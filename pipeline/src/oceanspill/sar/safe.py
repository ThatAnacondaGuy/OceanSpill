from __future__ import annotations

import re
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class SafeBand:
    polarisation: str
    measurement: str
    annotation: str
    calibration: str
    noise: str | None


@dataclass
class SafeProduct:
    """A Sentinel-1 SAFE product, either a downloaded .zip or an extracted .SAFE directory."""

    path: Path
    names: list[str]

    @classmethod
    def open(cls, path: Path) -> "SafeProduct":
        if path.is_dir():
            names = [str(p.relative_to(path)) for p in path.rglob("*") if p.is_file()]
        elif zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as zf:
                names = zf.namelist()
        else:
            raise ValueError(f"{path} is neither a SAFE directory nor a zip archive")
        return cls(path, names)

    def read_text(self, name: str) -> str:
        if self.path.is_dir():
            return (self.path / name).read_text()
        with zipfile.ZipFile(self.path) as zf:
            return zf.read(name).decode()

    def band(self, preferred: tuple[str, ...] = ("vv", "hh")) -> SafeBand:
        for pol in preferred:
            meas = [n for n in self.names if re.search(rf"measurement/[^/]*-{pol}-[^/]*\.tiff?$", n)]
            if not meas:
                continue
            stem = Path(meas[0]).stem
            ann = next((n for n in self.names if n.endswith(f"annotation/{stem}.xml")), None)
            cal = next((n for n in self.names if n.endswith(f"calibration/calibration-{stem}.xml")), None)
            noise = next((n for n in self.names if n.endswith(f"calibration/noise-{stem}.xml")), None)
            if ann and cal:
                return SafeBand(pol.upper(), meas[0], ann, cal, noise)
        raise ValueError(f"no {'/'.join(p.upper() for p in preferred)} band with annotation and calibration in {self.path.name}")

    def read_measurement(self, band: SafeBand) -> np.ndarray:
        try:
            import tifffile
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise RuntimeError("reading SAR rasters needs the 'sar' extra: uv sync --extra sar") from exc
        if self.path.is_dir():
            return _memmap_or_read(tifffile, self.path / band.measurement)
        # Measurement rasters are stored uncompressed inside the zip; extract once, then memory-map.
        cache = Path(tempfile.gettempdir()) / "oceanspill-safe" / self.path.stem
        target = cache / Path(band.measurement).name
        if not target.exists():
            cache.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(self.path) as zf, zf.open(band.measurement) as src, target.open("wb") as dst:
                while chunk := src.read(1 << 22):
                    dst.write(chunk)
        return _memmap_or_read(tifffile, target)


def _memmap_or_read(tifffile, path: Path) -> np.ndarray:
    try:
        return tifffile.memmap(str(path), mode="r")
    except (ValueError, TypeError):
        return tifffile.imread(str(path))


def pixel_spacing_m(annotation_xml: str) -> float:
    root = ET.fromstring(annotation_xml)
    value = root.findtext(".//imageInformation/rangePixelSpacing") or root.findtext(".//rangePixelSpacing")
    if not value:
        raise ValueError("rangePixelSpacing not found in annotation")
    return float(value)
