from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from ..geo import haversine_km, iso
from .calibration import parse_calibration, parse_noise, sigma0
from .darkspot import detect_dark_spots
from .filters import dilate, lee_filter, multilook_power, to_db
from .geolocation import interpolate_grid, latlon, parse_geolocation
from .landmask import PolygonLand, RingLand
from .quicklook import write_quicklook
from .safe import SafeProduct, pixel_spacing_m

METHOD = "Adaptive-threshold dark-spot detection on Lee-filtered, noise-corrected sigma0 (classical method, not a trained model)"
LIMITATIONS = [
    "Dark spots include look-alikes (low wind, biogenic films, rain cells); the look-alike checks must still be applied",
    "Land is masked with a coastline plus a coastal buffer; detections within a few km of shore remain unreliable",
    "Multilooking trades resolution for speckle reduction; slicks narrower than two output pixels can be missed",
    "The quicklook is in radar geometry (not north-up); use the outlines on the map for location",
]


def bilinear(arr: np.ndarray, r: float, c: float) -> float:
    r0 = int(min(max(math.floor(r), 0), arr.shape[0] - 1))
    c0 = int(min(max(math.floor(c), 0), arr.shape[1] - 1))
    r1, c1 = min(r0 + 1, arr.shape[0] - 1), min(c0 + 1, arr.shape[1] - 1)
    fr, fc = r - r0, c - c0
    return float(arr[r0, c0] * (1 - fr) * (1 - fc) + arr[r0, c1] * (1 - fr) * fc + arr[r1, c0] * fr * (1 - fc) + arr[r1, c1] * fr * fc)


def geo_shape(lat: np.ndarray, lon: np.ndarray) -> tuple[float, float]:
    """Elongation and major-axis bearing (0-180 deg) of a set of geographic points."""
    lat0 = float(lat.mean())
    y = (lat - lat0) * 110.574
    x = (lon - float(lon.mean())) * 111.32 * math.cos(math.radians(lat0))
    if len(x) < 3:
        return 1.0, 0.0
    evals, evecs = np.linalg.eigh(np.cov(np.stack([x, y])))
    ex, ey = evecs[:, -1]
    bearing = (math.degrees(math.atan2(ex, ey)) + 180.0) % 180.0
    return math.sqrt(max(evals[-1], 1e-12) / max(evals[0], 1e-12)), bearing


