import { analysePolygon, type PolygonShape } from '../lib/geo';
import type { Detection, SourceType } from '../data/types';
import MODEL_FILE from '../../shared/model-status.json';

export interface ModelEntry {
  trained: boolean;
  task: string;
  architecture: string;
  training: string;
  dataset: string;
  datasetUrl: string;
  version?: string;
  trainedAt?: string;
  threshold?: number;
  tiles?: { train: number; val: number };
  scores?: { iou: number; dice: number; precision: number; recall: number };
  falseAlarmRate?: number | null;
  falseAlarmBasis?: string | null;
  modelFile?: string | null;
  note?: string;
}

export interface MeasuredFigures {
  drift?: {
    source: string;
    observations: number;
    buoys: number;
    windage: { fraction: number; ci95: number[]; deflectionDeg: number; samples: number; group: string } | null;
    diffusivity: { m2s: number; ci95: number[]; pairs: number; observedSeparationKm: Record<string, number> } | null;
  };
  driftValidation?: Record<string, unknown>;
  aisGaps?: {
    events: number; source: string; window: string;
    hoursPercentiles: Record<string, number>;
    distanceFromShorePercentiles: Record<string, number>;
    calibration: Record<string, number>;
    caveat: string;
  };
}

const SAR = MODEL_FILE.models.sarSegmentation as ModelEntry;


/**
 * Oil-vs-look-alike discrimination.
 *
 * Detecting a dark patch in SAR is the easy half. Low-wind cells, biogenic films, rain cells,
 * current shear and upwelling all damp capillary waves the way oil does. The checks below are
 * the discriminating half. Checks that need SAR measurements (backscatter contrast, edge
 * definition, model class margin) stay "pending" until a scene has been downloaded and
 * segmented — they are never filled with invented values.
 */

export type CheckStatus = 'passed' | 'failed' | 'pending';

export interface LookalikeCheck {
  name: string;
  status: CheckStatus;
  weight: number;
  detail: string;
}

export interface DetectionAssessment {
  confidence: number;
  confidenceBasis: 'official-report' | 'sar-model' | 'unconfirmed-report';
  rawModelConfidence: number | null;
  verdict: 'Officially confirmed' | 'Confirmed oil' | 'Probable oil' | 'Ambiguous' | 'Probable look-alike';
  checks: LookalikeCheck[];
  lookalikeHypothesis: string | null;
  shape: PolygonShape;
  contrastDb: number | null;
  sourceInference: string;
  windSpeedMs: number | null;
  detectabilityNote: string;
  sarPending: boolean;
}

