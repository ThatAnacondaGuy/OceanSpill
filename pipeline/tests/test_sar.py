from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path

import numpy as np
import pytest

from oceanspill.sar.calibration import interpolate_lut, parse_calibration, parse_noise, sigma0
from oceanspill.sar.darkspot import detect_dark_spots, label_components
from oceanspill.sar.filters import box_mean, lee_filter, multilook_power, to_db
from oceanspill.sar.geolocation import latlon, parse_geolocation
from oceanspill.sar.landmask import PolygonLand, RingLand, land_mask, rings_from_land
from oceanspill.sar.quicklook import png_bytes

# XML below follows the Sentinel-1 IPF annotation layout (calibration, noise and product annotation).


def calibration_xml(lines=(0, 399), pixels="0 200 399", values=("100 100 100", "100 100 100")) -> str:
    vectors = "".join(
        f"<calibrationVector><azimuthTime>2025-05-25T00:00:00</azimuthTime><line>{ln}</line>"
        f"<pixel count='3'>{pixels}</pixel><sigmaNought count='3'>{val}</sigmaNought>"
        f"<betaNought count='3'>{val}</betaNought><gamma count='3'>{val}</gamma><dn count='3'>{val}</dn></calibrationVector>"
        for ln, val in zip(lines, values)
    )
    return f"<calibration><calibrationVectorList count='{len(lines)}'>{vectors}</calibrationVectorList></calibration>"


def noise_xml(lut="0 0 0") -> str:
    return (
        "<noise><noiseRangeVectorList count='2'>"
        f"<noiseRangeVector><line>0</line><pixel count='3'>0 200 399</pixel><noiseRangeLut count='3'>{lut}</noiseRangeLut></noiseRangeVector>"
        f"<noiseRangeVector><line>399</line><pixel count='3'>0 200 399</pixel><noiseRangeLut count='3'>{lut}</noiseRangeLut></noiseRangeVector>"
        "</noiseRangeVectorList></noise>"
    )


def annotation_xml(lat_top=9.40, lat_bottom=9.364, lon_left=76.0, lon_right=76.036, size=400) -> str:
    points = []
    for line in np.linspace(0, size - 1, 5).astype(int):
        for pixel in np.linspace(0, size - 1, 5).astype(int):
            lat = lat_top + (lat_bottom - lat_top) * line / (size - 1)
            lon = lon_left + (lon_right - lon_left) * pixel / (size - 1)
            points.append(f"<geolocationGridPoint><line>{line}</line><pixel>{pixel}</pixel><latitude>{lat}</latitude>"
                          f"<longitude>{lon}</longitude><incidenceAngle>{30 + 15 * pixel / (size - 1)}</incidenceAngle></geolocationGridPoint>")
    return ("<product><imageAnnotation><imageInformation><rangePixelSpacing>10.0</rangePixelSpacing>"
            "<azimuthPixelSpacing>10.0</azimuthPixelSpacing></imageInformation></imageAnnotation>"
            f"<geolocationGrid><geolocationGridPointList count='{len(points)}'>{''.join(points)}</geolocationGridPointList></geolocationGrid></product>")


def test_calibration_lut_is_bilinear_in_line_and_pixel():
    vectors = parse_calibration(calibration_xml(lines=(0, 100), pixels="0 100 200", values=("100 200 300", "300 400 500")))
    out = interpolate_lut(vectors, np.array([0, 50, 100]), np.array([0, 50, 100]))
    assert out[1, 1] == pytest.approx(250)
    assert out[0, 0] == pytest.approx(100) and out[2, 2] == pytest.approx(400)


def test_sigma0_applies_noise_then_calibration_constant():
    cal = parse_calibration(calibration_xml())
    rows, cols = np.array([10.0]), np.array([10.0])
    power = np.array([[10000.0]])
    assert sigma0(power, rows, cols, cal)[0, 0] == pytest.approx(1.0)
    noise = parse_noise(noise_xml("5000 5000 5000"))
    assert sigma0(power, rows, cols, cal, noise)[0, 0] == pytest.approx(0.5)
    assert sigma0(np.array([[100.0]]), rows, cols, cal, noise)[0, 0] > 0, "over-subtracted noise is floored, not negative"


