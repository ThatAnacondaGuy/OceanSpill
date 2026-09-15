import { destination, analysePolygon, type LatLon } from '../lib/geo';
import { hindcast, makeRng, OIL_TYPES } from '../engine/drift';
import { windAt } from '../engine/ocean';
import { buildFleet, buildTrack, routeThrough } from './fleet';
import { CORRIDORS } from './geography';
import type {
  AreaOfInterest, AuditEntry, CommunityAlert, DataSource, Detection, EnforcementAction,
  SatellitePass, SightingReport, SlickPolygon, SpillCase, SystemUser, Vessel, VesselTrack,
} from './types';

/** The demonstration clock. Everything in the dataset is positioned relative to this instant. */
export const NOW = Date.UTC(2025, 2, 12, 8, 24, 0);
const HOUR = 3600_000;

/**
 * Builds a slick polygon as a weathered trail: an elongated envelope along the discharge
 * course, widening and fragmenting downstream the way a real spreading slick does.
 */
function buildSlick(
  centre: LatLon,
  orientationDeg: number,
  lengthKm: number,
  widthKm: number,
  seed: number,
  fragmentCount = 0
): SlickPolygon {
  const rng = makeRng(seed);
  const steps = 22;
  const left: LatLon[] = [];
  const right: LatLon[] = [];
  const tailStart = destination(centre, (orientationDeg + 180) % 360, lengthKm / 2);

  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const along = destination(tailStart, orientationDeg, lengthKm * f);
    // Width tapers at the fresh end and broadens where the oil has had time to spread.
    const taper = Math.sin(Math.PI * Math.min(1, f * 1.12)) ** 0.55;
    const w = (widthKm * (0.28 + 0.72 * f) * taper) / 2;
    const jitterL = w * (0.82 + rng() * 0.4);
    const jitterR = w * (0.82 + rng() * 0.4);
    left.push(destination(along, (orientationDeg + 90) % 360, jitterL));
    right.push(destination(along, (orientationDeg + 270) % 360, jitterR));
  }

  const ring = [...left, ...right.reverse()];
  const fragments: LatLon[][] = [];
  for (let k = 0; k < fragmentCount; k++) {
    const f = 0.15 + rng() * 0.3;
    const base = destination(tailStart, (orientationDeg + 180) % 360, lengthKm * f);
    const side = destination(base, (orientationDeg + (rng() > 0.5 ? 90 : 270)) % 360, widthKm * (0.4 + rng() * 0.8));
    const r = widthKm * (0.14 + rng() * 0.2);
    const frag: LatLon[] = [];
    for (let a = 0; a < 9; a++) {
      frag.push(destination(side, (a / 9) * 360, r * (0.7 + rng() * 0.6)));
    }
    fragments.push(frag);
  }
  return { ring, fragments: fragments.length ? fragments : undefined };
}

