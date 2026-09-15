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