def test_multilook_power_averages_squared_dn_in_blocks():
    dn = np.array([[1, 3, 0, 0], [1, 3, 0, 0], [2, 2, 4, 4], [2, 2, 4, 4]], dtype=np.uint16)
    power, rows, cols = multilook_power(dn, 2, chunk_rows=2)
    assert power.tolist() == [[5.0, 0.0], [4.0, 16.0]]
    assert rows.tolist() == [0.5, 2.5]


def test_geolocation_grid_interpolates_between_tie_points():
    grid = parse_geolocation(annotation_xml())
    lat, lon = latlon(grid, np.array([0.0, 199.5, 399.0]), np.array([0.0, 399.0]))
    assert lat[0, 0] == pytest.approx(9.40) and lat[2, 0] == pytest.approx(9.364)
    assert lat[1, 0] == pytest.approx(9.382, abs=1e-4)
    assert lon[0, 1] == pytest.approx(76.036)


def test_lee_filter_smooths_speckle_but_keeps_edges():
    rng = np.random.default_rng(1)
    looks = 4
    truth = np.where(np.arange(200)[None, :] < 100, 0.2, 0.02) * np.ones((200, 1))
    speckled = truth * rng.gamma(looks, 1 / looks, truth.shape)
    out = lee_filter(speckled.astype(np.float32), 7, looks)
    flat = (slice(20, 180), slice(10, 80))
    assert out[flat].std() < speckled[flat].std() * 0.5
    assert out[flat].mean() == pytest.approx(0.2, rel=0.05)
    assert to_db(out[:, 60:80]).mean() - to_db(out[:, 120:140]).mean() > 8, "the 10 dB step must survive filtering"


def test_box_mean_matches_direct_window_average():
    img = np.arange(49, dtype=float).reshape(7, 7)
    assert box_mean(img, 3)[3, 3] == pytest.approx(img[2:5, 2:5].mean())


def test_land_mask_uses_the_coastline_rings(reference):
    land, _, _ = reference
    rings = rings_from_land(land)
    lat = np.array([[20.0, 15.0]])
    lon = np.array([[78.0, 70.0]])  # central India, open Arabian Sea
    assert land_mask(lat, lon, rings).tolist() == [[True, False]]


def test_label_components_drops_small_blobs():
    mask = np.zeros((10, 10), dtype=bool)
    mask[1:4, 1:4] = True
    mask[8, 8] = True
    labels, n = label_components(mask, min_pixels=4)
    assert n == 1 and labels[2, 2] == 1 and labels[8, 8] == 0


def _scene(rng: np.random.Generator, shape=(200, 200), looks=16) -> tuple[np.ndarray, np.ndarray]:
    sea_db = np.full(shape, -8.0)
    truth = sea_db.copy()
    truth[90:100, 40:160] = -18.0  # long, thin slick
    linear = 10 ** (truth / 10) * rng.gamma(looks, 1 / looks, shape)
    return to_db(lee_filter(linear.astype(np.float32), 7, looks)), truth


def test_dark_spot_detector_finds_elongated_slick_and_ignores_land():
    rng = np.random.default_rng(7)
    db, _ = _scene(rng)
    sea = np.ones(db.shape, dtype=bool)
    sea[:40, :40] = False
    db[:40, :40] = -25.0  # dark land that must not be reported
    spots, labels = detect_dark_spots(db, sea, pixel_km=0.08, window=51, min_area_km2=0.5)
    assert len(spots) >= 1
    top = spots[0]
    assert 90 <= top.centroid_rc[0] <= 100 and 80 <= top.centroid_rc[1] <= 120
    assert top.contrast_db < -6
    assert top.elongation > 4
    assert not labels[:40, :40].any()


def test_png_writer_produces_a_decodable_image():
    img = np.zeros((3, 5, 3), dtype=np.uint8)
    img[1, 2] = (255, 0, 0)
    data = png_bytes(img)
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", data[16:24])
    assert (width, height) == (5, 3)
    idat_len = struct.unpack(">I", data[33:37])[0]
    raw = zlib.decompress(data[41:41 + idat_len])
    assert len(raw) == 3 * (1 + 5 * 3) and raw[1 + 16 + 6] == 255


