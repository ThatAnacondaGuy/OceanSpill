import { angularDiff, haversineKm, axialDiff, type LatLon } from '../lib/geo';
import type { AisPing, AttributionScore, Vessel, VesselTrack } from '../data/types';

/**
 * Spatio-temporal attribution scoring.
 *
 * Follows the structure SkyTruth's Cerulean uses in production — proximity, temporality and
 * course parity against the slick centreline — extended with an explicit behavioural term
 * (speed anomaly, loitering, AIS gaps) and a recidivism prior drawn from the offender
 * registry.
 *
 * Every sub-score is kept separate and surfaced in the UI. A single opaque probability would
 * be worse than useless here: an attribution that cannot be explained cannot be acted on,
 * and a false accusation against a named vessel carries real legal weight.
 */

export interface ScoringWeights {
  proximity: number;
  temporality: number;
  trajectory: number;
  behaviour: number;
  vesselPrior: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  proximity: 0.34,
  temporality: 0.26,
  trajectory: 0.18,
  behaviour: 0.14,
  vesselPrior: 0.08,
};

export interface ScoringContext {
  /** Hindcast release point. */
  origin: LatLon;
  /** Hindcast release time, epoch ms. */
  originTime: number;
  /** Half-width of the plausible discharge window, hours. */
  windowHours: number;
  /** 1-sigma spatial uncertainty of the origin, km. */
  uncertaintyKm: number;
  /** Orientation of the slick's major axis, degrees 0–180. */
  slickOrientationDeg: number;
  /** How linear the slick is. Low elongation means course parity is uninformative. */
  slickElongation: number;
  weights?: ScoringWeights;
}

/** Search radius for pulling candidate traffic: the origin uncertainty plus a margin. */
export function searchRadiusKm(uncertaintyKm: number): number {
  return Math.max(35, uncertaintyKm * 2.6 + 18);
}

/** Interpolates a track to a given time, returning null outside the transmitted span. */
export function interpolateTrack(track: VesselTrack, t: number): AisPing | null {
  const pings = track.pings;
  if (pings.length === 0) return null;
  if (t < pings[0].t || t > pings[pings.length - 1].t) return null;
  for (let i = 1; i < pings.length; i++) {
    const a = pings[i - 1];
    const b = pings[i];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span === 0 ? 0 : (t - a.t) / span;
      return {
        t,
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        sog: a.sog + (b.sog - a.sog) * f,
        cog: a.cog,
        heading: a.heading,
        navStatus: a.navStatus,
      };
    }
  }
  return null;
}

/** True when the vessel had no transmission covering the given instant. */
export function isDarkAt(track: VesselTrack, t: number): boolean {
  return track.gaps.some((g) => t >= g.start && t <= g.end);
}

export interface BehaviourFindings {
  score: number;
  flags: string[];
  darkMinutes: number;
  darkDuringWindow: boolean;
  minSpeedKn: number;
  meanSpeedKn: number;
  maxTurnRate: number;
  loiterMinutes: number;
}

/**
 * Behavioural anomaly detection over the window. Three classic maritime anomaly families are
 * checked — speed, turning and loitering — plus AIS gap behaviour, which is the strongest
 * single indicator because switching off a transponder is a deliberate act.
 */
