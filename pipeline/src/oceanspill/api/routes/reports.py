"""Signed evidence documents.

Two ways to produce one: the server builds a chain-of-custody record for a case from its own
artifacts and audit trail, or an analyst submits the sections of a report they composed on screen.
Either way the server renders the PDF, hashes it, signs the hash with the server key and keeps a
copy, so a document produced today can be checked against the record months later.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import pdf, serialize
from ..audit import record
from ..deps import current_user, require, session, state
from ..models import AuditEntry, CaseState, EnforcementAction, SignedDocument, User
from ..rules import identities_visible
from ..security import sign_digest, signature_matches

router = APIRouter(prefix="/api", tags=["reports"])

MAX_UPLOAD = 25 * 1024 * 1024


class SectionBody(BaseModel):
    heading: str = Field(max_length=200)
    lines: list[str] = Field(default_factory=list, max_length=4000)
    pairs: list[tuple[str, str]] = Field(default_factory=list, max_length=400)
    columns: list[str] = Field(default_factory=list, max_length=12)
    rows: list[list[str]] = Field(default_factory=list, max_length=4000)


class ReportBody(BaseModel):
    caseId: str = Field(default="", max_length=64)
    kind: str = Field(default="report", max_length=40)
    title: str = Field(max_length=300)
    subtitle: str = Field(default="", max_length=300)
    footnote: str = Field(default="", max_length=2000)
    sections: list[SectionBody] = Field(max_length=60)


def _issue(request: Request, db: Session, user: User, doc: pdf.Document, kind: str) -> tuple[SignedDocument, bytes]:
    st = state(request)
    document_id = f"OS-DOC-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{secrets.token_hex(3).upper()}"
    digest = pdf.content_hash(doc)
    signature = sign_digest(st.settings.signing_secret, digest)
    data = pdf.render(doc, document_id=document_id, signature=signature, digest=digest)
    key = f"documents/{document_id}.pdf"
    st.storage.put(key, data)
    row = SignedDocument(
        id=document_id, kind=kind, case_id=doc.case_id, title=doc.title, content_sha256=digest,
        sha256=hashlib.sha256(data).hexdigest(), signature=signature, storage_key=key,
        created_by=user.id, created_by_name=user.name,
    )
    db.add(row)
    record(db, user, "Evidence document issued", doc.case_id or document_id, f"{doc.title} ({document_id})", "Analysis")
    db.commit()
    return row, data


def _pdf_response(row: SignedDocument, data: bytes) -> Response:
    return Response(
        content=data, media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{row.id}.pdf"',
            "X-Document-Id": row.id, "X-Document-Sha256": row.sha256, "X-Document-Signature": row.signature,
        },
    )


@router.post("/reports")
def issue_report(body: ReportBody, request: Request, user: User = Depends(require("reports", "read")), db: Session = Depends(session)):
    """Render and sign a document from sections the analyst composed on screen."""
    doc = pdf.Document(
        title=body.title, subtitle=body.subtitle, case_id=body.caseId, kind=body.kind,
        prepared_by=user.name, prepared_role=f"{user.role}, {user.agency}", footnote=body.footnote,
        sections=[pdf.Section(heading=s.heading, lines=list(s.lines), pairs=[tuple(p) for p in s.pairs],
                              columns=list(s.columns), rows=[list(r) for r in s.rows]) for s in body.sections],
    )
    row, data = _issue(request, db, user, doc, body.kind)
    return _pdf_response(row, data)


@router.post("/cases/{case_id}/chain-of-custody")
def chain_of_custody(case_id: str, request: Request, user: User = Depends(current_user), db: Session = Depends(session)):
    """Build the case record from the server's own artifacts and audit trail, then sign it."""
    st = state(request)
    try:
        artifact = st.artifacts.case(case_id)
    except FileNotFoundError:
        raise HTTPException(404, "Case not found") from None
    visible = identities_visible(user.clearance)
    case = artifact["case"]
    incident = case.get("incident", {})
    oil = case.get("oil", {})
    cs = db.get(CaseState, case_id)
    trail = list(db.scalars(select(AuditEntry).where(AuditEntry.target == case_id).order_by(AuditEntry.t, AuditEntry.seq)))
    actions = list(db.scalars(select(EnforcementAction).where(EnforcementAction.case_id == case_id).order_by(EnforcementAction.created_at)))

    def pos(p: dict | None) -> str:
        return "—" if not p else f"{p.get('lat'):.4f} N, {p.get('lon'):.4f} E"

    def onboard() -> str:
        parts = [f"{o.get('product', '')} {o.get('tonnes', '—')} t" for o in oil.get("onboard") or []]
        return "; ".join(parts) or "—"

    sections = [
        pdf.Section("Incident", pairs=[
            ("Case identifier", case_id),
            ("Title", case.get("title", "")),
            ("Region", f"{case.get('region', '')} · {case.get('subRegion', '')}".strip(" ·")),
            ("Reported time", f"{incident.get('time', '—')} ({incident.get('timePrecision', 'unknown')} precision)"),
            ("Time note", str(incident.get("timeNote") or "—")),
            ("Reported position", pos(incident.get("position"))),
            ("Position precision", f"± {incident.get('positionPrecisionKm', '—')} km"),
            ("Position source", str(incident.get("positionSource") or "—")),
            ("Source type", str(case.get("sourceType", "—"))),
            ("Officially confirmed", "Yes" if case.get("officiallyConfirmed") else "Not confirmed in public records"),
        ]),
        pdf.Section("Oil on record", pairs=[
            ("Model type", str(oil.get("modelType", "—"))),
            ("Reported on board", onboard()),
            ("Quantity released", f"{oil['spilledTonnes']} t" if oil.get("spilledTonnes") is not None else "Not published"),
            ("Note", str(oil.get("spilledNote") or "—")),
        ]),
        pdf.Section("Status at the time of issue", pairs=[
            ("Case status", cs.status if cs else "Under Analysis"),
            ("Workflow stage", cs.workflow_stage if cs else "Awaiting Dispatch"),
            ("Alert dispatched", "Yes" if cs and cs.alert_dispatched else "No"),
            ("IMAC payload generated", "Yes" if cs and cs.imac_pushed else "No"),
            ("Reclassification", (cs.lookalike_reason if cs and cs.lookalike_reason else "—")),
        ]),
    ]

    provenance = [[s.get("kind", ""), s.get("name", ""), s.get("agency", ""), s.get("message", "")]
                  for s in st.artifacts.index().get("providers", [])]
    if provenance:
        sections.append(pdf.Section("Data provenance", columns=["Kind", "Provider", "Agency", "Access"], rows=provenance))

    scenes = artifact.get("sarMeasurements") or []
    if scenes:
        sections.append(pdf.Section(
            "SAR observations processed",
            lines=["Dark-spot detection is a classical adaptive-threshold method, not a trained model."],
            columns=["Scene", "Product", "Polarisation", "Spots"],
            rows=[[s.get("scene", ""), s.get("product", ""), s.get("polarisation", ""), str(len(s.get("spots", [])))] for s in scenes],
        ))

    vessels = [v for v in artifact.get("vessels", []) if not v.get("isFacility")]
    if vessels:
        sections.append(pdf.Section(
            "Vessels present in the AIS window",
            lines=["Identity from Global Fishing Watch AIS. Presence is not evidence of discharge; the attribution "
                   "ranking is computed in the analysis client at view time from these positions."],
            columns=["Vessel", "MMSI", "IMO", "Flag", "Type"],
            rows=[[v.get("name", ""), (v.get("mmsi") or "—") if visible else "Withheld",
                   (v.get("imo") or "—") if visible else "Withheld", v.get("flag", "—"), v.get("type", "—")]
                  for v in vessels[:60]],
        ))

    if actions:
        sections.append(pdf.Section(
            "Enforcement actions recorded",
            columns=["Type", "Party", "Authority", "Reference", "Status"],
            rows=[[a.type, a.party, a.authority, a.reference or "—", a.status] for a in actions],
        ))

    sections.append(pdf.Section(
        "Human decision trail",
        lines=["No recorded actions yet."] if not trail else [],
        columns=["Time (UTC)", "Actor", "Role", "Action", "Detail"] if trail else [],
        rows=[[e.t.strftime("%Y-%m-%d %H:%M"), e.actor, e.role, e.action, e.detail] for e in trail],
    ))

    published = case.get("sources") or []
    if published:
        sections.append(pdf.Section(
            "Published sources",
            columns=["Document", "Location"],
            rows=[[s.get("title", ""), s.get("url", "")] for s in published],
        ))

    warnings = artifact.get("warnings") or []
    if warnings:
        sections.append(pdf.Section("Data warnings", lines=[f"— {w}" for w in warnings]))

    doc = pdf.Document(
        title=f"Chain of custody — {case.get('title', case_id)}",
        subtitle="Every input with its provenance, and every human action taken on the case.",
        case_id=case_id, kind="chain-of-custody", prepared_by=user.name,
        prepared_role=f"{user.role}, {user.agency}", sections=sections,
        footnote="Attribution scores are a prioritisation tool derived from spatio-temporal correlation and do not "
                 "constitute evidence of discharge." + ("" if visible else " Vessel identifiers are withheld at this clearance level."),
    )
    row, data = _issue(request, db, user, doc, "chain-of-custody")
    return _pdf_response(row, data)


