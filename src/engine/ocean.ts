import type { LatLon } from '../lib/geo';

/**
 * Deterministic synthetic ocean/atmosphere fields for the North Indian Ocean.
 *
 * These stand in for the INCOIS forecast products the production system would ingest.
 * They are not a general circulation model, but they reproduce the features that matter
 * for surface drift in this basin: the seasonally reversing monsoon current, the East and
 * West India Coastal Currents, the Somali/Lakshadweep gyre pair, and a wind field that
 * flips between the SW monsoon (Jun–Sep) and the NE monsoon (Nov–Feb).
 */

export interface VectorSample {
  /** Eastward component, m/s. */
  u: number;
  /** Northward component, m/s. */
  v: number;
  /** Magnitude, m/s. */
  speed: number;
  /** Direction the flow is heading toward, degrees clockwise from north. */
  dirTo: number;
  /** Direction the flow is coming from, degrees clockwise from north (meteorological convention). */
  dirFrom: number;
}

function vector(u: number, v: number): VectorSample {
  const speed = Math.hypot(u, v);
  const dirTo = (Math.atan2(u, v) * 180) / Math.PI;
  const to = (dirTo + 360) % 360;
  return { u, v, speed, dirTo: to, dirFrom: (to + 180) % 360 };
}

/** Smooth deterministic noise in [-1, 1] — reproducible across reloads and sessions. */
function fieldNoise(x: number, y: number, t: number, seed = 0): number {
  const a = Math.sin(x * 0.7 + t * 0.11 + seed * 1.7);
  const b = Math.cos(y * 0.9 - t * 0.07 + seed * 2.3);
  const c = Math.sin((x + y) * 0.35 + t * 0.05 + seed * 0.9);
  return (a * 0.5 + b * 0.3 + c * 0.2);
}

/**
 * Monsoon phase: +1 at the height of the SW monsoon (August), -1 at the height of the
 * NE monsoon (February). Drives the reversal of the Indian Monsoon Current.
 */
export function monsoonPhase(date: Date): number {
  const dayOfYear = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
  return -Math.cos(((dayOfYear - 32) / 365) * 2 * Math.PI);
}

export function monsoonLabel(date: Date): string {
  const m = date.getUTCMonth();
  if (m >= 5 && m <= 8) return 'Southwest Monsoon';
  if (m >= 10 || m <= 1) return 'Northeast Monsoon';
  if (m >= 2 && m <= 4) return 'Pre-monsoon (Inter-monsoon I)';
  return 'Post-monsoon (Inter-monsoon II)';
}

/** Surface current at a position and time. */
export function currentAt(p: LatLon, date: Date): VectorSample {
  const phase = monsoonPhase(date);
  const t = date.getTime() / 3.6e6; // hours
  const { lat, lon } = p;

  // Indian Monsoon Current: reverses direction with the monsoon, strongest 5–12 N.
  const imcBand = Math.exp(-((lat - 8.5) ** 2) / 32);
  const imcU = phase * 0.55 * imcBand;

  // West India Coastal Current: poleward in winter (NE monsoon), equatorward in summer.
  const wiccProx = Math.exp(-((lon - (72.5 - (lat - 8) * 0.15)) ** 2) / 8) * Math.exp(-((lat - 15) ** 2) / 90);
  const wiccV = -phase * 0.42 * wiccProx;
  const wiccU = -phase * 0.1 * wiccProx;

  // East India Coastal Current: northward Feb–Apr, southward during the SW monsoon.
  const eiccProx = Math.exp(-((lon - (81.5 + (lat - 10) * 0.35)) ** 2) / 10) * Math.exp(-((lat - 16) ** 2) / 110);
  const eiccV = -phase * 0.38 * eiccProx;

  // Lakshadweep High/Low — an anticyclonic eddy in winter, cyclonic in summer.
  const lx = lon - 73.0;
  const ly = lat - 10.0;
  const lr2 = lx * lx + ly * ly;
  const lakEddy = Math.exp(-lr2 / 18);
  const lakU = -phase * 0.35 * ly * lakEddy * 0.4;
  const lakV = phase * 0.35 * lx * lakEddy * 0.4;

  // Bay of Bengal cyclonic circulation, persistent but seasonally modulated.
  const bx = lon - 87.0;
  const by = lat - 15.0;
  const bobEddy = Math.exp(-(bx * bx + by * by) / 60);
  const bobU = -by * bobEddy * 0.075;
  const bobV = bx * bobEddy * 0.075;

  // Mesoscale eddy field and tidal residual.
  const nU = fieldNoise(lon, lat, t * 0.02, 1) * 0.16;
  const nV = fieldNoise(lon, lat, t * 0.02, 2) * 0.16;
  const tidal = Math.sin(t * (2 * Math.PI) / 12.42);
  const shelf = Math.exp(-((coastDistanceProxy(p)) ** 2) / 12);
  const tU = tidal * 0.18 * shelf;
  const tV = tidal * 0.12 * shelf;

  return vector(imcU + wiccU + lakU + bobU + nU + tU, wiccV + eiccV + lakV + bobV + nV + tV);
}