export function analyseBehaviour(
  track: VesselTrack,
  windowStart: number,
  windowEnd: number
): BehaviourFindings {
  const inWindow = track.pings.filter((p) => p.t >= windowStart && p.t <= windowEnd);
  const flags: string[] = [];

  const darkMs = track.gaps
    .filter((g) => g.end > windowStart && g.start < windowEnd)
    .reduce((sum, g) => sum + (Math.min(g.end, windowEnd) - Math.max(g.start, windowStart)), 0);
  const darkMinutes = Math.round(darkMs / 60000);
  const darkDuringWindow = darkMinutes > 12;

  if (!inWindow.length) {
    return {
      score: darkDuringWindow ? 0.86 : 0.1,
      flags: darkDuringWindow ? [`No AIS transmission for ${darkMinutes} min across the discharge window`] : ['No AIS data in window'],
      darkMinutes,
      darkDuringWindow,
      minSpeedKn: 0,
      meanSpeedKn: 0,
      maxTurnRate: 0,
      loiterMinutes: 0,
    };
  }

  const speeds = inWindow.map((p) => p.sog);
  const minSpeedKn = Math.min(...speeds);
  const meanSpeedKn = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  // Rate of turn derived from consecutive course reports, degrees per minute, ignoring
  // near-stationary reports where COG is meaningless.
  let maxTurnRate = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const a = inWindow[i - 1];
    const b = inWindow[i];
    const minutes = (b.t - a.t) / 60000;
    if (minutes <= 0 || a.sog < 2 || b.sog < 2) continue;
    maxTurnRate = Math.max(maxTurnRate, angularDiff(a.cog, b.cog) / minutes);
  }

  // Loitering: consecutive pings under 2 knots.
  let loiterMs = 0;
  for (let i = 1; i < inWindow.length; i++) {
    if (inWindow[i].sog < 2 && inWindow[i - 1].sog < 2) loiterMs += inWindow[i].t - inWindow[i - 1].t;
  }
  const loiterMinutes = Math.round(loiterMs / 60000);

  let score = 0;

  if (darkDuringWindow) {
    score += Math.min(0.5, 0.18 + darkMinutes / 420);
    flags.push(`AIS dark for ${darkMinutes} min inside the discharge window`);
  }

  // A laden tanker slowing to 4–8 kn is the classic signature of a discharge underway:
  // slow enough to let the slick form astern, fast enough to keep making passage.
  const cruiseEstimate = Math.max(...speeds);
  const slowdown = cruiseEstimate - minSpeedKn;
  if (minSpeedKn >= 3 && minSpeedKn <= 8.5 && slowdown > 3.5) {
    score += 0.26;
    flags.push(`Slowed from ${cruiseEstimate.toFixed(1)} kn to ${minSpeedKn.toFixed(1)} kn within the window`);
  } else if (slowdown > 6) {
    score += 0.12;
    flags.push(`Unexplained speed reduction of ${slowdown.toFixed(1)} kn`);
  }

  if (loiterMinutes > 25) {
    score += 0.2;
    flags.push(`Loitering below 2 kn for ${loiterMinutes} min`);
  }

  if (maxTurnRate > 12) {
    score += 0.1;
    flags.push(`Sharp manoeuvre detected (${maxTurnRate.toFixed(0)}°/min rate of turn)`);
  }

  // Course reversal inside the window.
  const firstCog = inWindow[0].cog;
  const lastCog = inWindow[inWindow.length - 1].cog;
  if (axialDiff(firstCog, lastCog) > 60) {
    score += 0.08;
    flags.push('Substantial course change across the window');
  }

  if (!flags.length) flags.push('Nominal transit behaviour — no anomaly detected');

  return {
    score: Math.min(1, score),
    flags,
    darkMinutes,
    darkDuringWindow,
    minSpeedKn,
    meanSpeedKn,
    maxTurnRate,
    loiterMinutes,
  };
}

export interface CandidateInput {
  vessel: Vessel;
  track: VesselTrack;
}

/**
 * Filters traffic down to vessels that could plausibly be responsible, then scores them.
 * Returns the ranked list plus the vessels that were excluded and why — the exclusion list
 * matters as much as the ranking when the result has to be defended.
 */
/** Name prefixes of Indian Coast Guard, Coast Guard and Navy ships as they appear in AIS. */
const STATE_VESSEL = /^(ICGS|ICG\s|CG\s?\d|INS\s|COAST\s?GUARD|NAVY)/i;

