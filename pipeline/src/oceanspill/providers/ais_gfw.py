from __future__ import annotations

import copy
import difflib
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import Settings
from ..geo import bearing_deg, epoch_ms, haversine_km, iso, parse_time
from ..http import CachedHttp
from .ais_synthetic import SyntheticAis
from .base import Ping, ProviderStatus, Track, VesselRecord

API_URL = "https://gateway.api.globalfishingwatch.org/v3"
IDENTITY_DATASET = "public-global-vessel-identity:latest"
GAPS_DATASET = "public-global-gaps-events:latest"
LOITERING_DATASET = "public-global-loitering-events:latest"
PORT_VISITS_DATASET = "public-global-port-visits-events:latest"
ENCOUNTERS_DATASET = "public-global-encounters-events:latest"
PRESENCE_DATASET = "public-global-presence:latest"

VESSEL_EVENT_DATASETS = (GAPS_DATASET, LOITERING_DATASET, PORT_VISITS_DATASET, ENCOUNTERS_DATASET)
REGION_EVENT_DATASETS = (GAPS_DATASET, LOITERING_DATASET)
PAGE_LIMIT = 500
MAX_REGION_VESSELS = 12
# Anchors implying a faster transit than this are inconsistent (overlapping events) and dropped.
MAX_ANCHOR_SPEED_KN = 35
# Candidates are only placed near their reported events; their positions elsewhere are unknown.
CANDIDATE_WINDOW_H = 8
# Event positions further than this outside the case area (e.g. a port call in another country)
# would be joined to the incident by a straight line across land, so they are not used as anchors.
AREA_MARGIN_DEG = 1.5

# Hourly AIS presence (4Wings report, 0.01 degree cells) around the incident.
PRESENCE_RADIUS_DEG = 1.0
PRESENCE_CHUNK_DAYS = 2
PRESENCE_MAX_CANDIDATES = 30
# Hourly positions: only silences of three hours or more count as gaps.
PRESENCE_GAP_MIN = 180
# A vessel last or next seen this close to the query boundary probably just left the area.
PRESENCE_EDGE_KM = 6.0
PRESENCE_NOTE = "Real AIS positions: Global Fishing Watch hourly vessel presence (0.01 degree cells); speed and course derived from consecutive hours"
NAME_MATCH_RATIO = 0.85

GFW_TYPES = {
    "FISHING": "Fishing Vessel", "CARGO": "General Cargo", "CARRIER": "Reefer / Carrier", "BUNKER": "Bunker Tanker",
    "PASSENGER": "Passenger Vessel", "SUPPORT": "Offshore Supply", "GEAR": "Fishing Gear", "SEISMIC_VESSEL": "Seismic Vessel",
    "TANKER": "Tanker", "OTHER": "Merchant Vessel",
}


