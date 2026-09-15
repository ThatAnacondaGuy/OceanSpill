import { describe, expect, it } from 'vitest';
import { DEFAULT_DRIFT_PARAMS, OIL_TYPES, estimateAge, hindcast, makeRng, runDrift, weather } from './drift';
import type { FieldSampler, SampledVector } from './forcing';
import { LandGrid } from './land';
import { haversineKm } from '../lib/geo';
import type { CoastArtifact } from '../data/types';

const START = { lat: 9.3, lon: 75.6 };
const T0 = Date.UTC(2025, 4, 25, 2, 20);

/** A vector with every field the engine reads, built from its east and north components. */
function vector(u: number, v: number): SampledVector {
  const dirTo = (Math.atan2(u, v) * 180) / Math.PI;
  return {
    u, v, speed: Math.hypot(u, v),
    dirTo: (dirTo + 360) % 360, dirFrom: (dirTo + 540) % 360,
    origin: 'observed',
  };
}

/** Fixed fields: 5 m/s wind towards the east, no current, so displacement is predictable. */
function steadySampler(over: Partial<FieldSampler> = {}): FieldSampler {
  return {
    label: 'test',
    sources: { wind: 'test', current: 'test' },
    wind: () => vector(5, 0),
    current: () => vector(0, 0),
    waveHeight: () => null,
    ...over,
  };
}

/** A square of land covering everything east of 75.7 E, drawn as a closed ring. */
function landToTheEast(): LandGrid {
  const coast: CoastArtifact = {
    source: 'test coastline',
    bbox: { west: 75.0, south: 9.0, east: 76.0, north: 9.6 },
    rings: [[
      [75.7, 8.9], [76.1, 8.9], [76.1, 9.7], [75.7, 9.7], [75.7, 8.9],
    ]],
  } as CoastArtifact;
  return new LandGrid(coast, 0.002);
}

describe('particle drift', () => {
  it('moves the slick downwind at roughly the windage fraction of the wind speed', () => {
    const hours = 6;
    const result = runDrift(START, T0, hours, { particles: 120 }, 42, 0.5, steadySampler());
    const travelled = haversineKm(START, result.path[result.path.length - 1]);
    // 3% of 5 m/s for six hours is about 3.2 km; allow for diffusion and the centre-of-mass estimate.
    const expected = DEFAULT_DRIFT_PARAMS.windage * 5 * hours * 3.6;
    expect(travelled).toBeGreaterThan(expected * 0.6);
    expect(travelled).toBeLessThan(expected * 1.6);
    expect(result.path[result.path.length - 1].lon).toBeGreaterThan(START.lon);
  });

  it('spreads further the longer it runs', () => {
    const short = runDrift(START, T0, 3, { particles: 120 }, 7, 0.5, steadySampler());
    const long = runDrift(START, T0, 12, { particles: 120 }, 7, 0.5, steadySampler());
    expect(long.finalSpreadKm).toBeGreaterThan(short.finalSpreadKm);
  });

  it('repeats exactly for the same seed and differs for another', () => {
    const a = runDrift(START, T0, 6, { particles: 60 }, 11, 0.5, steadySampler());
    const b = runDrift(START, T0, 6, { particles: 60 }, 11, 0.5, steadySampler());
    const c = runDrift(START, T0, 6, { particles: 60 }, 12, 0.5, steadySampler());
    expect(b.path).toEqual(a.path);
    expect(c.path).not.toEqual(a.path);
  });

  it('runs backwards for a hindcast, ending upwind of the observation', () => {
    const back = runDrift(START, T0, -6, { particles: 120 }, 42, 0.5, steadySampler());
    expect(back.origin.lon).toBeLessThan(START.lon);
    expect(back.originTime).toBeLessThan(T0);
  });

  it('keeps every particle off the land it is given', () => {
    const land = landToTheEast();
    const sampler = steadySampler({ land });
    const result = runDrift({ lat: 9.3, lon: 75.65 }, T0, 12, { particles: 200 }, 5, 0.5, sampler);
    const onLand = result.steps.flatMap((s) => s.particles).filter((p) => land.isLand(p));
    expect(onLand).toHaveLength(0);
  });

  it('gives a hindcast an uncertainty radius that grows with the look-back', () => {
    const near = hindcast(START, T0, 6, { particles: 60 }, 6, 3, steadySampler());
    const far = hindcast(START, T0, 24, { particles: 60 }, 6, 3, steadySampler());
    expect(far.uncertaintyRadiusKm).toBeGreaterThan(near.uncertaintyRadiusKm);
    expect(near.ensemble.length).toBe(6);
  });
});

describe('weathering', () => {
  it('evaporates light oil faster than heavy fuel oil', () => {
    const light = weather(OIL_TYPES.marineDiesel, 12, 6, 29);
    const heavy = weather(OIL_TYPES.bunkerC, 12, 6, 29);
    expect(light.evaporatedPct).toBeGreaterThan(heavy.evaporatedPct);
    expect(heavy.remainingPct).toBeGreaterThan(light.remainingPct);
  });

  it('thins the film and takes up water as the slick ages', () => {
    const fresh = weather(OIL_TYPES.bunkerC, 1, 6, 29);
    const old = weather(OIL_TYPES.bunkerC, 48, 6, 29);
    expect(old.thicknessUm).toBeLessThan(fresh.thicknessUm);
    expect(old.waterContentPct).toBeGreaterThan(fresh.waterContentPct);
    expect(old.waterContentPct).toBeLessThanOrEqual(OIL_TYPES.bunkerC.maxWaterPct);
  });

  it('reads back the age of a slick it produced itself', () => {
    const oil = OIL_TYPES.bunkerC;
    const [ageHours, volumeM3, wind, sst] = [18, 400, 6, 29];
    const state = weather(oil, ageHours, wind, sst);
    const areaKm2 = ((volumeM3 * (state.remainingPct / 100)) / (state.thicknessUm * 1e-6)) / 1e6;
    const estimate = estimateAge(oil, areaKm2, state.sarContrastDb, volumeM3, wind, sst);
    expect(Math.abs(estimate.ageHours - ageHours)).toBeLessThan(4);
    expect(estimate.confidence).toBeGreaterThan(0);
  });
});

describe('random numbers', () => {
  it('stays inside the unit interval and repeats for a seed', () => {
    const first = Array.from({ length: 50 }, makeRng(99));
    const again = Array.from({ length: 50 }, makeRng(99));
    expect(first).toEqual(again);
    expect(Math.min(...first)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...first)).toBeLessThan(1);
  });
});
