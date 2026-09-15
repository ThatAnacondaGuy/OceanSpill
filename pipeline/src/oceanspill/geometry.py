from __future__ import annotations

import math
from typing import Any

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


def reported_geometry(case: dict[str, Any], land: LandMask) -> dict[str, Any]:
    """Slick geometry built from what was reported, with every assumption spelled out.

    This stands in for a SAR-derived polygon until segmentation is run on the downloaded scenes.
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
        left_land = land.on_land(*destination(m_lat, m_lon, (brg - 90) % 360, 2))
        right_land = land.on_land(*destination(m_lat, m_lon, (brg + 90) % 360, 2))
        if left_land and not right_land:
            side, inner, outer = 90, 0.1, width + 0.1
        elif right_land and not left_land:
            side, inner, outer = -90, 0.1, width + 0.1
        else:
            side, inner, outer = 90, -width / 2, width / 2
            assumptions.append("Seaward side could not be determined; strip centred on the reported line")
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

    return {
        "ring": ring,
        "basis": basis,
        "assumptions": assumptions,
        "observationTime": obs["time"] if obs else case["incident"]["time"],
        "observationSource": obs.get("source") if obs else case["incident"].get("positionSource"),
        "extentReported": bool(obs and (obs.get("reportedExtent") or obs.get("lengthKm") or obs.get("extentKm2"))),
    }
