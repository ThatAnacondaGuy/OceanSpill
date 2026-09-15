"""Worker tests with stand-in providers: scheduling, claiming and failure handling, no network."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from oceanspill.api.db import Base, Database
from oceanspill.api.models import AreaOfInterest, Job, Notification, SceneRecord
from oceanspill.api.settings import ApiSettings
from oceanspill.api.worker import Worker
from oceanspill.providers.base import SarScene


class FakeCatalogue:
    name = "eos04"

    def __init__(self, scenes: list[SarScene], fail: bool = False):
        self.scenes = scenes
        self.fail = fail
        self.searches = 0

    def search(self, bbox, start, end):
        self.searches += 1
        if self.fail:
            raise RuntimeError("catalogue unavailable")
        return self.scenes


class FakeProviders:
    def __init__(self, sar):
        self.sar = sar
        self.ais = object()


def scene(ident: str) -> SarScene:
    when = datetime.now(timezone.utc) - timedelta(days=1)
    return SarScene(id=ident, name=ident, platform="EOS-04", mode="MRS", product_type="L2B", collection="EOS04",
                    start=when, end=when, footprint=[[76.0, 9.0], [77.0, 9.0], [77.0, 10.0], [76.0, 10.0]],
                    orbit_direction="ASCENDING", online=True, provider="eos04", size_bytes=1024)


@pytest.fixture
def worker(tmp_path: Path) -> Worker:
    settings = ApiSettings(database_url=f"sqlite:///{tmp_path / 'worker.db'}", data_dir=tmp_path / "data",
                           storage_dir=tmp_path / "storage", jwt_secret="x", signing_secret="y")
    w = Worker(settings)
    w.db = Database(settings.database_url)
    Base.metadata.create_all(w.db.engine)
    with w.db.sessions() as db:
        db.add(AreaOfInterest(id="AOI-TEST", name="Test area", priority=1, north=10.0, south=9.0, east=77.0,
                              west=76.0, rationale="Test", monitored=True, built_in=True))
        db.add(AreaOfInterest(id="AOI-QUIET", name="Not watched", priority=2, north=13.0, south=12.0, east=81.0,
                              west=80.0, rationale="Test", monitored=False, built_in=True))
        db.commit()
    return w


def test_only_monitored_areas_are_scheduled(worker: Worker):
    with worker.db.sessions() as db:
        assert worker.schedule(db) == 3
        kinds = {(j.kind, j.params["aoiId"]) for j in db.query(Job).all()}
    assert kinds == {("scan-aoi", "AOI-TEST"), ("refresh-ais", "AOI-TEST"), ("refresh-forecast", "AOI-TEST")}


def test_work_already_queued_is_not_queued_again(worker: Worker):
    with worker.db.sessions() as db:
        assert worker.schedule(db) == 3
        assert worker.schedule(db) == 0


def test_a_job_is_only_claimed_once(worker: Worker):
    with worker.db.sessions() as db:
        db.add(Job(kind="scan-aoi", params={"aoiId": "AOI-TEST"}))
        db.commit()
        first = worker.claim(db)
        second = worker.claim(db)
    assert first is not None and first.status == "running"
    assert second is None


def test_scanning_records_new_scenes_and_tells_people_once(worker: Worker):
    catalogue = FakeCatalogue([scene("SCENE-A"), scene("SCENE-B")])
    worker._providers = FakeProviders([catalogue])
    with worker.db.sessions() as db:
        detail = worker.scan_aoi(db, {"aoiId": "AOI-TEST"})
        assert "2 new of 2" in detail
        assert db.query(SceneRecord).count() == 2
        assert db.query(Notification).count() == 1
        # A second scan finds the same scenes and adds nothing.
        assert "0 new of 2" in worker.scan_aoi(db, {"aoiId": "AOI-TEST"})
        assert db.query(SceneRecord).count() == 2
        assert db.query(Notification).count() == 1


def test_a_catalogue_that_is_down_does_not_stop_the_others(worker: Worker):
    good = FakeCatalogue([scene("SCENE-C")])
    broken = FakeCatalogue([], fail=True)
    worker._providers = FakeProviders([broken, good])
    with worker.db.sessions() as db:
        assert "1 new of 1" in worker.scan_aoi(db, {"aoiId": "AOI-TEST"})


def test_a_failing_job_is_recorded_and_the_queue_keeps_going(worker: Worker):
    worker._providers = FakeProviders([FakeCatalogue([scene("SCENE-D")])])
    with worker.db.sessions() as db:
        db.add(Job(kind="scan-aoi", params={"aoiId": "AOI-MISSING"}))
        db.add(Job(kind="scan-aoi", params={"aoiId": "AOI-TEST"}))
        db.commit()
        assert worker.run_once(db) == 2
        jobs = {j.params["aoiId"]: j for j in db.query(Job).all()}
    assert jobs["AOI-MISSING"].status == "failed" and "AOI-MISSING" in jobs["AOI-MISSING"].error
    assert jobs["AOI-TEST"].status == "done"


def test_an_unknown_job_kind_fails_cleanly(worker: Worker):
    with worker.db.sessions() as db:
        db.add(Job(kind="polish-the-brass", params={}))
        db.commit()
        worker.run_once(db)
        job = db.query(Job).one()
    assert job.status == "failed" and "polish-the-brass" in job.error
