"""Turning a ship detector's output into vessel positions, and refusing when the pixels cannot.

The detections these produce end up beside a vessel's name in an enforcement file, so the tests here
are as much about what the module declines to say as about what it finds.
"""
from __future__ import annotations

import numpy as np
import pytest

from oceanspill.sar.vessels import MAX_PIXEL_M_FOR_VESSELS, TooCoarse, as_records, detect_vessels


def grid(shape=(120, 120), lat0=13.0, lon0=80.0, step=0.0002):
    rows, cols = np.mgrid[0 : shape[0], 0 : shape[1]]
    return lat0 + rows * step, lon0 + cols * step


def test_a_bright_compact_blob_becomes_a_vessel():
    probability = np.zeros((120, 120), dtype=np.float32)
    probability[50:58, 60:64] = 0.9  # 8 x 4 pixels: a hull at 20 m pixels
    sea = np.ones((120, 120), dtype=bool)
    lat, lon = grid()
    found = detect_vessels(probability, sea, lat, lon, pixel_km=0.02, incident=(13.0, 80.0), threshold=0.3)
    assert len(found) == 1
    assert 50 <= (found[0].lat - 13.0) / 0.0002 <= 58
    assert found[0].pixels == 32
    assert found[0].length_m is not None


def test_land_cannot_produce_a_vessel():
    probability = np.zeros((120, 120), dtype=np.float32)
    probability[10:18, 10:14] = 0.95  # a bright roof ashore
    sea = np.ones((120, 120), dtype=bool)
    sea[:40, :40] = False
    lat, lon = grid()
    assert detect_vessels(probability, sea, lat, lon, 0.02, (13.0, 80.0), 0.3) == []


def test_a_long_streak_is_not_reported_as_a_ship():
    """Swath edges and wakes are bright and linear; a hull is not 100 pixels long and 2 wide."""
    probability = np.zeros((120, 120), dtype=np.float32)
    probability[60, 5:115] = 0.9
    probability[61, 5:115] = 0.9
    sea = np.ones((120, 120), dtype=bool)
    lat, lon = grid()
    assert detect_vessels(probability, sea, lat, lon, 0.02, (13.0, 80.0), 0.3) == []


def test_a_handful_of_pixels_gets_a_position_but_no_length():
    """A five-pixel blob has a centroid worth reporting and no hull dimensions worth inventing."""
    probability = np.zeros((120, 120), dtype=np.float32)
    probability[70:72, 70:73] = 0.8  # 6 pixels, under the dimensions threshold
    probability[71, 72] = 0.0
    sea = np.ones((120, 120), dtype=bool)
    lat, lon = grid()
    found = detect_vessels(probability, sea, lat, lon, 0.02, (13.0, 80.0), 0.3)
    assert len(found) == 1
    assert found[0].length_m is None and found[0].width_m is None
    assert as_records(found)[0]["lengthM"] is None


def test_a_coarse_window_refuses_rather_than_reporting_no_vessels():
    """75 m pixels cannot resolve a ship, and an empty list there would read as 'none present'."""
    probability = np.full((120, 120), 0.9, dtype=np.float32)
    sea = np.ones((120, 120), dtype=bool)
    lat, lon = grid()
    with pytest.raises(TooCoarse) as exc:
        detect_vessels(probability, sea, lat, lon, pixel_km=0.075, incident=(13.0, 80.0), threshold=0.3)
    assert "75 m" in str(exc.value)
    # And the boundary itself is allowed, so the limit is a limit and not an off-by-one.
    detect_vessels(probability * 0, sea, lat, lon, MAX_PIXEL_M_FOR_VESSELS / 1000.0, (13.0, 80.0), 0.3)


def test_detections_come_back_nearest_the_incident_first():
    probability = np.zeros((120, 120), dtype=np.float32)
    probability[10:18, 10:14] = 0.9   # far from the incident at the grid origin? no: nearer
    probability[100:108, 100:104] = 0.9
    sea = np.ones((120, 120), dtype=bool)
    lat, lon = grid()
    found = detect_vessels(probability, sea, lat, lon, 0.02, (13.0, 80.0), 0.3)
    assert len(found) == 2
    assert found[0].distance_km < found[1].distance_km
