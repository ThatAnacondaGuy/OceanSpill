/**
 * Canvas-drawn sprites and textures for the map: marker icons, arrowheads, field vectors and
 * the procedural oil-slick renderer. Everything is generated at runtime so the map needs no
 * sprite sheet download.
 */

const PIXEL_RATIO = 2;

const colorCache = new Map<string, string>();
let colorCtx: CanvasRenderingContext2D | null = null;

/** Normalises any CSS colour (including #rrggbbaa) to a string MapLibre accepts. */
export function cssColor(input: string | undefined, fallback = '#ef4444'): string {
  const c = input ?? fallback;
  const hit = colorCache.get(c);
  if (hit) return hit;
  if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d');
  let out = fallback;
  if (colorCtx) {
    colorCtx.fillStyle = '#000000';
    colorCtx.fillStyle = c;
    out = colorCtx.fillStyle;
  }
  colorCache.set(c, out);
  return out;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const el = document.createElement('canvas');
  el.width = w * PIXEL_RATIO;
  el.height = h * PIXEL_RATIO;
  const ctx = el.getContext('2d')!;
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  return [el, ctx];
}

export interface SpriteImage {
  data: ImageData;
  pixelRatio: number;
}

function toImage(el: HTMLCanvasElement): SpriteImage {
  return { data: el.getContext('2d')!.getImageData(0, 0, el.width, el.height), pixelRatio: PIXEL_RATIO };
}


/**
 * What a vessel looks like from above, by what it is. One arrowhead for every ship made a trawler
 * and a supertanker identical on the map, and gave vessels the same shape language as the wind and
 * current arrows, which is the confusion worth removing.
 *
 * The free-text type comes from the AIS registry, so matching is by keyword rather than an exact
 * list; anything unrecognised gets a plain hull rather than a guess.
 */
export type VesselShape = 'tanker' | 'cargo' | 'bulk' | 'fishing' | 'passenger' | 'tug' | 'patrol' | 'platform' | 'plain';

export function vesselShape(type: string | null | undefined): VesselShape {
  const t = (type ?? '').toLowerCase();
  if (!t) return 'plain';
  if (/tanker|crude|lng|lpg|chemical|product/.test(t)) return 'tanker';
  if (/container|cargo|feeder|ro-?ro|vehicle/.test(t)) return 'cargo';
  // Word boundaries matter here: "offshore supply" contains "ore" and is not a bulk carrier.
  if (/\bbulk\b|\bore\b|\bcarrier\b/.test(t)) return 'bulk';
  if (/fishing|trawler|seiner|longlin|jigger/.test(t)) return 'fishing';
  if (/passenger|cruise|ferry/.test(t)) return 'passenger';
  if (/tug|supply|offshore|support|dredg|barge/.test(t)) return 'tug';
  if (/patrol|coast ?guard|navy|naval|icgs|military|law/.test(t)) return 'patrol';
  if (/platform|rig|installation|terminal/.test(t)) return 'platform';
  return 'plain';
}

/** Hull outline pointing north, drawn around the icon centre. */
function drawHull(ctx: CanvasRenderingContext2D, cx: number, cy: number, half: number, beam: number, bow = 1): void {
  const stern = cy + half;
  ctx.beginPath();
  ctx.moveTo(cx, cy - half);                                   // bow
  ctx.quadraticCurveTo(cx + beam, cy - half * 0.35 * bow, cx + beam, cy + half * 0.35);
  ctx.lineTo(cx + beam * 0.82, stern);
  ctx.lineTo(cx - beam * 0.82, stern);
  ctx.lineTo(cx - beam, cy + half * 0.35);
  ctx.quadraticCurveTo(cx - beam, cy - half * 0.35 * bow, cx, cy - half);
  ctx.closePath();
}

