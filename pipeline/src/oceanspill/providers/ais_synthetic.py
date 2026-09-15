from __future__ import annotations

import hashlib
import math
import random
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable

from ..config import Settings
from ..geo import bearing_deg, destination, haversine_km, parse_time, point_in_ring
from ..http import CachedHttp
from .base import Ping, ProviderStatus, Track, VesselRecord

KN_TO_KMH = 1.852
# Downsampled from the ITU reporting rate (2-10 s under way) to keep artifacts browser-sized.
UNDERWAY_INTERVAL_S = 300
SLOW_INTERVAL_S = 600
FACILITY_INTERVAL_S = 1800
# Responders are only placed within this many hours of their reported presence: outside it their
# real positions are unknown, and inventing days of transit would be pure fabrication.
RESPONDER_WINDOW_H = 10

# (type, weight, speed range kn, name word)
TYPE_POOL = [
    ("Crude Oil Tanker", 10, (11, 14), "TANKER"),
    ("Product Tanker", 14, (11, 14), "TANKER"),
    ("Chemical Tanker", 8, (10, 13), "CHEMTANKER"),
    ("Bulk Carrier", 16, (10, 13), "BULKER"),
    ("Container Ship", 18, (14, 19), "BOXSHIP"),
    ("General Cargo", 12, (9, 12), "CARGO"),
    ("Fishing Vessel", 12, (4, 8), "FISHING"),
    ("Offshore Supply", 6, (9, 12), "SUPPLY"),
    ("Tug", 4, (6, 9), "TUG"),
]

FLAGS = [
    ("India", "Standard"), ("Panama", "Grey List"), ("Liberia", "Standard"), ("Marshall Islands", "Standard"),
    ("Singapore", "Standard"), ("Malta", "Standard"), ("Togo", "Black List"), ("Comoros", "Black List"),
    ("Cameroon", "Black List"), ("Palau", "Grey List"), ("Sri Lanka", "Standard"), ("Hong Kong", "Standard"),
]


def seed_for(*parts: Any) -> int:
    return int.from_bytes(hashlib.sha256("|".join(map(str, parts)).encode()).digest()[:8], "big")


def slug(name: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "-", name.upper()).strip("-")


def vessel_key(v: dict[str, Any]) -> str:
    if v.get("mmsi"):
        return f"MMSI-{v['mmsi']}"
    if v.get("imo"):
        return f"IMO-{v['imo']}"
    return f"REF-{slug(v['name'])}"


class LandMask:
    def __init__(self, land: dict[str, Any]):
        rings = [land["indiaMainland"], land["sriLanka"], *land["andamanNicobar"], *(n["ring"] for n in land["neighbours"])]
        self._rings = [
            (min(p["lat"] for p in r), max(p["lat"] for p in r), min(p["lon"] for p in r), max(p["lon"] for p in r), r)
            for r in rings
        ]

    def on_land(self, lat: float, lon: float) -> bool:
        for s, n, w, e, ring in self._rings:
            if s <= lat <= n and w <= lon <= e and point_in_ring(lat, lon, ring):
                return True
        return False


def _polyline(points: list[tuple[float, float]]) -> tuple[list[float], float]:
    cum = [0.0]
    for (a_lat, a_lon), (b_lat, b_lon) in zip(points, points[1:]):
        cum.append(cum[-1] + haversine_km(a_lat, a_lon, b_lat, b_lon))
    return cum, cum[-1]


def _along(points: list[tuple[float, float]], cum: list[float], dist: float) -> tuple[float, float, float]:
    """Position and bearing at a distance along a polyline, extrapolating past either end."""
    if dist <= 0:
        brg = bearing_deg(*points[0], *points[1])
        lat, lon = destination(*points[0], (brg + 180) % 360, -dist)
        return lat, lon, brg
    if dist >= cum[-1]:
        brg = bearing_deg(*points[-2], *points[-1])
        lat, lon = destination(*points[-1], brg, dist - cum[-1])
        return lat, lon, brg
    for i in range(1, len(cum)):
        if dist <= cum[i]:
            seg = cum[i] - cum[i - 1]
            brg = bearing_deg(*points[i - 1], *points[i])
            lat, lon = destination(*points[i - 1], brg, dist - cum[i - 1]) if seg > 0 else points[i]
            return lat, lon, brg
    return points[-1][0], points[-1][1], 0.0


