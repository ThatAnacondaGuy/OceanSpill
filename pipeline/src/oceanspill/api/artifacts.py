"""Read the pipeline's case artifacts and prepare them for a particular viewer.

The API returns the same JSON the static web app reads, so pages do not change between modes.
For Restricted clearance, vessel identifiers are withheld and SAR quicklook paths removed.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
from functools import lru_cache
from pathlib import Path

WITHHELD = None


class ArtifactStore:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir

    def _read(self, rel: str) -> dict:
        path = (self.data_dir / rel).resolve()
        if not str(path).startswith(str(self.data_dir.resolve())) or not path.is_file():
            raise FileNotFoundError(rel)
        return _load(str(path), path.stat().st_mtime_ns)

    def index(self) -> dict:
        return self._read("index.json")

    def case_ids(self) -> list[str]:
        return [c["id"] for c in self.index()["cases"]]

    def case(self, case_id: str) -> dict:
        entry = next((c for c in self.index()["cases"] if c["id"] == case_id), None)
        if entry is None:
            raise FileNotFoundError(case_id)
        return self._read(entry["file"])

    def file(self, rel: str) -> dict:
        return self._read(rel)

    def etag(self, rel: str) -> str:
        path = self.data_dir / rel
        return f'"{path.stat().st_mtime_ns:x}-{path.stat().st_size:x}"'


@lru_cache(maxsize=64)
def _load(path: str, _mtime: int) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def redact_case(artifact: dict, secret: str) -> dict:
    """Copy of a case artifact with MMSI / IMO numbers and SAR imagery links removed.

    Vessel keys embed the MMSI, so they are replaced by stable pseudonyms (HMAC of the key) applied
    consistently to vessels, tracks and sanctions checks; relationships inside the case still hold.
    """
    out = copy.deepcopy(artifact)

    def alias(key: str) -> str:
        if not key.startswith("MMSI-"):
            return key
        return "V-" + hmac.new(secret.encode(), key.encode(), hashlib.sha256).hexdigest()[:12]

    for v in out.get("vessels", []):
        if v.get("isFacility"):
            continue
        v["key"] = alias(v["key"])
        v["mmsi"] = WITHHELD
        v["imo"] = WITHHELD
        if isinstance(v.get("registry"), dict):
            v["registry"]["details"] = None
    for t in out.get("tracks", []):
        t["key"] = alias(t["key"])
    for c in out.get("sanctions", []):
        c["key"] = alias(c.get("key", ""))
        c["imo"] = WITHHELD
    for v in out.get("case", {}).get("vessels", []):
        v["imo"] = WITHHELD
        v["mmsi"] = WITHHELD
    for m in out.get("sarMeasurements") or []:
        m["quicklook"] = None
    out["redacted"] = True
    return out
