"""Sentinel-2 optical scenes over an incident, from the Copernicus Data Space.

The problem statement asks for radar *and* optical. They fail in different ways, which is the point:
radar sees a slick as a dark patch and cannot tell oil from a patch of calm water, while an optical
sensor sees colour and cannot see through cloud at all. Where both are available and agree, the
detection is far harder to argue with.

Cloud is the deciding factor for optical, so the search reports it and the caller picks. In Indian
waters that means the pre-monsoon and post-monsoon cases have usable scenes and the monsoon ones do
not — which the catalogue will say plainly rather than being discovered after a download.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import Settings
from ..http import CachedHttp
from .base import BBox, ProviderStatus
from .sar_sentinel1 import CATALOGUE_URL, DOWNLOAD_URL, TOKEN_URL, _ring_from_geojson

PRODUCT_TYPE = "S2MSI2A"  # surface reflectance, atmospherically corrected
# Above this, a scene is cloud rather than sea and there is nothing to detect.
USABLE_CLOUD_PERCENT = 40.0


@dataclass
class OpticalScene:
    id: str
    name: str
    platform: str
    product_type: str
    start: datetime
    footprint: list[list[float]]
    cloud_percent: float | None
    size_bytes: int | None
    provider: str = "cdse-s2"

    @property
    def usable(self) -> bool:
        return self.cloud_percent is not None and self.cloud_percent < USABLE_CLOUD_PERCENT


def _attribute(product: dict[str, Any], name: str) -> Any:
    for attribute in product.get("Attributes", []):
        if attribute.get("Name") == name:
            return attribute.get("Value")
    return None


def parse_products(payload: dict[str, Any]) -> list[OpticalScene]:
    scenes = []
    for product in payload.get("value", []):
        footprint = product.get("GeoFootprint") or {}
        cloud = _attribute(product, "cloudCover")
        scenes.append(OpticalScene(
            id=product["Id"],
            name=product["Name"],
            platform=str(_attribute(product, "platformShortName") or "SENTINEL-2"),
            product_type=str(_attribute(product, "productType") or PRODUCT_TYPE),
            start=datetime.fromisoformat(product["ContentDate"]["Start"].replace("Z", "+00:00")),
            footprint=_ring_from_geojson(footprint) if footprint else [],
            cloud_percent=float(cloud) if cloud is not None else None,
            size_bytes=int(product["ContentLength"]) if product.get("ContentLength") else None,
        ))
    return sorted(scenes, key=lambda s: s.start)


class Sentinel2Cdse:
    """Optical scenes from the same Copernicus account the radar search uses."""

    name = "sentinel2"
    agency = "ESA Copernicus Data Space Ecosystem"
    sovereign = False

    def __init__(self, settings: Settings, http: CachedHttp):
        self.settings = settings
        self.http = http
        self._token: tuple[str, float] | None = None

    def status(self) -> ProviderStatus:
        configured = bool(self.settings.cdse_username and self.settings.cdse_password)
        return ProviderStatus(
            "eo", self.name, self.agency, self.sovereign, True,
            "Catalogue search public; downloads enabled" if configured else "Catalogue search public; downloads need CDSE credentials",
        )

    def search(self, bbox: BBox, start: datetime, end: datetime, limit: int = 50) -> list[OpticalScene]:
        wkt = "POLYGON((" + ",".join(f"{lon} {lat}" for lon, lat in bbox.ring()) + "))"
        flt = (
            "Collection/Name eq 'SENTINEL-2'"
            f" and OData.CSC.Intersects(area=geography'SRID=4326;{wkt}')"
            f" and ContentDate/Start gt {start.strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
            f" and ContentDate/Start lt {end.strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
            " and Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType'"
            f" and att/OData.CSC.StringAttribute/Value eq '{PRODUCT_TYPE}')"
        )
        params = {"$filter": flt, "$top": str(limit), "$orderby": "ContentDate/Start", "$expand": "Attributes"}
        return parse_products(self.http.request_json("GET", CATALOGUE_URL, params=params, timeout=180))

    def _access_token(self) -> str:
        if self._token and self._token[1] > time.time() + 30:
            return self._token[0]
        if not (self.settings.cdse_username and self.settings.cdse_password):
            raise RuntimeError("CDSE credentials missing: set CDSE_USERNAME and CDSE_PASSWORD")
        payload = self.http.request_json(
            "POST", TOKEN_URL,
            data={"grant_type": "password", "username": self.settings.cdse_username,
                  "password": self.settings.cdse_password, "client_id": "cdse-public"},
            cache=False,
        )
        self._token = (payload["access_token"], time.time() + float(payload.get("expires_in", 600)))
        return self._token[0]

    def download(self, scene: OpticalScene, dest_dir: Path) -> Path:
        """Fetch a scene. A whole Sentinel-2 product is about a gigabyte."""
        dest = dest_dir / f"{scene.name.removesuffix('.SAFE')}.zip"
        if dest.exists():
            return dest
        dest_dir.mkdir(parents=True, exist_ok=True)
        token = self._access_token()
        return self.http.download(DOWNLOAD_URL.format(id=scene.id), dest,
                                  headers={"Authorization": f"Bearer {token}"})


def summarise(scenes: list[OpticalScene], incident: datetime) -> dict[str, Any]:
    """What the catalogue offers for an incident, and whether any of it can be used."""
    usable = [s for s in scenes if s.usable]
    clearest = min((s for s in scenes if s.cloud_percent is not None), key=lambda s: s.cloud_percent, default=None)
    return {
        "scenes": len(scenes),
        "usable": len(usable),
        "cloudThreshold": USABLE_CLOUD_PERCENT,
        "clearest": None if clearest is None else {
            "name": clearest.name,
            "start": clearest.start.isoformat(),
            "cloudPercent": clearest.cloud_percent,
            "hoursFromIncident": round((clearest.start - incident).total_seconds() / 3600, 1),
            "sizeBytes": clearest.size_bytes,
        },
        "note": "Optical sees colour rather than surface roughness, so it fails on cloud where radar "
                "does not. Monsoon-season incidents in Indian waters usually have no usable scene.",
    }
