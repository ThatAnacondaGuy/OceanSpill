"""The measurements the drift model and the AIS scale rest on, and the tile preparation."""
from __future__ import annotations

import numpy as np
import pytest

from oceanspill.ml.ais_anomaly import HOUR_EDGES, build_grid, percentile_of
from oceanspill.ml.drift_calibration import fit_diffusivity, fit_windage, haversine_km
from oceanspill.ml.prepare_sar import CHANNEL_RANGE, dequantise, plan_scene, quantise
from oceanspill.ml.validate_drift import modelled_separation_km
from oceanspill.shoretype import classify_ring, summarise


def _samples(windage: float, deflection_deg: float, n: int = 400, noise: float = 0.0) -> object:
    """Buoy observations built from a known windage, to check the fit recovers it."""
    pd = pytest.importorskip("pandas")
    rng = np.random.default_rng(7)
    angle = np.radians(deflection_deg)
    wind = rng.normal(0, 6, size=(n, 2))
    current = rng.normal(0, 0.3, size=(n, 2))
    rotate = np.array([[np.cos(angle), np.sin(angle)], [-np.sin(angle), np.cos(angle)]])
    drift = current + windage * (wind @ rotate.T) + rng.normal(0, noise, size=(n, 2))
    return pd.DataFrame({
        "wind_u": wind[:, 0], "wind_v": wind[:, 1],
        "cur_u": current[:, 0], "cur_v": current[:, 1],
        "ve": drift[:, 0], "vn": drift[:, 1],
        "id": np.arange(n) // 4,
        "time": pd.to_datetime("2022-06-01", utc=True) + pd.to_timedelta(np.arange(n) % 4, unit="h"),
        "lat": rng.uniform(-30, 20, n),
    })


class TestWindage:
    def test_recovers_a_windage_it_was_given(self):
        fit = fit_windage(_samples(0.03, 0.0), "test")
        assert fit is not None
        assert fit.windage == pytest.approx(0.03, abs=0.002)
        assert abs(fit.deflection_deg) < 2

    def test_recovers_the_angle_the_wind_acts_at(self):
        fit = fit_windage(_samples(0.025, 25.0), "test")
        assert fit.deflection_deg == pytest.approx(25.0, abs=3)

    def test_finds_nothing_when_the_wind_does_nothing(self):
        fit = fit_windage(_samples(0.0, 0.0), "test")
        assert fit.windage < 0.005

    def test_says_so_rather_than_fitting_a_handful_of_points(self):
        assert fit_windage(_samples(0.03, 0.0, n=12), "test") is None

    def test_noise_widens_the_confidence_interval(self):
        clean = fit_windage(_samples(0.03, 0.0, noise=0.01), "test")
        noisy = fit_windage(_samples(0.03, 0.0, noise=0.5), "test")
        clean_width = clean.windage_ci95[1] - clean.windage_ci95[0]
        noisy_width = noisy.windage_ci95[1] - noisy.windage_ci95[0]
        assert noisy_width > clean_width


class TestSpreading:
    def test_separation_grows_with_the_square_root_of_time(self):
        six = modelled_separation_km(500, 6)
        twenty_four = modelled_separation_km(500, 24)
        assert twenty_four == pytest.approx(six * 2, rel=0.01)

    def test_a_larger_diffusivity_spreads_further(self):
        assert modelled_separation_km(600, 24) > modelled_separation_km(8, 24)

    def test_recovers_a_diffusivity_from_synthetic_random_walks(self):
        pd = pytest.importorskip("pandas")
        rng = np.random.default_rng(11)
        # Pairs of buoys that start together and random-walk apart at a known rate.
        k = 400.0
        hours = [6, 12, 24, 48]
        rows = []
        start = pd.to_datetime("2022-01-01", utc=True)
        for pair in range(120):
            lat0, lon0 = float(rng.uniform(-10, 10)), float(rng.uniform(60, 90))
            for member in range(2):
                lat, lon = lat0, lon0 + member * 0.02
                rows.append({"id": pair * 2 + member, "time": start, "lat": lat, "lon": lon,
                             "ve": 0.0, "vn": 0.0, "drogue_status": False})
                for h in hours:
                    step_km = np.sqrt(2 * k * h * 3600) / 1000.0
                    rows.append({
                        "id": pair * 2 + member,
                        "time": start + pd.Timedelta(hours=h),
                        "lat": lat0 + rng.normal(0, step_km) / 110.574,
                        "lon": lon0 + member * 0.02 + rng.normal(0, step_km) / 110.0,
                        "ve": 0.0, "vn": 0.0, "drogue_status": False,
                    })
        frame = pd.DataFrame(rows)
        fit = fit_diffusivity(frame, max_start_km=25.0, hours=hours, max_pairs=200, seed=3)
        assert fit is not None
        # Within a factor of two is enough to catch a unit or formula error.
        assert 0.3 * k < fit.diffusivity_m2s < 3 * k

    def test_distance_between_two_known_places(self):
        # Kochi to Chennai, about 558 km.
        km = haversine_km(np.array([9.965]), np.array([76.255]), np.array([13.082]), np.array([80.27]))[0]
        assert 550 < km < 566


