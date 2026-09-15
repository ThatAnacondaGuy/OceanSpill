from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass

import numpy as np


@dataclass
class GeoGrid:
    lines: np.ndarray
    pixels: np.ndarray
    lat: np.ndarray  # [n_lines, n_pixels]
    lon: np.ndarray
    incidence: np.ndarray


def parse_geolocation(xml: str) -> GeoGrid:
    """Tie-point grid from a Sentinel-1 product annotation (geolocationGridPoint elements)."""
    root = ET.fromstring(xml)
    pts = [
        (int(p.findtext("line")), int(p.findtext("pixel")), float(p.findtext("latitude")),
         float(p.findtext("longitude")), float(p.findtext("incidenceAngle") or "nan"))
        for p in root.iter("geolocationGridPoint")
    ]
    if not pts:
        raise ValueError("no geolocationGridPoint elements found")
    lines = np.array(sorted({p[0] for p in pts}), dtype=np.float64)
    pixels = np.array(sorted({p[1] for p in pts}), dtype=np.float64)
    li = {v: i for i, v in enumerate(lines)}
    pi = {v: i for i, v in enumerate(pixels)}
    lat = np.full((len(lines), len(pixels)), np.nan)
    lon = np.full_like(lat, np.nan)
    inc = np.full_like(lat, np.nan)
    for line, pixel, la, lo, ia in pts:
        lat[li[line], pi[pixel]] = la
        lon[li[line], pi[pixel]] = lo
        inc[li[line], pi[pixel]] = ia
    if np.isnan(lat).any():
        raise ValueError("geolocation grid is not a complete line x pixel grid")
    return GeoGrid(lines, pixels, lat, lon, inc)


def _axis(axis: np.ndarray, q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    idx = np.clip(np.searchsorted(axis, q, side="right") - 1, 0, max(len(axis) - 2, 0))
    if len(axis) < 2:
        return idx, np.zeros_like(q, dtype=np.float64)
    return idx, np.clip((q - axis[idx]) / (axis[idx + 1] - axis[idx]), 0.0, 1.0)


def interpolate_grid(grid: GeoGrid, values: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    ri, rf = _axis(grid.lines, np.asarray(rows, dtype=np.float64))
    ci, cf = _axis(grid.pixels, np.asarray(cols, dtype=np.float64))
    rf = rf[:, None]
    cf = cf[None, :]
    r1 = np.minimum(ri + 1, len(grid.lines) - 1)
    c1 = np.minimum(ci + 1, len(grid.pixels) - 1)
    v00 = values[np.ix_(ri, ci)]
    v01 = values[np.ix_(ri, c1)]
    v10 = values[np.ix_(r1, ci)]
    v11 = values[np.ix_(r1, c1)]
    return (v00 * (1 - rf) * (1 - cf) + v01 * (1 - rf) * cf + v10 * rf * (1 - cf) + v11 * rf * cf).astype(np.float64)


def latlon(grid: GeoGrid, rows: np.ndarray, cols: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return interpolate_grid(grid, grid.lat, rows, cols), interpolate_grid(grid, grid.lon, rows, cols)