/** The marks that tell one kind of ship from another at a glance. */
function drawVesselDetail(ctx: CanvasRenderingContext2D, shape: VesselShape, cx: number, cy: number, half: number, beam: number): void {
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = Math.max(0.9, beam * 0.22);
  if (shape === 'tanker') {
    // Pipework running the length of the deck.
    ctx.beginPath();
    ctx.moveTo(cx, cy - half * 0.35);
    ctx.lineTo(cx, cy + half * 0.45);
    ctx.stroke();
  } else if (shape === 'cargo') {
    // Stacked containers.
    for (const offset of [-0.3, 0.05, 0.4]) {
      ctx.fillRect(cx - beam * 0.55, cy + half * offset, beam * 1.1, half * 0.16);
    }
  } else if (shape === 'bulk') {
    // Hatch covers.
    for (const offset of [-0.3, 0.1, 0.5]) {
      ctx.strokeRect(cx - beam * 0.5, cy + half * offset, beam, half * 0.14);
    }
  } else if (shape === 'fishing') {
    // Boom over the stern.
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + half * 0.9);
    ctx.stroke();
  } else if (shape === 'passenger') {
    // A tall superstructure over most of the hull.
    ctx.fillRect(cx - beam * 0.6, cy - half * 0.25, beam * 1.2, half * 0.9);
  } else if (shape === 'tug') {
    // A short deckhouse forward.
    ctx.fillRect(cx - beam * 0.5, cy - half * 0.1, beam, half * 0.4);
  } else if (shape === 'patrol') {
    // A mast amidships.
    ctx.beginPath();
    ctx.moveTo(cx, cy - half * 0.15);
    ctx.lineTo(cx, cy + half * 0.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy - half * 0.2, beam * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Marker glyph drawn around the icon centre; vessels point north and are rotated by the map. */
export function markerIcon(kind: string, color: string, r: number, shape: VesselShape = 'plain'): SpriteImage {
  const size = Math.ceil((r + 7) * 2);
  const [el, ctx] = canvas(size, size);
  const cx = size / 2;
  const cy = size / 2;
  ctx.lineJoin = 'round';
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.4;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 2;
  if (kind === 'vessel') {
    // A hull seen from above, with the marks that say what kind of ship it is. A platform does not
    // move, so it keeps a fixed square rather than a hull.
    if (shape === 'platform') {
      ctx.fillRect(cx - r * 0.8, cy - r * 0.8, r * 1.6, r * 1.6);
      ctx.shadowBlur = 0;
      ctx.strokeRect(cx - r * 0.8, cy - r * 0.8, r * 1.6, r * 1.6);
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy - r * 0.5);
      ctx.lineTo(cx + r * 0.5, cy + r * 0.5);
      ctx.moveTo(cx + r * 0.5, cy - r * 0.5);
      ctx.lineTo(cx - r * 0.5, cy + r * 0.5);
      ctx.stroke();
    } else {
      const long = shape === 'tanker' || shape === 'bulk' || shape === 'cargo';
      const half = r * (long ? 1.45 : shape === 'fishing' || shape === 'tug' ? 1.05 : 1.25);
      const beam = r * (shape === 'tanker' || shape === 'bulk' ? 0.62 : shape === 'fishing' ? 0.5 : 0.56);
      drawHull(ctx, cx, cy, half, beam, shape === 'patrol' ? 1.35 : 1);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.stroke();
      drawVesselDetail(ctx, shape, cx, cy, half, beam);
    }
  } else if (kind === 'port') {
    ctx.fillRect(cx - r * 0.75, cy - r * 0.75, r * 1.5, r * 1.5);
    ctx.shadowBlur = 0;
    ctx.strokeRect(cx - r * 0.75, cy - r * 0.75, r * 1.5, r * 1.5);
  } else if (kind === 'origin') {
    ctx.shadowBlur = 3;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(cx - r - 5, cy); ctx.lineTo(cx - r * 0.35, cy);
    ctx.moveTo(cx + r * 0.35, cy); ctx.lineTo(cx + r + 5, cy);
    ctx.moveTo(cx, cy - r - 5); ctx.lineTo(cx, cy - r * 0.35);
    ctx.moveTo(cx, cy + r * 0.35); ctx.lineTo(cx, cy + r + 5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'platform') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - r * 0.9, cy - r * 0.9, r * 1.8, r * 1.8);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.9, cy - r * 0.9);
    ctx.lineTo(cx + r * 0.9, cy + r * 0.9);
    ctx.stroke();
  } else if (kind === 'sighting') {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r - 1);
    ctx.lineTo(cx + r, cy + r * 0.7);
    ctx.lineTo(cx - r, cy + r * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
  } else if (kind === 'detection') {
    // A hollow diamond, deliberately unlike the filled circle a confirmed case gets. Nobody has
    // decided anything about this yet, and the marker should not look like they have.
    ctx.beginPath();
    ctx.moveTo(cx, cy - r - 1);
    ctx.lineTo(cx + r + 1, cy);
    ctx.lineTo(cx, cy + r + 1);
    ctx.lineTo(cx - r - 1, cy);
    ctx.closePath();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
  }
  return toImage(el);
}

