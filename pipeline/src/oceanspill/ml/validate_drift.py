"""Check the drift model against real drifting buoys.

Two questions, answered separately:

* **Does the cloud spread at the right rate?** The model spreads particles by a horizontal
  diffusivity. Buoys released close together spread apart at a rate anyone can measure, so the
  model's one-sigma radius after six, twelve, twenty-four and forty-eight hours is compared with
  what the buoys actually did. This needs no weather data.

* **Does the centre go to the right place?** For sampled buoy tracks the model is run forward from
  a known position and compared with where the buoy actually was a day later, against two baselines:
  assuming it did not move at all, and moving it with the current alone. It also checks how often
  the truth lands inside the uncertainty radius the model claims — a forecast that is honest about
  its error is worth more than one that is quietly overconfident.

The physics here is the same as the interface uses — current, plus a fraction of the wind, plus a
random walk — re-implemented in Python so the check can run offline. The parameters it uses are
printed with the results.
"""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np

from ..config import PIPELINE_DIR, Settings
from ..http import CachedHttp
from .drift_calibration import (
    ARCHIVE_URL, MARINE_URL, EARTH_KM, _hourly, _with_retry, haversine_km, load_observations,
)
from ..providers.metocean_openmeteo import current_components, wind_components

# What the interface uses today, from src/engine/drift.ts.
APP_WINDAGE = 0.03
APP_DIFFUSIVITY = 8.0
STEP_MINUTES = 30


@dataclass
class SpreadCheck:
    hours: list[int]
    observed_separation_km: list[float]
    modelled_separation_km: dict[str, list[float]]
    diffusivity_tested: dict[str, float]
    pairs: int
    verdict: str


@dataclass
class TrackSkill:
    tracks: int
    hours: int
    windage: float
    diffusivity: float
    median_error_km: float
    mean_error_km: float
    median_no_drift_km: float
    median_current_only_km: float
    skill_against_no_drift: float
    inside_one_sigma: float
    inside_two_sigma: float
    expected_one_sigma: float
    expected_two_sigma: float


def modelled_separation_km(diffusivity: float, hours: int) -> float:
    """Distance between two independent particles that started together, after `hours`.

    Each particle random-walks with variance 2Kt per axis, so the separation between two of them has
    variance 4Kt per axis and a mean of sqrt(pi * K * t) for the two-dimensional case.
    """
    seconds = hours * 3600.0
    return math.sqrt(math.pi * diffusivity * seconds) / 1000.0


def check_spread(dispersion: dict, candidates: dict[str, float]) -> SpreadCheck:
    hours = dispersion["hours"]
    observed = dispersion["mean_separation_km"]
    modelled = {name: [modelled_separation_km(k, h) for h in hours] for name, k in candidates.items()}
    errors = {name: float(np.mean([abs(m - o) / o for m, o in zip(values, observed)])) for name, values in modelled.items()}
    best = min(errors, key=errors.get)
    verdict = (f"{best} reproduces the observed spreading to within {errors[best] * 100:.0f}% on average; "
               + ", ".join(f"{name} is off by {err * 100:.0f}%" for name, err in errors.items() if name != best))
    return SpreadCheck(hours=hours, observed_separation_km=observed, modelled_separation_km=modelled,
                       diffusivity_tested=candidates, pairs=dispersion["pairs"], verdict=verdict)


def sample_tracks(frame: Any, count: int, hours: int, seed: int) -> list[dict]:
    """Buoy tracks with a known start and a known position `hours` later."""
    import pandas as pd

    rng = np.random.default_rng(seed)
    tracks = []
    frame = frame.sort_values("time")
    for buoy, block in frame.groupby("id"):
        if len(tracks) >= count * 4:
            break
        block = block.set_index("time")
        stamps = block.index
        if len(stamps) < hours + 2:
            continue
        start = stamps[int(rng.integers(0, len(stamps) - hours - 1))]
        end = start + pd.Timedelta(hours=hours)
        if end not in block.index:
            continue
        tracks.append({
            "id": str(buoy), "start": start.to_pydatetime(), "end": end.to_pydatetime(),
            "lat0": float(block.loc[start, "lat"]), "lon0": float(block.loc[start, "lon"]),
            "lat1": float(block.loc[end, "lat"]), "lon1": float(block.loc[end, "lon"]),
            "drogued": bool(block.loc[start, "drogue_status"]),
        })
    rng.shuffle(tracks)
    return tracks[:count]


