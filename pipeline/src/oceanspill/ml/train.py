"""Train the oil spill U-Net.

Designed for the public Sentinel-1 oil spill dataset (Zenodo record 8346860: 2048x2048 VV+VH sigma0
in dB with binary masks) and for later fine-tuning on hand-labelled EOS-04 chips laid out the same way.

    uv sync --extra ml --extra sar
    uv run oceanspill-train --images /data/01_Train_Val_Oil_Spill_images \\
        --masks /data/01_Train_Val_Oil_Spill_mask --out runs/s1-unet --epochs 40

On Kaggle or AIRAWAT, run the same command inside the notebook or job script.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import numpy as np

from .data import binary_mask, confusion, metrics, normalise_db, pair_files, random_crop, stitch, tile_starts, to_chw


def _require_ml():
    try:
        import tifffile
        import torch
    except ImportError as exc:  # pragma: no cover - depends on optional extras
        raise SystemExit("training needs the 'ml' and 'sar' extras: uv sync --extra ml --extra sar") from exc
    return torch, tifffile


def split_pairs(pairs: list, val_fraction: float, seed: int) -> tuple[list, list]:
    shuffled = pairs[:]
    random.Random(seed).shuffle(shuffled)
    n_val = max(1, int(round(len(shuffled) * val_fraction)))
    return shuffled[n_val:], shuffled[:n_val]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oceanspill-train", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--masks", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--crop", type=int, default=512)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--crops-per-image", type=int, default=4)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--base", type=int, default=32, help="U-Net base width")
    parser.add_argument("--channels", type=int, default=2, help="2 for VV+VH (or HH+HV), 1 for single polarisation")
    parser.add_argument("--val-fraction", type=float, default=0.1)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=13)
    parser.add_argument("--init", type=Path, help="checkpoint to fine-tune from (e.g. Sentinel-1 weights for EOS-04)")
    parser.add_argument("--onnx", action="store_true", help="also export the best model to ONNX")
    parser.add_argument("--limit", type=int, help="use only the first N pairs (smoke tests)")
    args = parser.parse_args(argv)

    torch, tifffile = _require_ml()
    from torch.utils.data import DataLoader, Dataset

    from .unet import DiceFocalLoss, UNet

    pairs = pair_files(args.images, args.masks)
    if args.limit:
        pairs = pairs[: args.limit]
    if len(pairs) < 2:
        raise SystemExit(f"found {len(pairs)} image/mask pairs; need at least 2")
    train_pairs, val_pairs = split_pairs(pairs, args.val_fraction, args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "split.json").write_text(json.dumps({"train": [str(p[0]) for p in train_pairs], "val": [str(p[0]) for p in val_pairs]}, indent=1))

    def load(pair):
        img = normalise_db(to_chw(tifffile.imread(pair[0]), args.channels))
        return img, binary_mask(tifffile.imread(pair[1]))

    class Crops(Dataset):
        def __init__(self, items):
            self.items = items

        def __len__(self):
            return len(self.items) * args.crops_per_image

        def __getitem__(self, idx):
            rng = np.random.default_rng()
            img, mask = load(self.items[idx % len(self.items)])
            x, y = random_crop(img, mask, args.crop, rng)
            if rng.random() < 0.5:
                x, y = x[:, :, ::-1], y[:, ::-1]
            if rng.random() < 0.5:
                x, y = x[:, ::-1, :], y[::-1, :]
            return torch.from_numpy(np.ascontiguousarray(x)), torch.from_numpy(np.ascontiguousarray(y))[None]

    device = torch.device("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
    torch.manual_seed(args.seed)
    model = UNet(args.channels, args.base).to(device)
    if args.init:
        model.load_state_dict(torch.load(args.init, map_location=device)["model"])
    loss_fn = DiceFocalLoss()
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    loader = DataLoader(Crops(train_pairs), batch_size=args.batch, shuffle=True, num_workers=args.workers, drop_last=True)
    total_steps = max(1, args.epochs * len(loader))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: 0.5 * (1 + math.cos(math.pi * min(s, total_steps) / total_steps)))
    use_amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    @torch.no_grad()
    def evaluate() -> dict:
        model.eval()
        tp = fp = fn = tn = 0
        for pair in val_pairs:
            img, mask = load(pair)
            _, h, w = img.shape
            tiles = []
            for r in tile_starts(h, args.crop, args.crop // 4):
                for c in tile_starts(w, args.crop, args.crop // 4):
                    x = torch.from_numpy(img[None, :, r:r + args.crop, c:c + args.crop]).to(device)
                    tiles.append((r, c, torch.sigmoid(model(x))[0, 0].float().cpu().numpy()))
            prob = stitch((h, w), tiles, args.crop)
            a, b, c_, d = confusion(prob >= args.threshold, mask > 0)
            tp, fp, fn, tn = tp + a, fp + b, fn + c_, tn + d
        model.train()
        return metrics(tp, fp, fn, tn)

    history = []
    best = -1.0
    for epoch in range(1, args.epochs + 1):
        started = time.time()
        running = 0.0
        for x, y in loader:
            x, y = x.to(device, non_blocking=True), y.to(device, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, enabled=use_amp):
                loss = loss_fn(model(x), y)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            running += float(loss)
        val = evaluate()
        entry = {"epoch": epoch, "trainLoss": running / max(1, len(loader)), "val": val, "seconds": round(time.time() - started, 1)}
        history.append(entry)
        print(json.dumps(entry))
        (args.out / "history.json").write_text(json.dumps(history, indent=1))
        if (val["iou"] or 0) > best:
            best = val["iou"] or 0
            saved_args = {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()}
            torch.save({"model": model.state_dict(), "args": saved_args, "val": val, "epoch": epoch}, args.out / "unet_best.pt")

    if args.onnx and (args.out / "unet_best.pt").exists():
        model.load_state_dict(torch.load(args.out / "unet_best.pt", map_location=device)["model"])
        model.eval()
        torch.onnx.export(model.cpu(), torch.zeros(1, args.channels, args.crop, args.crop), str(args.out / "unet_best.onnx"),
                          input_names=["sigma0_db_norm"], output_names=["oil_logit"],
                          dynamic_axes={"sigma0_db_norm": {0: "n", 2: "h", 3: "w"}, "oil_logit": {0: "n", 2: "h", 3: "w"}})
    print(f"best validation IoU {best:.4f}; outputs in {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
