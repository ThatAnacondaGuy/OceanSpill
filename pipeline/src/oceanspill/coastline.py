"""Detailed coastline from Natural Earth 1:10m land polygons (public domain).

The hand-drawn outlines in data/reference/land.json are several kilometres off in places, which
is fine for maps but not for masking land out of SAR scenes. This module reads the Natural Earth
shapefiles, clips them to the Indian Ocean region and stores them compactly as JSON.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any

from .config import REFERENCE_DIR

COASTLINE_FILE = REFERENCE_DIR / "coastline_ne10m.json"
# West, south, east, north: Arabian Sea, Bay of Bengal, Andaman Sea and the approaches to them.
REGION = (60.0, -2.0, 100.0, 30.0)

Ring = list[tuple[float, float]]  # (lon, lat)


def read_polygons(shp: Path) -> list[list[Ring]]:
    """Polygon records (shape type 5) from an ESRI shapefile; each record is a list of rings."""
    data = shp.read_bytes()
    if struct.unpack(">i", data[:4])[0] != 9994:
        raise ValueError(f"{shp} is not a shapefile")
    records: list[list[Ring]] = []
    pos = 100
    while pos + 8 <= len(data):
        length = struct.unpack(">i", data[pos + 4:pos + 8])[0] * 2
        body = data[pos + 8:pos + 8 + length]
        pos += 8 + length
        shape_type = struct.unpack("<i", body[:4])[0]
        if shape_type == 0:
            continue
        if shape_type != 5:
            raise ValueError(f"unsupported shape type {shape_type}")
        num_parts, num_points = struct.unpack("<2i", body[36:44])
        parts = list(struct.unpack(f"<{num_parts}i", body[44:44 + 4 * num_parts]))
        coords = struct.unpack(f"<{2 * num_points}d", body[44 + 4 * num_parts:44 + 4 * num_parts + 16 * num_points])
        points = list(zip(coords[0::2], coords[1::2]))
        bounds = parts + [num_points]
        records.append([points[bounds[i]:bounds[i + 1]] for i in range(num_parts)])
    return records


def clip_ring(ring: Ring, box: tuple[float, float, float, float]) -> Ring:
    """Sutherland-Hodgman clipping of a ring to a rectangle.

    Concave rings can gain zero-width edges along the box boundary, which does not affect even-odd
    point-in-polygon tests for points inside the box.
    """
    west, south, east, north = box
    edges = [
        (lambda p: p[0] >= west, lambda a, b: (west, a[1] + (b[1] - a[1]) * (west - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= east, lambda a, b: (east, a[1] + (b[1] - a[1]) * (east - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= south, lambda a, b: (a[0] + (b[0] - a[0]) * (south - a[1]) / (b[1] - a[1]), south)),
        (lambda p: p[1] <= north, lambda a, b: (a[0] + (b[0] - a[0]) * (north - a[1]) / (b[1] - a[1]), north)),
    ]
    out = list(ring)
    for inside, cross in edges:
        if not out:
            break
        src, out = out, []
        prev = src[-1]
        for cur in src:
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
            prev = cur
    return out


def ring_bbox(ring: Ring) -> tuple[float, float, float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def _overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def build_coastline(shapefiles: list[Path], out: Path = COASTLINE_FILE, region: tuple[float, float, float, float] = REGION) -> dict[str, Any]:
    polygons = []
    for shp in shapefiles:
        for record in read_polygons(shp):
            rings = []
            for ring in record:
                if len(ring) < 3 or not _overlaps(ring_bbox(ring), region):
                    continue
                clipped = clip_ring(ring, region)
                if len(clipped) >= 3:
                    rings.append([[round(x, 4), round(y, 4)] for x, y in clipped])
            if rings:
                polygons.append(rings)
    doc = {
        "source": "Natural Earth 1:10m land and minor islands (public domain), naturalearthdata.com",
        "files": [p.name for p in shapefiles],
        "region": {"west": region[0], "south": region[1], "east": region[2], "north": region[3]},
        "format": "polygons -> rings -> [lon, lat]; rings within a polygon combine even-odd (holes)",
        "polygons": polygons,
    }
    out.write_text(json.dumps(doc, separators=(",", ":")))
    return doc


def load_coastline(path: Path = COASTLINE_FILE) -> list[list[Ring]] | None:
    if not path.exists():
        return None
    return [[[(x, y) for x, y in ring] for ring in poly] for poly in json.loads(path.read_text())["polygons"]]
