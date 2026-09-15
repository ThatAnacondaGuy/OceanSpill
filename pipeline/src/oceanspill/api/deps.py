from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .artifacts import ArtifactStore
from .db import Database
from .models import AuthSession, User
from .rules import module_level
from .security import read_token
from .settings import ApiSettings
from .storage import Storage


@dataclass
class AppState:
    settings: ApiSettings
    db: Database
    artifacts: ArtifactStore
    storage: Storage


def state(request: Request) -> AppState:
    return request.app.state.oceanspill


def session(request: Request) -> Iterator[Session]:
    yield from state(request).db.session()


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    # EventSource cannot set headers, so the notification stream accepts the token as a query value.
    return request.query_params.get("access_token")


def current_user(request: Request, db: Session = Depends(session)) -> User:
    token = _bearer(request)
    claims = read_token(state(request).settings.jwt_secret, token) if token else None
    if not claims:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in required", headers={"WWW-Authenticate": "Bearer"})
    sess = db.get(AuthSession, claims.get("sid"))
    now = datetime.now(timezone.utc)
    if not sess or sess.revoked_at is not None or _aware(sess.expires_at) <= now or sess.user_id != claims.get("sub"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired or signed out")
    user = db.get(User, sess.user_id)
    if not user or user.status != "Active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account is not active")
    request.state.session_id = sess.id
    return user


def require(module: str, level: str = "read") -> Callable[[User], User]:
    """Dependency that allows the request only if the user's role reaches `level` on `module`."""

    def check(user: User = Depends(current_user)) -> User:
        have = module_level(user.role, module)
        ok = have == "full" or (level == "read" and have == "read")
        if not ok:
            detail = "Your role has read-only access to this page" if have == "read" else "Your role cannot open this page"
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail)
        return user

    return check


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
