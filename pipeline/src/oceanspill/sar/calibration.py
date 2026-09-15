from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass

import numpy as np


@dataclass
class LutVector:
    line: int
    pixels: np.ndarray
    values: np.ndarray


@dataclass
class AzimuthNoiseBlock:
    first_line: int
    last_line: int
    first_sample: int
    last_sample: int
    lines: np.ndarray
    values: np.ndarray


def _floats(text: str | None) -> np.ndarray:
    return np.array((text or "").split(), dtype=np.float64)


def parse_calibration(xml: str, lut: str = "sigmaNought") -> list[LutVector]:
    """Calibration vectors from a Sentinel-1 calibration-*.xml annotation."""
    root = ET.fromstring(xml)
    vectors = []
    for v in root.iter("calibrationVector"):
        vectors.append(LutVector(int(v.findtext("line")), _floats(v.findtext("pixel")), _floats(v.findtext(lut))))
    if not vectors:
        raise ValueError("no calibrationVector elements found")
    return sorted(vectors, key=lambda v: v.line)


def parse_noise(xml: str) -> tuple[list[LutVector], list[AzimuthNoiseBlock]]:
    """Thermal noise range vectors (IPF >= 2.9 and older layouts) and azimuth noise blocks if present."""
    root = ET.fromstring(xml)
    ranges = [
        LutVector(int(v.findtext("line")), _floats(v.findtext("pixel")), _floats(v.findtext("noiseRangeLut")))
        for v in root.iter("noiseRangeVector")
    ] or [
        LutVector(int(v.findtext("line")), _floats(v.findtext("pixel")), _floats(v.findtext("noiseLut")))
        for v in root.iter("noiseVector")
    ]
    azimuth = [
        AzimuthNoiseBlock(
            int(b.findtext("firstAzimuthLine")), int(b.findtext("lastAzimuthLine")),
            int(b.findtext("firstRangeSample")), int(b.findtext("lastRangeSample")),
            _floats(b.findtext("line")), _floats(b.findtext("noiseAzimuthLut")),
        )
        for b in root.iter("noiseAzimuthVector")
    ]
    return sorted(ranges, key=lambda v: v.line), azimuth


def interpolate_lut(vectors: list[LutVector], rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """Bilinear LUT values at image coordinates (rows x cols), linear in pixel then in line."""
    rows = np.asarray(rows, dtype=np.float64)
    cols = np.asarray(cols, dtype=np.float64)
    per_vector = np.stack([np.interp(cols, v.pixels, v.values) for v in vectors])  # [n_vectors, n_cols]
    lines = np.array([v.line for v in vectors], dtype=np.float64)
    if len(lines) == 1:
        return np.repeat(per_vector, len(rows), axis=0)
    idx = np.clip(np.searchsorted(lines, rows, side="right") - 1, 0, len(lines) - 2)
    frac = np.clip((rows - lines[idx]) / (lines[idx + 1] - lines[idx]), 0.0, 1.0)[:, None]
    return per_vector[idx] * (1 - frac) + per_vector[idx + 1] * frac


def azimuth_noise(blocks: list[AzimuthNoiseBlock], rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """Azimuth noise scaling at image coordinates; 1 where no block applies."""
    out = np.ones((len(rows), len(cols)), dtype=np.float64)
    rows = np.asarray(rows, dtype=np.float64)
    cols = np.asarray(cols, dtype=np.float64)
    for b in blocks:
        rmask = (rows >= b.first_line) & (rows <= b.last_line)
        cmask = (cols >= b.first_sample) & (cols <= b.last_sample)
        if not rmask.any() or not cmask.any():
            continue
        values = np.interp(rows[rmask], b.lines, b.values) if len(b.lines) > 1 else np.full(rmask.sum(), b.values[0])
        out[np.ix_(rmask, cmask)] = values[:, None]
    return out


def sigma0(
    power_dn: np.ndarray,
    rows: np.ndarray,
    cols: np.ndarray,
    calibration: list[LutVector],
    noise: tuple[list[LutVector], list[AzimuthNoiseBlock]] | None = None,
) -> np.ndarray:
    """Calibrated sigma0 (linear) from mean |DN|^2 sampled at (rows, cols).

    sigma0 = (|DN|^2 - noise) / A^2, following the Sentinel-1 product specification. Negative
    values after noise subtraction are clipped to a small floor instead of being dropped.
    """
    a = interpolate_lut(calibration, rows, cols)
    signal = power_dn.astype(np.float64)
    if noise is not None:
        ranges, azimuth = noise
        if ranges:
            n = interpolate_lut(ranges, rows, cols)
            if azimuth:
                n = n * azimuth_noise(azimuth, rows, cols)
            signal = signal - n
    return np.maximum(signal / (a * a), 1e-6).astype(np.float32)
