from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from conftest import FakeHttp
from oceanspill.build import build_case, reference_time
from oceanspill.config import Settings
from oceanspill.geo import haversine_km, parse_time
from oceanspill.geometry import reported_geometry
from oceanspill.providers import Providers
from oceanspill.providers.ais_synthetic import LandMask, SyntheticAis
from oceanspill.providers.base import ForcingGrid, ProviderStatus, SanctionsCheck


def _ais(settings: Settings, reference) -> SyntheticAis:
    land, corridors, _ = reference
    return SyntheticAis(settings, FakeHttp(), land, corridors)


def _window(case: dict) -> tuple[datetime, datetime]:
    t = parse_time(case["incident"]["time"])
    return t - timedelta(hours=36), t + timedelta(hours=48)


def _nearest(pings, when: datetime):
    return min(pings, key=lambda p: abs((p.t - when).total_seconds()))


def test_source_vessel_passes_through_reported_sinking_position(settings, reference, cases):
    case = cases["IND-2025-05-MSC-ELSA3"]
    start, end = _window(case)
    vessels, tracks = _ais(settings, reference).tracks(case, start, end)
    elsa = next(t for t, v in zip(tracks, vessels) if v.name == "MSC ELSA 3")
    sink = case["vessels"][0]["anchors"][-1]
    p = _nearest(elsa.pings, parse_time(sink["time"]))
    assert haversine_km(p.lat, p.lon, sink["lat"], sink["lon"]) < 1.5
    assert all(q.t <= parse_time(sink["time"]) for q in elsa.pings), "a sunk vessel must stop transmitting"


def test_real_identities_are_kept_and_synthetic_ones_are_marked(settings, reference, cases):
    case = cases["IND-2025-06-WANHAI503"]
    vessels, _ = _ais(settings, reference).tracks(case, *_window(case))
    real = [v for v in vessels if v.provenance == "real"]
    synthetic = [v for v in vessels if v.provenance == "synthetic"]
    assert {v.name for v in real} == {"WAN HAI 503", "ONE MARVEL", "AMBRA"}
    assert next(v for v in real if v.name == "WAN HAI 503").imo == "9294862"
    assert all(v.registry["verified"] is False for v in real)
    assert "priorOffences" not in next(v for v in real if v.name == "WAN HAI 503").registry
    assert synthetic and all(v.name.startswith("SYN ") and v.mmsi.startswith("999") for v in synthetic)


def test_responders_only_appear_near_their_reported_time(settings, reference, cases):
    case = cases["IND-2025-06-WANHAI503"]
    vessels, tracks = _ais(settings, reference).tracks(case, *_window(case))
    marvel = next(t for t, v in zip(tracks, vessels) if v.name == "ONE MARVEL")
    anchor_t = parse_time(case["vessels"][1]["anchors"][0]["time"])
    assert all(abs((p.t - anchor_t).total_seconds()) <= 10 * 3600 + 1 for p in marvel.pings)


def test_generation_is_deterministic_and_stays_at_sea(settings, reference, cases):
    land = LandMask(reference[0])
    for case in cases.values():
        a = _ais(settings, reference).tracks(case, *_window(case))[1]
        b = _ais(settings, reference).tracks(case, *_window(case))[1]
        assert [len(t.pings) for t in a] == [len(t.pings) for t in b]
        for t in a:
            if t.key.startswith("FAC-") or not t.pings:
                continue
            on_land = sum(land.on_land(p.lat, p.lon) for p in t.pings)
            assert on_land / len(t.pings) <= 0.05, f"{case['id']} {t.key} crosses land"


def test_facilities_are_stationary_candidates(settings, reference, cases):
    case = cases["IND-2023-12-ENNORE-CREEK"]
    vessels, tracks = _ais(settings, reference).tracks(case, *_window(case))
    cpcl = next((v, t) for v, t in zip(vessels, tracks) if v.is_facility)
    assert cpcl[0].type == "Refinery"
    assert {(p.lat, p.lon) for p in cpcl[1].pings} and max(p.sog for p in cpcl[1].pings) < 0.5


def test_reported_extent_strip_lies_offshore(reference, cases):
    land = LandMask(reference[0])
    geom = reported_geometry(cases["IND-2023-12-ENNORE-CREEK"], land)
    lat = sum(p["lat"] for p in geom["ring"]) / len(geom["ring"])
    lon = sum(p["lon"] for p in geom["ring"]) / len(geom["ring"])
    assert not land.on_land(lat, lon)
    assert geom["extentReported"] and any("width" in a for a in geom["assumptions"])


