from __future__ import annotations

import json
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .config import CASES_DIR, REFERENCE_DIR, Settings
from .geo import epoch_ms, haversine_km, iso, parse_time, point_in_ring
from .geometry import primary_observation, reported_geometry
from .http import CachedHttp
from .providers import Providers
from .providers.ais_synthetic import LandMask
from .providers.base import BBox, ForcingGrid, SarScene, Track
from .sar.process import load_measurements

GAP_THRESHOLD_MIN = 20
SCAT_WIND_COLLECTION = "EOS-06_SCAT_3WW"
SCHEMA_VERSION = 1


def load_reference() -> tuple[dict, list[dict], dict]:
    land = json.loads((REFERENCE_DIR / "land.json").read_text())
    corridors = json.loads((REFERENCE_DIR / "corridors.json").read_text())["corridors"]
    historical = json.loads((REFERENCE_DIR / "historical_incidents.json").read_text())
    return land, corridors, historical


def load_cases(case_ids: list[str] | None = None) -> list[dict[str, Any]]:
    cases = [json.loads(p.read_text()) for p in sorted(CASES_DIR.glob("*.json"))]
    if case_ids:
        wanted = set(case_ids)
        missing = wanted - {c["id"] for c in cases}
        if missing:
            raise ValueError(f"unknown case id(s): {', '.join(sorted(missing))}")
        cases = [c for c in cases if c["id"] in wanted]
    return cases


def reference_time(case: dict[str, Any]) -> tuple[datetime, str]:
    """The instant the analysis is anchored to: the first reported observation of oil, or the incident."""
    incident = parse_time(case["incident"]["time"])
    obs = primary_observation(case)
    if obs:
        t = parse_time(obs["time"])
        if case["analysis"].get("referenceMode") == "observation" or t >= incident:
            return t, f"First reported observation ({obs.get('source', 'report')})"
    return incident, "Incident time"


REGISTRY_FIELDS = ("flag", "shipType", "grossTonnage", "yearOfBuild", "registeredOwner", "ismManager",
                   "classificationSociety", "pAndIClub", "pscInspections", "pscPeriod")


def load_manual_registry() -> list[dict[str, Any]]:
    path = REFERENCE_DIR / "registry_manual.json"
    if not path.exists():
        return []
    return [e for e in json.loads(path.read_text()).get("vessels", []) if e.get("lookedUpOn")]


def apply_manual_registry(vessels: list, entries: list[dict[str, Any]]) -> None:
    """Mark real vessels as registry-verified from manual Equasis lookups (matched on IMO, else name)."""
    for v in vessels:
        if v.provenance != "real" or v.is_facility:
            continue
        entry = next((e for e in entries if (e.get("imo") and e["imo"] == v.imo) or e["name"].upper() == v.name.upper()), None)
        if not entry:
            continue
        details = {k: entry[k] for k in REGISTRY_FIELDS if entry.get(k) is not None}
        v.registry = {
            **v.registry, "verified": True, "source": f"Equasis, looked up {entry['lookedUpOn']}", "details": details,
            "note": entry.get("notes") or "Registry details from a manual Equasis lookup",
        }
        if entry.get("pscDetentions") is not None:
            v.registry["pscDetentions"] = int(entry["pscDetentions"])
        v.registry.setdefault("priorOffences", 0)
        if entry.get("imo") and not v.imo:
            v.imo = entry["imo"]


def detect_gaps(track: Track) -> list[dict[str, Any]]:
    gaps = []
    for a, b in zip(track.pings, track.pings[1:]):
        minutes = (b.t - a.t).total_seconds() / 60
        if minutes > GAP_THRESHOLD_MIN:
            dist = haversine_km(a.lat, a.lon, b.lat, b.lon)
            gaps.append({
                "start": epoch_ms(a.t), "end": epoch_ms(b.t), "minutes": round(minutes),
                "distanceKm": round(dist, 1), "impliedSpeedKn": round(dist / 1.852 / (minutes / 60), 1),
            })
    return gaps


def scene_json(s: SarScene, incident: dict[str, float]) -> dict[str, Any]:
    ring = [{"lat": lat, "lon": lon} for lon, lat in s.footprint]
    return {
        "id": s.id, "name": s.name, "platform": s.platform, "mode": s.mode, "productType": s.product_type,
        "collection": s.collection, "start": epoch_ms(s.start), "end": epoch_ms(s.end),
        "orbitDirection": s.orbit_direction, "online": s.online, "provider": s.provider,
        "sizeBytes": s.size_bytes, "footprint": ring,
        "coversIncident": bool(ring) and point_in_ring(incident["lat"], incident["lon"], ring),
        "extra": s.extra,
    }