def test_process_scene_end_to_end_on_a_synthetic_safe(tmp_path: Path):
    tifffile = pytest.importorskip("tifffile")
    from oceanspill.sar.process import process_scene

    rng = np.random.default_rng(3)
    size = 400
    sigma = np.full((size, size), 10 ** (-8 / 10))
    sigma[170:200, 80:320] = 10 ** (-18 / 10)  # 0.3 x 2.4 km = 0.72 km2, above the 0.5 km2 minimum
    power = sigma * 100.0**2 * rng.gamma(4.4, 1 / 4.4, sigma.shape)
    dn = np.sqrt(power).clip(0, 65535).astype(np.uint16)

    safe = tmp_path / "S1A_IW_GRDH_1SDV_TEST.SAFE"
    stem = "s1a-iw-grd-vv-20250525t000000-test-001"
    (safe / "measurement").mkdir(parents=True)
    (safe / "annotation" / "calibration").mkdir(parents=True)
    tifffile.imwrite(safe / "measurement" / f"{stem}.tiff", dn)
    (safe / "annotation" / f"{stem}.xml").write_text(annotation_xml(size=size))
    (safe / "annotation" / "calibration" / f"calibration-{stem}.xml").write_text(calibration_xml())
    (safe / "annotation" / "calibration" / f"noise-{stem}.xml").write_text(noise_xml())

    case = {"id": "TEST-CASE", "incident": {"position": {"lat": 9.382, "lon": 76.018}}}
    # A land ring over the north-east corner of the scene.
    rings = [[(9.395, 76.030), (9.40, 76.030), (9.40, 76.036), (9.395, 76.036)]]
    record = process_scene(safe, case, "S1A_IW_GRDH_1SDV_TEST", RingLand(rings), tmp_path / "out", radius_km=40, factor=2,
                           params={"coastBufferKm": 0.1})

    assert record["polarisation"] == "VV" and record["parameters"]["pixelSpacingM"] == 20.0
    assert record["sea"]["meanDb"] == pytest.approx(-8, abs=1.0)
    top = record["spots"][0]
    assert top["distanceKm"] < 1.5
    assert top["contrastDb"] < -6
    assert 60 <= top["orientationDeg"] <= 120, "the slick runs east-west in this synthetic scene"
    assert (tmp_path / "out" / record["quicklook"]).read_bytes()[:4] == b"\x89PNG"
    saved = json.loads((tmp_path / "out" / "sar" / "TEST-CASE" / "S1A_IW_GRDH_1SDV_TEST.json").read_text())
    assert saved["spots"][0]["outline"]


def test_natural_earth_coastline_is_finer_than_the_outlines():
    from oceanspill.coastline import load_coastline

    polygons = load_coastline()
    if polygons is None:
        pytest.skip("coastline_ne10m.json not built")
    land = PolygonLand(polygons)
    # Thrissur is inland; 8 km off Kochi is sea; Kavaratti (Lakshadweep) is a small island.
    lat = np.array([[10.527, 9.97, 10.566]])
    lon = np.array([[76.214, 76.12, 72.642]])
    assert land.mask(lat, lon).tolist() == [[True, False, True]]


def test_clip_ring_keeps_inside_part_of_polygon():
    from oceanspill.coastline import clip_ring

    square = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)]
    clipped = clip_ring(square, (1.0, 1.0, 2.0, 5.0))
    xs = sorted({round(p[0], 6) for p in clipped})
    ys = sorted({round(p[1], 6) for p in clipped})
    assert xs == [1.0, 2.0] and ys == [1.0, 4.0]


def test_polygon_holes_are_water():
    outer = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    hole = [(4.0, 4.0), (6.0, 4.0), (6.0, 6.0), (4.0, 6.0)]
    land = PolygonLand([[outer, hole]])
    lat = np.array([[2.0, 5.0]])
    lon = np.array([[2.0, 5.0]])
    assert land.mask(lat, lon).tolist() == [[True, False]]