def fetch_series(http: CachedHttp, lat: float, lon: float, start: datetime, hours: int) -> dict[str, tuple[float, float]] | None:
    """Wind and current by the hour at one place, over the window a track covers."""
    end = start + timedelta(hours=hours)
    common = {"latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "start_date": start.strftime("%Y-%m-%d"),
              "end_date": end.strftime("%Y-%m-%d"), "wind_speed_unit": "ms", "timezone": "GMT"}
    try:
        wind = _with_retry(http, ARCHIVE_URL, {**common, "hourly": "wind_speed_10m,wind_direction_10m"}, common["start_date"])
        marine = _with_retry(http, MARINE_URL, {**common, "hourly": "ocean_current_velocity,ocean_current_direction", "cell_selection": "sea"}, common["start_date"])
    except Exception as exc:
        print(f"    forcing unavailable ({type(exc).__name__})", flush=True)
        return None
    speeds, directions = _hourly(wind, "wind_speed_10m"), _hourly(wind, "wind_direction_10m")
    cur_speeds, cur_dirs = _hourly(marine, "ocean_current_velocity"), _hourly(marine, "ocean_current_direction")
    series = {}
    for stamp in speeds:
        wu, wv = wind_components(speeds.get(stamp), directions.get(stamp))
        raw = cur_speeds.get(stamp)
        cu, cv = current_components(None if raw is None else raw / 3.6, cur_dirs.get(stamp))
        if None in (wu, wv, cu, cv):
            continue
        series[stamp] = (wu, wv, cu, cv)
    return series or None


