"""Render an evidence document as a PDF.

The layout follows a plain official-record style: a masthead, numbered sections, and a footer on
every page carrying the document identifier, the page number and the signature of the content.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, Frame, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle

INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#6b7280")
RULE = colors.HexColor("#d1d5db")
BAND = colors.HexColor("#f3f4f6")
ACCENT = colors.HexColor("#1e3a8a")


@dataclass
class Section:
    heading: str
    lines: list[str] = field(default_factory=list)
    pairs: list[tuple[str, str]] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)


@dataclass
class Document:
    title: str
    subtitle: str = ""
    case_id: str = ""
    kind: str = "report"
    prepared_by: str = ""
    prepared_role: str = ""
    sections: list[Section] = field(default_factory=list)
    footnote: str = ""


def content_hash(doc: Document) -> str:
    """A stable hash of what the document says, independent of fonts, dates and PDF internals."""
    payload = {
        "title": doc.title, "subtitle": doc.subtitle, "caseId": doc.case_id, "kind": doc.kind,
        "sections": [
            {"heading": s.heading, "lines": s.lines, "pairs": [list(p) for p in s.pairs],
             "columns": s.columns, "rows": s.rows}
            for s in doc.sections
        ],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()["BodyText"]
    body = ParagraphStyle("body", parent=base, fontName="Helvetica", fontSize=8.5, leading=12.5,
                          textColor=INK, alignment=TA_LEFT, spaceAfter=3)
    return {
        "title": ParagraphStyle("title", parent=body, fontName="Helvetica-Bold", fontSize=14, leading=18, spaceAfter=2),
        "subtitle": ParagraphStyle("subtitle", parent=body, fontSize=9, textColor=MUTED, spaceAfter=8),
        "heading": ParagraphStyle("heading", parent=body, fontName="Helvetica-Bold", fontSize=9.5, leading=13,
                                  textColor=ACCENT, spaceBefore=10, spaceAfter=4, keepWithNext=True),
        "body": body,
        "small": ParagraphStyle("small", parent=body, fontSize=7.5, leading=10.5, textColor=MUTED),
        "cell": ParagraphStyle("cell", parent=body, fontSize=7.5, leading=10, spaceAfter=0),
        "cellhead": ParagraphStyle("cellhead", parent=body, fontName="Helvetica-Bold", fontSize=7.5, leading=10, spaceAfter=0),
    }


def _escape(text: str) -> str:
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _column_widths(section: Section, total: float) -> list[float]:
    """Share the width out by how much text each column actually holds, within sane limits."""
    count = len(section.columns)
    weights = []
    for i, heading in enumerate(section.columns):
        longest = max([len(heading)] + [len(str(row[i])) for row in section.rows if i < len(row)])
        weights.append(min(max(longest, 8), 40))
    scale = total / sum(weights)
    return [w * scale for w in weights] if count else [total]


def render(doc: Document, *, document_id: str, signature: str, digest: str, issued_at: datetime | None = None) -> bytes:
    issued = issued_at or datetime.now(timezone.utc)
    s = _styles()
    buffer = BytesIO()
    width, height = A4
    margin = 18 * mm
    footer = f"{document_id} · content SHA-256 {digest[:24]}… · signature {signature[:16]}…"

    def decorate(canvas, _doc):
        canvas.saveState()
        canvas.setFont("Helvetica-Bold", 7.5)
        canvas.setFillColor(ACCENT)
        canvas.drawString(margin, height - margin + 8 * mm, "OCEANSPILL — MARITIME OIL SPILL DETECTION AND ATTRIBUTION")
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(MUTED)
        canvas.drawRightString(width - margin, height - margin + 8 * mm, "Official record")
        canvas.setStrokeColor(RULE)
        canvas.line(margin, height - margin + 6 * mm, width - margin, height - margin + 6 * mm)
        canvas.line(margin, margin - 4 * mm, width - margin, margin - 4 * mm)
        canvas.setFont("Helvetica", 6.5)
        canvas.drawString(margin, margin - 8 * mm, footer)
        canvas.drawRightString(width - margin, margin - 8 * mm, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    frame = Frame(margin, margin, width - 2 * margin, height - 2 * margin - 4 * mm, id="body",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    template = BaseDocTemplate(buffer, pagesize=A4, title=doc.title, author="OceanSpill",
                               subject=doc.case_id, leftMargin=margin, rightMargin=margin,
                               topMargin=margin, bottomMargin=margin)
    template.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=decorate)])

    flow: list = [Paragraph(_escape(doc.title), s["title"])]
    if doc.subtitle:
        flow.append(Paragraph(_escape(doc.subtitle), s["subtitle"]))
    meta = [
        ["Case", doc.case_id or "—", "Document", document_id],
        ["Prepared by", f"{doc.prepared_by} ({doc.prepared_role})" if doc.prepared_role else doc.prepared_by,
         "Issued", issued.strftime("%Y-%m-%d %H:%M UTC")],
    ]
    table = Table([[Paragraph(_escape(c), s["cellhead"] if i % 2 == 0 else s["cell"]) for i, c in enumerate(row)] for row in meta],
                  colWidths=[24 * mm, 68 * mm, 24 * mm, 58 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BAND),
        ("BOX", (0, 0), (-1, -1), 0.4, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    flow += [table, Spacer(1, 4)]

    for n, section in enumerate(doc.sections, start=1):
        block: list = [Paragraph(f"{n}. {_escape(section.heading).upper()}", s["heading"])]
        for line in section.lines:
            if line == "\f":
                flow.append(PageBreak())
                continue
            block.append(Paragraph(_escape(line) or "&nbsp;", s["body"]))
        if section.pairs:
            data = [[Paragraph(_escape(k), s["cellhead"]), Paragraph(_escape(v), s["cell"])] for k, v in section.pairs]
            t = Table(data, colWidths=[52 * mm, 122 * mm])
            t.setStyle(TableStyle([
                ("LINEBELOW", (0, 0), (-1, -2), 0.3, RULE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]))
            block.append(t)
        if section.columns and section.rows:
            head = [Paragraph(_escape(c), s["cellhead"]) for c in section.columns]
            body = [[Paragraph(_escape(str(c)), s["cell"]) for c in row] for row in section.rows]
            t = Table([head] + body, colWidths=_column_widths(section, width - 2 * margin), repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), BAND),
                ("GRID", (0, 0), (-1, -1), 0.3, RULE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]))
            block.append(t)
        # The heading stays with what follows it; long tables may still split across pages.
        flow.extend(block)

    if doc.footnote:
        flow += [Spacer(1, 8), Paragraph(_escape(doc.footnote), s["small"])]
    flow += [Spacer(1, 6), Paragraph(
        "Integrity: the content of this document hashes to the SHA-256 value printed in the footer and is signed with the "
        "issuing server's key. Upload the file to the verification page to confirm it has not been altered.", s["small"])]

    template.build(flow)
    return buffer.getvalue()
