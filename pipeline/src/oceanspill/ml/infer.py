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
    #: The decibel range each channel was scaled over during training, in channel order.
    channel_ranges: list[tuple[float, float]]


def normalise(db: np.ndarray, low: float = DB_MIN, high: float = DB_MAX) -> np.ndarray:
    """Decibels to [0, 1] over the range the model was trained on."""
    return np.clip((db - low) / (high - low), 0.0, 1.0).astype(np.float32)


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
        # True when the scene has one polarisation and the model wants more.
        self.duplicated_channels = info.channels > 1
        self.description = (f"U-Net segmentation ({info.path.name}), trained on {info.trained_on}, "
                            f"threshold {info.threshold:g}"
                            + (f"; the scene supplies one polarisation and the model expects "
                               f"{info.channels}, so the same band is used for each"
                               if self.duplicated_channels else ""))

    def mask(self, db: np.ndarray, sea: np.ndarray) -> np.ndarray:
        h, w = db.shape
        # One scaled copy per channel, each over the range that channel was trained on. Getting this
        # wrong shifts every pixel the model sees and quietly ruins the result.
        planes = [normalise(db, low, high) for low, high in self.info.channel_ranges[: self.info.channels]]
        while len(planes) < self.info.channels:
            planes.append(planes[-1])
        # The model never sees land or invalid pixels; they go in at the sea median.
        fills = [float(np.median(p[sea])) if sea.any() else 0.5 for p in planes]
        planes = [np.where(sea, p, f) for p, f in zip(planes, fills)]
        x = planes[0]
        total = np.zeros((h, w), dtype=np.float32)
        weight = np.zeros((h, w), dtype=np.float32)
        step = TILE - OVERLAP
        for r0 in range(0, max(1, h - OVERLAP), step):
            for c0 in range(0, max(1, w - OVERLAP), step):
                r1, c1 = min(r0 + TILE, h), min(c0 + TILE, w)
                # A single-polarisation scene cannot fill a two-channel model honestly: each
                # channel gets the same band, scaled over its own training range, and the
                # description says so rather than passing the result off as what the model expects.
                stack = np.empty((1, self.info.channels, TILE, TILE), dtype=np.float32)
                for c, (plane, fill) in enumerate(zip(planes, fills)):
                    stack[0, c] = fill
                    stack[0, c, : r1 - r0, : c1 - c0] = plane[r0:r1, c0:c1]
                batch = stack
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
    ranges = meta.get("channelRange") or {}
    names = meta.get("channelNames") or list(ranges)
    ordered = [tuple(ranges[name]) for name in names if name in ranges] or [(DB_MIN, DB_MAX)]
    return ModelInfo(
        path=path,
        channels=int(meta.get("channels", 2)),
        threshold=float(meta.get("threshold", 0.5)),
        trained_on=str(meta.get("trainedOn", "an unrecorded dataset")),
        validation=meta.get("val", {}),
        channel_ranges=ordered,
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