interface Scenario {
  id: string;
  region: string;
  subRegion: string;
  centre: LatLon;
  orientationDeg: number;
  lengthKm: number;
  widthKm: number;
  fragments: number;
  acquiredHoursAgo: number;
  sensor: Detection['sensor'];
  mode: string;
  polarisation: string;
  resolutionM: number;
  incidenceAngleDeg: number;
  oilType: keyof typeof OIL_TYPES;
  volumeM3: number;
  hindcastHours: number;
  forecastHours: number;
  rawOil: number;
  rawLookalike: number;
  meanDb: number;
  bgDb: number;
  status: SpillCase['status'];
  workflowStage: SpillCase['workflowStage'];
  assignedTo: string;
  notes: string;
  /** Index into the fleet for the vessel the traffic model places on the slick axis. */
  culpritIdx: number;
  decoyIdxs: number[];
  darkVesselIdx?: number;
  lookalikeReason?: string;
  imacPushed: boolean;
  alertDispatched: boolean;
  seed: number;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'IND-OS-2025-003',
    region: 'Andaman Sea',
    subRegion: 'Andaman Sea (Offshore) — Malacca feeder lane',
    centre: { lat: 10.42, lon: 93.68 },
    orientationDeg: 118,
    lengthKm: 18.4,
    widthKm: 1.35,
    fragments: 2,
    acquiredHoursAgo: 2.17,
    sensor: 'EOS-04',
    mode: 'MRS (Mid-Resolution ScanSAR)',
    polarisation: 'VV + VH (dual-pol)',
    resolutionM: 25,
    incidenceAngleDeg: 34.2,
    oilType: 'bunkerC',
    volumeM3: 62,
    hindcastHours: 14,
    forecastHours: 48,
    rawOil: 0.913,
    rawLookalike: 0.061,
    meanDb: -21.8,
    bgDb: -9.4,
    status: 'Under Analysis',
    workflowStage: 'Awaiting Dispatch',
    assignedTo: 'A. Sharma',
    notes: 'Linear slick on the Malacca feeder lane. Geometry consistent with a discharge under way. Nearest ESA is the Mahatma Gandhi Marine National Park, 96 km west.',
    culpritIdx: 3,
    decoyIdxs: [11, 19, 27, 34],
    darkVesselIdx: 41,
    imacPushed: false,
    alertDispatched: false,
    seed: 7001,
  },
  {
    id: 'IND-OS-2025-002',
    region: 'Bay of Bengal',
    subRegion: 'East Coast — Paradip approach',
    centre: { lat: 19.94, lon: 86.42 },
    orientationDeg: 212,
    lengthKm: 11.2,
    widthKm: 1.9,
    fragments: 1,
    acquiredHoursAgo: 9.9,
    sensor: 'NISAR',
    mode: 'S-band Stripmap',
    polarisation: 'HH + HV',
    resolutionM: 12,
    incidenceAngleDeg: 38.7,
    oilType: 'crudeMedium',
    volumeM3: 128,
    hindcastHours: 18,
    forecastHours: 72,
    rawOil: 0.871,
    rawLookalike: 0.094,
    meanDb: -19.6,
    bgDb: -8.9,
    status: 'Attributed',
    workflowStage: 'Patrol En Route',
    assignedTo: 'A. Sharma',
    notes: 'Forecast drift carries the slick toward Gahirmatha Marine Sanctuary during the olive ridley arribada window. Escalated on ecological grounds.',
    culpritIdx: 7,
    decoyIdxs: [15, 22, 30],
    imacPushed: true,
    alertDispatched: true,
    seed: 7002,
  },
  {
    id: 'IND-OS-2025-001',
    region: 'Arabian Sea',
    subRegion: 'Gulf of Kachchh approach — Vadinar outbound',
    centre: { lat: 22.14, lon: 68.86 },
    orientationDeg: 254,
    lengthKm: 14.8,
    widthKm: 1.15,
    fragments: 0,
    acquiredHoursAgo: 13.65,
    sensor: 'Sentinel-1A',
    mode: 'IW (Interferometric Wide)',
    polarisation: 'VV + VH',
    resolutionM: 20,
    incidenceAngleDeg: 36.1,
    oilType: 'bilge',
    volumeM3: 34,
    hindcastHours: 12,
    forecastHours: 48,
    rawOil: 0.884,
    rawLookalike: 0.072,
    meanDb: -20.9,
    bgDb: -9.1,
    status: 'Enforcement',
    workflowStage: 'Forensic Match Pending',
    assignedTo: 'S. Iyer',
    notes: 'Outbound VLCC track from Vadinar. Tank-washing signature. Sample collected by ICG Samudra Prahari; GC-MS fingerprint comparison with the vessel slop tank is pending.',
    culpritIdx: 1,
    decoyIdxs: [9, 17, 25],
    imacPushed: true,
    alertDispatched: false,
    seed: 7003,
  },
  {
    id: 'IND-OS-2025-004',
    region: 'Lakshadweep Sea',
    subRegion: 'Nine Degree Channel — south of Minicoy',
    centre: { lat: 8.12, lon: 73.42 },
    orientationDeg: 96,
    lengthKm: 22.6,
    widthKm: 0.95,
    fragments: 3,
    acquiredHoursAgo: 25.4,
    sensor: 'Sentinel-1C',
    mode: 'IW (Interferometric Wide)',
    polarisation: 'VV + VH',
    resolutionM: 20,
    incidenceAngleDeg: 41.3,
    oilType: 'crudeHeavy',
    volumeM3: 96,
    hindcastHours: 22,
    forecastHours: 72,
    rawOil: 0.856,
    rawLookalike: 0.101,
    meanDb: -22.4,
    bgDb: -9.8,
    status: 'Under Analysis',
    workflowStage: 'Awaiting Dispatch',
    assignedTo: 'R. Das',
    notes: 'Highest-traffic tanker corridor in the Indian EEZ. No AIS track explains the slick axis — the leading hypothesis is a dark vessel operating with the transponder disabled.',
    culpritIdx: 5,
    decoyIdxs: [13, 21, 29, 36, 44],
    darkVesselIdx: 5,
    imacPushed: false,
    alertDispatched: false,
    seed: 7004,
  },
  {
    id: 'IND-OS-2025-005',
    region: 'Bay of Bengal',
    subRegion: 'South Bay of Bengal — open ocean',
    centre: { lat: 11.28, lon: 84.16 },
    orientationDeg: 62,
    lengthKm: 7.4,
    widthKm: 2.8,
    fragments: 0,
    acquiredHoursAgo: 76.2,
    sensor: 'Sentinel-1A',
    mode: 'IW (Interferometric Wide)',
    polarisation: 'VV',
    resolutionM: 20,
    incidenceAngleDeg: 33.8,
    oilType: 'marineDiesel',
    volumeM3: 11,
    hindcastHours: 10,
    forecastHours: 24,
    rawOil: 0.512,
    rawLookalike: 0.401,
    meanDb: -14.2,
    bgDb: -9.6,
    status: 'Under Analysis',
    workflowStage: 'Awaiting Dispatch',
    assignedTo: 'K. Verma',
    notes: 'Shallow damping contrast and a compact diffuse form. Wind at acquisition was near the lower detectability limit, so a low-wind cell cannot be ruled out.',
    culpritIdx: 23,
    decoyIdxs: [31, 38],
    imacPushed: false,
    alertDispatched: false,
    seed: 7005,
  },
  {
    id: 'IND-OS-2025-006',
    region: 'Arabian Sea',
    subRegion: 'Mumbai High offshore field',
    centre: { lat: 19.42, lon: 71.62 },
    orientationDeg: 148,
    lengthKm: 5.2,
    widthKm: 3.4,
    fragments: 1,
    acquiredHoursAgo: 40.1,
    sensor: 'RISAT-2BR2',
    mode: 'FRS-1 (Fine Resolution Stripmap)',
    polarisation: 'HH',
    resolutionM: 3,
    incidenceAngleDeg: 42.6,
    oilType: 'crudeMedium',
    volumeM3: 19,
    hindcastHours: 8,
    forecastHours: 36,
    rawOil: 0.742,
    rawLookalike: 0.163,
    meanDb: -18.1,
    bgDb: -9.2,
    status: 'Verified',
    workflowStage: 'Port Inspection Requested',
    assignedTo: 'S. Iyer',
    notes: 'Compact form adjacent to a production platform. Source inference favours a stationary release — produced-water discharge rather than a transiting vessel.',
    culpritIdx: 47,
    decoyIdxs: [12, 26],
    imacPushed: true,
    alertDispatched: false,
    seed: 7006,
  },
  {
    id: 'IND-OS-2025-007',
    region: 'Tamil Nadu Coast',
    subRegion: 'Ennore / Kamarajar Port approach',
    centre: { lat: 13.31, lon: 80.52 },
    orientationDeg: 185,
    lengthKm: 4.1,
    widthKm: 1.6,
    fragments: 0,
    acquiredHoursAgo: 116.8,
    sensor: 'EOS-04',
    mode: 'HRS (High-Resolution Stripmap)',
    polarisation: 'VV + VH',
    resolutionM: 9,
    incidenceAngleDeg: 30.4,
    oilType: 'lubricant',
    volumeM3: 6,
    hindcastHours: 7,
    forecastHours: 24,
    rawOil: 0.398,
    rawLookalike: 0.487,
    meanDb: -13.4,
    bgDb: -9.7,
    status: 'Dismissed — Look-alike',
    workflowStage: 'Closed',
    assignedTo: 'K. Verma',
    notes: 'Feature coincided with a documented Noctiluca scintillans bloom reported by NCCR Chennai. Reclassified as biogenic.',
    lookalikeReason: 'Biogenic surfactant film — corroborated by an NCCR Chennai algal bloom bulletin for the same 48-hour period.',
    culpritIdx: 52,
    decoyIdxs: [18],
    imacPushed: false,
    alertDispatched: false,
    seed: 7007,
  },
  {
    id: 'IND-OS-2025-008',
    region: 'Kerala Coast',
    subRegion: 'Kochi outer anchorage',
    centre: { lat: 9.82, lon: 75.88 },
    orientationDeg: 288,
    lengthKm: 9.6,
    widthKm: 1.25,
    fragments: 1,
    acquiredHoursAgo: 187.4,
    sensor: 'Sentinel-1C',
    mode: 'IW (Interferometric Wide)',
    polarisation: 'VV + VH',
    resolutionM: 20,
    incidenceAngleDeg: 37.9,
    oilType: 'bilge',
    volumeM3: 27,
    hindcastHours: 11,
    forecastHours: 36,
    rawOil: 0.902,
    rawLookalike: 0.058,
    meanDb: -21.1,
    bgDb: -9.3,
    status: 'Closed',
    workflowStage: 'Closed',
    assignedTo: 'A. Sharma',
    notes: 'Attribution confirmed by GC-MS fingerprint match against the vessel slop tank. Penalty issued by DG Shipping under s.356J of the Merchant Shipping Act.',
    culpritIdx: 9,
    decoyIdxs: [16, 33],
    imacPushed: true,
    alertDispatched: true,
    seed: 7008,
  },
];

