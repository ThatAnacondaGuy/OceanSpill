from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np


def scale_db(db: np.ndarray, lo: float = -30.0, hi: float = 0.0) -> np.ndarray:
    return (np.clip((np.nan_to_num(db, nan=lo) - lo) / (hi - lo), 0.0, 1.0) * 255).astype(np.uint8)


def png_bytes(pixels: np.ndarray) -> bytes:
    """Encode an 8-bit greyscale (H, W) or RGB (H, W, 3) array as PNG using only the standard library."""
    arr = np.ascontiguousarray(pixels, dtype=np.uint8)
    if arr.ndim == 2:
        color_type = 0
    elif arr.ndim == 3 and arr.shape[2] == 3:
        color_type = 2
    else:
        raise ValueError("expected (H, W) or (H, W, 3) uint8 array")
    h, w = arr.shape[:2]
    raw = b"".join(b"\x00" + arr[r].tobytes() for r in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def write_quicklook(path: Path, db: np.ndarray, land: np.ndarray, dark_labels: np.ndarray | None = None) -> Path:
    """Greyscale sigma0 with land tinted and detected dark spots outlined in red."""
    grey = scale_db(db)
    rgb = np.stack([grey, grey, grey], axis=-1)
    rgb[land] = (rgb[land] * 0.35 + np.array([90, 120, 70]) * 0.65).astype(np.uint8)
    if dark_labels is not None:
        spots = dark_labels > 0
        edge = spots & ~(
            np.roll(spots, 1, 0) & np.roll(spots, -1, 0) & np.roll(spots, 1, 1) & np.roll(spots, -1, 1)
        )
        rgb[edge] = (230, 40, 40)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png_bytes(rgb))
    return path
