from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

PIPELINE_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = PIPELINE_DIR.parent
DATA_DIR = REPO_DIR / "data"
CASES_DIR = DATA_DIR / "cases"
REFERENCE_DIR = DATA_DIR / "reference"
OUTPUT_DIR = REPO_DIR / "public" / "data"


def _list(value: str | None, default: list[str]) -> list[str]:
    if not value:
        return default
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    sar_providers: list[str] = field(default_factory=lambda: ["eos04", "sentinel1"])
    metocean_providers: list[str] = field(default_factory=lambda: ["openmeteo"])
    ais_provider: str = "synthetic"
    sanctions_provider: str = "unsc"

    bhoonidhi_user_id: str = ""
    bhoonidhi_password: str = ""
    cdse_username: str = ""
    cdse_password: str = ""
    gfw_api_token: str = ""
    cmems_username: str = ""
    cmems_password: str = ""

    cache_dir: Path = PIPELINE_DIR / ".cache"
    output_dir: Path = OUTPUT_DIR
    # A trained segmentation model exported to ONNX. Empty means the classical detector is used.
    sar_model: str = ""
    # A trained ship detector exported to ONNX. Empty means no vessel detection is attempted, and the
    # scene record says nobody looked rather than that nothing was there.
    ship_model: str = ""

    @classmethod
    def load(cls, env_file: Path | None = None) -> "Settings":
        load_dotenv(env_file or PIPELINE_DIR / ".env", override=False)
        cache = os.getenv("CACHE_DIR", ".cache")
        cache_path = Path(cache) if Path(cache).is_absolute() else PIPELINE_DIR / cache
        # Somewhere other than public/data, for comparing a run against the published one.
        output = os.getenv("OUTPUT_DIR")
        output_path = Path(output) if output else OUTPUT_DIR
        return cls(
            sar_providers=_list(os.getenv("SAR_PROVIDERS"), ["eos04", "sentinel1"]),
            metocean_providers=_list(os.getenv("METOCEAN_PROVIDER"), ["openmeteo"]),
            ais_provider=os.getenv("AIS_PROVIDER", "synthetic"),
            sanctions_provider=os.getenv("SANCTIONS_PROVIDER", "unsc"),
            bhoonidhi_user_id=os.getenv("BHOONIDHI_USER_ID", ""),
            bhoonidhi_password=os.getenv("BHOONIDHI_PASSWORD", ""),
            cdse_username=os.getenv("CDSE_USERNAME", ""),
            cdse_password=os.getenv("CDSE_PASSWORD", ""),
            gfw_api_token=os.getenv("GFW_API_TOKEN", ""),
            cmems_username=os.getenv("CMEMS_USERNAME", ""),
            cmems_password=os.getenv("CMEMS_PASSWORD", ""),
            cache_dir=cache_path,
            output_dir=output_path,
            sar_model=os.getenv("SAR_MODEL", ""),
            ship_model=os.getenv("SHIP_MODEL", ""),
        )
