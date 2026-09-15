from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from conftest import FIXTURES, FakeHttp, fixture_json
from oceanspill.config import Settings
from oceanspill.geo import haversine_km
from oceanspill.providers import ProviderConfigError, Providers
from oceanspill.providers.base import BBox, VesselRecord
from oceanspill.providers.metocean_openmeteo import ARCHIVE_URL, MARINE_URL, OpenMeteo, current_components, wind_components
from oceanspill.providers.sanctions_unsc import LIST_URL, UnscSanctions, parse_list
from oceanspill.providers.sar_eos04 import BASE_URL, Eos04Bhoonidhi, parse_features
from oceanspill.providers.sar_sentinel1 import CATALOGUE_URL, Sentinel1Cdse, parse_products


def test_wind_and_current_conventions():
    # Wind FROM the north blows southward.
    u, v = wind_components(10.0, 0.0)
    assert u == pytest.approx(0, abs=1e-6) and v == pytest.approx(-10)
    # Current flowing TOWARDS the east.
    u, v = current_components(1.0, 90.0)
    assert u == pytest.approx(1) and v == pytest.approx(0, abs=1e-6)
    assert wind_components(None, 10) == (None, None)


def test_openmeteo_grid_from_real_responses(settings: Settings):
    http = FakeHttp({ARCHIVE_URL: fixture_json("openmeteo_wind.json"), MARINE_URL: fixture_json("openmeteo_marine.json")})
    grid = OpenMeteo(settings, http).grid(
        BBox(76.0, 9.0, 76.0, 9.5), 0.5,
        datetime(2025, 5, 25, 0, tzinfo=timezone.utc), datetime(2025, 5, 25, 23, tzinfo=timezone.utc),
    )
    assert grid.lats == [9.0, 9.5] and grid.lons == [76.0]
    assert len(grid.times) == 24
    assert all(grid.wind_u[t][y][0] is not None for t in range(24) for y in range(2))
    assert "ERA5" in grid.sources["wind"] and "SMOC" in grid.sources["current"]


def test_openmeteo_skips_currents_before_2022(settings: Settings):
    http = FakeHttp({ARCHIVE_URL: fixture_json("openmeteo_wind.json")})
    grid = OpenMeteo(settings, http).grid(
        BBox(76.0, 9.0, 76.0, 9.5), 0.5,
        datetime(2017, 5, 10, tzinfo=timezone.utc), datetime(2017, 5, 10, 23, tzinfo=timezone.utc),
    )
    assert not any(url.startswith(MARINE_URL) for _, url, _ in http.calls)
    assert "unavailable" in grid.sources["current"]


def test_sentinel1_parses_real_catalogue_response_and_drops_cog_duplicates(settings: Settings):
    scenes = parse_products(fixture_json("cdse_products.json"))
    assert scenes[0].platform == "Sentinel-1A"
    assert scenes[0].product_type == "IW_GRDH_1S"
    assert scenes[0].orbit_direction in ("ASCENDING", "DESCENDING")
    assert len(scenes[0].footprint) >= 4

    http = FakeHttp({CATALOGUE_URL: fixture_json("cdse_products.json")})
    found = Sentinel1Cdse(settings, http).search(
        BBox(75.8, 9.0, 76.4, 9.6), datetime(2025, 5, 24, tzinfo=timezone.utc), datetime(2025, 5, 31, tzinfo=timezone.utc)
    )
    assert all(not s.name.endswith("_COG.SAFE") for s in found)
    # One request per product type, because OR inside the attribute filter returns nothing.
    assert len(http.calls) == 2


def test_sentinel1_download_requires_credentials(settings: Settings, tmp_path: Path):
    provider = Sentinel1Cdse(settings, FakeHttp())
    scene = parse_products(fixture_json("cdse_products.json"))[0]
    with pytest.raises(RuntimeError, match="CDSE credentials missing"):
        provider.download(scene, tmp_path)


EOS04_SEARCH = {
    "type": "FeatureCollection",
    "context": {"limit": 500, "returned": 1},
    "features": [
        {
            "id": "E04_SAR_MRS_26MAY2025_362001201630_10311_STUC00ZTD_13022_22_DH_D_R_N09308_E076136",
            "collection": "EOS-04_SAR-MRS_L2B",
            "geometry": {"type": "Polygon", "coordinates": [[[75.5, 8.8], [76.9, 8.8], [76.9, 9.9], [75.5, 9.9], [75.5, 8.8]]]},
            "properties": {"Online": "Y"},
        }
    ],
    "links": [],
}


