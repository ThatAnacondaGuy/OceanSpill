"""What the shore is made of where oil would come ashore.

A slick reaching a sandy beach is a different problem from one reaching mangroves. Sand can be
cleaned mechanically in days; mangrove roots hold oil for years and cleaning them does more harm
than leaving them, which changes the response priority and the compensation claim.

The coastline this project already draws comes from OpenStreetMap, and OpenStreetMap also carries
what each stretch of shore is: beach, wetland and its type, cliff, bare rock, and the built edges
of ports. This asks for those features over the case's coast box and labels each coastline vertex
with the nearest one.

A vertex with nothing nearby stays "unclassified" rather than being guessed at. Coverage is reported
with the result, because in India the mapping is good around cities and thin on remote coasts.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from .coast_osm import Box, _overpass
from .http import CachedHttp

# What to ask OpenStreetMap for, and what it means for a response. Order matters: the first match
# within range wins, so specific and consequential types come first.
SHORE_TYPES: list[tuple[str, str, str]] = [
    ("mangrove", 'way["natural"="wetland"]["wetland"~"mangrove"]', "Mangrove — oil persists for years; cleaning causes further damage"),
    ("marsh", 'way["natural"="wetland"]', "Marsh, mudflat or tidal wetland — soft sediment holds oil"),
    ("beach", 'way["natural"~"^(beach|sand|dune)$"]', "Beach — mechanical cleaning is possible"),
    ("rocky", 'way["natural"~"^(cliff|bare_rock|rock|shingle|stone)$"]', "Rock or cliff — oil weathers off, access is hard"),
    ("built", 'way["man_made"~"^(breakwater|pier|groyne|quay|dyke|embankment)$"]', "Built edge — port structures, straightforward to clean"),
    ("port", 'way["landuse"~"^(harbour|port)$"]', "Port or harbour — contained water, response equipment at hand"),
    ("coral", 'way["natural"="reef"]', "Reef — highly sensitive, no mechanical cleaning"),
]
# How close a mapped feature has to be to describe a stretch of coastline.
MATCH_KM = 1.0
EARTH_KM = 6371.0088


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(min(1.0, a)))


# Spacing used when walking the edges of a mapped shape.
STEP_KM = 0.2


def _densify(a: tuple[float, float], b: tuple[float, float]) -> list[tuple[float, float]]:
    length = _haversine_km(a[0], a[1], b[0], b[1])
    steps = int(length / STEP_KM)
    if steps < 2:
        return []
    return [(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps) for i in range(1, steps)]


def fetch_features(http: CachedHttp, box: Box) -> dict[str, list[tuple[float, float]]]:
    """Points along each mapped shore feature, grouped by what kind of shore it is."""
    found: dict[str, list[tuple[float, float]]] = defaultdict(list)
    bbox = f"{box.south},{box.west},{box.north},{box.east}"
    for name, selector, _ in SHORE_TYPES:
        query = f"[out:json][timeout:180];({selector}({bbox});relation{selector[3:]}({bbox}););out geom;"
        try:
            payload = _overpass(http, query)
        except Exception as exc:
            print(f"    {name}: not available ({type(exc).__name__})")
            continue
        for element in payload.get("elements", []):
            geometry = element.get("geometry") or []
            for member in element.get("members", []):
                geometry.extend(member.get("geometry") or [])
            # Mapped shapes have corners far apart; walking their edges puts a point roughly every
            # 200 m so a long straight beach matches along its whole length, not only at its ends.
            previous = None
            for point in geometry:
                current = (point["lat"], point["lon"])
                if previous is not None:
                    found[name].extend(_densify(previous, current))
                found[name].append(current)
                previous = current
        print(f"    {name}: {len(found[name])} mapped points")
    return found


def classify_ring(ring: list[list[float]], features: dict[str, list[tuple[float, float]]], match_km: float = MATCH_KM) -> list[str]:
    """The shore type nearest each coastline vertex, or 'unclassified' when nothing is close."""
    # A coarse grid over the feature points keeps this to a handful of comparisons per vertex.
    cell = match_km / 111.0
    grid: dict[tuple[int, int], list[tuple[str, float, float]]] = defaultdict(list)
    for name, points in features.items():
        for lat, lon in points:
            grid[(int(lat / cell), int(lon / cell))].append((name, lat, lon))

    order = {name: i for i, (name, _, _) in enumerate(SHORE_TYPES)}
    out = []
    for lon, lat in ring:
        best: tuple[int, float, str] | None = None
        key = (int(lat / cell), int(lon / cell))
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                for name, flat, flon in grid.get((key[0] + dr, key[1] + dc), ()):
                    distance = _haversine_km(lat, lon, flat, flon)
                    if distance > match_km:
                        continue
                    candidate = (order[name], distance, name)
                    if best is None or candidate[:2] < best[:2]:
                        best = candidate
        out.append(best[2] if best else "unclassified")
    return out


def summarise(rings: list[list[list[float]]], types: list[list[str]]) -> dict[str, Any]:
    """Kilometres of each kind of shore, so the response page can say what is at stake."""
    lengths: dict[str, float] = defaultdict(float)
    for ring, kinds in zip(rings, types):
        for i in range(len(ring) - 1):
            (lon1, lat1), (lon2, lat2) = ring[i], ring[i + 1]
            step = _haversine_km(lat1, lon1, lat2, lon2)
            lengths[kinds[i]] += step
    total = sum(lengths.values())
    return {
        "kilometres": {k: round(v, 2) for k, v in sorted(lengths.items(), key=lambda kv: -kv[1])},
        "totalKm": round(total, 2),
        "classifiedFraction": round(1 - lengths.get("unclassified", 0.0) / total, 3) if total else 0.0,
    }


def build_shore_types(http: CachedHttp, case_id: str, out_dir: Path) -> dict[str, Any] | None:
    """Label the coastline already written for a case, and save it beside the coastline."""
    coast_path = out_dir / "coast" / f"{case_id}.json"
    if not coast_path.exists():
        print(f"  {case_id}: no coastline artifact yet")
        return None
    coast = json.loads(coast_path.read_text())
    bbox = coast["bbox"]
    box = Box(bbox["west"], bbox["south"], bbox["east"], bbox["north"])
    print(f"  {case_id}: {len(coast['rings'])} rings over {bbox['west']}–{bbox['east']}E, {bbox['south']}–{bbox['north']}N")

    features = fetch_features(http, box)
    types = [classify_ring(ring, features) for ring in coast["rings"]]
    summary = summarise(coast["rings"], types)

    artifact = {
        "schemaVersion": 1,
        "caseId": case_id,
        "source": "OpenStreetMap (© OpenStreetMap contributors, ODbL) via the Overpass API",
        "matchRadiusKm": MATCH_KM,
        "descriptions": {name: description for name, _, description in SHORE_TYPES},
        "types": types,
        "summary": summary,
        "note": "Each coastline vertex takes the nearest mapped shore feature within the match "
                "radius. Stretches with nothing mapped nearby stay unclassified rather than assumed.",
    }
    path = out_dir / "coast" / f"{case_id}-shoretype.json"
    path.write_text(json.dumps(artifact, separators=(",", ":")))
    share = summary["classifiedFraction"] * 100
    parts = ", ".join(f"{k} {v} km" for k, v in list(summary["kilometres"].items())[:4])
    print(f"    {share:.0f}% of {summary['totalKm']:.0f} km classified · {parts}")
    return artifact
