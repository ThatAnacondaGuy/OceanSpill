from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import serialize
from ..audit import record
from ..deps import current_user, session, state
from ..models import AuthSession, User
from ..security import (
    LOCKOUT, MAX_FAILED_LOGINS, hash_password, issue_token, new_session_id, new_totp_secret, password_problem,
    totp_uri, verify_password, verify_totp,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=500)
    code: str | None = Field(default=None, max_length=12)


class PasswordBody(BaseModel):
    current: str = Field(max_length=500)
    new: str = Field(max_length=500)


class CodeBody(BaseModel):
    code: str = Field(max_length=12)


def _aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.post("/login")
def login(body: LoginBody, request: Request, db: Session = Depends(session)):
    st = state(request)
    now = datetime.now(timezone.utc)
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    generic = HTTPException(status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect")
    if user is None:
        record(db, None, "Sign-in failed", body.email.strip().lower()[:120], "Unknown account", "Access", actor="Unknown", role="—")
        db.commit()
        raise generic
    if user.locked_until and _aware(user.locked_until) > now:
        raise HTTPException(status.HTTP_423_LOCKED, "Account temporarily locked after repeated failed sign-ins; try again later")
    if user.status != "Active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account is not active; contact the system administrator")
    if not verify_password(body.password, user.password_hash):
        user.failed_logins += 1
        if user.failed_logins >= MAX_FAILED_LOGINS:
            user.locked_until = now + LOCKOUT
            user.failed_logins = 0
        record(db, user, "Sign-in failed", user.id, "Wrong password", "Access")
        db.commit()
        raise generic
    if user.mfa_enabled:
        if not body.code:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"message": "Enter the code from your authenticator app", "mfaRequired": True})
        if not verify_totp(user.totp_secret, body.code):
            record(db, user, "Sign-in failed", user.id, "Wrong second-factor code", "Access")
            db.commit()
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"message": "Code is incorrect", "mfaRequired": True})

    sid = new_session_id()
    token, expires = issue_token(st.settings.jwt_secret, user.id, sid, st.settings.access_token_minutes)
    db.add(AuthSession(id=sid, user_id=user.id, expires_at=expires, ip=request.client.host if request.client else None,
                       user_agent=(request.headers.get("user-agent") or "")[:300]))
    user.failed_logins = 0
    user.locked_until = None
    user.last_login = now
    record(db, user, "Signed in", user.id, user.email, "Access")
    db.commit()
    return {"token": token, "expiresAt": serialize.ms(expires), "user": serialize.user(user)}


@router.post("/logout")
def logout(request: Request, user: User = Depends(current_user), db: Session = Depends(session)):
    sess = db.get(AuthSession, request.state.session_id)
    if sess:
        sess.revoked_at = datetime.now(timezone.utc)
    record(db, user, "Signed out", user.id, user.email, "Access")
    db.commit()
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return serialize.user(user)


@router.post("/password")
def change_password(body: PasswordBody, request: Request, user: User = Depends(current_user), db: Session = Depends(session)):
    if not verify_password(body.current, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    problem = password_problem(body.new)
    if problem:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, problem)
    user.password_hash = hash_password(body.new)
    # Other sessions end when the password changes.
    for s in db.scalars(select(AuthSession).where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))):
        if s.id != request.state.session_id:
            s.revoked_at = datetime.now(timezone.utc)
    record(db, user, "Password changed", user.id, "Other sessions signed out", "Access")
    db.commit()
    return {"ok": True}


@router.post("/mfa/setup")
def mfa_setup(user: User = Depends(current_user), db: Session = Depends(session)):
    if user.mfa_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Two-factor sign-in is already on")
    user.totp_secret = new_totp_secret()
    db.commit()
    return {"secret": user.totp_secret, "uri": totp_uri(user.totp_secret, user.email)}


@router.post("/mfa/enable")
def mfa_enable(body: CodeBody, user: User = Depends(current_user), db: Session = Depends(session)):
    if not verify_totp(user.totp_secret, body.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Code is incorrect")
    user.mfa_enabled = True
    record(db, user, "Two-factor sign-in enabled", user.id, "Authenticator app", "Access")
    db.commit()
    return serialize.user(user)
