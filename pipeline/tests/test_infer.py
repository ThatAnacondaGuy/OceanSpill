"""The detector swap: a trained model decides which pixels are oil, the measurements stay the same."""
from __future__ import annotations

import numpy as np

from oceanspill.ml.infer import normalise
from oceanspill.sar.darkspot import detect_dark_spots


def _scene() -> tuple[np.ndarray, np.ndarray]:
    """Calm sea at -8 dB with one dark patch that the classical detector should find.

    The patch is well inside the 51-pixel detector window: a slick larger than the window becomes
    its own local background, which is a property of adaptive thresholding, not a bug."""
    rng = np.random.default_rng(7)
    db = -8.0 + rng.normal(0, 0.4, (200, 200))
    db[80:100, 60:84] -= 6.0
    return db, np.ones_like(db, dtype=bool)


def test_the_classical_detector_finds_a_dark_patch():
    db, sea = _scene()
    spots, _ = detect_dark_spots(db, sea, pixel_km=0.15, min_area_km2=0.5)
    assert spots, "the patch should be detected"
    assert spots[0].contrast_db < -3
    assert 9 < spots[0].area_km2 < 12


def test_a_supplied_mask_replaces_the_pixel_decision():
    db, sea = _scene()
    # Stand in for a model that segments a different, smaller area.
    mask = np.zeros_like(sea)
    mask[20:50, 20:60] = True
    spots, labels = detect_dark_spots(db, sea, pixel_km=0.15, min_area_km2=0.5, dark=mask)
    assert len(spots) == 1
    assert spots[0].pixels == mask.sum()
    assert labels[90, 70] == 0, "the classical threshold must not run as well"


def test_a_mask_never_reaches_outside_the_sea():
    db, sea = _scene()
    sea[:100, :] = False
    mask = np.ones_like(sea)
    spots, labels = detect_dark_spots(db, sea, pixel_km=0.15, min_area_km2=0.5, dark=mask)
    assert spots and labels[:100, :].max() == 0


def test_backscatter_is_scaled_the_way_the_model_was_trained():
    assert normalise(np.array([-35.0]))[0] == 0.0
    assert normalise(np.array([5.0]))[0] == 1.0
    assert 0.6 < normalise(np.array([-10.0]))[0] < 0.7
    # Values outside the training range are clipped rather than extrapolated.
    assert normalise(np.array([-60.0, 20.0])).tolist() == [0.0, 1.0]