export interface World {
  vessels: Vessel[];
  vesselsByMmsi: Map<string, Vessel>;
  tracks: Map<string, VesselTrack>;
  cases: SpillCase[];
  passes: SatellitePass[];
  aois: AreaOfInterest[];
  alerts: CommunityAlert[];
  sightings: SightingReport[];
  users: SystemUser[];
  dataSources: DataSource[];
  audit: AuditEntry[];
  enforcement: EnforcementAction[];
}

export function buildWorld(): World {
  const vessels = buildFleet(58, 91827);
  const vesselsByMmsi = new Map(vessels.map((v) => [v.mmsi, v]));
  const tracks = new Map<string, VesselTrack>();
  const cases: SpillCase[] = [];
  const rng = makeRng(555);

  for (const sc of SCENARIOS) {
    const acquiredAt = NOW - sc.acquiredHoursAgo * HOUR;
    const polygon = buildSlick(sc.centre, sc.orientationDeg, sc.lengthKm, sc.widthKm, sc.seed, sc.fragments);
    const shape = analysePolygon(polygon.ring);
    const wind = windAt(sc.centre, new Date(acquiredAt));

    const detection: Detection = {
      id: `DET-${sc.id.slice(-8)}`,
      acquiredAt,
      sensor: sc.sensor,
      mode: sc.mode,
      polarisation: sc.polarisation,
      resolutionM: sc.resolutionM,
      incidenceAngleDeg: sc.incidenceAngleDeg,
      sceneId: `${sc.sensor.replace(/[^A-Z0-9]/g, '')}_${new Date(acquiredAt).toISOString().slice(0, 10).replace(/-/g, '')}T${new Date(acquiredAt).toISOString().slice(11, 16).replace(':', '')}_${Math.floor(rng() * 9000 + 1000)}`,
      classProbabilities: {
        oil: sc.rawOil,
        lookalike: sc.rawLookalike,
        sea: Math.max(0, 1 - sc.rawOil - sc.rawLookalike),
      },
      meanBackscatterDb: sc.meanDb,
      backgroundBackscatterDb: sc.bgDb,
      windSpeedMs: Number(wind.speed.toFixed(1)),
      polygon,
      modelVersion: 'oceanwatch-seg v2.4.1',
    };

    // Hindcast now so the synthetic traffic can be placed consistently around the result.
    const hc = hindcast(shape.centroid, acquiredAt, sc.hindcastHours, {}, 12, sc.seed);

    const candidateMmsis: string[] = [];

    /**
     * Routes are built so the vessel sits at the route midpoint — the point nearest the
     * hindcast origin — at a chosen instant. Without this anchoring the vessel would reach
     * the origin at whatever time its speed happened to produce, and the temporality term
     * would score a genuinely responsible vessel near zero.
     *
     * The route is also made long enough that the track still covers the satellite
     * acquisition, so the AIS replay does not run out of positions mid-window.
     */
    const anchoredRoute = (courseDeg: number, offsetKm: number, speedKn: number, bendDeg: number) => {
      const speedKmh = speedKn * 1.852;
      const halfHours = sc.hindcastHours + 10;
      const lengthKm = 2 * speedKmh * halfHours;
      return { route: routeThrough(hc.estimatedOrigin, courseDeg, lengthKm, offsetKm, bendDeg), halfHours };
    };

    // The vessel the model will rank first: crosses the origin at the discharge time, on a
    // course aligned with the slick axis, slowing while discharging.
    const culprit = vessels[sc.culpritIdx % vessels.length];
    const isDark = sc.darkVesselIdx === sc.culpritIdx;
    const culpritSpeed = 12.4;
    const culpritRoute = anchoredRoute(sc.orientationDeg, 1.6, culpritSpeed, 6);
    const culpritStart = hc.estimatedTime - culpritRoute.halfHours * HOUR;
    const culpritTrack = buildTrack(culprit.mmsi, {
      route: culpritRoute.route,
      startTime: culpritStart,
      endTime: culpritStart + culpritRoute.halfHours * 2 * HOUR,
      cruiseSpeedKn: culpritSpeed,
      intervalSec: 180,
      slowdown: { start: hc.estimatedTime - 0.9 * HOUR, end: hc.estimatedTime + 1.1 * HOUR, speedKn: 5.8 },
      gap: isDark ? { start: hc.estimatedTime - 2.2 * HOUR, end: hc.estimatedTime + 3.4 * HOUR } : undefined,
      seed: sc.seed + 11,
    });
    tracks.set(culprit.mmsi, culpritTrack);
    candidateMmsis.push(culprit.mmsi);

    // A separate dark vessel, when the scenario has one distinct from the culprit. It passes
    // further off and on a different heading, but goes silent across the window.
    if (sc.darkVesselIdx !== undefined && sc.darkVesselIdx !== sc.culpritIdx) {
      const dark = vessels[sc.darkVesselIdx % vessels.length];
      const darkSpeed = 10.8;
      const darkRoute = anchoredRoute((sc.orientationDeg + 48) % 360, 14, darkSpeed, -8);
      const darkStart = hc.estimatedTime - darkRoute.halfHours * HOUR;
      const darkTrack = buildTrack(dark.mmsi, {
        route: darkRoute.route,
        startTime: darkStart,
        endTime: darkStart + darkRoute.halfHours * 2 * HOUR,
        cruiseSpeedKn: darkSpeed,
        intervalSec: 240,
        gap: { start: hc.estimatedTime - 1.6 * HOUR, end: hc.estimatedTime + 4.2 * HOUR },
        seed: sc.seed + 23,
      });
      tracks.set(dark.mmsi, darkTrack);
      candidateMmsis.push(dark.mmsi);
    }

    // Decoy traffic: present in the area but progressively less consistent in space, time or
    // heading, which is what the filtering and scoring stages have to separate out.
    sc.decoyIdxs.forEach((idx, k) => {
      const v = vessels[idx % vessels.length];
      const course = (sc.orientationDeg + 35 + k * 42) % 360;
      const offsetKm = 12 + k * 16;
      const speed = 9.5 + k * 1.6;
      const timeShift = (k % 2 === 0 ? 1 : -1) * (1.6 + k * 1.4) * HOUR;
      const r = anchoredRoute(course, offsetKm, speed, k % 3 === 0 ? 12 : 0);
      const start = hc.estimatedTime + timeShift - r.halfHours * HOUR;
      const t = buildTrack(v.mmsi, {
        route: r.route,
        startTime: start,
        endTime: start + r.halfHours * 2 * HOUR,
        cruiseSpeedKn: speed,
        intervalSec: 240,
        loiter: k === 1 ? { start: hc.estimatedTime + 1.2 * HOUR, end: hc.estimatedTime + 2.4 * HOUR } : undefined,
        seed: sc.seed + 41 + k * 7,
      });
      tracks.set(v.mmsi, t);
      candidateMmsis.push(v.mmsi);
    });

    const tierByConfidence = (c: number, vol: number): SpillCase['tier'] =>
      c > 0.8 && vol > 50 ? 'HIGH' : c > 0.6 ? 'MEDIUM' : 'LOW';

    cases.push({
      id: sc.id,
      detection,
      region: sc.region,
      subRegion: sc.subRegion,
      status: sc.status,
      tier: tierByConfidence(sc.rawOil, sc.volumeM3),
      confidence: sc.rawOil,
      oilType: sc.oilType,
      estimatedVolumeM3: sc.volumeM3,
      hindcastHours: sc.hindcastHours,
      forecastHours: sc.forecastHours,
      createdAt: acquiredAt + 6 * 60000,
      updatedAt: acquiredAt + 90 * 60000,
      assignedTo: sc.assignedTo,
      workflowStage: sc.workflowStage,
      candidateMmsis,
      notes: sc.notes,
      lookalikeReason: sc.lookalikeReason,
      imacPushed: sc.imacPushed,
      imacPushedAt: sc.imacPushed ? acquiredAt + 2 * HOUR : undefined,
      alertDispatched: sc.alertDispatched,
    });
  }

  // Background traffic along the corridors, unrelated to any case. This is the "irrelevant
  // traffic" the filtering stage has to remove, and it makes the traffic explorer realistic.
  let bg = 0;
  for (const corridor of CORRIDORS) {
    const perCorridor = Math.round(corridor.density / 22);
    for (let i = 0; i < perCorridor; i++) {
      const v = vessels[(bg * 7 + 13) % vessels.length];
      if (tracks.has(v.mmsi)) {
        bg++;
        continue;
      }
      const forward = i % 2 === 0;
      const route = forward ? corridor.waypoints : [...corridor.waypoints].reverse();
      const t = buildTrack(v.mmsi, {
        route,
        startTime: NOW - (30 + rng() * 20) * HOUR,
        endTime: NOW + 6 * HOUR,
        cruiseSpeedKn: 8 + rng() * 9,
        intervalSec: 300,
        gap: corridor.highRisk && rng() > 0.72 ? { start: NOW - (14 + rng() * 8) * HOUR, end: NOW - (9 + rng() * 4) * HOUR } : undefined,
        seed: 3000 + bg * 17,
      });
      tracks.set(v.mmsi, t);
      bg++;
    }
  }

  return {
    vessels,
    vesselsByMmsi,
    tracks,
    cases,
    passes: buildPasses(cases),
    aois: buildAois(),
    alerts: buildAlerts(cases),
    sightings: buildSightings(),
    users: buildUsers(),
    dataSources: buildDataSources(),
    audit: buildAudit(cases),
    enforcement: buildEnforcement(cases),
  };
}

