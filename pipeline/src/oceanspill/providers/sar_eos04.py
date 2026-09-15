from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import Settings
from ..geo import iso, parse_time
from ..http import CachedHttp, HttpError
from .base import BBox, ProviderStatus, SarScene

BASE_URL = "https://bhoonidhi-api.nrsc.gov.in"
COLLECTIONS = ("EOS-04_SAR-MRS_L2B", "EOS-04_SAR-CRS_L2A", "EOS-04_SAR-MRS_L2A")
_ID_DATE = re.compile(r"_(\d{2}[A-Z]{3}\d{4})_")


def _scene_time(feature: dict[str, Any]) -> datetime:
    props = feature.get("properties", {})
    for key in ("datetime", "start_datetime", "DateOfPass", "acquisitionDate"):
        if props.get(key):
            try:
                return parse_time(str(props[key]))
            except ValueError:
                pass
    m = _ID_DATE.search(feature["id"])
    if m:
        return datetime.strptime(m.group(1), "%d%b%Y").replace(tzinfo=timezone.utc)
    raise ValueError(f"no acquisition time for {feature['id']}")


def parse_features(payload: dict[str, Any]) -> list[SarScene]:
    scenes: list[SarScene] = []
    for f in payload.get("features", []):
        props = f.get("properties", {})
        when = _scene_time(f)
        geom = f.get("geometry") or {}
        ring = geom.get("coordinates", [[]])[0] if geom.get("type") == "Polygon" else []
        collection = f.get("collection", "")
        mode = collection.split("SAR-")[1].split("_")[0] if "SAR-" in collection else ""
        scenes.append(
            SarScene(
                id=f["id"],
                name=f["id"],
                platform="EOS-04",
                mode=mode,
                product_type=collection.rsplit("_", 1)[-1],
                collection=collection,
                start=when,
                end=parse_time(props["end_datetime"]) if props.get("end_datetime") else when,
                footprint=ring,
                orbit_direction=props.get("OrbitDirection") or props.get("sat:orbit_state"),
                online=str(props.get("Online", "")).upper() == "Y",
                provider="bhoonidhi",
                extra={k: v for k, v in props.items() if isinstance(v, (str, int, float, bool))},
            )
        )
    return scenes


class Eos04Bhoonidhi:
    """ISRO EOS-04 (RISAT-1A) SAR via the NRSC Bhoonidhi API. MRS/CRS products are Open Data."""

    name = "eos04"
    agency = "ISRO / NRSC Bhoonidhi"
    sovereign = True

    def __init__(self, settings: Settings, http: CachedHttp):
        self.settings = settings
        self.http = http
        self._access: tuple[str, float] | None = None
        self._refresh: str | None = None

    def status(self) -> ProviderStatus:
        ok = bool(self.settings.bhoonidhi_user_id and self.settings.bhoonidhi_password)
        msg = "Credentials configured" if ok else "Set BHOONIDHI_USER_ID/BHOONIDHI_PASSWORD (search and download need login)"
        return ProviderStatus("sar", self.name, self.agency, self.sovereign, ok, msg)

    def _token(self) -> str:
        if self._access and self._access[1] > time.time() + 30:
            return self._access[0]
        if not (self.settings.bhoonidhi_user_id and self.settings.bhoonidhi_password):
            raise RuntimeError("Bhoonidhi credentials missing: set BHOONIDHI_USER_ID and BHOONIDHI_PASSWORD")
        body = (
            {"grant_type": "refresh_token", "refresh_token": self._refresh}
            if self._refresh
            else {"userId": self.settings.bhoonidhi_user_id, "password": self.settings.bhoonidhi_password, "grant_type": "password"}
        )
        payload = self.http.request_json("POST", f"{BASE_URL}/auth/token", json_body=body, cache=False)
        self._access = (payload["access_token"], time.time() + float(payload.get("expires_in", 900)))
        self._refresh = payload.get("refresh_token")
        return self._access[0]

    def search(self, bbox: BBox, start: datetime, end: datetime) -> list[SarScene]:
        headers = {"Authorization": f"Bearer {self._token()}"}
        body = {
            "collections": list(COLLECTIONS),
            "bbox": [bbox.west, bbox.south, bbox.east, bbox.north],
            "datetime": f"{iso(start)}/{iso(end)}",
            "limit": 500,
        }
        try:
            payload = self.http.request_json("POST", f"{BASE_URL}/data/search", json_body=body, headers=headers)
        except HttpError as exc:
            # Bhoonidhi answers an empty search with HTTP 404 "NO RESULTS FOUND" (e.g. before EOS-04 launched).
            if exc.status == 404 and "NO RESULTS" in str(exc).upper():
                return []
            raise
        scenes = parse_features(payload)
        next_link = next((l["href"] for l in payload.get("links", []) if l.get("rel") == "next"), None)
        while next_link:
            page = self.http.request_json("GET", next_link, headers=headers)
            scenes.extend(parse_features(page))
            next_link = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)
        return scenes

    def list_products(self, collection: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        """Catalogue entries of any Bhoonidhi collection (no spatial filter), e.g. EOS-06 scatterometer winds."""
        headers = {"Authorization": f"Bearer {self._token()}"}
        body = {"collections": [collection], "datetime": f"{iso(start)}/{iso(end)}", "limit": 500}
        try:
            payload = self.http.request_json("POST", f"{BASE_URL}/data/search", json_body=body, headers=headers)
        except HttpError as exc:
            if exc.status == 404 and "NO RESULTS" in str(exc).upper():
                return []
            raise
        return [
            {"id": f["id"], "collection": collection, "date": (f.get("properties") or {}).get("datetime"),
             "online": str((f.get("properties") or {}).get("Online", "")).upper() == "Y"}
            for f in payload.get("features", [])
        ]

    def download(self, scene: SarScene, dest_dir: Path) -> Path:
        if not scene.online:
            raise RuntimeError(f"{scene.id} is not online on Bhoonidhi; request delayed delivery via the portal")
        dest = dest_dir / f"{scene.id}.zip"
        if dest.exists():
            return dest
        return self.http.download(
            f"{BASE_URL}/download",
            dest,
            headers={"Authorization": f"Bearer {self._token()}"},
            params={"id": scene.id, "collection": scene.collection},
        )
