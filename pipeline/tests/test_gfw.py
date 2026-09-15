from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from conftest import FakeHttp
from oceanspill.build import detect_gaps
from oceanspill.config import Settings
from oceanspill.geo import parse_time
from oceanspill.providers import ProviderConfigError, Providers
from oceanspill.providers.ais_gfw import (
    API_URL, GAPS_DATASET, LOITERING_DATASET, GfwAis, consistent, event_anchors,
)
from oceanspill.providers.ais_synthetic import SyntheticAis

# Responses below follow the field names of the GFW API v3 models in the official
# gfw-api-python-client. They are constructed for the test, not recorded from the live API.
ELSA_OLD_ID = "old-elsa-identity"
ELSA_ID = "current-elsa-identity"
CANDIDATE_ID = "candidate-tanker-identity"

IDENTITY = {"entries": [{"selfReportedInfo": [
    {"id": ELSA_OLD_ID, "ssvid": "636016814", "shipname": "MSC ELSA 3", "flag": "LBR",
     "transmissionDateFrom": "2012-01-01T00:00:00Z", "transmissionDateTo": "2016-06-01T00:00:00Z"},
    {"id": ELSA_ID, "ssvid": "636016814", "shipname": "MSC ELSA 3", "flag": "LBR", "imo": "9123221",
     "transmissionDateFrom": "2016-06-02T00:00:00Z", "transmissionDateTo": "2025-05-25T02:00:00Z"},
]}]}

ELSA_GAP = {
    "id": "gap-elsa-1", "type": "gap", "start": "2025-05-24T00:00:00Z", "end": "2025-05-24T05:00:00Z",
    "position": {"lat": 8.8, "lon": 76.4},
    "vessel": {"id": ELSA_ID, "ssvid": "636016814", "name": "MSC ELSA 3"},
    "gap": {"durationHours": 5.0, "distanceKm": "34", "intentionalDisabling": False,
            "offPosition": {"lat": 8.8, "lon": 76.4}, "onPosition": {"lat": 9.1, "lon": 76.15}},
}

CANDIDATE_LOITER = {
    "id": "loiter-cand-1", "type": "loitering", "start": "2025-05-24T20:00:00Z", "end": "2025-05-24T23:00:00Z",
    "position": {"lat": 9.05, "lon": 75.9},
    "vessel": {"id": CANDIDATE_ID, "ssvid": "419000001", "name": "Test Product Carrier", "flag": "IND", "type": "BUNKER"},
    "loitering": {"totalTimeHours": 3, "averageSpeedKnots": 0.8},
}


class FakeGfwHttp(FakeHttp):
    def request_json(self, method: str, url: str, **kwargs: Any) -> Any:
        self.calls.append((method, url, kwargs))
        assert kwargs["headers"]["Authorization"] == "Bearer test-token"
        if url == f"{API_URL}/vessels/search":
            return IDENTITY if "636016814" in kwargs["params"]["where"] else {"entries": []}
        if url == f"{API_URL}/events":
            body = kwargs["json_body"]
            dataset = body["datasets"][0]
            if body.get("vessels") == [ELSA_ID] and dataset == GAPS_DATASET:
                return {"entries": [ELSA_GAP], "nextOffset": None}
            if "geometry" in body and dataset == LOITERING_DATASET:
                return {"entries": [CANDIDATE_LOITER, {**ELSA_GAP, "id": "dup"}], "nextOffset": None}
            return {"entries": []}
        raise AssertionError(f"unexpected request to {url}")


@pytest.fixture
def gfw(tmp_path, reference) -> tuple[GfwAis, FakeGfwHttp]:
    land, corridors, _ = reference
    settings = Settings(cache_dir=tmp_path / "cache", output_dir=tmp_path / "out", ais_provider="gfw", gfw_api_token="test-token")
    http = FakeGfwHttp()
    return GfwAis(settings, http, SyntheticAis(settings, http, land, corridors)), http


def _window(case):
    t = parse_time(case["incident"]["time"])
    return t - timedelta(hours=36), t + timedelta(hours=48)


def test_gap_event_becomes_real_anchors():
    anchors = event_anchors(ELSA_GAP)
    assert [a["event"].split(" ")[1] for a in anchors] == ["off", "back"]
    assert anchors[0]["lat"] == 8.8 and anchors[1]["lon"] == 76.15
    assert all("Global Fishing Watch" in a["source"] for a in anchors)


def test_inconsistent_gfw_anchor_is_dropped_but_reported_one_kept():
    reported = {"time": "2025-05-24T07:30:00Z", "event": "reported", "lat": 9.18, "lon": 76.1, "source": "SITREP-3"}
    impossible = {"time": "2025-05-24T08:00:00Z", "event": "gfw", "lat": 12.0, "lon": 74.0, "source": "Global Fishing Watch gap event x"}
    assert consistent([impossible, reported]) == [reported]


def test_resolves_identity_cuts_real_gap_and_adds_candidates(gfw, cases):
    ais, http = gfw
    case = cases["IND-2025-05-MSC-ELSA3"]
    start, end = _window(case)
    vessels, tracks = ais.tracks(case, start, end)
    by_name = {v.name: (v, t) for v, t in zip(vessels, tracks)}

    elsa, elsa_track = by_name["MSC ELSA 3"]
    assert elsa.registry["gfw"]["id"] == ELSA_ID, "must pick the identity transmitting during the window"
    assert any(a["event"].startswith("AIS off") for a in elsa.anchors)
    g0, g1 = parse_time(ELSA_GAP["start"]), parse_time(ELSA_GAP["end"])
    assert not any(g0 < p.t < g1 for p in elsa_track.pings)
    assert any(g["minutes"] >= 240 for g in detect_gaps(elsa_track))

    cand, cand_track = by_name["TEST PRODUCT CARRIER"]
    assert cand.provenance == "real" and cand.role == "candidate" and cand.mmsi == "419000001"
    first, last = parse_time(CANDIDATE_LOITER["start"]), parse_time(CANDIDATE_LOITER["end"])
    assert all(first - timedelta(hours=8, minutes=5) <= p.t <= last + timedelta(hours=8, minutes=5) for p in cand_track.pings)

    assert not any(v.provenance == "synthetic" for v in vessels), "real traffic replaces synthetic decoys"
    assert "dup" not in {a["source"].split()[-1] for v in vessels for a in v.anchors}, "known vessels are not re-added"
    assert case["analysis"]["backgroundVessels"] == 10, "the input case must not be mutated"


def test_gfw_without_token_is_a_config_error(tmp_path, reference):
    land, corridors, _ = reference
    settings = Settings(cache_dir=tmp_path, output_dir=tmp_path, ais_provider="gfw")
    with pytest.raises(ProviderConfigError, match="GFW_API_TOKEN"):
        Providers.from_settings(settings, FakeHttp(), land, corridors)