function buildPasses(cases: SpillCase[]): SatellitePass[] {
  const rng = makeRng(8811);
  const passes: SatellitePass[] = [];
  const sensors: { name: Detection['sensor']; swath: number; periodMin: number; incl: number }[] = [
    { name: 'EOS-04', swath: 225, periodMin: 101, incl: 97.9 },
    { name: 'NISAR', swath: 240, periodMin: 98, incl: 98.4 },
    { name: 'Sentinel-1A', swath: 250, periodMin: 99, incl: 98.2 },
    { name: 'Sentinel-1C', swath: 250, periodMin: 99, incl: 98.2 },
    { name: 'RISAT-2BR2', swath: 115, periodMin: 97, incl: 37.0 },
    { name: 'Oceansat-3', swath: 1420, periodMin: 100, incl: 98.3 },
  ];

  let id = 0;
  for (const s of sensors) {
    for (let k = -14; k <= 10; k++) {
      const start = NOW + k * 5.7 * HOUR + (sensors.indexOf(s) * 47) * 60000;
      const end = start + 11 * 60000;
      // Near-polar descending ground track across the Indian Ocean region.
      const lonAtEquator = 62 + ((k * 24.6 + sensors.indexOf(s) * 13) % 40);
      const track: LatLon[] = [];
      for (let j = 0; j <= 10; j++) {
        const lat = 30 - j * 5.2;
        const drift = (30 - lat) * Math.tan(((90 - s.incl) * Math.PI) / 180) * 0.9;
        track.push({ lat, lon: lonAtEquator + drift });
      }
      const past = start < NOW;
      const detectionIds = cases
        .filter((c) => c.detection.sensor === s.name && Math.abs(c.detection.acquiredAt - start) < 3 * HOUR)
        .map((c) => c.detection.id);

      passes.push({
        id: `PASS-${String(++id).padStart(4, '0')}`,
        sensor: s.name,
        start,
        end,
        track,
        swathKm: s.swath,
        status: !past ? 'Scheduled' : detectionIds.length ? 'Processed' : rng() > 0.12 ? 'Processed' : rng() > 0.5 ? 'Downlinked' : 'Failed',
        orbitNumber: 48210 + k * 15 + sensors.indexOf(s) * 3,
        detectionIds,
        cloudCoverPct: s.name === 'Oceansat-3' ? Math.round(rng() * 90) : undefined,
        taskedAoi: rng() > 0.6 ? ['AOI-9DEG', 'AOI-KUTCH', 'AOI-PARADIP', 'AOI-ANDAMAN'][Math.floor(rng() * 4)] : undefined,
      });
    }
  }
  return passes.sort((a, b) => a.start - b.start);
}

