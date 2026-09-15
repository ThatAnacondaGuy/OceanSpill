from __future__ import annotations

import math
from typing import Any

from .coast_osm import CoastLand
from .geo import bearing_deg, destination, haversine_km
from .providers.ais_synthetic import LandMask

GEOMETRY_TYPES = ("slick", "sheen", "tarballs", "shoreline")


def _pt(lat: float, lon: float) -> dict[str, float]:
    return {"lat": round(lat, 5), "lon": round(lon, 5)}


def _ellipse(c_lat: float, c_lon: float, major_km: float, minor_km: float, orientation: float, n: int = 36) -> list[dict]:
    ring = []
    for i in range(n):
        th = 2 * math.pi * i / n
        along = major_km / 2 * math.cos(th)
        across = minor_km / 2 * math.sin(th)
        lat, lon = destination(c_lat, c_lon, orientation, along)
        lat, lon = destination(lat, lon, (orientation + 90) % 360, across)
        ring.append(_pt(lat, lon))
    return ring


def primary_observation(case: dict[str, Any]) -> dict[str, Any] | None:
    obs = [o for o in case.get("observations", []) if o.get("type") in GEOMETRY_TYPES]
    return min(obs, key=lambda o: o["time"]) if obs else None


def _seaward_bearing(coast: CoastLand, lat: float, lon: float, previous: float | None) -> tuple[float, float, float] | None:
    """Nearest coastline point and the bearing that points from it out to sea."""
    c = coast.nearest_coast(lat, lon)
    if c is None:
        return None
    c_lon, c_lat = float(c[0]), float(c[1])
    # Probe a ring of directions 250 m out; sea is the widest run of water directions.
    water = [not coast.on_land(*destination(c_lat, c_lon, b, 0.25)) for b in range(0, 360, 15)]
    if all(water) or not any(water):
        if previous is None:
            return None
        return c_lat, c_lon, previous
    n = len(water)
    best, best_len = 0, 0
    for start in range(n):
        if water[start] and not water[start - 1]:
            length = 0
            while water[(start + length) % n] and length < n:
                length += 1
            if length > best_len:
                best, best_len = start, length
    return c_lat, c_lon, (best + (best_len - 1) / 2) * 15 % 360


def _coastal_strip(a: dict, b: dict, width_km: float, coast: CoastLand) -> list[dict] | None:
    """A band of the given width on the seaward side of the mapped coastline between two points."""
    length = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
    n = max(12, int(length / 0.25))
    inner: list[tuple[float, float]] = []
    outer: list[tuple[float, float]] = []
    previous = None
    for i in range(n + 1):
        f = i / n
        hit = _seaward_bearing(coast, a["lat"] + (b["lat"] - a["lat"]) * f, a["lon"] + (b["lon"] - a["lon"]) * f, previous)
        if hit is None:
            continue
        c_lat, c_lon, brg = hit
        previous = brg
        near = 0.1
        # Step past creek mouths and spits that the straight offset would land on.
        while coast.on_land(*destination(c_lat, c_lon, brg, near)) and near < 3:
            near += 0.1
        inner.append(destination(c_lat, c_lon, brg, near))
        outer.append(destination(c_lat, c_lon, brg, near + width_km))
    if len(inner) < 3:
        return None
    # Light smoothing of the outer edge; the inner edge keeps the shape of the coast.
    smooth = [outer[0]] + [
        ((outer[i - 1][0] + outer[i][0] + outer[i + 1][0]) / 3, (outer[i - 1][1] + outer[i][1] + outer[i + 1][1]) / 3)
        for i in range(1, len(outer) - 1)
    ] + [outer[-1]]
    return [_pt(*p) for p in inner] + [_pt(*p) for p in reversed(smooth)]


def keep_at_sea(ring: list[dict], coast: CoastLand) -> tuple[list[dict], bool]:
    """Moves outline vertices that fall on land to just seaward of the mapped coastline."""
    moved = False
    out = []
    for p in ring:
        if not coast.on_land(p["lat"], p["lon"]):
            out.append(p)
            continue
        hit = _seaward_bearing(coast, p["lat"], p["lon"], None)
        if hit is None:
            out.append(p)
            continue
        c_lat, c_lon, brg = hit
        out.append(_pt(*destination(c_lat, c_lon, brg, 0.05)))
        moved = True
    return out, moved


