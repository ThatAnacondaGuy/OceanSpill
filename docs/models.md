# Models and measurements

What the system learns, what it measures, and what it still cannot do. Every figure here comes from
a run in `pipeline/runs/`; none of it is typed in by hand. The web app reads the same figures from
`shared/model-status.json`, so a model that has not been trained says so on screen.

## Trained models

| Model | What it does | Dataset |
| --- | --- | --- |
| `sarSegmentation` | Oil pixels in radar scenes (VV + VH, decibels) | Sentinel-1 oil spill scenes, 1,200 with masks, plus 685 look-alike and 685 clean-sea scenes |
| `opticalSegmentation` | Oil in Sentinel-2 optical scenes | MADOS, 15 hand-labelled marine classes |
| `shipDetection` | Vessels in radar, including ones transmitting nothing | SSDD, ship outlines from the annotations |

All three are U-Nets with a Dice + focal loss, trained on Apple GPU. The current figures are in
`shared/model-status.json`; run `oceanspill-model-status` after a training run to refresh them.

### How they are scored

- **Scenes are split, not tiles.** Tiles cut from one scene share speckle, wind and coastline, so
  putting some in training and some in validation would flatter the model. Every tile from a scene
  stays on one side of the split.
- **The numbers reported are the ones that matter.** A model that never fires is already 99%
  accurate on this data, so what gets published is how much of the oil it finds (recall), how much of
  what it marks really is oil (precision), and how often it fires on water with nothing in it.
- **Look-alikes are scored separately** from clean sea, because telling oil from a low-wind patch or
  an algae bloom is the part a plain dark-spot threshold gets wrong.

### Running a training

```bash
cd pipeline && uv run oceanspill-prepare-sar --root <scenes> --masks <masks> --out <cache>
```

```bash
cd pipeline && uv run oceanspill-train-sar --cache <cache> --out runs/sar_oil --epochs 10
```

The run writes `unet_best.onnx` and `unet_best.json` beside each other. Point the pipeline at the
model with `SAR_MODEL=runs/sar_oil/unet_best.onnx` in `pipeline/.env`; see [detection.md](detection.md).

## Measured, not trained

Two numbers the drift model depends on were textbook values. They are now measured from the NOAA
Global Drifter Program record for the Indian Ocean — 21.5 million hourly positions from 3,264 buoys.

### Spreading

Buoys released close together drift apart at a rate anyone can measure, and that is the spreading a
particle model has to reproduce.

| Time | Buoys actually spread | Old model (8 m²/s) | Measured (564 m²/s) |
| --- | --- | --- | --- |
| 6 h | 3.7 km | 0.7 km | 6.2 km |
| 12 h | 6.2 km | 1.0 km | 8.7 km |
| 24 h | 11.3 km | 1.5 km | 12.4 km |
| 48 h | 21.0 km | 2.1 km | 17.5 km |

The old value was wrong by about 85%: every uncertainty radius the app drew was roughly eight times
too small. The measured value tracks the buoys to within 34% on average and under-predicts beyond
two days, because currents stretch a patch as well as mixing it and no single diffusivity follows
that.

### Windage

A buoy's own velocity minus the modelled current is what the wind is doing to it.

| Group | Windage | Deflection | Samples |
| --- | --- | --- | --- |
| Undrogued (floats at the surface) | 1.26% (CI 1.06–1.45) | −21.9° | 3,741 |
| Undrogued, northern hemisphere | 0.81% (CI 0.31–2.94) | +15.3° | 61 |
| Undrogued, southern hemisphere | 1.27% (CI 1.06–1.47) | −22.1° | 3,680 |
| Drogued at 15 m (control) | 0.12% (CI 0.05–0.58) | — | 733 |

Two things say this is measuring physics and not noise: the drogued control comes out near zero, and
the deflection flips from right of the wind north of the equator to left of it south, which is what
Coriolis does. A buoy is not an oil film — it sits partly submerged and misses some of the
wave-driven push — so 1.26% is a floor, and the model keeps the literature 3% for oil.

### Does the drift model get the position right?

Twenty-five buoy tracks, run forward 24 hours from a known position:

| | Median error after 24 h |
| --- | --- |
| The model | 15.7 km |
| Current alone | 16.9 km |
| Assuming it did not move | 21.6 km |

So the model beats doing nothing by 27%. Its stated uncertainty is close to honest but still a
little tight: the truth lands inside the one-sigma radius 52% of the time where 68% is expected, and
inside two sigma 88% where 95% is expected.

### AIS gaps

A vessel disappearing from AIS is usually nothing. The fixed "dark for longer than N minutes" rule
flagged half the fleet where reception is poor. It is replaced by the empirical distribution of
55,368 published Global Fishing Watch disabling events — gaps judged intentional — so a gap can be
placed against real ones: median 23.5 hours, quartiles 15.6–67.8 hours, typically 413 km offshore.
Checked on a quarter of the events held back, the scale is calibrated to within 0.3 of a percentage
point per decile.

An earlier attempt trained a classifier against the ordinary gaps in this project's own case
windows. It scored a perfect AUC, which was the giveaway: the two sides came from different feeds,
so it separated the datasets rather than the behaviour. Without a comparable sample of ordinary gaps
from the same feed there is no base rate, and the scale says so.

## Attribution ranking

Still a weighted score, not a learned model, and deliberately so: there are four cases with an
officially named source, which is nowhere near enough to train on. Replaying those four through the
same scoring the interface uses:

| Case | Named source | Where the ranking put it |
| --- | --- | --- |
| Wan Hai 503 | WAN HAI 503 | 1st of 4 |
| MSC ELSA 3 | MSC ELSA 3 | 2nd of 5 |
| Ennore collision 2017 | DAWN KANCHIPURAM | 15th of 21 |
| SSL Kolkata 2018 | SSL KOLKATA | not among the 6 scored |

Two of three found sit in the top three. The two failures are honest and both come from the same
cause: hourly AIS positions are too coarse to place a vessel at an anchorage, and a wreck that has
stopped transmitting cannot be ranked at all. `npm test` re-runs this check.

## What is still not possible

- **Oil type and thickness from imagery.** It needs polarimetric radar or hyperspectral optical data
  with thickness measured on the water at the same time, and none of the available datasets carry
  that. Oil type on a case comes from the incident report, labelled as such.
- **A learned attribution model.** See above: four confirmed cases.
- **Accuracy on Indian waters specifically.** The training scenes are global. Nothing here has been
  fine-tuned on EOS-04 scenes from the Indian cases, because that needs hand-labelled masks for
  those scenes, which do not exist yet.
