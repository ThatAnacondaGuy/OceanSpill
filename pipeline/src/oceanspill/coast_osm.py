"""High-resolution land polygons from the OpenStreetMap coastline, fetched through the Overpass API.

Natural Earth 1:10m is 1-3 km off along much of the Indian coast, which puts near-shore slicks and
drift particles on land. OSM coastline ways are mapped to tens of metres and, by convention, have
land on their left. For a case this module fetches the ways that cross its drift box, joins them
into chains, clips the chains to the box and closes them along the box edge into land polygons.

Data: © OpenStreetMap contributors, available under the Open Database License (ODbL).
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import requests

from .http import USER_AGENT, CachedHttp, HttpError

OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
SOURCE = "OpenStreetMap coastline (© OpenStreetMap contributors, ODbL) via the Overpass API"
TILE_DEG = 1.0

Pt = tuple[float, float]  # (lon, lat)


@dataclass
class Box:
    west: float
    south: float
    east: float
    north: float

    def inside(self, p: Pt, eps: float = 0.0) -> bool:
        return self.west - eps <= p[0] <= self.east + eps and self.south - eps <= p[1] <= self.north + eps


def _overpass(http: CachedHttp, query: str, attempts: int = 2, timeout: float = 150) -> dict[str, Any]:
    form = {"data": query}
    # A tile cached from any mirror is reused; otherwise mirrors are tried in order.
    cached = next((u for u in OVERPASS_URLS if http.has_cached("POST", u, data=form)), None)
    urls = [cached] if cached else list(OVERPASS_URLS)
    last: Exception | None = None
    for url in urls:
        for attempt in range(attempts):
            try:
                # Overpass refuses the generic python-requests agent, so identify the pipeline explicitly.
                return http.request_json("POST", url, data=form, headers={"User-Agent": USER_AGENT}, timeout=timeout, retries=1)
            except HttpError as exc:
                last = exc
                # Busy instances answer 429 or 50x; wait, then move to the next mirror.
                if exc.status not in (429, 502, 503, 504):
                    raise
                time.sleep(5 * (attempt + 1))
            except requests.RequestException as exc:
                last = exc
                break
    raise RuntimeError(f"no Overpass instance answered: {last}")


def _fetch_tile(http: CachedHttp, s: float, w: float, n: float, e: float, ways: dict[int, dict[str, Any]], min_size: float = 0.25) -> None:
    query = f'[out:json][timeout:180];way["natural"="coastline"]({s:.4f},{w:.4f},{n:.4f},{e:.4f});out geom;'
    try:
        doc = _overpass(http, query)
    except (RuntimeError, HttpError):
        # Dense coasts (creeks, mangroves) can exceed what a public instance returns in time: split the tile.
        if n - s <= min_size and e - w <= min_size:
            raise
        mid_lat, mid_lon = (s + n) / 2, (w + e) / 2
        for bs, bw, bn, be in ((s, w, mid_lat, mid_lon), (s, mid_lon, mid_lat, e), (mid_lat, w, n, mid_lon), (mid_lat, mid_lon, n, e)):
            _fetch_tile(http, bs, bw, bn, be, ways, min_size)
        return
    for el in doc.get("elements", []):
        if el.get("type") == "way" and el.get("geometry"):
            ways[el["id"]] = el


def fetch_ways(http: CachedHttp, box: Box) -> list[dict[str, Any]]:
    """Coastline ways crossing the box, fetched in 1-degree tiles (cached, split when too dense) and de-duplicated."""
    ways: dict[int, dict[str, Any]] = {}
    lat = math.floor(box.south)
    while lat < box.north:
        lon = math.floor(box.west)
        while lon < box.east:
            _fetch_tile(http, max(box.south, lat), max(box.west, lon), min(box.north, lat + TILE_DEG), min(box.east, lon + TILE_DEG), ways)
            lon += TILE_DEG
        lat += TILE_DEG
    return list(ways.values())


def join_ways(ways: list[dict[str, Any]]) -> list[list[Pt]]:
    """Joins ways end to end by shared node ids; returns open chains and closed rings."""
    pieces = [([n for n in w["nodes"]], [(g["lon"], g["lat"]) for g in w["geometry"]]) for w in ways]
    by_first: dict[int, list[int]] = {}
    for i, (nodes, _) in enumerate(pieces):
        by_first.setdefault(nodes[0], []).append(i)
    used = [False] * len(pieces)
    last_nodes = {nodes[-1] for nodes, _ in pieces}

    def extend(start: int) -> list[Pt]:
        used[start] = True
        nodes, pts = pieces[start]
        chain = list(pts)
        first, tail = nodes[0], nodes[-1]
        while tail != first:
            nxt = next((j for j in by_first.get(tail, []) if not used[j]), None)
            if nxt is None:
                break
            used[nxt] = True
            chain.extend(pieces[nxt][1][1:])
            tail = pieces[nxt][0][-1]
        return chain

    chains: list[list[Pt]] = []
    # Start from chain heads (no way ends where they begin), then whatever is left is a cycle.
    for i, (nodes, _) in enumerate(pieces):
        if not used[i] and nodes[0] not in last_nodes:
            chains.append(extend(i))
    for i in range(len(pieces)):
        if not used[i]:
            chains.append(extend(i))
    return chains


def _clip_segment(a: Pt, b: Pt, box: Box) -> tuple[float, float] | None:
    """Liang-Barsky: parameter range of segment a->b inside the box, or None."""
    t0, t1 = 0.0, 1.0
    dx, dy = b[0] - a[0], b[1] - a[1]
    for p, q in ((-dx, a[0] - box.west), (dx, box.east - a[0]), (-dy, a[1] - box.south), (dy, box.north - a[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    return t0, t1


def _lerp(a: Pt, b: Pt, t: float) -> Pt:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def clip_chain(chain: list[Pt], box: Box) -> tuple[list[list[Pt]], list[list[Pt]]]:
    """Splits a chain into pieces inside the box. Closed chains wholly inside are returned as rings."""
    closed = len(chain) > 2 and chain[0] == chain[-1]
    if all(box.inside(p) for p in chain):
        return ([], [chain[:-1]]) if closed else ([chain], [])
    pieces: list[list[Pt]] = []
    current: list[Pt] = []
    for a, b in zip(chain, chain[1:]):
        rng = _clip_segment(a, b, box)
        if rng is None:
            if current:
                pieces.append(current)
                current = []
            continue
        t0, t1 = rng
        pa, pb = _lerp(a, b, t0), _lerp(a, b, t1)
        if not current:
            current = [pa]
        elif t0 > 0:
            pieces.append(current)
            current = [pa]
        current.append(pb)
        if t1 < 1:
            pieces.append(current)
            current = []
    if current:
        pieces.append(current)
    if closed and len(pieces) > 1 and box.inside(chain[0]):
        # The ring's start lies inside: the last and first pieces are one piece.
        pieces[0] = pieces[-1] + pieces[0][1:]
        pieces.pop()
    return [p for p in pieces if len(p) >= 2], []


def simplify(points: list[Pt], tolerance: float) -> list[Pt]:
    """Douglas-Peucker in degrees; keeps the end points."""
    if len(points) < 3 or tolerance <= 0:
        return points
    arr = np.asarray(points)
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = arr[i], arr[j]
        seg = b - a
        norm = float(np.hypot(*seg))
        rel = arr[i + 1:j] - a
        d = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / norm if norm > 0 else np.hypot(rel[:, 0], rel[:, 1])
        k = int(np.argmax(d))
        if d[k] > tolerance:
            m = i + 1 + k
            keep[m] = True
            stack.extend(((i, m), (m, j)))
    return [points[i] for i in range(len(points)) if keep[i]]


def _perimeter_t(p: Pt, box: Box) -> float:
    """Position along the box edge, counter-clockwise from the south-west corner, in [0, 4)."""
    w, h = box.east - box.west, box.north - box.south
    candidates = [
        (abs(p[1] - box.south), (p[0] - box.west) / w),
        (abs(p[0] - box.east), 1 + (p[1] - box.south) / h),
        (abs(p[1] - box.north), 2 + (box.east - p[0]) / w),
        (abs(p[0] - box.west), 3 + (box.north - p[1]) / h),
    ]
    return min(candidates)[1] % 4


def _snap_to_edge(p: Pt, box: Box) -> Pt:
    d = [(abs(p[1] - box.south), (p[0], box.south)), (abs(p[0] - box.east), (box.east, p[1])),
         (abs(p[1] - box.north), (p[0], box.north)), (abs(p[0] - box.west), (box.west, p[1]))]
    x, y = min(d)[1]
    return (min(box.east, max(box.west, x)), min(box.north, max(box.south, y)))


CORNERS_T = (1.0, 2.0, 3.0, 4.0)


def _corner(t: float, box: Box) -> Pt:
    return {1: (box.east, box.south), 2: (box.east, box.north), 3: (box.west, box.north), 0: (box.west, box.south)}[int(round(t)) % 4]


def close_pieces(pieces: list[list[Pt]], box: Box) -> list[list[Pt]]:
    """Closes open coastline pieces along the box edge into land rings (land on the left, so CCW)."""
    items = []
    for piece in pieces:
        start, end = _snap_to_edge(piece[0], box), _snap_to_edge(piece[-1], box)
        items.append({"pts": [start, *piece[1:-1], end], "tin": _perimeter_t(start, box), "tout": _perimeter_t(end, box)})
    rings: list[list[Pt]] = []
    done = [False] * len(items)
    for first in range(len(items)):
        if done[first]:
            continue
        ring: list[Pt] = []
        cur = first
        for _ in range(len(items) + 1):
            done[cur] = True
            ring.extend(items[cur]["pts"])
            tout = items[cur]["tout"]
            # Next entry counter-clockwise from this exit, including the piece we started from.
            nxt = min(range(len(items)), key=lambda j: ((items[j]["tin"] - tout) % 4) if not done[j] or j == first else 9)
            tin = items[nxt]["tin"]
            span = (tin - tout) % 4
            corners = sorted(((c - tout) % 4, c) for c in CORNERS_T if 0 < (c - tout) % 4 < span)
            ring.extend(_corner(c, box) for _, c in corners)
            if nxt == first:
                break
            cur = nxt
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def signed_area(ring: list[Pt]) -> float:
    return 0.5 * sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1]))


@dataclass
class CoastLand:
    """Land polygons for one box. Rings combine even-odd; points outside the box are treated as water."""

    box: Box
    rings: list[list[Pt]]
    coastline: list[list[Pt]] = field(default_factory=list)
    source: str = SOURCE

    def __post_init__(self) -> None:
        self._rings = [np.asarray(r, dtype=float) for r in self.rings if len(r) >= 3]
        self._boxes = [(r[:, 0].min(), r[:, 1].min(), r[:, 0].max(), r[:, 1].max()) for r in self._rings]
        segs = [np.stack([np.asarray(c[:-1]), np.asarray(c[1:])], axis=1) for c in self.coastline if len(c) >= 2]
        self._segs = np.concatenate(segs) if segs else np.zeros((0, 2, 2))

    def mask(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        lat = np.asarray(lat, dtype=float)
        lon = np.asarray(lon, dtype=float)
        inside = np.zeros(lat.shape, dtype=bool)
        for ring, (x0, y0, x1, y1) in zip(self._rings, self._boxes):
            cand = (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1)
            if not cand.any():
                continue
            xs, ys = lon[cand], lat[cand]
            hit = np.zeros(xs.shape, dtype=bool)
            xa, ya = ring[:, 0], ring[:, 1]
            xb, yb = np.roll(xa, -1), np.roll(ya, -1)
            for k in range(len(ring)):
                cross = (ya[k] > ys) != (yb[k] > ys)
                if not cross.any():
                    continue
                xi = xa[k] + (ys - ya[k]) * (xb[k] - xa[k]) / ((yb[k] - ya[k]) or 1e-18)
                hit ^= cross & (xs < xi)
            inside[cand] ^= hit
        return inside

    def on_land(self, lat: float, lon: float) -> bool:
        if not self.box.inside((lon, lat)):
            return False
        return bool(self.mask(np.array([lat]), np.array([lon]))[0])

    def nearest_coast(self, lat: float, lon: float) -> Pt | None:
        """Closest point on the coastline, in (lon, lat), using a local equirectangular metric."""
        if not len(self._segs):
            return None
        k = math.cos(math.radians(lat))
        a, b = self._segs[:, 0], self._segs[:, 1]
        ax, ay = (a[:, 0] - lon) * k, a[:, 1] - lat
        bx, by = (b[:, 0] - lon) * k, b[:, 1] - lat
        dx, dy = bx - ax, by - ay
        t = np.clip(-(ax * dx + ay * dy) / np.maximum(dx * dx + dy * dy, 1e-18), 0, 1)
        px, py = ax + t * dx, ay + t * dy
        i = int(np.argmin(px * px + py * py))
        return (lon + px[i] / k, lat + py[i])


def build_coast(http: CachedHttp, box: Box, tolerance_deg: float) -> CoastLand:
    ways = fetch_ways(http, box)
    rings: list[list[Pt]] = []
    pieces: list[list[Pt]] = []
    coastline: list[list[Pt]] = []
    for chain in join_ways(ways):
        open_pieces, closed = clip_chain(chain, box)
        for p in open_pieces:
            s = simplify(p, tolerance_deg)
            pieces.append(s)
            coastline.append(s)
        for r in closed:
            s = simplify(r + [r[0]], tolerance_deg)[:-1]
            if len(s) >= 3:
                rings.append(s)
                coastline.append(s + [s[0]])
    rings.extend(close_pieces(pieces, box))
    return CoastLand(box, rings, coastline)


def coast_json(coast: CoastLand, tolerance_m: float) -> dict[str, Any]:
    return {
        "source": coast.source,
        "license": "ODbL 1.0",
        "bbox": {"west": coast.box.west, "south": coast.box.south, "east": coast.box.east, "north": coast.box.north},
        "simplifiedToleranceM": round(tolerance_m),
        "format": "rings of [lon, lat]; combine even-odd; outside the bbox is unknown (treated as water)",
        "rings": [[[round(x, 5), round(y, 5)] for x, y in r] for r in coast.rings],
    }