function buildAois(): AreaOfInterest[] {
  return [
    {
      id: 'AOI-9DEG', name: 'Nine Degree Channel Corridor', priority: 1,
      bounds: { north: 10.2, south: 6.4, east: 76.5, west: 70.5 },
      hitRate: 14.2, lastCovered: NOW - 5.2 * HOUR, pinned: true,
      rationale: 'Highest tanker throughput in the Indian EEZ with a persistent cluster of AIS gaps south of Minicoy. Four detections in the last 90 days.',
      requestedBy: 'NTRO Reviewer',
    },
    {
      id: 'AOI-KUTCH', name: 'Gulf of Kachchh / Vadinar Approach', priority: 2,
      bounds: { north: 23.2, south: 21.4, east: 70.6, west: 67.8 },
      hitRate: 11.8, lastCovered: NOW - 11.4 * HOUR, pinned: true,
      rationale: 'VLCC discharge terminal. Outbound tank-washing pattern recurs on the ebb. Adjacent to a category-5 marine national park.',
      requestedBy: 'NTRO Reviewer',
    },
    {
      id: 'AOI-PARADIP', name: 'Paradip – Gahirmatha Coastal Run', priority: 3,
      bounds: { north: 21.3, south: 19.2, east: 88.2, west: 85.6 },
      hitRate: 9.6, lastCovered: NOW - 3.1 * HOUR, pinned: true,
      rationale: 'Coastal lane passing within 25 km of the world\'s largest olive ridley rookery during the arribada window.',
      requestedBy: 'Indian Coast Guard',
    },
    {
      id: 'AOI-ANDAMAN', name: 'Andaman Sea Malacca Feeder', priority: 4,
      bounds: { north: 14.2, south: 6.2, east: 95.6, west: 91.4 },
      hitRate: 8.1, lastCovered: NOW - 2.2 * HOUR, pinned: false,
      rationale: 'Dense Malacca-bound traffic crossing a sparsely monitored stretch of the Andaman EEZ.',
      requestedBy: 'Analyst',
    },
    {
      id: 'AOI-MUMBAI', name: 'Mumbai High Offshore Field', priority: 5,
      bounds: { north: 20.4, south: 18.6, east: 72.8, west: 70.4 },
      hitRate: 6.4, lastCovered: NOW - 18.6 * HOUR, pinned: false,
      rationale: 'Platform-supply traffic and produced-water discharge generate frequent low-volume sheens requiring discrimination from vessel-source spills.',
      requestedBy: 'Analyst',
    },
    {
      id: 'AOI-MANNAR', name: 'Gulf of Mannar Reef Belt', priority: 6,
      bounds: { north: 9.6, south: 8.2, east: 79.6, west: 77.8 },
      hitRate: 4.2, lastCovered: NOW - 29.8 * HOUR, pinned: false,
      rationale: 'Category-5 coral and seagrass habitat. Low traffic density but very high consequence per event.',
      requestedBy: 'MoEFCC',
    },
    {
      id: 'AOI-SUNDAR', name: 'Sundarbans Approach / Haldia Lane', priority: 7,
      bounds: { north: 22.4, south: 20.8, east: 89.4, west: 87.6 },
      hitRate: 5.8, lastCovered: NOW - 36.2 * HOUR, pinned: false,
      rationale: 'Riverine tanker traffic to Haldia transiting the mangrove delta; high sediment backscatter complicates segmentation.',
      requestedBy: 'MoEFCC',
    },
  ];
}

function buildAlerts(cases: SpillCase[]): CommunityAlert[] {
  const c2 = cases.find((c) => c.id === 'IND-OS-2025-002')!;
  const c8 = cases.find((c) => c.id === 'IND-OS-2025-008')!;
  return [
    {
      id: 'ALT-2025-0042',
      caseId: c2.id,
      issuedAt: c2.detection.acquiredAt + 2.4 * HOUR,
      channel: ['SMS', 'WhatsApp', 'Community Radio'],
      languages: ['Odia', 'Hindi', 'English'],
      districts: ['Kendrapara', 'Jagatsinghpur', 'Bhadrak'],
      headline: 'Oil slick advisory — Paradip offshore waters',
      body: 'An oil slick has been detected approximately 42 km offshore of Paradip, drifting west-southwest. Fishing craft are advised to avoid the marked area for the next 48 hours. Do not handle floating oil. Report sightings to the nearest Coast Guard station or through the SAMUDRA app.',
      noGoRadiusKm: 18,
      centre: { lat: 19.94, lon: 86.42 },
      validUntil: c2.detection.acquiredAt + 50 * HOUR,
      status: 'Dispatched',
      reach: [
        { channel: 'SMS', sent: 14820, delivered: 14106, failed: 714 },
        { channel: 'WhatsApp', sent: 8940, delivered: 8611, failed: 329 },
        { channel: 'Community Radio', sent: 6, delivered: 6, failed: 0 },
      ],
    },
    {
      id: 'ALT-2025-0038',
      caseId: c8.id,
      issuedAt: c8.detection.acquiredAt + 3.1 * HOUR,
      channel: ['SMS', 'WhatsApp', 'App Push'],
      languages: ['Malayalam', 'English'],
      districts: ['Ernakulam', 'Thrissur', 'Alappuzha'],
      headline: 'Oil sheen advisory — Kochi outer anchorage',
      body: 'A thin oil sheen has been observed near the Kochi outer anchorage. Fishing operations within the marked 12 km zone should be suspended until further notice. Nets exposed to oil must not be reused without cleaning.',
      noGoRadiusKm: 12,
      centre: { lat: 9.82, lon: 75.88 },
      validUntil: c8.detection.acquiredAt + 36 * HOUR,
      status: 'Expired',
      reach: [
        { channel: 'SMS', sent: 9610, delivered: 9188, failed: 422 },
        { channel: 'WhatsApp', sent: 5240, delivered: 5061, failed: 179 },
        { channel: 'App Push', sent: 3180, delivered: 2904, failed: 276 },
      ],
    },
  ];
}

