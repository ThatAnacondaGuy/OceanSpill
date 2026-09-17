from __future__ import annotations

import secrets
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from .models import AuditEntry, Notification, User


def record(db: Session, user: User | None, action: str, target: str, detail: str, category: str,
           provenance: str = "session", actor: str | None = None, role: str | None = None) -> AuditEntry:
    entry = AuditEntry(
        id=f"SES-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3)}",
        actor=actor or (user.name if user else "System"),
        role=role or (user.role if user else "Automated"),
        action=action, target=target, detail=detail, category=category,
        provenance=provenance, user_id=user.id if user else None,
    )
    db.add(entry)
    return entry


def notify(db: Session, title: str, body: str = "", kind: str = "info", target: str | None = None, module: str | None = None) -> Notification:
    n = Notification(title=title, body=body, kind=kind, target=target, module=module)
    db.add(n)
    return n
