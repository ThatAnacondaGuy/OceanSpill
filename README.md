# OceanSpill

Maritime oil spill detection and vessel attribution for Indian waters. Built for Smart India
Hackathon problem statement 26143 (NTRO).

Seven real incidents in Indian waters are reconstructed end to end: satellite radar over the
incident, the metocean conditions at the time, where the oil drifted, which vessels were in the
water, and what the authorities concluded. Nothing is invented — where a figure is not published,
the interface says so rather than filling the gap.

## What it does

- **Finds oil in radar imagery.** An adaptive-threshold dark-spot detector runs on every scene today
  and is what the published measurements come from. A U-Net is being trained alongside it on 1,200
  Sentinel-1 scenes with hand-drawn masks plus 685 look-alike and 685 clean-sea scenes; until it
  earns its place the pages say it is not trained, and every processed record names whichever
  detector produced it. Figures live in `shared/model-status.json`, written by the training runs.
- **Finds ships in radar**, including ones transmitting nothing on AIS — trained, and measured on
  chips of open sea to see how often it fires at nothing.
- **Runs the oil backwards and forwards.** A particle model driven by ERA5 winds and Météo-France
  currents, with land taken from OpenStreetMap so oil does not drift through a headland. Running it
  backwards recovers where the discharge started and when.
- **Ranks the vessels that could be responsible.** A weighted score over how close each ship passed,
  when, whether its course lines up with the slick, and whether it went dark — with the reasons and
  the exclusions shown, because the exclusion list matters as much as the ranking when the result
  has to be defended.
- **Says what happens next.** Which protected areas are in the forecast envelope, what the shore is
  made of where oil would land, what the response and liability position is.

## Honesty rules this project follows

The hard part of a tool like this is not the model, it is not overclaiming. So:

- Every value on screen is labelled with where it came from — real, observed, modelled, synthetic,
  pending, or entered in this session.
- Accuracy figures come from `shared/model-status.json`, written by the training runs. A model that
  has not been trained says so; a trained one cannot be quoted more favourably than it scored.
- Attribution ranks vessels for inspection. It is not evidence of discharge, and the interface says
  that everywhere it shows a ranking.
- Where the official record has a gap — an unpublished quantity, an authority that never named a
  source — the gap is shown as a gap.

## Getting started

```bash
npm install && npm run dev
```

That runs the interface against the case files already in `public/data`. To rebuild those from the
providers, or to run the server, see below.

### Rebuilding the case data

```bash
cd pipeline && uv sync --extra sar --extra cmems && uv run oceanspill build
```

Provider credentials go in `pipeline/.env` (Copernicus, Bhoonidhi, Global Fishing Watch, Copernicus
Marine). Without them the build still runs on whatever is cached.

### Running against the server

```bash
cd pipeline && uv sync --extra api && uv run oceanspill-api migrate && uv run oceanspill-api serve
```

With `VITE_API_URL` set, the interface signs people in against real accounts and every change goes
to PostgreSQL with an append-only audit trail. See [docs/server.md](docs/server.md).

### Training the models

See [docs/models.md](docs/models.md) for what is trained, what is measured, and the figures each run
produced. [docs/detection.md](docs/detection.md) covers plugging a trained model into the pipeline.

## Layout

| Path | What is in it |
| --- | --- |
| `src/` | The interface: pages, the drift and attribution engines, the map |
| `pipeline/` | Python: providers, SAR processing, the API server, model training |
| `shared/` | Rules and figures both sides read — permissions, workflow, model status |
| `public/data/` | Case artifacts the pipeline produced |
| `docs/` | Server, detection and model documentation |
| `deploy/` | Docker, compose, nginx, backups |

## Tests

```bash
npm test
```

```bash
cd pipeline && uv run pytest -q
```

The web tests include a check that replays every case with an officially named source through the
attribution scoring and reports where the ranking put it, so a change that quietly makes the
ranking worse shows up as a failure.