export function scoreCandidates(
  candidates: CandidateInput[],
  ctx: ScoringContext
): { ranked: AttributionScore[]; excluded: { mmsi: string; name: string; reason: string; cpaKm: number }[] } {
  const weights = ctx.weights ?? DEFAULT_WEIGHTS;
  const radius = searchRadiusKm(ctx.uncertaintyKm);
  const windowMs = ctx.windowHours * 3600_000;
  // Cerulean-style asymmetric window: more time before the acquisition than after it.
  const windowStart = ctx.originTime - windowMs * 1.35;
  const windowEnd = ctx.originTime + windowMs;

  const ranked: AttributionScore[] = [];
  const excluded: { mmsi: string; name: string; reason: string; cpaKm: number }[] = [];

  for (const { vessel, track } of candidates) {
    // Vessels that came to the incident to help, and state patrol ships, loiter near a slick by
    // design. Ranking them as suspects would be wrong, so they are listed as excluded instead.
    if (vessel.role === 'responder') {
      excluded.push({ mmsi: vessel.mmsi, name: vessel.name, reason: 'Reported response vessel (assisting at the incident)', cpaKm: Infinity });
      continue;
    }
    if (STATE_VESSEL.test(vessel.name)) {
      excluded.push({ mmsi: vessel.mmsi, name: vessel.name, reason: 'Coast Guard / Navy vessel (name indicates a state patrol or response ship)', cpaKm: Infinity });
      continue;
    }

    // Closest approach to the hindcast origin, restricted to the plausible window.
    let cpaKm = Infinity;
    let cpaTime = ctx.originTime;
    let cpaPing: AisPing | null = null;

    const relevant = track.pings.filter((p) => p.t >= windowStart - 3600_000 && p.t <= windowEnd + 3600_000);
    for (const p of relevant) {
      const d = haversineKm(ctx.origin, p);
      // Ties (e.g. a stationary facility or an anchored wreck) resolve to the report nearest in time.
      const tie = Math.abs(d - cpaKm) <= 0.05 && Math.abs(p.t - ctx.originTime) < Math.abs(cpaTime - ctx.originTime);
      if (d < cpaKm - 0.05 || tie) {
        cpaKm = d;
        cpaTime = p.t;
        cpaPing = p;
      }
    }

    // A vessel that was dark throughout is still a candidate: absence of AIS near a slick is
    // itself evidence. Score it from the gap geometry rather than dropping it. Fixed facilities
    // do not transmit AIS, so behavioural terms do not apply to them.
    const behaviour = vessel.isFacility
      ? { score: 0, flags: ['Fixed facility: behavioural anomaly terms not applicable'], darkMinutes: 0, darkDuringWindow: false, minSpeedKn: 0, meanSpeedKn: 0, maxTurnRate: 0, loiterMinutes: 0 }
      : analyseBehaviour(track, windowStart, windowEnd);

    if (!cpaPing && !behaviour.darkDuringWindow) {
      excluded.push({ mmsi: vessel.mmsi, name: vessel.name, reason: 'No AIS reports within the discharge window', cpaKm: Infinity });
      continue;
    }

    // Dark through the whole window: estimate where it was from its last position before the
    // silence and its first position after, instead of scoring it with no position at all.
    let acrossGap = false;
    if (!cpaPing) {
      const before = track.pings.filter((p) => p.t < windowStart).pop();
      const after = track.pings.find((p) => p.t > windowEnd);
      if (!before || !after) {
        excluded.push({ mmsi: vessel.mmsi, name: vessel.name, reason: 'Silent throughout the window with no position before and after it', cpaKm: Infinity });
        continue;
      }
      const f = Math.min(1, Math.max(0, (ctx.originTime - before.t) / (after.t - before.t)));
      const est = { lat: before.lat + (after.lat - before.lat) * f, lon: before.lon + (after.lon - before.lon) * f };
      cpaKm = haversineKm(ctx.origin, est);
      cpaTime = ctx.originTime;
      cpaPing = { ...before, ...est, t: ctx.originTime };
      acrossGap = true;
    }

    // Applies to dark vessels too: an AIS gap far from the origin is not evidence about this slick.
    if (cpaKm > radius) {
      excluded.push({
        mmsi: vessel.mmsi,
        name: vessel.name,
        reason: `Closest approach ${cpaKm.toFixed(1)} km exceeds the ${radius.toFixed(0)} km search radius`,
        cpaKm,
      });
      continue;
    }

    if (vessel.type === 'Fishing Vessel' && cpaKm > radius * 0.35) {
      excluded.push({
        mmsi: vessel.mmsi,
        name: vessel.name,
        reason: 'Small fishing vessel outside the tightened radius — implausible discharge volume',
        cpaKm,
      });
      continue;
    }

    const reasons: string[] = [];
    const flags: string[] = [];

    // Proximity: Gaussian decay over the origin uncertainty, so the score is calibrated
    // against how well the origin is actually known rather than a fixed distance.
    const sigma = Math.max(6, ctx.uncertaintyKm);
    const proximity = Math.exp(-(cpaKm ** 2) / (2 * sigma ** 2));
    reasons.push(`Closest approach ${cpaKm.toFixed(1)} km from the hindcast origin (1σ = ${sigma.toFixed(0)} km)${acrossGap ? ', estimated across its AIS gap' : ''}`);

    // Temporality: how close the CPA was to the estimated discharge time.
    const deltaMin = (cpaTime - ctx.originTime) / 60000;
    const tSigmaMin = ctx.windowHours * 60 * 0.62;
    const temporality = Math.exp(-(deltaMin ** 2) / (2 * tSigmaMin ** 2));
    reasons.push(
      `Passed the origin ${Math.abs(deltaMin).toFixed(0)} min ${deltaMin >= 0 ? 'after' : 'before'} the estimated discharge time`
    );

    // Trajectory parity: a moving discharge lays oil along the vessel's course, so the slick's
    // major axis should align with the heading. Only meaningful for elongated slicks.
    let trajectory = 0.5;
    let courseAlignmentDeg = 90;
    if (vessel.isFacility) {
      reasons.push('Fixed facility: course parity not applicable (neutral score)');
    } else if (cpaPing) {
      courseAlignmentDeg = axialDiff(cpaPing.cog, ctx.slickOrientationDeg);
      const alignment = 1 - courseAlignmentDeg / 90;
      const linearity = Math.min(1, Math.max(0, (ctx.slickElongation - 1.8) / 4.5));
      trajectory = 0.5 + (alignment - 0.5) * linearity;
      if (linearity < 0.2) {
        reasons.push('Slick too compact for course parity to be informative — trajectory term down-weighted');
      } else if (courseAlignmentDeg < 22) {
        reasons.push(`Course ${cpaPing.cog.toFixed(0)}° aligns with the slick axis ${ctx.slickOrientationDeg.toFixed(0)}° (Δ ${courseAlignmentDeg.toFixed(0)}°)`);
      } else {
        reasons.push(`Course ${cpaPing.cog.toFixed(0)}° is ${courseAlignmentDeg.toFixed(0)}° off the slick axis`);
      }
    }

    // Recidivism and registry priors. Real vessels only receive a prior from verified registry data.
    let vesselPrior = 0;
    if (vessel.provenance === 'real' && !vessel.registryVerified && !vessel.isFacility) {
      reasons.push('Registry history not verified: no prior applied');
    }
    if (vessel.priorOffences > 0) {
      vesselPrior += Math.min(0.62, vessel.priorOffences * 0.22);
      flags.push(`${vessel.priorOffences} prior confirmed attribution${vessel.priorOffences > 1 ? 's' : ''}`);
    }
    if (vessel.sanctioned) {
      vesselPrior += 0.25;
      flags.push(`Listed on ${vessel.sanctionsList ?? 'a sanctions register'}`);
    }
    if (vessel.flagRisk === 'Black List') {
      vesselPrior += 0.12;
      flags.push(`${vessel.flag} flag is on the Paris MoU black list`);
    } else if (vessel.flagRisk === 'Grey List') {
      vesselPrior += 0.06;
    }
    if (vessel.pscDetentions && vessel.pscDetentions > 0) {
      vesselPrior += Math.min(0.14, vessel.pscDetentions * 0.07);
      flags.push(`${vessel.pscDetentions} port-state detention${vessel.pscDetentions > 1 ? 's' : ''} on record`);
    }
    const tankerTypes = ['Crude Oil Tanker', 'Product Tanker', 'Chemical Tanker'];
    if (tankerTypes.includes(vessel.type)) {
      vesselPrior += 0.08;
      reasons.push(`${vessel.type} — carries the cargo and slop volumes consistent with the observed slick`);
    }
    vesselPrior = Math.min(1, vesselPrior);

    if (behaviour.darkDuringWindow) flags.push('DARK VESSEL — transponder silent during the window');

    const total =
      weights.proximity * proximity +
      weights.temporality * temporality +
      weights.trajectory * trajectory +
      weights.behaviour * behaviour.score +
      weights.vesselPrior * vesselPrior;

    ranked.push({
      mmsi: vessel.mmsi,
      proximity,
      temporality,
      trajectory,
      behaviour: behaviour.score,
      vesselPrior,
      total,
      rank: 0,
      cpaKm,
      cpaTime,
      deltaTimeMin: deltaMin,
      courseAlignmentDeg,
      reasons: [...reasons, ...behaviour.flags],
      flags,
      darkDuringWindow: behaviour.darkDuringWindow,
      darkMinutes: behaviour.darkMinutes,
    });
  }

  ranked.sort((a, b) => b.total - a.total);
  ranked.forEach((r, i) => (r.rank = i + 1));
  excluded.sort((a, b) => a.cpaKm - b.cpaKm);
  return { ranked, excluded };
}

