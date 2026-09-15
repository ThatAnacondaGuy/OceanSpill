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
    # The same MMSI reused by an unnamed transmitter that stays active after the sinking.
    {"id": "unnamed-reuse", "ssvid": "636016814", "shipname": None,
     "transmissionDateFrom": "2015-07-23T00:00:00Z", "transmissionDateTo": "2026-03-15T00:00:00Z"},
    {"id": ELSA_ID, "ssvid": "636016814", "shipname": "MSC ELSA3", "flag": "LBR", "imo": "9123221",
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


NET_BUOY = {**CANDIDATE_LOITER, "id": "buoy-1",
            "vessel": {"id": "net-buoy", "ssvid": "419520219", "name": "ABINAYA NET2  56%", "type": "GEAR"}}

# A reported responder with no MMSI in the case file, seen by GFW under the same name.
HANE_YI_LOITER = {**CANDIDATE_LOITER, "id": "loiter-hane-yi", "start": "2025-05-25T03:00:00Z", "end": "2025-05-25T05:00:00Z",
                  "position": {"lat": 9.30, "lon": 76.12},
                  "vessel": {"id": "hane-yi-identity", "ssvid": "477000001", "name": "Hane Yi", "flag": "HKG", "type": "CARGO"}}


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
                return {"entries": [CANDIDATE_LOITER, {**ELSA_GAP, "id": "dup"}, NET_BUOY, HANE_YI_LOITER], "nextOffset": None}
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
    assert elsa.registry["gfw"]["id"] == ELSA_ID, "must pick the matching identity, not a reused MMSI"
    assert any(a["event"].startswith("AIS off") for a in elsa.anchors)
    g0, g1 = parse_time(ELSA_GAP["start"]), parse_time(ELSA_GAP["end"])
    assert not any(g0 < p.t < g1 for p in elsa_track.pings)
    assert any(g["minutes"] >= 240 for g in detect_gaps(elsa_track))

    cand, cand_track = by_name["TEST PRODUCT CARRIER"]
    assert cand.provenance == "real" and cand.role == "candidate" and cand.mmsi == "419000001"
    first, last = parse_time(CANDIDATE_LOITER["start"]), parse_time(CANDIDATE_LOITER["end"])
    assert all(first - timedelta(hours=8, minutes=5) <= p.t <= last + timedelta(hours=8, minutes=5) for p in cand_track.pings)

    assert "ABINAYA NET2  56%" not in by_name, "fishing-gear buoys are not candidate vessels"
    hane_yi, _ = by_name["HANE YI"]
    assert hane_yi.role == "responder" and hane_yi.mmsi == "477000001", "same-name area vessel is merged, not duplicated"
    assert sum(1 for v in vessels if v.name.upper() == "HANE YI") == 1

    assert not any(v.provenance == "synthetic" for v in vessels), "real traffic replaces synthetic decoys"
    assert "dup" not in {a["source"].split()[-1] for v in vessels for a in v.anchors}, "known vessels are not re-added"
    assert case["analysis"]["backgroundVessels"] == 10, "the input case must not be mutated"


def test_gfw_without_token_is_a_config_error(tmp_path, reference):
    land, corridors, _ = reference
    settings = Settings(cache_dir=tmp_path, output_dir=tmp_path, ais_provider="gfw")
    with pytest.raises(ProviderConfigError, match="GFW_API_TOKEN"):
        Providers.from_settings(settings, FakeHttp(), land, corridors)


def test_identity_outside_the_window_is_kept_as_a_fact(gfw, cases):
    ais, _ = gfw
    case = cases["IND-2025-05-MSC-ELSA3"]
    start, end = _window(case)
    vessel = {"name": "MSC ELSA 3", "mmsi": "636016814", "imo": "9123221"}
    ident = ais.identity(vessel, start + timedelta(days=400), end + timedelta(days=400))
    assert ident["id"] == ELSA_ID and ident["inWindow"] is False


# Presence rows use the fields seen in a live 4Wings report response (date, lat, lon, hours, vesselId, mmsi,
# imo, shipName, vesselType, flag); the values here are constructed for the test.
def _row(vid, hour, lat, lon, **meta):
    return {"date": hour, "lat": lat, "lon": lon, "hours": 1, "vesselId": vid, **meta}


def _presence_rows():
    rows = []
    elsa = {"mmsi": "636016814", "imo": "9123221", "shipName": "MSC ELSA3", "vesselType": "CARGO", "flag": "LBR"}
    for i, h in enumerate(["2025-05-24 20:00", "2025-05-24 21:00", "2025-05-24 22:00", "2025-05-25 02:00"]):
        rows.append(_row("elsa-presence", h, 9.25 + 0.01 * i, 76.13, **elsa))
    hanyi = {"mmsi": "566387000", "shipName": "HAN YI", "vesselType": "CARGO", "flag": "SGP"}
    rows += [_row("hanyi", "2025-05-25 03:00", 9.30, 76.10, **hanyi), _row("hanyi", "2025-05-25 04:00", 9.31, 76.11, **hanyi)]
    tanker = {"mmsi": "419000999", "shipName": "PASSING TANKER", "vesselType": "OTHER", "flag": "IND"}
    rows += [_row("tanker", "2025-05-24 23:00", 9.40, 76.00, **tanker), _row("tanker", "2025-05-25 00:00", 9.50, 75.90, **tanker)]
    rows.append(_row("buoy", "2025-05-24 23:00", 9.2, 76.2, mmsi="419520219", shipName="NET 2 56%", vesselType="GEAR"))
    return rows


class FakePresenceHttp(FakeGfwHttp):
    def request_json(self, method: str, url: str, **kwargs: Any) -> Any:
        if url == f"{API_URL}/4wings/report":
            self.calls.append((method, url, kwargs))
            assert kwargs["params"]["temporal-resolution"] == "HOURLY"
            d0, d1 = kwargs["params"]["date-range"].split(",")
            rows = [r for r in _presence_rows() if d0 <= r["date"][:10] < d1]
            return {"entries": [{"public-global-presence:v3.0": rows}]}
        return super().request_json(method, url, **kwargs)


def test_presence_gives_real_tracks_matches_reported_vessels_and_skips_gear(tmp_path, reference, cases):
    land, corridors, _ = reference
    settings = Settings(cache_dir=tmp_path, output_dir=tmp_path, ais_provider="gfw", gfw_api_token="test-token")
    http = FakePresenceHttp()
    ais = GfwAis(settings, http, SyntheticAis(settings, http, land, corridors))
    case = cases["IND-2025-05-MSC-ELSA3"]
    start, end = _window(case)
    vessels, tracks = ais.tracks(case, start, end)
    by_name = {v.name: (v, t) for v, t in zip(vessels, tracks)}

    elsa, elsa_track = by_name["MSC ELSA 3"]
    assert elsa_track.provenance == "real" and len(elsa_track.pings) == 4
    assert elsa_track.pings[0].t == parse_time("2025-05-24T20:30:00Z")
    assert [g["minutes"] for g in elsa_track.gaps] == [240], "the 22:00 to 02:00 silence inside the area is a gap"

    hane_yi, hane_track = by_name["HANE YI"]
    assert hane_track.provenance == "real" and hane_yi.mmsi == "566387000", "HAN YI in AIS is the reported HANE YI"

    silver, silver_track = by_name["MSC SILVER III"]
    assert silver_track.provenance != "real", "vessels not seen in presence keep interpolated tracks"

    tanker, tanker_track = by_name["PASSING TANKER"]
    assert tanker.role == "candidate" and tanker.provenance == "real" and tanker_track.provenance == "real"
    assert tanker_track.pings[0].sog > 5
    assert not any("NET" in v.name for v in vessels), "fishing gear is excluded"
    assert not any(v.provenance == "synthetic" for v in vessels)


def test_presence_gap_near_area_edge_is_not_counted():
    from datetime import datetime, timezone
    from oceanspill.providers.ais_gfw import presence_gaps

    box = {"west": 75.0, "south": 8.0, "east": 77.0, "north": 10.0}
    t = datetime(2025, 5, 24, tzinfo=timezone.utc)
    inside = [(t, 9.0, 76.0), (t + timedelta(hours=5), 9.1, 76.1)]
    leaving = [(t, 9.0, 75.02), (t + timedelta(hours=5), 9.1, 76.1)]
    assert len(presence_gaps(inside, box)) == 1
    assert presence_gaps(leaving, box) == []


def test_vessel_known_to_be_silent_gets_no_invented_pings(tmp_path, reference, cases):
    land, corridors, _ = reference
    settings = Settings(cache_dir=tmp_path, output_dir=tmp_path, ais_provider="gfw", gfw_api_token="test-token")
    http = FakePresenceHttp()
    ais = GfwAis(settings, http, SyntheticAis(settings, http, land, corridors))
    case = cases["IND-2025-05-MSC-ELSA3"]
    start, end = _window(case)
    later = (start + timedelta(days=400), end + timedelta(days=400))
    vessels, tracks = ais.tracks(case, *later)
    elsa_track = next(t for v, t in zip(vessels, tracks) if v.name == "MSC ELSA 3")
    assert elsa_track.pings == [] and "No AIS transmissions" in elsa_track.notes[0]
