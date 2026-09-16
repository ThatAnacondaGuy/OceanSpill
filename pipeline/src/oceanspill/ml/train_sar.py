"""Train the oil segmentation model on the prepared SAR tiles.

Two things make this different from a textbook segmentation run:

* **Scenes, not tiles, are split.** Tiles from one scene share speckle, wind and a coastline, so
  mixing them across the split would flatter the model. Every tile from a scene stays on one side.
* **Look-alikes are scored separately.** A model that never fires is already 99% accurate on this
  data, so the numbers reported are the ones that matter: how much of the oil is found (recall), how
  much of what it calls oil really is (precision), and how often it fires on a dark patch that is
  not oil.

The result is exported to ONNX with the figures beside it, which is what the pipeline loads.
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .unet import DiceFocalLoss, UNet


def device_for(name: str):
    import torch

    if name != "auto":
        return torch.device(name)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


@dataclass
class Split:
    train: list[int] = field(default_factory=list)
    val: list[int] = field(default_factory=list)


def split_by_scene(index: dict, val_fraction: float, seed: int) -> Split:
    rng = np.random.default_rng(seed)
    scenes = sorted({t["scene"] for t in index["tiles"]})
    rng.shuffle(scenes)
    cut = max(1, int(len(scenes) * val_fraction))
    val_scenes = set(scenes[:cut])
    split = Split()
    for i, tile in enumerate(index["tiles"]):
        (split.val if tile["scene"] in val_scenes else split.train).append(i)
    return split


class Tiles:
    """Reads tiles from the memory-mapped cache, cropping and flipping on the way out."""

    def __init__(self, root: Path, rows: list[int], crop: int, augment: bool, seed: int = 0,
                 standardise: bool = False, channels: list[int] | None = None):
        # Only the path is kept. A memory-mapped array is an ndarray, so holding one here would make
        # the loader pickle the whole cache — gigabytes — into every worker process on start-up.
        # Each worker opens its own map the first time it reads a tile instead.
        self.root = root
        self._images: np.ndarray | None = None
        self._masks: np.ndarray | None = None
        self.rows = rows
        self.crop = crop
        self.augment = augment
        # Optical reflectance over water occupies a sliver of the byte range, so each tile is put on
        # its own scale; radar in decibels already spans it and is left alone.
        self.standardise = standardise
        # EOS-04 flies single polarisation, so a model meant for those scenes is trained on that one
        # channel rather than being handed the same data twice at inference.
        self.channels = channels
        self.rng = np.random.default_rng(seed)

    def __len__(self) -> int:
        return len(self.rows)

    @property
    def images(self) -> np.ndarray:
        if self._images is None:
            self._images = np.load(self.root / "images.npy", mmap_mode="r")
        return self._images

    @property
    def masks(self) -> np.ndarray:
        if self._masks is None:
            self._masks = np.load(self.root / "masks.npy", mmap_mode="r")
        return self._masks

    def __getitem__(self, i: int):
        import torch

        row = self.rows[i]
        image = np.asarray(self.images[row])
        if self.channels is not None:
            image = image[..., self.channels]
        mask = np.asarray(self.masks[row])
        size = image.shape[0]
        if self.crop < size:
            if self.augment:
                # Prefer a crop that contains oil, so batches are not dominated by empty water.
                oil = np.argwhere(mask > 0)
                if len(oil) and self.rng.random() < 0.7:
                    r, c = oil[self.rng.integers(len(oil))]
                    top = int(np.clip(r - self.crop // 2, 0, size - self.crop))
                    left = int(np.clip(c - self.crop // 2, 0, size - self.crop))
                else:
                    top = int(self.rng.integers(0, size - self.crop + 1))
                    left = int(self.rng.integers(0, size - self.crop + 1))
            else:
                top = left = (size - self.crop) // 2
            image = image[top : top + self.crop, left : left + self.crop]
            mask = mask[top : top + self.crop, left : left + self.crop]

        if self.augment:
            if self.rng.random() < 0.5:
                image, mask = image[:, ::-1], mask[:, ::-1]
            if self.rng.random() < 0.5:
                image, mask = image[::-1], mask[::-1]
            turns = int(self.rng.integers(4))
            if turns:
                image, mask = np.rot90(image, turns), np.rot90(mask, turns)

        x = torch.from_numpy(np.ascontiguousarray(image.transpose(2, 0, 1))).float() / 255.0
        if self.standardise:
            mean = x.mean(dim=(1, 2), keepdim=True)
            spread = x.std(dim=(1, 2), keepdim=True).clamp_min(1e-4)
            x = (x - mean) / spread
        y = torch.from_numpy(np.ascontiguousarray(mask)).float().unsqueeze(0)
        return x, y


@dataclass
class Scores:
    threshold: float
    iou: float
    dice: float
    precision: float
    recall: float
    pixels: int
    oil_pixels: int


def evaluate(model, loader, device, thresholds: list[float]) -> list[Scores]:
    import torch

    counts = {t: np.zeros(3, dtype=np.int64) for t in thresholds}  # intersection, predicted, actual
    pixels = oil_pixels = 0
    model.eval()
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            probability = torch.sigmoid(model(x))
            truth = y > 0.5
            pixels += int(truth.numel())
            oil_pixels += int(truth.sum())
            for t in thresholds:
                predicted = probability > t
                counts[t] += np.array([
                    int((predicted & truth).sum()), int(predicted.sum()), int(truth.sum())
                ], dtype=np.int64)

    scores = []
    for t in thresholds:
        inter, pred, actual = counts[t]
        union = pred + actual - inter
        scores.append(Scores(
            threshold=t,
            iou=float(inter / union) if union else 0.0,
            dice=float(2 * inter / (pred + actual)) if pred + actual else 0.0,
            precision=float(inter / pred) if pred else 0.0,
            recall=float(inter / actual) if actual else 0.0,
            pixels=pixels, oil_pixels=oil_pixels,
        ))
    return scores


def false_alarm_rate(model, loader, device, threshold: float, min_pixels: int) -> dict:
    """How often the model calls oil on a tile that holds none — the look-alike problem."""
    import torch

    fired = tiles = 0
    area = []
    model.eval()
    with torch.no_grad():
        for x, y in loader:
            x = x.to(device)
            predicted = torch.sigmoid(model(x)) > threshold
            counts = predicted.flatten(1).sum(1).cpu().numpy()
            tiles += len(counts)
            fired += int((counts >= min_pixels).sum())
            area.extend(counts[counts >= min_pixels].tolist())
    return {
        "tiles": tiles, "tilesWithDetection": fired,
        "falseAlarmRate": float(fired / tiles) if tiles else 0.0,
        "medianFalseAreaPixels": float(np.median(area)) if area else 0.0,
        "minPixels": min_pixels,
    }


def main(argv: list[str] | None = None) -> int:
    import torch
    from torch.utils.data import DataLoader

    parser = argparse.ArgumentParser(prog="oceanspill-train-sar", description=__doc__)
    parser.add_argument("--cache", required=True, help="directory written by a prepare step")
    parser.add_argument("--val-cache", help="a separate validation cache, for data that ships its own split")
    parser.add_argument("--out", required=True)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--crop", type=int, default=256)
    parser.add_argument("--base", type=int, default=32, help="width of the first U-Net stage")
    parser.add_argument("--depth", type=int, default=4)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--val-fraction", type=float, default=0.2)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=20260916)
    parser.add_argument("--limit", type=int, help="use only this many training tiles, for a quick check")
    parser.add_argument("--oversample", type=float, default=4.0, help="how much more often tiles containing the target are drawn")
    parser.add_argument("--standardise", action="store_true", help="put each tile on its own scale (for optical reflectance)")
    parser.add_argument("--use-channels", help="comma-separated channel indices to train on, e.g. 0 for co-polarised only")
    args = parser.parse_args(argv)

    cache = Path(args.cache)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    index = json.loads((cache / "index.json").read_text())
    torch.manual_seed(args.seed)

    val_cache = Path(args.val_cache) if args.val_cache else cache
    if args.val_cache:
        # The dataset already says which tiles are held out, so use its split rather than inventing one.
        val_index = json.loads((val_cache / "index.json").read_text())
        split = Split(train=list(range(index["count"])), val=list(range(val_index["count"])))
        val_fractions = [t["oilFraction"] for t in val_index["tiles"]]
    else:
        val_index = index
        split = split_by_scene(index, args.val_fraction, args.seed)
        val_fractions = [t["oilFraction"] for t in index["tiles"]]
    if args.limit:
        split.train = split.train[: args.limit]
    # Tiles with none of the target in them at all. Keying this on a label name was wrong: the ship
    # data labels its tiles "ship", so every chip counted as clean and the false-alarm figure was
    # really the detection rate.
    clean_val = [i for i in split.val if val_fractions[i] == 0]

    print(f"{len(split.train)} training tiles, {len(split.val)} validation tiles "
          f"({sum(val_fractions[i] > 0 for i in split.val)} of them contain oil)")

    # Which channels to train on, decided before any loader is built because they all read it.
    selected = [int(c) for c in args.use_channels.split(",")] if args.use_channels else None
    device = device_for(args.device)
    print(f"device: {device}" + (f" · channels {selected}" if selected else ""))

    # Tiles holding the thing being looked for are rare, so they are drawn more often; without this
    # the model is rewarded for predicting nothing.
    train_fractions = [t["oilFraction"] for t in index["tiles"]]
    sample_weights = [args.oversample if train_fractions[i] > 0 else 1.0 for i in split.train]
    sampler = torch.utils.data.WeightedRandomSampler(sample_weights, num_samples=len(split.train), replacement=True)
    train_loader = DataLoader(Tiles(cache, split.train, args.crop, augment=True, seed=args.seed, standardise=args.standardise, channels=selected),
                              batch_size=args.batch, sampler=sampler, num_workers=args.workers, drop_last=True)
    val_loader = DataLoader(Tiles(val_cache, split.val, args.crop, augment=False, standardise=args.standardise, channels=selected),
                            batch_size=args.batch, num_workers=args.workers)
    clean_loader = DataLoader(Tiles(val_cache, clean_val, args.crop, augment=False, standardise=args.standardise, channels=selected),
                              batch_size=args.batch, num_workers=args.workers)

    channels = len(selected) if selected else int(np.load(cache / "images.npy", mmap_mode="r").shape[-1])
    print(f"{channels} input channels: {', '.join(index.get('channels', []) or ['unnamed'])}")
    model = UNet(in_channels=channels, base=args.base, depth=args.depth).to(device)
    loss_fn = DiceFocalLoss()
    optimiser = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimiser, max_lr=args.lr, total_steps=args.epochs * max(1, len(train_loader)))

    history = []
    best = -1.0
    thresholds = [0.3, 0.4, 0.5, 0.6, 0.7]

    for epoch in range(1, args.epochs + 1):
        started = time.time()
        model.train()
        running = 0.0
        for step, (x, y) in enumerate(train_loader):
            x, y = x.to(device), y.to(device)
            optimiser.zero_grad(set_to_none=True)
            loss = loss_fn(model(x), y)
            loss.backward()
            optimiser.step()
            schedule.step()
            running += float(loss)
            if step % 50 == 0:
                print(f"  epoch {epoch} step {step}/{len(train_loader)} loss {float(loss):.4f}", flush=True)

        scores = evaluate(model, val_loader, device, thresholds)
        best_score = max(scores, key=lambda s: s.iou)
        entry = {
            "epoch": epoch, "trainLoss": running / max(1, len(train_loader)),
            "seconds": round(time.time() - started, 1),
            "val": [s.__dict__ for s in scores],
            "bestThreshold": best_score.threshold, "bestIou": best_score.iou,
        }
        history.append(entry)
        print(f"epoch {epoch}: loss {entry['trainLoss']:.4f} · IoU {best_score.iou:.4f} "
              f"(threshold {best_score.threshold}) · precision {best_score.precision:.3f} "
              f"· recall {best_score.recall:.3f} · {entry['seconds']}s", flush=True)
        (out / "history.json").write_text(json.dumps(history, indent=1))

        if best_score.iou > best:
            best = best_score.iou
            torch.save({"model": model.state_dict(), "args": vars(args), "val": entry}, out / "unet_best.pt")

    # Best epoch, scored again for the record, including how often it fires on oil-free water.
    state = torch.load(out / "unet_best.pt", map_location=device, weights_only=False)
    model.load_state_dict(state["model"])
    scores = evaluate(model, val_loader, device, thresholds)
    chosen = max(scores, key=lambda s: s.iou)
    alarms = false_alarm_rate(model, clean_loader, device, chosen.threshold, min_pixels=50) if clean_val else None
    if alarms:
        print(f"false alarms on tiles with nothing in them: {alarms['falseAlarmRate'] * 100:.1f}% "
              f"({alarms['tilesWithDetection']}/{alarms['tiles']} tiles)", flush=True)
    else:
        print("false alarms: not measurable — every validation tile contains the target", flush=True)

    model = model.cpu().eval()
    dummy = torch.zeros(1, channels, args.crop, args.crop)
    onnx_path = out / "unet_best.onnx"
    torch.onnx.export(model, dummy, str(onnx_path), input_names=["sigma0_db_norm"], output_names=["oil_logit"],
                      dynamic_axes={"sigma0_db_norm": {0: "n", 2: "h", 3: "w"}, "oil_logit": {0: "n", 2: "h", 3: "w"}})

    meta = {
        "channels": channels,
        "standardise": bool(args.standardise),
        "channelNames": [index.get("channels", [])[c] for c in selected] if selected and index.get("channels") else index.get("channels"),
        "useChannels": selected,
        "threshold": chosen.threshold,
        "trainedOn": index.get("source", str(cache)),
        "tiles": {"train": len(split.train), "val": len(split.val)},
        "val": chosen.__dict__,
        "allThresholds": [s.__dict__ for s in scores],
        "falseAlarms": alarms,
        "falseAlarmsNote": None if alarms else "Every validation tile contains the target, so there is nothing to measure false alarms on.",
        "channelRange": index.get("channelRange"),
        "note": "Pixel values are per-channel decibels scaled to [0, 1]; see channelRange.",
    }
    (out / "unet_best.json").write_text(json.dumps(meta, indent=1))
    print(f"best IoU {chosen.iou:.4f} · Dice {chosen.dice:.4f} · precision {chosen.precision:.3f} · recall {chosen.recall:.3f}")
    print(f"wrote {onnx_path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
