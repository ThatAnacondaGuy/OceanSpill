"""Open-Meteo forecast winds, currents and waves for the days ahead.

Same request shape as the archive provider, pointed at the forecast endpoints, so a forward drift
run uses exactly the same grid format as a hindcast. Still a foreign fallback: INCOIS currents and
IMD/MOSDAC winds replace this as soon as access is granted.
"""
from __future__ import annotations

from .base import ProviderStatus
from .metocean_openmeteo import FORECAST_URL, OpenMeteo

# Open-Meteo publishes 16 days of forecast; the marine API matches it.
MAX_FORECAST_DAYS = 16


class OpenMeteoForecast(OpenMeteo):
    name = "openmeteo-forecast"
    agency = "Open-Meteo forecast (ICON/GFS wind, Météo-France SMOC currents, waves)"
    wind_url = FORECAST_URL

    def status(self) -> ProviderStatus:
        return ProviderStatus("metocean", self.name, self.agency, self.sovereign, True,
                              f"Public API, no key required; up to {MAX_FORECAST_DAYS} days ahead")
