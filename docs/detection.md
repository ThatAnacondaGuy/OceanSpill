# Slick detection: the classical detector, and plugging in a trained model

## What runs today

Every SAR scene in this project is processed by an adaptive-threshold dark-spot detector: a sea
pixel counts as dark when it sits below its local sea background by more than both 1.5 local
standard deviations and 3 dB. It is the classical first stage of SAR oil spill detection. It finds
oil and look-alikes alike — low wind, biogenic films, ship wakes — and the look-alike checks and the
analyst decide between them.

It is not a trained model, and every processed record says so in its `method` field. Nothing in the
interface claims otherwise.

## Adding a trained model

`oceanspill-train` trains a U-Net for binary oil segmentation and can export it to ONNX:

```bash
cd pipeline && uv run oceanspill-train --images <images> --masks <masks> --out runs/unet --onnx
```

That writes `unet_best.onnx` and a `unet_best.json` beside it recording the channel count, the
decision threshold, what it was trained on and its validation scores. The pipeline reads that file,
so a model can be moved between machines without anyone having to remember how it was trained.

Point the pipeline at it, either per run:

```bash
cd pipeline && uv run oceanspill process --case IND-2025-05-MSC-ELSA3 --model runs/unet/unet_best.onnx
```

or for everything, including the background worker, by adding to `pipeline/.env`:

```
SAR_MODEL=runs/unet/unet_best.onnx
```

The model replaces one step and nothing else: which pixels are oil. Speckle filtering, the land
mask and the coastal buffer still run before it, and the outline, area, contrast, elongation and
look-alike checks are measured exactly as before — so results from the two detectors are directly
comparable on the same scene, and the record still states which one produced them.

Inference is CPU-only through onnxruntime, over 512-pixel tiles with 64 pixels of overlap so a slick
crossing a tile edge is not cut in half. If the model file is missing or onnxruntime is not
installed, the run says so and falls back to the classical detector rather than failing.

## What is still missing

A model needs labelled SAR imagery to train on, and the honest position is that this project has not
trained one yet. Until it has, the classical detector is what the numbers on screen come from.
