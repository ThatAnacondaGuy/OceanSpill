"""Find vessels in a radar window, so a ship that is transmitting nothing still leaves a mark.

Oil is dark in radar and steel is bright, so the same scene that shows a slick also shows the
traffic around it. The attribution chain up to now could only rank vessels that broadcast AIS, which
means the one kind of vessel worth suspecting — the one that turned its transmitter off — was the
one kind it could not see.

This runs the trained ship detector over the window and turns what it finds into positions. Matching
those against the AIS tracks for the same minute is what makes a detection "dark": radar says a ship
is there, the feed says nothing is. That comparison belongs to the caller, because it needs the AIS
window; here the job is only to say what the radar shows.

Nothing in here guesses. A vessel gets a length only when the pixel size supports one, and the model
that produced it is named in the record so a reader can look up what it scores.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..geo import haversine_km
from .darkspot import label_components

log = logging.getLogger(__name__)

# Below this a bright return is speckle or a wave crest, not a hull.
MIN_PIXELS = 4
# A vessel is compact. A bright streak hundreds of pixels long is a swath edge, an ice shelf or an
# oil platform's wake, and reporting it as a ship would put a false vessel in an enforcement file.
MAX_ELONGATION = 12.0
# Ships longer than this do not exist; a blob this large is a rig, an island or a processing artefact.
MAX_LENGTH_M = 500.0
# The window the slick is measured in is multilooked to about 75 m pixels to beat down speckle. A
# 200 m ship is under three pixels across there, which is not enough for the detector to separate a
# hull from a bright patch of sea, and far too few to measure a length from. Vessel detection wants
# the scene at or near full resolution; above this pixel size the answer is that nobody can tell.
MAX_PIXEL_M_FOR_VESSELS = 30.0
# And a length needs several pixels along the hull before it means anything at all.
MIN_PIXELS_FOR_DIMENSIONS = 8
# The threshold the training run chose was picked on SSDD chips, which are cropped around a ship and
# hold almost no open water. It is close to meaningless for a whole scene: between 0.3 and 0.7 the
# chip score barely moves (IoU 0.550 to 0.543), because on a chip the ship is obvious either way.
# A scene is millions of water pixels, so the same threshold that looked harmless produced hundreds
# of marginal targets off Chennai at a median confidence of 0.34. This is the operating point for
# scene-wide use: it costs four points of chip recall and removes most of what sits just above the
# floor. It is a judgement, not a measurement, and it is written here so it can be argued with.
SCENE_THRESHOLD = 0.7


class TooCoarse(RuntimeError):
    """The window's pixels are too large for a vessel to be resolved in it."""


@dataclass
class VesselDetection:
    lat: float
    lon: float
    pixels: int
    length_m: float | None
    width_m: float | None
    confidence: float
    distance_km: float


def _axes_m(rows: np.ndarray, cols: np.ndarray, pixel_km: float) -> tuple[float, float]:
    """Length and width in metres from the pixel footprint's principal axes."""
    if len(rows) < 3:
        span = float(max(rows.ptp(), cols.ptp()) + 1) * pixel_km * 1000.0
        return span, span
    points = np.column_stack([rows - rows.mean(), cols - cols.mean()]).astype(np.float64)
    # Two pixels wide in one direction is a covariance of zero there, so guard the degenerate case.
    cov = np.cov(points, rowvar=False)
    if not np.all(np.isfinite(cov)):
        return 0.0, 0.0
    eigenvalues = np.linalg.eigvalsh(cov)
    extent = 2.0 * np.sqrt(np.maximum(eigenvalues, 0.0)) * 2.0
    width, length = (float(extent[0]), float(extent[1]))
    return length * pixel_km * 1000.0, width * pixel_km * 1000.0


def detect_vessels(
    probability: np.ndarray,
    sea: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    pixel_km: float,
    incident: tuple[float, float],
    threshold: float,
    max_vessels: int = 200,
) -> list[VesselDetection]:
    """Bright, compact, ship-sized regions of the model's output, as positions.

    `probability` is the detector's per-pixel output over the same window the slick was measured in,
    and `sea` is the water mask, so a bright roof on the coast cannot become a vessel.

    Raises `TooCoarse` when the pixels are too large for a ship to be more than a smudge. Returning
    an empty list there would be a lie of a different kind: it would read as "no vessels present"
    when the truth is that this window cannot answer the question.
    """
    pixel_m = pixel_km * 1000.0
    if pixel_m > MAX_PIXEL_M_FOR_VESSELS:
        raise TooCoarse(
            f"vessel detection needs pixels of {MAX_PIXEL_M_FOR_VESSELS:.0f} m or finer; this window is "
            f"{pixel_m:.0f} m, where a 200 m ship is under {200 / pixel_m:.1f} pixels across"
        )
    mask = (probability >= threshold) & sea
    if not mask.any():
        return []
    labels, count = label_components(mask, MIN_PIXELS)
    if count == 0:
        return []

    found: list[VesselDetection] = []
    coords = np.argwhere(labels > 0)
    ids = labels[coords[:, 0], coords[:, 1]]
    order = np.argsort(ids, kind="stable")
    coords, ids = coords[order], ids[order]
    for chunk in np.split(coords, np.flatnonzero(np.diff(ids)) + 1):
        rows, cols = chunk[:, 0], chunk[:, 1]
        length_m, width_m = _axes_m(rows, cols, pixel_km)
        if width_m > 0 and length_m / max(width_m, 1e-6) > MAX_ELONGATION:
            continue
        if length_m > MAX_LENGTH_M:
            continue
        r, c = int(round(rows.mean())), int(round(cols.mean()))
        vlat, vlon = float(lat[r, c]), float(lon[r, c])
        found.append(VesselDetection(
            lat=round(vlat, 5), lon=round(vlon, 5), pixels=int(len(chunk)),
            # A length is only meaningful when a hull spans several pixels. Below that the axes come
            # out of the covariance of a handful of pixels, which produces a confident-looking number
            # with nothing behind it — a 13-pixel blob does not have a 421 m hull.
            length_m=round(length_m, 1) if len(chunk) >= MIN_PIXELS_FOR_DIMENSIONS else None,
            width_m=round(width_m, 1) if len(chunk) >= MIN_PIXELS_FOR_DIMENSIONS else None,
            confidence=round(float(probability[rows, cols].mean()), 4),
            distance_km=round(haversine_km(vlat, vlon, *incident), 2),
        ))
    found.sort(key=lambda v: v.distance_km)
    if len(found) > max_vessels:
        log.info("keeping the %d vessel detections nearest the incident of %d found", max_vessels, len(found))
    return found[:max_vessels]


def as_records(vessels: list[VesselDetection]) -> list[dict[str, Any]]:
    return [{
        "position": {"lat": v.lat, "lon": v.lon},
        "pixels": v.pixels,
        "lengthM": v.length_m,
        "widthM": v.width_m,
        "confidence": v.confidence,
        "distanceKm": v.distance_km,
    } for v in vessels]
