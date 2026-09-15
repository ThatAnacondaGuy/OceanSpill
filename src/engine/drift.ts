import { offsetKm, haversineKm, centroid, type LatLon } from '../lib/geo';
import { MODEL_SAMPLER, type FieldSampler } from './forcing';

/**
 * Lagrangian particle drift model for surface oil, in the style of OpenDrift/OpenOil and
 * NOAA GNOME.
 *
 * Each particle advances under
 *     u_drift = u_current + u_stokes + windage * u_wind + turbulent diffusion
 * where windage is the fraction of the 10 m wind transferred to the floating slick. The
 * literature range is 2.5–5%; 3% is the conventional default and is used here.
 *
 * Running the same integration with a negative timestep gives the hindcast, which is how
 * the origin point and discharge window are recovered from an observed slick.
 */

export const WINDAGE_DEFAULT = 0.03;
export const HORIZONTAL_DIFFUSIVITY_DEFAULT = 8; // m^2/s

export interface DriftParams {
  windage: number;
  /** Horizontal eddy diffusivity, m²/s. Controls how fast the particle cloud spreads. */
  diffusivity: number;
  /** Integration step in minutes. */
  stepMinutes: number;
  /** Number of particles in the cloud. */
  particles: number;
}

export const DEFAULT_DRIFT_PARAMS: DriftParams = {
  windage: WINDAGE_DEFAULT,
  diffusivity: HORIZONTAL_DIFFUSIVITY_DEFAULT,
  stepMinutes: 30,
  particles: 220,
};

/** Mulberry32 — small, fast, deterministic PRNG so every run of the model reproduces. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal deviate. */
function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface DriftStep {
  time: number;
  /** Particle cloud at this timestep. */
  particles: LatLon[];
  centroid: LatLon;
  /** Radius containing ~68% of particles, in km. */
  spreadKm: number;
}

export interface DriftResult {
  steps: DriftStep[];
  /** Centre-of-mass path, one point per step. */
  path: LatLon[];
  origin: LatLon;
  originTime: number;
  endTime: number;
  /** 1-sigma uncertainty radius at the far end of the run. */
  finalSpreadKm: number;
  params: DriftParams;
}

/**
 * Integrates a particle cloud forward or backward in time.
 * A negative `hours` runs the model backward, producing the hindcast.
 */
