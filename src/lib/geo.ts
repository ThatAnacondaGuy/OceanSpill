export interface LatLon {
  lat: number;
  lon: number;
}

export const EARTH_RADIUS_KM = 6371.0088;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees clockwise from true north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached by travelling distKm from origin along bearing. */
export function destination(origin: LatLon, bearing: number, distKm: number): LatLon {
  const d = distKm / EARTH_RADIUS_KM;
  const br = toRad(bearing);
  const la1 = toRad(origin.lat);
  const lo1 = toRad(origin.lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 =
    lo1 +
    Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: toDeg(la2), lon: ((toDeg(lo2) + 540) % 360) - 180 };
}

/** Move a point by east/north offsets in km (local flat-earth approximation). */
export function offsetKm(origin: LatLon, eastKm: number, northKm: number): LatLon {
  const latPerKm = 1 / 110.574;
  const lonPerKm = 1 / (111.32 * Math.cos(toRad(origin.lat)) || 1e-6);
  return { lat: origin.lat + northKm * latPerKm, lon: origin.lon + eastKm * lonPerKm };
}

/** Smallest absolute difference between two compass bearings, 0..180. */
export function angularDiff(a: number, b: number): number {
  const d = Math.abs(((a - b + 180 + 360) % 360) - 180);
  return d;
}

/** Difference treating headings 180 degrees apart as identical (axis alignment), 0..90. */
export function axialDiff(a: number, b: number): number {
  const d = angularDiff(a, b);
  return d > 90 ? 180 - d : d;
}

export function centroid(points: LatLon[]): LatLon {
  if (!points.length) return { lat: 0, lon: 0 };
  let lat = 0;
  let lon = 0;
  for (const p of points) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}

/** Signed planar area of a lat/lon ring converted to km², using a local equirectangular projection. */
export function polygonAreaKm2(ring: LatLon[]): number {
  if (ring.length < 3) return 0;
  const c = centroid(ring);
  const kx = 111.32 * Math.cos(toRad(c.lat));
  const ky = 110.574;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    const x1 = (p1.lon - c.lon) * kx;
    const y1 = (p1.lat - c.lat) * ky;
    const x2 = (p2.lon - c.lon) * kx;
    const y2 = (p2.lat - c.lat) * ky;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function polygonPerimeterKm(ring: LatLon[]): number {
  if (ring.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    total += haversineKm(ring[i], ring[(i + 1) % ring.length]);
  }
  return total;
}

export interface PolygonShape {
  areaKm2: number;
  perimeterKm: number;
  /** Longest axis length in km. */
  majorAxisKm: number;
  /** Extent perpendicular to the major axis, in km. */
  minorAxisKm: number;
  /** majorAxis / minorAxis. High values indicate a ship-track-like linear slick. */
  elongation: number;
  /** 4*pi*A / P^2 — 1.0 for a circle, approaching 0 for a thin filament. */
  compactness: number;
  /** Orientation of the major axis, degrees clockwise from north, 0..180. */
  orientationDeg: number;
  centroid: LatLon;
}

/**
 * Derives the geometric descriptors used for spill characterisation. The major axis is
 * found by rotating-caliper search over the convex extent, which is what distinguishes a
 * linear discharge trail from a compact stationary-source blob.
 */
export function analysePolygon(ring: LatLon[]): PolygonShape {
  const c = centroid(ring);
  const kx = 111.32 * Math.cos(toRad(c.lat));
  const ky = 110.574;
  const pts = ring.map((p) => ({ x: (p.lon - c.lon) * kx, y: (p.lat - c.lat) * ky }));

  let best = { len: 0, angle: 0, width: 0 };
  for (let deg = 0; deg < 180; deg += 1) {
    const th = toRad(deg);
    const ux = Math.sin(th);
    const uy = Math.cos(th);
    let minP = Infinity;
    let maxP = -Infinity;
    let minQ = Infinity;
    let maxQ = -Infinity;
    for (const p of pts) {
      const proj = p.x * ux + p.y * uy;
      const perp = -p.x * uy + p.y * ux;
      if (proj < minP) minP = proj;
      if (proj > maxP) maxP = proj;
      if (perp < minQ) minQ = perp;
      if (perp > maxQ) maxQ = perp;
    }
    const len = maxP - minP;
    if (len > best.len) best = { len, angle: deg, width: maxQ - minQ };
  }

  const areaKm2 = polygonAreaKm2(ring);
  const perimeterKm = polygonPerimeterKm(ring);
  const minorAxisKm = Math.max(best.width, 1e-3);
  return {
    areaKm2,
    perimeterKm,
    majorAxisKm: best.len,
    minorAxisKm,
    elongation: best.len / minorAxisKm,
    compactness: perimeterKm > 0 ? (4 * Math.PI * areaKm2) / perimeterKm ** 2 : 0,
    orientationDeg: best.angle,
    centroid: c,
  };
}

export function pointInPolygon(pt: LatLon, ring: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon;
    const yi = ring[i].lat;
    const xj = ring[j].lon;
    const yj = ring[j].lat;
    const intersects =
      yi > pt.lat !== yj > pt.lat && pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Perpendicular distance in km from a point to the segment ab. */
export function distanceToSegmentKm(p: LatLon, a: LatLon, b: LatLon): number {
  const c = a;
  const kx = 111.32 * Math.cos(toRad(c.lat));
  const ky = 110.574;
  const px = (p.lon - c.lon) * kx;
  const py = (p.lat - c.lat) * ky;
  const ax = 0;
  const ay = 0;
  const bx = (b.lon - c.lon) * kx;
  const by = (b.lat - c.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface TrackProximity {
  distanceKm: number;
  /** Interpolated time at the closest point of approach. */
  timeAtCpa: number;
  position: LatLon;
  index: number;
}

/** Closest point of approach between a target position and a timestamped track. */
export function closestApproach(
  target: LatLon,
  track: { lat: number; lon: number; t: number }[]
): TrackProximity | null {
  if (!track.length) return null;
  let best: TrackProximity | null = null;
  for (let i = 0; i < track.length; i++) {
    const d = haversineKm(target, track[i]);
    if (!best || d < best.distanceKm) {
      best = { distanceKm: d, timeAtCpa: track[i].t, position: track[i], index: i };
    }
  }
  return best;
}

export function formatLatLon(p: LatLon, precision = 3): string {
  const ns = p.lat >= 0 ? 'N' : 'S';
  const ew = p.lon >= 0 ? 'E' : 'W';
  return `${Math.abs(p.lat).toFixed(precision)}° ${ns}  ${Math.abs(p.lon).toFixed(precision)}° ${ew}`;
}

export function formatBearing(deg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(((deg % 360) / 22.5)) % 16];
}
