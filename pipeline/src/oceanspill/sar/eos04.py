"""Reader for ISRO EOS-04 (RISAT-1A) L2B analysis-ready products from Bhoonidhi.

The product is a CEOS-ARD normalised radar backscatter package: map-projected (UTM) GeoTIFF
magnitude per polarisation in scene_<POL>/imagery_<POL>.tif, noise already removed and
radiometric terrain correction applied, a per-pixel data mask, and product.xml / BAND_META.txt
metadata that give the DN to dB conversion (10*log10(DN^2) - K).
"""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MASK_VALID_BIT = 128
POLARISATION_PREFERENCE = ("VV", "HH", "VH", "HV")


def _tifffile():
    try:
        import tifffile
    except ImportError as exc:  # pragma: no cover - optional extra
        raise RuntimeError("reading EOS-04 rasters needs the 'sar' extra: uv sync --extra sar") from exc
    return tifffile


@dataclass
class Eos04Product:
    path: Path
    names: list[str]

    @classmethod
    def open(cls, path: Path) -> "Eos04Product":
        if path.is_dir():
            names = [str(p.relative_to(path)) for p in path.rglob("*") if p.is_file()]
        elif zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as zf:
                names = zf.namelist()
        else:
            raise ValueError(f"{path} is neither a directory nor a zip archive")
        return cls(path, names)

    @staticmethod
    def detect(path: Path) -> bool:
        try:
            names = Eos04Product.open(path).names
        except ValueError:
            return False
        return any(n.endswith("BAND_META.txt") for n in names) and any(re.search(r"scene_[A-Z]{2}/imagery_[A-Z]{2}\.tif$", n) for n in names)

    def _find(self, pattern: str) -> str | None:
        return next((n for n in self.names if re.search(pattern, n)), None)

    def read_bytes(self, name: str) -> bytes:
        if self.path.is_dir():
            return (self.path / name).read_bytes()
        with zipfile.ZipFile(self.path) as zf:
            return zf.read(name)

    def read_text(self, name: str) -> str:
        return self.read_bytes(name).decode("utf-8", errors="replace")

    def band_meta(self) -> dict[str, str]:
        name = self._find(r"BAND_META\.txt$")
        if not name:
            raise ValueError("BAND_META.txt not found")
        meta = {}
        for line in self.read_text(name).splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                meta[key.strip()] = value.strip()
        return meta

    def product_xml(self) -> str:
        name = self._find(r"(^|/)product\.xml$")
        return self.read_text(name) if name else ""

    def polarisations(self) -> list[str]:
        found = {m.group(1) for n in self.names if (m := re.search(r"scene_([A-Z]{2})/imagery_\1\.tif$", n))}
        return [p for p in POLARISATION_PREFERENCE if p in found] + sorted(found - set(POLARISATION_PREFERENCE))

    def conversion_constant_db(self, pol: str) -> tuple[float, str]:
        """K in dB = 10*log10(DN^2) - K, and the backscatter measurement it yields."""
        xml = self.product_xml()
        measurement = (re.search(r"<BackscatterMeasurement>([^<]+)</BackscatterMeasurement>", xml) or [None, "unknown"])[1]
        eq = re.search(r"<BackscatterConversionEq[^>]*>\s*10\*log10\(DN\^2\)\s*-\s*([0-9.]+)", xml)
        if eq:
            return float(eq.group(1)), measurement.strip()
        meta = self.band_meta()
        for key in (f"Calibration_Constant_Beta0_{pol}", f"Calibration_Constant_{pol}"):
            if key in meta:
                return float(meta[key]), measurement.strip()
        raise ValueError("no DN to backscatter conversion found in product metadata")

    def read_raster(self, name: str) -> tuple[np.ndarray, dict]:
        tifffile = _tifffile()
        with tifffile.TiffFile(io.BytesIO(self.read_bytes(name))) as tif:
            page = tif.pages[0]
            tags = {k: page.tags[k].value for k in ("ModelPixelScaleTag", "ModelTiepointTag", "GeoKeyDirectoryTag") if k in page.tags}
            return page.asarray(), tags

    def image_member(self, pol: str) -> str:
        name = self._find(rf"scene_{pol}/imagery_{pol}\.tif$")
        if not name:
            raise ValueError(f"no {pol} imagery in product")
        return name

    def mask_member(self) -> str | None:
        return self._find(r"_mask\.tif$")


def utm_zone(tags: dict, meta: dict[str, str]) -> tuple[int, bool]:
    keys = tags.get("GeoKeyDirectoryTag")
    if keys:
        entries = list(keys)
        for i in range(4, len(entries), 4):
            if entries[i] == 3072:  # ProjectedCSTypeGeoKey
                code = int(entries[i + 3])
                if 32601 <= code <= 32660:
                    return code - 32600, True
                if 32701 <= code <= 32760:
                    return code - 32700, False
    if "ZoneNo" in meta:
        return int(float(meta["ZoneNo"])), float(meta.get("SceneCenterLat", 1)) >= 0
    raise ValueError("cannot determine the UTM zone of the product")


def block_mean_masked(values: np.ndarray, valid: np.ndarray, factor: int, min_fraction: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    h, w = values.shape
    oh, ow = h // factor, w // factor
    v = np.where(valid, values, 0.0)[: oh * factor, : ow * factor].reshape(oh, factor, ow, factor)
    n = valid[: oh * factor, : ow * factor].reshape(oh, factor, ow, factor).sum(axis=(1, 3))
    total = v.sum(axis=(1, 3))
    ok = n >= min_fraction * factor * factor
    mean = np.where(ok, total / np.maximum(n, 1), 0.0)
    return mean.astype(np.float32), ok
