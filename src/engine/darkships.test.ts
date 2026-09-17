import { describe, expect, it } from 'vitest';
import { darkShipSummary, findDarkShips, MATCH_RADIUS_KM } from './darkships';
import type { RadarVessel, SarMeasurement, VesselTrack } from '../data/types';

const T0 = Date.UTC(2017, 0, 29, 0, 31, 32);

function track(mmsi: string, lat: number, lon: number): VesselTrack {
  return {
    mmsi,
    provenance: 'real',
    notes: [],
    gaps: [],
    pings: [
      { t: T0 - 3600_000, lat, lon, sog: 8, cog: 90, heading: 90, navStatus: 0 },
      { t: T0 + 3600_000, lat, lon, sog: 8, cog: 90, heading: 90, navStatus: 0 },
    ],
  };
}

function radarVessel(lat: number, lon: number): RadarVessel {
  return { position: { lat, lon }, pixels: 30, lengthM: 180, widthM: 30, confidence: 0.8, distanceKm: 5 };
}

function measurement(vessels: SarMeasurement['vessels'], unavailable: string | null = null): SarMeasurement {
  return {
    schemaVersion: 1, caseId: 'C', scene: 'S', processedAt: '', polarisation: 'VV', method: 'm',
    parameters: {}, crop: { corners: [], shape: [1, 1] }, incidenceDeg: 30,
    sea: { meanDb: null, stdDb: null, pixels: 0 }, quicklook: '', spots: [], limitations: [],
    vessels, vesselsUnavailable: unavailable,
  } as SarMeasurement;
}

describe('dark ships', () => {
  it('calls a radar target dark when no AIS track is near it', () => {
    const tracks = new Map([['A', track('A', 13.0, 80.0)]]);
    const result = findDarkShips(measurement([radarVessel(13.5, 80.5)]), tracks, T0)!;
    expect(result.dark).toHaveLength(1);
    expect(result.matched).toHaveLength(0);
  });

  it('matches a radar target to a vessel that was transmitting nearby', () => {
    const tracks = new Map([['A', track('A', 13.0, 80.0)]]);
    // About 500 m away: inside the match radius, because a hull is not a point and AIS lags.
    const result = findDarkShips(measurement([radarVessel(13.0045, 80.0)]), tracks, T0)!;
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].key).toBe('A');
    expect(result.matched[0].separationKm).toBeLessThan(MATCH_RADIUS_KM);
    expect(result.dark).toHaveLength(0);
  });

  it('refuses to judge when no AIS track covers the scene time', () => {
    // A track that ends long before the satellite passed cannot exonerate anything.
    const stale = new Map([['A', track('A', 13.0, 80.0)]]);
    expect(findDarkShips(measurement([radarVessel(13.0, 80.0)]), stale, T0 + 86_400_000)).toBeNull();
  });

  it('says nobody looked, rather than that nothing was found', () => {
    const noDetector = measurement(undefined);
    expect(darkShipSummary(null, noDetector)).toMatch(/No vessel detection was run/);
    const tooCoarse = measurement(null, 'vessel detection needs pixels of 30 m or finer');
    expect(darkShipSummary(null, tooCoarse)).toMatch(/30 m or finer/);
  });

  it('will not call a target dark when there was nothing to compare it against', () => {
    const summary = darkShipSummary(null, measurement([radarVessel(13.0, 80.0)]));
    expect(summary).toMatch(/none of them can be called dark/);
  });

  it('reports plainly when every radar target was transmitting', () => {
    const tracks = new Map([['A', track('A', 13.0, 80.0)]]);
    const result = findDarkShips(measurement([radarVessel(13.0, 80.0)]), tracks, T0)!;
    expect(darkShipSummary(result, measurement([radarVessel(13.0, 80.0)]))).toMatch(/all of them transmitting/);
  });
});
