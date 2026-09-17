from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .build import build, load_cases, load_reference, update_coast
from .config import PIPELINE_DIR, Settings
from .http import CachedHttp
from .providers import Providers, ProviderConfigError
from .providers.base import SarScene


def _providers(settings: Settings, offline: bool = False) -> Providers:
    land, corridors, _ = load_reference()
    return Providers.from_settings(settings, CachedHttp(settings.cache_dir, offline=offline), land, corridors)


def cmd_providers(settings: Settings, _args: argparse.Namespace) -> int:
    for s in _providers(settings).statuses():
        mark = "OK " if s.available else "-- "
        origin = "IN " if s.sovereign else "EXT"
        print(f"{mark} {origin} {s.kind:<9} {s.name:<10} {s.agency}\n            {s.message}")
    return 0


def cmd_build(settings: Settings, args: argparse.Namespace) -> int:
    result = build(settings, args.case or None, offline=args.offline)
    for c in result["index"]["cases"]:
        print(f"built {c['id']:<32} scenes={c['sarScenes']:<3} forcing={'yes' if c['forcing'] else 'no ':<3} warnings={c['warnings']}")
    for f in result["failures"]:
        print(f"FAILED {f['id']}: {f['error']}", file=sys.stderr)
        print(f["trace"], file=sys.stderr)
    return 1 if result["failures"] else 0


def cmd_eo(settings: Settings, args: argparse.Namespace) -> int:
    """What optical coverage exists over each incident, and whether cloud leaves it usable."""
    import json as _json
    from datetime import datetime, timedelta

    from .providers.base import BBox
    from .providers.eo_sentinel2 import Sentinel2Cdse, summarise

    http = CachedHttp(settings.cache_dir, offline=args.offline)
    provider = Sentinel2Cdse(settings, http)
    out = {}
    for case in load_cases(args.case):
        incident = datetime.fromisoformat(case["incident"]["time"].replace("Z", "+00:00"))
        position = case["incident"]["position"]
        pad = args.pad_deg
        bbox = BBox(west=position["lon"] - pad, south=position["lat"] - pad,
                    east=position["lon"] + pad, north=position["lat"] + pad)
        try:
            scenes = provider.search(bbox, incident - timedelta(days=args.before), incident + timedelta(days=args.after))
        except Exception as exc:
            print(f"{case['id']:<32} search failed: {type(exc).__name__}: {exc}")
            continue
        report = summarise(scenes, incident)
        out[case["id"]] = report
        clearest = report["clearest"]
        detail = "" if not clearest else (f" · clearest {clearest['cloudPercent']:.0f}% cloud "
                                          f"{clearest['hoursFromIncident']:+.0f} h from the incident")
        print(f"{case['id']:<32} {report['scenes']:2d} scenes · {report['usable']:2d} under "
              f"{report['cloudThreshold']:.0f}% cloud{detail}")

    if args.out:
        Path(args.out).write_text(_json.dumps(out, indent=1))
        print(f"wrote {args.out}")
    return 0


def cmd_protected(settings: Settings, args: argparse.Namespace) -> int:
    """Find the mapped boundary of each protected area the risk pages rank."""
    import json as _json

    from .api.settings import SHARED_DIR
    from .protected_areas import build_protected_areas

    areas = _json.loads((SHARED_DIR / "ecological-areas.json").read_text())["areas"]
    http = CachedHttp(settings.cache_dir, offline=args.offline)
    build_protected_areas(http, areas, settings.output_dir)
    return 0


def cmd_shoretype(settings: Settings, args: argparse.Namespace) -> int:
    """Label each case's coastline with what the shore is made of."""
    from .shoretype import build_shore_types

    http = CachedHttp(settings.cache_dir, offline=args.offline)
    for case in load_cases(args.case):
        build_shore_types(http, case["id"], settings.output_dir)
    return 0


def cmd_coast(settings: Settings, args: argparse.Namespace) -> int:
    from .providers.ais_synthetic import LandMask

    land_json, _, _ = load_reference()
    http = CachedHttp(settings.cache_dir, offline=args.offline)
    for case in load_cases(args.case or None):
        art = update_coast(case, http, LandMask(land_json), settings.output_dir)
        geom = art["reportedGeometry"]
        print(f"coast {case['id']:<32} rings={art['coast']['rings']:<4} vertices={art['coast']['vertices']:<6} geometry={geom['basis']}")
    return 0


def cmd_download(settings: Settings, args: argparse.Namespace) -> int:
    providers = _providers(settings)
    artifact_path = settings.output_dir / "cases" / f"{args.case}.json"
    if not artifact_path.exists():
        print(f"no artifact for {args.case}; run `oceanspill build --case {args.case}` first", file=sys.stderr)
        return 1
    artifact = json.loads(artifact_path.read_text())
    wanted = [s for s in artifact["sar"]["scenes"] if not args.provider or s["provider"] == args.provider]
    wanted = [s for s in wanted if s["coversIncident"]] or wanted
    by_name = {p.name: p for p in providers.sar}
    provider_for = {"cdse": by_name.get("sentinel1"), "bhoonidhi": by_name.get("eos04")}
    dest = Path(args.dest) if args.dest else PIPELINE_DIR / "downloads" / args.case
    done = 0
    for s in wanted[: args.limit]:
        p = provider_for.get(s["provider"])
        if p is None:
            print(f"skip {s['name']}: provider not configured")
            continue
        path = p.download(scene_from_json(s), dest)
        print(f"downloaded {path}")
        done += 1
    return 0 if done else 1