@router.get("/documents")
def list_documents(user: User = Depends(require("reports", "read")), db: Session = Depends(session)):
    rows = db.scalars(select(SignedDocument).order_by(SignedDocument.created_at.desc()).limit(200))
    return [{"id": d.id, "kind": d.kind, "caseId": d.case_id, "title": d.title, "sha256": d.sha256,
             "contentSha256": d.content_sha256, "signature": d.signature, "createdAt": serialize.ms(d.created_at),
             "createdBy": d.created_by_name} for d in rows]


@router.get("/documents/{document_id}/file")
def download_document(document_id: str, request: Request, user: User = Depends(require("reports", "read")), db: Session = Depends(session)):
    row = db.get(SignedDocument, document_id)
    if row is None:
        raise HTTPException(404, "Document not found")
    try:
        data = state(request).storage.get(row.storage_key)
    except FileNotFoundError:
        raise HTTPException(410, "The stored copy of this document is no longer available") from None
    return _pdf_response(row, data)


@router.post("/documents/verify")
async def verify_document(request: Request, file: UploadFile = File(...), user: User = Depends(require("reports", "read")),
                          db: Session = Depends(session)):
    """Check an uploaded PDF against the issuing record: same bytes, and a signature the server made."""
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File is larger than 25 MB")
    digest = hashlib.sha256(data).hexdigest()
    row = db.scalar(select(SignedDocument).where(SignedDocument.sha256 == digest))
    if row is None:
        return {"verified": False, "reason": "No document with this exact content was issued by this server"}
    ok = signature_matches(state(request).settings.signing_secret, row.content_sha256, row.signature)
    return {"verified": ok, "reason": None if ok else "The signature does not match this server's key",
            "document": {"id": row.id, "kind": row.kind, "caseId": row.case_id, "title": row.title,
                         "createdAt": serialize.ms(row.created_at), "createdBy": row.created_by_name,
                         "sha256": row.sha256, "signature": row.signature}}
