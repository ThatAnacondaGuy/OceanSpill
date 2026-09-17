from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from ..config import OUTPUT_DIR, PIPELINE_DIR, REPO_DIR

SHARED_DIR = REPO_DIR / "shared"
SECRET_DIR = PIPELINE_DIR / ".secrets"


def _list(value: str | None) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


def _secret(name: str, env: str) -> str:
    """A server secret from the environment, or generated once and kept in pipeline/.secrets."""
    value = os.getenv(env)
    if value:
        return value
    SECRET_DIR.mkdir(parents=True, exist_ok=True)
    path = SECRET_DIR / name
    if not path.exists():
        path.write_text(secrets.token_urlsafe(48))
        path.chmod(0o600)
    return path.read_text().strip()


@dataclass(frozen=True)
class ApiSettings:
    database_url: str = "postgresql+psycopg:///oceanspill"
    data_dir: Path = OUTPUT_DIR
    storage_dir: Path = PIPELINE_DIR / "storage"
    jwt_secret: str = ""
    signing_secret: str = ""
    access_token_minutes: int = 8 * 60
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:5173"])
    s3_bucket: str = ""
    s3_endpoint: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    alert_emails: list[str] = field(default_factory=list)
    worker_interval_s: int = 900

    @classmethod
    def load(cls, env_file: Path | None = None, **overrides) -> "ApiSettings":
        load_dotenv(env_file or PIPELINE_DIR / ".env", override=False)
        values = dict(
            database_url=os.getenv("DATABASE_URL", cls.database_url),
            data_dir=Path(os.getenv("DATA_DIR", str(OUTPUT_DIR))),
            storage_dir=Path(os.getenv("STORAGE_DIR", str(PIPELINE_DIR / "storage"))),
            jwt_secret=_secret("jwt.key", "JWT_SECRET"),
            signing_secret=_secret("signing.key", "SIGNING_SECRET"),
            access_token_minutes=int(os.getenv("ACCESS_TOKEN_MINUTES", str(8 * 60))),
            cors_origins=_list(os.getenv("CORS_ORIGINS")) or ["http://localhost:5173"],
            s3_bucket=os.getenv("S3_BUCKET", ""),
            s3_endpoint=os.getenv("S3_ENDPOINT", ""),
            smtp_host=os.getenv("SMTP_HOST", ""),
            smtp_port=int(os.getenv("SMTP_PORT", "587")),
            smtp_user=os.getenv("SMTP_USER", ""),
            smtp_password=os.getenv("SMTP_PASSWORD", ""),
            smtp_from=os.getenv("SMTP_FROM", ""),
            alert_emails=_list(os.getenv("ALERT_EMAILS")),
            worker_interval_s=int(os.getenv("WORKER_INTERVAL_S", "900")),
        )
        values.update(overrides)
        return cls(**values)