def _date(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def _norm(name: str | None) -> str:
    return "".join(ch for ch in (name or "").upper() if ch.isalnum())


def _overlaps(info: dict[str, Any], start: datetime, end: datetime) -> bool:
    t0 = info.get("transmissionDateFrom")
    t1 = info.get("transmissionDateTo")
    if not t0 or not t1:
        return True
    return parse_time(t0) <= end and parse_time(t1) >= start


def presence_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Rows from a 4Wings report response shaped {"entries": [{"<dataset>": [rows]}]}."""
    return [r for entry in payload.get("entries", []) for rows in entry.values() if isinstance(rows, list) for r in rows]


def presence_tracks(rows: list[dict[str, Any]], start: datetime, end: datetime) -> dict[str, dict[str, Any]]:
    """Hourly positions per vessel. Cells a vessel crossed within one hour are averaged by time spent."""
    cells: dict[str, dict[datetime, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0]))
    meta: dict[str, dict[str, Any]] = {}
    for r in rows:
        vid, date = r.get("vesselId"), r.get("date")
        if not vid or not date or r.get("lat") is None or r.get("lon") is None:
            continue
        hour = datetime.strptime(date, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
        w = float(r.get("hours") or 1.0)
        acc = cells[vid][hour]
        acc[0] += w
        acc[1] += w * float(r["lat"])
        acc[2] += w * float(r["lon"])
        meta.setdefault(vid, r)
    out = {}
    for vid, hours in cells.items():
        points = sorted((h + timedelta(minutes=30), a[1] / a[0], a[2] / a[0]) for h, a in hours.items() if a[0] > 0)
        points = [p for p in points if start <= p[0] <= end]
        if points:
            out[vid] = {"meta": meta[vid], "points": points}
    return out


def pings_from_points(points: list[tuple[datetime, float, float]]) -> list[Ping]:
    pings = []
    for i, (t, lat, lon) in enumerate(points):
        j = i + 1 if i + 1 < len(points) else i - 1
        if j < 0:
            pings.append(Ping(t, round(lat, 5), round(lon, 5), 0.0, 0.0, 0.0, 15))
            continue
        a, b = (points[i], points[j]) if j > i else (points[j], points[i])
        hours = (b[0] - a[0]).total_seconds() / 3600
        dist = haversine_km(a[1], a[2], b[1], b[2])
        sog = dist / 1.852 / hours if hours > 0 else 0.0
        cog = bearing_deg(a[1], a[2], b[1], b[2]) if dist > 0.3 else 0.0
        # Navigational status is not part of presence data: 15 is "not defined" in the AIS standard.
        pings.append(Ping(t, round(lat, 5), round(lon, 5), round(min(sog, 40.0), 1), round(cog, 1), round(cog, 1), 15))
    return pings


def _edge_km(lat: float, lon: float, box: dict[str, float]) -> float:
    kx = 111.32 * math.cos(math.radians(lat))
    return min((lat - box["south"]) * 110.574, (box["north"] - lat) * 110.574, (lon - box["west"]) * kx, (box["east"] - lon) * kx)


def presence_gaps(points: list[tuple[datetime, float, float]], box: dict[str, float]) -> list[dict[str, Any]]:
    """Silences inside the area. A vessel seen near the query boundary before or after is treated as having left it."""
    gaps = []
    for a, b in zip(points, points[1:]):
        minutes = (b[0] - a[0]).total_seconds() / 60
        if minutes < PRESENCE_GAP_MIN:
            continue
        if _edge_km(a[1], a[2], box) < PRESENCE_EDGE_KM or _edge_km(b[1], b[2], box) < PRESENCE_EDGE_KM:
            continue
        dist = haversine_km(a[1], a[2], b[1], b[2])
        gaps.append({"start": epoch_ms(a[0]), "end": epoch_ms(b[0]), "minutes": round(minutes), "distanceKm": round(dist, 1),
                     "impliedSpeedKn": round(dist / 1.852 / (minutes / 60), 1)})
    return gaps


def _mark_silent(trk: Track, info: dict[str, Any]) -> None:
    """GFW shows this vessel was not transmitting during the window, so no AIS positions are invented for it."""
    trk.pings = []
    trk.gaps = []
    trk.provenance = "real"
    trk.notes = [
        "No AIS transmissions in this window according to Global Fishing Watch "
        f"(identity transmitted {str(info.get('transmissionDateFrom'))[:10]} to {str(info.get('transmissionDateTo'))[:10]}); "
        "reported positions shown as anchors only"
    ]


def presence_box(case: dict[str, Any]) -> dict[str, float]:
    inc = case["incident"]["position"]
    box = {"west": inc["lon"] - PRESENCE_RADIUS_DEG, "south": inc["lat"] - PRESENCE_RADIUS_DEG,
           "east": inc["lon"] + PRESENCE_RADIUS_DEG, "north": inc["lat"] + PRESENCE_RADIUS_DEG}
    fb = case.get("analysis", {}).get("forcingBox")
    if fb:
        box = {"west": max(box["west"], fb["west"]), "south": max(box["south"], fb["south"]),
               "east": min(box["east"], fb["east"]), "north": min(box["north"], fb["north"])}
    return box


def _in_area(anchor: dict[str, Any], box: dict[str, float] | None) -> bool:
    if not box:
        return True
    return (box["south"] - AREA_MARGIN_DEG <= anchor["lat"] <= box["north"] + AREA_MARGIN_DEG
            and box["west"] - AREA_MARGIN_DEG <= anchor["lon"] <= box["east"] + AREA_MARGIN_DEG)


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
        """Best GFW identity for a reported vessel, matched on MMSI, IMO or exact name.

        Returns None when nothing matches. A match that did not transmit during the window is still
        returned (inWindow False), because "last AIS transmission before the incident" is a fact.
        """
        if vessel.get("mmsi"):
            where = f"ssvid='{vessel['mmsi']}'"
        elif vessel.get("imo"):
            where = f"imo='{vessel['imo']}'"
        elif vessel.get("name"):
            where = "shipname='{}'".format(vessel["name"].upper().replace("'", "''"))
        else:
            return None
        payload = self.http.request_json(
            "GET", f"{API_URL}/vessels/search", headers=self._headers(),
            params={"where": where, "datasets[0]": IDENTITY_DATASET, "limit": 20},
        )
        candidates = [info for entry in payload.get("entries", []) for info in entry.get("selfReportedInfo", []) if info.get("id")]
        if not candidates:
            return None
        # MMSIs get reused and spoofed, so one MMSI can map to several identities.
        # Prefer the record whose IMO or ship name matches the reported vessel.
        want_name = _norm(vessel.get("name"))
        by_name_only = not vessel.get("mmsi") and not vessel.get("imo")

        def score(c: dict[str, Any]) -> tuple[int, int, int, str]:
            imo_match = bool(vessel.get("imo")) and str(c.get("imo") or "") == str(vessel["imo"])
            name_match = bool(want_name) and _norm(c.get("shipname")) == want_name
            return (2 * imo_match + name_match, int(_overlaps(c, start, end)), 1 if c.get("shipname") else 0,
                    c.get("transmissionDateTo") or "")

        best = max(candidates, key=score)
        overlapping = [c for c in candidates if _overlaps(c, start, end)]
        if score(best)[0] == 0 and (by_name_only or len(overlapping) != 1):
            return None
        return {"id": best["id"], "ssvid": best.get("ssvid"), "shipname": best.get("shipname"), "flag": best.get("flag"),
                "imo": best.get("imo"), "transmissionDateFrom": best.get("transmissionDateFrom"),
                "transmissionDateTo": best.get("transmissionDateTo"), "inWindow": _overlaps(best, start, end)}

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

    def presence(self, box: dict[str, float], start: datetime, end: datetime) -> list[dict[str, Any]]:
        ring = [[box["west"], box["south"]], [box["east"], box["south"]], [box["east"], box["north"]],
                [box["west"], box["north"]], [box["west"], box["south"]]]
        rows: list[dict[str, Any]] = []
        day = start.date()
        last = end.date()
        while day <= last:
            chunk_end = min(day + timedelta(days=PRESENCE_CHUNK_DAYS), last + timedelta(days=1))
            payload = self.http.request_json(
                "POST", f"{API_URL}/4wings/report", headers=self._headers(), timeout=300,
                params={"spatial-resolution": "HIGH", "temporal-resolution": "HOURLY", "group-by": "VESSEL_ID",
                        "datasets[0]": PRESENCE_DATASET, "date-range": f"{day:%Y-%m-%d},{chunk_end:%Y-%m-%d}", "format": "JSON"},
                json_body={"geojson": {"type": "Polygon", "coordinates": [ring]}},
            )
            rows.extend(presence_rows(payload))
            day = chunk_end
        return rows

    def tracks(self, case: dict[str, Any], start: datetime, end: datetime) -> tuple[list[VesselRecord], list[Track]]:
        box = presence_box(case)
        try:
            presence = presence_tracks(self.presence(box, start, end), start, end)
        except Exception as exc:  # presence is the largest GFW dataset and can time out; events still work
            presence, error = {}, str(exc)
        else:
            error = None
        if presence:
            return self._tracks_from_presence(case, start, end, presence, box)
        vessels, tracks = self._tracks_from_events(case, start, end)
        note = f"No hourly AIS presence available ({error[:120]})" if error else "No hourly AIS presence in the area for this window"
        for rec, trk in zip(vessels, tracks):
            if rec.provenance == "real" and not rec.is_facility:
                trk.notes.append(note)
        return vessels, tracks

    def _match_presence(self, v: dict[str, Any], ident: dict[str, Any] | None, presence: dict[str, dict[str, Any]], used: set[str]) -> str | None:
        free = {vid: p for vid, p in presence.items() if vid not in used}
        if ident and ident.get("id") in free:
            return ident["id"]
        mmsis = {str(x) for x in (v.get("mmsi"), (ident or {}).get("ssvid")) if x}
        for vid, p in free.items():
            if str(p["meta"].get("mmsi") or "") in mmsis:
                return vid
        if v.get("imo"):
            for vid, p in free.items():
                if str(p["meta"].get("imo") or "") == str(v["imo"]):
                    return vid
        want = _norm(v.get("name"))
        scored = sorted(((difflib.SequenceMatcher(None, want, _norm(p["meta"].get("shipName"))).ratio(), vid) for vid, p in free.items()), reverse=True)
        if scored and scored[0][0] >= NAME_MATCH_RATIO and (len(scored) == 1 or scored[1][0] < scored[0][0]):
            return scored[0][1]
        return None

    def _tracks_from_presence(
        self, case: dict[str, Any], start: datetime, end: datetime, presence: dict[str, dict[str, Any]], box: dict[str, float]
    ) -> tuple[list[VesselRecord], list[Track]]:
        case = copy.deepcopy(case)
        case.setdefault("analysis", {})["backgroundVessels"] = 0
        used: set[str] = set()
        matches: dict[str, str] = {}
        infos: dict[str, dict[str, Any]] = {}
        for v in case.get("vessels", []):
            ident = self.identity(v, start, end)
            vid = self._match_presence(v, ident, presence, used)
            info: dict[str, Any] = {"matched": bool(ident or vid), **(ident or {})}
            if vid:
                used.add(vid)
                matches[v["name"]] = vid
                meta = presence[vid]["meta"]
                info.update({"presenceVesselId": vid, "shipname": meta.get("shipName"), "ssvid": meta.get("mmsi"),
                             "hours": len(presence[vid]["points"]), "inWindow": True})
                v["mmsi"] = v.get("mmsi") or meta.get("mmsi")
                v["imo"] = v.get("imo") or meta.get("imo")
            infos[v["name"]] = info

        vessels, tracks = self.synthetic.tracks(case, start, end)
        for rec, trk in zip(vessels, tracks):
            if rec.provenance != "real" or rec.is_facility:
                continue
            rec.registry = {**rec.registry, "gfw": infos.get(rec.name, {"matched": False})}
            vid = matches.get(rec.name)
            info = infos.get(rec.name, {})
            if not vid and info.get("matched") and info.get("inWindow") is False:
                _mark_silent(trk, info)
                continue
            if vid:
                points = presence[vid]["points"]
                trk.pings = pings_from_points(points)
                trk.provenance = "real"
                trk.gaps = presence_gaps(points, box)
                trk.notes = [PRESENCE_NOTE, f"{len(points)} hourly positions; reported positions kept as anchors for reference"]
            else:
                trk.notes.append("Not seen in Global Fishing Watch hourly AIS presence near the incident; track interpolated between reported positions")

        inc = case["incident"]["position"]
        known_mmsi = {v.mmsi for v in vessels if v.mmsi}
        ranked = []
        for vid, p in presence.items():
            meta = p["meta"]
            if vid in used or str(meta.get("mmsi") or "") in known_mmsi:
                continue
            if (meta.get("vesselType") or meta.get("geartype") or "").upper() == "GEAR":
                continue
            nearest = min(haversine_km(lat, lon, inc["lat"], inc["lon"]) for _, lat, lon in p["points"])
            ranked.append((nearest, vid))
        for _, vid in sorted(ranked)[:PRESENCE_MAX_CANDIDATES]:
            meta = presence[vid]["meta"]
            points = presence[vid]["points"]
            mmsi = str(meta["mmsi"]) if meta.get("mmsi") else None
            name = (meta.get("shipName") or f"UNNAMED {mmsi or vid[:8]}").upper()
            key = f"MMSI-{mmsi}" if mmsi else f"GFW-{vid[:12]}"
            vtype = (meta.get("vesselType") or "").upper()
            vessels.append(VesselRecord(
                key=key, name=name, type=GFW_TYPES.get(vtype, "Merchant Vessel"), role="candidate", provenance="real",
                mmsi=mmsi, imo=meta.get("imo"), flag=meta.get("flag"),
                registry={"verified": False, "note": "Registry history not verified (DG Shipping / Equasis access pending)",
                          "gfw": {"matched": True, "presenceVesselId": vid, "shipname": meta.get("shipName"), "ssvid": mmsi,
                                  "hours": len(points), "inWindow": True}},
                note=f"Real vessel in Global Fishing Watch AIS presence within {PRESENCE_RADIUS_DEG:g} degree of the incident",
            ))
            tracks.append(Track(key, pings_from_points(points), "real", [PRESENCE_NOTE], presence_gaps(points, box)))
        return vessels, tracks

    def _tracks_from_events(self, case: dict[str, Any], start: datetime, end: datetime) -> tuple[list[VesselRecord], list[Track]]:
        case = copy.deepcopy(case)
        box = case.get("analysis", {}).get("forcingBox")
        gfw_info: dict[str, dict[str, Any]] = {}
        gaps: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)
        known_ssvids: set[str] = set()
        unmatched: dict[str, dict[str, Any]] = {}

        for v in case.get("vessels", []):
            ident = self.identity(v, start, end)
            if not ident:
                gfw_info[v["name"]] = {"matched": False}
                unmatched[_norm(v["name"])] = v
                continue
            known_ssvids.add(str(ident.get("ssvid")))
            v.setdefault("mmsi", None)
            v["mmsi"] = v["mmsi"] or ident.get("ssvid")
            v["imo"] = v.get("imo") or ident.get("imo")
            if not ident["inWindow"]:
                gfw_info[v["name"]] = {"matched": True, **ident, "events": 0}
                continue
            evs = self.vessel_events(ident["id"], start, end)
            self._merge_events(v, evs, gaps, box)
            gfw_info[v["name"]] = {"matched": True, **ident, "events": len(evs)}

        candidates, merges = self._region_candidates(case, start, end, known_ssvids, unmatched)
        for vessel_name, meta, evs in merges:
            v = next(x for x in case["vessels"] if x["name"] == vessel_name)
            v["mmsi"] = v.get("mmsi") or meta.get("ssvid")
            self._merge_events(v, evs, gaps, box)
            gfw_info[vessel_name] = {"matched": True, "matchedBy": "name in area events", "id": meta.get("id"),
                                     "ssvid": meta.get("ssvid"), "shipname": meta.get("name"), "flag": meta.get("flag"),
                                     "events": len(evs), "inWindow": True}
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
                trk.notes.append("No Global Fishing Watch identity match for this vessel")
                continue
            if not info.get("inWindow", True):
                _mark_silent(trk, info)
                continue
            trk.notes[0] = "Track passes through reported positions and Global Fishing Watch event positions; segments between them are interpolated"
            for g0, g1 in gaps.get(rec.name, []):
                before = len(trk.pings)
                trk.pings = [p for p in trk.pings if not (g0 < p.t < g1)]
                if len(trk.pings) < before:
                    trk.notes.append(f"Real AIS gap from GFW: {iso(g0)} to {iso(g1)}")
        return vessels, tracks

    def _merge_events(self, v: dict[str, Any], evs: list[dict[str, Any]], gaps: dict[str, list], box: dict[str, float] | None) -> None:
        near = [a for e in evs for a in event_anchors(e) if _in_area(a, box)]
        v["anchors"] = consistent([*v.get("anchors", []), *near])
        gaps[v["name"]].extend(self._gap_windows(evs))

    @staticmethod
    def _gap_windows(events: list[dict[str, Any]]) -> list[tuple[datetime, datetime]]:
        return [(parse_time(e["start"]), parse_time(e["end"])) for e in events
                if (e.get("type") or "").lower() == "gap" and e.get("start") and e.get("end")]

    def _region_candidates(
        self, case: dict[str, Any], start: datetime, end: datetime, known: set[str], unmatched: dict[str, dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[tuple[str, dict[str, Any], list[dict[str, Any]]]]]:
        box = case.get("analysis", {}).get("forcingBox")
        if not box:
            return [], []
        by_vessel: dict[str, list[dict[str, Any]]] = defaultdict(list)
        meta: dict[str, dict[str, Any]] = {}
        for e in self.region_events(box, start, end):
            vessel = e.get("vessel") or {}
            vid = vessel.get("id")
            # Fishing-gear transmitters (net buoys) are not vessels that can discharge oil.
            if not vid or str(vessel.get("ssvid")) in known or (vessel.get("type") or "").upper() == "GEAR":
                continue
            by_vessel[vid].append(e)
            meta[vid] = vessel
        merges = []
        for vid in list(by_vessel):
            reported = unmatched.get(_norm(meta[vid].get("name")))
            if reported is not None:
                merges.append((reported["name"], {**meta[vid], "id": vid}, by_vessel.pop(vid)))
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
                         "flag": vessel.get("flag"), "events": len(evs), "inWindow": True},
            })
        return out, merges
