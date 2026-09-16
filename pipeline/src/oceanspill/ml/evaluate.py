"""Score a trained model on tiles it never saw, broken down by what the tile actually holds.

The single number a segmentation run prints hides the thing that matters for this project: a
detector that finds every slick is useless if it also fires on every patch of calm water. So the
tiles are split by what is in them and scored separately —

* tiles with confirmed oil: how much of it is found, and how much of what is marked is really oil;
* tiles from **look-alike** scenes: dark patches that are not oil, where a firing is a false alarm;
* tiles of **clean sea**: where anything at all is a false alarm.

The look-alike figure is the one to quote against a plain dark-spot threshold, which by construction
cannot tell the two apart.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .train_sar import Tiles, device_for, evaluate, split_by_scene
from .unet import UNet


def detections_per_tile(model, loader, device, threshold: float, min_pixels: int) -> tuple[int, int, list[int]]:
    """How many tiles produce a detection of at least `min_pixels`, and how big those are."""
    import torch

    fired = tiles = 0
    areas: list[int] = []
    model.eval()
    with torch.no_grad():
        for x, _ in loader:
            predicted = torch.sigmoid(model(x.to(device))) > threshold
            counts = predicted.flatten(1).sum(1).cpu().numpy()
            tiles += len(counts)
            fired += int((counts >= min_pixels).sum())
            areas.extend(int(c) for c in counts if c >= min_pixels)
    return fired, tiles, areas


def main(argv: list[str] | None = None) -> int:
    import torch
    from torch.utils.data import DataLoader

    parser = argparse.ArgumentParser(prog="oceanspill-evaluate", description=__doc__)
    parser.add_argument("--run", required=True, help="a training run directory holding unet_best.pt")
    parser.add_argument("--cache", required=True)
    parser.add_argument("--val-cache")
    parser.add_argument("--crop", type=int, default=256)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--min-pixels", type=int, default=50, help="a detection smaller than this is speckle")
    parser.add_argument("--val-fraction", type=float, default=0.15)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=20260916)
    args = parser.parse_args(argv)

    run = Path(args.run)
    cache = Path(args.cache)
    val_cache = Path(args.val_cache) if args.val_cache else cache
    index = json.loads((cache / "index.json").read_text())
    val_index = json.loads((val_cache / "index.json").read_text())

    state = torch.load(run / "unet_best.pt", map_location="cpu", weights_only=False)
    saved = state.get("args", {})
    device = device_for(args.device)
    # A model trained on one polarisation must be fed one polarisation. The cache holds both, so the
    # channel count comes from what the run selected, not from what happens to be on disk.
    use_channels = saved.get("use_channels") or saved.get("useChannels")
    if isinstance(use_channels, str):
        use_channels = [int(c) for c in use_channels.split(",")]
    cache_channels = int(np.load(cache / "images.npy", mmap_mode="r").shape[-1])
    channels = len(use_channels) if use_channels else cache_channels
    model = UNet(in_channels=channels, base=saved.get("base", 32), depth=saved.get("depth", 4)).to(device)
    model.load_state_dict(state["model"])

    if args.val_cache:
        rows = list(range(val_index["count"]))
    else:
        rows = split_by_scene(index, args.val_fraction, saved.get("seed", args.seed)).val
    tiles = val_index["tiles"]
    standardise = bool(saved.get("standardise", False))

    groups = {
        "with the target in them": [i for i in rows if tiles[i]["oilFraction"] > 0],
        "look-alike scenes": [i for i in rows if tiles[i].get("label") == "lookalike"],
        "clean sea": [i for i in rows if tiles[i].get("label") == "no_oil"],
    }

    meta_path = run / "unet_best.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    threshold = float(meta.get("threshold", 0.5))
    print(f"{run.name}: threshold {threshold}, {channels} channels, {len(rows)} validation tiles")

    report: dict[str, object] = {"threshold": threshold, "minPixels": args.min_pixels, "groups": {}}

    positives = groups["with the target in them"]
    if positives:
        loader = DataLoader(Tiles(val_cache, positives, args.crop, augment=False, standardise=standardise, channels=use_channels),
                            batch_size=args.batch, num_workers=args.workers)
        scores = evaluate(model, loader, device, [threshold])[0]
        report["groups"]["withTarget"] = {
            "tiles": len(positives), "iou": round(scores.iou, 4), "dice": round(scores.dice, 4),
            "precision": round(scores.precision, 4), "recall": round(scores.recall, 4),
        }
        print(f"  with the target in them ({len(positives)} tiles): IoU {scores.iou:.3f} · "
              f"finds {scores.recall * 100:.0f}% of it · {scores.precision * 100:.0f}% of what it marks is right")

    for name, key in (("look-alike scenes", "lookalike"), ("clean sea", "cleanSea")):
        rows_here = groups[name]
        if not rows_here:
            print(f"  {name}: none in the validation split")
            continue
        loader = DataLoader(Tiles(val_cache, rows_here, args.crop, augment=False, standardise=standardise, channels=use_channels),
                            batch_size=args.batch, num_workers=args.workers)
        fired, total, areas = detections_per_tile(model, loader, device, threshold, args.min_pixels)
        report["groups"][key] = {
            "tiles": total, "tilesWithDetection": fired, "falseAlarmRate": round(fired / total, 4) if total else None,
            "medianAreaPixels": float(np.median(areas)) if areas else 0.0,
        }
        print(f"  {name} ({total} tiles): fires on {fired / total * 100:.1f}% of them"
              + (f", median {np.median(areas):.0f} pixels" if areas else ""))

    path = run / "evaluation.json"
    path.write_text(json.dumps(report, indent=1))
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
