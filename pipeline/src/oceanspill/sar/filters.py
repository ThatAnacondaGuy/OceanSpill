from __future__ import annotations

import numpy as np


def to_db(linear: np.ndarray, floor: float = 1e-6) -> np.ndarray:
    return (10.0 * np.log10(np.maximum(linear, floor))).astype(np.float32)


def multilook_power(dn: np.ndarray, factor: int, chunk_rows: int = 2048) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Mean |DN|^2 over factor x factor blocks, streamed in row chunks so a memory-mapped full
    scene never has to fit in RAM. Returns the power and the block-centre row/col coordinates."""
    h, w = dn.shape[:2]
    oh, ow = h // factor, w // factor
    out = np.empty((oh, ow), dtype=np.float32)
    step = max(1, chunk_rows // factor)
    for r0 in range(0, oh, step):
        r1 = min(oh, r0 + step)
        block = np.asarray(dn[r0 * factor:r1 * factor, : ow * factor], dtype=np.float32)
        block = block * block
        out[r0:r1] = block.reshape(r1 - r0, factor, ow, factor).mean(axis=(1, 3))
    rows = np.arange(oh) * factor + (factor - 1) / 2
    cols = np.arange(ow) * factor + (factor - 1) / 2
    return out, rows, cols


def box_sum(img: np.ndarray, size: int) -> np.ndarray:
    """Sum over a size x size window (edge-clamped) using an integral image."""
    pad = size // 2
    padded = np.pad(img.astype(np.float64), pad, mode="edge")
    ii = np.pad(padded.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    h, w = img.shape
    return ii[size:size + h, size:size + w] - ii[:h, size:size + w] - ii[size:size + h, :w] + ii[:h, :w]


def box_mean(img: np.ndarray, size: int) -> np.ndarray:
    return box_sum(img, size) / float(size * size)


def masked_mean_std(img: np.ndarray, mask: np.ndarray, size: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Local mean and standard deviation over valid pixels only, plus the local valid count."""
    m = mask.astype(np.float64)
    x = np.where(mask, img, 0.0).astype(np.float64)
    n = box_sum(m, size)
    s1 = box_sum(x, size)
    s2 = box_sum(x * x, size)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(n > 0, s1 / n, np.nan)
        var = np.where(n > 1, s2 / n - mean * mean, np.nan)
    return mean, np.sqrt(np.maximum(var, 0.0)), n


def lee_filter(linear: np.ndarray, size: int = 7, looks: float = 4.4) -> np.ndarray:
    """Classic Lee speckle filter on linear intensity.

    looks is the equivalent number of looks of the input (about 4.4 for Sentinel-1 IW GRDH, higher
    after further multilooking). Homogeneous areas are smoothed towards the local mean while edges,
    where local variation exceeds speckle statistics, are preserved.
    """
    mean = box_mean(linear, size)
    sq_mean = box_mean(linear.astype(np.float64) ** 2, size)
    var = np.maximum(sq_mean - mean * mean, 0.0)
    cu2 = 1.0 / looks
    with np.errstate(invalid="ignore", divide="ignore"):
        ci2 = np.where(mean > 0, var / (mean * mean), 0.0)
        weight = np.where(ci2 > cu2, 1.0 - cu2 / ci2, 0.0)
    return (mean + np.clip(weight, 0.0, 1.0) * (linear - mean)).astype(np.float32)


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return mask.copy()
    return box_sum(mask.astype(np.float64), 2 * radius + 1) > 0
