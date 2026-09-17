"""Check the ship detector against the AIS feed on a real scene.

The detector's published figures come from SSDD: chips cropped around a ship, which say how well it
outlines a vessel it has already been handed and nothing about how it behaves over eighty kilometres
of open water. This measures the thing that matters instead — point the detector at a scene over
Indian waters, take the vessels that were transmitting at the moment the satellite passed, and ask
how many of them the radar found.

Two numbers come out, and only one of them is a score:

* **Found.** Of the vessels AIS places in the scene, how many have a radar target near them. This is
  a fair recall figure, with one caveat recorded in the output: AIS positions between pings are
  interpolated, so a ship that reported an hour ago may genuinely be kilometres from where the line
  says it was, and that counts against the detector here even though it is the feed's error.

* **Unmatched.** Radar targets with no transmitting vessel near them. This is *not* a count of dark
  ships. Some of it is: small craft that never transmit are ordinary in Indian coastal waters. The
  rest is the detector's false-alarm rate over open sea, which nobody has measured, because doing so
  needs a scene where every vessel is known. Until that exists these are candidates for a human to
  look at, and the output says so rather than handing over a list of accusations.
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import OUTPUT_DIR

# A hull is not a point, the radar position is a pixel centroid, and AIS between pings is a straight
# line drawn through a ship that was turning. Two kilometres is generous on purpose.
MATCH_KM = 2.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


def scene_time(scene_name: str) -> datetime | None:
    """Acquisition start from a Sentinel-1 product name, which carries it in the fifth field."""
    parts = scene_name.split("_")
    for part in parts:
        if len(part) == 15 and part[8] == "T":
            try:
                return datetime.strptime(part, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    return None


def positions_at(case: dict[str, Any], when: datetime) -> list[dict[str, Any]]:
    """Every track interpolated to one moment, skipping tracks that do not cover it."""
    window = (case.get("ais") or {}).get("window") or {}
    if not window.get("start"):
        return []
    start = datetime.fromtimestamp(window["start"] / 1000, timezone.utc)
    secs = (when - start).total_seconds()
    out = []
    for track in case.get("tracks") or []:
        pings = track.get("pings") or []
        if not pings or secs < pings[0][0] or secs > pings[-1][0]:
            continue
        previous = pings[0]
        for ping in pings:
            if ping[0] >= secs:
                span = ping[0] - previous[0]
                f = 0.0 if span == 0 else (secs - previous[0]) / span
                out.append({"key": track["key"], "provenance": track.get("provenance"),
                            "lat": previous[1] + f * (ping[1] - previous[1]),
                            "lon": previous[2] + f * (ping[2] - previous[2]),
                            # How stale the nearest real report is, which bounds how far out the
                            # interpolated position can be through no fault of the detector.
                            "gapMinutes": round((ping[0] - previous[0]) / 60.0, 1)})
                break
            previous = ping
    return out


def check(case: dict[str, Any], measurement: dict[str, Any], match_km: float = MATCH_KM) -> dict[str, Any] | None:
    vessels = measurement.get("vessels")
    if vessels is None:
        return None
    when = scene_time(measurement["scene"])
    if when is None:
        return None
    ais = positions_at(case, when)
    if not ais:
        return None

    found, missed = [], []
    for v in ais:
        nearest = min((haversine_km(v["lat"], v["lon"], t["position"]["lat"], t["position"]["lon"])
                       for t in vessels), default=float("inf"))
        row = {"key": v["key"], "provenance": v["provenance"], "nearestRadarKm": round(nearest, 2),
               "aisGapMinutes": v["gapMinutes"]}
        (found if nearest <= match_km else missed).append(row)

    unmatched = 0
    for t in vessels:
        nearest = min(haversine_km(t["position"]["lat"], t["position"]["lon"], v["lat"], v["lon"]) for v in ais)
        if nearest > match_km:
            unmatched += 1

    return {
        "scene": measurement["scene"],
        "sceneTime": when.isoformat(),
        "pixelSpacingM": measurement.get("parameters", {}).get("pixelSpacingM"),
        "threshold": (measurement.get("vesselModel") or {}).get("threshold"),
        "matchRadiusKm": match_km,
        "aisVesselsInScene": len(ais),
        "foundByRadar": len(found),
        "recall": round(len(found) / len(ais), 3) if ais else None,
        "radarTargets": len(vessels),
        "unmatchedTargets": unmatched,
        "found": found,
        "missed": missed,
        "caveats": [
            "AIS positions between pings are interpolated, so a stale report puts a vessel where it "
            "is not and counts as a miss against the detector.",
            "Unmatched radar targets are not dark ships. Small craft that never transmit are ordinary "
            "here, and the detector's false-alarm rate over open sea has not been measured.",
            "One scene over one stretch of coast. This is evidence the detector works on real data, "
            "not a performance figure for the system.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-validate-vessels", description=__doc__)
    parser.add_argument("--case", required=True,
                        help="a case id with processed scenes; process it with --factor 2 first, "
                             "because the default multilook is too coarse to resolve a vessel")
    parser.add_argument("--output", default=str(OUTPUT_DIR), help="where the built artifacts live")
    parser.add_argument("--match-km", type=float, default=MATCH_KM)
    parser.add_argument("--out", help="write the report here as JSON")
    args = parser.parse_args(argv)

    output = Path(args.output)
    case_path = output / "cases" / f"{args.case}.json"
    if not case_path.exists():
        print(f"no built case at {case_path}")
        return 1
    case = json.loads(case_path.read_text())

    reports = []
    for path in sorted((output / "sar" / args.case).glob("*.json")):
        report = check(case, json.loads(path.read_text()), args.match_km)
        if report is None:
            continue
        reports.append(report)
        print(f"{report['scene']}  ({report['pixelSpacingM']} m pixels, threshold {report['threshold']})")
        print(f"  {report['foundByRadar']} of {report['aisVesselsInScene']} transmitting vessels found "
              f"within {args.match_km:g} km  (recall {report['recall']:.0%})")
        print(f"  {report['radarTargets']} radar targets, {report['unmatchedTargets']} with no AIS near them "
              f"— candidates to look at, not dark ships")
        for row in report["found"][:5]:
            print(f"    found   {row['key']:22s} {row['nearestRadarKm']:6.2f} km")
        for row in report["missed"]:
            print(f"    missed  {row['key']:22s} {row['nearestRadarKm']:6.2f} km "
                  f"(AIS gap {row['aisGapMinutes']:.0f} min)")

    if not reports:
        print("no processed scene in this case has vessel detections to check")
        return 1
    if args.out:
        Path(args.out).write_text(json.dumps({"case": args.case, "scenes": reports}, indent=1))
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