function buildSightings(): SightingReport[] {
  const base: Omit<SightingReport, 'id'>[] = [
    {
      receivedAt: NOW - 3.2 * HOUR, reporter: 'B. Behera', boatRegistration: 'OD-KDP-1842', district: 'Kendrapara',
      position: { lat: 20.12, lon: 86.71 }, description: 'Thick brown patches floating about 3 nautical miles from our net line. Strong smell of fuel. Nets came up stained.',
      severity: 'Heavy Oil', photos: 4, linkedCaseId: 'IND-OS-2025-002', verified: true, language: 'Odia',
    },
    {
      receivedAt: NOW - 5.8 * HOUR, reporter: 'S. Mallick', boatRegistration: 'OD-JGS-0937', district: 'Jagatsinghpur',
      position: { lat: 19.88, lon: 86.55 }, description: 'Rainbow-coloured film on the water over a wide area. No smell.',
      severity: 'Sheen', photos: 2, linkedCaseId: 'IND-OS-2025-002', verified: true, language: 'Odia',
    },
    {
      receivedAt: NOW - 14.6 * HOUR, reporter: 'M. Kunhikannan', boatRegistration: 'KL-ERN-4471', district: 'Ernakulam',
      position: { lat: 9.79, lon: 76.02 }, description: 'Black lumps washing up near the shore this morning, sticky to touch.',
      severity: 'Tar Balls', photos: 6, verified: false, language: 'Malayalam',
    },
    {
      receivedAt: NOW - 22.1 * HOUR, reporter: 'A. Fernandes', boatRegistration: 'MH-RTG-2208', district: 'Ratnagiri',
      position: { lat: 17.02, lon: 73.11 }, description: 'Patchy oil seen while returning at dawn. Two dead fish observed nearby but cannot confirm the cause.',
      severity: 'Patchy Oil', photos: 1, verified: false, language: 'Marathi',
    },
    {
      receivedAt: NOW - 31.4 * HOUR, reporter: 'R. Murugan', boatRegistration: 'TN-NGP-5590', district: 'Nagapattinam',
      position: { lat: 10.81, lon: 79.92 }, description: 'Large number of dead fish floating. Water looks discoloured but no oil smell.',
      severity: 'Dead Fish', photos: 3, verified: false, language: 'Tamil',
    },
    {
      receivedAt: NOW - 46.9 * HOUR, reporter: 'P. Das', boatRegistration: 'WB-SUN-1123', district: 'South 24 Parganas',
      position: { lat: 21.68, lon: 88.42 }, description: 'Oily film along the channel edge near the mangrove roots.',
      severity: 'Sheen', photos: 2, verified: true, language: 'Bengali',
    },
    {
      receivedAt: NOW - 61.2 * HOUR, reporter: 'V. Solanki', boatRegistration: 'GJ-JAM-3377', district: 'Jamnagar',
      position: { lat: 22.28, lon: 69.31 }, description: 'Dark slick visible from the boat, roughly a kilometre long, drifting toward the reef.',
      severity: 'Heavy Oil', photos: 5, linkedCaseId: 'IND-OS-2025-001', verified: true, language: 'Gujarati',
    },
    {
      receivedAt: NOW - 79.5 * HOUR, reporter: 'K. Ramesh', boatRegistration: 'AP-VSK-8814', district: 'Visakhapatnam',
      position: { lat: 17.58, lon: 83.42 }, description: 'Thin sheen near the anchorage, visible only in the sun.',
      severity: 'Sheen', photos: 1, verified: false, language: 'Telugu',
    },
  ];
  return base.map((s, i) => ({ ...s, id: `SR-2025-${String(1201 + i * 7).padStart(4, '0')}` }));
}

function buildUsers(): SystemUser[] {
  return [
    { id: 'U-001', name: 'Dr. R. Menon', email: 'rmenon@ntro.gov.in', role: 'NTRO Admin', agency: 'NTRO', status: 'Active', lastLogin: NOW - 0.43 * HOUR, mfa: true, clearance: 'Secret' },
    { id: 'U-002', name: 'S. Iyer', email: 'siyer@ntro.gov.in', role: 'NTRO Reviewer', agency: 'NTRO', status: 'Active', lastLogin: NOW - 2.2 * HOUR, mfa: true, clearance: 'Secret' },
    { id: 'U-003', name: 'A. Sharma', email: 'asharma@indiancoastguard.gov.in', role: 'Analyst', agency: 'Indian Coast Guard', status: 'Active', lastLogin: NOW - 2.62 * HOUR, mfa: true, clearance: 'Confidential' },
    { id: 'U-004', name: 'P. Nair', email: 'pnair@dgshipping.gov.in', role: 'Regulator', agency: 'DG Shipping', status: 'Active', lastLogin: NOW - 18.1 * HOUR, mfa: true, clearance: 'Confidential' },
    { id: 'U-005', name: 'K. Verma', email: 'kverma@moefcc.gov.in', role: 'Viewer', agency: 'MoEFCC', status: 'Active', lastLogin: NOW - 21.4 * HOUR, mfa: false, clearance: 'Restricted' },
    { id: 'U-006', name: 'R. Das', email: 'rdas@incois.gov.in', role: 'Data Operator', agency: 'INCOIS', status: 'Active', lastLogin: NOW - 44.2 * HOUR, mfa: true, clearance: 'Restricted' },
    { id: 'U-007', name: 'Cdr. V. Pillai', email: 'vpillai@indiannavy.gov.in', role: 'Liaison', agency: 'Indian Navy (IMAC)', status: 'Active', lastLogin: NOW - 6.8 * HOUR, mfa: true, clearance: 'Secret' },
    { id: 'U-008', name: 'M. Chandrasekhar', email: 'mchandra@ncscm.res.in', role: 'Viewer', agency: 'NCSCM', status: 'Active', lastLogin: NOW - 96.3 * HOUR, mfa: false, clearance: 'Restricted' },
    { id: 'U-009', name: 'T. Ghosh', email: 'tghosh@ntro.gov.in', role: 'Analyst', agency: 'NTRO', status: 'Suspended', lastLogin: NOW - 720 * HOUR, mfa: true, clearance: 'Confidential' },
    { id: 'U-010', name: 'J. Abraham', email: 'jabraham@dgshipping.gov.in', role: 'Regulator', agency: 'DG Shipping', status: 'Pending', lastLogin: 0, mfa: false, clearance: 'Restricted' },
  ];
}