export function assessDetection(det: Detection, officiallyConfirmed: boolean, sourceType: SourceType): DetectionAssessment {
  const shape = analysePolygon(det.polygon.ring);
  const sarProcessed = det.status === 'sar-processed' && det.classProbabilities != null;
  const contrastDb =
    det.meanBackscatterDb != null && det.backgroundBackscatterDb != null ? det.meanBackscatterDb - det.backgroundBackscatterDb : null;
  const wind = det.windSpeedMs;
  const sceneNote = det.sarMeasurements.length
    ? `No dark spot within 10 km of the incident in ${det.sarMeasurements.length} processed scene${det.sarMeasurements.length === 1 ? '' : 's'}, so there is no slick contrast to measure`
    : det.scenes.length
    ? `${det.scenes.length} catalogue scene${det.scenes.length === 1 ? '' : 's'} identified; download and processing pending`
    : 'No SAR scene found in the search window';
  const measured = det.sarSpot ? ` (measured on ${det.sarSpot.scene})` : '';
  const checks: LookalikeCheck[] = [];

  if (wind == null) {
    checks.push({ name: 'Wind cross-check', status: 'pending', weight: 0.3, detail: 'No wind data for the reference time' });
  } else if (wind < 2.2) {
    checks.push({ name: 'Wind cross-check', status: 'failed', weight: 0.3, detail: `Wind ${wind.toFixed(1)} m/s is below the ~3 m/s damping floor; low-wind cells look like oil at this sea state` });
  } else if (wind < 3.2) {
    checks.push({ name: 'Wind cross-check', status: 'failed', weight: 0.16, detail: `Wind ${wind.toFixed(1)} m/s is at the lower detectability limit; low-wind look-alikes cannot be excluded` });
  } else if (wind > 13.5) {
    checks.push({ name: 'Wind cross-check', status: 'failed', weight: 0.12, detail: `Wind ${wind.toFixed(1)} m/s exceeds the upper limit; wave breaking normally erases slick contrast` });
  } else {
    checks.push({ name: 'Wind cross-check', status: 'passed', weight: 0.3, detail: `Wind ${wind.toFixed(1)} m/s is inside the 3–12 m/s window where oil damping is visible in SAR` });
  }

  if (contrastDb == null) {
    checks.push({ name: 'Backscatter contrast', status: 'pending', weight: 0.22, detail: det.sarMeasurements.length ? `${sceneNote}.` : `Needs calibrated backscatter from a processed scene. ${sceneNote}.` });
  } else if (contrastDb <= -9) {
    checks.push({ name: 'Backscatter contrast', status: 'passed', weight: 0.22, detail: `${contrastDb.toFixed(1)} dB damping, deeper than biogenic films typically produce${measured}` });
  } else if (contrastDb <= -6) {
    checks.push({ name: 'Backscatter contrast', status: 'passed', weight: 0.12, detail: `${contrastDb.toFixed(1)} dB damping, consistent with a thin mineral-oil film${measured}` });
  } else {
    checks.push({ name: 'Backscatter contrast', status: 'failed', weight: 0.18, detail: `${contrastDb.toFixed(1)} dB damping is shallow, within the range of algal surfactant films${measured}` });
  }

  if (!sarProcessed) {
    checks.push({ name: 'Edge definition', status: 'pending', weight: 0.14, detail: 'Needs a segmented SAR boundary; reported geometry has no measured edge' });
  } else {
    const sharp = shape.compactness < 0.34;
    const diffuse = shape.compactness > 0.62;
    checks.push({
      name: 'Edge definition',
      status: diffuse ? 'failed' : 'passed',
      weight: 0.14,
      detail: sharp ? `Sharp boundary (compactness ${shape.compactness.toFixed(2)})` : diffuse ? `Diffuse feathered boundary (compactness ${shape.compactness.toFixed(2)})` : `Moderately defined boundary (compactness ${shape.compactness.toFixed(2)})`,
    });
  }

  if (!sarProcessed && !det.extentReported && det.sarSpot) {
    const e = det.sarSpot.elongation;
    checks.push({
      name: 'Geometric plausibility', status: e >= 2.4 ? 'passed' : 'failed', weight: e >= 4.5 ? 0.2 : 0.1,
      detail: `Detected dark spot: ${det.sarSpot.areaKm2.toFixed(1)} km², elongation ${e.toFixed(1)}:1, axis ${det.sarSpot.orientationDeg.toFixed(0)}°${measured}`,
    });
  } else if (!sarProcessed && !det.extentReported) {
    checks.push({ name: 'Geometric plausibility', status: 'pending', weight: 0.2, detail: 'Extent not reported; needs a processed SAR scene' });
  } else {
    const basis = sarProcessed ? '' : ' (from reported extent)';
    if (shape.elongation >= 4.5) {
      checks.push({ name: 'Geometric plausibility', status: 'passed', weight: 0.2, detail: `Elongation ${shape.elongation.toFixed(1)}:1 over ${shape.majorAxisKm.toFixed(1)} km${basis}` });
    } else if (shape.elongation >= 2.4) {
      checks.push({ name: 'Geometric plausibility', status: 'passed', weight: 0.1, detail: `Elongation ${shape.elongation.toFixed(1)}:1${basis}` });
    } else {
      checks.push({ name: 'Geometric plausibility', status: 'failed', weight: 0.1, detail: `Compact form, elongation ${shape.elongation.toFixed(1)}:1${basis}` });
    }
  }

  if (!det.classProbabilities) {
    checks.push({ name: 'Segmentation class margin', status: 'pending', weight: 0.16, detail: 'No segmentation model output yet' });
  } else {
    const margin = det.classProbabilities.oil - det.classProbabilities.lookalike;
    checks.push({
      name: 'Segmentation class margin',
      status: margin > 0.25 ? 'passed' : 'failed',
      weight: 0.16,
      detail: `Model separates oil from look-alike by ${(margin * 100).toFixed(0)} points (${det.modelVersion ?? 'model'})`,
    });
  }

  let confidence: number;
  let confidenceBasis: DetectionAssessment['confidenceBasis'];
  let verdict: DetectionAssessment['verdict'];
  let raw: number | null = null;

  if (sarProcessed && det.classProbabilities) {
    raw = det.classProbabilities.oil;
    const scored = checks.filter((c) => c.status !== 'pending');
    const supporting = scored.filter((c) => c.status === 'passed').reduce((s, c) => s + c.weight, 0);
    const contradicting = scored.filter((c) => c.status === 'failed').reduce((s, c) => s + c.weight, 0);
    confidence = Math.max(0.03, Math.min(0.985, raw + (supporting - contradicting) * 0.42));
    confidenceBasis = 'sar-model';
    verdict = confidence >= 0.85 ? 'Confirmed oil' : confidence >= 0.62 ? 'Probable oil' : confidence >= 0.4 ? 'Ambiguous' : 'Probable look-alike';
  } else if (officiallyConfirmed) {
    confidence = 1;
    confidenceBasis = 'official-report';
    verdict = 'Officially confirmed';
  } else {
    confidence = 0.5;
    confidenceBasis = 'unconfirmed-report';
    verdict = 'Ambiguous';
  }

  let lookalikeHypothesis: string | null = null;
  if (confidenceBasis === 'sar-model' && confidence < 0.62) {
    if (wind != null && wind < 3.2) lookalikeHypothesis = 'Low-wind cell / wind shadow';
    else if (contrastDb != null && contrastDb > -6 && shape.compactness > 0.5) lookalikeHypothesis = 'Biogenic surfactant film (algal bloom)';
    else lookalikeHypothesis = 'Rain cell, current shear or upwelling front';
  }

  const sourceInference =
    sourceType === 'vessel' ? 'Reported source: vessel'
    : sourceType === 'facility' ? 'Reported source: land-based facility'
    : sourceType === 'pipeline' ? 'Reported source: undersea pipeline'
    : sarProcessed && shape.elongation >= 4 ? 'Moving vessel (linear discharge)'
    : 'Unknown source';

  const detectabilityNote =
    wind == null ? 'Wind unavailable; SAR detectability cannot be assessed'
    : wind < 3.2 ? 'Wind below the detectability window at the reference time: SAR scenes from this period may not show the slick clearly'
    : wind > 13.5 ? 'High sea state: slick boundary likely under-segmented in SAR'
    : 'Wind inside the nominal SAR detectability envelope at the reference time';

  return {
    confidence,
    confidenceBasis,
    rawModelConfidence: raw,
    verdict,
    checks,
    lookalikeHypothesis,
    shape,
    contrastDb,
    sourceInference,
    windSpeedMs: wind,
    detectabilityNote,
    sarPending: !sarProcessed,
  };
}

