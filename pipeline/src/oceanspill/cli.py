from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .build import build, load_cases, load_reference
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
    from .sar.landmask import rings_from_land
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
    rings = rings_from_land(land)
    done = 0
    for path in paths:
        name = path.name.removesuffix(".zip").removesuffix(".SAFE")
        try:
            record = process_scene(path, case, name, rings, settings.output_dir, radius_km=args.radius_km, factor=args.factor)
        except Exception as exc:  # one bad scene must not stop the rest
            print(f"FAILED {name}: {exc}", file=sys.stderr)
            continue
        top = record["spots"][0] if record["spots"] else None
        print(f"processed {name}: {len(record['spots'])} dark spot(s)"
              + (f"; nearest {top['distanceKm']} km, {top['areaKm2']} km2, contrast {top['contrastDb']} dB" if top else ""))
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

    d = sub.add_parser("download", help="download SAR scenes for a built case (needs credentials)")
    d.add_argument("--case", required=True)
    d.add_argument("--provider", choices=["cdse", "bhoonidhi"])
    d.add_argument("--limit", type=int, default=1)
    d.add_argument("--dest")

    pr = sub.add_parser("process", help="calibrate downloaded SAR scenes and run the dark-spot detector")
    pr.add_argument("--case", required=True)
    pr.add_argument("--scene", help="a .zip or .SAFE path (default: every scene in downloads/<case>)")
    pr.add_argument("--radius-km", type=float, default=40.0, help="analysis radius around the incident")
    pr.add_argument("--factor", type=int, default=8, help="multilook factor (8 gives 80 m pixels for IW GRDH)")

    args = parser.parse_args(argv)
    settings = Settings.load(Path(args.env) if args.env else None)
    try:
        handler = {"providers": cmd_providers, "build": cmd_build, "download": cmd_download, "process": cmd_process}[args.command]
        return handler(settings, args)
    except ProviderConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
