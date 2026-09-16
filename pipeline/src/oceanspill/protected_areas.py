"""Real boundaries for the protected areas the app ranks by risk.

The twelve marine parks, sanctuaries and Ramsar sites on the ecological page were outlined by hand
from published descriptions — good enough to place a name on a map, not good enough to say whether a
slick will reach one. NCSCM holds the official shapefiles and does not publish them for download, so
this takes the next best source that is open: the boundaries mapped in OpenStreetMap.

Each named area is matched by searching OpenStreetMap for protected areas near the hand-drawn
outline and keeping the best match by name similarity and overlap. An area with no match keeps its
hand-drawn outline and is labelled as such, so the map never implies a precision it does not have.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .coast_osm import _overpass
from .http import CachedHttp

EARTH_KM = 6371.0088
# How far from the hand-drawn outline to look for the real boundary.
SEARCH_PAD_DEG = 0.6
# A boundary is only accepted when the name clearly matches.
NAME_SCORE = 0.45
# Vertex spacing kept after simplification, in degrees (about 500 m).
SIMPLIFY_DEG = 0.005

SELECTORS = [
    '["boundary"="protected_area"]',
    '["leisure"="nature_reserve"]',
    '["boundary"="national_park"]',
]

STOP_WORDS = {"marine", "national", "park", "wildlife", "sanctuary", "reserve", "biosphere",
              "conservation", "area", "bird", "gulf", "of", "the", "and", "gr", "ramsar", "gulf"}


@dataclass
class Match:
    area_id: str
    name: str
    osm_id: int
    osm_name: str
    designation: str
    score: float
    vertices: int


def _words(name: str) -> set[str]:
    return {w for w in re.split(r"[^a-z]+", name.lower()) if w and w not in STOP_WORDS}


def name_score(wanted: str, candidate: str) -> float:
    """Overlap between the distinctive words of two names."""
    a, b = _words(wanted), _words(candidate)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a)


def ring_bounds(ring: list[dict[str, float]]) -> tuple[float, float, float, float]:
    lats = [p["lat"] for p in ring]
    lons = [p["lon"] for p in ring]
    return min(lats), min(lons), max(lats), max(lons)


def simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    """Drop vertices closer together than the tolerance, keeping the shape."""
    out = [points[0]]
    for point in points[1:]:
        if math.hypot(point[0] - out[-1][0], point[1] - out[-1][1]) >= tolerance:
            out.append(point)
    if len(out) > 2 and out[0] != out[-1]:
        out.append(out[0])
    return out


def fetch_candidates(http: CachedHttp, south: float, west: float, north: float, east: float) -> list[dict[str, Any]]:
    bbox = f"{south - SEARCH_PAD_DEG},{west - SEARCH_PAD_DEG},{north + SEARCH_PAD_DEG},{east + SEARCH_PAD_DEG}"
    parts = []
    for selector in SELECTORS:
        parts.append(f"way{selector}({bbox});")
        parts.append(f"relation{selector}({bbox});")
    query = f"[out:json][timeout:180];({''.join(parts)});out geom;"
    payload = _overpass(http, query)
    return payload.get("elements", [])


def outline_of(element: dict[str, Any]) -> list[tuple[float, float]]:
    """The longest closed way of a mapped area, as (lon, lat) pairs for the web app."""
    pieces: list[list[dict[str, float]]] = []
    if element.get("geometry"):
        pieces.append(element["geometry"])
    for member in element.get("members", []):
        if member.get("role") in (None, "", "outer") and member.get("geometry"):
            pieces.append(member["geometry"])
    if not pieces:
        return []
    longest = max(pieces, key=len)
    return [(round(p["lon"], 5), round(p["lat"], 5)) for p in longest]


def match_areas(http: CachedHttp, areas: list[dict[str, Any]]) -> dict[str, Any]:
    """Find the mapped boundary for each hand-drawn area."""
    results = {}
    matches: list[Match] = []
    for area in areas:
        ring = area["ring"]
        south, west, north, east = ring_bounds(ring)
        try:
            candidates = fetch_candidates(http, south, west, north, east)
        except Exception as exc:
            print(f"  {area['name']}: search failed ({type(exc).__name__})")
            continue

        best = None
        for element in candidates:
            tags = element.get("tags", {})
            osm_name = tags.get("name") or tags.get("official_name") or ""
            score = name_score(area["name"], osm_name)
            if score < NAME_SCORE:
                continue
            outline = outline_of(element)
            if len(outline) < 4:
                continue
            if best is None or score > best[0] or (score == best[0] and len(outline) > len(best[1])):
                best = (score, outline, element, osm_name, tags)

        if best is None:
            print(f"  {area['name']}: no mapped boundary found, keeping the hand-drawn outline")
            continue

        score, outline, element, osm_name, tags = best
        simplified = simplify(outline, SIMPLIFY_DEG)
        designation = tags.get("protection_title") or tags.get("designation") or tags.get("boundary") or "protected area"
        results[area["id"]] = {
            "ring": [[lon, lat] for lon, lat in simplified],
            "osmId": element.get("id"),
            "osmType": element.get("type"),
            "osmName": osm_name,
            "designation": designation,
            "nameScore": round(score, 2),
            "vertices": len(simplified),
        }
        matches.append(Match(area["id"], area["name"], int(element.get("id", 0)), osm_name, designation, score, len(simplified)))
        print(f"  {area['name']}: matched \"{osm_name}\" ({designation}, {len(simplified)} vertices)")

    return {
        "schemaVersion": 1,
        "source": "OpenStreetMap (© OpenStreetMap contributors, ODbL) via the Overpass API",
        "note": "Mapped boundaries for the protected areas on the ecological page. Areas without a "
                "match keep their hand-drawn outline; the official NCSCM shapefiles are not published "
                "for download.",
        "matched": len(results),
        "requested": len(areas),
        "areas": results,
    }


def build_protected_areas(http: CachedHttp, areas: list[dict[str, Any]], out_dir: Path) -> dict[str, Any]:
    artifact = match_areas(http, areas)
    path = out_dir / "protected-areas.json"
    path.write_text(json.dumps(artifact, separators=(",", ":")))
    print(f"  {artifact['matched']} of {artifact['requested']} areas have a mapped boundary · wrote {path}")
    return artifact
