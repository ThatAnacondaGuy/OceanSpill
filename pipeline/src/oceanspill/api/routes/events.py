"""Notifications, delivered on request and as a live stream.

The stream is server-sent events over the notifications table: no message broker to run, and a
reconnecting browser simply asks for everything newer than the last id it saw.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import serialize
from ..deps import current_user, session, state
from ..models import Notification, User
from ..rules import module_level

router = APIRouter(prefix="/api", tags=["events"])

POLL_SECONDS = 3
KEEPALIVE_SECONDS = 20


def _visible(user: User, n: Notification) -> bool:
    return n.module is None or module_level(user.role, n.module) != "none"


@router.get("/notifications")
def notifications(since: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                  user: User = Depends(current_user), db: Session = Depends(session)):
    rows = db.scalars(select(Notification).where(Notification.id > since).order_by(Notification.id.desc()).limit(limit))
    return [serialize.notification(n) for n in rows if _visible(user, n)]


@router.get("/events")
async def stream(request: Request, since: int = Query(0, ge=0), user: User = Depends(current_user)):
    """Live notifications, as server-sent events over a normal authenticated request."""
    st = state(request)

    def latest_id() -> int:
        with st.db.sessions() as db:
            return db.scalar(select(func.max(Notification.id))) or 0

    def fetch(after: int) -> tuple[int, list[dict]]:
        """Runs off the event loop, so a slow query never stalls other requests."""
        fresh: list[dict] = []
        with st.db.sessions() as db:
            for n in db.scalars(select(Notification).where(Notification.id > after).order_by(Notification.id).limit(50)):
                after = n.id
                if _visible(user, n):
                    fresh.append(serialize.notification(n))
        return after, fresh

    async def events():
        last = since or await asyncio.to_thread(latest_id)
        yield f"retry: 5000\nevent: ready\ndata: {json.dumps({'since': last})}\n\n"
        idle = 0
        while True:
            if await request.is_disconnected():
                return
            last, fresh = await asyncio.to_thread(fetch, last)
            for item in fresh:
                yield f"id: {item['id']}\nevent: notification\ndata: {json.dumps(item)}\n\n"
            idle = 0 if fresh else idle + POLL_SECONDS
            if idle >= KEEPALIVE_SECONDS:
                idle = 0
                yield ": keep-alive\n\n"
            await asyncio.sleep(POLL_SECONDS)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