def test_location_only_geometry_says_so(reference, cases):
    geom = reported_geometry(cases["IND-2025-05-MSC-ELSA3"], LandMask(reference[0]))
    assert not geom["extentReported"] and geom["basis"] == "Location only"


def test_observation_mode_keeps_short_hindcast(cases):
    t, basis = reference_time(cases["IND-2018-06-SSL-KOLKATA"])
    assert t.month == 7 and "SkyTruth" in basis


class StubSar:
    name, agency, sovereign = "stub", "Stub", True

    def status(self):
        return ProviderStatus("sar", self.name, self.agency, self.sovereign, True, "stub")

    def search(self, bbox, start, end):
        return []


class StubMet:
    name, agency, sovereign = "stubmet", "Stub", False

    def status(self):
        return ProviderStatus("metocean", self.name, self.agency, self.sovereign, True, "stub")

    def grid(self, bbox, step, start, end, hour_step=1):
        times = [start, start + timedelta(hours=1)]
        cube = [[[1.0]]] * 2
        return ForcingGrid([bbox.south], [bbox.west], times, cube, cube, cube, cube, cube, {"wind": "stub", "current": "stub", "waves": "stub"})


class StubSanctions:
    name, agency, sovereign = "stubsanc", "Stub", False

    def status(self):
        return ProviderStatus("sanctions", self.name, self.agency, self.sovereign, True, "stub")

    def check(self, vessels):
        return [SanctionsCheck(v.key, v.name, v.imo, False, "Stub", None, datetime.now(timezone.utc)) for v in vessels if v.imo]


def test_build_case_writes_complete_artifact(settings, reference, cases, tmp_path: Path):
    land, corridors, _ = reference
    providers = Providers([StubSar()], StubMet(), SyntheticAis(settings, FakeHttp(), land, corridors), StubSanctions())
    art = build_case(cases["IND-2025-05-MSC-ELSA3"], providers, LandMask(land), tmp_path)
    written = json.loads((tmp_path / "cases" / "IND-2025-05-MSC-ELSA3.json").read_text())
    assert written["schemaVersion"] == 1
    assert {"case", "reference", "reportedGeometry", "sar", "forcing", "ais", "vessels", "tracks", "sanctions", "warnings"} <= set(written)
    assert (tmp_path / "forcing" / "IND-2025-05-MSC-ELSA3.json").exists()
    assert art["ais"]["pingFormat"][0] == "secondsFromWindowStart"
    first = art["tracks"][0]["pings"][0]
    assert len(first) == 7 and first[0] >= 0


def test_build_survives_a_failing_provider(settings, reference, cases, tmp_path: Path):
    class BrokenSar(StubSar):
        name = "broken"

        def search(self, bbox, start, end):
            raise RuntimeError("catalogue down")

    land, corridors, _ = reference
    providers = Providers([BrokenSar()], StubMet(), SyntheticAis(settings, FakeHttp(), land, corridors), StubSanctions())
    art = build_case(cases["IND-2025-05-MSC-ELSA3"], providers, LandMask(land), tmp_path)
    assert art["sar"]["providers"][0]["ok"] is False
    assert any("catalogue down" in w for w in art["warnings"])


def test_manual_registry_marks_matching_real_vessels_verified():
    from oceanspill.build import apply_manual_registry
    from oceanspill.providers.base import VesselRecord

    real = VesselRecord(key="IMO-9123221", name="MSC ELSA 3", type="Container Ship", role="source", provenance="real",
                        imo="9123221", registry={"verified": False})
    by_name = VesselRecord(key="REF-BW-MAPLE", name="BW Maple", type="Tanker", role="involved", provenance="real",
                           registry={"verified": False})
    synthetic = VesselRecord(key="MMSI-999000001", name="MSC ELSA 3", type="Tanker", role="background", provenance="synthetic",
                             registry={"verified": False, "synthetic": True})
    entries = [
        {"name": "MSC ELSA 3", "imo": "9123221", "lookedUpOn": "2026-09-16", "registeredOwner": "Example Owner", "pscDetentions": 1},
        {"name": "BW MAPLE", "imo": "9999999", "lookedUpOn": "2026-09-16", "flag": "Singapore"},
    ]
    apply_manual_registry([real, by_name, synthetic], entries)
    assert real.registry["verified"] and real.registry["pscDetentions"] == 1
    assert real.registry["details"] == {"registeredOwner": "Example Owner"}
    assert by_name.registry["verified"] and by_name.imo == "9999999"
    assert synthetic.registry["verified"] is False, "synthetic vessels never pick up real registry data"
