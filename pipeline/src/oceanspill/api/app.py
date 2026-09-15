"""The FastAPI application: one factory used by the server, the tests and the container image."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .artifacts import ArtifactStore
from .db import Base, Database
from .deps import AppState
from .routes import actions, auth, data, events, monitoring, reports, system, users
from .settings import ApiSettings
from .storage import make_storage

log = logging.getLogger("oceanspill.api")

DESCRIPTION = """Server for the OceanSpill oil spill detection and attribution prototype.

Case facts come from the pipeline's artifact files; accounts, workflow state, drafts, detections,
signed documents and the audit trail live in the database."""


def create_app(settings: ApiSettings | None = None, *, create_tables: bool = False) -> FastAPI:
    settings = settings or ApiSettings.load()
    db = Database(settings.database_url)
    if create_tables:
        Base.metadata.create_all(db.engine)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        log.info("serving case artifacts from %s", settings.data_dir)
        yield
        db.engine.dispose()

    app = FastAPI(title="OceanSpill API", version="1.0", description=DESCRIPTION, lifespan=lifespan)
    app.state.oceanspill = AppState(settings=settings, db=db, artifacts=ArtifactStore(settings.data_dir),
                                    storage=make_storage(settings))
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allow_headers=["Authorization", "Content-Type"],
        expose_headers=["X-Document-Id", "X-Document-Sha256", "X-Document-Signature", "ETag"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):  # pragma: no cover - safety net
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "The server could not complete that request"}, status_code=500)

    for module in (auth, data, actions, users, reports, monitoring, events, system):
        app.include_router(module.router)
    return app
