"""Turn the Sentinel-1 oil spill scenes into a compact training cache.

Each scene is 2048 x 2048 with two polarisations (VV and VH) in decibels, about 40 MB, and the whole
collection is well over a hundred gigabytes. Training reads the same pixels many times, so they are
cut into tiles once, quantised to a byte per pixel per channel, and written to a memory-mapped file
the loader can read without unpacking anything.

Quantisation is 0.2 dB per step over the range sea and oil actually occupy, which is far finer than
the speckle noise on any single pixel.

Three kinds of scene go in: confirmed oil (with masks), look-alikes — the dark patches that are not
oil — and clean sea. Oil tiles teach the model what to find; the other two teach it what to leave
alone, which is the part a plain dark-spot threshold gets wrong.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import tifffile

# Decibel range kept for each channel. VH backscatter sits lower than VV over water.
CHANNEL_RANGE = {"vv": (-40.0, 5.0), "vh": (-45.0, 0.0)}
TILE = 512
CLASSES = ("oil", "lookalike", "no_oil")


@dataclass
class TilePlan:
    scene: str
    label: str
    row: int
    col: int
    oil_fraction: float


def quantise(scene: np.ndarray) -> np.ndarray:
    """Two channels of decibels to one byte per pixel, each over its own range."""
    out = np.empty(scene.shape, dtype=np.uint8)
    for c, (name, (low, high)) in enumerate(CHANNEL_RANGE.items()):
        channel = scene[..., c] if scene.ndim == 3 else scene
        scaled = (np.nan_to_num(channel, nan=low) - low) / (high - low)
        out[..., c] = np.clip(scaled * 255.0, 0, 255).astype(np.uint8)
    return out


def dequantise(tiles: np.ndarray) -> np.ndarray:
    """Back to [0, 1] per channel, which is what the network sees."""
    return tiles.astype(np.float32) / 255.0


def plan_scene(scene_id: str, label: str, mask: np.ndarray | None, tiles_per_clean: int, rng: np.random.Generator) -> list[TilePlan]:
    """Which tiles to keep from one scene: every tile holding oil, plus a sample of the rest."""
    plans: list[TilePlan] = []
    steps = range(0, 2048 - TILE + 1, TILE)
    empty: list[TilePlan] = []
    for row in steps:
        for col in steps:
            fraction = 0.0
            if mask is not None:
                window = mask[row : row + TILE, col : col + TILE]
                fraction = float((window > 0).mean())
            (plans if fraction > 0.001 else empty).append(TilePlan(scene_id, label, row, col, fraction))
    keep = min(tiles_per_clean, len(empty))
    if keep:
        for i in rng.choice(len(empty), size=keep, replace=False):
            plans.append(empty[int(i)])
    return plans


def scene_paths(root: Path, label: str) -> dict[str, Path]:
    folder = {"oil": "Oil", "lookalike": "Lookalike", "no_oil": "No_oil"}[label]
    directory = root / folder
    if not directory.is_dir():
        return {}
    return {p.stem: p for p in sorted(directory.glob("*.tif"))}


def build(root: Path, masks: Path | None, out: Path, tiles_per_clean: int, seed: int, limit: int | None) -> dict:
    rng = np.random.default_rng(seed)
    out.mkdir(parents=True, exist_ok=True)

    mask_files = {p.stem: p for p in sorted(masks.glob("*.tif"))} if masks and masks.is_dir() else {}
    plans: list[TilePlan] = []
    scenes: dict[str, Path] = {}

    for label in CLASSES:
        found = scene_paths(root, label)
        if limit:
            found = dict(list(found.items())[:limit])
        for scene_id, path in found.items():
            key = f"{label}/{scene_id}"
            scenes[key] = path
            mask = None
            if label == "oil":
                mask_path = mask_files.get(scene_id)
                if mask_path is None:
                    continue  # an oil scene without its mask cannot teach anything
                mask = tifffile.imread(mask_path)
            plans.extend(plan_scene(key, label, mask, tiles_per_clean, rng))
        print(f"  {label}: {len(found)} scenes")

    if not plans:
        raise SystemExit(f"no scenes found under {root}")

    rng.shuffle(plans)
    count = len(plans)
    print(f"  {count} tiles ({sum(p.oil_fraction > 0 for p in plans)} contain oil)")

    images = np.lib.format.open_memmap(out / "images.npy", mode="w+", dtype=np.uint8, shape=(count, TILE, TILE, 2))
    masks_out = np.lib.format.open_memmap(out / "masks.npy", mode="w+", dtype=np.uint8, shape=(count, TILE, TILE))

    # One scene is read once and all of its tiles written, so the big files are never re-read.
    by_scene: dict[str, list[tuple[int, TilePlan]]] = {}
    for i, plan in enumerate(plans):
        by_scene.setdefault(plan.scene, []).append((i, plan))

    done = 0
    for key, items in by_scene.items():
        label, scene_id = key.split("/", 1)
        scene = quantise(tifffile.imread(scenes[key]))
        mask = tifffile.imread(mask_files[scene_id]) if label == "oil" and scene_id in mask_files else None
        for index, plan in items:
            # A few scenes are a pixel or two short of 2048, so an edge tile comes back small. It is
            # written into the corner of an empty tile rather than dropped, which keeps the planned
            # index and the written tile in step.
            patch = scene[plan.row : plan.row + TILE, plan.col : plan.col + TILE]
            images[index, : patch.shape[0], : patch.shape[1]] = patch
            if mask is not None:
                window = (mask[plan.row : plan.row + TILE, plan.col : plan.col + TILE] > 0).astype(np.uint8)
                masks_out[index, : window.shape[0], : window.shape[1]] = window
        done += 1
        if done % 100 == 0:
            print(f"  {done}/{len(by_scene)} scenes written")

    images.flush()
    masks_out.flush()

    index = {
        "tile": TILE,
        "channels": list(CHANNEL_RANGE),
        "channelRange": {k: list(v) for k, v in CHANNEL_RANGE.items()},
        "count": count,
        "tiles": [{"scene": p.scene, "label": p.label, "row": p.row, "col": p.col, "oilFraction": round(p.oil_fraction, 5)} for p in plans],
        "scenes": sorted(by_scene),
        "source": "Sentinel-1 oil spill, look-alike and clean-sea scenes (dual polarisation, decibels)",
    }
    (out / "index.json").write_text(json.dumps(index))
    print(f"  wrote {out}")
    return index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-prepare-sar", description=__doc__)
    parser.add_argument("--root", required=True, help="directory holding Oil/, Lookalike/ and No_oil/")
    parser.add_argument("--masks", help="directory of oil masks named like the oil scenes")
    parser.add_argument("--out", required=True)
    parser.add_argument("--clean-tiles", type=int, default=2, help="tiles kept from the oil-free part of each scene")
    parser.add_argument("--limit", type=int, help="only this many scenes per class, for a quick check")
    parser.add_argument("--seed", type=int, default=20260916)
    args = parser.parse_args(argv)

    print(f"preparing tiles from {args.root}")
    build(Path(args.root), Path(args.masks) if args.masks else None, Path(args.out), args.clean_tiles, args.seed, args.limit)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
