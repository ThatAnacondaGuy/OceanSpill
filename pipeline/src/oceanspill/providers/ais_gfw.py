from __future__ import annotations

import copy
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from ..config import Settings
from ..geo import haversine_km, iso, parse_time
from ..http import CachedHttp
from .ais_synthetic import SyntheticAis
from .base import ProviderStatus, Track, VesselRecord

API_URL = "https://gateway.api.globalfishingwatch.org/v3"
IDENTITY_DATASET = "public-global-vessel-identity:latest"
GAPS_DATASET = "public-global-gaps-events:latest"
LOITERING_DATASET = "public-global-loitering-events:latest"
PORT_VISITS_DATASET = "public-global-port-visits-events:latest"
ENCOUNTERS_DATASET = "public-global-encounters-events:latest"

VESSEL_EVENT_DATASETS = (GAPS_DATASET, LOITERING_DATASET, PORT_VISITS_DATASET, ENCOUNTERS_DATASET)
REGION_EVENT_DATASETS = (GAPS_DATASET, LOITERING_DATASET)
PAGE_LIMIT = 500
MAX_REGION_VESSELS = 12
# Anchors implying a faster transit than this are inconsistent (overlapping events) and dropped.
MAX_ANCHOR_SPEED_KN = 35
# Candidates are only placed near their reported events; their positions elsewhere are unknown.
CANDIDATE_WINDOW_H = 8

GFW_TYPES = {
    "FISHING": "Fishing Vessel", "CARGO": "General Cargo", "CARRIER": "Reefer / Carrier", "BUNKER": "Bunker Tanker",
    "PASSENGER": "Passenger Vessel", "SUPPORT": "Offshore Supply", "GEAR": "Fishing Gear", "SEISMIC_VESSEL": "Seismic Vessel",
}


