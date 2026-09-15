"""Object storage for large files (SAR scenes, quicklooks, forecast grids, generated reports).

Local disk by default; any S3-compatible store (MinIO, AWS, NIC object storage) when S3_BUCKET is
set. Keys are forward-slash paths such as "scenes/<id>.zip".
"""
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .settings import ApiSettings


class Storage(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def path_for(self, key: str) -> Path | None: ...


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not str(path).startswith(str(self.root.resolve())):
            raise ValueError("storage key escapes the storage root")
        return path

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def path_for(self, key: str) -> Path | None:
        return self._path(key)


class S3Storage:  # pragma: no cover - needs a live bucket
    def __init__(self, bucket: str, endpoint: str | None):
        try:
            import boto3
        except ImportError as exc:
            raise RuntimeError("S3 storage needs boto3: uv add boto3") from exc
        self.bucket = bucket
        self.client = boto3.client("s3", endpoint_url=endpoint or None)

    def put(self, key: str, data: bytes) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data)

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False

    def path_for(self, key: str) -> Path | None:
        return None


def make_storage(settings: ApiSettings) -> Storage:
    if settings.s3_bucket:
        return S3Storage(settings.s3_bucket, settings.s3_endpoint)
    return LocalStorage(settings.storage_dir)
