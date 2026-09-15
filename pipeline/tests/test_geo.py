from __future__ import annotations

import pytest

from oceanspill.geo import bearing_deg, destination, haversine_km, point_in_ring


def test_haversine_kochi_to_vizhinjam():
    # Roughly 195 km along the Kerala coast.
    assert haversine_km(9.965, 76.255, 8.376, 76.992) == pytest.approx(193, rel=0.03)


def test_destination_round_trip():
    lat, lon = destination(9.3125, 76.136, 225, 50)
    assert haversine_km(9.3125, 76.136, lat, lon) == pytest.approx(50, rel=1e-3)
    assert bearing_deg(9.3125, 76.136, lat, lon) == pytest.approx(225, abs=0.5)


def test_point_in_ring():
    square = [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 1, "lon": 0}]
    assert point_in_ring(0.5, 0.5, square)
    assert not point_in_ring(1.5, 0.5, square)
