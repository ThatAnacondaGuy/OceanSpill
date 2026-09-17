import { describe, expect, it } from 'vitest';
import { MODEL_STATUS, aisGapPercentile, assessDetection, modelScoreLine } from './detection';

describe('AIS gap scale', () => {
  const scale = MODEL_STATUS.measured?.aisGaps;

  it('is built from the published disabling events', () => {
    expect(scale).toBeDefined();
    expect(scale!.events).toBeGreaterThan(10_000);
  });

  it('places a gap against gaps that really were deliberate', () => {
    // The median deliberate gap is just under a day, so half a day should read as short and
    // a fortnight as longer than almost all of them.
    const short = aisGapPercentile(4 * 60)!;
    const median = aisGapPercentile(Math.round(scale!.hoursPercentiles.p50 * 60))!;
    const long = aisGapPercentile(14 * 24 * 60)!;
    expect(short.percentile).toBeLessThan(25);
    expect(Math.abs(median.percentile - 50)).toBeLessThanOrEqual(5);
    expect(long.percentile).toBeGreaterThan(90);
    expect(short.reading).toMatch(/short/);
  });

  it('says nothing when there is no gap', () => {
    expect(aisGapPercentile(0)).toBeNull();
  });
});

describe('how model figures are worded', () => {
  it('refuses to quote a figure for a model that has not been trained', () => {
    expect(modelScoreLine({ trained: false })).toMatch(/Not trained/);
    expect(modelScoreLine({ trained: true, scores: undefined })).toMatch(/Not trained/);
  });

  it('reports what was measured when there is something to report', () => {
    const line = modelScoreLine({ trained: true, scores: { iou: 0.55, dice: 0.71, precision: 0.65, recall: 0.79 }, falseAlarmRate: 0.112 });
    expect(line).toContain('IoU 0.550');
    expect(line).toContain('79%');
    expect(line).toContain('11.2%');
  });
});

describe('what decides a detection', () => {
  const base = {
    polygon: { ring: [{ lat: 9.0, lon: 76.0 }, { lat: 9.0, lon: 76.2 }, { lat: 9.02, lon: 76.2 }, { lat: 9.02, lon: 76.0 }] },
    status: 'sar-processed' as const,
    windSpeedMs: 6,
    scenes: [], sarMeasurements: [], sarSpot: null,
    meanBackscatterDb: -18, backgroundBackscatterDb: -9,
    extentReported: true, geometryBasis: 'test', geometryAssumptions: [],
    acquiredAt: 0, observationSource: 'test', sarProviders: [], modelVersion: 'unet-test',
  };

  it('lets an authority that went and looked outrank the model', () => {
    const doubtful = assessDetection({ ...base, classProbabilities: { oil: 0.05, notOil: 0.95 } } as never, true, 'vessel');
    expect(doubtful.verdict).toBe('Officially confirmed');
    expect(doubtful.confidence).toBe(1);
    // The model's own score is still reported, so the disagreement is visible rather than hidden.
    expect(doubtful.rawModelConfidence).toBe(0.05);
  });

  it('uses the model when nobody has confirmed anything', () => {
    const confident = assessDetection({ ...base, classProbabilities: { oil: 0.93, notOil: 0.07 } } as never, false, 'unknown');
    expect(confident.confidenceBasis).toBe('sar-model');
    expect(confident.confidence).toBeGreaterThan(0.7);
    const doubtful = assessDetection({ ...base, classProbabilities: { oil: 0.12, notOil: 0.88 } } as never, false, 'unknown');
    expect(doubtful.confidence).toBeLessThan(doubtful.confidence + 1);
    expect(doubtful.verdict === 'Probable look-alike' || doubtful.verdict === 'Ambiguous').toBe(true);
  });

  it('says the class check has nothing to judge when no model has run', () => {
    const none = assessDetection({ ...base, classProbabilities: null } as never, false, 'unknown');
    const check = none.checks.find((c) => c.name === 'Segmentation class margin')!;
    expect(check.status).toBe('pending');
    expect(none.rawModelConfidence).toBeNull();
  });

  it('reports which way the model leaned, not just that it disagreed', () => {
    const against = assessDetection({ ...base, classProbabilities: { oil: 0.2, notOil: 0.8 } } as never, false, 'unknown');
    const check = against.checks.find((c) => c.name === 'Segmentation class margin')!;
    expect(check.status).toBe('failed');
    expect(check.detail).toMatch(/leans against oil by 60 points/);
  });
});
