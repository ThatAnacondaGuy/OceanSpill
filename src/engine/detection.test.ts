import { describe, expect, it } from 'vitest';
import { MODEL_STATUS, aisGapPercentile, modelScoreLine } from './detection';

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
