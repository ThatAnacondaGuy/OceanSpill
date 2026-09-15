import { describe, expect, it } from 'vitest';
import {
  analysePolygon, angularDiff, axialDiff, bearingDeg, closestApproach, destination, distanceToSegmentKm,
  formatBearing, formatLatLon, haversineKm, offsetKm, pointInPolygon, polygonAreaKm2,
} from './geo';

const KOCHI = { lat: 9.965, lon: 76.255 };
const CHENNAI = { lat: 13.082, lon: 80.27 };

describe('distances and bearings', () => {
  it('measures a known sea distance to within a kilometre', () => {
    // Kochi to Chennai is about 558 km great-circle.
    expect(haversineKm(KOCHI, CHENNAI)).toBeGreaterThan(553);
    expect(haversineKm(KOCHI, CHENNAI)).toBeLessThan(563);
    expect(haversineKm(KOCHI, KOCHI)).toBe(0);
  });

  it('points roughly north-east from Kochi to Chennai', () => {
    const bearing = bearingDeg(KOCHI, CHENNAI);
    expect(bearing).toBeGreaterThan(30);
    expect(bearing).toBeLessThan(60);
    expect(formatBearing(bearing)).toMatch(/NE|ENE|NNE/);
  });

  it('returns to the start when it travels out and back', () => {
    const out = destination(KOCHI, 75, 40);
    const back = destination(out, 75 + 180, 40);
    expect(haversineKm(back, KOCHI)).toBeLessThan(0.05);
  });

  it('offsets east and north by the kilometres asked for', () => {
    const moved = offsetKm(KOCHI, 10, 0);
    expect(haversineKm(KOCHI, moved)).toBeCloseTo(10, 1);
    expect(moved.lat).toBeCloseTo(KOCHI.lat, 6);
    expect(moved.lon).toBeGreaterThan(KOCHI.lon);
  });

  it('compares angles the short way round', () => {
    expect(angularDiff(350, 10)).toBe(20);
    expect(angularDiff(10, 350)).toBe(20);
    // An axis has no direction, so north and south are the same line.
    expect(axialDiff(10, 190)).toBe(0);
    expect(axialDiff(10, 100)).toBe(90);
  });
});

describe('slick shape', () => {
  it('measures the area of a square patch', () => {
    const ring = [
      { lat: 9.0, lon: 76.0 }, { lat: 9.0, lon: 76.1 }, { lat: 9.1, lon: 76.1 }, { lat: 9.1, lon: 76.0 },
    ];
    // 0.1° is about 11 km each way, so roughly 122 km².
    expect(polygonAreaKm2(ring)).toBeGreaterThan(110);
    expect(polygonAreaKm2(ring)).toBeLessThan(135);
  });

  it('tells a long discharge trail apart from a compact blob', () => {
    const trail = analysePolygon([
      { lat: 9.0, lon: 76.0 }, { lat: 9.0, lon: 76.4 }, { lat: 9.01, lon: 76.4 }, { lat: 9.01, lon: 76.0 },
    ]);
    const blob = analysePolygon([
      { lat: 9.0, lon: 76.0 }, { lat: 9.0, lon: 76.1 }, { lat: 9.1, lon: 76.1 }, { lat: 9.1, lon: 76.0 },
    ]);
    expect(trail.elongation).toBeGreaterThan(10);
    expect(blob.elongation).toBeLessThan(2);
    expect(blob.compactness).toBeGreaterThan(trail.compactness);
    expect(trail.majorAxisKm).toBeGreaterThan(trail.minorAxisKm);
  });

  it('knows what lies inside a patch', () => {
    const ring = [
      { lat: 9.0, lon: 76.0 }, { lat: 9.0, lon: 76.1 }, { lat: 9.1, lon: 76.1 }, { lat: 9.1, lon: 76.0 },
    ];
    expect(pointInPolygon({ lat: 9.05, lon: 76.05 }, ring)).toBe(true);
    expect(pointInPolygon({ lat: 9.2, lon: 76.05 }, ring)).toBe(false);
  });
});

describe('closest approach', () => {
  it('finds the nearest ping on a track and when it happened', () => {
    const track = [
      { lat: 9.0, lon: 76.0, t: 1000 },
      { lat: 9.05, lon: 76.0, t: 2000 },
      { lat: 9.5, lon: 76.0, t: 3000 },
    ];
    const cpa = closestApproach({ lat: 9.06, lon: 76.0 }, track);
    expect(cpa?.index).toBe(1);
    expect(cpa?.timeAtCpa).toBe(2000);
    expect(cpa?.distanceKm).toBeLessThan(2);
    expect(closestApproach({ lat: 9, lon: 76 }, [])).toBeNull();
  });

  it('measures the distance from a point to a leg of a track', () => {
    const a = { lat: 9.0, lon: 76.0 };
    const b = { lat: 9.0, lon: 76.2 };
    const beside = { lat: 9.05, lon: 76.1 };
    expect(distanceToSegmentKm(beside, a, b)).toBeLessThan(haversineKm(beside, a));
    expect(distanceToSegmentKm({ lat: 9.0, lon: 76.1 }, a, b)).toBeLessThan(0.01);
  });
});

describe('formatting', () => {
  it('writes positions the way the screens show them', () => {
    expect(formatLatLon(KOCHI)).toContain('9.965° N');
    expect(formatLatLon(KOCHI)).toContain('76.255° E');
    expect(formatLatLon({ lat: -9.5, lon: -76.5 }, 1)).toBe('9.5° S  76.5° W');
  });
});
