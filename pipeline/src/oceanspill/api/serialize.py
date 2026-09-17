"""Convert rows to the JSON shapes the web app already uses (camelCase, epoch milliseconds)."""
from __future__ import annotations

from datetime import datetime, timezone

from . import models as m


def ms(dt: datetime | None) -> int | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def from_ms(value: int | float | None) -> datetime | None:
    return None if value is None else datetime.fromtimestamp(value / 1000, timezone.utc)


def user(u: m.User) -> dict:
    return {
        "id": u.id, "name": u.name, "email": u.email, "role": u.role, "agency": u.agency,
        "status": u.status, "lastLogin": ms(u.last_login) or 0, "mfa": u.mfa_enabled,
        "clearance": u.clearance, "hasPassword": bool(u.password_hash),
    }


def audit(a: m.AuditEntry) -> dict:
    return {"id": a.id, "t": ms(a.t), "actor": a.actor, "role": a.role, "action": a.action,
            "target": a.target, "detail": a.detail, "category": a.category, "provenance": a.provenance}


def case_state(s: m.CaseState) -> dict:
    return {"caseId": s.case_id, "status": s.status, "workflowStage": s.workflow_stage, "imacPushed": s.imac_pushed,
            "imacPushedAt": ms(s.imac_pushed_at), "alertDispatched": s.alert_dispatched,
            "lookalikeReason": s.lookalike_reason, "updatedAt": ms(s.updated_at), "version": s.version}


def alert(a: m.CommunityAlert) -> dict:
    return {"id": a.id, "caseId": a.case_id, "issuedAt": ms(a.issued_at), "channel": a.channel, "languages": a.languages,
            "districts": a.districts, "headline": a.headline, "body": a.body, "noGoRadiusKm": a.no_go_radius_km,
            "centre": {"lat": a.centre_lat, "lon": a.centre_lon}, "validUntil": ms(a.valid_until), "status": a.status,
            "reach": None, "issuer": a.issuer, "provenance": "session"}


def enforcement(e: m.EnforcementAction) -> dict:
    return {"id": e.id, "caseId": e.case_id, "mmsi": e.mmsi, "party": e.party, "type": e.type, "issuedAt": ms(e.issued_at),
            "authority": e.authority, "reference": e.reference, "amountInr": e.amount_inr, "status": e.status,
            "outcome": e.outcome, "provenance": "session"}


def sighting(s: m.SightingReport) -> dict:
    return {"id": s.id, "receivedAt": ms(s.received_at), "reporter": s.reporter, "district": s.district,
            "position": {"lat": s.lat, "lon": s.lon}, "description": s.description, "severity": s.severity,
            "linkedCaseId": s.linked_case_id, "verified": s.verified, "provenance": "session", "source": s.source}


def aoi(a: m.AreaOfInterest) -> dict:
    return {"id": a.id, "name": a.name, "priority": a.priority,
            "bounds": {"north": a.north, "south": a.south, "east": a.east, "west": a.west},
            "rationale": a.rationale, "pinned": a.pinned, "requestedBy": a.requested_by,
            "monitored": a.monitored, "provenance": "real" if a.built_in else "session"}


def scene(s: m.SceneRecord) -> dict:
    return {"id": s.id, "provider": s.provider, "platform": s.platform, "start": ms(s.start), "footprint": s.footprint,
            "aoiId": s.aoi_id, "sizeBytes": s.size_bytes, "online": s.online, "status": s.status, "error": s.error,
            "foundAt": ms(s.found_at)}


def detection(d: m.Detection) -> dict:
    return {"id": d.id, "sceneId": d.scene_id, "aoiId": d.aoi_id, "acquiredAt": ms(d.acquired_at), "outline": d.outline,
            "position": {"lat": d.lat, "lon": d.lon}, "areaKm2": d.area_km2, "score": d.score, "method": d.method,
            "measurements": d.measurements, "status": d.status, "reviewedAt": ms(d.reviewed_at), "notes": d.notes,
            "caseId": d.case_id, "createdAt": ms(d.created_at)}


def job(j: m.Job) -> dict:
    return {"id": j.id, "kind": j.kind, "status": j.status, "params": j.params, "createdAt": ms(j.created_at),
            "startedAt": ms(j.started_at), "finishedAt": ms(j.finished_at), "detail": j.detail, "error": j.error}


def notification(n: m.Notification) -> dict:
    return {"id": n.id, "createdAt": ms(n.created_at), "kind": n.kind, "title": n.title, "body": n.body,
            "target": n.target, "module": n.module}
