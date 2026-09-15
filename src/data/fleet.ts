import { bearingDeg, destination, haversineKm, type LatLon } from '../lib/geo';
import { makeRng } from '../engine/drift';
import type { AisPing, Vessel, VesselTrack, VesselType } from './types';

/**
 * Vessel registry and AIS track synthesis.
 *
 * Track geometry follows the MarineCadastre AIS schema (MMSI, position, SOG, COG, heading,
 * navigational status, rate of turn) so that the same code path would accept a real feed.
 * Tracks are generated deterministically from a seed, which means the demo reproduces exactly
 * and the attribution results are stable across reloads.
 */

const FLAGS: { flag: string; risk: Vessel['flagRisk']; prefix: string }[] = [
  { flag: 'India', risk: 'Standard', prefix: '419' },
  { flag: 'Panama', risk: 'Grey List', prefix: '351' },
  { flag: 'Liberia', risk: 'Standard', prefix: '636' },
  { flag: 'Marshall Islands', risk: 'Standard', prefix: '538' },
  { flag: 'Singapore', risk: 'Standard', prefix: '563' },
  { flag: 'Malta', risk: 'Standard', prefix: '215' },
  { flag: 'Cyprus', risk: 'Standard', prefix: '212' },
  { flag: 'Cameroon', risk: 'Black List', prefix: '613' },
  { flag: 'Togo', risk: 'Black List', prefix: '671' },
  { flag: 'Comoros', risk: 'Black List', prefix: '616' },
  { flag: 'Gabon', risk: 'Grey List', prefix: '626' },
  { flag: 'Palau', risk: 'Grey List', prefix: '511' },
  { flag: 'Sri Lanka', risk: 'Standard', prefix: '417' },
  { flag: 'Bangladesh', risk: 'Grey List', prefix: '405' },
  { flag: 'Iran', risk: 'Black List', prefix: '422' },
  { flag: 'Hong Kong', risk: 'Standard', prefix: '477' },
];

const SHIP_NAMES = [
  'Kaveri Spirit', 'Gulf Meridian', 'Sea Falcon', 'Nordic Aurora', 'Star Vanadis', 'Bay Trader',
  'Desert Pearl', 'Ocean Rhapsody', 'Vishwa Vijay', 'Jag Prabha', 'Al Manara', 'Pacific Emerald',
  'Coral Vanguard', 'Baltic Sunrise', 'Indus Pioneer', 'Global Sentinel', 'Nova Vega', 'Emerald Bay',
  'Sagar Shakti', 'Andaman Star', 'Malacca Dawn', 'Aurora Bay', 'Crimson Tide', 'Nautilus Prime',
  'Marina Vela', 'Blue Cascade', 'Silver Straits', 'Konkan Express', 'Bengal Runner', 'Orient Zephyr',
  'Zarina M', 'Petro Valiant', 'Cape Serenity', 'Atlantic Noor', 'Ionian Grace', '黄海 Harmony',
  'Samudra Ratna', 'Tanjung Pelepas', 'Hormuz Voyager', 'Aegean Dawn', 'Neptune Trident', 'Vasco Navigator',
  'Chola Mariner', 'Kalinga Wave', 'Malabar Breeze', 'Sunda Horizon', 'Arctic Lotus', 'Suvarna Rekha',
  'Deccan Glory', 'Persian Crest', 'Yamuna Star', 'Laccadive Pride', 'Coromandel Queen', 'Palk Sovereign',
  'Vega Fortuna', 'Ganga Sadan', 'Nicobar Trader', 'Eastern Diamond', 'Arabian Falcon', 'Trident Bay',
];

const OWNERS = [
  'Shipping Corporation of India Ltd', 'Great Eastern Shipping Co', 'Mercator Lines Pte',
  'Ocean Sovereign Maritime SA', 'Sunrise Tanker Holdings', 'Meridian Bulk Carriers Ltd',
  'Blue Horizon Shipmanagement', 'Atlas Marine Services FZE', 'Trident Navigation Ltd',
  'Crescent Maritime DMCC', 'Pearl River Shipping Co', 'Varuna Fleet Management',
  'Anchor Bay Holdings Inc', 'Seaboard Transport Group', 'Northstar Chartering SA',
];

