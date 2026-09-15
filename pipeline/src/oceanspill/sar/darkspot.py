from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

from .filters import dilate, masked_mean_std


@dataclass
class DarkSpot:
    label: int
    pixels: int
    area_km2: float
    mean_db: float
    background_db: float
    contrast_db: float
    centroid_rc: tuple[float, float]
    bbox_rc: tuple[int, int, int, int]
    elongation: float
    hull_rc: list[tuple[float, float]]


def label_components(mask: np.ndarray, min_pixels: int = 1) -> tuple[np.ndarray, int]:
    """4-connected component labelling (breadth-first); components below min_pixels are dropped."""
    labels = np.zeros(mask.shape, dtype=np.int32)
    h, w = mask.shape
    current = 0
    for r0, c0 in np.argwhere(mask):
        if labels[r0, c0]:
            continue
        current += 1
        labels[r0, c0] = current
        queue = deque([(r0, c0)])
        members = [(r0, c0)]
        while queue:
            r, c = queue.popleft()
            for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= rr < h and 0 <= cc < w and mask[rr, cc] and not labels[rr, cc]:
                    labels[rr, cc] = current
                    queue.append((rr, cc))
                    members.append((rr, cc))
        if len(members) < min_pixels:
            rs, cs = zip(*members)
            labels[list(rs), list(cs)] = -1
            current -= 1
    labels[labels < 0] = 0
    return labels, current


def convex_hull(points: np.ndarray) -> list[tuple[float, float]]:
    """Monotone chain convex hull of (row, col) points."""
    pts = sorted({(float(p[0]), float(p[1])) for p in points})
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def detect_dark_spots(
    db: np.ndarray,
    sea: np.ndarray,
    pixel_km: float,
    window: int = 51,
    k_sigma: float = 1.5,
    min_contrast_db: float = 3.0,
    min_area_km2: float = 0.5,
    max_spots: int = 20,
) -> tuple[list[DarkSpot], np.ndarray]:
    """Adaptive-threshold dark-spot detection on a speckle-filtered sigma0 image in dB.

    A sea pixel is dark when it lies below the local sea background by more than both
    k_sigma local standard deviations and min_contrast_db. This is the classical first stage of
    SAR oil spill detection: it finds oil and look-alikes alike, and the look-alike checks decide
    between them. It is not a trained model.
    """
    background, spread, count = masked_mean_std(db, sea, window)
    threshold = background - np.maximum(k_sigma * spread, min_contrast_db)
    dark = sea & (count > window * window * 0.25) & (db < threshold)
    min_pixels = max(4, int(round(min_area_km2 / (pixel_km * pixel_km))))
    labels, n = label_components(dark, min_pixels)

    spots: list[DarkSpot] = []
    coords = np.argwhere(labels > 0)
    if len(coords):
        order = np.argsort(labels[coords[:, 0], coords[:, 1]], kind="stable")
        coords = coords[order]
        splits = np.flatnonzero(np.diff(labels[coords[:, 0], coords[:, 1]])) + 1
        groups = np.split(coords, splits)
    else:
        groups = []
    pad = 6
    h, w = db.shape
    for rc in groups:
        lab = int(labels[rc[0, 0], rc[0, 1]])
        r0, c0 = rc.min(axis=0)
        r1, c1 = rc.max(axis=0)
        sl = (slice(max(0, r0 - pad), min(h, r1 + pad + 1)), slice(max(0, c0 - pad), min(w, c1 + pad + 1)))
        comp = labels[sl] == lab
        # Background is the clean sea in a 5-pixel ring around the spot, excluding other dark pixels.
        ring = dilate(comp, 5) & ~comp & sea[sl] & ~dark[sl]
        crop = db[sl]
        mean_db = float(crop[comp].mean())
        bg_db = float(crop[ring].mean()) if ring.any() else float(np.nanmean(background[sl][comp]))
        centroid = rc.mean(axis=0)
        cov = np.cov((rc - centroid).T) if len(rc) > 2 else np.eye(2)
        # Image rows and columns are not north and east in radar geometry, so orientation is
        # computed later in geographic coordinates; elongation is rotation invariant.
        evals = np.linalg.eigvalsh(cov)
        major = float(np.sqrt(max(evals[-1], 1e-9)))
        minor = float(np.sqrt(max(evals[0], 1e-9)))
        spots.append(DarkSpot(
            label=lab, pixels=int(len(rc)), area_km2=float(len(rc) * pixel_km * pixel_km),
            mean_db=mean_db, background_db=bg_db, contrast_db=mean_db - bg_db,
            centroid_rc=(float(centroid[0]), float(centroid[1])), bbox_rc=(int(r0), int(c0), int(r1), int(c1)),
            elongation=major / minor if minor > 0 else 1.0,
            hull_rc=convex_hull(rc),
        ))
    spots.sort(key=lambda s: s.area_km2, reverse=True)
    return spots[:max_spots], labels
