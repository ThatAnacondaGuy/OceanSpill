from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from oceanspill.build import load_cases, load_reference
from oceanspill.config import Settings

FIXTURES = Path(__file__).parent / "fixtures"


def fixture_json(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


class FakeHttp:
    """Stands in for CachedHttp: returns canned responses keyed by URL prefix, records calls."""

    def __init__(self, routes: dict[str, Any] | None = None, text_routes: dict[str, str] | None = None):
        self.routes = routes or {}
        self.text_routes = text_routes or {}
        self.calls: list[tuple[str, str, dict]] = []

    def _match(self, table: dict, url: str) -> Any:
        for prefix, value in table.items():
            if url.startswith(prefix):
                return value(url) if callable(value) else value
        raise AssertionError(f"unexpected request to {url}")

    def request_json(self, method: str, url: str, **kwargs: Any) -> Any:
        self.calls.append((method, url, kwargs))
        return self._match(self.routes, url)

    def get_text(self, url: str, **kwargs: Any) -> str:
        self.calls.append(("GET-TEXT", url, kwargs))
        return self._match(self.text_routes, url)


@pytest.fixture(scope="session")
def reference() -> tuple[dict, list[dict], dict]:
    return load_reference()


@pytest.fixture(scope="session")
def cases() -> dict[str, dict]:
    return {c["id"]: c for c in load_cases()}


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(cache_dir=tmp_path / "cache", output_dir=tmp_path / "out")
