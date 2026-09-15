from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path

from ..config import Settings
from ..geo import parse_time
from ..http import CachedHttp
from .base import BBox, ProviderStatus, SarScene

CATALOGUE_URL = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"
TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
DOWNLOAD_URL = "https://zipper.dataspace.copernicus.eu/odata/v1/Products({id})/$value"
PRODUCT_TYPES = ("IW_GRDH_1S", "EW_GRDM_1S")


def _ring_from_geojson(geom: dict) -> list[list[float]]:
    if geom["type"] == "Polygon":
        return geom["coordinates"][0]
    if geom["type"] == "MultiPolygon":
        return max((poly[0] for poly in geom["coordinates"]), key=len)
    raise ValueError(f"unsupported footprint geometry {geom['type']}")


def parse_products(payload: dict) -> list[SarScene]:
    scenes: list[SarScene] = []
    for item in payload.get("value", []):
        attrs = {a["Name"]: a.get("Value") for a in item.get("Attributes", [])}
        name: str = item["Name"]
        platform = f"Sentinel-1{attrs.get('platformSerialIdentifier') or name[2]}"
        scenes.append(
            SarScene(
                id=item["Id"],
                name=name,
                platform=platform,
                mode=name.split("_")[1] if "_" in name else "",
                product_type=attrs.get("productType") or "",
                collection="SENTINEL-1",
                start=parse_time(item["ContentDate"]["Start"]),
                end=parse_time(item["ContentDate"]["End"]),
                footprint=_ring_from_geojson(item["GeoFootprint"]),
                orbit_direction=attrs.get("orbitDirection"),
                online=bool(item.get("Online", False)),
                provider="cdse",
                size_bytes=item.get("ContentLength"),
                extra={"s3Path": item.get("S3Path"), "polarisation": attrs.get("polarisationChannels")},
            )
        )
    return scenes


class Sentinel1Cdse:
    """ESA Copernicus Data Space. Catalogue search is public; downloads need a free CDSE account."""

    name = "sentinel1"
    agency = "ESA Copernicus Data Space Ecosystem"
    sovereign = False

    def __init__(self, settings: Settings, http: CachedHttp):
        self.settings = settings
        self.http = http
        self._token: tuple[str, float] | None = None

    def status(self) -> ProviderStatus:
        creds = bool(self.settings.cdse_username and self.settings.cdse_password)
        msg = "Catalogue search public" + ("; downloads enabled" if creds else "; set CDSE_USERNAME/CDSE_PASSWORD to download scenes")
        return ProviderStatus("sar", self.name, self.agency, self.sovereign, True, msg)

    def search(self, bbox: BBox, start: datetime, end: datetime) -> list[SarScene]:
        wkt = "POLYGON((" + ",".join(f"{lon} {lat}" for lon, lat in bbox.ring()) + "))"
        scenes: list[SarScene] = []
        # One query per product type: an `or` inside the attribute any() silently returns nothing.
        for product_type in PRODUCT_TYPES:
            flt = (
                "Collection/Name eq 'SENTINEL-1'"
                f" and OData.CSC.Intersects(area=geography'SRID=4326;{wkt}')"
                f" and ContentDate/Start gt {start.strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
                f" and ContentDate/Start lt {end.strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
                " and Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType'"
                f" and att/OData.CSC.StringAttribute/Value eq '{product_type}')"
            )
            params = {"$filter": flt, "$expand": "Attributes", "$orderby": "ContentDate/Start asc", "$top": 100}
            scenes.extend(parse_products(self.http.request_json("GET", CATALOGUE_URL, params=params)))
        # COG duplicates share acquisition and footprint with the original product.
        scenes = [s for s in scenes if not s.name.endswith("_COG.SAFE")]
        return sorted(scenes, key=lambda s: s.start)

    def _access_token(self) -> str:
        if self._token and self._token[1] > time.time() + 30:
            return self._token[0]
        if not (self.settings.cdse_username and self.settings.cdse_password):
            raise RuntimeError("CDSE credentials missing: set CDSE_USERNAME and CDSE_PASSWORD")
        payload = self.http.request_json(
            "POST",
            TOKEN_URL,
            data={
                "grant_type": "password",
                "username": self.settings.cdse_username,
                "password": self.settings.cdse_password,
                "client_id": "cdse-public",
            },
            cache=False,
        )
        self._token = (payload["access_token"], time.time() + float(payload.get("expires_in", 600)))
        return self._token[0]

    def download(self, scene: SarScene, dest_dir: Path) -> Path:
        dest = dest_dir / f"{scene.name.removesuffix('.SAFE')}.zip"
        if dest.exists():
            return dest
        token = self._access_token()
        return self.http.download(
            DOWNLOAD_URL.format(id=scene.id), dest, headers={"Authorization": f"Bearer {token}"}
        )
