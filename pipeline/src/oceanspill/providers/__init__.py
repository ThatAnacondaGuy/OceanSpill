from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..config import Settings
from ..http import CachedHttp
from .ais_gfw import GfwAis
from .ais_synthetic import SyntheticAis
from .base import AisSource, MetOceanSource, ProviderStatus, SanctionsSource, SarCatalog
from .metocean_cmems import CmemsCurrents
from .metocean_merged import MergedMetOcean
from .metocean_forecast import OpenMeteoForecast
from .metocean_openmeteo import OpenMeteo
from .sanctions_unsc import UnscSanctions
from .sar_eos04 import Eos04Bhoonidhi
from .eo_sentinel2 import Sentinel2Cdse
from .sar_sentinel1 import Sentinel1Cdse

SAR = {"eos04": Eos04Bhoonidhi, "sentinel1": Sentinel1Cdse}
# Optical, which sees colour where radar sees roughness, and is stopped by cloud where radar is not.
EO = {"sentinel2": Sentinel2Cdse}
METOCEAN = {"openmeteo": OpenMeteo, "openmeteo-forecast": OpenMeteoForecast, "cmems": CmemsCurrents}
AIS = {"synthetic": SyntheticAis, "gfw": GfwAis}
SANCTIONS = {"unsc": UnscSanctions}

# Integrations the configuration recognises but that need access the project does not have yet.
PENDING_ACCESS = {
    "sar": {"nisar": "NISAR S-SAR via Bhoonidhi (collections NISAR_SSAR_*); only covers events after June 2026"},
    "metocean": {
        "incois": "INCOIS HOOFS currents: needs INCOIS data portal access and API details",
        "mosdac": "MOSDAC Oceansat-3 scatterometer winds: needs MOSDAC account",
        "imd": "IMD / NCMRWF wind grids: needs data access agreement",
    },
    "ais": {"dgll": "DGLL National AIS Network: needs government access"},
    "sanctions": {"mea": "MEA / DG Shipping watchlists: needs government access"},
}


class ProviderConfigError(ValueError):
    pass


def _resolve(kind: str, name: str, table: dict[str, Any]) -> Any:
    if name in table:
        return table[name]
    if name in PENDING_ACCESS.get(kind, {}):
        raise ProviderConfigError(f"{kind} provider '{name}' is not integrated yet: {PENDING_ACCESS[kind][name]}")
    raise ProviderConfigError(f"unknown {kind} provider '{name}' (available: {', '.join(table)})")


@dataclass
class Providers:
    sar: list[SarCatalog]
    metocean: MetOceanSource | MergedMetOcean
    ais: AisSource
    sanctions: SanctionsSource

    @classmethod
    def from_settings(
        cls, settings: Settings, http: CachedHttp, land: dict[str, Any], corridors: list[dict[str, Any]]
    ) -> "Providers":
        sar = [_resolve("sar", n, SAR)(settings, http) for n in settings.sar_providers]
        metocean_list = [_resolve("metocean", n, METOCEAN)(settings, http) for n in settings.metocean_providers]
        metocean = metocean_list[0] if len(metocean_list) == 1 else MergedMetOcean(metocean_list)
        ais_cls = _resolve("ais", settings.ais_provider, AIS)
        if ais_cls is GfwAis:
            if not settings.gfw_api_token:
                raise ProviderConfigError("AIS_PROVIDER=gfw needs GFW_API_TOKEN")
            ais = GfwAis(settings, http, SyntheticAis(settings, http, land, corridors))
        else:
            ais = SyntheticAis(settings, http, land, corridors)
        sanctions = _resolve("sanctions", settings.sanctions_provider, SANCTIONS)(settings, http)
        return cls(sar, metocean, ais, sanctions)

    def statuses(self) -> list[ProviderStatus]:
        return [*(p.status() for p in self.sar), self.metocean.status(), self.ais.status(), self.sanctions.status()]
