from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

import requests

USER_AGENT = "OceanSpill-pipeline/0.1 (SIH 26143 prototype)"


class HttpError(RuntimeError):
    def __init__(self, status: int, url: str, body: str):
        super().__init__(f"HTTP {status} for {url}: {body[:300]}")
        self.status = status


class CachedHttp:
    """Small JSON/text HTTP client with an on-disk cache so repeated builds do not re-hit APIs."""

    def __init__(self, cache_dir: Path, offline: bool = False, session: requests.Session | None = None):
        self.cache_dir = cache_dir
        self.offline = offline
        self.session = session or requests.Session()
        self.session.headers.setdefault("User-Agent", USER_AGENT)

    def _key(self, method: str, url: str, params: Any, body: Any) -> Path:
        raw = json.dumps([method, url, params, body], sort_keys=True, default=str)
        return self.cache_dir / f"{hashlib.sha256(raw.encode()).hexdigest()}.json"

    def has_cached(self, method: str, url: str, *, params: dict | None = None, json_body: Any = None, data: dict | None = None) -> bool:
        return self._key(method, url, params, json_body if data is None else {"form": data}).exists()

    def request_json(
        self,
        method: str,
        url: str,
        *,
        params: dict | None = None,
        json_body: Any = None,
        data: dict | None = None,
        headers: dict | None = None,
        cache: bool = True,
        max_age_s: float | None = None,
        timeout: float = 60,
        retries: int = 3,
    ) -> Any:
        # Form bodies join the cache key only when present, so existing cached responses keep their keys.
        path = self._key(method, url, params, json_body if data is None else {"form": data})
        if cache and path.exists():
            if max_age_s is None or time.time() - path.stat().st_mtime < max_age_s:
                return json.loads(path.read_text())
        if self.offline:
            raise RuntimeError(f"offline mode: no cached response for {method} {url}")

        last: Exception | None = None
        for attempt in range(retries):
            try:
                resp = self.session.request(
                    method, url, params=params, json=json_body, data=data, headers=headers, timeout=timeout
                )
            except requests.RequestException as exc:
                last = exc
                time.sleep(1.5 * (attempt + 1))
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                last = HttpError(resp.status_code, url, resp.text)
                time.sleep(2.0 * (attempt + 1))
                continue
            if resp.status_code >= 400:
                raise HttpError(resp.status_code, url, resp.text)
            payload = resp.json()
            if cache:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(payload))
            return payload
        raise last if last else RuntimeError(f"request failed: {url}")

    def get_text(self, url: str, *, cache: bool = True, max_age_s: float | None = None, timeout: float = 120) -> str:
        path = self._key("GET-TEXT", url, None, None).with_suffix(".txt")
        if cache and path.exists():
            if max_age_s is None or time.time() - path.stat().st_mtime < max_age_s:
                return path.read_text()
        if self.offline:
            raise RuntimeError(f"offline mode: no cached response for GET {url}")
        resp = self.session.get(url, timeout=timeout)
        if resp.status_code >= 400:
            raise HttpError(resp.status_code, url, resp.text)
        if cache:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(resp.text)
        return resp.text

    def download(self, url: str, dest: Path, *, headers: dict | None = None, params: dict | None = None) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        with self.session.get(url, headers=headers, params=params, stream=True, timeout=600) as resp:
            if resp.status_code >= 400:
                raise HttpError(resp.status_code, url, resp.text)
            with tmp.open("wb") as fh:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    fh.write(chunk)
        tmp.replace(dest)
        return dest
