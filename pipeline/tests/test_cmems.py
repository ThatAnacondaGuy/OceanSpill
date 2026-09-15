from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from oceanspill.config import Settings
from oceanspill.providers import Providers
from oceanspill.providers.base import BBox, ForcingGrid, ProviderStatus
from oceanspill.providers.metocean_cmems import CmemsCurrents, CurrentCube, sample_cube
from oceanspill.providers.metocean_merged import MergedMetOcean
from oceanspill.providers.metocean_openmeteo import grid_axes

T0 = datetime(2017, 1, 27, tzinfo=timezone.utc)


def _cube() -> CurrentCube:
    lats = np.array([12.5, 12.583333, 12.666667])
    lons = np.array([80.0, 80.083333, 80.166667])
    days = [T0 + timedelta(days=d) for d in range(3)]
    u = np.stack([np.full((3, 3), 0.1 * (d + 1), dtype=np.float32) for d in range(3)])
    v = np.full((3, 3, 3), -0.2, dtype=np.float32)
    u[:, 0, 0] = np.nan  # a land cell
    return CurrentCube(days, lats, lons, u, v)


def test_daily_means_are_centred_at_noon_and_interpolated_in_time():
    cube = _cube()
    times = [T0 + timedelta(hours=12), T0 + timedelta(hours=24), T0 + timedelta(hours=36)]
    u, v = sample_cube(cube, [12.55], [80.1], times)
    assert [row[0][0] for row in u] == pytest.approx([0.1, 0.15, 0.2])
    assert v[1][0][0] == pytest.approx(-0.2)


def test_land_cells_are_excluded_not_averaged_as_zero():
    cube = _cube()
    u, _ = sample_cube(cube, [12.52, 12.5], [80.02, 80.0], [T0 + timedelta(hours=12)])
    assert u[0][0][0] == pytest.approx(0.1), "the NaN corner is dropped and the weights renormalised"
    assert u[0][1][1] is None, "a point exactly on a land cell has no sea value"


def test_points_outside_the_cube_stay_empty():
    u, _ = sample_cube(_cube(), [13.5], [80.1], [T0 + timedelta(hours=12)])
    assert u[0][0][0] is None


class _Grid:
    def __init__(self, name: str, fill: dict[str, float | None], available: bool = True, fail: bool = False):
        self.name, self.agency, self.sovereign = name, name, False
        self.fill, self.available, self.fail = fill, available, fail

    def status(self) -> ProviderStatus:
        return ProviderStatus("metocean", self.name, self.agency, False, self.available, "test")

    def grid(self, bbox, step_deg, start, end, hour_step=1) -> ForcingGrid:
        if self.fail:
            raise RuntimeError("boom")
        lats, lons, times = grid_axes(bbox, step_deg, start, end, hour_step)
        cube = lambda key: [[[self.fill.get(key)] * len(lons) for _ in lats] for _ in times]  # noqa: E731
        return ForcingGrid(lats, lons, times, cube("wind"), cube("wind"), cube("current"), cube("current"), cube("waves"),
                           {"wind": f"{self.name} wind", "current": f"{self.name} current", "waves": f"{self.name} waves"})


def test_merged_provider_keeps_primary_values_and_fills_gaps():
    primary = _Grid("openmeteo", {"wind": 5.0, "current": None})
    fallback = _Grid("cmems", {"wind": 99.0, "current": 0.3})
    grid = MergedMetOcean([primary, fallback]).grid(BBox(80, 12.5, 80.5, 13), 0.25, T0, T0 + timedelta(hours=2))
    assert grid.wind_u[0][0][0] == 5.0, "primary wins where it has data"
    assert grid.current_u[1][2][1] == 0.3
    assert "gap cells filled from cmems current" in grid.sources["current"]
    assert "filled" not in grid.sources["wind"]


def test_failed_fallback_is_recorded_and_primary_data_kept():
    primary = _Grid("openmeteo", {"wind": 5.0})
    grid = MergedMetOcean([primary, _Grid("cmems", {}, fail=True)]).grid(BBox(80, 12.5, 80.5, 13), 0.25, T0, T0 + timedelta(hours=1))
    assert grid.wind_u[0][0][0] == 5.0
    assert "cmems failed: boom" in grid.sources["current"]


def test_registry_builds_merged_metocean_and_cmems_needs_credentials(tmp_path, reference):
    land, corridors, _ = reference
    settings = Settings(cache_dir=tmp_path, output_dir=tmp_path, metocean_providers=["openmeteo", "cmems"])
    from conftest import FakeHttp

    providers = Providers.from_settings(settings, FakeHttp(), land, corridors)
    assert isinstance(providers.metocean, MergedMetOcean)
    assert not CmemsCurrents(settings, FakeHttp()).status().available
