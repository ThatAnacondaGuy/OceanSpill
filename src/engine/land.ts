import type { LatLon } from '../lib/geo';
import type { CoastArtifact } from '../data/types';

/** Answers whether a position is on land. Positions it knows nothing about count as water. */
export interface LandMask {
  source: string;
  isLand(p: LatLon): boolean;
  /** Closest water position within `maxKm`, or null if none is found. */
  nearestWater(p: LatLon, maxKm?: number): LatLon | null;
}

const MAX_CELLS = 9_000_000;

/**
 * Land raster over a case's drift box, rasterised once from the pipeline's coastline rings with an
 * even-odd scanline fill and stored as a bitset. Lookups are constant time, which keeps the particle
 * model fast while respecting a coastline mapped to tens of metres.
 */
export class LandGrid implements LandMask {
  readonly source: string;
  private readonly west: number;
  private readonly south: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly bits: Uint8Array;

  constructor(coast: CoastArtifact, cellDeg = 0.001) {
    const { west, south, east, north } = coast.bbox;
    // Coarsen for very large boxes so the bitset stays around a megabyte.
    const area = ((east - west) / cellDeg) * ((north - south) / cellDeg);
    this.cell = area > MAX_CELLS ? cellDeg * Math.sqrt(area / MAX_CELLS) : cellDeg;
    this.source = coast.source;
    this.west = west;
    this.south = south;
    this.nx = Math.max(1, Math.ceil((east - west) / this.cell));
    this.ny = Math.max(1, Math.ceil((north - south) / this.cell));
    this.bits = new Uint8Array(Math.ceil((this.nx * this.ny) / 8));
    this.rasterise(coast.rings);
  }

  private rasterise(rings: [number, number][][]) {
    // Bucket edges by the rows they span, then fill spans between sorted crossings on each row.
    const rows: number[][] = Array.from({ length: this.ny }, () => []);
    const edges: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        if (y1 === y2) continue;
        const e = edges.length / 4;
        edges.push(x1, y1, x2, y2);
        const r0 = Math.max(0, Math.floor((Math.min(y1, y2) - this.south) / this.cell));
        const r1 = Math.min(this.ny - 1, Math.floor((Math.max(y1, y2) - this.south) / this.cell));
        for (let r = r0; r <= r1; r++) rows[r].push(e);
      }
    }
    const xs: number[] = [];
    for (let r = 0; r < this.ny; r++) {
      const y = this.south + (r + 0.5) * this.cell;
      xs.length = 0;
      for (const e of rows[r]) {
        const x1 = edges[e * 4], y1 = edges[e * 4 + 1], x2 = edges[e * 4 + 2], y2 = edges[e * 4 + 3];
        if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - this.west) / this.cell - 0.5));
        const c1 = Math.min(this.nx - 1, Math.floor((xs[k + 1] - this.west) / this.cell - 0.5));
        for (let c = c0; c <= c1; c++) {
          const idx = r * this.nx + c;
          this.bits[idx >> 3] |= 1 << (idx & 7);
        }
      }
    }
  }

  private cellLand(c: number, r: number): boolean {
    if (c < 0 || r < 0 || c >= this.nx || r >= this.ny) return false;
    const idx = r * this.nx + c;
    return (this.bits[idx >> 3] & (1 << (idx & 7))) !== 0;
  }

  isLand(p: LatLon): boolean {
    return this.cellLand(Math.floor((p.lon - this.west) / this.cell), Math.floor((p.lat - this.south) / this.cell));
  }

  nearestWater(p: LatLon, maxKm = 30): LatLon | null {
    const c0 = Math.floor((p.lon - this.west) / this.cell);
    const r0 = Math.floor((p.lat - this.south) / this.cell);
    if (!this.cellLand(c0, r0)) return p;
    const kmPerCellY = this.cell * 111.32;
    const kmPerCellX = kmPerCellY * Math.cos((p.lat * Math.PI) / 180);
    const maxRing = Math.ceil(maxKm / Math.min(kmPerCellX, kmPerCellY));
    // Expanding square rings; the best candidate on the first ring with water is within one ring of optimal.
    for (let d = 1; d <= maxRing; d++) {
      let best: { c: number; r: number; dist: number } | null = null;
      for (let dc = -d; dc <= d; dc++) {
        for (const dr of Math.abs(dc) === d ? rangeInclusive(-d, d) : [-d, d]) {
          const c = c0 + dc, r = r0 + dr;
          if (this.cellLand(c, r)) continue;
          const dist = (dc * kmPerCellX) ** 2 + (dr * kmPerCellY) ** 2;
          if (!best || dist < best.dist) best = { c, r, dist };
        }
      }
      if (best) {
        return { lat: this.south + (best.r + 0.5) * this.cell, lon: this.west + (best.c + 0.5) * this.cell };
      }
    }
    return null;
  }
}

function rangeInclusive(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
