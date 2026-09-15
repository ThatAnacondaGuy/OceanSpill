from __future__ import annotations

import re
from pathlib import Path

import numpy as np

# Sigma0 range used to scale dB inputs to [0, 1]; ocean backscatter rarely leaves it.
DB_MIN = -35.0
DB_MAX = 5.0


def _number(path: Path) -> int | None:
    digits = re.findall(r"\d+", path.stem)
    return int(digits[-1]) if digits else None


def pair_files(images_dir: Path, masks_dir: Path, suffixes: tuple[str, ...] = (".tif", ".tiff")) -> list[tuple[Path, Path]]:
    """Image/mask pairs matched on the trailing number in the file name.

    The public Sentinel-1 oil spill dataset (Zenodo 8346860) stores images and masks in separate
    folders where each mask carries the same number as its image.
    """
    masks = {n: p for p in masks_dir.iterdir() if p.suffix.lower() in suffixes and (n := _number(p)) is not None}
    pairs = []
    for img in sorted(images_dir.iterdir()):
        if img.suffix.lower() not in suffixes:
            continue
        n = _number(img)
        if n is not None and n in masks:
            pairs.append((img, masks[n]))
    return pairs


def to_chw(image: np.ndarray, channels: int = 2) -> np.ndarray:
    """Channel-first float32 array with exactly `channels` bands (missing bands are zero-filled)."""
    arr = np.asarray(image, dtype=np.float32)
    if arr.ndim == 2:
        arr = arr[None]
    elif arr.ndim == 3 and arr.shape[-1] <= 4 and arr.shape[0] > 4:
        arr = np.moveaxis(arr, -1, 0)
    if arr.shape[0] < channels:
        arr = np.concatenate([arr, np.zeros((channels - arr.shape[0], *arr.shape[1:]), dtype=np.float32)])
    return arr[:channels]


def normalise_db(chw: np.ndarray) -> np.ndarray:
    return np.clip((np.nan_to_num(chw, nan=DB_MIN) - DB_MIN) / (DB_MAX - DB_MIN), 0.0, 1.0).astype(np.float32)


def binary_mask(mask: np.ndarray) -> np.ndarray:
    m = np.asarray(mask)
    if m.ndim == 3:
        m = m[..., 0] if m.shape[-1] <= 4 else m[0]
    return (m > 0).astype(np.float32)


def random_crop(
    image: np.ndarray, mask: np.ndarray, size: int, rng: np.random.Generator, positive_fraction: float = 0.5, tries: int = 20
) -> tuple[np.ndarray, np.ndarray]:
    """A size x size crop; with probability positive_fraction, prefer a crop containing oil.

    Oil is a tiny share of pixels, so uniform crops would teach the network to predict sea everywhere.
    """
    _, h, w = image.shape
    if h < size or w < size:
        raise ValueError(f"image {h}x{w} smaller than crop {size}")
    want_oil = rng.random() < positive_fraction and mask.any()
    for _ in range(tries if want_oil else 1):
        r = int(rng.integers(0, h - size + 1))
        c = int(rng.integers(0, w - size + 1))
        m = mask[r:r + size, c:c + size]
        if not want_oil or m.any():
            break
    return image[:, r:r + size, c:c + size], m


def tile_starts(length: int, tile: int, overlap: int) -> list[int]:
    if length <= tile:
        return [0]
    step = tile - overlap
    starts = list(range(0, length - tile + 1, step))
    if starts[-1] != length - tile:
        starts.append(length - tile)
    return starts


def stitch(shape: tuple[int, int], tiles: list[tuple[int, int, np.ndarray]], tile: int) -> np.ndarray:
    """Average overlapping tile predictions with a centre-weighted window to suppress seams."""
    acc = np.zeros(shape, dtype=np.float32)
    weight = np.zeros(shape, dtype=np.float32)
    ramp = np.minimum(np.arange(1, tile + 1), np.arange(tile, 0, -1)).astype(np.float32)
    window = np.minimum.outer(ramp, ramp)
    for r, c, pred in tiles:
        h, w = pred.shape
        acc[r:r + h, c:c + w] += pred * window[:h, :w]
        weight[r:r + h, c:c + w] += window[:h, :w]
    return acc / np.maximum(weight, 1e-6)


def confusion(pred: np.ndarray, truth: np.ndarray) -> tuple[int, int, int, int]:
    p = pred.astype(bool)
    t = truth.astype(bool)
    return int((p & t).sum()), int((p & ~t).sum()), int((~p & t).sum()), int((~p & ~t).sum())


def metrics(tp: int, fp: int, fn: int, tn: int) -> dict[str, float | None]:
    def ratio(a: float, b: float) -> float | None:
        return a / b if b else None

    return {
        "iou": ratio(tp, tp + fp + fn),
        "dice": ratio(2 * tp, 2 * tp + fp + fn),
        "precision": ratio(tp, tp + fp),
        "recall": ratio(tp, tp + fn),
        "falsePositiveRate": ratio(fp, fp + tn),
        "oilPixelShare": ratio(tp + fn, tp + fp + fn + tn),
    }
