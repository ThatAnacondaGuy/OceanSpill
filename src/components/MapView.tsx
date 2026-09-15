import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LatLon } from '../lib/geo';
import {
  ANDAMAN_EEZ, ANDAMAN_NICOBAR, COUNTRY_LABELS, INDIA_EEZ, INDIA_MAINLAND, LAKSHADWEEP,
  NEIGHBOURS, SEA_LABELS, SRI_LANKA,
} from '../data/geography';

/**
 * Interactive Web Mercator map.
 *
 * Everything is drawn as SVG in world-pixel space so that hit-testing, tooltips and layer
 * ordering work the same way at every zoom level. Pan is a pointer drag, zoom is the wheel or
 * the on-screen control, and both keep the geographic point under the cursor fixed.
 */

const TILE = 256;

export type BasemapStyle = 'map' | 'satellite' | 'dark' | 'bathymetry';

export interface MapMarker {
  id: string;
  position: LatLon;
  kind: 'case' | 'vessel' | 'port' | 'origin' | 'sighting' | 'asset' | 'platform';
  color?: string;
  label?: string;
  sublabel?: string;
  /** Radius in px. */
  size?: number;
  /** Rotation for directional markers such as vessels under way. */
  headingDeg?: number;
  selected?: boolean;
  dimmed?: boolean;
  pulse?: boolean;
  z?: number;
  meta?: Record<string, string | number>;
}

export interface MapPolygon {
  id: string;
  rings: LatLon[][];
  fill: string;
  stroke: string;
  strokeWidth?: number;
  dash?: string;
  opacity?: number;
  label?: string;
  selected?: boolean;
  z?: number;
}

export interface MapPath {
  id: string;
  points: LatLon[];
  stroke: string;
  strokeWidth?: number;
  dash?: string;
  opacity?: number;
  arrow?: boolean;
  label?: string;
  z?: number;
}

export interface MapCircle {
  id: string;
  centre: LatLon;
  radiusKm: number;
  fill: string;
  stroke: string;
  dash?: string;
  opacity?: number;
  label?: string;
}

export interface MapVector {
  position: LatLon;
  /** Direction the arrow points, degrees clockwise from north. */
  dirDeg: number;
  /** Magnitude used to scale the arrow. */
  magnitude: number;
  color?: string;
}

export interface MapViewProps {
  initialCentre?: LatLon;
  initialZoom?: number;
  basemap?: BasemapStyle;
  markers?: MapMarker[];
  polygons?: MapPolygon[];
  paths?: MapPath[];
  circles?: MapCircle[];
  vectors?: MapVector[];
  vectorLabel?: string;
  showGraticule?: boolean;
  showEez?: boolean;
  showLabels?: boolean;
  onMarkerClick?: (m: MapMarker) => void;
  onMapClick?: (p: LatLon) => void;
  /** Rendered above the map, inside the frame. */
  overlay?: ReactNode;
  legend?: ReactNode;
  className?: string;
  /** Fit the view to these points on mount and whenever the key changes. */
  fitTo?: LatLon[];
  fitKey?: string;
  interactive?: boolean;
}

function project(p: LatLon, scale: number): { x: number; y: number } {
  const lat = Math.max(-85.05, Math.min(85.05, p.lat));
  const x = ((p.lon + 180) / 360) * scale;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function unproject(x: number, y: number, scale: number): LatLon {
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lon };
}

const BASEMAPS: Record<BasemapStyle, {
  ocean: string; oceanDeep: string; land: string; landStroke: string; text: string;
  seaText: string; graticule: string; eez: string; neighbourLand: string;
}> = {
  map: {
    ocean: '#c9e3f2', oceanDeep: '#a8d0e8', land: '#eef2e4', landStroke: '#a8b394',
    text: '#5a6b4a', seaText: '#5b8db5', graticule: '#9dbfd4', eez: '#2c7fb8', neighbourLand: '#e6e8dd',
  },
  satellite: {
    ocean: '#0b2e4a', oceanDeep: '#061c2e', land: '#3d4a2a', landStroke: '#5a6b3a',
    text: '#d4dcc4', seaText: '#7fb4d6', graticule: '#2a5570', eez: '#5fc9f3', neighbourLand: '#33401f',
  },
  dark: {
    ocean: '#0f2135', oceanDeep: '#081726', land: '#1c2b3a', landStroke: '#33485e',
    text: '#7a94ad', seaText: '#4a7fa8', graticule: '#1e3448', eez: '#3d8fc4', neighbourLand: '#17222e',
  },
  bathymetry: {
    ocean: '#1b6ca8', oceanDeep: '#0a3d62', land: '#dfe6d5', landStroke: '#b0bd9c',
    text: '#4a5a3a', seaText: '#cfe8f7', graticule: '#3c8dbc', eez: '#7fe3ff', neighbourLand: '#d2dac7',
  },
};

