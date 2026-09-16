"""Calibrate the drift model against real drifting buoys.

The drift model moves oil with the current plus a fraction of the wind (windage), and spreads it by
a horizontal diffusivity. Both were textbook values. This measures them from the NOAA Global Drifter
Program record for the Indian Ocean:

* **Windage** is fitted by regression. A buoy's own velocity minus the modelled surface current is
  what the wind is doing to it, so fitting that residual against the wind gives the fraction and the
  angle it acts at. Buoys that have lost their drogue float at the surface like a slick does, so they
  are the ones that matter; drogued buoys sit 15 m down and should show almost no windage, which is
  the check that the method works.
* **Diffusivity** is measured from pairs of buoys that were close together: how fast the distance
  between them grows is the spreading the model has to reproduce. That needs no wind or current data
  at all.

Nothing here is a trained model — these are two numbers with error bars, measured from observations.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np

from ..config import PIPELINE_DIR, Settings
from ..http import CachedHttp
from ..providers.metocean_openmeteo import ARCHIVE_URL, MARINE_URL, current_components, wind_components

# Météo-France SMOC currents through Open-Meteo start in 2022.
CURRENTS_FROM = datetime(2022, 1, 1, tzinfo=timezone.utc)
# Open-Meteo accepts many coordinates in one request, all sharing the same date range.
POINTS_PER_REQUEST = 50
EARTH_KM = 6371.0088


@dataclass
class WindageFit:
    """Windage as a fraction of wind speed, and the angle it acts at (positive = to the right)."""
    drogue: str
    samples: int
    buoy_days: int
    windage: float
    deflection_deg: float
    rms_residual_ms: float
    mean_wind_ms: float
    mean_current_ms: float
    mean_drifter_ms: float
    windage_ci95: tuple[float, float]


@dataclass
class DiffusivityFit:
    pairs: int
    diffusivity_m2s: float
    ci95: tuple[float, float]
    hours: list[int]
    mean_separation_km: list[float]


def load_observations(path: Path, start: datetime, end: datetime, region: dict[str, float]) -> Any:
    import pandas as pd

    columns = ["id", "time", "lat", "lon", "ve", "vn", "drogue_status"]
    frame = pd.read_parquet(path, columns=columns) if path.suffix == ".parquet" else pd.read_csv(path, usecols=columns)
    frame["time"] = pd.to_datetime(frame["time"], utc=True)
    keep = (
        frame["time"].between(start, end)
        & frame["lat"].between(region["south"], region["north"])
        & frame["lon"].between(region["west"], region["east"])
        & frame["ve"].notna() & frame["vn"].notna()
    )
    return frame[keep]


def sample_by_day(frame: Any, days: int, per_day: int, seed: int, hours_per_buoy: int = 6) -> Any:
    """A spread of observations: some days from across the record, some buoys on each.

    One request to the weather archive returns a whole day at a point, so several hours from the
    same buoy cost nothing extra. They are correlated, which the block bootstrap accounts for.
    """
    import pandas as pd

    rng = np.random.default_rng(seed)
    frame = frame.copy()
    frame["day"] = frame["time"].dt.floor("D")
    all_days = np.array(sorted(frame["day"].unique()))
    chosen = rng.choice(all_days, size=min(days, len(all_days)), replace=False)
    out = []
    for day in chosen:
        block = frame[frame["day"] == day]
        buoys = block["id"].unique()
        if len(buoys) > per_day:
            buoys = rng.choice(buoys, size=per_day, replace=False)
        block = block[block["id"].isin(buoys)]
        # Hours spread through the day, so wind and current conditions vary within each buoy.
        wanted = set(np.linspace(0, 23, hours_per_buoy).round().astype(int).tolist())
        block = block[block["time"].dt.hour.isin(wanted)]
        out.append(block)
    return pd.concat(out, ignore_index=True)


def _hourly(payload: dict, key: str) -> dict[str, float | None]:
    hourly = payload.get("hourly", {})
    times = hourly.get("time", [])
    values = hourly.get(key, [])
    return {t: v for t, v in zip(times, values)}


# The free weather archive counts each coordinate separately, so a run of large requests can trip
# the minute limit. Wait it out rather than losing the day.
REQUEST_PAUSE_S = 1.5
RATE_LIMIT_WAIT_S = 65


def _with_retry(http: CachedHttp, url: str, params: dict, date: str, attempts: int = 4) -> Any:
    for attempt in range(attempts):
        try:
            payload = http.request_json("GET", url, params=params, timeout=120)
            time.sleep(REQUEST_PAUSE_S)
            return payload
        except Exception as exc:
            if "429" not in str(exc) or attempt == attempts - 1:
                raise
            print(f"  {date}: rate limited, waiting {RATE_LIMIT_WAIT_S}s", flush=True)
            time.sleep(RATE_LIMIT_WAIT_S)
    raise RuntimeError("unreachable")


def fetch_forcing(http: CachedHttp, samples: Any) -> Any:
    """Wind and surface current at each sampled position and hour."""
    import pandas as pd

    samples = samples.copy()
    for column in ("wind_u", "wind_v", "cur_u", "cur_v"):
        samples[column] = np.nan

    for day, block in samples.groupby(samples["time"].dt.floor("D")):
        date = day.strftime("%Y-%m-%d")
        # One request covers a whole day at a point, so ask once per buoy and reuse it for that
        # buoy's other hours. Positions move within the day, but only by a few kilometres, which is
        # well inside a forcing grid cell.
        first_rows = block.groupby("id").head(1)
        rows = list(first_rows.index)
        row_for_buoy = {samples.at[r, "id"]: r for r in rows}
        for i in range(0, len(rows), POINTS_PER_REQUEST):
            chunk = rows[i : i + POINTS_PER_REQUEST]
            lats = ",".join(f"{samples.at[r, 'lat']:.4f}" for r in chunk)
            lons = ",".join(f"{samples.at[r, 'lon']:.4f}" for r in chunk)
            common = {"latitude": lats, "longitude": lons, "start_date": date, "end_date": date,
                      "wind_speed_unit": "ms", "timezone": "GMT"}
            try:
                wind = _with_retry(http, ARCHIVE_URL, {**common, "hourly": "wind_speed_10m,wind_direction_10m"}, date)
                marine = _with_retry(http, MARINE_URL, {**common, "hourly": "ocean_current_velocity,ocean_current_direction", "cell_selection": "sea"}, date)
            except Exception as exc:  # a failed day costs those samples, not the run
                print(f"  {date}: forcing unavailable ({type(exc).__name__}: {exc})", flush=True)
                continue
            wind_list = wind if isinstance(wind, list) else [wind]
            marine_list = marine if isinstance(marine, list) else [marine]
            for n, row in enumerate(chunk):
                if n >= len(wind_list) or n >= len(marine_list):
                    break
                buoy = samples.at[row, "id"]
                speeds = _hourly(wind_list[n], "wind_speed_10m")
                directions = _hourly(wind_list[n], "wind_direction_10m")
                # Open-Meteo reports current speed in km/h; the drift model works in m/s.
                cur_speeds = _hourly(marine_list[n], "ocean_current_velocity")
                cur_dirs = _hourly(marine_list[n], "ocean_current_direction")
                for other in block.index[block["id"] == buoy]:
                    stamp = samples.at[other, "time"].strftime("%Y-%m-%dT%H:00")
                    wu, wv = wind_components(speeds.get(stamp), directions.get(stamp))
                    raw = cur_speeds.get(stamp)
                    cu, cv = current_components(None if raw is None else raw / 3.6, cur_dirs.get(stamp))
                    samples.at[other, "wind_u"], samples.at[other, "wind_v"] = wu, wv
                    samples.at[other, "cur_u"], samples.at[other, "cur_v"] = cu, cv

    return samples.dropna(subset=["wind_u", "wind_v", "cur_u", "cur_v"])


def fit_windage(samples: Any, drogue: str) -> WindageFit | None:
    """Least squares for the rotation and scaling that takes wind to the residual buoy motion."""
    if len(samples) < 30:
        return None
    wind = np.column_stack([samples["wind_u"].to_numpy(float), samples["wind_v"].to_numpy(float)])
    current = np.column_stack([samples["cur_u"].to_numpy(float), samples["cur_v"].to_numpy(float)])
    drifter = np.column_stack([samples["ve"].to_numpy(float), samples["vn"].to_numpy(float)])
    residual = drifter - current

    # residual = a * wind + b * wind_rotated_90, so the pair (a, b) gives both fraction and angle.
    rotated = np.column_stack([wind[:, 1], -wind[:, 0]])
    design = np.zeros((2 * len(wind), 2))
    design[0::2, 0], design[0::2, 1] = wind[:, 0], rotated[:, 0]
    design[1::2, 0], design[1::2, 1] = wind[:, 1], rotated[:, 1]
    target = residual.reshape(-1)
    (a, b), *_ = np.linalg.lstsq(design, target, rcond=None)

    predicted = design @ np.array([a, b])
    rms = float(np.sqrt(np.mean((target - predicted) ** 2)))
    windage = float(math.hypot(a, b))
    deflection = float(math.degrees(math.atan2(b, a)))

    # Confidence interval by bootstrap over buoy-days, not single hours: hours from one buoy on one
    # day share the same weather, so treating them as independent would understate the uncertainty.
    rng = np.random.default_rng(12345)
    blocks = (samples["id"].astype(str) + "|" + samples["time"].dt.floor("D").astype(str)).to_numpy()
    unique_blocks = np.unique(blocks)
    positions = {b: np.flatnonzero(blocks == b) for b in unique_blocks}
    boot = []
    for _ in range(400):
        picked = rng.choice(unique_blocks, size=len(unique_blocks), replace=True)
        idx = np.concatenate([positions[b] for b in picked])
        d = np.zeros((2 * len(idx), 2))
        d[0::2, 0], d[0::2, 1] = wind[idx, 0], rotated[idx, 0]
        d[1::2, 0], d[1::2, 1] = wind[idx, 1], rotated[idx, 1]
        t = residual[idx].reshape(-1)
        (ba, bb), *_ = np.linalg.lstsq(d, t, rcond=None)
        boot.append(math.hypot(ba, bb))
    low, high = np.percentile(boot, [2.5, 97.5])

    return WindageFit(
        drogue=drogue, samples=int(len(wind)), buoy_days=int(len(unique_blocks)), windage=windage, deflection_deg=deflection,
        rms_residual_ms=rms,
        mean_wind_ms=float(np.mean(np.linalg.norm(wind, axis=1))),
        mean_current_ms=float(np.mean(np.linalg.norm(current, axis=1))),
        mean_drifter_ms=float(np.mean(np.linalg.norm(drifter, axis=1))),
        windage_ci95=(float(low), float(high)),
    )


def haversine_km(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray) -> np.ndarray:
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def fit_diffusivity(frame: Any, max_start_km: float, hours: list[int], max_pairs: int, seed: int) -> DiffusivityFit | None:
    """How fast buoys that started together drift apart: relative dispersion, from positions alone."""
    import pandas as pd

    rng = np.random.default_rng(seed)
    frame = frame.sort_values("time")
    by_hour = {h: [] for h in hours}
    pairs_used = 0

    # Work hour by hour: buoys reporting in the same hour and close together start a pair.
    frame = frame.copy()
    frame["hour"] = frame["time"].dt.floor("h")
    index = {(row.id, row.hour): (row.lat, row.lon) for row in frame.itertuples()}

    starts = list(frame.groupby("hour"))
    rng.shuffle(starts)
    for hour, block in starts:
        if pairs_used >= max_pairs:
            break
        if len(block) < 2:
            continue
        ids = block["id"].to_numpy()
        lats = block["lat"].to_numpy(float)
        lons = block["lon"].to_numpy(float)
        for i in range(len(ids)):
            if pairs_used >= max_pairs:
                break
            for j in range(i + 1, len(ids)):
                d0 = float(haversine_km(np.array([lats[i]]), np.array([lons[i]]), np.array([lats[j]]), np.array([lons[j]]))[0])
                if d0 > max_start_km or d0 < 1e-3:
                    continue
                separations = {}
                for h in hours:
                    later = hour + pd.Timedelta(hours=h)
                    a = index.get((ids[i], later))
                    b = index.get((ids[j], later))
                    if a is None or b is None:
                        break
                    separations[h] = float(haversine_km(np.array([a[0]]), np.array([a[1]]), np.array([b[0]]), np.array([b[1]]))[0])
                if len(separations) == len(hours):
                    pairs_used += 1
                    for h, d in separations.items():
                        by_hour[h].append(d ** 2 - d0 ** 2)
                    break

    if pairs_used < 20:
        return None

    # Growth of mean squared separation with time gives the diffusivity: <d²> = <d0²> + 4 K t.
    times = np.array([h * 3600.0 for h in hours])
    growth = np.array([np.mean(by_hour[h]) * 1e6 for h in hours])  # km² to m²
    slope = float(np.linalg.lstsq(times.reshape(-1, 1), growth, rcond=None)[0][0])
    diffusivity = slope / 4.0

    boot = []
    samples = np.array([by_hour[h] for h in hours])  # hours × pairs
    rng2 = np.random.default_rng(seed + 1)
    for _ in range(400):
        idx = rng2.integers(0, samples.shape[1], samples.shape[1])
        g = np.array([np.mean(samples[k][idx]) * 1e6 for k in range(len(hours))])
        boot.append(float(np.linalg.lstsq(times.reshape(-1, 1), g, rcond=None)[0][0]) / 4.0)
    low, high = np.percentile(boot, [2.5, 97.5])

    return DiffusivityFit(
        pairs=pairs_used, diffusivity_m2s=diffusivity, ci95=(float(low), float(high)), hours=hours,
        mean_separation_km=[float(np.sqrt(max(np.mean(by_hour[h]), 0))) for h in hours],
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-calibrate-drift", description=__doc__)
    parser.add_argument("--drifters", default=str(PIPELINE_DIR.parent / "Datasetss" / "NOAA_GDP" / "noaa_gdp_indian_ocean.parquet"))
    parser.add_argument("--out", default=str(PIPELINE_DIR / "runs" / "drift_calibration"))
    parser.add_argument("--days", type=int, default=40, help="how many separate days to sample for the windage fit")
    parser.add_argument("--per-day", type=int, default=50, help="buoys sampled on each of those days")
    parser.add_argument("--pairs", type=int, default=600, help="buoy pairs used for the diffusivity fit")
    parser.add_argument("--seed", type=int, default=20260916)
    parser.add_argument("--offline", action="store_true", help="use cached forcing responses only")
    parser.add_argument("--skip-windage", action="store_true", help="only measure spreading, which needs no weather data")
    # Windage and spreading are properties of wind and sea, not of a particular coast, so the fit
    # uses the whole Indian Ocean record; there are only a handful of buoys inside the case box.
    parser.add_argument("--north", type=float, default=30.0)
    parser.add_argument("--south", type=float, default=-40.0)
    parser.add_argument("--east", type=float, default=120.0)
    parser.add_argument("--west", type=float, default=20.0)
    parser.add_argument("--start", default="2022-01-01", help="currents from Open-Meteo begin in 2022")
    parser.add_argument("--end", default="2024-12-31")
    args = parser.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    settings = Settings.load()
    http = CachedHttp(settings.cache_dir, offline=args.offline)

    region = {"north": args.north, "south": args.south, "east": args.east, "west": args.west}
    start = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
    end = datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc)

    print(f"reading {args.drifters}")
    frame = load_observations(Path(args.drifters), start, end, region)
    print(f"{len(frame):,} hourly observations from {frame['id'].nunique():,} buoys in the box, {args.start} to {args.end}")

    results: dict[str, Any] = {
        "source": "NOAA Global Drifter Program hourly product (doi 10.25921/x46c-3620)",
        "region": region,
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "observations": int(len(frame)),
        "buoys": int(frame["id"].nunique()),
    }

    if args.skip_windage:
        print("skipping the windage fit (no weather requests)")
        results["windage"] = []
    else:
        print("sampling for the windage fit…")
        samples = sample_by_day(frame, args.days, args.per_day, args.seed)
        print(f"  {len(samples)} samples across {samples['time'].dt.floor('D').nunique()} days; fetching wind and currents")
        samples = fetch_forcing(http, samples)
        print(f"  {len(samples)} samples have both wind and current")

        surface = samples[~samples["drogue_status"].astype(bool)]
        fits = []
        # The wind pushes a float to the right of its own direction north of the equator and to the
        # left south of it, so a fit spanning both hemispheres cancels the angle out. India's coast
        # is northern, which is the number the drift model needs.
        groups = (
            ("undrogued (surface-following, like a slick)", surface),
            ("undrogued, northern hemisphere", surface[surface["lat"] > 0]),
            ("undrogued, southern hemisphere", surface[surface["lat"] <= 0]),
            ("drogued (15 m drogue, control)", samples[samples["drogue_status"].astype(bool)]),
        )
        for label, subset in groups:
            fit = fit_windage(subset, label)
            if fit is None:
                print(f"  {label}: too few samples ({len(subset)})")
                continue
            fits.append(asdict(fit))
            print(f"  {label}: windage {fit.windage * 100:.2f}% "
                  f"(95% CI {fit.windage_ci95[0] * 100:.2f}–{fit.windage_ci95[1] * 100:.2f}), "
                  f"deflection {fit.deflection_deg:+.1f}°, residual {fit.rms_residual_ms:.3f} m/s, n={fit.samples}")
        results["windage"] = fits

    print("measuring spreading from buoy pairs…")
    # Pair separation needs positions only, so it uses the whole record rather than the years where
    # modelled currents happen to be available.
    all_years = load_observations(Path(args.drifters), datetime(1987, 1, 1, tzinfo=timezone.utc), end, region)
    print(f"  {len(all_years):,} observations from {all_years['id'].nunique():,} buoys over the full record")
    results["dispersionObservations"] = int(len(all_years))
    results["dispersionBuoys"] = int(all_years["id"].nunique())
    dispersion = fit_diffusivity(all_years, max_start_km=25.0, hours=[6, 12, 24, 48], max_pairs=args.pairs, seed=args.seed)
    if dispersion:
        results["diffusivity"] = asdict(dispersion)
        print(f"  {dispersion.pairs} pairs: diffusivity {dispersion.diffusivity_m2s:.1f} m²/s "
              f"(95% CI {dispersion.ci95[0]:.1f}–{dispersion.ci95[1]:.1f})")
        print("  mean separation: " + ", ".join(f"{h} h {d:.1f} km" for h, d in zip(dispersion.hours, dispersion.mean_separation_km)))
    else:
        print("  not enough overlapping pairs")

    path = out / "drift_calibration.json"
    path.write_text(json.dumps(results, indent=1))
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