/** Crude proxy for distance from the coastline in degrees, used to scale shelf effects. */
function coastDistanceProxy(p: LatLon): number {
  const westCoastLon = 72.8 - (p.lat - 8) * 0.18;
  const eastCoastLon = 80.2 + (p.lat - 8) * 0.42;
  const dWest = Math.abs(p.lon - westCoastLon);
  const dEast = Math.abs(p.lon - eastCoastLon);
  return Math.min(dWest, dEast);
}

/** 10 m wind at a position and time. */
export function windAt(p: LatLon, date: Date): VectorSample {
  const phase = monsoonPhase(date);
  const t = date.getTime() / 3.6e6;
  const { lat, lon } = p;

  // SW monsoon: strong southwesterlies. NE monsoon: moderate northeasterlies.
  const swStrength = Math.max(0, phase) * 11.5;
  const neStrength = Math.max(0, -phase) * 6.5;
  const latTaper = Math.exp(-((lat - 12) ** 2) / 260);

  const swU = swStrength * 0.82 * latTaper;
  const swV = swStrength * 0.48 * latTaper;
  const neU = -neStrength * 0.62 * latTaper;
  const neV = -neStrength * 0.58 * latTaper;

  // Diurnal land/sea breeze near the coast.
  const hour = (date.getUTCHours() + lon / 15) % 24;
  const breeze = Math.sin(((hour - 9) / 24) * 2 * Math.PI) * 2.2 * Math.exp(-((coastDistanceProxy(p)) ** 2) / 4);
  const towardLand = lon < 77 ? 1 : -1;

  const gustU = fieldNoise(lon * 1.3, lat * 1.3, t * 0.05, 5) * 2.1;
  const gustV = fieldNoise(lon * 1.3, lat * 1.3, t * 0.05, 6) * 2.1;

  return vector(swU + neU + breeze * towardLand + gustU, swV + neV + gustV);
}

export interface SeaState {
  significantWaveHeightM: number;
  peakPeriodS: number;
  seaSurfaceTempC: number;
  salinityPsu: number;
  /** Beaufort scale derived from wind speed. */
  beaufort: number;
  beaufortLabel: string;
  /**
   * SAR detectability window. Oil damping is only visible between roughly 3 and 10 m/s of
   * wind: below that the whole sea looks dark, above it wave breaking re-roughens the slick.
   */
  sarDetectability: 'Optimal' | 'Marginal — low wind' | 'Marginal — high wind' | 'Poor';
}

const BEAUFORT_LABELS = [
  'Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze', 'Fresh breeze',
  'Strong breeze', 'Near gale', 'Gale', 'Strong gale', 'Storm', 'Violent storm', 'Hurricane',
];

export function beaufortFromSpeed(ms: number): number {
  const thresholds = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  for (let i = 0; i < thresholds.length; i++) if (ms < thresholds[i]) return i;
  return 12;
}

export function seaStateAt(p: LatLon, date: Date): SeaState {
  const wind = windAt(p, date);
  const phase = monsoonPhase(date);
  // Fully-developed sea approximation: Hs ≈ 0.0248 * U^2 for long fetch.
  const hs = Math.max(0.3, 0.0248 * wind.speed ** 2 * 0.75 + 0.4);
  const tp = 3.5 + 2.6 * Math.sqrt(Math.max(hs, 0.1));
  const sst = 28.4 - Math.abs(p.lat - 12) * 0.22 - Math.max(0, phase) * 1.6 + fieldNoise(p.lon, p.lat, 0, 9) * 0.5;
  const sal = p.lon > 84 ? 32.4 + fieldNoise(p.lon, p.lat, 0, 11) * 0.6 : 35.2 + fieldNoise(p.lon, p.lat, 0, 12) * 0.4;
  const bft = beaufortFromSpeed(wind.speed);

  let det: SeaState['sarDetectability'];
  if (wind.speed < 1.8) det = 'Poor';
  else if (wind.speed < 3.0) det = 'Marginal — low wind';
  else if (wind.speed <= 10.0) det = 'Optimal';
  else if (wind.speed <= 13.5) det = 'Marginal — high wind';
  else det = 'Poor';

  return {
    significantWaveHeightM: Number(hs.toFixed(2)),
    peakPeriodS: Number(tp.toFixed(1)),
    seaSurfaceTempC: Number(sst.toFixed(1)),
    salinityPsu: Number(sal.toFixed(1)),
    beaufort: bft,
    beaufortLabel: BEAUFORT_LABELS[bft],
    sarDetectability: det,
  };
}

/**
 * Stokes drift from the wave field. Empirically close to 1.2% of the 10 m wind speed for a
 * fully developed sea, aligned with the wind.
 */
export function stokesDrift(p: LatLon, date: Date): VectorSample {
  const w = windAt(p, date);
  return vector(w.u * 0.012, w.v * 0.012);
}

/** Samples the current field on a regular grid — used to draw the vector overlay. */
export function sampleField(
  bounds: { north: number; south: number; east: number; west: number },
  date: Date,
  cols: number,
  rows: number,
  kind: 'current' | 'wind'
): { position: LatLon; sample: VectorSample }[] {
  const out: { position: LatLon; sample: VectorSample }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat = bounds.south + ((bounds.north - bounds.south) * (r + 0.5)) / rows;
      const lon = bounds.west + ((bounds.east - bounds.west) * (c + 0.5)) / cols;
      const position = { lat, lon };
      out.push({ position, sample: kind === 'current' ? currentAt(position, date) : windAt(position, date) });
    }
  }
  return out;
}
