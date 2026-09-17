"""Case artifacts (the same files the static app reads) and the shared, changeable state."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import serialize
from ..artifacts import redact_case
from ..deps import current_user, session, state
from ..models import AreaOfInterest, AuditEntry, CaseState, CommunityAlert, EnforcementAction, SightingPatch, SightingReport, User
from ..rules import identities_visible

router = APIRouter(prefix="/api", tags=["data"])

SERVED_DIRS = {"cases", "forcing", "coast", "sar"}


@router.get("/data/{path:path}")
def artifact(path: str, request: Request, user: User = Depends(current_user)):
    """Serves `index.json`, `cases/*.json`, `forcing/*`, `coast/*` and `sar/*` from the pipeline output.

    The web app in server mode points its data base URL here, so the loading code is unchanged."""
    st = state(request)
    visible = identities_visible(user.clearance)
    root = st.artifacts.data_dir.resolve()
    target = (root / path).resolve()
    if path != "index.json" and path.split("/")[0] not in SERVED_DIRS:
        raise HTTPException(404, "Not found")
    if not str(target).startswith(str(root) + "/") or not target.is_file():
        raise HTTPException(404, "Not found")

    etag = st.artifacts.etag(path) + ("" if visible else "-r")
    headers = {"ETag": etag, "Cache-Control": "private, no-cache", "Vary": "Authorization"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)

    if path.startswith("sar/") and path.endswith(".png"):
        if not visible:
            raise HTTPException(403, "SAR imagery is withheld at your clearance level")
        return FileResponse(target, headers=headers)
    if path.startswith("cases/") and path.endswith(".json"):
        data = st.artifacts.file(path)
        return JSONResponse(data if visible else redact_case(data, st.settings.signing_secret), headers=headers)
    return FileResponse(target, headers=headers)


@router.get("/state")
def shared_state(user: User = Depends(current_user), db: Session = Depends(session)):
    """Everything people have changed, merged into the case data by the web app."""
    patches = {p.sighting_id: {"linkedCaseId": p.linked_case_id, "verified": p.verified} for p in db.scalars(select(SightingPatch))}
    aois = list(db.scalars(select(AreaOfInterest)))
    return {
        "cases": {s.case_id: serialize.case_state(s) for s in db.scalars(select(CaseState))},
        "alerts": [serialize.alert(a) for a in db.scalars(select(CommunityAlert).order_by(CommunityAlert.issued_at.desc()))],
        "enforcement": [serialize.enforcement(e) for e in db.scalars(select(EnforcementAction).order_by(EnforcementAction.created_at.desc()))],
        "sightings": [serialize.sighting(s) for s in db.scalars(select(SightingReport).order_by(SightingReport.received_at.desc()))],
        "sightingPatches": patches,
        "aois": [serialize.aoi(a) for a in aois if not a.built_in],
        "aoiPatches": {a.id: {"pinned": a.pinned, "priority": a.priority, "monitored": a.monitored} for a in aois},
        "audit": [serialize.audit(a) for a in db.scalars(select(AuditEntry).order_by(AuditEntry.t.desc(), AuditEntry.seq.desc()).limit(500))],
        "users": [serialize.user(u) for u in db.scalars(select(User).order_by(User.id))],
    }