def test_eos04_reader_end_to_end_on_a_synthetic_ard_product(tmp_path: Path):
    tifffile = pytest.importorskip("tifffile")
    from oceanspill.sar.process import process_scene
    from oceanspill.sar.utm import from_utm, to_utm

    # Layout and metadata keys follow a real EOS-04 MRS L2B CEOS-ARD product from Bhoonidhi.
    name = "E04_SAR_MRS_TEST"
    root = tmp_path / name
    (root / "scene_VV").mkdir(parents=True)
    size, spacing, k_db = 600, 18.0, 67.14
    x0, y0 = to_utm(9.35, 76.08, 43)
    tx, ty = float(x0) - 300 * spacing, float(y0) + 300 * spacing
    rng = np.random.default_rng(5)
    gamma = np.full((size, size), 10 ** (-11 / 10))
    gamma[280:320, 150:450] = 10 ** (-21 / 10)  # 0.7 x 5.4 km slick, east-west
    power = gamma * 10 ** (k_db / 10) * rng.gamma(2.0, 0.5, gamma.shape)
    dn = np.sqrt(power).clip(1, 65535).astype(np.uint16)
    dn[:40, :] = 0  # outside the swath
    geokeys = (1, 1, 0, 1, 3072, 0, 1, 32643)
    tags = [(33550, "d", 3, (spacing, spacing, 0.0)), (33922, "d", 6, (0.0, 0.0, 0.0, tx, ty, 0.0)), (34735, "H", len(geokeys), geokeys)]
    tifffile.imwrite(root / "scene_VV" / "imagery_VV.tif", dn, extratags=tags)
    mask = np.where(dn > 0, 128, 0).astype(np.uint16)
    tifffile.imwrite(root / f"{name}_mask.tif", mask, extratags=tags)
    (root / "BAND_META.txt").write_text("SatID=EOS-04\nImagingMode=MRS \nProductType=L2B-ARD-PRODUCT\nZoneNo=43\nRangeLooks=2.000\nAzimuthLooks=1.000\nIncidenceAngle=34.97863\nSceneCenterLat=9.35\n")
    (root / "product.xml").write_text(
        "<Product><BackscatterMeasurementData><BackscatterMeasurement>Gamma-0</BackscatterMeasurement>"
        f"<BackscatterConversionEq units=\"dB\">10*log10(DN^2) - {k_db}</BackscatterConversionEq></BackscatterMeasurementData></Product>"
    )

    case = {"id": "TEST-EOS04", "incident": {"position": {"lat": 9.35, "lon": 76.08}}}
    record = process_scene(root, case, name, RingLand([]), tmp_path / "out", radius_km=6)
    assert record["product"].startswith("EOS-04 MRS") and "Gamma-0" in record["radiometry"]
    assert record["parameters"]["pixelSpacingM"] == 72.0
    assert record["sea"]["meanDb"] == pytest.approx(-11, abs=1.0)
    top = record["spots"][0]
    assert top["distanceKm"] < 1.0 and top["contrastDb"] < -6
    assert 70 <= top["orientationDeg"] <= 110
    lat, lon = from_utm(tx + 300 * spacing, ty - 300 * spacing, 43)
    assert float(lat) == pytest.approx(9.35, abs=1e-5) and float(lon) == pytest.approx(76.08, abs=1e-5)


def test_utm_matches_eos04_product_corner_coordinates():
    from oceanspill.sar.utm import from_utm, to_utm

    # Corner pairs copied from a real EOS-04 BAND_META.txt (UTM zone 43N).
    corners = [(9.623452, 75.348160, 538200.0, 1063800.0), (7.909241, 77.011876, 721800.0, 874800.0)]
    for lat, lon, x, y in corners:
        fx, fy = to_utm(lat, lon, 43)
        assert float(fx) == pytest.approx(x, abs=1.0) and float(fy) == pytest.approx(y, abs=1.0)
        ilat, ilon = from_utm(x, y, 43)
        assert float(ilat) == pytest.approx(lat, abs=1e-5) and float(ilon) == pytest.approx(lon, abs=1e-5)