def test_eos04_parses_documented_search_format():
    scene = parse_features(EOS04_SEARCH)[0]
    assert scene.platform == "EOS-04"
    assert scene.mode == "MRS"
    assert scene.start == datetime(2025, 5, 26, tzinfo=timezone.utc)  # recovered from the product id
    assert scene.online and scene.provider == "bhoonidhi"


def test_eos04_logs_in_then_searches_with_bearer_token():
    settings = Settings(bhoonidhi_user_id="student", bhoonidhi_password="secret")
    http = FakeHttp({
        f"{BASE_URL}/auth/token": {"access_token": "jwt-123", "expires_in": 900, "refresh_token": "r-1"},
        f"{BASE_URL}/data/search": EOS04_SEARCH,
    })
    provider = Eos04Bhoonidhi(settings, http)
    assert provider.status().available
    scenes = provider.search(BBox(75.6, 8.8, 76.6, 9.8), datetime(2025, 5, 24, tzinfo=timezone.utc), datetime(2025, 6, 1, tzinfo=timezone.utc))
    assert len(scenes) == 1
    method, url, kwargs = http.calls[1]
    assert url.endswith("/data/search") and kwargs["headers"]["Authorization"] == "Bearer jwt-123"
    assert kwargs["json_body"]["collections"][0].startswith("EOS-04")


def test_eos04_unavailable_without_credentials(settings: Settings):
    assert not Eos04Bhoonidhi(settings, FakeHttp()).status().available


def test_unsc_matches_by_imo_only(settings: Settings):
    xml = (FIXTURES / "unsc_sample.xml").read_text()
    listed = parse_list(xml)
    assert listed  # the fixture entity carries an IMO number
    listed_imo = next(iter(listed))
    http = FakeHttp(text_routes={LIST_URL: xml})
    vessels = [
        VesselRecord(key="a", name="LISTED SHIP", type="Tanker", role="source", provenance="real", imo=listed_imo),
        VesselRecord(key="b", name="CLEAN SHIP", type="Tanker", role="source", provenance="real", imo="1234567"),
        VesselRecord(key="c", name="NO IMO", type="Tanker", role="source", provenance="real"),
        VesselRecord(key="d", name="SYN TANKER 01", type="Tanker", role="background", provenance="synthetic", imo=listed_imo),
    ]
    checks = {c.key: c for c in UnscSanctions(settings, http).check(vessels)}
    assert checks["a"].listed and not checks["b"].listed
    assert "c" not in checks and "d" not in checks


def test_registry_rejects_unknown_and_explains_pending(settings: Settings, reference):
    land, corridors, _ = reference
    with pytest.raises(ProviderConfigError, match="not integrated yet"):
        Providers.from_settings(Settings(metocean_providers=["incois"]), FakeHttp(), land, corridors)
    with pytest.raises(ProviderConfigError, match="unknown"):
        Providers.from_settings(Settings(ais_provider="nope"), FakeHttp(), land, corridors)
    providers = Providers.from_settings(settings, FakeHttp(), land, corridors)
    kinds = [s.kind for s in providers.statuses()]
    assert kinds == ["sar", "sar", "metocean", "ais", "sanctions"]


def test_settings_parse_provider_lists(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("SAR_PROVIDERS", "sentinel1, eos04")
    monkeypatch.setenv("AIS_PROVIDER", "synthetic")
    s = Settings.load(tmp_path / "missing.env")
    assert s.sar_providers == ["sentinel1", "eos04"]


@pytest.mark.live
def test_live_cdse_catalogue_finds_msc_elsa3_scene(settings: Settings):
    from oceanspill.http import CachedHttp

    scenes = Sentinel1Cdse(settings, CachedHttp(settings.cache_dir)).search(
        BBox(75.8, 9.0, 76.4, 9.6), datetime(2025, 5, 24, tzinfo=timezone.utc), datetime(2025, 5, 31, tzinfo=timezone.utc)
    )
    assert any(haversine_km(9.31, 76.14, s.footprint[0][1], s.footprint[0][0]) < 400 for s in scenes)
