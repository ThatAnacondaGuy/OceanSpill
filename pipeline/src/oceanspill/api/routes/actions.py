"""Analyst actions. Every change is permission-checked, validated against the workflow rules and
written to the audit trail in the same transaction."""
from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import serialize
from ..audit import notify, record
from ..deps import current_user, require, session, state
from ..models import AreaOfInterest, CaseState, CommunityAlert, EnforcementAction, SightingPatch, SightingReport, User
from ..rules import can_move_stage, can_set_status, module_level

router = APIRouter(prefix="/api", tags=["actions"])


def _case_ids(request: Request) -> set[str]:
    return set(state(request).artifacts.case_ids())


def _state_for(db: Session, case_id: str) -> CaseState:
    s = db.get(CaseState, case_id)
    if s is None:
        s = CaseState(case_id=case_id)
        db.add(s)
        db.flush()
    return s


def _can(user: User, *modules: str) -> bool:
    return any(module_level(user.role, m) == "full" for m in modules)


class CaseStateBody(BaseModel):
    status: str | None = None
    workflowStage: str | None = None
    note: str | None = Field(default=None, max_length=2000)
    imacPushed: bool | None = None
    alertDispatched: bool | None = None
    lookalikeReason: str | None = Field(default=None, max_length=2000)
    version: int | None = None


@router.patch("/cases/{case_id}/state")
def update_case_state(case_id: str, body: CaseStateBody, request: Request, user: User = Depends(current_user), db: Session = Depends(session)):
    if case_id not in _case_ids(request):
        raise HTTPException(404, "Case not found")
    s = _state_for(db, case_id)
    if body.version is not None and body.version != s.version:
        raise HTTPException(409, "The case was changed by someone else; reload to see the latest state")

    if body.workflowStage is not None and body.workflowStage != s.workflow_stage:
        if not _can(user, "workflow", "investigation"):
            raise HTTPException(403, "Your role has read-only access to this page")
        ok, reason = can_move_stage(s.workflow_stage, body.workflowStage)
        if not ok:
            raise HTTPException(422, reason)
        record(db, user, "Workflow advanced", case_id, f'Moved to "{body.workflowStage}"', "Dispatch")
        s.workflow_stage = body.workflowStage

    if body.lookalikeReason is not None:
        if not _can(user, "investigation"):
            raise HTTPException(403, "Your role has read-only access to this page")
        s.status, s.workflow_stage, s.lookalike_reason = "Dismissed — Look-alike", "Closed", body.lookalikeReason
        record(db, user, "Reclassified as look-alike", case_id, body.lookalikeReason, "Detection")
    elif body.status is not None and body.status != s.status:
        if not _can(user, "workflow", "investigation"):
            raise HTTPException(403, "Your role has read-only access to this page")
        ok, reason = can_set_status(body.status, s.workflow_stage)
        if not ok:
            raise HTTPException(422, reason)
        s.status = body.status
        record(db, user, "Status changed", case_id, body.note or f'Status set to "{body.status}"', "Analysis")

    if body.imacPushed:
        if not _can(user, "data", "investigation"):
            raise HTTPException(403, "Your role has read-only access to this page")
        s.imac_pushed, s.imac_pushed_at = True, datetime.now(timezone.utc)
        record(db, user, "IMAC payload generated", case_id, "Payload prepared; IMAC ingest endpoint not integrated", "Dispatch")
    if body.alertDispatched is not None:
        s.alert_dispatched = body.alertDispatched

    s.updated_at, s.updated_by, s.version = datetime.now(timezone.utc), user.id, s.version + 1
    db.commit()
    return serialize.case_state(s)


class AlertBody(BaseModel):
    caseId: str
    channel: list[str]
    languages: list[str]
    districts: list[str]
    headline: str = Field(max_length=300)
    body: str = Field(max_length=4000)
    noGoRadiusKm: float = Field(ge=0, le=500)
    centre: dict[str, float]
    validUntil: int | None = None
    capXml: str | None = Field(default=None, max_length=20000)


@router.post("/alerts")
def draft_alert(body: AlertBody, request: Request, user: User = Depends(require("alerting", "full")), db: Session = Depends(session)):
    if body.caseId not in _case_ids(request):
        raise HTTPException(404, "Case not found")
    count = db.scalar(select(func.count()).select_from(CommunityAlert)) or 0
    a = CommunityAlert(
        id=f"DRAFT-{count + 1:03d}-{secrets.token_hex(2)}", case_id=body.caseId, channel=body.channel, languages=body.languages,
        districts=body.districts, headline=body.headline, body=body.body, no_go_radius_km=body.noGoRadiusKm,
        centre_lat=body.centre["lat"], centre_lon=body.centre["lon"], valid_until=serialize.from_ms(body.validUntil),
        issuer=user.name, cap_xml=body.capXml,
    )
    db.add(a)
    _state_for(db, body.caseId).alert_dispatched = True
    record(db, user, "Community alert drafted", body.caseId,
           f"{', '.join(body.channel)} to {', '.join(body.districts)} ({'/'.join(body.languages)})", "Alert")
    db.commit()
    return serialize.alert(a)


class EnforcementBody(BaseModel):
    caseId: str
    mmsi: str = ""
    party: str = Field(max_length=200)
    type: Literal["Inspection Ordered", "Detention", "Fine Issued", "Insurance Flagged", "Blacklist Recommended", "Prosecution Referred"]
    issuedAt: int | None = None
    authority: str = Field(max_length=200)
    reference: str | None = Field(default=None, max_length=200)
    amountInr: float | None = None
    status: Literal["Pending", "Served", "Contested", "Concluded", "Reported"] = "Pending"
    outcome: str | None = Field(default=None, max_length=4000)


