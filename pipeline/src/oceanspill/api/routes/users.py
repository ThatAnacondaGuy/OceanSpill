"""Account administration. Only roles with full access to the administration module get here."""
from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import serialize
from ..audit import record
from ..deps import require, session
from ..models import AuthSession, User
from ..rules import access_rules
from ..security import hash_password, password_problem

router = APIRouter(prefix="/api/users", tags=["users"])

ROLES = Literal["NTRO Admin", "NTRO Reviewer", "Analyst", "Regulator", "Viewer", "Data Operator", "Liaison"]
CLEARANCES = Literal["Restricted", "Confidential", "Secret"]
STATUSES = Literal["Active", "Suspended", "Pending"]


class NewUser(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(max_length=200)
    role: ROLES
    agency: str = Field(min_length=2, max_length=120)
    clearance: CLEARANCES = "Restricted"
    status: STATUSES = "Pending"
    password: str | None = Field(default=None, max_length=500)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", v):
            raise ValueError("Enter a valid email address")
        return v


class UserPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    role: ROLES | None = None
    agency: str | None = Field(default=None, min_length=2, max_length=120)
    clearance: CLEARANCES | None = None
    status: STATUSES | None = None


class PasswordReset(BaseModel):
    password: str = Field(max_length=500)


def _next_id(db: Session) -> str:
    count = db.scalar(select(func.count()).select_from(User)) or 0
    for n in range(count + 1, count + 50):
        candidate = f"U-{n:03d}"
        if db.get(User, candidate) is None:
            return candidate
    return f"U-{secrets.token_hex(3)}"


@router.get("")
def list_users(user: User = Depends(require("admin", "read")), db: Session = Depends(session)):
    return [serialize.user(u) for u in db.scalars(select(User).order_by(User.id))]


@router.get("/roles")
def roles(user: User = Depends(require("admin", "read"))):
    """The permission matrix the administration page renders, straight from the shared rules file."""
    return access_rules()


@router.post("")
def create_user(body: NewUser, user: User = Depends(require("admin", "full")), db: Session = Depends(session)):
    email = body.email
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "An account with that email already exists")
    if body.password:
        problem = password_problem(body.password)
        if problem:
            raise HTTPException(400, problem)
    u = User(id=_next_id(db), name=body.name, email=email, role=body.role, agency=body.agency,
             clearance=body.clearance, status=body.status,
             password_hash=hash_password(body.password) if body.password else None)
    db.add(u)
    record(db, user, "Account created", u.id, f"{body.name} · {body.role} · {body.agency}", "Access")
    db.commit()
    return serialize.user(u)


@router.patch("/{user_id}")
def update_user(user_id: str, body: UserPatch, user: User = Depends(require("admin", "full")), db: Session = Depends(session)):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(404, "Account not found")
    changes = []
    for field in ("name", "role", "agency", "clearance", "status"):
        value = getattr(body, field)
        if value is not None and value != getattr(u, field):
            changes.append(f"{field}: {getattr(u, field)} → {value}")
            setattr(u, field, value)
    if u.id == user.id and body.status and body.status != "Active":
        raise HTTPException(400, "You cannot suspend your own account")
    if body.status and body.status != "Active":
        # Suspending or resetting to pending ends any open session immediately.
        for s in db.scalars(select(AuthSession).where(AuthSession.user_id == u.id, AuthSession.revoked_at.is_(None))):
            s.revoked_at = datetime.now(timezone.utc)
    if changes:
        record(db, user, "Account updated", u.id, "; ".join(changes), "Access")
    db.commit()
    return serialize.user(u)


@router.post("/{user_id}/password")
def set_password(user_id: str, body: PasswordReset, user: User = Depends(require("admin", "full")), db: Session = Depends(session)):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(404, "Account not found")
    problem = password_problem(body.password)
    if problem:
        raise HTTPException(400, problem)
    u.password_hash = hash_password(body.password)
    u.failed_logins, u.locked_until = 0, None
    for s in db.scalars(select(AuthSession).where(AuthSession.user_id == u.id, AuthSession.revoked_at.is_(None))):
        s.revoked_at = datetime.now(timezone.utc)
    record(db, user, "Password set by administrator", u.id, "Existing sessions signed out", "Access")
    db.commit()
    return serialize.user(u)


@router.post("/{user_id}/mfa/reset")
def reset_mfa(user_id: str, user: User = Depends(require("admin", "full")), db: Session = Depends(session)):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(404, "Account not found")
    u.mfa_enabled, u.totp_secret = False, None
    record(db, user, "Two-factor sign-in reset", u.id, "Account must enrol an authenticator app again", "Access")
    db.commit()
    return serialize.user(u)