@dataclass
class State:
    lat: float
    lon: float
    sog: float
    cog: float
    nav: int
    alive: bool = True


def _sample(
    state_at: Callable[[datetime], State], start: datetime, end: datetime, rng: random.Random, fixed_interval: int | None = None
) -> list[Ping]:
    pings: list[Ping] = []
    t = start
    last_cog = 0.0
    while t <= end:
        st = state_at(t)
        if st.alive:
            moving = st.sog >= 0.3
            jitter_km = 0.03
            lat = st.lat + rng.gauss(0, jitter_km) / 110.574
            lon = st.lon + rng.gauss(0, jitter_km) / (111.32 * math.cos(math.radians(st.lat)))
            cog = (st.cog + rng.gauss(0, 1.5)) % 360 if moving else last_cog
            last_cog = cog
            sog = max(0.0, st.sog * (1 + rng.gauss(0, 0.02))) if moving else round(abs(rng.gauss(0, 0.1)), 1)
            pings.append(Ping(t, round(lat, 5), round(lon, 5), round(sog, 1), round(cog, 1),
                              round((cog + rng.gauss(0, 2)) % 360), st.nav))
        interval = fixed_interval or (UNDERWAY_INTERVAL_S if st.sog >= 2 else SLOW_INTERVAL_S)
        t += timedelta(seconds=interval)
    return pings