function buildDataSources(): DataSource[] {
  return [
    { id: 'DS-EOS4', name: 'EOS-04 SAR Archive', kind: 'Satellite', endpoint: 'https://bhoonidhi.nrsc.gov.in/api/v2/eos04', status: 'Online', latencyMs: 412, lastSync: NOW - 0.12 * HOUR, recordsPerMin: 0.4, provider: 'NRSC / Bhoonidhi', authMode: 'OAuth2 client credentials', quotaUsedPct: 38 },
    { id: 'DS-NISAR', name: 'NISAR L-band Product Feed', kind: 'Satellite', endpoint: 'https://bhoonidhi.nrsc.gov.in/api/v2/nisar', status: 'Online', latencyMs: 508, lastSync: NOW - 0.33 * HOUR, recordsPerMin: 0.3, provider: 'ISRO / NASA', authMode: 'OAuth2 client credentials', quotaUsedPct: 21 },
    { id: 'DS-S1', name: 'Copernicus Sentinel-1 SciHub', kind: 'Satellite', endpoint: 'https://catalogue.dataspace.copernicus.eu/odata/v1', status: 'Online', latencyMs: 1240, lastSync: NOW - 0.68 * HOUR, recordsPerMin: 0.9, provider: 'ESA Copernicus', authMode: 'API key', quotaUsedPct: 64 },
    { id: 'DS-INCOIS-OC', name: 'INCOIS Ocean Currents (HOOFS)', kind: 'Ocean Model', endpoint: 'https://incois.gov.in/services/hoofs/currents', status: 'Online', latencyMs: 286, lastSync: NOW - 0.15 * HOUR, recordsPerMin: 12, provider: 'INCOIS Hyderabad', authMode: 'Institutional token', quotaUsedPct: 44 },
    { id: 'DS-INCOIS-WV', name: 'INCOIS Wave & Sea State', kind: 'Ocean Model', endpoint: 'https://incois.gov.in/services/waves', status: 'Degraded', latencyMs: 3820, lastSync: NOW - 2.9 * HOUR, recordsPerMin: 4, provider: 'INCOIS Hyderabad', authMode: 'Institutional token', quotaUsedPct: 71 },
    { id: 'DS-IMD', name: 'IMD Wind Forecast Grid', kind: 'Meteorology', endpoint: 'https://mausam.imd.gov.in/api/wind', status: 'Online', latencyMs: 640, lastSync: NOW - 0.22 * HOUR, recordsPerMin: 8, provider: 'India Meteorological Department', authMode: 'API key', quotaUsedPct: 33 },
    { id: 'DS-AIS-TER', name: 'Terrestrial AIS Network', kind: 'AIS', endpoint: 'tcp://ais-gateway.dgshipping.gov.in:4001', status: 'Online', latencyMs: 92, lastSync: NOW - 0.01 * HOUR, recordsPerMin: 1842, provider: 'DG Shipping coastal chain', authMode: 'mTLS', quotaUsedPct: 58 },
    { id: 'DS-AIS-SAT', name: 'Satellite AIS (S-AIS)', kind: 'AIS', endpoint: 'https://sais.provider.gov.in/stream/v3', status: 'Online', latencyMs: 2140, lastSync: NOW - 0.08 * HOUR, recordsPerMin: 684, provider: 'Commercial S-AIS', authMode: 'Bearer token', quotaUsedPct: 82 },
    { id: 'DS-REG', name: 'IMO / Equasis Vessel Registry', kind: 'Registry', endpoint: 'https://api.equasis.org/v1/vessel', status: 'Online', latencyMs: 880, lastSync: NOW - 4.2 * HOUR, recordsPerMin: 2, provider: 'Equasis', authMode: 'API key', quotaUsedPct: 12 },
    { id: 'DS-SANC', name: 'Sanctions Watchlist Aggregator', kind: 'Registry', endpoint: 'https://api.opensanctions.org/match/default', status: 'Online', latencyMs: 520, lastSync: NOW - 7.8 * HOUR, recordsPerMin: 1, provider: 'OpenSanctions', authMode: 'API key', quotaUsedPct: 6 },
    { id: 'DS-SACHET', name: 'SACHET / NDMA Alert Gateway', kind: 'Alerting', endpoint: 'https://sachet.ndma.gov.in/cap/v1/publish', status: 'Online', latencyMs: 340, lastSync: NOW - 12.4 * HOUR, recordsPerMin: 0, provider: 'NDMA', authMode: 'Signed CAP payload', quotaUsedPct: 3 },
    { id: 'DS-IMAC', name: 'IMAC Common Operating Picture', kind: 'Alerting', endpoint: 'https://imac.navy.gov.in/cop/ingest', status: 'Online', latencyMs: 176, lastSync: NOW - 1.9 * HOUR, recordsPerMin: 0, provider: 'Indian Navy IMAC, Gurugram', authMode: 'mTLS + signed payload', quotaUsedPct: 2 },
  ];
}

