"""Server tests: sign-in, permissions, workflow rules, clearance redaction and signed documents.

Everything runs against a temporary SQLite database and a small artifact tree, so the suite needs
no PostgreSQL and no network.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from oceanspill.api.app import create_app
from oceanspill.api.db import Base, Database
from oceanspill.api.models import AreaOfInterest, Notification, User
from oceanspill.api.security import hash_password
from oceanspill.api.settings import ApiSettings

CASE_ID = "IND-2025-05-TEST"

ACCOUNTS = [
    ("U-001", "Admin Example", "admin@example.gov.in", "NTRO Admin", "Secret"),
    ("U-002", "Analyst Example", "analyst@example.gov.in", "Analyst", "Confidential"),
    ("U-003", "Viewer Example", "viewer@example.gov.in", "Viewer", "Restricted"),
    ("U-004", "Liaison Example", "liaison@example.gov.in", "Liaison", "Secret"),
]
PASSWORD = "Harbour-Watch-2026"


def _artifacts(root: Path) -> None:
    (root / "cases").mkdir(parents=True)
    (root / "forcing").mkdir(parents=True)
    (root / "index.json").write_text(json.dumps({
        "schemaVersion": 1, "generatedAt": "2026-01-01T00:00:00Z",
        "providers": [{"kind": "sar", "name": "eos04", "agency": "ISRO / NRSC", "sovereign": True,
                       "available": True, "message": "Credentials configured"}],
        "cases": [{"id": CASE_ID, "title": "Test spill", "region": "Kerala Coast", "file": f"cases/{CASE_ID}.json",
                   "incidentTime": "2025-05-24T07:30:00Z", "position": {"lat": 9.2, "lon": 76.1},
                   "sourceType": "vessel", "sarScenes": 1, "forcing": True, "warnings": 0}],
        "historical": [], "failures": [],
    }))
    (root / "cases" / f"{CASE_ID}.json").write_text(json.dumps({
        "schemaVersion": 1,
        "case": {"id": CASE_ID, "title": "Test spill", "region": "Kerala Coast", "subRegion": "Arabian Sea",
                 "incidentTime": "2025-05-24T07:30:00Z", "sourceType": "vessel", "reportedBy": "DG Shipping",
                 "facts": {"incident": {"position": {"lat": 9.2, "lon": 76.1}, "timePrecision": "minute",
                                        "positionPrecisionKm": 0.5}},
                 "vessels": [{"role": "source", "name": "TEST CARRIER", "imo": "9123221", "mmsi": "636016814"}]},
        "vessels": [{"key": "MMSI-636016814", "name": "TEST CARRIER", "mmsi": "636016814", "imo": "9123221",
                     "flag": "Liberia", "type": "Container Ship", "registry": {"details": {"owner": "Example Ltd"}}}],
        "tracks": [{"key": "MMSI-636016814", "pings": []}],
        "sanctions": [{"key": "MMSI-636016814", "imo": "9123221", "listed": False}],
        "sarMeasurements": [{"scene": "SCENE-1", "product": "EOS-04 MRS", "polarisation": "VV",
                             "quicklook": "sar/IND-2025-05-TEST/SCENE-1.png", "spots": []}],
        "warnings": [],
    }))
    (root / "forcing" / f"{CASE_ID}.json").write_text(json.dumps({"lats": [9.0], "lons": [76.0]}))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    data_dir = tmp_path / "data"
    _artifacts(data_dir)
    settings = ApiSettings(
        database_url=f"sqlite:///{tmp_path / 'test.db'}", data_dir=data_dir, storage_dir=tmp_path / "storage",
        jwt_secret="test-jwt-secret", signing_secret="test-signing-secret",
    )
    app = create_app(settings, create_tables=True)
    db: Database = app.state.oceanspill.db
    Base.metadata.create_all(db.engine)
    with db.sessions() as s:
        for uid, name, email, role, clearance in ACCOUNTS:
            s.add(User(id=uid, name=name, email=email, role=role, agency="Test", clearance=clearance,
                       status="Active", password_hash=hash_password(PASSWORD)))
        s.add(AreaOfInterest(id="AOI-TEST", name="Test area", priority=1, north=10.0, south=9.0, east=77.0,
                             west=76.0, rationale="Test", built_in=True))
        s.commit()
    return TestClient(app)


def token(client: TestClient, email: str) -> str:
    res = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert res.status_code == 200, res.text
    return res.json()["token"]


def auth(client: TestClient, email: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token(client, email)}"}


# --- sign-in ---------------------------------------------------------------------------------


def test_login_returns_a_token_and_the_account(client: TestClient):
    res = client.post("/api/auth/login", json={"email": "admin@example.gov.in", "password": PASSWORD})
    body = res.json()
    assert res.status_code == 200
    assert body["user"]["role"] == "NTRO Admin"
    assert "passwordHash" not in json.dumps(body)


def test_wrong_password_is_rejected_and_locks_after_five_tries(client: TestClient):
    for _ in range(5):
        res = client.post("/api/auth/login", json={"email": "analyst@example.gov.in", "password": "wrong-password"})
        assert res.status_code == 401
    res = client.post("/api/auth/login", json={"email": "analyst@example.gov.in", "password": PASSWORD})
    assert res.status_code == 423


def test_unknown_account_gives_the_same_message_as_a_wrong_password(client: TestClient):
    unknown = client.post("/api/auth/login", json={"email": "nobody@example.gov.in", "password": PASSWORD})
    wrong = client.post("/api/auth/login", json={"email": "analyst@example.gov.in", "password": "wrong-password"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]


def test_requests_without_a_token_are_refused(client: TestClient):
    assert client.get("/api/state").status_code == 401


def test_signing_out_ends_the_session(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_changing_a_password_needs_the_current_one_and_a_strong_new_one(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    assert client.post("/api/auth/password", json={"current": "wrong", "new": "Another-Strong-1"}, headers=headers).status_code == 400
    weak = client.post("/api/auth/password", json={"current": PASSWORD, "new": "short"}, headers=headers)
    assert weak.status_code == 400 and "12 characters" in weak.json()["detail"]
    assert client.post("/api/auth/password", json={"current": PASSWORD, "new": "Another-Strong-1"}, headers=headers).status_code == 200


# --- permissions -----------------------------------------------------------------------------


def test_a_viewer_cannot_change_a_case(client: TestClient):
    res = client.patch(f"/api/cases/{CASE_ID}/state", json={"workflowStage": "Patrol En Route"},
                       headers=auth(client, "viewer@example.gov.in"))
    assert res.status_code == 403


def test_only_an_administrator_reaches_the_accounts_page(client: TestClient):
    assert client.get("/api/users", headers=auth(client, "analyst@example.gov.in")).status_code == 403
    assert client.get("/api/users", headers=auth(client, "admin@example.gov.in")).status_code == 200


def test_a_liaison_can_read_cases_but_not_advance_them(client: TestClient):
    headers = auth(client, "liaison@example.gov.in")
    assert client.get("/api/state", headers=headers).status_code == 200
    assert client.patch(f"/api/cases/{CASE_ID}/state", json={"status": "Verified"}, headers=headers).status_code == 403


# --- workflow rules --------------------------------------------------------------------------


def test_a_case_moves_one_stage_at_a_time(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    skip = client.patch(f"/api/cases/{CASE_ID}/state", json={"workflowStage": "Forensic Match Pending"}, headers=headers)
    assert skip.status_code == 422
    step = client.patch(f"/api/cases/{CASE_ID}/state", json={"workflowStage": "Patrol En Route"}, headers=headers)
    assert step.status_code == 200 and step.json()["workflowStage"] == "Patrol En Route"


def test_a_status_needs_the_workflow_to_reach_its_stage(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    early = client.patch(f"/api/cases/{CASE_ID}/state", json={"status": "Verified"}, headers=headers)
    assert early.status_code == 422 and "Sample Collected" in early.json()["detail"]
    for stage in ("Patrol En Route", "Sample Collected"):
        assert client.patch(f"/api/cases/{CASE_ID}/state", json={"workflowStage": stage}, headers=headers).status_code == 200
    assert client.patch(f"/api/cases/{CASE_ID}/state", json={"status": "Verified"}, headers=headers).status_code == 200


def test_two_people_editing_the_same_case_do_not_overwrite_each_other(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    first = client.patch(f"/api/cases/{CASE_ID}/state", json={"workflowStage": "Patrol En Route", "version": 1}, headers=headers)
    assert first.status_code == 200
    stale = client.patch(f"/api/cases/{CASE_ID}/state", json={"workflowStage": "Sample Collected", "version": 1}, headers=headers)
    assert stale.status_code == 409


def test_every_change_is_written_to_the_audit_trail(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    client.patch(f"/api/cases/{CASE_ID}/state", json={"workflowStage": "Patrol En Route"}, headers=headers)
    entries = client.get("/api/state", headers=headers).json()["audit"]
    actions = [e["action"] for e in entries]
    assert "Workflow advanced" in actions and "Signed in" in actions
    assert all(e["actor"] for e in entries)


# --- clearance -------------------------------------------------------------------------------


def test_restricted_clearance_hides_vessel_identifiers(client: TestClient):
    full = client.get(f"/api/data/cases/{CASE_ID}.json", headers=auth(client, "admin@example.gov.in")).json()
    limited = client.get(f"/api/data/cases/{CASE_ID}.json", headers=auth(client, "viewer@example.gov.in")).json()
    assert full["vessels"][0]["mmsi"] == "636016814"
    assert limited["vessels"][0]["mmsi"] is None
    assert limited["vessels"][0]["imo"] is None
    assert limited["case"]["vessels"][0]["mmsi"] is None
    assert limited["redacted"] is True
    assert "636016814" not in json.dumps(limited)


def test_pseudonyms_keep_vessels_matched_to_their_tracks(client: TestClient):
    limited = client.get(f"/api/data/cases/{CASE_ID}.json", headers=auth(client, "viewer@example.gov.in")).json()
    key = limited["vessels"][0]["key"]
    assert key.startswith("V-")
    assert limited["tracks"][0]["key"] == key
    assert limited["sanctions"][0]["key"] == key


def test_sar_imagery_is_withheld_at_restricted_clearance(client: TestClient):
    limited = client.get(f"/api/data/cases/{CASE_ID}.json", headers=auth(client, "viewer@example.gov.in")).json()
    assert limited["sarMeasurements"][0]["quicklook"] is None
    assert client.get("/api/data/sar/IND-2025-05-TEST/SCENE-1.png",
                      headers=auth(client, "viewer@example.gov.in")).status_code in {403, 404}


# --- artifacts -------------------------------------------------------------------------------


def test_artifacts_are_served_at_the_paths_the_web_app_expects(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    index = client.get("/api/data/index.json", headers=headers)
    assert index.status_code == 200 and index.json()["cases"][0]["file"] == f"cases/{CASE_ID}.json"
    assert client.get(f"/api/data/{index.json()['cases'][0]['file']}", headers=headers).status_code == 200
    assert client.get(f"/api/data/forcing/{CASE_ID}.json", headers=headers).status_code == 200


def test_a_path_outside_the_data_directory_is_refused(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    assert client.get("/api/data/../../etc/passwd", headers=headers).status_code == 404
    assert client.get("/api/data/cases/../../index.json", headers=headers).status_code == 404


def test_unchanged_artifacts_are_not_sent_twice(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    first = client.get("/api/data/index.json", headers=headers)
    again = client.get("/api/data/index.json", headers={**headers, "If-None-Match": first.headers["etag"]})
    assert again.status_code == 304


# --- actions ---------------------------------------------------------------------------------


def test_drafting_an_alert_records_it_against_the_case(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    res = client.post("/api/alerts", headers=headers, json={
        "caseId": CASE_ID, "channel": ["SMS"], "languages": ["English"], "districts": ["Alappuzha"],
        "headline": "Avoid the shoreline", "body": "Oil reported offshore.", "noGoRadiusKm": 5,
        "centre": {"lat": 9.2, "lon": 76.1},
    })
    assert res.status_code == 200
    state = client.get("/api/state", headers=headers).json()
    assert state["alerts"][0]["headline"] == "Avoid the shoreline"
    assert state["cases"][CASE_ID]["alertDispatched"] is True


def test_a_new_planning_area_is_checked_before_it_is_stored(client: TestClient):
    headers = auth(client, "admin@example.gov.in")
    bad = client.post("/api/aois", headers=headers, json={
        "name": "Upside down", "priority": 3, "bounds": {"north": 8.0, "south": 9.0, "east": 77.0, "west": 76.0}})
    assert bad.status_code == 422
    good = client.post("/api/aois", headers=headers, json={
        "name": "Test approach", "priority": 3, "bounds": {"north": 10.0, "south": 9.0, "east": 77.0, "west": 76.0}})
    assert good.status_code == 200 and good.json()["provenance"] == "session"


def test_a_field_report_can_be_linked_to_a_case(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    report = client.post("/api/sightings", headers=headers, json={
        "reporter": "Coastal watcher", "district": "Alappuzha", "position": {"lat": 9.3, "lon": 76.2},
        "description": "Sheen along the beach", "severity": "Sheen"}).json()
    assert client.post(f"/api/sightings/{report['id']}/link", json={"caseId": CASE_ID}, headers=headers).status_code == 200
    linked = client.get("/api/state", headers=headers).json()["sightings"][0]
    assert linked["linkedCaseId"] == CASE_ID


# --- accounts --------------------------------------------------------------------------------


def test_an_administrator_creates_an_account_and_sets_its_password(client: TestClient):
    headers = auth(client, "admin@example.gov.in")
    created = client.post("/api/users", headers=headers, json={
        "name": "New Officer", "email": "new.officer@example.gov.in", "role": "Regulator",
        "agency": "DG Shipping", "clearance": "Confidential", "status": "Active"})
    assert created.status_code == 200 and created.json()["hasPassword"] is False
    assert client.post("/api/auth/login", json={"email": "new.officer@example.gov.in", "password": PASSWORD}).status_code == 401
    user_id = created.json()["id"]
    assert client.post(f"/api/users/{user_id}/password", json={"password": PASSWORD}, headers=headers).status_code == 200
    assert client.post("/api/auth/login", json={"email": "new.officer@example.gov.in", "password": PASSWORD}).status_code == 200


def test_suspending_an_account_signs_it_out(client: TestClient):
    admin = auth(client, "admin@example.gov.in")
    analyst = auth(client, "analyst@example.gov.in")
    assert client.get("/api/auth/me", headers=analyst).status_code == 200
    assert client.patch("/api/users/U-002", json={"status": "Suspended"}, headers=admin).status_code == 200
    assert client.get("/api/auth/me", headers=analyst).status_code == 401


def test_an_account_email_must_be_unique(client: TestClient):
    headers = auth(client, "admin@example.gov.in")
    res = client.post("/api/users", headers=headers, json={
        "name": "Duplicate", "email": "analyst@example.gov.in", "role": "Analyst", "agency": "Test"})
    assert res.status_code == 409


# --- documents -------------------------------------------------------------------------------


def test_a_chain_of_custody_document_is_a_pdf_that_verifies(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    res = client.post(f"/api/cases/{CASE_ID}/chain-of-custody", headers=headers)
    assert res.status_code == 200 and res.content[:4] == b"%PDF"
    check = client.post("/api/documents/verify", headers=headers,
                        files={"file": ("record.pdf", res.content, "application/pdf")})
    assert check.status_code == 200 and check.json()["verified"] is True
    assert check.json()["document"]["id"] == res.headers["x-document-id"]


def test_an_altered_document_does_not_verify(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    original = client.post(f"/api/cases/{CASE_ID}/chain-of-custody", headers=headers).content
    # PDF content is compressed, so alter a byte in the stream rather than looking for words.
    middle = len(original) // 2
    tampered = original[:middle] + bytes([original[middle] ^ 0x01]) + original[middle + 1:]
    assert tampered != original
    check = client.post("/api/documents/verify", headers=headers,
                        files={"file": ("record.pdf", tampered, "application/pdf")})
    assert check.json()["verified"] is False


def test_a_report_composed_on_screen_is_rendered_and_listed(client: TestClient):
    headers = auth(client, "analyst@example.gov.in")
    res = client.post("/api/reports", headers=headers, json={
        "caseId": CASE_ID, "kind": "summary", "title": "Weekly summary",
        "sections": [{"heading": "Cases", "columns": ["Case", "Status"], "rows": [[CASE_ID, "Under Analysis"]]}]})
    assert res.status_code == 200 and res.content[:4] == b"%PDF"
    listed = client.get("/api/documents", headers=headers).json()
    assert listed[0]["title"] == "Weekly summary"


def test_a_restricted_viewer_sees_no_identifiers_in_the_case_record(client: TestClient):
    res = client.post(f"/api/cases/{CASE_ID}/chain-of-custody", headers=auth(client, "viewer@example.gov.in"))
    assert res.status_code == 200
    assert b"636016814" not in res.content


# --- monitoring ------------------------------------------------------------------------------


def _watch_data(client: TestClient) -> None:
    from datetime import datetime, timedelta, timezone

    from oceanspill.api.models import Detection, SceneRecord

    now = datetime.now(timezone.utc)
    with client.app.state.oceanspill.db.sessions() as s:
        s.add(SceneRecord(id="S1A-TEST-SCENE", provider="cdse", platform="SENTINEL-1A", start=now - timedelta(hours=6),
                          footprint=[[76.0, 9.0], [77.0, 9.0], [77.0, 10.0], [76.0, 10.0]], aoi_id="AOI-TEST",
                          size_bytes=1024, online=True, status="processed"))
        s.add(Detection(id="DET-TEST-001", scene_id="S1A-TEST-SCENE", aoi_id="AOI-TEST", acquired_at=now - timedelta(hours=6),
                        outline=[{"lat": 9.2, "lon": 76.2}], lat=9.2, lon=76.2, area_km2=3.4, method="classical",
                        measurements={"contrastDb": 5.2}))
        s.commit()


def test_new_detections_are_listed_for_review(client: TestClient):
    _watch_data(client)
    headers = auth(client, "analyst@example.gov.in")
    summary = client.get("/api/monitoring/summary", headers=headers).json()
    assert summary["scenesLastDay"] == 1
    assert [d["id"] for d in summary["newDetections"]] == ["DET-TEST-001"]
    assert client.get("/api/scenes", headers=headers).json()[0]["id"] == "S1A-TEST-SCENE"


def test_reviewing_a_detection_records_who_decided_and_why(client: TestClient):
    _watch_data(client)
    headers = auth(client, "analyst@example.gov.in")
    res = client.post("/api/detections/DET-TEST-001/review", headers=headers,
                      json={"status": "dismissed", "notes": "Low wind; biogenic film"})
    assert res.status_code == 200 and res.json()["status"] == "dismissed"
    assert client.get("/api/monitoring/summary", headers=headers).json()["newDetections"] == []
    trail = client.get("/api/state", headers=headers).json()["audit"]
    assert any("look-alike" in e["action"] and e["detail"].startswith("Low wind") for e in trail)


def test_ais_tracks_come_back_grouped_by_vessel_and_dated(client: TestClient):
    from datetime import datetime, timedelta, timezone

    from oceanspill.api.models import AisPosition

    now = datetime.now(timezone.utc)
    with client.app.state.oceanspill.db.sessions() as s:
        for minutes in (0, 60, 120):
            s.add(AisPosition(vessel_id="gfw-abc-123", mmsi="563812000", t=now - timedelta(minutes=minutes),
                              lat=9.2 + minutes / 1000, lon=76.1, source="gfw", aoi_id="AOI-TEST"))
        # A second vessel, and one the feed gave no MMSI for.
        s.add(AisPosition(vessel_id="gfw-def-456", mmsi=None, t=now - timedelta(minutes=30),
                          lat=9.4, lon=76.3, source="gfw", aoi_id="AOI-TEST"))
        s.commit()

    body = client.get("/api/ais/tracks?hours=24", headers=auth(client, "analyst@example.gov.in")).json()
    assert body["vessels"] == 2 and body["positions"] == 4
    track = next(t for t in body["tracks"] if t["vesselId"] == "gfw-abc-123")
    assert len(track["points"]) == 3 and track["mmsi"] == "563812000"
    # A vessel the feed did not name keeps a null MMSI rather than borrowing the identifier.
    assert next(t for t in body["tracks"] if t["vesselId"] == "gfw-def-456")["mmsi"] is None
    assert body["lagHours"] is not None and body["lagHours"] < 1


def test_the_ais_answer_says_how_far_behind_the_feed_is(client: TestClient):
    from datetime import datetime, timedelta, timezone

    from oceanspill.api.models import AisPosition

    with client.app.state.oceanspill.db.sessions() as s:
        s.add(AisPosition(vessel_id="gfw-old", mmsi=None, t=datetime.now(timezone.utc) - timedelta(days=3),
                          lat=9.0, lon=76.0, source="gfw", aoi_id="AOI-TEST"))
        s.commit()
    body = client.get("/api/ais/tracks?hours=168", headers=auth(client, "analyst@example.gov.in")).json()
    assert 70 < body["lagHours"] < 74
    assert "not a live picture" in body["note"].lower()


def test_a_viewer_cannot_queue_background_work(client: TestClient):
    assert client.post("/api/jobs", json={"kind": "scan-aoi", "params": {"aoiId": "AOI-TEST"}},
                       headers=auth(client, "viewer@example.gov.in")).status_code == 403
    queued = client.post("/api/jobs", json={"kind": "scan-aoi", "params": {"aoiId": "AOI-TEST"}},
                         headers=auth(client, "admin@example.gov.in"))
    assert queued.status_code == 200 and queued.json()["status"] == "queued"


def test_an_unknown_job_kind_is_refused_at_the_door(client: TestClient):
    res = client.post("/api/jobs", json={"kind": "polish-the-brass", "params": {}},
                      headers=auth(client, "admin@example.gov.in"))
    assert res.status_code == 422


# --- notifications and health ----------------------------------------------------------------


def test_notifications_respect_what_a_role_may_see(client: TestClient):
    app = client.app
    with app.state.oceanspill.db.sessions() as s:
        s.add(Notification(title="Queue backed up", body="4 jobs waiting", kind="warning", module="data"))
        s.add(Notification(title="New detection", body="Kerala coast", kind="info", module="incidents"))
        s.commit()
    viewer = client.get("/api/notifications", headers=auth(client, "viewer@example.gov.in")).json()
    admin = client.get("/api/notifications", headers=auth(client, "admin@example.gov.in")).json()
    assert {n["title"] for n in viewer} == {"New detection"}
    assert {n["title"] for n in admin} == {"Queue backed up", "New detection"}


def test_health_reports_the_database_and_the_artifacts(client: TestClient):
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["checks"]["database"] == "ok"
    assert body["checks"]["artifacts"].startswith("ok (1 case")