export function selectionRing(color: string, r: number): SpriteImage {
  const size = Math.ceil((r + 9) * 2);
  const [el, ctx] = canvas(size, size);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, r + 6, 0, Math.PI * 2);
  ctx.stroke();
  return toImage(el);
}

/** Arrowhead pointing north; rotated to the bearing of the final path segment. */
export function arrowHead(color: string): SpriteImage {
  const [el, ctx] = canvas(14, 14);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(7, 1);
  ctx.lineTo(12.5, 12);
  ctx.lineTo(7, 9.2);
  ctx.lineTo(1.5, 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  return toImage(el);
}

/** Field arrow (current or wind) pointing north, 26 px long at icon-size 1. */
export function vectorArrow(color: string): SpriteImage {
  const [el, ctx] = canvas(12, 28);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(6, 27);
  ctx.lineTo(6, 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(6, 1);
  ctx.lineTo(10, 8);
  ctx.lineTo(2, 8);
  ctx.closePath();
  ctx.fill();
  return toImage(el);
}

// ---- Oil slick texture --------------------------------------------------------------------------

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise with separate periods per axis (unequal periods stretch the pattern). */
function tileNoise(u: number, v: number, px: number, py: number, seed: number): number {
  const x = u * px;
  const y = v * py;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wx = (i: number) => ((i % px) + px) % px;
  const wy = (i: number) => ((i % py) + py) % py;
  const a = hash(wx(x0), wy(y0), seed);
  const b = hash(wx(x0 + 1), wy(y0), seed);
  const c = hash(wx(x0), wy(y0 + 1), seed);
  const d = hash(wx(x0 + 1), wy(y0 + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(u: number, v: number, seed: number): number {
  return tileNoise(u, v, 3, 3, seed) * 0.46 + tileNoise(u, v, 6, 6, seed + 1) * 0.27
    + tileNoise(u, v, 12, 12, seed + 2) * 0.15 + tileNoise(u, v, 24, 24, seed + 3) * 0.08 + tileNoise(u, v, 48, 48, seed + 4) * 0.04;
}

/** Thin-film interference colour: the rainbow bands of an oil sheen, for a film phase in turns. */
function sheen(t: number): [number, number, number] {
  const k = t * Math.PI * 2;
  return [
    128 + 110 * Math.cos(k),
    128 + 110 * Math.cos(k - 2.094),
    128 + 110 * Math.cos(k - 4.189),
  ];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const FIELD = 256;
let fields: { warp: Float32Array; streak: Float32Array; grain: Float32Array } | null = null;

function noiseFields() {
  if (fields) return fields;
  const warp = new Float32Array(FIELD * FIELD);
  const streak = new Float32Array(FIELD * FIELD);
  const grain = new Float32Array(FIELD * FIELD);
  for (let y = 0; y < FIELD; y++) {
    for (let x = 0; x < FIELD; x++) {
      const u = x / FIELD;
      const v = y / FIELD;
      // Domain warp gives the swirled, torn look of oil broken up by wave action.
      const wu = u + (tileNoise(u, v, 4, 4, 31) - 0.5) * 0.2;
      const wv = v + (tileNoise(u, v, 4, 4, 37) - 0.5) * 0.2;
      warp[y * FIELD + x] = fbm(((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1, 7);
      // Windrows: noise stretched along one axis.
      streak[y * FIELD + x] = tileNoise(u, v, 3, 22, 11) * 0.65 + tileNoise(u, v, 6, 44, 12) * 0.35;
      grain[y * FIELD + x] = tileNoise(u, v, 64, 64, 19);
    }
  }
  fields = { warp, streak, grain };
  return fields;
}

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
};
const unMercY = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** Three-pass separable box blur (close to Gaussian) of a single-channel field, in place. */
function blur(src: Float32Array, w: number, h: number, radius: number) {
  const tmp = new Float32Array(src.length);
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const norm = 1 / (radius * 2 + 1);
    for (let l = 0; l < lines; l++) {
      const at = (i: number) => {
        const c = Math.max(0, Math.min(len - 1, i));
        return horizontal ? from[l * w + c] : from[c * w + l];
      };
      let acc = 0;
      for (let i = -radius; i <= radius; i++) acc += at(i);
      for (let i = 0; i < len; i++) {
        if (horizontal) to[l * w + i] = acc * norm;
        else to[i * w + l] = acc * norm;
        acc += at(i + radius + 1) - at(i - radius);
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(src, tmp, true);
    pass(tmp, src, false);
  }
}

/**
 * Draws a detected slick as oil looks on the sea surface, following the Bonn Agreement oil
 * appearance code: a black thick core, brown emulsion, rainbow and metallic sheen where the film
 * thins towards the edge, and a faint silver sheen at the fringe, broken into wind-aligned
 * windrows. The polygon sets where the oil is; only the shading inside and at its edge is
 * procedural. `draw` advances the film slowly so the slick shimmers and creeps like real oil.
 */
export class SlickRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly coordinates: [[number, number], [number, number], [number, number], [number, number]];
  private readonly w: number;
  private readonly h: number;
  private readonly core: Float32Array;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly img: ImageData;
  private readonly scale: number;

  constructor(rings: { lat: number; lon: number }[][], maxSide = 384) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const ring of rings) for (const p of ring) {
      const x = mercX(p.lon);
      const y = mercY(p.lat);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const span = Math.max(x1 - x0, y1 - y0, 1e-9);
    const pad = span * 0.28;
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const aspect = (x1 - x0) / (y1 - y0);
    this.w = Math.max(48, Math.round(aspect >= 1 ? maxSide : maxSide * aspect));
    this.h = Math.max(48, Math.round(aspect >= 1 ? maxSide / aspect : maxSide));
    this.coordinates = [
      [x0 * 360 - 180, unMercY(y0)], [x1 * 360 - 180, unMercY(y0)],
      [x1 * 360 - 180, unMercY(y1)], [x0 * 360 - 180, unMercY(y1)],
    ];

    const mask = document.createElement('canvas');
    mask.width = this.w;
    mask.height = this.h;
    const mctx = mask.getContext('2d')!;
    mctx.fillStyle = '#fff';
    for (const ring of rings) {
      if (ring.length < 3) continue;
      mctx.beginPath();
      ring.forEach((p, i) => {
        const px = ((mercX(p.lon) - x0) / (x1 - x0)) * this.w;
        const py = ((mercY(p.lat) - y0) / (y1 - y0)) * this.h;
        if (i === 0) mctx.moveTo(px, py); else mctx.lineTo(px, py);
      });
      mctx.closePath();
      mctx.fill();
    }
    const alpha = mctx.getImageData(0, 0, this.w, this.h).data;
    this.core = new Float32Array(this.w * this.h);
    for (let i = 0; i < this.core.length; i++) this.core[i] = alpha[i * 4 + 3] / 255;
    // The blur turns the hard outline into a film that thins over the outer part of the slick.
    const polySide = Math.min(this.w, this.h) / (1 + 2 * 0.28 / Math.max(0.2, Math.min(aspect, 1 / aspect)));
    blur(this.core, this.w, this.h, Math.max(2, Math.round(polySide * 0.07)));

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(this.w, this.h);
    // About two and a half noise cycles across the slick itself.
    this.scale = (FIELD / Math.max(this.w, this.h)) * 1.6;
    noiseFields();
  }

  draw(timeMs: number) {
    const { warp, streak, grain } = noiseFields();
    const { w, h, core, img, scale } = this;
    const data = img.data;
    const driftX = (timeMs / 1000) * 2.2;
    const driftY = (timeMs / 1000) * 0.9;
    const phase = timeMs / 2600;
    for (let y = 0; y < h; y++) {
      const fy = (((Math.floor(y * scale + driftY) % FIELD) + FIELD) % FIELD) * FIELD;
      const sy = (((Math.floor(y * scale * 0.8) % FIELD) + FIELD) % FIELD) * FIELD;
      const ly = (((Math.floor(y * scale * 0.32 + driftY * 0.3) % FIELD) + FIELD) % FIELD) * FIELD;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = i * 4;
        const c = core[i];
        if (c < 0.02) { data[o + 3] = 0; continue; }
        const n = warp[fy + (((Math.floor(x * scale + driftX) % FIELD) + FIELD) % FIELD)];
        const s = streak[sy + (((Math.floor(x * scale * 0.8 + driftX * 0.5) % FIELD) + FIELD) % FIELD)];
        const g = grain[(y % FIELD) * FIELD + (x % FIELD)];
        // Large lobes break the outer edge up the way wind and waves tear a slick apart.
        const lobes = warp[ly + (((Math.floor(x * scale * 0.32 + driftX * 0.3) % FIELD) + FIELD) % FIELD)];
        const edge = 4 * c * (1 - c);
        const t = c * (1 + (n - 0.5) * 1.4 + (s - 0.5) * 0.6) + (lobes - 0.5) * 1.2 * edge;

        const heavy = smooth(0.66, 0.8, t);
        const emulsion = smooth(0.46, 0.58, t) * (1 - heavy);
        const rainbow = smooth(0.3, 0.4, t) * (1 - smooth(0.46, 0.58, t));
        const silver = smooth(0.16, 0.26, t) * (1 - smooth(0.3, 0.4, t));
        const wsum = heavy + emulsion + rainbow + silver;
        if (wsum < 0.001) { data[o + 3] = 0; continue; }
        const [sr, sg, sb] = sheen(t * 2.2 + phase + n * 1.6 + s * 0.7);
        const r = heavy * (24 + g * 14) + emulsion * (78 + g * 30) + rainbow * (sr * 0.62 + 40) + silver * 188;
        const gg = heavy * (18 + g * 10) + emulsion * (46 + g * 18) + rainbow * (sg * 0.62 + 36) + silver * 196;
        const b = heavy * (13 + g * 8) + emulsion * (22 + g * 10) + rainbow * (sb * 0.62 + 34) + silver * 206;
        data[o] = r / wsum;
        data[o + 1] = gg / wsum;
        data[o + 2] = b / wsum;
        data[o + 3] = 255 * Math.min(0.94, heavy * 0.93 + emulsion * 0.86 + rainbow * 0.52 + silver * 0.26);
      }
    }
    this.ctx.putImageData(img, 0, 0);
  }
}

/** Geodesic circle ring for an uncertainty envelope or no-go zone. */
export function circleRing(lat: number, lon: number, radiusKm: number, steps = 72): [number, number][] {
  const R = 6371.0088;
  const d = radiusKm / R;
  const phi1 = (lat * Math.PI) / 180;
  const lam1 = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const brg = (i / steps) * Math.PI * 2;
    const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(brg));
    const lam2 = lam1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2));
    ring.push([(lam2 * 180) / Math.PI, (phi2 * 180) / Math.PI]);
  }
  return ring;
}

export function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
