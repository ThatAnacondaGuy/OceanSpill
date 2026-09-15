import type { LatLon } from '../lib/geo';
import type { ForcingArtifact } from '../data/types';
import { currentAt, vector, windAt, type VectorSample } from './ocean';

export type FieldOrigin = 'observed' | 'model';

export interface SampledVector extends VectorSample {
  origin: FieldOrigin;
}

/**
 * Source of wind and current for the drift engine. The observed sampler reads the reanalysis grid
 * produced by the pipeline; wherever that grid has no value (outside its box, over land, or before
 * the dataset starts) it falls back to the climatological model and marks the sample as such.
 */
export interface FieldSampler {
  label: string;
  sources: { wind: string; current: string };
  wind(p: LatLon, t: number): SampledVector;
  current(p: LatLon, t: number): SampledVector;
  waveHeight(p: LatLon, t: number): number | null;
}

export const MODEL_SAMPLER: FieldSampler = {
  label: 'Climatological model (synthetic North Indian Ocean fields)',
  sources: { wind: 'Modelled', current: 'Modelled' },
  wind: (p, t) => ({ ...windAt(p, new Date(t)), origin: 'model' }),
  current: (p, t) => ({ ...currentAt(p, new Date(t)), origin: 'model' }),
  waveHeight: () => null,
};

function axisIndex(axis: number[], value: number): { i0: number; i1: number; f: number } | null {
  const n = axis.length;
  if (n === 0) return null;
  if (n === 1) return Math.abs(value - axis[0]) < 1e-6 ? { i0: 0, i1: 0, f: 0 } : null;
  const step = axis[1] - axis[0];
  const pos = (value - axis[0]) / step;
  if (pos < -1e-6 || pos > n - 1 + 1e-6) return null;
  const i0 = Math.min(n - 2, Math.max(0, Math.floor(pos)));
  return { i0, i1: i0 + 1, f: Math.min(1, Math.max(0, pos - i0)) };
}

export function observedSampler(forcing: ForcingArtifact, fallback: FieldSampler = MODEL_SAMPLER): FieldSampler {
  const [, ny, nx] = forcing.shape;
  const at = (arr: (number | null)[], ti: number, yi: number, xi: number) => arr[ti * ny * nx + yi * nx + xi];

  /** Bilinear in space and linear in time, renormalising weights over non-null corners. */
  const interpolate = (arr: (number | null)[], p: LatLon, t: number): number | null => {
    const ty = axisIndex(forcing.times, t);
    const yy = axisIndex(forcing.lats, p.lat);
    const xx = axisIndex(forcing.lons, p.lon);
    if (!ty || !yy || !xx) return null;
    let sum = 0;
    let weight = 0;
    for (const [ti, wt] of [[ty.i0, 1 - ty.f], [ty.i1, ty.f]] as const) {
      for (const [yi, wy] of [[yy.i0, 1 - yy.f], [yy.i1, yy.f]] as const) {
        for (const [xi, wx] of [[xx.i0, 1 - xx.f], [xx.i1, xx.f]] as const) {
          const w = wt * wy * wx;
          if (w === 0) continue;
          const v = at(arr, ti, yi, xi);
          if (v == null) continue;
          sum += v * w;
          weight += w;
        }
      }
    }
    return weight > 1e-9 ? sum / weight : null;
  };

  const vectorOrFallback = (
    field: { u: (number | null)[]; v: (number | null)[] },
    p: LatLon,
    t: number,
    fb: (p: LatLon, t: number) => SampledVector
  ): SampledVector => {
    const u = interpolate(field.u, p, t);
    const v = interpolate(field.v, p, t);
    if (u == null || v == null) return fb(p, t);
    return { ...vector(u, v), origin: 'observed' };
  };

  return {
    label: `Observed forcing: ${forcing.sources.wind}; ${forcing.sources.current}`,
    sources: { wind: forcing.sources.wind, current: forcing.sources.current },
    wind: (p, t) => vectorOrFallback(forcing.wind, p, t, fallback.wind),
    current: (p, t) => (forcing.coverage.current > 0 ? vectorOrFallback(forcing.current, p, t, fallback.current) : fallback.current(p, t)),
    waveHeight: (p, t) => interpolate(forcing.waveHs, p, t),
  };
}
