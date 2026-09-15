from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np

from ..config import Settings
from ..http import CachedHttp
from .base import BBox, ForcingGrid, ProviderStatus
from .metocean_openmeteo import grid_axes

# Global Ocean Physics Reanalysis GLORYS12V1: daily means at 1/12 degree, 1993 to near present.
REANALYSIS_DATASET = "cmems_mod_glo_phy_my_0.083deg_P1D-m"
PAD_DEG = 0.25
SURFACE_MAX_DEPTH_M = 1.0


@dataclass
class CurrentCube:
    times: list[datetime]  # timestamps of the daily means
    lats: np.ndarray
    lons: np.ndarray
    u: np.ndarray  # [t, y, x] eastward m/s, NaN over land
    v: np.ndarray


def sample_cube(cube: CurrentCube, lats: list[float], lons: list[float], times: list[datetime]) -> tuple[list, list]:
    """Bilinear in space (renormalised over sea cells) and linear in time onto the forcing grid.

    Daily means are placed at noon of their day, the centre of the averaging period.
    """
    centres = np.array([(t + timedelta(hours=12)).timestamp() for t in cube.times])
    tq = np.array([t.timestamp() for t in times])
    ti = np.clip(np.searchsorted(centres, tq, side="right") - 1, 0, max(len(centres) - 2, 0))
    tf = np.clip((tq - centres[ti]) / np.maximum(centres[np.minimum(ti + 1, len(centres) - 1)] - centres[ti], 1), 0, 1)
    outside = (tq < centres[0] - 43200) | (tq > centres[-1] + 43200)

    def axis_weights(axis: np.ndarray, q: list[float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        qa = np.array(q)
        i0 = np.clip(np.searchsorted(axis, qa, side="right") - 1, 0, len(axis) - 2)
        f = np.clip((qa - axis[i0]) / (axis[i0 + 1] - axis[i0]), 0, 1)
        return i0, f, (qa < axis[0]) | (qa > axis[-1])

    yi, yf, y_out = axis_weights(cube.lats, lats)
    xi, xf, x_out = axis_weights(cube.lons, lons)

    def field(arr: np.ndarray) -> list:
        out: list = [[[None] * len(lons) for _ in lats] for _ in times]
        for k in range(len(times)):
            if outside[k]:
                continue
            for a in range(len(lats)):
                if y_out[a]:
                    continue
                for b in range(len(lons)):
                    if x_out[b]:
                        continue
                    total = 0.0
                    weight = 0.0
                    for dt, wt in ((0, 1 - tf[k]), (1, tf[k])):
                        tt = min(ti[k] + dt, len(centres) - 1)
                        for dy, wy in ((0, 1 - yf[a]), (1, yf[a])):
                            for dx, wx in ((0, 1 - xf[b]), (1, xf[b])):
                                w = wt * wy * wx
                                val = arr[tt, yi[a] + dy, xi[b] + dx]
                                if w > 0 and not math.isnan(val):
                                    total += w * val
                                    weight += w
                    if weight > 1e-9:
                        out[k][a][b] = round(total / weight, 3)
        return out

    return field(cube.u), field(cube.v)


class CmemsCurrents:
    """Surface currents from the Copernicus Marine GLORYS12V1 reanalysis.

    Fills the years Open-Meteo's SMOC currents do not cover (before 2022). Daily means do not
    resolve tides or inertial oscillations, which the sources text states. Interim fallback until
    INCOIS HOOFS access is granted.
    """

    name = "cmems"
    agency = "Copernicus Marine Service (GLORYS12V1 reanalysis currents)"
    sovereign = False

    def __init__(self, settings: Settings, http: CachedHttp):
        self.settings = settings
        self.cache_dir = settings.cache_dir / "cmems"

    def status(self) -> ProviderStatus:
        ok = bool(self.settings.cmems_username and self.settings.cmems_password)
        msg = ("Daily-mean surface currents 1993 onwards, 1/12 degree" if ok
               else "Set CMEMS_USERNAME / CMEMS_PASSWORD (free Copernicus Marine account)")
        return ProviderStatus("metocean", self.name, self.agency, self.sovereign, ok, msg)

    def fetch(self, bbox: BBox, start: datetime, end: datetime) -> CurrentCube:
        key = f"{bbox.west:.2f}_{bbox.south:.2f}_{bbox.east:.2f}_{bbox.north:.2f}_{start:%Y%m%d}_{end:%Y%m%d}"
        cached = self.cache_dir / f"{key}.npz"
        if cached.exists():
            data = np.load(cached)
            times = [datetime.fromtimestamp(float(t), timezone.utc) for t in data["times"]]
            return CurrentCube(times, data["lats"], data["lons"], data["u"], data["v"])
        try:
            import copernicusmarine
        except ImportError as exc:  # pragma: no cover - optional extra
            raise RuntimeError("CMEMS currents need the 'cmems' extra: uv sync --extra cmems") from exc
        if not (self.settings.cmems_username and self.settings.cmems_password):
            raise RuntimeError("CMEMS_USERNAME / CMEMS_PASSWORD are not set")
        ds = copernicusmarine.open_dataset(
            dataset_id=REANALYSIS_DATASET, variables=["uo", "vo"],
            minimum_longitude=bbox.west, maximum_longitude=bbox.east,
            minimum_latitude=bbox.south, maximum_latitude=bbox.north,
            start_datetime=start.strftime("%Y-%m-%dT00:00:00"), end_datetime=end.strftime("%Y-%m-%dT23:59:59"),
            minimum_depth=0.0, maximum_depth=SURFACE_MAX_DEPTH_M,
            username=self.settings.cmems_username, password=self.settings.cmems_password,
        )
        u = ds["uo"].isel(depth=0).values.astype(np.float32)
        v = ds["vo"].isel(depth=0).values.astype(np.float32)
        times = [datetime.fromtimestamp(t.astype("datetime64[s]").astype(int), timezone.utc) for t in ds["time"].values]
        cube = CurrentCube(times, ds["latitude"].values.astype(np.float64), ds["longitude"].values.astype(np.float64), u, v)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cached, times=np.array([t.timestamp() for t in times]), lats=cube.lats, lons=cube.lons, u=u, v=v)
        (self.cache_dir / f"{key}.json").write_text(json.dumps({"dataset": REANALYSIS_DATASET, "fetched": datetime.now(timezone.utc).isoformat()}))
        return cube

    def grid(self, bbox: BBox, step_deg: float, start: datetime, end: datetime, hour_step: int = 1) -> ForcingGrid:
        lats, lons, times = grid_axes(bbox, step_deg, start, end, hour_step)
        padded = BBox(bbox.west - PAD_DEG, bbox.south - PAD_DEG, bbox.east + PAD_DEG, bbox.north + PAD_DEG)
        cube = self.fetch(padded, start - timedelta(days=1), end + timedelta(days=1))
        cu, cv = sample_cube(cube, lats, lons, times)
        empty = lambda: [[[None] * len(lons) for _ in lats] for _ in times]  # noqa: E731
        sources = {
            "wind": "unavailable (currents-only provider)",
            "current": f"GLORYS12V1 daily-mean reanalysis via Copernicus Marine ({REANALYSIS_DATASET}); no tides",
            "waves": "unavailable",
        }
        return ForcingGrid(lats, lons, times, empty(), empty(), cu, cv, empty(), sources)

