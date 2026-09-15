/**
 * The ranking is a prioritisation tool, not proof. These tests pin the properties that make it
 * defensible: a vessel that was there when the oil was released outranks one that was not, response
 * and state vessels are set aside rather than accused, and every exclusion carries a reason.
 */
import { describe, expect, it } from 'vitest';
import { attributionVerdict, interpolateTrack, isDarkAt, scoreCandidates, searchRadiusKm } from './attribution';
import type { CandidateInput, ScoringContext } from './attribution';
import type { AisPing, Vessel, VesselTrack } from '../data/types';

const ORIGIN = { lat: 9.2, lon: 76.1 };
const T0 = Date.UTC(2025, 4, 24, 12, 0);
const HOUR = 3600_000;

const CONTEXT: ScoringContext = {
  origin: ORIGIN,
  originTime: T0,
  windowHours: 3,
  uncertaintyKm: 5,
  slickOrientationDeg: 90,
  slickElongation: 6,
};

function vessel(over: Partial<Vessel> = {}): Vessel {
  return {
    mmsi: 'MMSI-111111111', mmsiNumber: '111111111', imo: null, name: 'TEST TRADER', flag: 'India',
    flagRisk: null, type: 'Cargo', operator: null, role: 'candidate', provenance: 'real', isFacility: false,
    registryVerified: false, priorOffences: 0, sanctioned: false, sanctionsChecked: true, pscDetentions: 0,
    registrySource: null, registryDetails: null, note: null, caseId: 'TEST', anchors: [],
    ...over,
  } as Vessel;
}

function ping(t: number, lat: number, lon: number, over: Partial<AisPing> = {}): AisPing {
  return { t, lat, lon, sog: 11, cog: 90, heading: 90, navStatus: 0, ...over };
}

/** A track running due east through `lat`, passing the given longitude at T0. */
function track(mmsi: string, lat: number, lonAtT0: number, over: Partial<VesselTrack> = {}): VesselTrack {
  const pings: AisPing[] = [];
  for (let h = -6; h <= 6; h++) pings.push(ping(T0 + h * HOUR, lat, lonAtT0 + h * 0.12));
  return { mmsi, provenance: 'real', notes: [], pings, gaps: [], ...over };
}

function candidates(...items: CandidateInput[]): CandidateInput[] {
  return items;
}

describe('candidate search', () => {
  it('widens the search when the origin is less certain', () => {
    expect(searchRadiusKm(20)).toBeGreaterThan(searchRadiusKm(2));
    expect(searchRadiusKm(0)).toBeGreaterThanOrEqual(35);
  });

  it('interpolates a position between pings and refuses to guess outside the track', () => {
    const t = track('MMSI-111111111', 9.2, 76.1);
    const midway = interpolateTrack(t, T0 + HOUR / 2);
    expect(midway).not.toBeNull();
    expect(midway!.lon).toBeGreaterThan(76.1);
    expect(midway!.lon).toBeLessThan(76.1 + 0.12);
    expect(interpolateTrack(t, T0 + 48 * HOUR)).toBeNull();
  });

  it('knows when a vessel stopped transmitting', () => {
    const t = track('MMSI-111111111', 9.2, 76.1);
    t.gaps = [{ start: T0 - HOUR, end: T0 + HOUR, minutes: 120 } as VesselTrack['gaps'][number]];
    expect(isDarkAt(t, T0)).toBe(true);
    expect(isDarkAt(t, T0 + 4 * HOUR)).toBe(false);
  });
});

describe('ranking', () => {
  it('puts the vessel that was at the origin ahead of one that passed far away', () => {
    const near = { vessel: vessel({ mmsi: 'MMSI-1', name: 'NEAR TRADER' }), track: track('MMSI-1', 9.2, 76.1) };
    const far = { vessel: vessel({ mmsi: 'MMSI-2', name: 'FAR TRADER' }), track: track('MMSI-2', 9.45, 76.1) };
    const { ranked } = scoreCandidates(candidates(near, far), CONTEXT);
    expect(ranked[0].mmsi).toBe('MMSI-1');
    expect(ranked[0].total).toBeGreaterThan(ranked[1]?.total ?? 0);
    expect(ranked[0].cpaKm).toBeLessThan(ranked[1]?.cpaKm ?? Infinity);
  });

  it('sets response and state vessels aside with a reason instead of ranking them', () => {
    const responder = { vessel: vessel({ mmsi: 'MMSI-3', name: 'MSC SILVER III', role: 'responder' }), track: track('MMSI-3', 9.2, 76.1) };
    const patrol = { vessel: vessel({ mmsi: 'MMSI-4', name: 'ICGS SAMARTH' }), track: track('MMSI-4', 9.2, 76.1) };
    const { ranked, excluded } = scoreCandidates(candidates(responder, patrol), CONTEXT);
    expect(ranked).toHaveLength(0);
    expect(excluded).toHaveLength(2);
    for (const e of excluded) expect(e.reason.length).toBeGreaterThan(10);
  });

  it('gives every score the reasons behind it', () => {
    const near = { vessel: vessel({ mmsi: 'MMSI-1' }), track: track('MMSI-1', 9.2, 76.1) };
    const { ranked } = scoreCandidates(candidates(near), CONTEXT);
    expect(ranked[0].reasons.length).toBeGreaterThan(0);
    expect(ranked[0].total).toBeGreaterThan(0);
    expect(ranked[0].total).toBeLessThanOrEqual(1);
  });

  it('rewards a course that runs along the slick over one that cuts across it', () => {
    const along = { vessel: vessel({ mmsi: 'MMSI-5' }), track: track('MMSI-5', 9.2, 76.1) };
    const acrossPings: AisPing[] = [];
    for (let h = -6; h <= 6; h++) acrossPings.push(ping(T0 + h * HOUR, 9.2 + h * 0.1, 76.1, { cog: 0, heading: 0 }));
    const across = {
      vessel: vessel({ mmsi: 'MMSI-6' }),
      track: { mmsi: 'MMSI-6', provenance: 'real', notes: [], pings: acrossPings, gaps: [] } as VesselTrack,
    };
    const { ranked } = scoreCandidates(candidates(along, across), CONTEXT);
    const alongScore = ranked.find((r) => r.mmsi === 'MMSI-5');
    const acrossScore = ranked.find((r) => r.mmsi === 'MMSI-6');
    expect(alongScore!.trajectory).toBeGreaterThan(acrossScore!.trajectory);
  });
});

describe('verdict', () => {
  it('says so plainly when no traffic was transmitting', () => {
    const verdict = attributionVerdict([]);
    expect(verdict.band).toBe('Inconclusive');
    expect(verdict.detail).toContain('dark-vessel');
  });

  it('calls a clear leader strong and a close pair weaker', () => {
    const scores = (totals: number[]) => totals.map((total, i) => ({ mmsi: `MMSI-${i}`, total } as never));
    expect(attributionVerdict(scores([0.82, 0.4])).band).toBe('Strong');
    const close = attributionVerdict(scores([0.78, 0.76]));
    expect(close.band).not.toBe('Strong');
    expect(close.separation).toBeLessThan(0.05);
  });
});
