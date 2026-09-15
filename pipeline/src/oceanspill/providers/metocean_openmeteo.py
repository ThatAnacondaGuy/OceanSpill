from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from ..config import Settings
from ..http import CachedHttp
from .base import BBox, ForcingGrid, ProviderStatus

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
CHUNK = 50
CURRENTS_START = datetime(2022, 1, 1, tzinfo=timezone.utc)


def axis(lo: float, hi: float, step: float) -> list[float]:
    n = int(math.floor((hi - lo) / step + 1e-9)) + 1
    return [round(lo + i * step, 4) for i in range(n)]


def grid_axes(bbox: BBox, step_deg: float, start: datetime, end: datetime, hour_step: int) -> tuple[list[float], list[float], list[datetime]]:
    """Forcing grid shared by every metocean provider, so grids from different sources line up cell for cell."""
    lats = axis(bbox.south, bbox.north, step_deg)
    lons = axis(bbox.west, bbox.east, step_deg)
    start = start.replace(minute=0, second=0, microsecond=0)
    n_hours = int((end - start).total_seconds() // 3600) + 1
    return lats, lons, [start + timedelta(hours=h) for h in range(0, n_hours, hour_step)]


def wind_components(speed: float | None, from_deg: float | None) -> tuple[float | None, float | None]:
    """Meteorological convention: direction is where the wind blows FROM."""
    if speed is None or from_deg is None:
        return None, None
    r = math.radians(from_deg)
    return round(-speed * math.sin(r), 3), round(-speed * math.cos(r), 3)


def current_components(speed: float | None, to_deg: float | None) -> tuple[float | None, float | None]:
    """Oceanographic convention used by Open-Meteo: direction the current flows TOWARDS."""
    if speed is None or to_deg is None:
        return None, None
    r = math.radians(to_deg)
    return round(speed * math.sin(r), 3), round(speed * math.cos(r), 3)


class OpenMeteo:
    """ERA5 reanalysis wind and Météo-France SMOC currents via Open-Meteo. No account needed.

    Interim fallback until INCOIS (currents) and MOSDAC/IMD (wind) access is granted.
    SMOC currents only exist from January 2022; earlier cases get wind only.
    """

    name = "openmeteo"
    agency = "Open-Meteo (ERA5 wind, Météo-France SMOC currents)"
    sovereign = False
    # The archive API answers for past dates; the forecast subclass points the same code at future ones.
    wind_url = ARCHIVE_URL

    def __init__(self, settings: Settings, http: CachedHttp):
        self.settings = settings
        self.http = http

    def status(self) -> ProviderStatus:
        return ProviderStatus("metocean", self.name, self.agency, self.sovereign, True, "Public API, no key required")

    def _fetch(self, url: str, points: list[tuple[float, float]], start: datetime, end: datetime, hourly: str) -> list[dict]:
        out: list[dict] = []
        for i in range(0, len(points), CHUNK):
            chunk = points[i : i + CHUNK]
            params = {
                "latitude": ",".join(f"{p[0]:.4f}" for p in chunk),
                "longitude": ",".join(f"{p[1]:.4f}" for p in chunk),
                "start_date": start.strftime("%Y-%m-%d"),
                "end_date": end.strftime("%Y-%m-%d"),
                "hourly": hourly,
                "wind_speed_unit": "ms",
                "timezone": "GMT",
            }
            if url == MARINE_URL:
                params["cell_selection"] = "sea"
            payload = self.http.request_json("GET", url, params=params, timeout=120)
            out.extend(payload if isinstance(payload, list) else [payload])
        return out

    def grid(self, bbox: BBox, step_deg: float, start: datetime, end: datetime, hour_step: int = 1) -> ForcingGrid:
        lats, lons, times = grid_axes(bbox, step_deg, start, end, hour_step)
        start = times[0]
        points = [(lat, lon) for lat in lats for lon in lons]

        wind = self._fetch(self.wind_url, points, start, end, "wind_speed_10m,wind_direction_10m")
        want_currents = end >= CURRENTS_START
        marine = (
            self._fetch(MARINE_URL, points, start, end, "ocean_current_velocity,ocean_current_direction,wave_height")
            if want_currents
            else []
        )

        def index_by_time(block: dict) -> dict[str, int]:
            return {t: i for i, t in enumerate(block["hourly"]["time"])}

        shape = lambda: [[[None] * len(lons) for _ in lats] for _ in times]  # noqa: E731
        wu, wv, cu, cv, hs = shape(), shape(), shape(), shape(), shape()
        for p_idx in range(len(points)):
            yi, xi = divmod(p_idx, len(lons))
            wb = wind[p_idx]
            widx = index_by_time(wb)
            mb = marine[p_idx] if marine else None
            midx = index_by_time(mb) if mb else {}
            for ti, t in enumerate(times):
                key = t.strftime("%Y-%m-%dT%H:%M")
                j = widx.get(key)
                if j is not None:
                    wu[ti][yi][xi], wv[ti][yi][xi] = wind_components(
                        wb["hourly"]["wind_speed_10m"][j], wb["hourly"]["wind_direction_10m"][j]
                    )
                k = midx.get(key)
                if mb and k is not None:
                    cu[ti][yi][xi], cv[ti][yi][xi] = current_components(
                        mb["hourly"]["ocean_current_velocity"][k], mb["hourly"]["ocean_current_direction"][k]
                    )
                    hs[ti][yi][xi] = mb["hourly"]["wave_height"][k]

        sources = {
            "wind": "ERA5 reanalysis via Open-Meteo archive API",
            "current": "Météo-France SMOC via Open-Meteo marine API" if want_currents else "unavailable before 2022 (needs INCOIS or CMEMS reanalysis)",
            "waves": "Open-Meteo marine API" if want_currents else "unavailable",
        }
        return ForcingGrid(lats, lons, times, wu, wv, cu, cv, hs, sources)