export function runDrift(
  start: LatLon,
  startTime: number,
  hours: number,
  params: Partial<DriftParams> = {},
  seed = 1337,
  initialRadiusKm = 0.6,
  sampler: FieldSampler = MODEL_SAMPLER
): DriftResult {
  const p: DriftParams = { ...DEFAULT_DRIFT_PARAMS, ...params };
  const rng = makeRng(seed);
  const backward = hours < 0;
  const totalMinutes = Math.abs(hours) * 60;
  const steps = Math.max(1, Math.round(totalMinutes / p.stepMinutes));
  const dtSec = p.stepMinutes * 60 * (backward ? -1 : 1);
  const land = sampler.land;
  const toWater = (q: LatLon): LatLon => (land && land.isLand(q) ? land.nearestWater(q) ?? q : q);

  // Seed the cloud in a disc around the start position; oil starts on the water, never inland.
  const seedCentre = toWater(start);
  let cloud: LatLon[] = [];
  for (let i = 0; i < p.particles; i++) {
    const r = initialRadiusKm * Math.sqrt(rng());
    const th = rng() * 2 * Math.PI;
    let q = offsetKm(seedCentre, r * Math.cos(th), r * Math.sin(th));
    if (land?.isLand(q)) q = seedCentre;
    cloud.push(q);
  }

  const out: DriftStep[] = [];
  const record = (time: number, particles: LatLon[]) => {
    // The centre of a cloud hugging a curved coast can fall inland; keep the reported centre on the water.
    const c = toWater(centroid(particles));
    const dists = particles.map((q) => haversineKm(c, q)).sort((a, b) => a - b);
    const spreadKm = dists[Math.floor(dists.length * 0.68)] ?? 0;
    out.push({ time, particles: particles.map((q) => ({ ...q })), centroid: c, spreadKm });
  };

  record(startTime, cloud);
  let t = startTime;

  for (let s = 0; s < steps; s++) {
    const when = new Date(t);
    const next: LatLon[] = [];
    for (const q of cloud) {
      const cur = sampler.current(q, when.getTime());
      const wind = sampler.wind(q, when.getTime());
      const stokes = { u: wind.u * 0.012, v: wind.v * 0.012 };

      const u = cur.u + stokes.u + p.windage * wind.u;
      const v = cur.v + stokes.v + p.windage * wind.v;

      // Random-walk turbulent displacement: sigma = sqrt(2 * K * dt)
      const sigmaM = Math.sqrt(2 * p.diffusivity * Math.abs(dtSec));
      const dxKm = (u * dtSec + sigmaM * gauss(rng)) / 1000;
      const dyKm = (v * dtSec + sigmaM * gauss(rng)) / 1000;
      const moved = offsetKm(q, dxKm, dyKm);
      // A step that would carry the particle onto land leaves it beached on the shore for this step;
      // it refloats as soon as the forcing carries it back offshore.
      next.push(land?.isLand(moved) ? q : moved);
    }
    cloud = next;
    t += dtSec * 1000;
    record(t, cloud);
  }

  const last = out[out.length - 1];
  return {
    steps: out,
    path: out.map((s) => s.centroid),
    origin: last.centroid,
    originTime: last.time,
    endTime: t,
    finalSpreadKm: last.spreadKm,
    params: p,
  };
}

export interface HindcastResult extends DriftResult {
  /** Best estimate of where the discharge happened. */
  estimatedOrigin: LatLon;
  /** Best estimate of when, as an epoch millisecond value. */
  estimatedTime: number;
  /** Half-width of the discharge time window, in hours. */
  timeWindowHours: number;
  /** Radius of the origin uncertainty ellipse, in km. */
  uncertaintyRadiusKm: number;
  /** Ensemble members, each a perturbed realisation of the backward run. */
  ensemble: { path: LatLon[]; origin: LatLon }[];
  confidence: number;
}

/**
 * Backward run with an ensemble over perturbed windage and diffusivity. The spread of the
 * ensemble origins is the honest uncertainty estimate — a single backward trajectory would
 * overstate how precisely the release point is known.
 */
export function hindcast(
  observed: LatLon,
  observedTime: number,
  hoursBack: number,
  params: Partial<DriftParams> = {},
  members = 12,
  seed = 20250312,
  sampler: FieldSampler = MODEL_SAMPLER
): HindcastResult {
  const base = runDrift(observed, observedTime, -Math.abs(hoursBack), params, seed, 0.6, sampler);
  const ensemble: { path: LatLon[]; origin: LatLon }[] = [];
  const rng = makeRng(seed + 77);

  for (let m = 0; m < members; m++) {
    const windage = WINDAGE_DEFAULT * (0.7 + rng() * 0.75); // 2.1% – 5.3%
    const diffusivity = HORIZONTAL_DIFFUSIVITY_DEFAULT * (0.5 + rng() * 1.4);
    const run = runDrift(
      observed,
      observedTime,
      -Math.abs(hoursBack),
      { ...params, windage, diffusivity, particles: 60 },
      seed + m * 991,
      0.6,
      sampler
    );
    ensemble.push({ path: run.path, origin: run.origin });
  }

  const origins = ensemble.map((e) => e.origin);
  const mean = centroid([...origins, base.origin]);
  const meanOrigin = sampler.land?.isLand(mean) ? sampler.land.nearestWater(mean) ?? mean : mean;
  const spread = origins.map((o) => haversineKm(meanOrigin, o)).sort((a, b) => a - b);
  const p90 = spread[Math.floor(spread.length * 0.9)] ?? base.finalSpreadKm;
  const uncertaintyRadiusKm = Math.max(base.finalSpreadKm, p90);

  // Confidence decays with how far back we integrated and how wide the ensemble spread is.
  const timePenalty = Math.min(1, Math.abs(hoursBack) / 36);
  const spreadPenalty = Math.min(1, uncertaintyRadiusKm / 60);
  const confidence = Math.max(0.12, 0.96 - timePenalty * 0.34 - spreadPenalty * 0.4);

  return {
    ...base,
    estimatedOrigin: meanOrigin,
    estimatedTime: base.originTime,
    timeWindowHours: Math.max(1.5, Math.abs(hoursBack) * 0.18 + uncertaintyRadiusKm / 22),
    uncertaintyRadiusKm,
    ensemble,
    confidence,
  };
}