/** Status of the segmentation model. No model has been trained yet, so no accuracy figures are shown. */
/**
 * What the models score, written by the training runs into shared/model-status.json. Nothing here is
 * typed in by hand: if a model has not been trained, the pages say so rather than showing a figure.
 */
export const MODEL_STATUS = {
  trained: SAR.trained,
  version: (SAR as { version?: string }).version ?? null,
  architecture: SAR.architecture,
  training: SAR.training,
  loss: 'Dice + focal loss, because oil is a tiny fraction of the pixels in any scene',
  scores: (SAR as { scores?: { iou: number; dice: number; precision: number; recall: number } }).scores ?? null,
  falseAlarmRate: (SAR as { falseAlarmRate?: number | null }).falseAlarmRate ?? null,
  falseAlarmBasis: (SAR as { falseAlarmBasis?: string | null }).falseAlarmBasis ?? null,
  threshold: (SAR as { threshold?: number }).threshold ?? null,
  tiles: (SAR as { tiles?: { train: number; val: number } }).tiles ?? null,
  evaluation: [
    'Intersection over union and Dice against hand-drawn masks, on scenes the model never saw',
    'How often it fires on water with no oil in it',
    'Scored on scenes, not tiles, so one scene cannot appear on both sides of the split',
  ],
  datasetUrl: SAR.datasetUrl,
  note: SAR.trained
    ? `Trained on ${SAR.dataset}. Detection confidence on a case still comes from official confirmation; the model measures the slick, it does not decide whether a spill happened.`
    : 'No segmentation model has been trained yet. Detection confidence comes from official confirmation; processed scenes add classical dark-spot measurements, not model scores.',
  /** Every model, including the optical and ship detectors. */
  models: MODEL_FILE.models as Record<string, ModelEntry>,
  /** Figures measured from observations rather than trained: drift and AIS gaps. */
  measured: MODEL_FILE.measured as MeasuredFigures,
  generatedAt: MODEL_FILE.generatedAt,
};

/** Reads as a percentage when the model has been trained, and says so plainly when it has not. */
export function modelScoreLine(entry: { trained: boolean; scores?: { iou: number; precision: number; recall: number } | null; falseAlarmRate?: number | null }): string {
  if (!entry.trained || !entry.scores) return 'Not trained — no accuracy figures';
  const { iou, precision, recall } = entry.scores;
  const alarms = entry.falseAlarmRate == null ? '' : ` · fires on ${(entry.falseAlarmRate * 100).toFixed(1)}% of water with nothing in it`;
  return `IoU ${iou.toFixed(3)} · finds ${(recall * 100).toFixed(0)}% of the oil · ${(precision * 100).toFixed(0)}% of what it marks is oil${alarms}`;
}
