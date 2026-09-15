"""Background work: watch the monitored areas, process what comes in, keep AIS and forecasts fresh.

The queue is a table, so there is no broker to run and a restarted worker picks up where it stopped.
One worker at a time is enough for this prototype; jobs are claimed with a conditional update so a
second worker cannot take the same row.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..build import load_reference
from ..config import Settings
from ..http import CachedHttp
from ..providers import Providers
from ..providers.base import BBox, SarScene
from ..providers.metocean_forecast import MAX_FORECAST_DAYS, OpenMeteoForecast
from .audit import notify, record
from .db import Database
from .models import AisPosition, AreaOfInterest, Detection, ForecastRun, Job, SceneRecord
from .settings import ApiSettings
from .storage import Storage, make_storage

log = logging.getLogger("oceanspill.worker")

SCAN_DAYS = 7
AIS_DAYS = 2
FORECAST_DAYS = 3
FORECAST_STEP_DEG = 0.25
# How long a periodic job may be skipped before it is queued again.
PERIODS = {"scan-aoi": timedelta(hours=6), "refresh-ais": timedelta(hours=6), "refresh-forecast": timedelta(hours=12)}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Worker:
    def __init__(self, api_settings: ApiSettings, pipeline_settings: Settings | None = None, *, offline: bool = False):
        self.settings = api_settings
        self.pipeline = pipeline_settings or Settings.load()
        self.db = Database(api_settings.database_url)
        self.storage: Storage = make_storage(api_settings)
        self.offline = offline
        self._providers: Providers | None = None
        self._land = None
        self._http: CachedHttp | None = None

    # --- shared pipeline objects, built on first use so a worker with no network still starts ---

    @property
    def http(self) -> CachedHttp:
        if self._http is None:
            self._http = CachedHttp(self.pipeline.cache_dir, offline=self.offline)
        return self._http

    @property
    def providers(self) -> Providers:
        if self._providers is None:
            land, corridors, _ = load_reference()
            self._providers = Providers.from_settings(self.pipeline, self.http, land, corridors)
        return self._providers

    @property
    def land(self):
        if self._land is None:
            from ..sar.landmask import default_land
            land_json, _, _ = load_reference()
            self._land = default_land(land_json)
        return self._land

    # --- queue ---

    def schedule(self, db: Session) -> int:
        """Queue the periodic work that is due. Returns how many jobs were added."""
        areas = list(db.scalars(select(AreaOfInterest).where(AreaOfInterest.monitored.is_(True))))
        added = 0
        for area in areas:
            for kind in ("scan-aoi", "refresh-ais", "refresh-forecast"):
                if self._due(db, kind, area.id):
                    db.add(Job(kind=kind, params={"aoiId": area.id}))
                    added += 1
        if added:
            db.commit()
        return added

    def _due(self, db: Session, kind: str, aoi_id: str) -> bool:
        cutoff = utcnow() - PERIODS[kind]
        recent = db.scalars(select(Job).where(Job.kind == kind).order_by(Job.created_at.desc()).limit(40))
        for job in recent:
            if job.params.get("aoiId") != aoi_id:
                continue
            if job.status in {"queued", "running"}:
                return False
            finished = job.finished_at or job.created_at
            if finished.replace(tzinfo=finished.tzinfo or timezone.utc) > cutoff:
                return False
        return True

    def claim(self, db: Session) -> Job | None:
        """Take the oldest queued job, if no one else took it first."""
        for job in db.scalars(select(Job).where(Job.status == "queued").order_by(Job.created_at).limit(5)):
            changed = db.execute(
                update(Job).where(Job.id == job.id, Job.status == "queued")
                .values(status="running", started_at=utcnow())
            ).rowcount
            db.commit()
            if changed:
                db.refresh(job)
                return job
        return None

    def run_once(self, db: Session) -> int:
        """Run every job that is waiting. Returns how many ran."""
        handlers = {
            "scan-aoi": self.scan_aoi, "refresh-ais": self.refresh_ais,
            "refresh-forecast": self.refresh_forecast, "process-scene": self.process_scene,
        }
        ran = 0
        while (job := self.claim(db)) is not None:
            ran += 1
            handler = handlers.get(job.kind)
            try:
                if handler is None:
                    raise ValueError(f"unknown job kind {job.kind!r}")
                job.detail = handler(db, job.params or {})
                job.status = "done"
            except Exception as exc:
                log.exception("job %s (%s) failed", job.id, job.kind)
                job.status, job.error = "failed", f"{type(exc).__name__}: {exc}"
                notify(db, "Background job failed", f"{job.kind}: {exc}", "warning", None, "data")
            job.finished_at = utcnow()
            db.commit()
        return ran

    def serve(self) -> None:  # pragma: no cover - long-running loop
        log.info("worker started; checking every %s seconds", self.settings.worker_interval_s)
        while True:
            try:
                with self.db.sessions() as db:
                    self.schedule(db)
                    self.run_once(db)
            except Exception:
                log.exception("worker cycle failed")
            time.sleep(self.settings.worker_interval_s)

    # --- jobs ---

    def _area(self, db: Session, params: dict) -> AreaOfInterest:
        area = db.get(AreaOfInterest, params.get("aoiId", ""))
        if area is None:
            raise ValueError(f"unknown planning area {params.get('aoiId')!r}")
        return area

    def scan_aoi(self, db: Session, params: dict) -> str:
        """Ask every SAR catalogue what it has over the area in the last week."""
        area = self._area(db, params)
        days = int(params.get("days", SCAN_DAYS))
        end, start = utcnow(), utcnow() - timedelta(days=days)
        bbox = BBox(west=area.west, south=area.south, east=area.east, north=area.north)
        found, fresh = 0, 0
        for catalogue in self.providers.sar:
            try:
                scenes = catalogue.search(bbox, start, end)
            except Exception as exc:
                log.warning("%s catalogue search failed for %s: %s", catalogue.name, area.id, exc)
                continue
            found += len(scenes)
            for scene in scenes:
                if db.get(SceneRecord, scene.id) is not None:
                    continue
                db.add(SceneRecord(id=scene.id, provider=scene.provider, platform=scene.platform, start=scene.start,
                                   footprint=scene.footprint, aoi_id=area.id, size_bytes=scene.size_bytes,
                                   online=scene.online, status="listed"))
                fresh += 1
        if fresh:
            notify(db, f"{fresh} new SAR scene{'s' if fresh > 1 else ''}", area.name, "info", area.id, "satellite")
            record(db, None, "New SAR scenes listed", area.id, f"{fresh} new of {found} over {area.name}",
                   "Detection", provenance="automated")
        db.commit()
        return f"{fresh} new of {found} scenes over {area.name}"

    def process_scene(self, db: Session, params: dict) -> str:
        """Download a scene and run the dark-spot detector; results wait for analyst review."""
        scene_row = db.get(SceneRecord, params.get("sceneId", ""))
        if scene_row is None:
            raise ValueError(f"unknown scene {params.get('sceneId')!r}")
        area = db.get(AreaOfInterest, scene_row.aoi_id or "")
        if area is None:
            raise ValueError("the scene is not attached to a planning area")
        catalogue = next((c for c in self.providers.sar if c.name == scene_row.provider), None)
        if catalogue is None:
            raise ValueError(f"no catalogue configured for {scene_row.provider}")

        scene_row.status = "downloading"
        db.commit()
        scene = SarScene(id=scene_row.id, name=scene_row.id, platform=scene_row.platform, mode="", product_type="",
                         collection="", start=scene_row.start, end=scene_row.start, footprint=scene_row.footprint,
                         orbit_direction=None, online=scene_row.online, provider=scene_row.provider,
                         size_bytes=scene_row.size_bytes)
        path = Path(scene_row.local_path) if scene_row.local_path else catalogue.download(scene, self.pipeline.cache_dir / "scenes")
        scene_row.local_path, scene_row.status = str(path), "processing"
        db.commit()

        from ..sar.process import process_scene as run_detector
        centre_lat, centre_lon = (area.north + area.south) / 2, (area.east + area.west) / 2
        pseudo_case = {"id": f"WATCH-{area.id}", "incident": {"position": {"lat": centre_lat, "lon": centre_lon},
                                                             "time": scene_row.start.isoformat()}}
        radius_km = max(40.0, _half_span_km(area))
        result = run_detector(path, pseudo_case, scene_row.id, self.land, self.settings.data_dir, radius_km=radius_km)

        made = 0
        for i, spot in enumerate(result.get("spots", [])):
            detection_id = f"DET-{scene_row.id[:40]}-{i:03d}"
            if db.get(Detection, detection_id) is not None:
                continue
            db.add(Detection(
                id=detection_id, scene_id=scene_row.id, aoi_id=area.id, acquired_at=scene_row.start,
                outline=spot.get("outline", []), lat=spot["centroid"]["lat"], lon=spot["centroid"]["lon"],
                area_km2=spot.get("areaKm2", 0.0), score=None, method=result.get("method", ""),
                measurements={k: spot.get(k) for k in
                              ("contrastDb", "meanDb", "backgroundDb", "elongation", "orientationDeg", "distanceKm")},
            ))
            made += 1
        scene_row.status = "processed"
        if made:
            notify(db, f"{made} candidate slick{'s' if made > 1 else ''} to review", f"{area.name} · {scene_row.id[:40]}",
                   "warning", area.id, "incidents")
            record(db, None, "Candidate detections created", area.id,
                   f"{made} dark spots from {scene_row.id}", "Detection", provenance="automated")
        db.commit()
        return f"{made} candidate detections from {scene_row.id}"

    def refresh_ais(self, db: Session, params: dict) -> str:
        """Store recent AIS presence inside the area, for the live vessel picture."""
        area = self._area(db, params)
        ais = self.providers.ais
        if not hasattr(ais, "presence"):
            return "AIS provider does not expose area presence; nothing stored"
        end, start = utcnow(), utcnow() - timedelta(days=int(params.get("days", AIS_DAYS)))
        box = {"north": area.north, "south": area.south, "east": area.east, "west": area.west}
        from ..providers.ais_gfw import presence_tracks
        tracks = presence_tracks(ais.presence(box, start, end), start, end)
        stored = 0
        for vessel_id, track in tracks.items():
            meta = track.get("meta", {})
            # Presence reports are grouped by GFW vessel id; keep the MMSI when the row carries one.
            mmsi = str(meta.get("ssvid") or meta.get("mmsi") or vessel_id)
            for when, lat, lon in track.get("points", []):
                if db.scalar(select(AisPosition.id).where(AisPosition.mmsi == mmsi, AisPosition.t == when)):
                    continue
                db.add(AisPosition(mmsi=mmsi, t=when, lat=lat, lon=lon, source="gfw", aoi_id=area.id))
                stored += 1
        db.commit()
        return f"{stored} AIS positions stored for {area.name}"

    def refresh_forecast(self, db: Session, params: dict) -> str:
        """Pull the next few days of wind, current and wave forcing over the area."""
        area = self._area(db, params)
        days = min(int(params.get("days", FORECAST_DAYS)), MAX_FORECAST_DAYS)
        start = utcnow().replace(minute=0, second=0, microsecond=0)
        end = start + timedelta(days=days)
        provider = OpenMeteoForecast(self.pipeline, self.http)
        bbox = BBox(west=area.west, south=area.south, east=area.east, north=area.north)
        grid = provider.grid(bbox, FORECAST_STEP_DEG, start, end, hour_step=3)

        from ..build import forcing_json
        payload: dict[str, Any] = forcing_json(grid, 3)
        payload["aoiId"] = area.id
        run_id = f"FCST-{area.id}-{start.strftime('%Y%m%dT%H')}"
        key = f"forecasts/{run_id}.json"
        self.storage.put(key, json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        if db.get(ForecastRun, run_id) is None:
            db.add(ForecastRun(id=run_id, aoi_id=area.id, valid_from=start, valid_to=end, storage_key=key,
                               sources=payload.get("sources", {})))
            notify(db, "Forecast updated", f"{area.name} · {days} days ahead", "success", area.id, "environment")
        db.commit()
        coverage = payload.get("coverage", {})
        return f"{days}-day forecast for {area.name} (wind {coverage.get('wind', 0):.0%}, current {coverage.get('current', 0):.0%})"


def _half_span_km(area: AreaOfInterest) -> float:
    """Half the diagonal of the area in kilometres, so one scene crop covers it."""
    import math
    lat_km = (area.north - area.south) * 110.574
    lon_km = (area.east - area.west) * 111.320 * math.cos(math.radians((area.north + area.south) / 2))
    return math.hypot(lat_km, lon_km) / 2