export interface ForecastResult extends DriftResult {
  /** Forward positions bucketed at fixed horizons for the UI. */
  horizons: { hours: number; centroid: LatLon; spreadKm: number; time: number }[];
}

export function forecast(
  observed: LatLon,
  observedTime: number,
  hoursAhead: number,
  params: Partial<DriftParams> = {},
  seed = 424242,
  sampler: FieldSampler = MODEL_SAMPLER
): ForecastResult {
  const run = runDrift(observed, observedTime, Math.abs(hoursAhead), params, seed, 0.6, sampler);
  const marks = [6, 12, 24, 36, 48, 72].filter((h) => h <= Math.abs(hoursAhead));
  const horizons = marks.map((h) => {
    const targetTime = observedTime + h * 3600_000;
    let best = run.steps[0];
    for (const s of run.steps) {
      if (Math.abs(s.time - targetTime) < Math.abs(best.time - targetTime)) best = s;
    }
    return { hours: h, centroid: best.centroid, spreadKm: best.spreadKm, time: best.time };
  });
  return { ...run, horizons };
}

/**
 * Oil weathering. Evaporation of the light ends follows an approximately logarithmic curve
 * in time; water uptake (emulsification) follows a saturating exponential. Both change the
 * slick's radar contrast, which is what makes an age estimate possible at all.
 */
export interface WeatheringState {
  ageHours: number;
  evaporatedPct: number;
  waterContentPct: number;
  /** Mean film thickness in micrometres. */
  thicknessUm: number;
  viscosityCp: number;
  /** Fraction of the original release still on the surface. */
  remainingPct: number;
  appearance: string;
  /** Estimated contrast against surrounding sea in dB — how dark the slick looks to SAR. */
  sarContrastDb: number;
}

export interface OilProperties {
  label: string;
  /** API gravity. Higher is lighter and evaporates faster. */
  api: number;
  /** Asymptotic maximum water uptake. */
  maxWaterPct: number;
  initialThicknessUm: number;
}

export const OIL_TYPES: Record<string, OilProperties> = {
  bunkerC: { label: 'Bunker C / HFO (IFO-380)', api: 11, maxWaterPct: 78, initialThicknessUm: 220 },
  crudeMedium: { label: 'Medium Crude (Arabian Light)', api: 33, maxWaterPct: 68, initialThicknessUm: 120 },
  crudeHeavy: { label: 'Heavy Crude', api: 19, maxWaterPct: 72, initialThicknessUm: 180 },
  marineDiesel: { label: 'Marine Gas Oil / MDO', api: 38, maxWaterPct: 35, initialThicknessUm: 40 },
  bilge: { label: 'Oily Bilge / Sludge Mix', api: 24, maxWaterPct: 60, initialThicknessUm: 65 },
  lubricant: { label: 'Waste Lubricating Oil', api: 28, maxWaterPct: 45, initialThicknessUm: 55 },
};

