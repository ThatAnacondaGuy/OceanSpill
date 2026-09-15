from __future__ import annotations

from datetime import datetime

from .base import BBox, ForcingGrid, MetOceanSource, ProviderStatus

FIELDS = (("wind", ("wind_u", "wind_v")), ("current", ("current_u", "current_v")), ("waves", ("wave_hs",)))


def _filled(grid: ForcingGrid, attrs: tuple[str, ...]) -> int:
    first = getattr(grid, attrs[0])
    return sum(1 for plane in first for row in plane for v in row if v is not None)


class MergedMetOcean:
    """Several metocean providers on the same grid, first provider wins cell by cell.

    Used to keep Open-Meteo ERA5 wind and SMOC currents where they exist while filling the gaps
    (for example currents before 2022) from a reanalysis such as CMEMS GLORYS12. A provider that
    fails is recorded in the sources text instead of aborting the build.
    """

    sovereign = False

    def __init__(self, providers: list[MetOceanSource]):
        if not providers:
            raise ValueError("at least one metocean provider is required")
        self.providers = providers
        self.name = "+".join(p.name for p in providers)
        self.agency = " + ".join(p.agency for p in providers)
        self.sovereign = all(p.sovereign for p in providers)

    def status(self) -> ProviderStatus:
        statuses = [p.status() for p in self.providers]
        return ProviderStatus(
            "metocean", self.name, self.agency, self.sovereign, statuses[0].available,
            "; ".join(f"{s.name}: {s.message}" for s in statuses),
        )

    def grid(self, bbox: BBox, step_deg: float, start: datetime, end: datetime, hour_step: int = 1) -> ForcingGrid:
        base = self.providers[0].grid(bbox, step_deg, start, end, hour_step)
        notes: dict[str, list[str]] = {name: [] for name, _ in FIELDS}
        for provider in self.providers[1:]:
            if not provider.status().available:
                continue
            try:
                extra = provider.grid(bbox, step_deg, start, end, hour_step)
            except Exception as exc:  # a fallback failing must not lose the primary data
                for name, _ in FIELDS:
                    notes[name].append(f"{provider.name} failed: {exc}")
                continue
            if (extra.lats, extra.lons, extra.times) != (base.lats, base.lons, base.times):
                raise ValueError(f"{provider.name} returned a different grid than {self.providers[0].name}")
            for name, attrs in FIELDS:
                before = _filled(base, attrs)
                for attr in attrs:
                    dst, src = getattr(base, attr), getattr(extra, attr)
                    for t, plane in enumerate(dst):
                        for y, row in enumerate(plane):
                            for x, value in enumerate(row):
                                if value is None and src[t][y][x] is not None:
                                    row[x] = src[t][y][x]
                added = _filled(base, attrs) - before
                if added:
                    notes[name].append(f"{added} gap cells filled from {extra.sources.get(name, provider.name)}")
        for name, _ in FIELDS:
            if notes[name]:
                base.sources[name] = f"{base.sources.get(name, '')}; " + "; ".join(notes[name])
        return base