def forcing_json(grid: ForcingGrid, hour_step: int) -> dict[str, Any]:
    flat = lambda cube: [None if v is None else round(v, 2) for t in cube for row in t for v in row]  # noqa: E731

    def coverage(cube: list) -> float:
        vals = [v for t in cube for row in t for v in row]
        return round(sum(v is not None for v in vals) / len(vals), 3) if vals else 0.0

    return {
        "lats": grid.lats, "lons": grid.lons, "times": [epoch_ms(t) for t in grid.times], "hourStep": hour_step,
        "shape": [len(grid.times), len(grid.lats), len(grid.lons)],
        "wind": {"u": flat(grid.wind_u), "v": flat(grid.wind_v)},
        "current": {"u": flat(grid.current_u), "v": flat(grid.current_v)},
        "waveHs": flat(grid.wave_hs),
        "sources": grid.sources,
        "coverage": {"wind": coverage(grid.wind_u), "current": coverage(grid.current_u), "waves": coverage(grid.wave_hs)},
    }


def build_case(case: dict[str, Any], providers: Providers, land: LandMask, out_dir: Path) -> dict[str, Any]:
    warnings: list[str] = []
    analysis = case["analysis"]
    inc = case["incident"]["position"]
    incident_time = parse_time(case["incident"]["time"])
    ref_time, ref_basis = reference_time(case)
    hindcast_h = int(analysis["hindcastHours"])
    if analysis.get("referenceMode") != "observation":
        hindcast_h = max(hindcast_h, int((ref_time - incident_time).total_seconds() // 3600) + 6)
    forecast_h = int(analysis["forecastHours"])

    if case["incident"].get("timePrecision") in ("month", "year"):
        warnings.append("Incident date is only known to the month; drift and AIS timing are nominal, not event-accurate")

    # SAR catalogues: every configured provider is searched and results merged.
    pad = max(0.3, case["incident"].get("positionPrecisionKm", 5) / 111 + 0.2)
    bbox = BBox(inc["lon"] - pad, inc["lat"] - pad, inc["lon"] + pad, inc["lat"] + pad)
    d0, d1 = analysis.get("sarWindowDays", [-1, 6])
    sar_start, sar_end = incident_time + timedelta(days=d0), incident_time + timedelta(days=d1)
    sar_status, scenes = [], []
    for p in providers.sar:
        st = p.status()
        entry = {"name": p.name, "agency": p.agency, "sovereign": p.sovereign, "ok": False, "message": st.message, "count": 0}
        if st.available:
            try:
                found = p.search(bbox, sar_start, sar_end)
                scenes.extend(scene_json(s, inc) for s in found)
                entry.update(ok=True, count=len(found))
            except Exception as exc:  # provider failure must not abort the whole build
                entry["message"] = f"search failed: {exc}"
                warnings.append(f"{p.name}: {exc}")
        sar_status.append(entry)
    scenes.sort(key=lambda s: s["start"])

    # Metocean forcing over the full hindcast + forecast window.
    f_start = ref_time - timedelta(hours=hindcast_h + 6)
    f_end = ref_time + timedelta(hours=forecast_h + 6)
    hour_step = int(analysis.get("forcingHourStep", 1))
    fb = analysis["forcingBox"]
    forcing_ref = None
    try:
        grid = providers.metocean.grid(BBox(fb["west"], fb["south"], fb["east"], fb["north"]),
                                       float(analysis["forcingStepDeg"]), f_start, f_end, hour_step)
        forcing = forcing_json(grid, hour_step)
        (out_dir / "forcing").mkdir(parents=True, exist_ok=True)
        (out_dir / "forcing" / f"{case['id']}.json").write_text(json.dumps(forcing, separators=(",", ":")))
        forcing_ref = {"file": f"forcing/{case['id']}.json", "provider": providers.metocean.name,
                       "sources": forcing["sources"], "coverage": forcing["coverage"],
                       "window": {"start": epoch_ms(f_start), "end": epoch_ms(f_end)}}
        if forcing["coverage"]["current"] == 0:
            warnings.append("No ocean current data for this period; drift uses the modelled current field")
    except Exception as exc:
        warnings.append(f"metocean forcing failed: {exc}")

    # Indian scatterometer winds (Oceansat-3 / EOS-06) listed from the Bhoonidhi catalogue. They are
    # global daily products, so they are matched on date only.
    wind_catalog = None
    eos = next((p for p in providers.sar if p.name == "eos04" and p.status().available), None)
    if eos is not None and f_end.year >= 2023:
        try:
            products = [x for x in eos.list_products(SCAT_WIND_COLLECTION, f_start, f_end) if "25km" in x["id"]]
            wind_catalog = {"provider": "bhoonidhi", "collection": SCAT_WIND_COLLECTION,
                            "description": "Oceansat-3 (EOS-06) SCAT-3 daily global ocean wind vectors, 25 km",
                            "products": products, "online": sum(1 for x in products if x["online"])}
        except Exception as exc:
            warnings.append(f"EOS-06 scatterometer catalogue search failed: {exc}")

    # AIS over the attribution window.
    a_start = ref_time - timedelta(hours=hindcast_h + 12)
    a_end = ref_time + timedelta(hours=forecast_h)
    vessels, tracks = providers.ais.tracks(case, a_start, a_end)
    apply_manual_registry(vessels, load_manual_registry())
    for t in tracks:
        warnings.extend(f"{t.key}: {n}" for n in t.notes if n.startswith("WARNING"))

    sanctions = []
    try:
        sanctions = [
            {"key": c.key, "name": c.name, "imo": c.imo, "listed": c.listed, "list": c.list_name,
             "reference": c.reference, "checkedAt": iso(c.checked_at)}
            for c in providers.sanctions.check(vessels)
        ]
    except Exception as exc:
        warnings.append(f"sanctions check failed: {exc}")

    artifact = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(datetime.now(timezone.utc)),
        "case": case,
        "reference": {"time": epoch_ms(ref_time), "basis": ref_basis, "hindcastHours": hindcast_h, "forecastHours": forecast_h},
        "reportedGeometry": reported_geometry(case, land),
        "sar": {"window": {"start": epoch_ms(sar_start), "end": epoch_ms(sar_end)},
                "bbox": {"west": bbox.west, "south": bbox.south, "east": bbox.east, "north": bbox.north},
                "providers": sar_status, "scenes": scenes},
        "forcing": forcing_ref,
        "ais": {"provider": providers.ais.name, "agency": providers.ais.agency,
                "window": {"start": epoch_ms(a_start), "end": epoch_ms(a_end)},
                "pingFormat": ["secondsFromWindowStart", "lat", "lon", "sogKn", "cogDeg", "headingDeg", "navStatus"]},
        "vessels": [
            {"key": v.key, "name": v.name, "type": v.type, "role": v.role, "provenance": v.provenance,
             "mmsi": v.mmsi, "imo": v.imo, "flag": v.flag, "operator": v.operator, "isFacility": v.is_facility,
             "registry": v.registry, "anchors": v.anchors, "note": v.note}
            for v in vessels
        ],
        "tracks": [
            {"key": t.key, "provenance": t.provenance, "notes": t.notes, "gaps": t.gaps if t.gaps is not None else detect_gaps(t) if not t.key.startswith("FAC-") else [],
             "pings": [[int((p.t - a_start).total_seconds()), round(p.lat, 4), round(p.lon, 4), p.sog, round(p.cog), round(p.heading), p.nav_status]
                       for p in t.pings]}
            for t in tracks
        ],
        "sanctions": sanctions,
        "sarMeasurements": load_measurements(out_dir, case["id"]),
        "windCatalog": wind_catalog,
        "warnings": warnings,
    }
    (out_dir / "cases").mkdir(parents=True, exist_ok=True)
    (out_dir / "cases" / f"{case['id']}.json").write_text(json.dumps(artifact, separators=(",", ":")))
    return artifact


def build(settings: Settings, case_ids: list[str] | None = None, offline: bool = False) -> dict[str, Any]:
    land_json, corridors, historical = load_reference()
    http = CachedHttp(settings.cache_dir, offline=offline)
    providers = Providers.from_settings(settings, http, land_json, corridors)
    land = LandMask(land_json)
    out = settings.output_dir
    out.mkdir(parents=True, exist_ok=True)

    summaries, failures = [], []
    for case in load_cases(case_ids):
        try:
            art = build_case(case, providers, land, out)
        except Exception as exc:
            failures.append({"id": case["id"], "error": str(exc), "trace": traceback.format_exc()})
            continue
        summaries.append({
            "id": case["id"], "title": case["title"], "region": case["region"], "file": f"cases/{case['id']}.json",
            "incidentTime": case["incident"]["time"], "position": case["incident"]["position"],
            "sourceType": case["sourceType"], "sarScenes": len(art["sar"]["scenes"]),
            "forcing": bool(art["forcing"]), "warnings": len(art["warnings"]),
        })

    index_path = out / "index.json"
    previous = json.loads(index_path.read_text()) if index_path.exists() and case_ids else None
    if previous:
        built = {s["id"] for s in summaries}
        summaries = [s for s in previous["cases"] if s["id"] not in built] + summaries
    summaries.sort(key=lambda s: s["incidentTime"], reverse=True)

    index = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(datetime.now(timezone.utc)),
        "providers": [
            {"kind": s.kind, "name": s.name, "agency": s.agency, "sovereign": s.sovereign, "available": s.available, "message": s.message}
            for s in providers.statuses()
        ],
        "cases": summaries,
        "historical": historical,
        "failures": [{"id": f["id"], "error": f["error"]} for f in failures],
    }
    index_path.write_text(json.dumps(index, indent=1))
    return {"index": index, "failures": failures}
