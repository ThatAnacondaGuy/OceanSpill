"""Put a number on how unusual an AIS gap is, from the record of real disabling events.

A vessel disappearing from AIS is usually nothing: coastal receivers have holes, satellites pass
every few hours, and a gap over open water is routine. Sometimes it is a ship switching off. The
interface used to decide with a fixed rule — dark for longer than a set number of minutes — which
flags half the fleet where reception is poor and misses a short, deliberate gap beside a slick.

This replaces the fixed rule with the empirical distribution of Global Fishing Watch's published
record of intentional AIS disabling events: where a gap of this length, this far from shore, sits
among tens of thousands of confirmed ones.

**Why a scale and not a classifier.** The first attempt trained a classifier against the ordinary
gaps in this project's own case windows. It scored a perfect AUC, which was the giveaway: the two
sides come from different feeds, so vessel class and distance are recorded differently and the model
separated the datasets rather than the behaviour. Without a comparable sample of ordinary gaps from
the same feed, a calibrated scale is what the data honestly supports.

What the analyst gets is a percentile. It ranks gaps for attention; it is not evidence of intent.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..config import PIPELINE_DIR

# Gap length in hours and distance offshore in kilometres. Both span orders of magnitude, so the
# bands widen as they go.
HOUR_EDGES = [0, 6, 12, 18, 24, 36, 48, 72, 120, 240, 1e9]
SHORE_EDGES = [0, 20, 50, 100, 200, 400, 800, 1e9]


@dataclass
class GapScale:
    events: int
    source: str
    window: str
    hours_percentiles: dict[str, float]
    shore_percentiles: dict[str, float]
    by_vessel_class: dict[str, dict[str, float]]
    grid: dict[str, Any]
    calibration: dict[str, float]
    use: str
    caveat: str


def load_events(path: Path) -> Any:
    import pandas as pd

    frame = pd.read_csv(path, parse_dates=["gap_start_timestamp", "gap_end_timestamp"])
    return frame[frame["gap_hours"].notna() & frame["gap_start_distance_from_shore_m"].notna()]


def percentile_of(sorted_values: np.ndarray, value: float) -> float:
    """Where a value sits in a distribution, as a percentage."""
    return float(np.searchsorted(sorted_values, value, side="right") / len(sorted_values) * 100.0)


def build_grid(hours: np.ndarray, shore_km: np.ndarray) -> dict[str, Any]:
    """How the confirmed events spread over gap length and distance offshore."""
    counts, _, _ = np.histogram2d(hours, shore_km, bins=[HOUR_EDGES, SHORE_EDGES])
    share = counts / counts.sum()
    return {
        "hourEdges": HOUR_EDGES[:-1],
        "shoreEdgesKm": SHORE_EDGES[:-1],
        "share": [[round(float(v), 5) for v in row] for row in share],
        "note": "Share of confirmed disabling events in each gap-length and distance-offshore band; "
                "the last band in each direction is open-ended.",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-train-ais", description=__doc__)
    parser.add_argument("--events", default=str(PIPELINE_DIR.parent / "Datasetss" / "_work" / "ais" / "disabling_events.csv"))
    parser.add_argument("--out", default=str(PIPELINE_DIR / "runs" / "ais_anomaly"))
    parser.add_argument("--seed", type=int, default=20260916)
    args = parser.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(args.seed)

    events = load_events(Path(args.events))
    hours = events["gap_hours"].to_numpy(float)
    shore_km = events["gap_start_distance_from_shore_m"].to_numpy(float) / 1000.0
    print(f"{len(events):,} confirmed AIS disabling events, "
          f"{events['gap_start_timestamp'].min():%Y-%m} to {events['gap_start_timestamp'].max():%Y-%m}")

    # Fit the scale on three quarters of the events and check it on the rest.
    order = rng.permutation(len(hours))
    cut = int(len(order) * 0.75)
    fit, held = order[:cut], order[cut:]
    reference = np.sort(hours[fit])

    ranks = np.array([percentile_of(reference, h) for h in hours[held]])
    # A percentile scale is calibrated when held-out values land evenly across it.
    deciles = np.histogram(ranks, bins=10, range=(0, 100))[0] / len(ranks)
    calibration = {
        "heldOut": int(len(held)),
        "maxDecileShare": float(deciles.max()),
        "minDecileShare": float(deciles.min()),
        "uniformShare": 0.1,
        "meanAbsoluteDeviation": float(np.mean(np.abs(deciles - 0.1))),
    }

    by_class = {}
    for name, block in events.groupby(events["vessel_class"].fillna("unknown").astype(str)):
        if len(block) < 200:
            continue
        by_class[name] = {
            "events": int(len(block)),
            "medianGapHours": float(block["gap_hours"].median()),
            "medianDistanceFromShoreKm": float(block["gap_start_distance_from_shore_m"].median() / 1000.0),
        }

    scale = GapScale(
        events=int(len(events)),
        source="Global Fishing Watch published AIS disabling events (gaps judged intentional)",
        window=f"{events['gap_start_timestamp'].min():%Y-%m-%d} to {events['gap_start_timestamp'].max():%Y-%m-%d}",
        hours_percentiles={f"p{q}": float(np.percentile(hours, q)) for q in (5, 10, 25, 50, 75, 90, 95, 99)},
        shore_percentiles={f"p{q}": float(np.percentile(shore_km, q)) for q in (5, 10, 25, 50, 75, 90, 95, 99)},
        by_vessel_class=by_class,
        grid=build_grid(hours, shore_km),
        calibration=calibration,
        use="Report where an observed gap sits in this distribution, beside the fixed-rule flag it "
            "replaces. A gap below the 25th percentile is short by the standards of deliberate ones.",
        caveat="Confirmed disabling events only. Without a comparable sample of ordinary gaps from "
               "the same feed there is no base rate here, so a high percentile means 'resembles the "
               "deliberate ones', not 'probably deliberate'.",
    )

    path = out / "ais_gap_scale.json"
    path.write_text(json.dumps(asdict(scale), indent=1))

    print(f"gap length: median {scale.hours_percentiles['p50']:.1f} h, "
          f"quartiles {scale.hours_percentiles['p25']:.1f}–{scale.hours_percentiles['p75']:.1f} h, "
          f"p95 {scale.hours_percentiles['p95']:.1f} h")
    print(f"distance offshore: median {scale.shore_percentiles['p50']:.0f} km, "
          f"p95 {scale.shore_percentiles['p95']:.0f} km")
    print(f"calibration on {calibration['heldOut']:,} held-out events: deciles "
          f"{calibration['minDecileShare']:.3f}–{calibration['maxDecileShare']:.3f} against 0.100 expected "
          f"(mean deviation {calibration['meanAbsoluteDeviation']:.4f})")
    for name, stats in sorted(by_class.items(), key=lambda kv: -kv[1]["events"]):
        print(f"  {name:12s} {stats['events']:6,d} events · median {stats['medianGapHours']:.1f} h "
              f"· {stats['medianDistanceFromShoreKm']:.0f} km offshore")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