def cmd_process(settings: Settings, args: argparse.Namespace) -> int:
    from .sar.landmask import default_land
    from .sar.process import load_measurements, process_scene

    case = next((c for c in load_cases() if c["id"] == args.case), None)
    if case is None:
        print(f"unknown case {args.case}", file=sys.stderr)
        return 1
    if args.scene:
        paths = [Path(args.scene)]
    else:
        folder = PIPELINE_DIR / "downloads" / args.case
        paths = sorted([*folder.glob("*.zip"), *folder.glob("*.SAFE")]) if folder.exists() else []
    if not paths:
        print(f"no downloaded scenes for {args.case}; run `oceanspill download --case {args.case}` first", file=sys.stderr)
        return 1
    land, _, _ = load_reference()
    land_source = default_land(land)
    print(f"land mask: {land_source.source}")
    done = 0
    for path in paths:
        name = path.name.removesuffix(".zip").removesuffix(".SAFE")
        try:
            record = process_scene(path, case, name, land_source, settings.output_dir, radius_km=args.radius_km,
                                   factor=args.factor, model_path=args.model or settings.sar_model or None,
                                   ship_model_path=args.ship_model or settings.ship_model or None)
        except Exception as exc:  # one bad scene must not stop the rest
            print(f"FAILED {name}: {exc}", file=sys.stderr)
            continue
        top = record["spots"][0] if record["spots"] else None
        vessels, no_vessels = record.get("vessels"), record.get("vesselsUnavailable")
        print(f"processed {name}: {len(record['spots'])} dark spot(s)"
              + (f"; nearest {top['distanceKm']} km, {top['areaKm2']} km2, contrast {top['contrastDb']} dB" if top else "")
              + (f"; {len(vessels)} vessel(s) in the radar" if vessels is not None
                 else f"; no vessel detection: {no_vessels}" if no_vessels else ""))
        done += 1
    artifact_path = settings.output_dir / "cases" / f"{args.case}.json"
    if done and artifact_path.exists():
        artifact = json.loads(artifact_path.read_text())
        artifact["sarMeasurements"] = load_measurements(settings.output_dir, args.case)
        artifact_path.write_text(json.dumps(artifact, separators=(",", ":")))
    return 0 if done else 1


def scene_from_json(s: dict) -> SarScene:
    return SarScene(
        id=s["id"], name=s["name"], platform=s["platform"], mode=s["mode"], product_type=s["productType"],
        collection=s["collection"], start=datetime.fromtimestamp(s["start"] / 1000, timezone.utc),
        end=datetime.fromtimestamp(s["end"] / 1000, timezone.utc),
        footprint=[[p["lon"], p["lat"]] for p in s["footprint"]], orbit_direction=s["orbitDirection"],
        online=s["online"], provider=s["provider"], size_bytes=s.get("sizeBytes"), extra=s.get("extra", {}),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill", description="OceanSpill data pipeline")
    parser.add_argument("--env", help="path to .env file")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("providers", help="show configured providers and their status")

    b = sub.add_parser("build", help="build frontend artifacts for real cases")
    b.add_argument("--case", action="append", help="case id (repeatable); default all")
    b.add_argument("--offline", action="store_true", help="use cached provider responses only")

    c = sub.add_parser("coast", help="fetch the OSM coastline for built cases and refresh their reported geometry")
    c.add_argument("--case", action="append", help="case id (repeatable); default all")
    c.add_argument("--offline", action="store_true", help="use cached coastline responses only")

    eo = sub.add_parser("eo-search", help="what Sentinel-2 optical coverage exists over each incident")
    eo.add_argument("--case", action="append", help="case id (repeatable); default all")
    eo.add_argument("--before", type=int, default=2, help="days before the incident to search")
    eo.add_argument("--after", type=int, default=7, help="days after the incident to search")
    eo.add_argument("--pad-deg", type=float, default=0.35, help="half-width of the search box in degrees")
    eo.add_argument("--out", help="write the result as JSON")
    eo.add_argument("--offline", action="store_true", help="use cached responses only")

    pa = sub.add_parser("protected-areas", help="fetch mapped boundaries for the protected areas on the ecological page")
    pa.add_argument("--offline", action="store_true", help="use cached responses only")

    st = sub.add_parser("shoretype", help="label each case coastline with beach, mangrove, rock or built shore")
    st.add_argument("--case", action="append", help="case id (repeatable); default all")
    st.add_argument("--offline", action="store_true", help="use cached responses only")

    d = sub.add_parser("download", help="download SAR scenes for a built case (needs credentials)")
    d.add_argument("--case", required=True)
    d.add_argument("--provider", choices=["cdse", "bhoonidhi"])
    d.add_argument("--limit", type=int, default=1)
    d.add_argument("--dest")

    pr = sub.add_parser("process", help="calibrate downloaded SAR scenes and run the dark-spot detector")
    pr.add_argument("--case", required=True)
    pr.add_argument("--scene", help="a .zip or .SAFE path (default: every scene in downloads/<case>)")
    pr.add_argument("--radius-km", type=float, default=40.0, help="analysis radius around the incident")
    pr.add_argument("--factor", type=int, help="multilook factor (default: 8 for Sentinel-1 GRDH, 4 for EOS-04 MRS, about 75 m pixels)")
    pr.add_argument("--model", help="a trained segmentation model in ONNX form; without it the classical detector runs")
    pr.add_argument("--ship-model", help="a trained ship detector in ONNX form; without it no vessel detection is attempted")

    args = parser.parse_args(argv)
    settings = Settings.load(Path(args.env) if args.env else None)
    try:
        handler = {"providers": cmd_providers, "build": cmd_build, "coast": cmd_coast, "shoretype": cmd_shoretype, "protected-areas": cmd_protected, "eo-search": cmd_eo,
                   "download": cmd_download, "process": cmd_process}[args.command]
        return handler(settings, args)
    except ProviderConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