/**
 * Converts the top score into a plain-language confidence band. The wording deliberately
 * stops short of asserting guilt — this output prioritises an inspection, it is not proof.
 */
export function attributionVerdict(ranked: AttributionScore[]): {
  band: 'Strong' | 'Moderate' | 'Weak' | 'Inconclusive';
  label: string;
  detail: string;
  separation: number;
} {
  if (!ranked.length) {
    return {
      band: 'Inconclusive',
      label: 'No candidate vessel',
      detail: 'No AIS traffic intersected the discharge window. Treat as a suspected dark-vessel event.',
      separation: 0,
    };
  }
  const top = ranked[0];
  const second = ranked[1];
  const separation = second ? top.total - second.total : top.total;

  if (top.total >= 0.72 && separation >= 0.12) {
    return {
      band: 'Strong',
      label: 'Strong spatio-temporal correlation',
      detail: 'One vessel dominates the ranking with a clear margin. Recommend dispatching verification to collect a physical sample for forensic fingerprint matching.',
      separation,
    };
  }
  if (top.total >= 0.55) {
    return {
      band: 'Moderate',
      label: 'Moderate correlation — corroboration required',
      detail: separation < 0.08
        ? 'The leading candidates are closely separated. Attribution cannot be narrowed to a single vessel on AIS correlation alone.'
        : 'The leading candidate is plausible but the margin does not support enforcement without physical corroboration.',
      separation,
    };
  }
  if (top.total >= 0.35) {
    return {
      band: 'Weak',
      label: 'Weak correlation',
      detail: 'No candidate correlates strongly with the hindcast origin. Widen the search window or re-run the hindcast with updated ocean forcing.',
      separation,
    };
  }
  return {
    band: 'Inconclusive',
    label: 'Inconclusive',
    detail: 'Candidate scores are indistinguishable from background traffic. Not suitable for attribution.',
    separation,
  };
}