def analyse_image(
    power: np.ndarray,
    rows: np.ndarray,
    cols: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    calibration,
    noise,
    land_source: RingLand | PolygonLand,
    pixel_km: float,
    incident: tuple[float, float],
    looks: float,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Calibrate, filter, mask and detect over an already cropped multilooked window."""
    valid = power > 0
    s0 = sigma0(power, rows, cols, calibration, noise)
    filtered = lee_filter(s0, int(params["leeWindow"]), looks)
    db = to_db(filtered)
    land = land_source.mask(lat, lon)
    buffer_px = int(round(params["coastBufferKm"] / pixel_km))
    near_land = dilate(land, buffer_px)
    sea = valid & ~near_land
    spots, labels = detect_dark_spots(
        db, sea, pixel_km, window=int(params["detectorWindow"]), k_sigma=float(params["kSigma"]),
        min_contrast_db=float(params["minContrastDb"]), min_area_km2=float(params["minAreaKm2"]),
    )

    out_spots = []
    for s in spots:
        # One-pixel-wide lines are crop or swath edges, not slicks.
        if s.elongation > float(params.get("maxElongation", 50.0)):
            continue
        clat = bilinear(lat, *s.centroid_rc)
        clon = bilinear(lon, *s.centroid_rc)
        rc = np.argwhere(labels == s.label)
        if len(rc) > 4000:
            rc = rc[np.linspace(0, len(rc) - 1, 4000).astype(int)]
        elong, bearing = geo_shape(lat[rc[:, 0], rc[:, 1]], lon[rc[:, 0], rc[:, 1]])
        outline = [{"lat": round(float(lat[int(pr), int(pc)]), 5), "lon": round(float(lon[int(pr), int(pc)]), 5)} for pr, pc in s.hull_rc]
        out_spots.append({
            "areaKm2": round(s.area_km2, 3), "meanDb": round(s.mean_db, 2), "backgroundDb": round(s.background_db, 2),
            "contrastDb": round(s.contrast_db, 2), "centroid": {"lat": round(clat, 5), "lon": round(clon, 5)},
            "distanceKm": round(haversine_km(clat, clon, *incident), 2), "elongation": round(elong, 2),
            "orientationDeg": round(bearing, 1), "outline": outline,
        })
    out_spots.sort(key=lambda s: (s["distanceKm"], -s["areaKm2"]))
    sea_db = db[sea]
    return {
        "db": db, "land": near_land, "labels": labels, "spots": out_spots,
        "sea": {"meanDb": round(float(sea_db.mean()), 2) if sea_db.size else None,
                "stdDb": round(float(sea_db.std()), 2) if sea_db.size else None, "pixels": int(sea_db.size)},
    }


def process_scene(
    safe_path: Path,
    case: dict[str, Any],
    scene_name: str,
    land_source: RingLand | PolygonLand,
    out_dir: Path,
    radius_km: float = 40.0,
    factor: int = 8,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # 2 km is enough with the Natural Earth coastline; the coarse fallback outlines need about 8 km.
    params = {"leeWindow": 7, "detectorWindow": 51, "kSigma": 1.5, "minContrastDb": 3.0, "minAreaKm2": 0.5,
              "coastBufferKm": 2.0 if isinstance(land_source, PolygonLand) else 8.0, "maxElongation": 50.0, **(params or {})}
    product = SafeProduct.open(safe_path)
    band = product.band()
    annotation = product.read_text(band.annotation)
    grid = parse_geolocation(annotation)
    calibration = parse_calibration(product.read_text(band.calibration))
    noise = parse_noise(product.read_text(band.noise)) if band.noise else None
    spacing_m = pixel_spacing_m(annotation) * factor
    pixel_km = spacing_m / 1000.0

    dn = product.read_measurement(band)
    power, rows, cols = multilook_power(dn, factor)
    lat, lon = latlon(grid, rows, cols)

    inc = case["incident"]["position"]
    incident = (inc["lat"], inc["lon"])
    dist = haversine_grid(lat, lon, *incident)
    near = dist <= radius_km
    if not near.any():
        raise ValueError(f"{scene_name} does not cover {radius_km:g} km around the incident")
    r_idx = np.flatnonzero(near.any(axis=1))
    c_idx = np.flatnonzero(near.any(axis=0))
    rs = slice(r_idx[0], r_idx[-1] + 1)
    cs = slice(c_idx[0], c_idx[-1] + 1)

    # Equivalent looks: about 4.4 for IW GRDH, multiplied by the extra block averaging.
    looks = 4.4 * factor * factor
    result = analyse_image(power[rs, cs], rows[rs], cols[cs], lat[rs, cs], lon[rs, cs], calibration, noise,
                           land_source, pixel_km, incident, looks, params)

    case_dir = out_dir / "sar" / case["id"]
    quicklook = write_quicklook(case_dir / f"{scene_name}.png", result["db"], result["land"], result["labels"])
    crop_lat, crop_lon = lat[rs, cs], lon[rs, cs]
    corners = [(0, 0), (0, -1), (-1, -1), (-1, 0)]
    record = {
        "schemaVersion": 1,
        "caseId": case["id"],
        "scene": scene_name,
        "processedAt": iso(datetime.now(timezone.utc)),
        "polarisation": band.polarisation,
        "method": METHOD,
        "landMask": land_source.source,
        "parameters": {**params, "multilookFactor": factor, "pixelSpacingM": round(spacing_m, 1), "equivalentLooks": looks,
                       "radiusKm": radius_km},
        "crop": {"corners": [{"lat": round(float(crop_lat[r, c]), 5), "lon": round(float(crop_lon[r, c]), 5)} for r, c in corners],
                 "shape": list(result["db"].shape)},
        "incidenceDeg": round(float(np.nanmean(interpolate_grid(grid, grid.incidence, rows[rs], cols[cs]))), 2),
        "sea": result["sea"],
        "quicklook": str(quicklook.relative_to(out_dir)).replace("\\", "/"),
        "spots": result["spots"][:20],
        "limitations": LIMITATIONS,
    }
    (case_dir / f"{scene_name}.json").write_text(json.dumps(record, indent=1))
    return record


def haversine_grid(lat: np.ndarray, lon: np.ndarray, lat0: float, lon0: float) -> np.ndarray:
    p1, p2 = np.radians(lat), math.radians(lat0)
    dphi = p2 - p1
    dl = np.radians(lon0 - lon)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * math.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6371.0088 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def load_measurements(out_dir: Path, case_id: str) -> list[dict[str, Any]]:
    case_dir = out_dir / "sar" / case_id
    if not case_dir.exists():
        return []
    return [json.loads(p.read_text()) for p in sorted(case_dir.glob("*.json"))]