export function weather(
  oil: OilProperties,
  ageHours: number,
  windSpeedMs: number,
  sstC: number
): WeatheringState {
  const h = Math.max(0.05, ageHours);
  // Evaporation: rate scales with API gravity, wind and temperature.
  const k = 0.031 * (oil.api / 30) * (1 + windSpeedMs / 14) * (1 + (sstC - 25) / 55);
  const evaporated = Math.min(oil.api > 35 ? 62 : oil.api > 25 ? 42 : 24, 100 * k * Math.log(1 + h * 1.9));

  // Emulsification: water uptake saturates, faster in rough seas.
  const kw = 0.055 * (1 + windSpeedMs / 8);
  const water = oil.maxWaterPct * (1 - Math.exp(-kw * h));

  // Spreading thins the film; natural dispersion removes mass in higher winds.
  const thickness = Math.max(0.35, oil.initialThicknessUm / (1 + 0.42 * Math.pow(h, 0.82)));
  const dispersed = Math.min(30, 0.42 * h * (windSpeedMs / 9) ** 2);
  const remaining = Math.max(10, 100 - evaporated * 0.55 - dispersed);

  // Mackay viscosity increase from water content and loss of light ends.
  const visc0 = Math.max(4, 900 * Math.exp(-0.085 * oil.api));
  const viscosity = visc0 * Math.exp(0.042 * evaporated) * Math.exp((2.5 * water / 100) / (1 - 0.65 * (water / 100)));

  let appearance: string;
  if (thickness < 0.5) appearance = 'Silver / rainbow sheen';
  else if (thickness < 5) appearance = 'Rainbow to metallic sheen';
  else if (thickness < 50) appearance = 'Discontinuous true-colour oil';
  else if (water > 45) appearance = 'Chocolate mousse emulsion';
  else appearance = 'Continuous true-colour oil';

  // Thicker films damp capillary waves more, but weathered emulsion damps less than fresh oil.
  const damping = Math.min(1, Math.log10(1 + thickness) / 2.3);
  const contrast = -(3.2 + damping * 9.5) * (1 - water / 240);

  return {
    ageHours: h,
    evaporatedPct: Number(evaporated.toFixed(1)),
    waterContentPct: Number(water.toFixed(1)),
    thicknessUm: Number(thickness.toFixed(2)),
    viscosityCp: Math.round(viscosity),
    remainingPct: Number(remaining.toFixed(1)),
    appearance,
    sarContrastDb: Number(contrast.toFixed(1)),
  };
}

/**
 * Inverts the weathering model: given the slick's observed area and SAR contrast, find the
 * age whose predicted state best matches. This is the "age if feasible" deliverable —
 * reported with an explicit residual so the analyst can see how well-constrained it is.
 */
export function estimateAge(
  oil: OilProperties,
  observedAreaKm2: number,
  observedContrastDb: number,
  releaseVolumeM3: number,
  windSpeedMs: number,
  sstC: number
): { ageHours: number; residual: number; confidence: number; curve: { h: number; predictedAreaKm2: number; contrast: number }[] } {
  const curve: { h: number; predictedAreaKm2: number; contrast: number }[] = [];
  let best = { ageHours: 1, residual: Infinity };

  for (let h = 0.5; h <= 96; h += 0.5) {
    const w = weather(oil, h, windSpeedMs, sstC);
    // Volume conservation: area = remaining volume / film thickness.
    const volM3 = releaseVolumeM3 * (w.remainingPct / 100);
    const predictedAreaKm2 = (volM3 / (w.thicknessUm * 1e-6)) / 1e6;
    curve.push({ h, predictedAreaKm2, contrast: w.sarContrastDb });

    const areaErr = Math.abs(Math.log(Math.max(predictedAreaKm2, 1e-6)) - Math.log(Math.max(observedAreaKm2, 1e-6)));
    const contrastErr = Math.abs(w.sarContrastDb - observedContrastDb) / 6;
    const residual = areaErr + contrastErr;
    if (residual < best.residual) best = { ageHours: h, residual };
  }

  const confidence = Math.max(0.05, Math.min(0.9, 1 / (1 + best.residual * 2.6)));
  return { ...best, confidence, curve };
}
