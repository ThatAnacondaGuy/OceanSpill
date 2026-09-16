"""Live monitoring: scenes the watcher found, candidate detections awaiting review, and the job queue."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import serialize
from ..audit import notify, record
from ..deps import current_user, require, session, state
from ..models import AisPosition, AreaOfInterest, Detection, ForecastRun, Job, SceneRecord, User

router = APIRouter(prefix="/api", tags=["monitoring"])

JOB_KINDS = Literal["scan-aoi", "process-scene", "refresh-ais", "refresh-forecast"]


class JobBody(BaseModel):
    kind: JOB_KINDS
    params: dict = Field(default_factory=dict)


class ReviewBody(BaseModel):
    status: Literal["confirmed", "dismissed"]
    notes: str | None = Field(default=None, max_length=2000)


def _count(db: Session, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


@router.get("/scenes")
def scenes(days: int = Query(30, ge=1, le=365), user: User = Depends(require("satellite", "read")), db: Session = Depends(session)):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.scalars(select(SceneRecord).where(SceneRecord.start >= since).order_by(SceneRecord.start.desc()).limit(500))
    return [serialize.scene(s) for s in rows]


@router.get("/detections")
def detections(status: str | None = None, days: int = Query(30, ge=1, le=365),
               user: User = Depends(require("incidents", "read")), db: Session = Depends(session)):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = select(Detection).where(Detection.acquired_at >= since)
    if status:
        q = q.where(Detection.status == status)
    rows = db.scalars(q.order_by(Detection.acquired_at.desc()).limit(500))
    return [serialize.detection(d) for d in rows]


@router.post("/detections/{detection_id}/review")
def review_detection(detection_id: str, body: ReviewBody, user: User = Depends(require("investigation", "full")),
                     db: Session = Depends(session)):
    d = db.get(Detection, detection_id)
    if d is None:
        raise HTTPException(404, "Detection not found")
    d.status, d.reviewed_by, d.reviewed_at, d.notes = body.status, user.id, datetime.now(timezone.utc), body.notes
    verb = "confirmed" if body.status == "confirmed" else "dismissed as a look-alike"
    record(db, user, f"Detection {verb}", detection_id, body.notes or f"{d.area_km2:.1f} km² near {d.lat:.3f}, {d.lon:.3f}", "Detection")
    db.commit()
    return serialize.detection(d)


@router.get("/jobs")
def jobs(user: User = Depends(require("data", "read")), db: Session = Depends(session)):
    rows = db.scalars(select(Job).order_by(Job.created_at.desc()).limit(100))
    return [serialize.job(j) for j in rows]


@router.post("/jobs")
def queue_job(body: JobBody, user: User = Depends(require("data", "full")), db: Session = Depends(session)):
    job = Job(kind=body.kind, params=body.params, requested_by=user.id)
    db.add(job)
    record(db, user, "Job queued", body.kind, str(body.params) if body.params else "No parameters", "System")
    notify(db, "Job queued", body.kind, "info", None, "data")
    db.commit()
    return serialize.job(job)


@router.get("/forecasts")
def forecasts(request: Request, aoi_id: str | None = None, user: User = Depends(require("environment", "read")),
              db: Session = Depends(session)):
    q = select(ForecastRun)
    if aoi_id:
        q = q.where(ForecastRun.aoi_id == aoi_id)
    rows = list(db.scalars(q.order_by(ForecastRun.created_at.desc()).limit(50)))
    return [{"id": r.id, "aoiId": r.aoi_id, "createdAt": serialize.ms(r.created_at),
             "validFrom": serialize.ms(r.valid_from), "validTo": serialize.ms(r.valid_to),
             "sources": r.sources, "file": f"/api/forecasts/{r.id}/grid"} for r in rows]


@router.get("/forecasts/{forecast_id}/grid")
def forecast_grid(forecast_id: str, request: Request, user: User = Depends(require("environment", "read")),
                  db: Session = Depends(session)):
    row = db.get(ForecastRun, forecast_id)
    if row is None:
        raise HTTPException(404, "Forecast not found")
    try:
        data = state(request).storage.get(row.storage_key)
    except FileNotFoundError:
        raise HTTPException(410, "The stored forecast grid is no longer available") from None
    return Response(content=data, media_type="application/json", headers={"Cache-Control": "private, max-age=600"})


@router.get("/ais/tracks")
def ais_tracks(aoi_id: str | None = None, hours: int = Query(72, ge=1, le=24 * 60),
               limit: int = Query(200, ge=1, le=2000),
               user: User = Depends(require("vessels", "read")), db: Session = Depends(session)):
    """Recent vessel tracks from the AIS feed, newest first.

    The feed this project has access to runs a few days behind, so the response says how old its
    newest position is. A page that draws this as a live picture would be misleading.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(AisPosition).where(AisPosition.t >= since)
    if aoi_id:
        q = q.where(AisPosition.aoi_id == aoi_id)
    rows = list(db.scalars(q.order_by(AisPosition.vessel_id, AisPosition.t)))

    tracks: dict[str, dict] = {}
    for row in rows:
        track = tracks.setdefault(row.vessel_id, {"vesselId": row.vessel_id, "mmsi": row.mmsi,
                                                  "source": row.source, "aoiId": row.aoi_id, "points": []})
        track["points"].append([serialize.ms(row.t), round(row.lat, 5), round(row.lon, 5)])
        if row.mmsi and not track["mmsi"]:
            track["mmsi"] = row.mmsi

    newest = db.scalar(select(func.max(AisPosition.t)))
    ordered = sorted(tracks.values(), key=lambda t: t["points"][-1][0], reverse=True)[:limit]
    return {
        "tracks": ordered,
        "vessels": len(tracks),
        "positions": len(rows),
        "newest": serialize.ms(newest),
        "lagHours": None if newest is None else round((datetime.now(timezone.utc) - newest.replace(tzinfo=newest.tzinfo or timezone.utc)).total_seconds() / 3600, 1),
        "note": "Global Fishing Watch presence, which trails real time by a few days. Not a live picture.",
    }


@router.get("/monitoring/summary")
def summary(user: User = Depends(current_user), db: Session = Depends(session)):
    """What the live monitoring banner shows: new detections, recent scenes, queue health."""
    day = datetime.now(timezone.utc) - timedelta(days=1)
    week = datetime.now(timezone.utc) - timedelta(days=7)
    new = list(db.scalars(select(Detection).where(Detection.status == "new").order_by(Detection.acquired_at.desc()).limit(20)))
    return {
        "newDetections": [serialize.detection(d) for d in new],
        "scenesLastWeek": _count(db, SceneRecord, SceneRecord.found_at >= week),
        "scenesLastDay": _count(db, SceneRecord, SceneRecord.found_at >= day),
        "monitoredAreas": [a.id for a in db.scalars(select(AreaOfInterest).where(AreaOfInterest.monitored.is_(True)))],
        "queued": _count(db, Job, Job.status == "queued"),
        "running": _count(db, Job, Job.status == "running"),
        "failedLastDay": _count(db, Job, Job.status == "failed", Job.finished_at >= day),
        "lastScene": serialize.ms(db.scalar(select(SceneRecord.found_at).order_by(SceneRecord.found_at.desc()).limit(1))),
    }