def reported_geometry(case: dict[str, Any], land: LandMask, coast: CoastLand | None = None) -> dict[str, Any]:
    """Slick geometry built from what was reported, with every assumption spelled out.

    This stands in for a SAR-derived polygon until segmentation is run on the downloaded scenes.
    With a detailed coastline, outlines are kept on the water: oil on the sea cannot lie inland.
    """
    inc = case["incident"]["position"]
    obs = primary_observation(case)
    assumptions: list[str] = []

    if obs and obs.get("reportedExtent"):
        a, b = obs["reportedExtent"]["from"], obs["reportedExtent"]["to"]
        length = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
        area = obs.get("extentKm2")
        width = area / length if area and length else 1.0
        brg = bearing_deg(a["lat"], a["lon"], b["lat"], b["lon"])
        m_lat, m_lon = (a["lat"] + b["lat"]) / 2, (a["lon"] + b["lon"]) / 2
        strip = _coastal_strip(a, b, width, coast) if coast is not None else None
        left_land = land.on_land(*destination(m_lat, m_lon, (brg - 90) % 360, 2))
        right_land = land.on_land(*destination(m_lat, m_lon, (brg + 90) % 360, 2))
        if strip is not None:
            ring = strip
            assumptions.append("Strip follows the mapped coastline (OpenStreetMap) on its seaward side")
        elif left_land and not right_land:
            side, inner, outer = 90, 0.1, width + 0.1
        elif right_land and not left_land:
            side, inner, outer = -90, 0.1, width + 0.1
        else:
            side, inner, outer = 90, -width / 2, width / 2
            assumptions.append("Seaward side could not be determined; strip centred on the reported line")
        if strip is None:
            off = lambda p, d: destination(p["lat"], p["lon"], (brg + side) % 360, d)  # noqa: E731
            ring = [_pt(*off(a, inner)), _pt(*off(b, inner)), _pt(*off(b, outer)), _pt(*off(a, outer))]
        assumptions.append(f"Strip width {width:.2f} km derived from reported area and extent length")
        basis = f"Reported extent{f' {area} km²' if area else ''} along {length:.1f} km of coast"
    elif obs and obs.get("lengthKm"):
        length = float(obs["lengthKm"])
        orient = float(obs.get("orientationDeg", 0))
        width = 0.6
        c_lat, c_lon = destination(obs["lat"], obs["lon"], orient, length / 2)
        ring = _ellipse(c_lat, c_lon, length, width, orient)
        assumptions.append("Width 0.6 km assumed (not reported)")
        if obs.get("orientationAssumed"):
            assumptions.append("Orientation assumed (not reported)")
        basis = f"Reported slick length {length:g} km"
    elif obs and obs.get("extentKm2"):
        radius = math.sqrt(float(obs["extentKm2"]) / math.pi)
        ring = _ellipse(obs.get("lat", inc["lat"]), obs.get("lon", inc["lon"]), 2 * radius, 2 * radius, 0)
        assumptions.append("Shape assumed circular; only area was reported")
        basis = f"Reported affected area {obs['extentKm2']} km²"
    else:
        lat = obs.get("lat", inc["lat"]) if obs else inc["lat"]
        lon = obs.get("lon", inc["lon"]) if obs else inc["lon"]
        ring = _ellipse(lat, lon, 2.0, 2.0, 0)
        assumptions.append("Extent not reported; 1 km radius marker around reported location")
        basis = "Location only"

    if coast is not None:
        ring, moved = keep_at_sea(ring, coast)
        if moved:
            assumptions.append("Parts of the assumed outline that fell on land were moved to the mapped coastline")

    return {
        "ring": ring,
        "basis": basis,
        "assumptions": assumptions,
        "observationTime": obs["time"] if obs else case["incident"]["time"],
        "observationSource": obs.get("source") if obs else case["incident"].get("positionSource"),
        "extentReported": bool(obs and (obs.get("reportedExtent") or obs.get("lengthKm") or obs.get("extentKm2"))),
    }
