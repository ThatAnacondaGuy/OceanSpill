from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from oceanspill.ml.data import (
    binary_mask, confusion, metrics, normalise_db, pair_files, random_crop, stitch, tile_starts, to_chw,
)


def test_pairs_images_and_masks_by_number(tmp_path: Path):
    images, masks = tmp_path / "images", tmp_path / "masks"
    images.mkdir()
    masks.mkdir()
    for name in ("0001.tif", "0002.tif", "0003.tif", "notes.txt"):
        (images / name).write_bytes(b"")
    for name in ("0002.tif", "0001.tif"):
        (masks / name).write_bytes(b"")
    pairs = pair_files(images, masks)
    assert [(i.name, m.name) for i, m in pairs] == [("0001.tif", "0001.tif"), ("0002.tif", "0002.tif")]


def test_channel_layout_and_scaling():
    hwc = np.full((8, 8, 2), -15.0)
    chw = to_chw(hwc)
    assert chw.shape == (2, 8, 8)
    assert to_chw(np.zeros((8, 8))).shape == (2, 8, 8), "single polarisation is zero-padded"
    assert normalise_db(np.array([[[-35.0, -15.0, 5.0, np.nan]]])).tolist() == [[[0.0, 0.5, 1.0, 0.0]]]
    assert binary_mask(np.array([[0, 255], [1, 0]])).tolist() == [[0, 1], [1, 0]]


def test_random_crop_prefers_oil_when_asked():
    rng = np.random.default_rng(0)
    img = np.zeros((2, 256, 256), dtype=np.float32)
    mask = np.zeros((256, 256), dtype=np.float32)
    mask[200:210, 200:210] = 1
    hits = sum(random_crop(img, mask, 64, rng, positive_fraction=1.0)[1].any() for _ in range(20))
    assert hits >= 18


def test_tiles_cover_the_image_and_stitch_back():
    starts = tile_starts(1000, 256, 64)
    assert starts[0] == 0 and starts[-1] == 1000 - 256
    assert all(b - a <= 192 for a, b in zip(starts, starts[1:]))
    truth = np.random.default_rng(1).random((300, 300)).astype(np.float32)
    tiles = [(r, c, truth[r:r + 128, c:c + 128]) for r in tile_starts(300, 128, 32) for c in tile_starts(300, 128, 32)]
    assert np.allclose(stitch((300, 300), tiles, 128), truth, atol=1e-5)


def test_metrics_report_iou_and_false_positive_rate():
    pred = np.array([[1, 1, 0, 0]])
    truth = np.array([[1, 0, 1, 0]])
    m = metrics(*confusion(pred, truth))
    assert m["iou"] == pytest.approx(1 / 3)
    assert m["dice"] == pytest.approx(0.5)
    assert m["falsePositiveRate"] == pytest.approx(0.5)
    assert metrics(0, 0, 0, 10)["iou"] is None, "IoU is undefined without any oil, not zero"


def test_unet_forward_shape_when_torch_available():
    torch = pytest.importorskip("torch")
    from oceanspill.ml.unet import DiceFocalLoss, UNet

    model = UNet(2, base=4, depth=3)
    out = model(torch.zeros(1, 2, 64, 64))
    assert out.shape == (1, 1, 64, 64)
    loss = DiceFocalLoss()(out, torch.zeros_like(out))
    assert torch.isfinite(loss)