const CLASS_SOCIETIES = ['IRS', 'DNV', 'Lloyd\'s Register', 'ABS', 'Bureau Veritas', 'ClassNK', 'RINA', 'Not classed'];
const PI_CLUBS = ['Britannia', 'Gard', 'UK P&I Club', 'Skuld', 'North of England', 'Steamship Mutual', 'None declared'];

const PORT_NAMES = [
  'Jebel Ali, AE', 'Fujairah, AE', 'Sikka, IN', 'Vadinar, IN', 'Kandla, IN', 'Mumbai (JNPT), IN',
  'Kochi, IN', 'Tuticorin, IN', 'Chennai, IN', 'Ennore, IN', 'Visakhapatnam, IN', 'Paradip, IN',
  'Haldia, IN', 'Colombo, LK', 'Port Klang, MY', 'Singapore, SG', 'Chittagong, BD', 'Yangon, MM',
  'Ras Tanura, SA', 'Kharg Island, IR', 'Basrah, IQ', 'Port Blair, IN', 'Mormugao, IN', 'New Mangalore, IN',
];

const TYPE_POOL: { type: VesselType; weight: number; loa: [number, number]; dwt: [number, number] }[] = [
  { type: 'Crude Oil Tanker', weight: 14, loa: [245, 336], dwt: [80000, 320000] },
  { type: 'Product Tanker', weight: 16, loa: [145, 228], dwt: [25000, 115000] },
  { type: 'Chemical Tanker', weight: 9, loa: [110, 183], dwt: [8000, 45000] },
  { type: 'LPG Carrier', weight: 4, loa: [160, 230], dwt: [20000, 85000] },
  { type: 'Bulk Carrier', weight: 15, loa: [180, 292], dwt: [35000, 205000] },
  { type: 'Container Ship', weight: 14, loa: [200, 366], dwt: [30000, 195000] },
  { type: 'General Cargo', weight: 10, loa: [90, 160], dwt: [5000, 32000] },
  { type: 'Fishing Vessel', weight: 8, loa: [18, 48], dwt: [80, 900] },
  { type: 'Offshore Supply', weight: 5, loa: [55, 92], dwt: [1500, 6000] },
  { type: 'Tug', weight: 2, loa: [24, 42], dwt: [200, 900] },
  { type: 'Passenger', weight: 2, loa: [95, 180], dwt: [3000, 14000] },
  { type: 'Naval / Government', weight: 1, loa: [70, 160], dwt: [1200, 9000] },
];

const SANCTIONS_LISTS = [
  'OFAC SDN (Specially Designated Nationals)',
  'EU Consolidated Sanctions List',
  'UK OFSI Consolidated List',
  'UANI Shadow Fleet Tracker',
];