export function MapView({
  initialCentre = { lat: 13.5, lon: 80.5 },
  initialZoom = 4.1,
  basemap = 'map',
  markers = [],
  polygons = [],
  paths = [],
  circles = [],
  vectors = [],
  vectorLabel,
  showGraticule = true,
  showEez = true,
  showLabels = true,
  onMarkerClick,
  onMapClick,
  overlay,
  legend,
  className = '',
  fitTo,
  fitKey,
  interactive = true,
}: MapViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [centre, setCentre] = useState<LatLon>(initialCentre);
  const [zoom, setZoom] = useState(initialZoom);
  const [hover, setHover] = useState<{ m: MapMarker; x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<LatLon | null>(null);
  const drag = useRef<{ x: number; y: number; centre: LatLon; moved: boolean } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const scale = TILE * Math.pow(2, zoom);

  // Fit the viewport to a set of points whenever the caller asks for a new framing.
  useEffect(() => {
    if (!fitTo || fitTo.length === 0 || size.w < 50) return;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of fitTo) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    const padLat = Math.max((maxLat - minLat) * 0.35, 0.12);
    const padLon = Math.max((maxLon - minLon) * 0.35, 0.12);
    minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;

    let best = 2;
    for (let z = 12; z >= 1; z -= 0.1) {
      const s = TILE * Math.pow(2, z);
      const a = project({ lat: maxLat, lon: minLon }, s);
      const b = project({ lat: minLat, lon: maxLon }, s);
      if (Math.abs(b.x - a.x) <= size.w && Math.abs(b.y - a.y) <= size.h) { best = z; break; }
    }
    setZoom(best);
    setCentre({ lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.w, size.h]);

  const centrePx = useMemo(() => project(centre, scale), [centre, scale]);

  const toScreen = useCallback(
    (p: LatLon) => {
      const w = project(p, scale);
      return { x: w.x - centrePx.x + size.w / 2, y: w.y - centrePx.y + size.h / 2 };
    },
    [scale, centrePx, size]
  );

  const fromScreen = useCallback(
    (x: number, y: number) => unproject(x - size.w / 2 + centrePx.x, y - size.h / 2 + centrePx.y, scale),
    [scale, centrePx, size]
  );

  const kmToPx = useCallback(
    (km: number, atLat: number) => {
      const metresPerPx = (156543.03392 * Math.cos((atLat * Math.PI) / 180)) / Math.pow(2, zoom);
      return (km * 1000) / metresPerPx;
    },
    [zoom]
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!interactive) return;
      e.preventDefault();
      const rect = hostRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = fromScreen(mx, my);
      const next = Math.max(2.2, Math.min(11, zoom - e.deltaY * 0.0022));
      const nextScale = TILE * Math.pow(2, next);
      // Keep the point under the cursor anchored.
      const beforePx = project(before, nextScale);
      const newCentrePx = { x: beforePx.x - (mx - size.w / 2), y: beforePx.y - (my - size.h / 2) };
      setZoom(next);
      setCentre(unproject(newCentrePx.x, newCentrePx.y, nextScale));
    },
    [zoom, fromScreen, size, interactive]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, centre, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (rect) setCursor(fromScreen(e.clientX - rect.left, e.clientY - rect.top));
    if (!drag.current || !interactive) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.current.moved = true;
    const start = project(drag.current.centre, scale);
    setCentre(unproject(start.x - dx, start.y - dy, scale));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasMoved = drag.current?.moved;
    drag.current = null;
    if (!wasMoved && onMapClick && interactive) {
      const rect = hostRef.current!.getBoundingClientRect();
      onMapClick(fromScreen(e.clientX - rect.left, e.clientY - rect.top));
    }
  };

  const zoomBy = (d: number) => setZoom((z) => Math.max(2.2, Math.min(11, z + d)));

  const theme = BASEMAPS[basemap];

  const ringToPath = useCallback(
    (ring: LatLon[], close = true) => {
      if (!ring.length) return '';
      const pts = ring.map((p) => toScreen(p));
      return `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}${close ? 'Z' : ''}`;
    },
    [toScreen]
  );

  // Graticule spacing adapts to zoom so the grid stays readable.
  const gridStep = zoom > 8 ? 0.25 : zoom > 6.5 ? 1 : zoom > 5 ? 2 : zoom > 3.5 ? 5 : 10;
  const graticule = useMemo(() => {
    if (!showGraticule) return { lines: [] as { d: string; label: string; x: number; y: number; vertical: boolean }[] };
    const tl = fromScreen(0, 0);
    const br = fromScreen(size.w, size.h);
    const lines: { d: string; label: string; x: number; y: number; vertical: boolean }[] = [];
    const lonStart = Math.floor(tl.lon / gridStep) * gridStep;
    for (let lon = lonStart; lon <= br.lon; lon += gridStep) {
      const a = toScreen({ lat: tl.lat, lon });
      const b = toScreen({ lat: br.lat, lon });
      lines.push({ d: `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`, label: `${lon.toFixed(gridStep < 1 ? 2 : 0)}°E`, x: a.x, y: 12, vertical: true });
    }
    const latStart = Math.floor(br.lat / gridStep) * gridStep;
    for (let lat = latStart; lat <= tl.lat; lat += gridStep) {
      const a = toScreen({ lat, lon: tl.lon });
      const b = toScreen({ lat, lon: br.lon });
      lines.push({ d: `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`, label: `${lat.toFixed(gridStep < 1 ? 2 : 0)}°N`, x: 4, y: a.y, vertical: false });
    }
    return { lines };
  }, [showGraticule, fromScreen, toScreen, size, gridStep]);

  const sortedMarkers = useMemo(() => [...markers].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)), [markers]);
  const sortedPolys = useMemo(() => [...polygons].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)), [polygons]);
  const sortedPaths = useMemo(() => [...paths].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)), [paths]);

  // Scale bar: choose a round distance that fits comfortably.
  const scaleBar = useMemo(() => {
    const candidates = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000];
    const maxPx = 160;
    let chosen = candidates[0];
    for (const c of candidates) {
      if (kmToPx(c, centre.lat) <= maxPx) chosen = c;
    }
    return { km: chosen, px: kmToPx(chosen, centre.lat) };
  }, [kmToPx, centre.lat]);

  return (
    <div
      ref={hostRef}
      className={`relative overflow-hidden select-none w-full h-full ${interactive ? 'cursor-grab active:cursor-grabbing' : ''} ${className}`}
      style={{ background: theme.oceanDeep, touchAction: 'none' }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { drag.current = null; setHover(null); setCursor(null); }}
    >
      <svg width={size.w} height={size.h} className="absolute inset-0">
        <defs>
          <radialGradient id="oceanGrad" cx="50%" cy="45%" r="75%">
            <stop offset="0%" stopColor={theme.ocean} />
            <stop offset="100%" stopColor={theme.oceanDeep} />
          </radialGradient>
          <marker id="arrowHead" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
          </marker>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1.6" opacity="0.5" />
          </pattern>
        </defs>

        <rect width={size.w} height={size.h} fill="url(#oceanGrad)" />

        {showGraticule && (
          <g>
            {graticule.lines.map((l, i) => (
              <path key={i} d={l.d} stroke={theme.graticule} strokeWidth="0.5" opacity="0.55" fill="none" />
            ))}
          </g>
        )}

        {/* Landmasses */}
        <g>
          {NEIGHBOURS.map((n) => (
            <path key={n.name} d={ringToPath(n.ring)} fill={theme.neighbourLand} stroke={theme.landStroke} strokeWidth="0.7" />
          ))}
          <path d={ringToPath(INDIA_MAINLAND)} fill={theme.land} stroke={theme.landStroke} strokeWidth="0.9" />
          <path d={ringToPath(SRI_LANKA)} fill={theme.land} stroke={theme.landStroke} strokeWidth="0.8" />
          {ANDAMAN_NICOBAR.map((isle, i) => (
            <path key={i} d={ringToPath(isle)} fill={theme.land} stroke={theme.landStroke} strokeWidth="0.7" />
          ))}
          {LAKSHADWEEP.map((p, i) => {
            const s = toScreen(p);
            return <circle key={i} cx={s.x} cy={s.y} r={Math.max(1.4, kmToPx(6, p.lat))} fill={theme.land} stroke={theme.landStroke} strokeWidth="0.6" />;
          })}
        </g>

        {showEez && (
          <g>
            <path d={ringToPath(INDIA_EEZ)} fill="none" stroke={theme.eez} strokeWidth="1.3" strokeDasharray="7 5" opacity="0.85" />
            <path d={ringToPath(ANDAMAN_EEZ)} fill="none" stroke={theme.eez} strokeWidth="1.2" strokeDasharray="7 5" opacity="0.75" />
          </g>
        )}

        {/* Field vectors (currents or wind) */}
        {vectors.length > 0 && (
          <g opacity="0.85">
            {vectors.map((v, i) => {
              const s = toScreen(v.position);
              if (s.x < -20 || s.y < -20 || s.x > size.w + 20 || s.y > size.h + 20) return null;
              const len = Math.min(26, 6 + v.magnitude * 11);
              const rad = ((v.dirDeg - 90) * Math.PI) / 180;
              const ex = s.x + Math.cos(rad) * len;
              const ey = s.y + Math.sin(rad) * len;
              const col = v.color ?? (basemap === 'map' || basemap === 'bathymetry' ? '#1d6fa5' : '#67c7f0');
              return (
                <g key={i} style={{ color: col }}>
                  <line x1={s.x} y1={s.y} x2={ex} y2={ey} stroke={col} strokeWidth="1.5" opacity="0.8" markerEnd="url(#arrowHead)" />
                </g>
              );
            })}
          </g>
        )}

        {/* Polygons: ecological areas, slicks, footprints */}
        <g>
          {sortedPolys.map((poly) => (
            <g key={poly.id}>
              {poly.rings.map((ring, i) => (
                <path
                  key={i}
                  d={ringToPath(ring)}
                  fill={poly.fill}
                  stroke={poly.stroke}
                  strokeWidth={(poly.strokeWidth ?? 1.4) * (poly.selected ? 1.9 : 1)}
                  strokeDasharray={poly.dash}
                  opacity={poly.opacity ?? 1}
                />
              ))}
            </g>
          ))}
        </g>

        {/* Circles: uncertainty envelopes, no-go zones, search radii */}
        <g>
          {circles.map((c) => {
            const s = toScreen(c.centre);
            const r = kmToPx(c.radiusKm, c.centre.lat);
            if (r < 0.5) return null;
            return (
              <g key={c.id}>
                <circle cx={s.x} cy={s.y} r={r} fill={c.fill} stroke={c.stroke} strokeWidth="1.4" strokeDasharray={c.dash} opacity={c.opacity ?? 1} />
                {c.label && r > 26 && (
                  <text x={s.x} y={s.y - r - 5} textAnchor="middle" fontSize="10" fontWeight="600" fill={c.stroke}>{c.label}</text>
                )}
              </g>
            );
          })}
        </g>

        {/* Paths: drift trajectories, AIS tracks, ground tracks */}
        <g>
          {sortedPaths.map((p) => (
            <g key={p.id} style={{ color: p.stroke }}>
              <path
                d={ringToPath(p.points, false)}
                fill="none"
                stroke={p.stroke}
                strokeWidth={p.strokeWidth ?? 1.8}
                strokeDasharray={p.dash}
                opacity={p.opacity ?? 1}
                strokeLinejoin="round"
                strokeLinecap="round"
                markerEnd={p.arrow ? 'url(#arrowHead)' : undefined}
              />
            </g>
          ))}
        </g>

        {/* Markers */}
        <g>
          {sortedMarkers.map((m) => {
            const s = toScreen(m.position);
            if (s.x < -40 || s.y < -40 || s.x > size.w + 40 || s.y > size.h + 40) return null;
            const r = m.size ?? 6;
            const color = m.color ?? '#ef4444';
            const op = m.dimmed ? 0.35 : 1;
            return (
              <g
                key={m.id}
                opacity={op}
                style={{ cursor: onMarkerClick ? 'pointer' : 'default' }}
                onPointerEnter={() => setHover({ m, x: s.x, y: s.y })}
                onPointerLeave={() => setHover(null)}
                onClick={(e) => { e.stopPropagation(); onMarkerClick?.(m); }}
              >
                {m.pulse && (
                  <circle cx={s.x} cy={s.y} r={r + 5} fill={color} opacity="0.25">
                    <animate attributeName="r" values={`${r + 2};${r + 13};${r + 2}`} dur="2.4s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.35;0;0.35" dur="2.4s" repeatCount="indefinite" />
                  </circle>
                )}
                {m.selected && <circle cx={s.x} cy={s.y} r={r + 6} fill="none" stroke={color} strokeWidth="2" opacity="0.85" />}

                {m.kind === 'vessel' ? (
                  <g transform={`translate(${s.x},${s.y}) rotate(${m.headingDeg ?? 0})`}>
                    <path d={`M0,${-r - 2} L${r * 0.72},${r} L0,${r * 0.45} L${-r * 0.72},${r} Z`} fill={color} stroke="#ffffff" strokeWidth="1" />
                  </g>
                ) : m.kind === 'port' ? (
                  <rect x={s.x - r * 0.75} y={s.y - r * 0.75} width={r * 1.5} height={r * 1.5} fill={color} stroke="#ffffff" strokeWidth="1" rx="1" />
                ) : m.kind === 'origin' ? (
                  <g>
                    <circle cx={s.x} cy={s.y} r={r} fill="none" stroke={color} strokeWidth="2.2" />
                    <line x1={s.x - r - 4} y1={s.y} x2={s.x + r + 4} y2={s.y} stroke={color} strokeWidth="1.6" />
                    <line x1={s.x} y1={s.y - r - 4} x2={s.x} y2={s.y + r + 4} stroke={color} strokeWidth="1.6" />
                  </g>
                ) : m.kind === 'platform' ? (
                  <g>
                    <rect x={s.x - r * 0.9} y={s.y - r * 0.9} width={r * 1.8} height={r * 1.8} fill="none" stroke={color} strokeWidth="1.8" />
                    <line x1={s.x - r * 0.9} y1={s.y - r * 0.9} x2={s.x + r * 0.9} y2={s.y + r * 0.9} stroke={color} strokeWidth="1.2" />
                  </g>
                ) : m.kind === 'sighting' ? (
                  <path d={`M${s.x},${s.y - r - 1} L${s.x + r},${s.y + r * 0.7} L${s.x - r},${s.y + r * 0.7} Z`} fill={color} stroke="#ffffff" strokeWidth="1" />
                ) : (
                  <circle cx={s.x} cy={s.y} r={r} fill={color} stroke="#ffffff" strokeWidth="1.4" filter={m.pulse ? 'url(#glow)' : undefined} />
                )}

                {showLabels && m.label && (zoom > 5.4 || m.selected) && (
                  <text
                    x={s.x + r + 4}
                    y={s.y + 3.5}
                    fontSize="10"
                    fontWeight="600"
                    fill={basemap === 'map' || basemap === 'bathymetry' ? '#1f2937' : '#e5eef5'}
                    stroke={basemap === 'map' || basemap === 'bathymetry' ? '#ffffff' : '#0a1622'}
                    strokeWidth="2.6"
                    paintOrder="stroke"
                  >
                    {m.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Place names */}
        {showLabels && (
          <g pointerEvents="none">
            {COUNTRY_LABELS.map((c) => {
              const s = toScreen(c);
              if (s.x < 0 || s.y < 0 || s.x > size.w || s.y > size.h) return null;
              return (
                <text key={c.name} x={s.x} y={s.y} textAnchor="middle" fontSize={zoom > 5 ? 13 : 11} fontWeight="700"
                  letterSpacing="1.4" fill={theme.text} opacity="0.9">{c.name}</text>
              );
            })}
            {SEA_LABELS.map((s0) => {
              const s = toScreen(s0);
              if (s.x < 0 || s.y < 0 || s.x > size.w || s.y > size.h) return null;
              if (s0.size === 'sm' && zoom < 5) return null;
              const fs = s0.size === 'lg' ? (zoom > 5 ? 14 : 12) : s0.size === 'md' ? 11 : 9.5;
              return (
                <text key={s0.name} x={s.x} y={s.y} textAnchor="middle" fontSize={fs} fontStyle="italic"
                  fontWeight="600" letterSpacing="1.8" fill={theme.seaText} opacity="0.85">{s0.name}</text>
              );
            })}
          </g>
        )}

        {/* Graticule labels */}
        {showGraticule && (
          <g pointerEvents="none">
            {graticule.lines.map((l, i) => (
              <text key={i} x={l.vertical ? l.x + 3 : 4} y={l.vertical ? 11 : l.y - 3}
                fontSize="9" fill={theme.graticule} opacity="0.95" fontFamily="ui-monospace, monospace">{l.label}</text>
            ))}
          </g>
        )}
      </svg>

      {/* Hover tooltip */}
      {hover && (
        <div
          className="absolute z-30 pointer-events-none bg-white/97 backdrop-blur border border-gray-300 rounded shadow-lg px-2.5 py-1.5 text-[11px] max-w-[260px]"
          style={{ left: Math.min(hover.x + 12, size.w - 230), top: Math.max(6, hover.y - 14) }}
        >
          <div className="font-bold text-gray-900">{hover.m.label ?? hover.m.id}</div>
          {hover.m.sublabel && <div className="text-gray-600 mt-0.5">{hover.m.sublabel}</div>}
          {hover.m.meta && (
            <div className="mt-1 pt-1 border-t border-gray-200 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              {Object.entries(hover.m.meta).map(([k, v]) => (
                <div key={k} className="contents">
                  <span className="text-gray-500">{k}</span>
                  <span className="text-gray-900 font-medium font-mono">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Zoom control */}
      {interactive && (
        <div className="absolute top-3 right-3 z-20 flex flex-col gap-1.5">
          <div className="bg-white rounded shadow-md flex flex-col overflow-hidden border border-gray-300">
            <button onClick={() => zoomBy(0.6)} title="Zoom in"
              className="w-8 h-8 hover:bg-gray-100 text-gray-800 text-lg leading-none font-semibold border-b border-gray-200">+</button>
            <button onClick={() => zoomBy(-0.6)} title="Zoom out"
              className="w-8 h-8 hover:bg-gray-100 text-gray-800 text-lg leading-none font-semibold">−</button>
          </div>
          <button
            onClick={() => { setCentre(initialCentre); setZoom(initialZoom); }}
            title="Reset view"
            className="w-8 h-8 bg-white rounded shadow-md border border-gray-300 hover:bg-gray-100 flex items-center justify-center"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-700">
              <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" fill="currentColor" />
            </svg>
          </button>
        </div>
      )}

      {legend}
      {overlay}

      {/* Scale bar and readout */}
      <div className="absolute bottom-2 right-3 z-20 flex flex-col items-end gap-1 pointer-events-none">
        <div className="flex items-center gap-1.5">
          <div className="bg-white/92 px-1.5 py-0.5 rounded text-[10px] font-semibold text-gray-800 shadow-sm">{scaleBar.km} km</div>
          <div className="h-[6px] border-l-2 border-r-2 border-b-2 border-gray-800 bg-white/45" style={{ width: Math.max(18, scaleBar.px) }} />
        </div>
        <div className="bg-white/92 backdrop-blur px-2 py-1 rounded text-[10px] font-mono font-medium text-gray-800 shadow-sm">
          {cursor
            ? `${Math.abs(cursor.lat).toFixed(3)}° ${cursor.lat >= 0 ? 'N' : 'S'}  ${Math.abs(cursor.lon).toFixed(3)}° ${cursor.lon >= 0 ? 'E' : 'W'}`
            : `${Math.abs(centre.lat).toFixed(3)}° N  ${Math.abs(centre.lon).toFixed(3)}° E`}
          <span className="ml-2 text-gray-500">z{zoom.toFixed(1)}</span>
        </div>
      </div>

      {vectorLabel && vectors.length > 0 && (
        <div className="absolute bottom-2 left-3 z-20 bg-white/92 backdrop-blur px-2 py-1 rounded text-[10px] font-medium text-gray-700 shadow-sm pointer-events-none">
          {vectorLabel}
        </div>
      )}
    </div>
  );
}

/** Basemap style switcher, rendered by pages that want it above the map. */
export function BasemapSwitch({ value, onChange }: { value: BasemapStyle; onChange: (v: BasemapStyle) => void }) {
  const opts: { v: BasemapStyle; label: string }[] = [
    { v: 'map', label: 'Map' },
    { v: 'satellite', label: 'Satellite' },
    { v: 'bathymetry', label: 'Bathymetry' },
    { v: 'dark', label: 'Dark' },
  ];
  return (
    <div className="flex bg-white rounded shadow-md text-xs font-semibold overflow-hidden border border-gray-300">
      {opts.map((o, i) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2.5 py-1.5 transition-colors ${i > 0 ? 'border-l border-gray-200' : ''} ${
            value === o.v ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
