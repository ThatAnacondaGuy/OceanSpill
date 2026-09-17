"""Health, the audit trail and the state of every data source."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from .. import serialize
from ..audit import record
from ..deps import current_user, require, session, state
from ..models import AuditEntry, User

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health(request: Request):
    """Used by the container health check and the monitoring probe; no sign-in required."""
    st = state(request)
    checks = {}
    try:
        with st.db.sessions() as db:
            db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # pragma: no cover - depends on the deployment
        checks["database"] = f"error: {type(exc).__name__}"
    try:
        checks["artifacts"] = f"ok ({len(st.artifacts.case_ids())} cases)"
    except Exception as exc:
        checks["artifacts"] = f"error: {type(exc).__name__}"
    ok = all(v.startswith("ok") for v in checks.values())
    return {"status": "ok" if ok else "degraded", "checks": checks, "time": serialize.ms(datetime.now(timezone.utc))}


@router.get("/audit")
def audit(category: str | None = None, target: str | None = None, days: int = Query(90, ge=1, le=3650),
          limit: int = Query(500, ge=1, le=5000), user: User = Depends(require("archive", "read")),
          db: Session = Depends(session)):
    q = select(AuditEntry).where(AuditEntry.t >= datetime.now(timezone.utc) - timedelta(days=days))
    if category:
        q = q.where(AuditEntry.category == category)
    if target:
        q = q.where(AuditEntry.target == target)
    rows = db.scalars(q.order_by(AuditEntry.t.desc(), AuditEntry.seq.desc()).limit(limit))
    return [serialize.audit(a) for a in rows]


@router.post("/audit")
def add_audit(entry: dict, user: User = Depends(current_user), db: Session = Depends(session)):
    """Records an action the web app performed locally, such as opening an evidence export."""
    row = record(db, user, str(entry.get("action", "Action"))[:200], str(entry.get("target", "—"))[:120],
                 str(entry.get("detail", ""))[:2000], str(entry.get("category", "System"))[:20])
    db.commit()
    return serialize.audit(row)


@router.get("/sources")
def sources(request: Request, user: User = Depends(current_user), db: Session = Depends(session)):
    """Provider status from the last pipeline build, plus what the server itself has stored."""
    st = state(request)
    index = st.artifacts.index()
    return {"providers": index.get("providers", []), "generatedAt": index.get("generatedAt"),
            "cases": len(index.get("cases", [])),
            "auditEntries": db.scalar(select(func.count()).select_from(AuditEntry)) or 0}
