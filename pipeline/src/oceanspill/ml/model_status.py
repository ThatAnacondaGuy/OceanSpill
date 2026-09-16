"""Collect what the trained models actually score, for the interface to show.

The pages used to say "no model has been trained; no accuracy figures are reported", which was true
and had to stay true until it wasn't. This gathers the figures each training run wrote beside its
model and puts them in shared/model-status.json, which the web app reads. Nothing is typed in by
hand, so the numbers on screen are the ones the runs produced.

A model with no run on disk stays marked as not trained.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import PIPELINE_DIR
from ..api.settings import SHARED_DIR

# Each entry: the key the app uses, where the run wrote its figures, and how to describe it.
MODELS = [
    {
        "id": "sarSegmentation",
        "run": "runs/sar_oil",
        "task": "Finds oil pixels in Sentinel-1 and EOS-04 radar scenes",
        "architecture": "U-Net, 2 input channels (co-polarised and cross-polarised backscatter in decibels)",
        "training": "Sentinel-1 oil spill scenes with hand-drawn masks, plus look-alike and clean-sea scenes as negatives",
        "dataset": "Sentinel-1 oil spill dataset (Zenodo 8346860)",
        "datasetUrl": "https://zenodo.org/records/8346860",
    },
    {
        "id": "opticalSegmentation",
        "run": "runs/mados_optical",
        "task": "Finds oil in Sentinel-2 optical scenes, where radar look-alikes behave differently",
        "architecture": "U-Net, 4 input channels (10 m blue, green, red and near-infrared reflectance)",
        "training": "MADOS marine debris and oil spill scenes, fifteen hand-labelled classes",
        "dataset": "MADOS (Marine Debris and Oil Spill), Sentinel-2",
        "datasetUrl": "https://zenodo.org/records/10664073",
    },
    {
        "id": "shipDetection",
        "run": "runs/ship_detection",
        "task": "Finds vessels in radar imagery, including ships transmitting nothing on AIS",
        "architecture": "U-Net, single-channel radar amplitude; connected regions become vessel detections",
        "training": "SAR Ship Detection Dataset, ship outlines rasterised from the annotations",
        "dataset": "SSDD (SAR Ship Detection Dataset)",
        "datasetUrl": "https://github.com/TianwenZhang0825/Official-SSDD",
    },
]


def collect(pipeline_dir: Path) -> dict[str, Any]:
    models: dict[str, Any] = {}
    for spec in MODELS:
        run = pipeline_dir / spec["run"]
        meta_path = run / "unet_best.json"
        entry = {k: spec[k] for k in ("task", "architecture", "training", "dataset", "datasetUrl")}
        if not meta_path.exists():
            entry.update({"trained": False, "note": "Not trained yet; no accuracy figures."})
            models[spec["id"]] = entry
            continue
        meta = json.loads(meta_path.read_text())
        val = meta.get("val", {})
        alarms = meta.get("falseAlarms", {})
        onnx = run / "unet_best.onnx"
        entry.update({
            "trained": True,
            "version": f"{spec['id']}-{datetime.fromtimestamp(meta_path.stat().st_mtime, timezone.utc):%Y%m%d}",
            "trainedAt": datetime.fromtimestamp(meta_path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds"),
            "threshold": meta.get("threshold"),
            "tiles": meta.get("tiles"),
            "scores": {
                "iou": round(val.get("iou", 0.0), 4),
                "dice": round(val.get("dice", 0.0), 4),
                "precision": round(val.get("precision", 0.0), 4),
                "recall": round(val.get("recall", 0.0), 4),
            },
            "falseAlarmRate": round(alarms.get("falseAlarmRate", 0.0), 4) if alarms else None,
            "falseAlarmBasis": (f"{alarms.get('tilesWithDetection', 0)} of {alarms.get('tiles', 0)} tiles with no "
                                f"target in them produced a detection of at least "
                                f"{alarms.get('minPixels', 0)} pixels") if alarms else None,
            "modelFile": str(onnx.relative_to(pipeline_dir)) if onnx.exists() else None,
        })
        models[spec["id"]] = entry
    return models


def collect_measurements(pipeline_dir: Path) -> dict[str, Any]:
    """Figures measured from observations rather than trained: drift and AIS gaps."""
    out: dict[str, Any] = {}
    drift = pipeline_dir / "runs" / "drift_calibration" / "drift_calibration.json"
    if drift.exists():
        data = json.loads(drift.read_text())
        windage = next((w for w in data.get("windage", []) if w["drogue"].startswith("undrogued, northern")), None)
        windage = windage or next((w for w in data.get("windage", []) if w["drogue"].startswith("undrogued")), None)
        dispersion = data.get("diffusivity")
        out["drift"] = {
            "source": data.get("source"),
            "observations": data.get("observations"),
            "buoys": data.get("buoys"),
            "windage": None if not windage else {
                "fraction": round(windage["windage"], 5),
                "ci95": [round(v, 5) for v in windage["windage_ci95"]],
                "deflectionDeg": round(windage["deflection_deg"], 1),
                "samples": windage["samples"],
                "group": windage["drogue"],
            },
            "diffusivity": None if not dispersion else {
                "m2s": round(dispersion["diffusivity_m2s"], 1),
                "ci95": [round(v, 1) for v in dispersion["ci95"]],
                "pairs": dispersion["pairs"],
                "observedSeparationKm": dict(zip([str(h) for h in dispersion["hours"]],
                                                 [round(v, 1) for v in dispersion["mean_separation_km"]])),
            },
        }
    validation = pipeline_dir / "runs" / "drift_validation" / "drift_validation.json"
    if validation.exists():
        data = json.loads(validation.read_text())
        out["driftValidation"] = {k: data.get(k) for k in ("spread", "trackSkill") if data.get(k)}
    gaps = pipeline_dir / "runs" / "ais_anomaly" / "ais_gap_scale.json"
    if gaps.exists():
        data = json.loads(gaps.read_text())
        out["aisGaps"] = {
            "events": data["events"], "source": data["source"], "window": data["window"],
            "hoursPercentiles": data["hours_percentiles"],
            "distanceFromShorePercentiles": data["shore_percentiles"],
            "calibration": data["calibration"], "caveat": data["caveat"],
        }
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-model-status", description=__doc__)
    parser.add_argument("--pipeline", default=str(PIPELINE_DIR))
    parser.add_argument("--out", default=str(SHARED_DIR / "model-status.json"))
    args = parser.parse_args(argv)

    pipeline_dir = Path(args.pipeline)
    status = {
        "_comment": "Written by oceanspill-model-status from the training runs. Do not edit by hand.",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "models": collect(pipeline_dir),
        "measured": collect_measurements(pipeline_dir),
    }
    Path(args.out).write_text(json.dumps(status, indent=1) + "\n")

    for name, model in status["models"].items():
        if model.get("trained"):
            s = model["scores"]
            print(f"{name}: IoU {s['iou']:.3f} · Dice {s['dice']:.3f} · precision {s['precision']:.3f} "
                  f"· recall {s['recall']:.3f}" + (f" · false alarms {model['falseAlarmRate'] * 100:.1f}%" if model.get("falseAlarmRate") is not None else ""))
        else:
            print(f"{name}: not trained")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
