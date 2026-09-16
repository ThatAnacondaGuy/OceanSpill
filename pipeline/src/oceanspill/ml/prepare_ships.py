"""Turn the SAR Ship Detection Dataset into the tile cache the trainer reads.

Vessels are found from AIS today, which means a ship with its transmitter off is invisible. Radar
sees the hull regardless, so a detector trained on ship chips gives the missing half: something in
the water that nothing is broadcasting from.

SSDD ships are outlined as polygons in the annotation files, so the masks here are rasterised from
those outlines rather than read from the dataset's own JPEG masks, which are lossy and blur the
edges of small vessels.

Chips vary in size and are padded onto a fixed square. Padding is written as sea with no ship, and
because it is dark and featureless it teaches nothing either way.
"""
from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ElementTree
from pathlib import Path

import numpy as np

CANVAS = 512


def parse_polygons(xml_path: Path) -> tuple[list[list[tuple[int, int]]], tuple[int, int]]:
    """Ship outlines and the chip size they belong to."""
    root = ElementTree.parse(xml_path).getroot()
    size = root.find("size")
    width = int(size.findtext("width", "0"))
    height = int(size.findtext("height", "0"))
    polygons = []
    for obj in root.findall("object"):
        segment = obj.find("segm")
        points = []
        if segment is not None:
            for point in segment.findall("point"):
                x, y = (point.text or "0,0").split(",")
                points.append((int(float(x)), int(float(y))))
        if len(points) < 3:
            # Some objects carry only a box; its corners make a rectangle of the same extent.
            box = obj.find("bndbox")
            if box is None:
                continue
            x1, y1 = int(float(box.findtext("xmin", "0"))), int(float(box.findtext("ymin", "0")))
            x2, y2 = int(float(box.findtext("xmax", "0"))), int(float(box.findtext("ymax", "0")))
            points = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
        polygons.append(points)
    return polygons, (height, width)


def rasterise(polygons: list[list[tuple[int, int]]], shape: tuple[int, int]) -> np.ndarray:
    """Fill each outline, by testing rows against the edges that cross them."""
    mask = np.zeros(shape, dtype=np.uint8)
    for points in polygons:
        if len(points) < 3:
            continue
        ys = [p[1] for p in points]
        for y in range(max(0, min(ys)), min(shape[0], max(ys) + 1)):
            crossings = []
            for i in range(len(points)):
                (x1, y1), (x2, y2) = points[i], points[(i + 1) % len(points)]
                if (y1 <= y < y2) or (y2 <= y < y1):
                    crossings.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
            crossings.sort()
            for i in range(0, len(crossings) - 1, 2):
                left, right = int(round(crossings[i])), int(round(crossings[i + 1]))
                mask[y, max(0, left) : min(shape[1], right + 1)] = 1
    return mask


def build(root: Path, split: str, out: Path) -> dict:
    from PIL import Image

    images_dir = root / f"JPEGImages_{split}"
    annotations_dir = root / f"Annotations_{split}"
    names = sorted(p.stem for p in annotations_dir.glob("*.xml"))
    if not names:
        raise SystemExit(f"no annotations in {annotations_dir}")
    out.mkdir(parents=True, exist_ok=True)

    images = np.lib.format.open_memmap(out / "images.npy", mode="w+", dtype=np.uint8, shape=(len(names), CANVAS, CANVAS, 1))
    masks = np.lib.format.open_memmap(out / "masks.npy", mode="w+", dtype=np.uint8, shape=(len(names), CANVAS, CANVAS))

    tiles = []
    written = ships = 0
    for name in names:
        chip_path = images_dir / f"{name}.jpg"
        if not chip_path.exists():
            continue
        polygons, shape = parse_polygons(annotations_dir / f"{name}.xml")
        chip = np.asarray(Image.open(chip_path).convert("L"), dtype=np.uint8)
        mask = rasterise(polygons, chip.shape)
        h, w = chip.shape[:2]
        if h > CANVAS or w > CANVAS:
            chip, mask = chip[:CANVAS, :CANVAS], mask[:CANVAS, :CANVAS]
            h, w = chip.shape[:2]
        images[written, :h, :w, 0] = chip
        masks[written, :h, :w] = mask
        tiles.append({
            "scene": name, "label": "ship" if polygons else "sea",
            "oilFraction": float(mask.mean()),  # the trainer's name for "fraction of the target"
            "ships": len(polygons), "height": int(h), "width": int(w),
        })
        ships += len(polygons)
        written += 1

    images.flush()
    masks.flush()
    index = {
        "tile": CANVAS, "channelCount": 1, "channels": ["sar_amplitude"], "count": written,
        "split": split, "tiles": tiles[:written], "scenes": [t["scene"] for t in tiles[:written]],
        "ships": ships,
        "source": "SAR Ship Detection Dataset (SSDD), ship outlines rasterised from the annotations",
        "target": "ship",
    }
    (out / "index.json").write_text(json.dumps(index))
    print(f"  {split}: {written} chips, {ships} ships, mean ship area {np.mean([t['oilFraction'] for t in tiles]) * 100:.2f}% of a chip")
    return index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-prepare-ships", description=__doc__)
    parser.add_argument("--root", required=True, help="the voc_style directory of the segmentation set")
    parser.add_argument("--out", required=True)
    parser.add_argument("--splits", nargs="*", default=["train", "test"])
    args = parser.parse_args(argv)

    for split in args.splits:
        build(Path(args.root), split, Path(args.out) / split)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
