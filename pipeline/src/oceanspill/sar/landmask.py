from __future__ import annotations

from typing import Any

import numpy as np


def rings_from_land(land: dict[str, Any]) -> list[list[tuple[float, float]]]:
    raw = [land["indiaMainland"], land["sriLanka"], *land["andamanNicobar"], land.get("lakshadweep", []), *(n["ring"] for n in land["neighbours"])]
    return [[(p["lat"], p["lon"]) for p in r] for r in raw if len(r) >= 3]


def points_in_ring(lat: np.ndarray, lon: np.ndarray, ring: list[tuple[float, float]]) -> np.ndarray:
    """Even-odd ray casting, vectorised over points."""
    inside = np.zeros(lat.shape, dtype=bool)
    n = len(ring)
    for i in range(n):
        y1, x1 = ring[i]
        y2, x2 = ring[(i + 1) % n]
        if y1 == y2:
            continue
        crosses = (y1 > lat) != (y2 > lat)
        x_at = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
        inside ^= crosses & (lon < x_at)
    return inside


def land_mask(lat: np.ndarray, lon: np.ndarray, rings: list[list[tuple[float, float]]]) -> np.ndarray:
    mask = np.zeros(lat.shape, dtype=bool)
    for ring in rings:
        ys = [p[0] for p in ring]
        xs = [p[1] for p in ring]
        near = (lat >= min(ys)) & (lat <= max(ys)) & (lon >= min(xs)) & (lon <= max(xs))
        if not near.any():
            continue
        mask[near] |= points_in_ring(lat[near], lon[near], ring)
    return mask


class RingLand:
    """Land from simple (lat, lon) rings, e.g. the coarse outlines in land.json."""

    source = "coarse coastline outlines (data/reference/land.json)"

    def __init__(self, rings: list[list[tuple[float, float]]]):
        self.rings = rings

    def mask(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        return land_mask(lat, lon, self.rings)


class PolygonLand:
    """Land from polygons with holes, rings as (lon, lat); clipped to each query area before testing."""

    source = "Natural Earth 1:10m coastline (data/reference/coastline_ne10m.json)"

    def __init__(self, polygons: list[list[list[tuple[float, float]]]]):
        from ..coastline import ring_bbox

        self.polygons = [(poly, [ring_bbox(r) for r in poly]) for poly in polygons]

    def mask(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        from ..coastline import clip_ring

        pad = 0.05
        box = (float(np.nanmin(lon)) - pad, float(np.nanmin(lat)) - pad, float(np.nanmax(lon)) + pad, float(np.nanmax(lat)) + pad)
        out = np.zeros(lat.shape, dtype=bool)
        for poly, boxes in self.polygons:
            inside = np.zeros(lat.shape, dtype=bool)
            touched = False
            for ring, rb in zip(poly, boxes):
                if rb[0] > box[2] or rb[2] < box[0] or rb[1] > box[3] or rb[3] < box[1]:
                    continue
                clipped = clip_ring(ring, box)
                if len(clipped) < 3:
                    continue
                inside ^= points_in_ring(lat, lon, [(y, x) for x, y in clipped])
                touched = True
            if touched:
                out |= inside
        return out


def default_land(land_json: dict[str, Any]) -> RingLand | PolygonLand:
    from ..coastline import load_coastline

    polygons = load_coastline()
    return PolygonLand(polygons) if polygons else RingLand(rings_from_land(land_json))