def _date(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def _overlaps(info: dict[str, Any], start: datetime, end: datetime) -> bool:
    t0 = info.get("transmissionDateFrom")
    t1 = info.get("transmissionDateTo")
    if not t0 or not t1:
        return True
    return parse_time(t0) <= end and parse_time(t1) >= start


def event_anchors(event: dict[str, Any]) -> list[dict[str, Any]]:
    """Real positions from a GFW event, as anchors the track generator must pass through."""
    kind = (event.get("type") or "").lower()
    start = event.get("start")
    end = event.get("end") or start
    source = f"Global Fishing Watch {kind} event {event.get('id', '')}".strip()
    pos = event.get("position") or {}
    anchors: list[dict[str, Any]] = []

    def add(time: str | None, p: dict[str, Any] | None, label: str, **extra: Any) -> None:
        if time and p and p.get("lat") is not None and p.get("lon") is not None:
            anchors.append({"time": time, "event": label, "lat": float(p["lat"]), "lon": float(p["lon"]),
                            "positionPrecisionKm": 1, "source": source, **extra})

    if kind == "gap":
        gap = event.get("gap") or {}
        hours = gap.get("durationHours")
        flagged = " (flagged as likely intentional)" if gap.get("intentionalDisabling") else ""
        add(start, gap.get("offPosition") or pos, f"AIS off{f' for {float(hours):.1f} h' if hours else ''}{flagged}")
        add(end, gap.get("onPosition"), "AIS back on")
    elif kind == "loitering":
        lo = event.get("loitering") or {}
        speed = lo.get("averageSpeedKnots")
        add(start, pos, f"Loitering starts{f' (avg {float(speed):.1f} kn)' if speed is not None else ''}")
        add(end, pos, "Loitering ends")
    elif kind == "port_visit":
        add(start, pos, "Port visit starts", navStatus=5, sog=0)
        add(end, pos, "Port visit ends", navStatus=5, sog=0)
    elif kind == "encounter":
        other = ((event.get("encounter") or {}).get("vessel") or {}).get("name") or "another vessel"
        add(start, pos, f"Encounter with {other} starts")
        add(end, pos, "Encounter ends")
    return anchors


def consistent(anchors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Time-sorted anchors with physically impossible jumps removed; reported anchors always win."""
    ordered = sorted(anchors, key=lambda a: (parse_time(a["time"]), 0 if "Global Fishing Watch" not in a["source"] else 1))
    kept: list[dict[str, Any]] = []
    for a in ordered:
        if kept:
            prev = kept[-1]
            hours = (parse_time(a["time"]) - parse_time(prev["time"])).total_seconds() / 3600
            dist = haversine_km(prev["lat"], prev["lon"], a["lat"], a["lon"])
            if hours <= 0 and dist > 1 or hours > 0 and dist / 1.852 / hours > MAX_ANCHOR_SPEED_KN:
                if "Global Fishing Watch" in a["source"]:
                    continue
        kept.append(a)
    return kept


class GfwAis:
    """Real AIS identities and events from Global Fishing Watch.

    GFW's public API does not return raw position reports, only vessel identity and derived
    events (AIS gaps, loitering, port visits, encounters) with real positions and times. This
    adapter resolves each reported vessel against GFW, adds vessels with AIS gaps or loitering in
    the case area as candidates, and uses those real event positions as anchors. Positions between
    anchors are still interpolated and marked synthetic-anchored; real AIS-off periods are cut out
    of the tracks so gap detection reflects what GFW actually observed.
    """

    name = "gfw"
    agency = "Global Fishing Watch (AIS identity and events)"
    sovereign = False

    def __init__(self, settings: Settings, http: CachedHttp, synthetic: SyntheticAis):
        self.settings = settings
        self.http = http
        self.synthetic = synthetic

    def status(self) -> ProviderStatus:
        ok = bool(self.settings.gfw_api_token)
        msg = ("Real vessel identity and AIS gap / loitering / port-visit events; tracks between events interpolated"
               if ok else "Set GFW_API_TOKEN (free for non-commercial use)")
        return ProviderStatus("ais", self.name, self.agency, self.sovereign, ok, msg)

    # ---- API calls ----------------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        if not self.settings.gfw_api_token:
            raise RuntimeError("GFW_API_TOKEN is not set")
        return {"Authorization": f"Bearer {self.settings.gfw_api_token}"}

    def identity(self, vessel: dict[str, Any], start: datetime, end: datetime) -> dict[str, Any] | None:
        if vessel.get("mmsi"):
            where = f"ssvid='{vessel['mmsi']}'"
        elif vessel.get("imo"):
            where = f"imo='{vessel['imo']}'"
        else:
            return None
        payload = self.http.request_json(
            "GET", f"{API_URL}/vessels/search", headers=self._headers(),
            params={"where": where, "datasets[0]": IDENTITY_DATASET, "limit": 20},
        )
        candidates = [info for entry in payload.get("entries", []) for info in entry.get("selfReportedInfo", [])]
        overlapping = [c for c in candidates if c.get("id") and _overlaps(c, start, end)]
        if not overlapping:
            return None
        best = max(overlapping, key=lambda c: c.get("transmissionDateTo") or "")
        return {"id": best["id"], "ssvid": best.get("ssvid"), "shipname": best.get("shipname"), "flag": best.get("flag"),
                "imo": best.get("imo"), "transmissionDateFrom": best.get("transmissionDateFrom"),
                "transmissionDateTo": best.get("transmissionDateTo")}

    def events(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = self.http.request_json(
                "POST", f"{API_URL}/events", headers=self._headers(),
                params={"limit": PAGE_LIMIT, "offset": offset}, json_body=body,
            )
            entries = page.get("entries", [])
            out.extend(entries)
            next_offset = page.get("nextOffset")
            if not entries or next_offset is None or next_offset <= offset:
                return out
            offset = int(next_offset)

    def vessel_events(self, vessel_id: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for dataset in VESSEL_EVENT_DATASETS:
            events.extend(self.events({"datasets": [dataset], "vessels": [vessel_id],
                                       "startDate": _date(start), "endDate": _date(end + timedelta(days=1))}))
        return [e for e in events if e.get("start") and parse_time(e["start"]) <= end and parse_time(e.get("end") or e["start"]) >= start]

    def region_events(self, box: dict[str, float], start: datetime, end: datetime) -> list[dict[str, Any]]:
        ring = [[box["west"], box["south"]], [box["east"], box["south"]], [box["east"], box["north"]],
                [box["west"], box["north"]], [box["west"], box["south"]]]
        events: list[dict[str, Any]] = []
        for dataset in REGION_EVENT_DATASETS:
            events.extend(self.events({"datasets": [dataset], "startDate": _date(start), "endDate": _date(end + timedelta(days=1)),
                                       "geometry": {"type": "Polygon", "coordinates": [ring]}}))
        return [e for e in events if e.get("start") and parse_time(e["start"]) <= end and parse_time(e.get("end") or e["start"]) >= start]

    # ---- track assembly -----------------------------------------------------------------------

    def tracks(self, case: dict[str, Any], start: datetime, end: datetime) -> tuple[list[VesselRecord], list[Track]]:
        case = copy.deepcopy(case)
        gfw_info: dict[str, dict[str, Any]] = {}
        gaps: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)
        known_ssvids: set[str] = set()

        for v in case.get("vessels", []):
            ident = self.identity(v, start, end)
            if not ident:
                gfw_info[v["name"]] = {"matched": False}
                continue
            known_ssvids.add(str(ident.get("ssvid")))
            evs = self.vessel_events(ident["id"], start, end)
            new_anchors = [a for e in evs for a in event_anchors(e)]
            v["anchors"] = consistent([*v.get("anchors", []), *new_anchors])
            gfw_info[v["name"]] = {"matched": True, **ident, "events": len(evs)}
            gaps[v["name"]].extend(self._gap_windows(evs))

        candidates = self._region_candidates(case, start, end, known_ssvids)
        for c in candidates:
            gaps[c["name"]].extend(c.pop("_gaps"))
            gfw_info[c["name"]] = c.pop("_gfw")
        case.setdefault("vessels", []).extend(candidates)
        if candidates:
            # Real traffic replaces synthetic decoys; they would only dilute the real signal.
            case.setdefault("analysis", {})["backgroundVessels"] = 0

        vessels, tracks = self.synthetic.tracks(case, start, end)
        for rec, trk in zip(vessels, tracks):
            info = gfw_info.get(rec.name)
            if rec.provenance != "real" or rec.is_facility or info is None:
                continue
            rec.registry = {**rec.registry, "gfw": info}
            if not info.get("matched"):
                trk.notes.append("No Global Fishing Watch identity match for this vessel in the window")
                continue
            trk.notes[0] = "Track passes through reported positions and Global Fishing Watch event positions; segments between them are interpolated"
            for g0, g1 in gaps.get(rec.name, []):
                before = len(trk.pings)
                trk.pings = [p for p in trk.pings if not (g0 < p.t < g1)]
                if len(trk.pings) < before:
                    trk.notes.append(f"Real AIS gap from GFW: {iso(g0)} to {iso(g1)}")
        return vessels, tracks

    @staticmethod
    def _gap_windows(events: list[dict[str, Any]]) -> list[tuple[datetime, datetime]]:
        return [(parse_time(e["start"]), parse_time(e["end"])) for e in events
                if (e.get("type") or "").lower() == "gap" and e.get("start") and e.get("end")]

    def _region_candidates(self, case: dict[str, Any], start: datetime, end: datetime, known: set[str]) -> list[dict[str, Any]]:
        box = case.get("analysis", {}).get("forcingBox")
        if not box:
            return []
        by_vessel: dict[str, list[dict[str, Any]]] = defaultdict(list)
        meta: dict[str, dict[str, Any]] = {}
        for e in self.region_events(box, start, end):
            vessel = e.get("vessel") or {}
            vid = vessel.get("id")
            if not vid or str(vessel.get("ssvid")) in known:
                continue
            by_vessel[vid].append(e)
            meta[vid] = vessel
        ranked = sorted(by_vessel.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:MAX_REGION_VESSELS]
        out = []
        for vid, evs in ranked:
            vessel = meta[vid]
            anchors = consistent([a for e in evs for a in event_anchors(e)])
            if not anchors:
                continue
            name = (vessel.get("name") or f"UNNAMED {vessel.get('ssvid', vid)[:9]}").upper()
            kinds = sorted({(e.get("type") or "").lower() for e in evs})
            out.append({
                "role": "candidate", "name": name, "mmsi": vessel.get("ssvid"), "imo": None,
                "flag": vessel.get("flag"), "type": GFW_TYPES.get((vessel.get("type") or "").upper(), "Merchant Vessel"),
                "cruiseSpeedKn": 10, "anchors": anchors, "placementWindowH": CANDIDATE_WINDOW_H,
                "note": f"Real vessel with {len(evs)} Global Fishing Watch event(s) ({', '.join(kinds)}) in the case area",
                "_gaps": self._gap_windows(evs),
                "_gfw": {"matched": True, "id": vid, "ssvid": vessel.get("ssvid"), "shipname": vessel.get("name"),
                         "flag": vessel.get("flag"), "events": len(evs)},
            })
        return out
