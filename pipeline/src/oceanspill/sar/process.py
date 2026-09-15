from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from ..geo import haversine_km, iso
from .calibration import parse_calibration, parse_noise, sigma0
from .darkspot import detect_dark_spots
from .eos04 import MASK_VALID_BIT, Eos04Product, block_mean_masked, utm_zone
from .filters import dilate, lee_filter, multilook_power, to_db
from .geolocation import interpolate_grid, latlon, parse_geolocation
from .landmask import PolygonLand, RingLand
from .quicklook import write_quicklook
from .safe import SafeProduct, pixel_spacing_m
from .utm import from_utm, to_utm

METHOD = "Adaptive-threshold dark-spot detection on Lee-filtered calibrated backscatter (classical method, not a trained model)"
LIMITATIONS = [
    "Dark spots include look-alikes (low wind, biogenic films, rain cells); the look-alike checks must still be applied",
    "Land is masked with a coastline plus a coastal buffer; detections within a few km of shore remain unreliable",
    "Multilooking trades resolution for speckle reduction; slicks narrower than two output pixels can be missed",
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


@dataclass
class LoadedScene:
    """A calibrated, multilooked window around the incident, ready for detection."""

    product: str
    radiometry: str
    polarisation: str
    linear: np.ndarray
    valid: np.ndarray
    lat: np.ndarray
    lon: np.ndarray
    pixel_m: float
    looks: float
    incidence_deg: float | None
    geometry: str


def load_sentinel1(path: Path, incident: tuple[float, float], radius_km: float, factor: int) -> LoadedScene:
    product = SafeProduct.open(path)
    band = product.band()
    annotation = product.read_text(band.annotation)
    grid = parse_geolocation(annotation)
    calibration = parse_calibration(product.read_text(band.calibration))
    noise = parse_noise(product.read_text(band.noise)) if band.noise else None
    spacing_m = pixel_spacing_m(annotation) * factor

    dn = product.read_measurement(band)
    power, rows, cols = multilook_power(dn, factor)
    lat, lon = latlon(grid, rows, cols)
    near = haversine_grid(lat, lon, *incident) <= radius_km
    if not near.any():
        raise ValueError(f"scene does not cover {radius_km:g} km around the incident")
    r_idx = np.flatnonzero(near.any(axis=1))
    c_idx = np.flatnonzero(near.any(axis=0))
    rs, cs = slice(r_idx[0], r_idx[-1] + 1), slice(c_idx[0], c_idx[-1] + 1)
    s0 = sigma0(power[rs, cs], rows[rs], cols[cs], calibration, noise)
    return LoadedScene(
        product="Sentinel-1 GRD", radiometry="Sigma0 (thermal noise removed)", polarisation=band.polarisation,
        linear=s0, valid=power[rs, cs] > 0, lat=lat[rs, cs], lon=lon[rs, cs], pixel_m=spacing_m,
        # Equivalent looks: about 4.4 for IW GRDH, multiplied by the extra block averaging.
        looks=4.4 * factor * factor,
        incidence_deg=float(np.nanmean(interpolate_grid(grid, grid.incidence, rows[rs], cols[cs]))),
        geometry="radar geometry (not north-up)",
    )


def load_eos04(path: Path, incident: tuple[float, float], radius_km: float, factor: int) -> LoadedScene:
    product = Eos04Product.open(path)
    meta = product.band_meta()
    pol = product.polarisations()[0]
    k_db, measurement = product.conversion_constant_db(pol)
    dn, tags = product.read_raster(product.image_member(pol))
    zone, north = utm_zone(tags, meta)
    sx, sy = float(tags["ModelPixelScaleTag"][0]), float(tags["ModelPixelScaleTag"][1])
    tx, ty = float(tags["ModelTiepointTag"][3]), float(tags["ModelTiepointTag"][4])

    x0, y0 = to_utm(incident[0], incident[1], zone, north)
    col_c, row_c = (float(x0) - tx) / sx, (ty - float(y0)) / sy
    half = radius_km * 1000.0 / sx
    h, w = dn.shape
    r0, r1 = max(0, int(row_c - half)), min(h, int(row_c + half))
    c0, c1 = max(0, int(col_c - half)), min(w, int(col_c + half))
    r1 = r0 + (r1 - r0) // factor * factor
    c1 = c0 + (c1 - c0) // factor * factor
    if r1 - r0 < factor * 8 or c1 - c0 < factor * 8:
        raise ValueError(f"scene does not cover {radius_km:g} km around the incident")

    window = dn[r0:r1, c0:c1]
    valid = window > 0
    mask_name = product.mask_member()
    if mask_name:
        mask, _ = product.read_raster(mask_name)
        valid &= (mask[r0:r1, c0:c1] & MASK_VALID_BIT) > 0
    power = window.astype(np.float64) ** 2
    mean_power, ok = block_mean_masked(power, valid, factor)
    linear = (mean_power * 10.0 ** (-k_db / 10.0)).astype(np.float32)

    rows = r0 + (np.arange(linear.shape[0]) + 0.5) * factor
    cols = c0 + (np.arange(linear.shape[1]) + 0.5) * factor
    xx, yy = np.meshgrid(tx + cols * sx, ty - rows * sy)
    lat, lon = from_utm(xx, yy, zone, north)
    looks = float(meta.get("RangeLooks", 1)) * float(meta.get("AzimuthLooks", 1)) * factor * factor
    incidence = float(meta["IncidenceAngle"]) if meta.get("IncidenceAngle") else None
    return LoadedScene(
        product=f"{meta.get('SatID', 'EOS-04')} {meta.get('ImagingMode', '').strip()} {meta.get('ProductType', 'L2B')}".strip(),
        radiometry=f"{measurement} (noise removed, terrain corrected; dB = 10*log10(DN^2) - {k_db:g})",
        polarisation=pol, linear=linear, valid=ok & (mean_power > 0), lat=lat, lon=lon, pixel_m=sx * factor,
        looks=looks, incidence_deg=incidence, geometry=f"UTM zone {zone}{'N' if north else 'S'} map grid (north-up)",
    )


def analyse_linear(
    linear: np.ndarray,
    valid: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    land_source: RingLand | PolygonLand,
    pixel_km: float,
    incident: tuple[float, float],
    looks: float,
    params: dict[str, Any],
    segmenter: Any | None = None,
) -> dict[str, Any]:
    """Filter, mask and detect over a calibrated multilooked window (linear backscatter)."""
    filtered = lee_filter(linear, int(params["leeWindow"]), looks)
    db = to_db(filtered)
    land = land_source.mask(lat, lon)
    buffer_px = int(round(params["coastBufferKm"] / pixel_km))
    near_land = dilate(land, buffer_px)
    sea = valid & ~near_land
    # A trained model, when one is configured, replaces only the pixel decision; everything the
    # record reports about each spot is measured the same way either way.
    model_mask = None
    if segmenter is not None:
        from ..ml.infer import mask_to_spots
        model_mask = mask_to_spots(segmenter.mask(db, sea), segmenter.info.threshold)
    spots, labels = detect_dark_spots(
        db, sea, pixel_km, window=int(params["detectorWindow"]), k_sigma=float(params["kSigma"]),
        min_contrast_db=float(params["minContrastDb"]), min_area_km2=float(params["minAreaKm2"]),
        dark=model_mask,
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
        "db": db, "land": near_land | ~valid, "labels": labels, "spots": out_spots,
        "sea": {"meanDb": round(float(sea_db.mean()), 2) if sea_db.size else None,
                "stdDb": round(float(sea_db.std()), 2) if sea_db.size else None, "pixels": int(sea_db.size)},
    }


def process_scene(
    path: Path,
    case: dict[str, Any],
    scene_name: str,
    land_source: RingLand | PolygonLand,
    out_dir: Path,
    radius_km: float = 40.0,
    factor: int | None = None,
    params: dict[str, Any] | None = None,
    model_path: Path | str | None = None,
) -> dict[str, Any]:
    # 2 km is enough with the Natural Earth coastline; the coarse fallback outlines need about 8 km.
    params = {"leeWindow": 7, "detectorWindow": 51, "kSigma": 1.5, "minContrastDb": 3.0, "minAreaKm2": 0.5,
              "coastBufferKm": 2.0 if isinstance(land_source, PolygonLand) else 8.0, "maxElongation": 50.0, **(params or {})}
    inc = case["incident"]["position"]
    incident = (inc["lat"], inc["lon"])
    # Default multilooking brings both products to roughly 75 m pixels (EOS-04 MRS 18 m, Sentinel-1 GRDH 10 m).
    if Eos04Product.detect(path):
        factor = factor or 4
        scene = load_eos04(path, incident, radius_km, factor)
    else:
        factor = factor or 8
        scene = load_sentinel1(path, incident, radius_km, factor)
    pixel_km = scene.pixel_m / 1000.0
    # Without a trained model, or when one cannot be loaded, this stays None and the classical
    # detector runs — which is what the record then says it used.
    from ..ml.infer import segmenter as load_segmenter
    detector = load_segmenter(model_path)
    result = analyse_linear(scene.linear, scene.valid, scene.lat, scene.lon, land_source, pixel_km,
                            incident, scene.looks, params, segmenter=detector)

    case_dir = out_dir / "sar" / case["id"]
    quicklook = write_quicklook(case_dir / f"{scene_name}.png", result["db"], result["land"], result["labels"])
    corners = [(0, 0), (0, -1), (-1, -1), (-1, 0)]
    record = {
        "schemaVersion": 1,
        "caseId": case["id"],
        "scene": scene_name,
        "product": scene.product,
        "radiometry": scene.radiometry,
        "processedAt": iso(datetime.now(timezone.utc)),
        "polarisation": scene.polarisation,
        "method": detector.description if detector else METHOD,
        "landMask": land_source.source,
        "parameters": {**params, "multilookFactor": factor, "pixelSpacingM": round(scene.pixel_m, 1),
                       "equivalentLooks": scene.looks, "radiusKm": radius_km},
        "crop": {"corners": [{"lat": round(float(scene.lat[r, c]), 5), "lon": round(float(scene.lon[r, c]), 5)} for r, c in corners],
                 "shape": list(result["db"].shape)},
        "incidenceDeg": round(scene.incidence_deg, 2) if scene.incidence_deg is not None else None,
        "sea": result["sea"],
        "quicklook": str(quicklook.relative_to(out_dir)).replace("\\", "/"),
        "spots": result["spots"][:20],
        "limitations": [*LIMITATIONS, f"The quicklook is in {scene.geometry}; use the outlines on the map for location"],
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
