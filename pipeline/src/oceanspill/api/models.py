"""Database tables. Case facts stay in the pipeline's artifact files; these tables hold everything
people and background jobs change: accounts, workflow state, drafts, reports, detections and the
append-only audit trail."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, JsonType, utcnow

# SQLite only auto-increments INTEGER primary keys; PostgreSQL gets BIGINT.
BigId = BigInteger().with_variant(Integer(), "sqlite")


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(40))
    agency: Mapped[str] = mapped_column(String(120))
    clearance: Mapped[str] = mapped_column(String(20), default="Restricted")
    status: Mapped[str] = mapped_column(String(20), default="Pending")
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)


class AuditEntry(Base):
    """Append-only. On PostgreSQL a trigger rejects UPDATE and DELETE on this table."""
    __tablename__ = "audit_log"
    seq: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(64), unique=True)
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(60))
    action: Mapped[str] = mapped_column(String(200))
    target: Mapped[str] = mapped_column(String(120), index=True)
    detail: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(20))
    provenance: Mapped[str] = mapped_column(String(20), default="session")
    user_id: Mapped[str | None] = mapped_column(String(32), nullable=True)


class CaseState(Base):
    __tablename__ = "case_state"
    case_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    status: Mapped[str] = mapped_column(String(40), default="Under Analysis")
    workflow_stage: Mapped[str] = mapped_column(String(40), default="Awaiting Dispatch")
    imac_pushed: Mapped[bool] = mapped_column(Boolean, default=False)
    imac_pushed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    alert_dispatched: Mapped[bool] = mapped_column(Boolean, default=False)
    lookalike_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)


class CommunityAlert(Base):
    __tablename__ = "community_alerts"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    case_id: Mapped[str] = mapped_column(String(64), index=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    channel: Mapped[list] = mapped_column(JsonType, default=list)
    languages: Mapped[list] = mapped_column(JsonType, default=list)
    districts: Mapped[list] = mapped_column(JsonType, default=list)
    headline: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    no_go_radius_km: Mapped[float] = mapped_column(Float)
    centre_lat: Mapped[float] = mapped_column(Float)
    centre_lon: Mapped[float] = mapped_column(Float)
    valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="Draft")
    issuer: Mapped[str] = mapped_column(String(120))
    cap_xml: Mapped[str | None] = mapped_column(Text, nullable=True)


class EnforcementAction(Base):
    __tablename__ = "enforcement_actions"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    case_id: Mapped[str] = mapped_column(String(64), index=True)
    mmsi: Mapped[str] = mapped_column(String(20), default="")
    party: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(40))
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    authority: Mapped[str] = mapped_column(String(200))
    reference: Mapped[str | None] = mapped_column(String(200), nullable=True)
    amount_inr: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="Pending")
    outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SightingReport(Base):
    __tablename__ = "sighting_reports"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    reporter: Mapped[str] = mapped_column(String(160))
    district: Mapped[str] = mapped_column(String(120))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    description: Mapped[str] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(String(30))
    linked_case_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    source: Mapped[str] = mapped_column(String(200), default="Field report")


class SightingPatch(Base):
    """Links and verification applied to reports that come from the case artifacts."""
    __tablename__ = "sighting_patches"
    sighting_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    linked_case_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)


class AreaOfInterest(Base):
    __tablename__ = "areas_of_interest"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    priority: Mapped[int] = mapped_column(Integer, default=5)
    north: Mapped[float] = mapped_column(Float)
    south: Mapped[float] = mapped_column(Float)
    east: Mapped[float] = mapped_column(Float)
    west: Mapped[float] = mapped_column(Float)
    rationale: Mapped[str] = mapped_column(Text, default="")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    requested_by: Mapped[str] = mapped_column(String(60), default="")
    monitored: Mapped[bool] = mapped_column(Boolean, default=False)
    built_in: Mapped[bool] = mapped_column(Boolean, default=False)


class SceneRecord(Base):
    """SAR scenes found by the monitoring job over monitored areas."""
    __tablename__ = "scenes"
    id: Mapped[str] = mapped_column(String(200), primary_key=True)
    provider: Mapped[str] = mapped_column(String(30))
    platform: Mapped[str] = mapped_column(String(40))
    start: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    footprint: Mapped[list] = mapped_column(JsonType)
    aoi_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    online: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(20), default="listed")
    local_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    found_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Detection(Base):
    """A candidate slick from a processed scene, waiting for analyst review."""
    __tablename__ = "detections"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    scene_id: Mapped[str] = mapped_column(String(200), index=True)
    aoi_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    outline: Mapped[list] = mapped_column(JsonType)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    area_km2: Mapped[float] = mapped_column(Float)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    method: Mapped[str] = mapped_column(String(60))
    measurements: Mapped[dict] = mapped_column(JsonType, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="new")
    reviewed_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    case_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AisPosition(Base):
    __tablename__ = "ais_positions"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    mmsi: Mapped[str] = mapped_column(String(20))
    t: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    sog: Mapped[float | None] = mapped_column(Float, nullable=True)
    cog: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(30))
    aoi_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    __table_args__ = (Index("ix_ais_mmsi_t", "mmsi", "t"),)


class ForecastRun(Base):
    __tablename__ = "forecast_runs"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    aoi_id: Mapped[str] = mapped_column(String(40), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    valid_to: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    storage_key: Mapped[str] = mapped_column(String(300))
    sources: Mapped[dict] = mapped_column(JsonType, default=dict)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    params: Mapped[dict] = mapped_column(JsonType, default=dict)
    requested_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    kind: Mapped[str] = mapped_column(String(20), default="info")
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    target: Mapped[str | None] = mapped_column(String(120), nullable=True)
    module: Mapped[str | None] = mapped_column(String(30), nullable=True)


class SignedDocument(Base):
    """Hash and signature of every exported evidence document, so a copy can be verified later."""
    __tablename__ = "signed_documents"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40))
    case_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(300), default="")
    content_sha256: Mapped[str] = mapped_column(String(64))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    signature: Mapped[str] = mapped_column(String(128))
    storage_key: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by: Mapped[str] = mapped_column(String(32))
    created_by_name: Mapped[str] = mapped_column(String(120), default="")