def run_drift(lat: float, lon: float, start: datetime, hours: int, series: dict, windage: float,
              diffusivity: float, particles: int, rng: np.random.Generator) -> tuple[float, float, float]:
    """The model's own physics: current, a fraction of the wind, and a random walk."""
    lats = np.full(particles, lat)
    lons = np.full(particles, lon)
    steps = int(hours * 60 / STEP_MINUTES)
    dt = STEP_MINUTES * 60
    for step in range(steps):
        when = start + timedelta(seconds=step * dt)
        sample = series.get(when.strftime("%Y-%m-%dT%H:00"))
        if sample is None:
            continue
        wu, wv, cu, cv = sample
        u = cu + windage * wu
        v = cv + windage * wv
        walk = math.sqrt(2 * diffusivity * dt)
        du = (u * dt + walk * rng.normal(size=particles)) / 1000.0
        dv = (v * dt + walk * rng.normal(size=particles)) / 1000.0
        lats += dv / 110.574
        lons += du / (111.320 * np.cos(np.radians(lats)))
    centre_lat, centre_lon = float(lats.mean()), float(lons.mean())
    spread = float(np.percentile(haversine_km(lats, lons, np.full(particles, centre_lat), np.full(particles, centre_lon)), 68))
    return centre_lat, centre_lon, spread


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-validate-drift", description=__doc__)
    parser.add_argument("--drifters", default=str(PIPELINE_DIR.parent / "Datasetss" / "NOAA_GDP" / "noaa_gdp_indian_ocean.parquet"))
    parser.add_argument("--calibration", default=str(PIPELINE_DIR / "runs" / "drift_calibration" / "drift_calibration.json"))
    parser.add_argument("--out", default=str(PIPELINE_DIR / "runs" / "drift_validation"))
    parser.add_argument("--tracks", type=int, default=30)
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--particles", type=int, default=200)
    parser.add_argument("--windage", type=float, help="default: the figure measured from the buoys, else the app's 3%%")
    parser.add_argument("--diffusivity", type=float, help="default: the figure measured from the buoys")
    parser.add_argument("--skip-tracks", action="store_true", help="only check spreading, which needs no weather data")
    parser.add_argument("--seed", type=int, default=20260916)
    args = parser.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    calibration = json.loads(Path(args.calibration).read_text())
    measured_k = calibration.get("diffusivity", {}).get("diffusivity_m2s")
    measured_windage = next((w["windage"] for w in calibration.get("windage", []) if "undrogued" in w["drogue"]), None)
    windage = args.windage if args.windage is not None else (measured_windage or APP_WINDAGE)
    diffusivity = args.diffusivity if args.diffusivity is not None else (measured_k or APP_DIFFUSIVITY)

    results: dict[str, Any] = {
        "parameters": {"windage": windage, "diffusivity": diffusivity, "stepMinutes": STEP_MINUTES,
                       "appWindage": APP_WINDAGE, "appDiffusivity": APP_DIFFUSIVITY},
        "source": calibration.get("source"),
    }

    if "diffusivity" in calibration:
        candidates = {"the model's old 8 m²/s": APP_DIFFUSIVITY, f"the measured {measured_k:.0f} m²/s": measured_k}
        spread = check_spread(calibration["diffusivity"], candidates)
        results["spread"] = asdict(spread)
        print("spreading, against buoys that started together:")
        for i, h in enumerate(spread.hours):
            line = " · ".join(f"{name} {values[i]:.1f} km" for name, values in spread.modelled_separation_km.items())
            print(f"  {h:3d} h: observed {spread.observed_separation_km[i]:.1f} km · {line}")
        print(f"  {spread.verdict}")

    if not args.skip_tracks:
        settings = Settings.load()
        http = CachedHttp(settings.cache_dir)
        rng = np.random.default_rng(args.seed)
        region = {"north": 30.0, "south": -40.0, "east": 120.0, "west": 20.0}
        frame = load_observations(Path(args.drifters), datetime(2022, 1, 1, tzinfo=timezone.utc),
                                  datetime(2024, 12, 31, tzinfo=timezone.utc), region)
        tracks = sample_tracks(frame, args.tracks, args.hours, args.seed)
        print(f"checking the centre against {len(tracks)} buoy tracks of {args.hours} h")

        errors, no_drift, current_only, inside1, inside2, used = [], [], [], 0, 0, 0
        for track in tracks:
            series = fetch_series(http, track["lat0"], track["lon0"], track["start"], args.hours)
            if series is None:
                continue
            lat, lon, spread_km = run_drift(track["lat0"], track["lon0"], track["start"], args.hours, series,
                                            windage, diffusivity, args.particles, rng)
            truth = (track["lat1"], track["lon1"])
            error = float(haversine_km(np.array([lat]), np.array([lon]), np.array([truth[0]]), np.array([truth[1]]))[0])
            still = float(haversine_km(np.array([track["lat0"]]), np.array([track["lon0"]]), np.array([truth[0]]), np.array([truth[1]]))[0])
            clat, clon, _ = run_drift(track["lat0"], track["lon0"], track["start"], args.hours, series, 0.0, 0.0, 1, rng)
            drift_only = float(haversine_km(np.array([clat]), np.array([clon]), np.array([truth[0]]), np.array([truth[1]]))[0])
            errors.append(error)
            no_drift.append(still)
            current_only.append(drift_only)
            inside1 += error <= spread_km
            inside2 += error <= 2 * spread_km
            used += 1

        if used:
            skill = TrackSkill(
                tracks=used, hours=args.hours, windage=windage, diffusivity=diffusivity,
                median_error_km=float(np.median(errors)), mean_error_km=float(np.mean(errors)),
                median_no_drift_km=float(np.median(no_drift)), median_current_only_km=float(np.median(current_only)),
                skill_against_no_drift=float(1 - np.median(errors) / np.median(no_drift)),
                inside_one_sigma=inside1 / used, inside_two_sigma=inside2 / used,
                expected_one_sigma=0.68, expected_two_sigma=0.95,
            )
            results["trackSkill"] = asdict(skill)
            print(f"  median error after {args.hours} h: {skill.median_error_km:.1f} km "
                  f"(no drift {skill.median_no_drift_km:.1f} km, current only {skill.median_current_only_km:.1f} km)")
            print(f"  improvement over assuming it did not move: {skill.skill_against_no_drift * 100:.0f}%")
            print(f"  truth inside the stated uncertainty: {skill.inside_one_sigma * 100:.0f}% at one sigma "
                  f"(0.68 expected), {skill.inside_two_sigma * 100:.0f}% at two sigma (0.95 expected)")
        else:
            print("  no track could be checked: the weather archive returned nothing")

    path = out / "drift_validation.json"
    path.write_text(json.dumps(results, indent=1))
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
