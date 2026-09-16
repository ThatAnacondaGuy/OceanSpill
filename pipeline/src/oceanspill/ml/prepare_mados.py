"""Turn the MADOS optical scenes into the same tile cache the SAR trainer reads.

MADOS is Sentinel-2 surface reflectance over real marine scenes, hand-labelled into fifteen classes:
oil spill, and the things that get mistaken for it — sargassum, floating algae, natural organic
material, foam, sea snot, ships, wakes, turbid and sediment-laden water.

Radar sees an oil slick as a dark patch; an optical sensor sees colour, so the two instruments fail
in different ways and confirm each other when they agree. That is why the problem statement asks for
both.

The four 10 m bands are stacked per crop. Reflectance over water is small, so the byte scale runs to
0.3 rather than 1.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import tifffile

# The 10 m bands, by nominal wavelength. Each resolution in MADOS is cropped on its own grid, so
# crop 1 at 20 m is not the same piece of sea as crop 1 at 10 m; mixing them by index would misalign
# the stack. The 10 m set covers blue to near-infrared, which is what separates oil from water.
#
# Sentinel-2A and 2B sit a nanometre or two apart and the file names carry the exact figure, so each
# band is matched to the closest one the scene actually has rather than by an exact name.
BANDS_10M = [492, 560, 665, 833]
BAND_TOLERANCE_NM = 4
REFLECTANCE_MAX = 0.3

# The fifteen labels, grouped by what they mean for an oil spill watch.
CLASS_NAMES = {
    1: "Marine Debris", 2: "Dense Sargassum", 3: "Sparse Floating Algae", 4: "Natural Organic Material",
    5: "Ship", 6: "Oil Spill", 7: "Marine Water", 8: "Sediment-Laden Water", 9: "Foam",
    10: "Turbid Water", 11: "Shallow Water", 12: "Waves & Wakes", 13: "Oil Platform",
    14: "Jellyfish", 15: "Sea snot",
}
OIL = 6
# Floating matter that looks like oil to a detector and is the reason for the false-alarm figure.
LOOKALIKE = (1, 2, 3, 4, 9, 12, 15)


def scene_bands(scene_dir: Path, scene: str) -> dict[int, int] | None:
    """The wavelength each wanted band is actually stored under for this scene."""
    available = set()
    for path in (scene_dir / "10").glob(f"{scene}_L2R_rhorc_*.tif"):
        parts = path.stem.split("_")
        if len(parts) >= 2 and parts[-2].isdigit():
            available.add(int(parts[-2]))
    chosen = {}
    for wanted in BANDS_10M:
        near = [w for w in available if abs(w - wanted) <= BAND_TOLERANCE_NM]
        if not near:
            return None
        chosen[wanted] = min(near, key=lambda w: abs(w - wanted))
    return chosen


def read_crop(scene_dir: Path, scene: str, crop: str, bands: dict[int, int]) -> np.ndarray | None:
    """One crop as a stack of bands on the 10 m grid, or None when a band is missing."""
    layers = []
    for wanted in BANDS_10M:
        path = scene_dir / "10" / f"{scene}_L2R_rhorc_{bands[wanted]}_{crop}.tif"
        if not path.exists():
            return None
        layers.append(tifffile.imread(path).astype(np.float32))
    return np.stack(layers, axis=-1)


def quantise(stack: np.ndarray) -> np.ndarray:
    scaled = np.nan_to_num(stack, nan=0.0) / REFLECTANCE_MAX
    return np.clip(scaled * 255.0, 0, 255).astype(np.uint8)


def build(root: Path, out: Path, split_name: str) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    names = [line.strip() for line in (root / "splits" / f"{split_name}_X.txt").read_text().splitlines() if line.strip()]

    bands_for: dict[str, dict[int, int]] = {}
    kept: list[tuple[str, str]] = []
    for name in names:
        scene, crop = name.rsplit("_", 1)
        if not (root / scene / "10" / f"{scene}_L2R_cl_{crop}.tif").exists():
            continue
        if scene not in bands_for:
            found = scene_bands(root / scene, scene)
            if found is None:
                continue
            bands_for[scene] = found
        if scene in bands_for:
            kept.append((scene, crop))
    if not kept:
        raise SystemExit(f"no crops found for split {split_name}")

    first = next((stack for stack in (read_crop(root / scene, scene, crop, bands_for[scene]) for scene, crop in kept) if stack is not None), None)
    if first is None:
        raise SystemExit("no crop has a complete set of bands")
    size, channels = first.shape[0], first.shape[2]

    images = np.lib.format.open_memmap(out / "images.npy", mode="w+", dtype=np.uint8, shape=(len(kept), size, size, channels))
    masks = np.lib.format.open_memmap(out / "masks.npy", mode="w+", dtype=np.uint8, shape=(len(kept), size, size))
    classes = np.lib.format.open_memmap(out / "classes.npy", mode="w+", dtype=np.uint8, shape=(len(kept), size, size))

    tiles = []
    written = 0
    for scene, crop in kept:
        stack = read_crop(root / scene, scene, crop, bands_for[scene])
        label = tifffile.imread(root / scene / "10" / f"{scene}_L2R_cl_{crop}.tif")
        if stack is None or stack.shape[0] != size or label.shape[0] != size:
            continue
        images[written] = quantise(stack)
        masks[written] = (label == OIL).astype(np.uint8)
        classes[written] = label
        present = set(np.unique(label).tolist())
        tiles.append({
            "scene": scene, "crop": crop,
            "oilFraction": float((label == OIL).mean()),
            "lookalikeFraction": float(np.isin(label, LOOKALIKE).mean()),
            "classes": sorted(present - {0}),
        })
        written += 1

    images.flush()
    masks.flush()
    classes.flush()

    index = {
        "tile": size,
        "channelCount": channels,
        "channels": [f"rhorc_{b}nm" for b in BANDS_10M],
        "reflectanceMax": REFLECTANCE_MAX,
        "count": written,
        "split": split_name,
        "tiles": tiles[:written],
        "scenes": sorted({t["scene"] for t in tiles[:written]}),
        "classNames": CLASS_NAMES,
        "oilClass": OIL,
        "lookalikeClasses": list(LOOKALIKE),
        "source": "MADOS: Sentinel-2 marine debris and oil spill scenes, fifteen hand-labelled classes",
    }
    (out / "index.json").write_text(json.dumps(index))
    oil_tiles = sum(1 for t in index["tiles"] if t["oilFraction"] > 0)
    print(f"  {split_name}: {written} crops, {oil_tiles} contain oil, {channels} bands")
    return index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-prepare-mados", description=__doc__)
    parser.add_argument("--root", required=True, help="the MADOS directory holding Scene_* and splits/")
    parser.add_argument("--out", required=True, help="a directory per split is written under here")
    parser.add_argument("--splits", nargs="*", default=["train", "val", "test"])
    args = parser.parse_args(argv)

    for split in args.splits:
        build(Path(args.root), Path(args.out) / split, split)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