class TestAisGapScale:
    def test_percentile_of_a_value_in_a_known_spread(self):
        values = np.arange(1, 101, dtype=float)
        assert percentile_of(values, 50) == pytest.approx(50, abs=1)
        assert percentile_of(values, 1) == pytest.approx(1, abs=1)
        assert percentile_of(values, 1000) == 100.0

    def test_the_grid_of_gaps_sums_to_one(self):
        rng = np.random.default_rng(5)
        hours = rng.uniform(1, 300, 500)
        shore = rng.uniform(1, 900, 500)
        grid = build_grid(hours, shore)
        total = sum(sum(row) for row in grid["share"])
        assert total == pytest.approx(1.0, abs=1e-3)
        assert len(grid["share"]) == len(HOUR_EDGES) - 1


class TestTilePreparation:
    def test_decibels_survive_the_round_trip(self):
        scene = np.zeros((4, 4, 2), dtype=np.float32)
        scene[..., 0] = -20.0
        scene[..., 1] = -30.0
        back = dequantise(quantise(scene))
        low, high = CHANNEL_RANGE["vv"]
        assert back[0, 0, 0] == pytest.approx((-20.0 - low) / (high - low), abs=0.01)

    def test_values_outside_the_range_are_clipped_not_wrapped(self):
        scene = np.full((2, 2, 2), -80.0, dtype=np.float32)
        assert quantise(scene).min() == 0
        scene = np.full((2, 2, 2), 40.0, dtype=np.float32)
        assert quantise(scene).max() == 255

    def test_every_tile_holding_oil_is_kept(self):
        mask = np.zeros((2048, 2048), dtype=np.uint8)
        mask[600:700, 600:700] = 1          # inside one tile
        mask[1100:1200, 1600:1700] = 1      # inside another
        plans = plan_scene("oil/0001", "oil", mask, tiles_per_clean=0, rng=np.random.default_rng(1))
        assert len(plans) == 2
        assert all(p.oil_fraction > 0 for p in plans)

    def test_clean_tiles_are_sampled_from_scenes_with_no_mask(self):
        plans = plan_scene("no_oil/0001", "no_oil", None, tiles_per_clean=3, rng=np.random.default_rng(1))
        assert len(plans) == 3
        assert all(p.oil_fraction == 0 for p in plans)


class TestShoreTypes:
    def test_a_vertex_takes_the_shore_type_beside_it(self):
        features = {"mangrove": [(9.0, 76.0)], "beach": [(9.5, 76.0)]}
        ring = [[76.0, 9.001], [76.0, 9.4995]]
        assert classify_ring(ring, features, match_km=1.0) == ["mangrove", "beach"]

    def test_nothing_nearby_stays_unclassified(self):
        features = {"beach": [(9.0, 76.0)]}
        assert classify_ring([[80.0, 13.0]], features, match_km=1.0) == ["unclassified"]

    def test_the_more_consequential_type_wins_a_tie(self):
        # A vertex with mangrove and beach the same distance away is called mangrove: oil in
        # mangrove roots is the harder problem, so it should not be hidden behind the beach.
        features = {"mangrove": [(9.01, 76.0)], "beach": [(8.99, 76.0)]}
        assert classify_ring([[76.0, 9.0]], features, match_km=5.0) == ["mangrove"]

    def test_kilometres_add_up_to_the_coastline_length(self):
        ring = [[76.0, 9.0], [76.0, 9.1], [76.0, 9.2]]
        summary = summarise([ring], [["beach", "mangrove", "beach"]])
        assert summary["totalKm"] == pytest.approx(22.1, abs=0.5)
        assert summary["classifiedFraction"] == 1.0
        assert summary["kilometres"]["beach"] == pytest.approx(11.06, abs=0.3)