@router.post("/enforcement")
def add_enforcement(body: EnforcementBody, user: User = Depends(current_user), db: Session = Depends(session)):
    if not _can(user, "workflow", "liability", "investigation"):
        raise HTTPException(403, "Your role has read-only access to this page")
    e = EnforcementAction(
        id=f"SES-ENF-{secrets.token_hex(4)}", case_id=body.caseId, mmsi=body.mmsi, party=body.party, type=body.type,
        issued_at=serialize.from_ms(body.issuedAt), authority=body.authority, reference=body.reference,
        amount_inr=body.amountInr, status=body.status, outcome=body.outcome, created_by=user.id,
    )
    db.add(e)
    record(db, user, body.type, body.caseId, f"{body.type} recorded against {body.party}", "Enforcement")
    notify(db, f"{body.type} recorded", body.party, "success", body.caseId, "workflow")
    db.commit()
    return serialize.enforcement(e)


class SightingBody(BaseModel):
    reporter: str = Field(max_length=160)
    district: str = Field(max_length=120)
    position: dict[str, float]
    description: str = Field(max_length=4000)
    severity: Literal["Sheen", "Patchy Oil", "Heavy Oil", "Tar Balls", "Debris / Containers", "Fire"]
    linkedCaseId: str | None = None
    source: str = Field(default="Field report", max_length=200)


@router.post("/sightings")
def add_sighting(body: SightingBody, user: User = Depends(require("alerting", "full")), db: Session = Depends(session)):
    s = SightingReport(
        id=f"SES-RPT-{secrets.token_hex(4)}", reporter=body.reporter, district=body.district, lat=body.position["lat"],
        lon=body.position["lon"], description=body.description, severity=body.severity, linked_case_id=body.linkedCaseId,
        source=body.source,
    )
    db.add(s)
    record(db, user, "Field report logged", body.linkedCaseId or s.id, f"{body.severity} reported by {body.reporter} ({body.district})", "Analysis")
    notify(db, "Field report logged", f"{body.severity} · {body.district}", "info", body.linkedCaseId, "alerting")
    db.commit()
    return serialize.sighting(s)


class LinkBody(BaseModel):
    caseId: str


def _sighting_target(db: Session, sighting_id: str) -> SightingReport | SightingPatch:
    s = db.get(SightingReport, sighting_id)
    if s is not None:
        return s
    patch = db.get(SightingPatch, sighting_id)
    if patch is None:
        patch = SightingPatch(sighting_id=sighting_id)
        db.add(patch)
    return patch


@router.post("/sightings/{sighting_id}/link")
def link_sighting(sighting_id: str, body: LinkBody, request: Request, user: User = Depends(require("alerting", "full")), db: Session = Depends(session)):
    if body.caseId not in _case_ids(request):
        raise HTTPException(404, "Case not found")
    target = _sighting_target(db, sighting_id)
    target.linked_case_id = body.caseId
    record(db, user, "Report linked to case", body.caseId, f"{sighting_id} attached as corroborating evidence", "Analysis")
    db.commit()
    return {"ok": True}


@router.post("/sightings/{sighting_id}/verify")
def verify_sighting(sighting_id: str, user: User = Depends(require("alerting", "full")), db: Session = Depends(session)):
    target = _sighting_target(db, sighting_id)
    target.verified = True
    record(db, user, "Report verified", sighting_id, "Marked verified", "Analysis")
    db.commit()
    return {"ok": True}


class AoiBody(BaseModel):
    name: str = Field(max_length=200)
    priority: int = Field(ge=1, le=99)
    bounds: dict[str, float]
    rationale: str = Field(default="", max_length=2000)
    monitored: bool = False


@router.post("/aois")
def add_aoi(body: AoiBody, user: User = Depends(require("satellite", "full")), db: Session = Depends(session)):
    b = body.bounds
    if not (b["north"] > b["south"] and b["east"] > b["west"]):
        raise HTTPException(422, "North must exceed south and east must exceed west")
    a = AreaOfInterest(id=f"AOI-SES-{secrets.token_hex(3)}", name=body.name, priority=body.priority, north=b["north"],
                       south=b["south"], east=b["east"], west=b["west"], rationale=body.rationale or "Analyst-requested planning area.",
                       requested_by=user.role, monitored=body.monitored)
    db.add(a)
    record(db, user, "Planning area created", a.id, body.name, "System")
    db.commit()
    return serialize.aoi(a)


class AoiPatch(BaseModel):
    pinned: bool | None = None
    priority: int | None = Field(default=None, ge=1, le=99)
    monitored: bool | None = None


@router.patch("/aois/{aoi_id}")
def update_aoi(aoi_id: str, body: AoiPatch, user: User = Depends(require("satellite", "full")), db: Session = Depends(session)):
    a = db.get(AreaOfInterest, aoi_id)
    if a is None:
        raise HTTPException(404, "Planning area not found")
    changes = []
    for field in ("pinned", "priority", "monitored"):
        value = getattr(body, field)
        if value is not None and value != getattr(a, field):
            setattr(a, field, value)
            changes.append(f"{field} → {value}")
    if changes:
        record(db, user, "Planning area updated", aoi_id, ", ".join(changes), "System")
    db.commit()
    return serialize.aoi(a)