function buildAudit(cases: SpillCase[]): AuditEntry[] {
  const out: AuditEntry[] = [];
  let n = 0;
  const add = (t: number, actor: string, role: string, action: string, target: string, detail: string, category: AuditEntry['category']) => {
    out.push({ id: `AUD-${String(++n).padStart(5, '0')}`, t, actor, role, action, target, detail, category });
  };

  for (const c of cases) {
    add(c.detection.acquiredAt, 'system', 'Automated', 'Scene acquired', c.detection.sceneId, `${c.detection.sensor} ${c.detection.mode}, ${c.detection.polarisation}`, 'Detection');
    add(c.createdAt, 'oceanwatch-seg v2.4.1', 'Model', 'Detection raised', c.id, `Segmentation produced oil probability ${(c.detection.classProbabilities.oil * 100).toFixed(1)}%`, 'Detection');
    add(c.createdAt + 12 * 60000, c.assignedTo, 'Analyst', 'Case opened', c.id, `Assigned to ${c.assignedTo}`, 'Analysis');
    add(c.createdAt + 26 * 60000, 'drift-engine', 'Model', 'Hindcast executed', c.id, `${c.hindcastHours} h backward run, 12-member ensemble`, 'Analysis');
    if (c.status !== 'New' && c.status !== 'Dismissed — Look-alike') {
      add(c.createdAt + 41 * 60000, 'attribution-engine', 'Model', 'Candidates scored', c.id, `${c.candidateMmsis.length} vessels evaluated against the discharge window`, 'Attribution');
    }
    if (c.lookalikeReason) {
      add(c.updatedAt, c.assignedTo, 'Analyst', 'Reclassified as look-alike', c.id, c.lookalikeReason, 'Analysis');
    }
    if (c.imacPushed && c.imacPushedAt) {
      add(c.imacPushedAt, 'S. Iyer', 'NTRO Reviewer', 'Pushed to IMAC', c.id, 'Case record published to the common operating picture', 'Dispatch');
    }
    if (c.alertDispatched) {
      add(c.detection.acquiredAt + 2.4 * HOUR, 'A. Sharma', 'Analyst', 'Community alert dispatched', c.id, 'SACHET multi-channel advisory issued to coastal districts', 'Alert');
    }
    if (c.workflowStage === 'Patrol En Route' || c.workflowStage === 'Sample Collected' || c.workflowStage === 'Forensic Match Pending' || c.workflowStage === 'Port Inspection Requested') {
      add(c.updatedAt + 30 * 60000, 'Cdr. V. Pillai', 'Liaison', 'Verification dispatched', c.id, 'ICG asset tasked for on-scene confirmation and sampling', 'Dispatch');
    }
    if (c.status === 'Enforcement' || c.status === 'Closed') {
      add(c.updatedAt + 4 * HOUR, 'P. Nair', 'Regulator', 'Enforcement initiated', c.id, 'Referred to DG Shipping under the Merchant Shipping Act', 'Enforcement');
    }
  }

  add(NOW - 0.43 * HOUR, 'Dr. R. Menon', 'NTRO Admin', 'Signed in', 'session', 'MFA verified, source 10.24.x.x', 'Access');
  add(NOW - 2.2 * HOUR, 'S. Iyer', 'NTRO Reviewer', 'Signed in', 'session', 'MFA verified', 'Access');
  add(NOW - 0.15 * HOUR, 'system', 'Automated', 'Ocean forcing refreshed', 'DS-INCOIS-OC', 'HOOFS current field updated to the 06Z cycle', 'System');
  add(NOW - 2.9 * HOUR, 'system', 'Automated', 'Data source degraded', 'DS-INCOIS-WV', 'Wave service latency exceeded 3 s threshold', 'System');
  add(NOW - 720 * HOUR, 'Dr. R. Menon', 'NTRO Admin', 'Account suspended', 'U-009', 'Suspended pending periodic clearance revalidation', 'Access');

  return out.sort((a, b) => b.t - a.t);
}

function buildEnforcement(cases: SpillCase[]): EnforcementAction[] {
  const c1 = cases.find((c) => c.id === 'IND-OS-2025-001')!;
  const c6 = cases.find((c) => c.id === 'IND-OS-2025-006')!;
  const c8 = cases.find((c) => c.id === 'IND-OS-2025-008')!;
  return [
    {
      id: 'ENF-2025-0011', caseId: c1.id, mmsi: c1.candidateMmsis[0], type: 'Inspection Ordered',
      issuedAt: c1.updatedAt + 4 * HOUR, authority: 'DG Shipping — Mercantile Marine Department, Mumbai',
      reference: 'MMD/MUM/POL/2025/0114', status: 'Served',
      outcome: 'Slop tank sampled at Sikka. GC-MS comparison with the on-scene sample in progress at NIO Goa.',
    },
    {
      id: 'ENF-2025-0009', caseId: c6.id, mmsi: c6.candidateMmsis[0], type: 'Inspection Ordered',
      issuedAt: c6.updatedAt + 6 * HOUR, authority: 'DG Shipping — Mercantile Marine Department, Mumbai',
      reference: 'MMD/MUM/POL/2025/0109', status: 'Pending',
      outcome: 'Awaiting the vessel\'s next Indian port call.',
    },
    {
      id: 'ENF-2025-0004', caseId: c8.id, mmsi: c8.candidateMmsis[0], type: 'Fine Issued',
      issuedAt: c8.updatedAt + 96 * HOUR, authority: 'DG Shipping', reference: 'DGS/ENF/2025/0037',
      amountInr: 4200000, status: 'Concluded',
      outcome: 'Penalty under s.356J of the Merchant Shipping Act 1958. Paid in full. Forensic fingerprint match confirmed at 0.94 similarity.',
    },
    {
      id: 'ENF-2025-0003', caseId: c8.id, mmsi: c8.candidateMmsis[0], type: 'Insurance Flagged',
      issuedAt: c8.updatedAt + 100 * HOUR, authority: 'DG Shipping → P&I Club notification',
      reference: 'DGS/INS/2025/0018', status: 'Concluded',
      outcome: 'P&I club notified of the confirmed pollution event for cover review.',
    },
  ];
}
