from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

from ..config import Settings
from ..http import CachedHttp
from .base import ProviderStatus, SanctionsCheck, VesselRecord

LIST_URL = "https://scsanctions.un.org/resources/xml/en/consolidated.xml"
IMO_RE = re.compile(r"IMO(?:\s*(?:number|no\.?|#))?\s*:?\s*(\d{7})", re.IGNORECASE)


def parse_list(xml_text: str) -> dict[str, str]:
    """Returns imo -> UN reference number. Matching is by IMO only: name matching against listed
    entities (mostly companies) produces false positives, and a false sanctions flag against a real
    vessel is far more damaging than a missed one."""
    root = ET.fromstring(xml_text)
    by_imo: dict[str, str] = {}
    for ent in root.iter("ENTITY"):
        ref = (ent.findtext("REFERENCE_NUMBER") or "").strip()
        for imo in IMO_RE.findall(" ".join(ent.itertext())):
            by_imo[imo] = ref
    return by_imo


class UnscSanctions:
    """UN Security Council Consolidated List. Interim until MEA / DG Shipping watchlists are integrated."""

    name = "unsc"
    agency = "UN Security Council Consolidated List"
    sovereign = False

    def __init__(self, settings: Settings, http: CachedHttp):
        self.settings = settings
        self.http = http

    def status(self) -> ProviderStatus:
        return ProviderStatus("sanctions", self.name, self.agency, self.sovereign, True, "Public XML, refreshed daily")

    def check(self, vessels: list[VesselRecord]) -> list[SanctionsCheck]:
        xml_text = self.http.get_text(LIST_URL, max_age_s=86400)
        by_imo = parse_list(xml_text)
        now = datetime.now(timezone.utc)
        out: list[SanctionsCheck] = []
        for v in vessels:
            if v.provenance != "real" or v.is_facility or not v.imo:
                continue
            ref = by_imo.get(v.imo)
            out.append(SanctionsCheck(v.key, v.name, v.imo, ref is not None, self.agency, ref, now))
        return out
