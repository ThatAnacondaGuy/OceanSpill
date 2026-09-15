from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol


@dataclass(frozen=True)
class BBox:
    west: float
    south: float
    east: float
    north: float

    def ring(self) -> list[list[float]]:
        return [
            [self.west, self.south], [self.east, self.south], [self.east, self.north],
            [self.west, self.north], [self.west, self.south],
        ]


@dataclass
class ProviderStatus:
    kind: str
    name: str
    agency: str
    sovereign: bool
    available: bool
    message: str


@dataclass
class SarScene:
    id: str
    name: str
    platform: str
    mode: str
    product_type: str
    collection: str
    start: datetime
    end: datetime
    footprint: list[list[float]]
    orbit_direction: str | None
    online: bool
    provider: str
    size_bytes: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ForcingGrid:
    lats: list[float]
    lons: list[float]
    times: list[datetime]
    wind_u: list[list[list[float | None]]]
    wind_v: list[list[list[float | None]]]
    current_u: list[list[list[float | None]]]
    current_v: list[list[list[float | None]]]
    wave_hs: list[list[list[float | None]]]
    sources: dict[str, str]


@dataclass
class Ping:
    t: datetime
    lat: float
    lon: float
    sog: float
    cog: float
    heading: float
    nav_status: int


@dataclass
class VesselRecord:
    key: str
    name: str
    type: str
    role: str
    provenance: str
    mmsi: str | None = None
    imo: str | None = None
    flag: str | None = None
    operator: str | None = None
    is_facility: bool = False
    registry: dict[str, Any] = field(default_factory=dict)
    anchors: list[dict[str, Any]] = field(default_factory=list)
    note: str | None = None


@dataclass
class Track:
    key: str
    pings: list[Ping]
    provenance: str
    notes: list[str] = field(default_factory=list)


@dataclass
class SanctionsCheck:
    key: str
    name: str
    imo: str | None
    listed: bool
    list_name: str
    reference: str | None
    checked_at: datetime


class Provider(Protocol):
    name: str
    agency: str
    sovereign: bool

    def status(self) -> ProviderStatus: ...


class SarCatalog(Provider, Protocol):
    def search(self, bbox: BBox, start: datetime, end: datetime) -> list[SarScene]: ...

    def download(self, scene: SarScene, dest_dir: Path) -> Path: ...


class MetOceanSource(Provider, Protocol):
    def grid(self, bbox: BBox, step_deg: float, start: datetime, end: datetime, hour_step: int = 1) -> ForcingGrid: ...


class AisSource(Provider, Protocol):
    def tracks(
        self, case: dict[str, Any], start: datetime, end: datetime
    ) -> tuple[list[VesselRecord], list[Track]]: ...


class SanctionsSource(Provider, Protocol):
    def check(self, vessels: list[VesselRecord]) -> list[SanctionsCheck]: ...