function pickWeighted<T extends { weight: number }>(pool: T[], rng: () => number): T {
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = rng() * total;
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function buildFleet(count = 58, seed = 91827): Vessel[] {
  const rng = makeRng(seed);
  const vessels: Vessel[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < count; i++) {
    const spec = pickWeighted(TYPE_POOL, rng);
    const flagSpec = pick(FLAGS, rng);
    let name = pick(SHIP_NAMES, rng);
    while (usedNames.has(name)) name = `${pick(SHIP_NAMES, rng)} ${['II', 'III', 'IV', 'V'][Math.floor(rng() * 4)]}`;
    usedNames.add(name);

    const loa = Math.round(randRange(rng, spec.loa[0], spec.loa[1]));
    const dwt = Math.round(randRange(rng, spec.dwt[0], spec.dwt[1]) / 100) * 100;
    const built = 1996 + Math.floor(rng() * 28);
    const age = 2025 - built;

    // Older ships under open registries carry the poorest inspection records — the pattern the
    // registry view surfaces when it correlates flag risk against detention history.
    const riskLoad = (flagSpec.risk === 'Black List' ? 2.2 : flagSpec.risk === 'Grey List' ? 1.3 : 0.5) + age / 14;
    const detentions = rng() * riskLoad > 1.45 ? Math.floor(rng() * 3) + 1 : 0;
    const deficiencies = detentions * (2 + Math.floor(rng() * 6)) + Math.floor(rng() * 5);
    const sanctioned = flagSpec.risk === 'Black List' && rng() > 0.62;

    const isTanker = ['Crude Oil Tanker', 'Product Tanker', 'Chemical Tanker'].includes(spec.type);
    const priorOffences = isTanker && rng() * riskLoad > 1.6 ? Math.floor(rng() * 3) + 1 : rng() > 0.94 ? 1 : 0;

    const lastPort = pick(PORT_NAMES, rng);
    let nextPort = pick(PORT_NAMES, rng);
    while (nextPort === lastPort) nextPort = pick(PORT_NAMES, rng);

    vessels.push({
      mmsi: `${flagSpec.prefix}${Math.floor(100000 + rng() * 899999)}`,
      imo: `${9000000 + Math.floor(rng() * 899999)}`,
      name: name.toUpperCase(),
      callSign: `${['A', 'V', '9', '3', 'H', 'D'][Math.floor(rng() * 6)]}${Math.floor(rng() * 9)}${String.fromCharCode(65 + Math.floor(rng() * 26))}${String.fromCharCode(65 + Math.floor(rng() * 26))}${Math.floor(rng() * 9)}`,
      flag: flagSpec.flag,
      flagRisk: flagSpec.risk,
      type: spec.type,
      lengthM: loa,
      beamM: Math.round(loa / (5.4 + rng() * 1.4)),
      grossTonnage: Math.round(dwt * (0.52 + rng() * 0.22)),
      deadweightT: dwt,
      builtYear: built,
      owner: pick(OWNERS, rng),
      operator: pick(OWNERS, rng),
      classSociety: flagSpec.risk === 'Black List' && rng() > 0.6 ? 'Not classed' : pick(CLASS_SOCIETIES, rng),
      piClub: flagSpec.risk === 'Black List' && rng() > 0.5 ? 'None declared' : pick(PI_CLUBS, rng),
      lastPort,
      nextPort,
      destination: nextPort.split(',')[0].toUpperCase(),
      eta: `${10 + Math.floor(rng() * 8)} Mar 2025 ${String(Math.floor(rng() * 24)).padStart(2, '0')}:${['00', '15', '30', '45'][Math.floor(rng() * 4)]}`,
      draughtM: Number(randRange(rng, 4.5, isTanker ? 21 : 15).toFixed(1)),
      sanctioned,
      sanctionsList: sanctioned ? pick(SANCTIONS_LISTS, rng) : undefined,
      priorOffences,
      psc: {
        detentions,
        deficiencies,
        lastInspection: `${String(1 + Math.floor(rng() * 28)).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Nov', 'Dec'][Math.floor(rng() * 5)]} ${2024 + Math.floor(rng() * 2)}`,
        lastPort: pick(PORT_NAMES, rng),
      },
    });
  }
  return vessels;
}

export interface TrackOptions {
  /** Waypoints the vessel transits. */
  route: LatLon[];
  startTime: number;
  endTime: number;
  cruiseSpeedKn: number;
  /** Reporting interval in seconds. */
  intervalSec?: number;
  /** Optional deliberate AIS blackout. */
  gap?: { start: number; end: number };
  /** Optional slow-steaming episode, the signature of a discharge underway. */
  slowdown?: { start: number; end: number; speedKn: number };
  /** Optional loitering episode. */
  loiter?: { start: number; end: number };
  seed: number;
}

/**
 * Generates an AIS track along a route with realistic reporting cadence, speed jitter and
 * course noise, plus any injected anomalies. The reporting interval follows the ITU rules
 * loosely: faster ships report more often.
 */
export function buildTrack(mmsi: string, opts: TrackOptions): VesselTrack {
  const rng = makeRng(opts.seed);
  const interval = (opts.intervalSec ?? 180) * 1000;
  const pings: AisPing[] = [];

  // Cumulative route length so position can be found by distance travelled.
  const legs: { from: LatLon; to: LatLon; km: number; bearing: number }[] = [];
  let totalKm = 0;
  for (let i = 1; i < opts.route.length; i++) {
    const from = opts.route[i - 1];
    const to = opts.route[i];
    const km = haversineKm(from, to);
    legs.push({ from, to, km, bearing: bearingDeg(from, to) });
    totalKm += km;
  }
  if (!legs.length) return { mmsi, pings: [], gaps: [] };

  const durationH = (opts.endTime - opts.startTime) / 3600_000;
  const baseSpeedKn = opts.cruiseSpeedKn;

  let travelledKm = 0;
  let lastT = opts.startTime;
  let prevCog = legs[0].bearing;

  for (let t = opts.startTime; t <= opts.endTime; t += interval) {
    const dtH = (t - lastT) / 3600_000;
    lastT = t;

    let speedKn = baseSpeedKn * (0.96 + rng() * 0.08);
    let navStatus = 0; // under way using engine

    if (opts.slowdown && t >= opts.slowdown.start && t <= opts.slowdown.end) {
      speedKn = opts.slowdown.speedKn * (0.94 + rng() * 0.12);
    }
    if (opts.loiter && t >= opts.loiter.start && t <= opts.loiter.end) {
      speedKn = rng() * 1.4;
      navStatus = 1; // at anchor
    }

    travelledKm += speedKn * 1.852 * dtH;
    const clamped = Math.min(travelledKm, totalKm * 0.999);

    let acc = 0;
    let leg = legs[0];
    let legDist = 0;
    for (const l of legs) {
      if (acc + l.km >= clamped) {
        leg = l;
        legDist = clamped - acc;
        break;
      }
      acc += l.km;
      leg = l;
      legDist = l.km;
    }

    const pos = destination(leg.from, leg.bearing, legDist);
    // Small cross-track wander so the track is not a perfect rhumb line.
    const wander = (rng() - 0.5) * 0.6;
    const jittered = destination(pos, (leg.bearing + 90) % 360, wander);

    const cog = (leg.bearing + (rng() - 0.5) * 4 + 360) % 360;
    const rot = ((cog - prevCog + 540) % 360 - 180) / Math.max(dtH * 60, 1);
    prevCog = cog;

    pings.push({
      t,
      lat: Number(jittered.lat.toFixed(5)),
      lon: Number(jittered.lon.toFixed(5)),
      sog: Number(speedKn.toFixed(1)),
      cog: Number(cog.toFixed(1)),
      heading: Math.round((cog + (rng() - 0.5) * 6 + 360) % 360),
      navStatus,
      rot: Number(rot.toFixed(1)),
    });

    if (travelledKm > totalKm && durationH > 0) break;
  }

  // Apply the blackout by removing pings and recording the gap.
  const gaps: VesselTrack['gaps'] = [];
  let kept = pings;
  if (opts.gap) {
    const before = pings.filter((p) => p.t < opts.gap!.start);
    const after = pings.filter((p) => p.t > opts.gap!.end);
    if (before.length && after.length) {
      const a = before[before.length - 1];
      const b = after[0];
      const minutes = Math.round((b.t - a.t) / 60000);
      const distanceKm = haversineKm(a, b);
      gaps.push({
        start: a.t,
        end: b.t,
        minutes,
        distanceKm: Number(distanceKm.toFixed(1)),
        impliedSpeedKn: Number((distanceKm / 1.852 / (minutes / 60)).toFixed(1)),
      });
      after[0] = { ...after[0], afterGapMinutes: minutes };
    }
    kept = [...before, ...after];
  }

  // Detect any other gaps that exceed three reporting intervals.
  for (let i = 1; i < kept.length; i++) {
    const dt = kept[i].t - kept[i - 1].t;
    if (dt > interval * 3.5 && !gaps.some((g) => g.start === kept[i - 1].t)) {
      const distanceKm = haversineKm(kept[i - 1], kept[i]);
      const minutes = Math.round(dt / 60000);
      gaps.push({
        start: kept[i - 1].t,
        end: kept[i].t,
        minutes,
        distanceKm: Number(distanceKm.toFixed(1)),
        impliedSpeedKn: Number((distanceKm / 1.852 / (minutes / 60)).toFixed(1)),
      });
    }
  }

  return { mmsi, pings: kept, gaps };
}

/** Builds a route of `n` waypoints crossing near a target point at a chosen bearing. */
export function routeThrough(
  target: LatLon,
  courseDeg: number,
  lengthKm: number,
  offsetKm: number,
  bendDeg = 0
): LatLon[] {
  const offsetPoint = offsetKm === 0 ? target : destination(target, (courseDeg + 90) % 360, offsetKm);
  const start = destination(offsetPoint, (courseDeg + 180) % 360, lengthKm / 2);
  const mid = offsetPoint;
  const end = destination(offsetPoint, (courseDeg + bendDeg) % 360, lengthKm / 2);
  const quarter = destination(start, courseDeg, lengthKm / 4);
  const threeQuarter = destination(mid, (courseDeg + bendDeg / 2) % 360, lengthKm / 4);
  return [start, quarter, mid, threeQuarter, end];
}
