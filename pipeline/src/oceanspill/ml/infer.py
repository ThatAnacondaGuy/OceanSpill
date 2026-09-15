"""Run a trained segmentation model over a SAR window.

The classical adaptive-threshold detector is what the project uses today and is always available.
When a model has been trained and exported to ONNX, this module runs it instead, on CPU, over the
same calibrated window and returns a mask in the same shape — so everything downstream (outlines,
areas, look-alike checks, review) is unchanged and the two can be compared on the same scene.

Nothing here downloads or trains anything; `oceanspill-train` produces the model file.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from .data import DB_MAX, DB_MIN

log = logging.getLogger("oceanspill.ml.infer")

# Overlapping tiles, so a slick crossing a tile edge is not cut in half.
TILE = 512
OVERLAP = 64


class Segmenter(Protocol):
    name: str
    description: str

    def mask(self, db: np.ndarray, sea: np.ndarray) -> np.ndarray:
        """Per-pixel oil probability over the window, in [0, 1]."""


@dataclass
class ModelInfo:
    path: Path
    channels: int
    threshold: float
    trained_on: str
    validation: dict[str, Any]


def normalise(db: np.ndarray) -> np.ndarray:
    """dB to [0, 1] the same way the training data was prepared."""
    return np.clip((db - DB_MIN) / (DB_MAX - DB_MIN), 0.0, 1.0).astype(np.float32)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


class OnnxSegmenter:
    """A U-Net exported to ONNX, run tile by tile on the CPU."""

    def __init__(self, info: ModelInfo):
        try:
            import onnxruntime  # noqa: PLC0415
        except ImportError as exc:  # pragma: no cover - depends on the install
            raise RuntimeError("running a trained model needs onnxruntime: uv sync --extra ml") from exc
        self.info = info
        self.session = onnxruntime.InferenceSession(str(info.path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.name = f"unet-onnx:{info.path.stem}"
        self.description = (f"U-Net segmentation ({info.path.name}), trained on {info.trained_on}, "
                            f"threshold {info.threshold:g}")

    def mask(self, db: np.ndarray, sea: np.ndarray) -> np.ndarray:
        h, w = db.shape
        x = normalise(db)
        # The model never sees land or invalid pixels; they go in at the sea median.
        fill = float(np.median(x[sea])) if sea.any() else 0.5
        x = np.where(sea, x, fill)
        total = np.zeros((h, w), dtype=np.float32)
        weight = np.zeros((h, w), dtype=np.float32)
        step = TILE - OVERLAP
        for r0 in range(0, max(1, h - OVERLAP), step):
            for c0 in range(0, max(1, w - OVERLAP), step):
                r1, c1 = min(r0 + TILE, h), min(c0 + TILE, w)
                tile = x[r0:r1, c0:c1]
                padded = np.zeros((TILE, TILE), dtype=np.float32) + fill
                padded[: r1 - r0, : c1 - c0] = tile
                batch = np.repeat(padded[None, None], self.info.channels, axis=1)
                logits = self.session.run(None, {self.input_name: batch})[0]
                probability = _sigmoid(np.asarray(logits, dtype=np.float32))[0, 0]
                total[r0:r1, c0:c1] += probability[: r1 - r0, : c1 - c0]
                weight[r0:r1, c0:c1] += 1.0
        out = np.divide(total, np.maximum(weight, 1e-6))
        return np.where(sea, out, 0.0)


def load_model(path: Path) -> ModelInfo:
    """Read a model and whatever the training run recorded next to it."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"no model at {path}")
    meta_path = path.with_suffix(".json")
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    return ModelInfo(
        path=path,
        channels=int(meta.get("channels", 2)),
        threshold=float(meta.get("threshold", 0.5)),
        trained_on=str(meta.get("trainedOn", "an unrecorded dataset")),
        validation=meta.get("val", {}),
    )


def segmenter(path: Path | str | None) -> Segmenter | None:
    """The trained detector at `path`, or None when there is no model to run."""
    if not path:
        return None
    try:
        return OnnxSegmenter(load_model(Path(path)))
    except (FileNotFoundError, RuntimeError) as exc:
        log.warning("falling back to the classical detector: %s", exc)
        return None


def mask_to_spots(probability: np.ndarray, threshold: float) -> np.ndarray:
    """Binary oil mask from per-pixel probabilities."""
    return probability >= threshold