class SyntheticAis:
    """Synthetic AIS for cases where real AIS is unavailable.

    Real vessels keep their real identities and pass through their reported anchor positions at
    the reported times; everything between anchors, and all background traffic, is synthetic and
    tagged as such. Background vessels have clearly synthetic identities (SYN prefix, MMSI 999xxxxxx)
    so no real ship is ever associated with invented behaviour.
    """

    name = "synthetic"
    agency = "OceanSpill synthetic AIS generator"
    sovereign = True

    def __init__(self, settings: Settings, http: CachedHttp, land: dict[str, Any], corridors: list[dict[str, Any]]):
        self.settings = settings
        self.land = LandMask(land)
        self.corridors = {c["id"]: c for c in corridors}

    def status(self) -> ProviderStatus:
        return ProviderStatus(
            "ais", self.name, self.agency, self.sovereign, True,
            "Tagged synthetic tracks anchored to reported positions; replace with GFW or DGLL AIS when available",
        )

    def tracks(self, case: dict[str, Any], start: datetime, end: datetime) -> tuple[list[VesselRecord], list[Track]]:
        vessels: list[VesselRecord] = []
        tracks: list[Track] = []
        for v in case.get("vessels", []):
            rec, trk = self._real_vessel(case["id"], v, start, end)
            vessels.append(rec)
            tracks.append(trk)
        for f in case.get("facilities", []):
            rec, trk = self._facility(f, start, end)
            vessels.append(rec)
            tracks.append(trk)
        for k in range(int(case.get("analysis", {}).get("backgroundVessels", 0))):
            rec, trk = self._background(case, k, start, end)
            vessels.append(rec)
            tracks.append(trk)
        return vessels, tracks

    # ---- real vessels -------------------------------------------------------------------------

    def _approach_origin(self, anchor: dict, rng: random.Random, reach_km: float) -> tuple[float, float]:
        """A sea point 30 km from the anchor whose approach line stays at sea for reach_km."""
        for _ in range(72):
            brg = rng.uniform(0, 360)
            samples = [destination(anchor["lat"], anchor["lon"], brg, d) for d in range(0, int(30 + reach_km) + 1, 10)]
            if not any(self.land.on_land(lat, lon) for lat, lon in samples):
                return samples[3]
        return destination(anchor["lat"], anchor["lon"], 270, 30)

    def _land_note(self, pings: list[Ping]) -> list[str]:
        on_land = sum(1 for p in pings if self.land.on_land(p.lat, p.lon))
        if pings and on_land / len(pings) > 0.05:
            return [f"WARNING: {on_land} of {len(pings)} pings fall on land; add routeWaypoints"]
        return []

    def _real_vessel(self, case_id: str, v: dict[str, Any], start: datetime, end: datetime) -> tuple[VesselRecord, Track]:
        rng = random.Random(seed_for(case_id, v["name"]))
        anchors = sorted(({**a, "t": parse_time(a["time"])} for a in v.get("anchors", [])), key=lambda a: a["t"])
        if not anchors:
            raise ValueError(f"{v['name']}: at least one anchor position is required")
        speed = float(v.get("cruiseSpeedKn", 10))
        a0 = anchors[0]

        port = (v.get("voyage") or {}).get("from") or v.get("comeFrom")
        reach = speed * KN_TO_KMH * RESPONDER_WINDOW_H
        origin = (port["lat"], port["lon"]) if port else self._approach_origin(a0, rng, reach)
        route = [origin, *((w["lat"], w["lon"]) for w in v.get("routeWaypoints", [])), (a0["lat"], a0["lon"])]
        cum, total = _polyline(route)
        travel_h = total / (speed * KN_TO_KMH)
        depart = a0["t"] - timedelta(hours=travel_h)
        destination_port = (v.get("voyage") or {}).get("to")
        last = anchors[-1]
        after = last.get("after", "continue")

        onward: list[tuple[float, float]] | None = None
        if after == "continue" and v.get("role") == "responder":
            home = v.get("comeFrom")
            onward = [(last["lat"], last["lon"]), (home["lat"], home["lon"]) if home else origin]
        elif after == "continue" and destination_port and last.get("sog", 0) >= 3:
            onward = [(last["lat"], last["lon"]), (destination_port["lat"], destination_port["lon"])]
        onward_cum = _polyline(onward) if onward else None
        loiter_h = 2.0 if v.get("role") == "responder" else 0.0

        def state_at(t: datetime) -> State:
            if t < depart:
                if port:
                    return State(origin[0], origin[1], 0.0, 0.0, 5)
                lat, lon, brg = _along(route, cum, -speed * KN_TO_KMH * (depart - t).total_seconds() / 3600)
                return State(lat, lon, speed, brg, 0)
            if t <= a0["t"]:
                d = speed * KN_TO_KMH * (t - depart).total_seconds() / 3600
                lat, lon, brg = _along(route, cum, d)
                return State(lat, lon, speed, brg, 0)
            for a, b in zip(anchors, anchors[1:]):
                if a["t"] <= t <= b["t"]:
                    span = (b["t"] - a["t"]).total_seconds()
                    f = (t - a["t"]).total_seconds() / span if span else 0.0
                    dist = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
                    lat = a["lat"] + (b["lat"] - a["lat"]) * f
                    lon = a["lon"] + (b["lon"] - a["lon"]) * f
                    sog = dist / KN_TO_KMH / (span / 3600) if span else 0.0
                    cog = bearing_deg(a["lat"], a["lon"], b["lat"], b["lon"]) if dist > 0.2 else float(a.get("cog", 0))
                    return State(lat, lon, sog, cog, int(a.get("navStatus", 0)))
            # After the final anchor.
            if after == "sunk":
                return State(last["lat"], last["lon"], 0.0, 0.0, 2, alive=False)
            if after == "stationary":
                return State(last["lat"], last["lon"], 0.0, float(last.get("cog", 0)), int(last.get("navStatus", 1)))
            elapsed_h = (t - last["t"]).total_seconds() / 3600
            if onward and onward_cum:
                if elapsed_h < loiter_h:
                    return State(last["lat"], last["lon"], 0.5, float(last.get("cog", 0)), 0)
                d = speed * KN_TO_KMH * (elapsed_h - loiter_h)
                if d >= onward_cum[1]:
                    return State(onward[-1][0], onward[-1][1], 0.0, 0.0, 5)
                lat, lon, brg = _along(onward, onward_cum[0], d)
                return State(lat, lon, speed, brg, 0)
            sog = float(last.get("sog", 0))
            lat, lon = destination(last["lat"], last["lon"], float(last.get("cog", 0)), sog * KN_TO_KMH * elapsed_h)
            return State(lat, lon, sog, float(last.get("cog", 0)), int(last.get("navStatus", 0)))

        t0, t1 = start, end
        notes = ["Synthetic track anchored to reported positions; segments between anchors are interpolated"]
        if v.get("role") == "responder":
            t0 = max(start, anchors[0]["t"] - timedelta(hours=RESPONDER_WINDOW_H))
            t1 = min(end, anchors[-1]["t"] + timedelta(hours=RESPONDER_WINDOW_H))
            notes.append(f"Responder placed only within {RESPONDER_WINDOW_H} h of its reported presence")
        elif v.get("placementWindowH"):
            window_h = float(v["placementWindowH"])
            t0 = max(start, anchors[0]["t"] - timedelta(hours=window_h))
            t1 = min(end, anchors[-1]["t"] + timedelta(hours=window_h))
            notes.append(f"Placed only within {window_h:g} h of its first and last known position")
        pings = _sample(state_at, t0, t1, rng)
        notes.extend(self._land_note(pings))

        rec = VesselRecord(
            key=vessel_key(v), name=v["name"], type=v["type"], role=v["role"], provenance="real",
            mmsi=v.get("mmsi"), imo=v.get("imo"), flag=v.get("flag"), operator=v.get("operator"),
            registry={"verified": False, "note": "Registry history not verified (DG Shipping / Equasis access pending)"},
            anchors=[{k: val for k, val in a.items() if k != "t"} for a in anchors], note=v.get("note"),
        )
        return rec, Track(rec.key, pings, "synthetic-anchored", notes)

    # ---- facilities ----------------------------------------------------------------------------

    def _facility(self, f: dict[str, Any], start: datetime, end: datetime) -> tuple[VesselRecord, Track]:
        rng = random.Random(seed_for(f["name"]))
        state = State(f["lat"], f["lon"], 0.0, 0.0, 5)
        pings = _sample(lambda _t: state, start, end, rng, fixed_interval=FACILITY_INTERVAL_S)
        rec = VesselRecord(
            key=f"FAC-{slug(f['name'])}", name=f["name"], type=f["type"], role=f.get("role", "candidate"),
            provenance="real", operator=f.get("operator"), is_facility=True,
            registry={"verified": False}, note=f.get("note"),
        )
        return rec, Track(rec.key, pings, "facility-position", ["Fixed facility position; not an AIS transmitter"])

    # ---- background traffic --------------------------------------------------------------------

    def _lane(self, case: dict[str, Any], rng: random.Random, k: int) -> list[tuple[float, float]]:
        box = case["analysis"]["forcingBox"]
        corridor_ids = [c for c in case["analysis"].get("corridorIds", []) if c in self.corridors]
        if corridor_ids and k % 2 == 0:
            wps = [(p["lat"], p["lon"]) for p in self.corridors[corridor_ids[k // 2 % len(corridor_ids)]]["waypoints"]]
            return wps if rng.random() < 0.5 else list(reversed(wps))
        pad = 0.5
        w, s, e, n = box["west"] - pad, box["south"] - pad, box["east"] + pad, box["north"] + pad

        def edge_point(edge: int) -> tuple[float, float]:
            if edge == 0:
                return s, rng.uniform(w, e)
            if edge == 1:
                return n, rng.uniform(w, e)
            if edge == 2:
                return rng.uniform(s, n), w
            return rng.uniform(s, n), e

        best: list[tuple[float, float]] | None = None
        for _ in range(80):
            e1, e2 = rng.sample(range(4), 2)
            a, b = edge_point(e1), edge_point(e2)
            samples = [(a[0] + (b[0] - a[0]) * i / 24, a[1] + (b[1] - a[1]) * i / 24) for i in range(25)]
            if not any(self.land.on_land(lat, lon) for lat, lon in samples):
                return [a, b]
            best = best or [a, b]
        return best  # type: ignore[return-value]

    def _background(self, case: dict[str, Any], k: int, start: datetime, end: datetime) -> tuple[VesselRecord, Track]:
        rng = random.Random(seed_for(case["id"], "bg", k))
        weights = [t[1] for t in TYPE_POOL]
        vtype, _, (lo, hi), word = rng.choices(TYPE_POOL, weights=weights)[0]
        base = rng.uniform(lo, hi)
        lane = self._lane(case, rng, k)
        cum, total = _polyline(lane)

        # Each background vessel makes one transit of the area. Most transits are timed around the
        # incident so the attribution window contains realistic decoy traffic; the rest are spread
        # across the whole window as unrelated traffic.
        incident = parse_time(case["incident"]["time"])
        hindcast_h = float(case["analysis"].get("hindcastHours", 24))
        if rng.random() < 0.6:
            t_cross = incident + timedelta(hours=rng.uniform(-hindcast_h, 6))
        else:
            t_cross = start + (end - start) * rng.random()
        d_cross = rng.uniform(0.3, 0.7) * total

        behaviour = rng.random()
        episode_start = t_cross + timedelta(hours=rng.uniform(-3, 2))
        gap: tuple[datetime, datetime] | None = None
        slow: tuple[datetime, datetime, float] | None = None
        if behaviour < 0.15:
            gap = (episode_start, episode_start + timedelta(hours=rng.uniform(2, 7)))
        elif behaviour < 0.27:
            slow = (episode_start, episode_start + timedelta(hours=rng.uniform(1.5, 3)), rng.uniform(4, 7))
        elif behaviour < 0.34:
            slow = (episode_start, episode_start + timedelta(hours=rng.uniform(1, 2.5)), rng.uniform(0.2, 0.9))

        def speed_at(t: datetime) -> float:
            if slow and slow[0] <= t <= slow[1]:
                return slow[2]
            return base

        box = case["analysis"]["forcingBox"]
        pad = 1.5

        # Integrate distance so slow-downs and loitering shift the downstream position correctly.
        step = timedelta(minutes=5)
        d = d_cross - base * KN_TO_KMH * (t_cross - start).total_seconds() / 3600
        dist_at: dict[datetime, float] = {}
        t = start
        while t <= end + step:
            dist_at[t] = d
            d += speed_at(t) * KN_TO_KMH * step.total_seconds() / 3600
            t += step

        def state_at(t: datetime) -> State:
            dist = dist_at.get(start + step * int((t - start) / step), d)
            lat, lon, brg = _along(lane, cum, dist)
            in_area = (
                0 <= dist <= total
                and box["south"] - pad <= lat <= box["north"] + pad
                and box["west"] - pad <= lon <= box["east"] + pad
            )
            sog = speed_at(t)
            alive = in_area and not (gap and gap[0] <= t <= gap[1])
            return State(lat, lon, sog, brg, 0 if sog >= 1 else 1, alive)

        pings = _sample(state_at, start, end, rng)
        flag, risk = rng.choice(FLAGS)
        tanker = "Tanker" in vtype
        registry = {
            "verified": False,
            "synthetic": True,
            "flagRisk": risk,
            "priorOffences": (rng.choice([1, 1, 2, 3]) if tanker and rng.random() < 0.25 else 0),
            "sanctioned": risk == "Black List" and rng.random() < 0.3,
            "pscDetentions": rng.choice([0, 0, 0, 1, 2]) if risk != "Standard" else rng.choice([0, 0, 0, 0, 1]),
        }
        mmsi = f"999{seed_for(case['id'], k) % 1_000_000:06d}"
        rec = VesselRecord(
            key=f"MMSI-{mmsi}", name=f"SYN {word} {k + 1:02d}", type=vtype, role="background",
            provenance="synthetic", mmsi=mmsi, flag=flag, registry=registry,
            note="Synthetic background vessel. Not a real ship.",
        )
        notes = ["Synthetic background traffic", *self._land_note(pings)]
        if gap:
            notes.append("Synthetic AIS gap episode")
        if slow:
            notes.append("Synthetic speed-reduction episode")
        return rec, Track(rec.key, pings, "synthetic", notes)
