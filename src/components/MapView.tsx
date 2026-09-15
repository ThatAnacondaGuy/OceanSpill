import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LatLon } from '../lib/geo';
import { ANDAMAN_EEZ, INDIA_EEZ } from '../data/geography';
import { arrowHead, bearing, circleRing, cssColor, markerIcon, selectionRing, SlickRenderer, vectorArrow } from './mapAssets';

/**
 * Interactive map on real basemap tiles (MapLibre GL).
 *
 * The component keeps the declarative props the pages already use — markers, polygons, paths,
 * circles and field vectors — and renders them as WebGL layers above raster basemaps. Optional
 * visual effects (realistic oil slicks, flowing trajectories, animated drift particles) only
 * change how data is drawn, never the data itself.
 */

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
  /** 'oil' draws the polygon as a realistic, shimmering oil slick instead of a flat fill. */
  effect?: 'oil';
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
  /** Animate a flowing dash along the path in the direction of travel. */
  flow?: boolean;
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

/** A particle cloud replayed frame by frame (e.g. drift model steps). Purely visual. */
export interface MapParticles {
  id: string;
  tone: 'oil' | 'hindcast';
  frames: { points: LatLon[]; label?: string }[];
  /** Milliseconds for one pass through all frames. */
  durationMs?: number;
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
  particles?: MapParticles[];
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

// Pages pass zoom levels for 256 px tiles; MapLibre uses 512 px tiles, one level lower.
const ZOOM_OFFSET = 1;

const ESRI = (service: string) => [`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`];

const BASEMAP_LAYERS: Record<BasemapStyle, string[]> = {
  map: ['bm-street'],
  satellite: ['bm-imagery', 'bm-imagery-labels'],
  bathymetry: ['bm-ocean', 'bm-ocean-labels'],
  dark: ['bm-dark', 'bm-dark-labels'],
};
const ALL_BASEMAP_LAYERS = Object.values(BASEMAP_LAYERS).flat();

const ATTRIBUTION: Record<BasemapStyle, string> = {
  map: 'Esri, HERE, Garmin, USGS, NGA, © OpenStreetMap contributors',
  dark: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
  satellite: 'Imagery © Esri, Maxar, Earthstar Geographics',
  bathymetry: 'Esri, GEBCO, NOAA, Garmin, HERE',
};

const MARKER_LAYERS = ['mk-icons'];

function baseStyle(): maplibregl.StyleSpecification {
  const raster = (tiles: string[], maxzoom = 19): maplibregl.RasterSourceSpecification => ({ type: 'raster', tiles, tileSize: 256, maxzoom });
  const emptyFc = { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } };
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      // Esri serves placeholder tiles offshore beyond these zooms, so overzoom instead.
      street: raster(ESRI('World_Street_Map'), 15),
      dark: raster(ESRI('Canvas/World_Dark_Gray_Base'), 15),
      darkLabels: raster(ESRI('Canvas/World_Dark_Gray_Reference'), 15),
      imagery: raster(ESRI('World_Imagery'), 13),
      imageryLabels: raster(ESRI('Reference/World_Boundaries_and_Places'), 13),
      ocean: raster(ESRI('Ocean/World_Ocean_Base'), 10),
      oceanLabels: raster(ESRI('Ocean/World_Ocean_Reference'), 10),
      graticule: emptyFc, eez: emptyFc, vectors: emptyFc, polygons: emptyFc, circles: emptyFc,
      particles: emptyFc, paths: emptyFc, arrows: emptyFc, markers: emptyFc, circleLabels: emptyFc,
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#aad3df' } },
      { id: 'bm-street', type: 'raster', source: 'street', paint: { 'raster-fade-duration': 150 } },
      { id: 'bm-dark', type: 'raster', source: 'dark', layout: { visibility: 'none' } },
      { id: 'bm-dark-labels', type: 'raster', source: 'darkLabels', layout: { visibility: 'none' } },
      { id: 'bm-imagery', type: 'raster', source: 'imagery', layout: { visibility: 'none' } },
      { id: 'bm-imagery-labels', type: 'raster', source: 'imageryLabels', layout: { visibility: 'none' } },
      { id: 'bm-ocean', type: 'raster', source: 'ocean', layout: { visibility: 'none' } },
      { id: 'bm-ocean-labels', type: 'raster', source: 'oceanLabels', layout: { visibility: 'none' } },

      { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': '#5b7f99', 'line-width': 0.5, 'line-opacity': 0.35 } },
      { id: 'eez', type: 'line', source: 'eez', paint: { 'line-color': '#2c7fb8', 'line-width': 1.3, 'line-opacity': 0.8, 'line-dasharray': [4, 3] } },

      { id: 'vectors', type: 'symbol', source: 'vectors', layout: {
        'icon-image': ['get', 'icon'], 'icon-size': ['get', 'size'], 'icon-rotate': ['get', 'rot'],
        'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      }, paint: { 'icon-opacity': 0.85 } },

      { id: 'poly-fill', type: 'fill', source: 'polygons', filter: ['!=', ['get', 'effect'], 'oil'], layout: { 'fill-sort-key': ['get', 'z'] },
        paint: { 'fill-color': ['to-color', ['get', 'fill']], 'fill-opacity': ['get', 'opacity'] } },
      { id: 'poly-line', type: 'line', source: 'polygons', filter: ['all', ['!=', ['get', 'effect'], 'oil'], ['!', ['get', 'dashed']]], layout: { 'line-join': 'round', 'line-sort-key': ['get', 'z'] },
        paint: { 'line-color': ['to-color', ['get', 'stroke']], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] } },
      { id: 'poly-line-dash', type: 'line', source: 'polygons', filter: ['all', ['!=', ['get', 'effect'], 'oil'], ['get', 'dashed']], layout: { 'line-join': 'round' },
        paint: { 'line-color': ['to-color', ['get', 'stroke']], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'], 'line-dasharray': [3, 2] } },

      { id: 'circle-fill', type: 'fill', source: 'circles', paint: { 'fill-color': ['to-color', ['get', 'fill']], 'fill-opacity': ['get', 'opacity'] } },
      { id: 'circle-line', type: 'line', source: 'circles', filter: ['!', ['get', 'dashed']], paint: { 'line-color': ['to-color', ['get', 'stroke']], 'line-width': 1.4, 'line-opacity': ['get', 'opacity'] } },
      { id: 'circle-line-dash', type: 'line', source: 'circles', filter: ['get', 'dashed'], paint: { 'line-color': ['to-color', ['get', 'stroke']], 'line-width': 1.4, 'line-opacity': ['get', 'opacity'], 'line-dasharray': [3, 2] } },

      // Each particle is a parcel of oil about a kilometre across, so kernels scale with the map.
      { id: 'particles-heat-oil', type: 'heatmap', source: 'particles', filter: ['==', ['get', 'tone'], 'oil'], paint: {
        'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 3, 2.5, 7, 3.5, 9, 7, 11, 27, 13, 106, 14, 212],
        'heatmap-intensity': 1,
        'heatmap-weight': 0.14,
        'heatmap-opacity': 0.92,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)', 0.04, 'rgba(205,210,220,0.16)', 0.12, 'rgba(170,140,200,0.26)', 0.22, 'rgba(110,160,170,0.32)',
          0.34, 'rgba(150,110,60,0.45)', 0.5, 'rgba(105,70,36,0.62)', 0.7, 'rgba(58,40,24,0.78)', 0.88, 'rgba(30,22,15,0.86)', 1, 'rgba(16,12,9,0.9)'],
      } },
      { id: 'particles-heat-hind', type: 'heatmap', source: 'particles', filter: ['==', ['get', 'tone'], 'hindcast'], paint: {
        'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 3, 2, 7, 3, 9, 6, 11, 22, 13, 85, 14, 170],
        'heatmap-intensity': 1,
        'heatmap-weight': 0.12,
        'heatmap-opacity': 0.6,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)', 0.1, 'rgba(253,230,138,0.18)', 0.4, 'rgba(251,191,36,0.38)', 0.75, 'rgba(217,119,6,0.55)', 1, 'rgba(180,83,9,0.7)'],
      } },
      { id: 'particles-dots', type: 'circle', source: 'particles', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 10, 1.4, 14, 2.2],
        'circle-color': ['match', ['get', 'tone'], 'oil', '#1a140e', '#fbbf24'],
        'circle-opacity': ['match', ['get', 'tone'], 'oil', 0.5, 0.7],
      } },

      { id: 'path-line', type: 'line', source: 'paths', filter: ['!', ['get', 'dashed']], layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'z'] },
        paint: { 'line-color': ['to-color', ['get', 'stroke']], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] } },
      { id: 'path-line-dash', type: 'line', source: 'paths', filter: ['get', 'dashed'], layout: { 'line-join': 'round' },
        paint: { 'line-color': ['to-color', ['get', 'stroke']], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'], 'line-dasharray': [2.5, 2] } },
      { id: 'path-flow', type: 'line', source: 'paths', filter: ['get', 'flow'], layout: { 'line-cap': 'butt' },
        paint: { 'line-color': '#ffffff', 'line-width': ['max', 1, ['*', ['get', 'width'], 0.55]], 'line-opacity': 0.75, 'line-dasharray': [0, 4, 3] } },
      { id: 'path-arrows', type: 'symbol', source: 'arrows', layout: {
        'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['get', 'size'],
      }, paint: { 'icon-opacity': ['get', 'opacity'] } },

      { id: 'mk-rings', type: 'symbol', source: 'markers', filter: ['get', 'selected'], layout: {
        'icon-image': ['get', 'ring'], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'z'],
      } },
      { id: 'mk-icons', type: 'symbol', source: 'markers', layout: {
        'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'z'],
      }, paint: { 'icon-opacity': ['get', 'opacity'] } },
      { id: 'mk-labels', type: 'symbol', source: 'markers', minzoom: 5.4 - ZOOM_OFFSET, filter: ['!', ['get', 'selected']], layout: {
        'text-field': ['get', 'label'], 'text-font': ['Open Sans Semibold'], 'text-size': 11, 'text-anchor': 'left',
        'text-offset': [0.9, 0], 'text-optional': true, 'symbol-sort-key': ['-', 100, ['get', 'z']],
      }, paint: { 'text-color': '#1f2937', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6, 'text-opacity': ['get', 'opacity'] } },
      { id: 'mk-labels-selected', type: 'symbol', source: 'markers', filter: ['get', 'selected'], layout: {
        'text-field': ['get', 'label'], 'text-font': ['Open Sans Semibold'], 'text-size': 11.5, 'text-anchor': 'left',
        'text-offset': [1.1, 0], 'text-allow-overlap': true,
      }, paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 } },
      { id: 'circle-labels', type: 'symbol', source: 'circleLabels', filter: ['>=', ['zoom'], ['get', 'minz']], layout: {
        'text-field': ['get', 'label'], 'text-font': ['Open Sans Semibold'], 'text-size': 10, 'text-anchor': 'bottom', 'text-offset': [0, -0.3],
      }, paint: { 'text-color': ['to-color', ['get', 'color']], 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 } },
    ],
  };
}

type Feature = GeoJSON.Feature;
const NO_PARTICLES: MapParticles[] = [];
const fc = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });
const lngLat = (p: LatLon): [number, number] => [p.lon, p.lat];

function ensureImage(map: MlMap, name: string, make: () => { data: ImageData; pixelRatio: number }) {
  if (!map.hasImage(name)) {
    const img = make();
    map.addImage(name, img.data, { pixelRatio: img.pixelRatio });
  }
}

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
  particles = NO_PARTICLES,
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
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  // The map whose style has finished loading; guards effects while a map is being recreated.
  const styledMap = useRef<MlMap | null>(null);
  const [hover, setHover] = useState<{ m: MapMarker; x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<LatLon | null>(null);
  const [view, setView] = useState({ lat: initialCentre.lat, lon: initialCentre.lon, zoom: initialZoom - ZOOM_OFFSET });
  const [frameLabel, setFrameLabel] = useState<string | null>(null);
  const [animating, setAnimating] = useState(true);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  const markersRef = useRef(markers);
  markersRef.current = markers;
  const clickRef = useRef({ onMarkerClick, onMapClick, interactive });
  clickRef.current = { onMarkerClick, onMapClick, interactive };
  const pulseMarkers = useRef(new Map<string, maplibregl.Marker>());
  const slicks = useRef(new Map<string, { id: string; renderer: SlickRenderer }>());
  const slickSeq = useRef(0);
  const [slickCount, setSlickCount] = useState(0);
  const fitDone = useRef<string | undefined>(undefined);
  const fitBounds = useRef<[[number, number], [number, number]] | null>(null);

  // ---- create the map once ---------------------------------------------------------------------
  useEffect(() => {
    if (!canvasHostRef.current) return;
    const map = new maplibregl.Map({
      container: canvasHostRef.current,
      style: baseStyle(),
      center: lngLat(initialCentre),
      zoom: initialZoom - ZOOM_OFFSET,
      minZoom: 1.2,
      maxZoom: 16,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: false,
      fadeDuration: 120,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    styledMap.current = null;
    fitDone.current = undefined;
    setReady(false);
    const markReady = () => {
      styledMap.current = map;
      setReady(true);
    };

    // Layers and sources exist once the style is parsed; no need to wait for basemap tiles.
    map.once('style.load', markReady);
    map.once('load', markReady);
    map.on('error', (e) => {
      const msg = String((e as { error?: Error }).error?.message ?? '');
      if (/tile|Failed to fetch|AJAXError/i.test(msg)) setTilesFailed(true);
    });
    map.on('move', () => {
      const c = map.getCenter();
      setView({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    });
    map.on('mousemove', (e) => setCursor({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    map.on('mouseout', () => { setCursor(null); setHover(null); });

    const onEnter = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const m = markersRef.current.find((x) => x.id === f.properties?.id);
      if (m) {
        map.getCanvas().style.cursor = clickRef.current.onMarkerClick ? 'pointer' : '';
        setHover({ m, x: e.point.x, y: e.point.y });
      }
    };
    map.on('mousemove', 'mk-icons', onEnter);
    map.on('mouseleave', 'mk-icons', () => { map.getCanvas().style.cursor = ''; setHover(null); });
    map.on('click', (e) => {
      const { onMarkerClick: omc, onMapClick: opc, interactive: live } = clickRef.current;
      if (!live) return;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]];
      const hit = map.getLayer('mk-icons') ? map.queryRenderedFeatures(box, { layers: MARKER_LAYERS }) : [];
      if (hit.length) {
        const m = markersRef.current.find((x) => x.id === hit[0].properties?.id);
        if (m) { omc?.(m); return; }
      }
      opc?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    // Like the previous map, re-fit to the data when the frame changes size.
    let lastSize = { w: canvasHostRef.current.clientWidth, h: canvasHostRef.current.clientHeight };
    let refit = 0;
    const ro = new ResizeObserver((entries) => {
      map.resize();
      const { width: w, height: h } = entries[0].contentRect;
      if (Math.abs(w - lastSize.w) < 40 && Math.abs(h - lastSize.h) < 40) return;
      lastSize = { w, h };
      window.clearTimeout(refit);
      refit = window.setTimeout(() => {
        if (fitBounds.current && w > 50) map.fitBounds(fitBounds.current, { padding: 12, maxZoom: 12, duration: 0 });
      }, 150);
    });
    ro.observe(canvasHostRef.current);
    return () => {
      ro.disconnect();
      window.clearTimeout(refit);
      pulseMarkers.current.forEach((mk) => mk.remove());
      pulseMarkers.current.clear();
      slicks.current.clear();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- interaction toggle --------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handlers = [map.scrollZoom, map.boxZoom, map.dragPan, map.keyboard, map.doubleClickZoom, map.touchZoomRotate];
    handlers.forEach((h) => (interactive ? h.enable() : h.disable()));
    if (interactive) map.touchZoomRotate.disableRotation();
  }, [interactive, ready]);

  // ---- basemap ---------------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    const visible = new Set(BASEMAP_LAYERS[basemap].filter((id) => showLabels || !id.endsWith('-labels')));
    for (const id of ALL_BASEMAP_LAYERS) map.setLayoutProperty(id, 'visibility', visible.has(id) ? 'visible' : 'none');
    map.setPaintProperty('bg', 'background-color', basemap === 'dark' ? '#0b1726' : basemap === 'satellite' ? '#07131f' : '#aad3df');
    const darkText = basemap === 'map' || basemap === 'bathymetry';
    for (const id of ['mk-labels', 'mk-labels-selected']) {
      map.setPaintProperty(id, 'text-color', darkText ? '#1f2937' : '#e5eef5');
      map.setPaintProperty(id, 'text-halo-color', darkText ? '#ffffff' : '#0a1622');
    }
    map.setPaintProperty('eez', 'line-color', darkText ? '#2c7fb8' : '#5fc9f3');
    map.setPaintProperty('graticule', 'line-color', darkText ? '#5b7f99' : '#6f93ad');
  }, [basemap, ready, showLabels]);

  // ---- static overlays -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    const src = map.getSource('eez') as GeoJSONSource;
    src.setData(fc(showEez ? [INDIA_EEZ, ANDAMAN_EEZ].map((ring) => ({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [...ring, ring[0]].map(lngLat) },
    })) : []));
  }, [showEez, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    const draw = () => {
      if (!showGraticule) { (map.getSource('graticule') as GeoJSONSource).setData(fc([])); return; }
      const z = map.getZoom() + ZOOM_OFFSET;
      const step = z > 8 ? 0.25 : z > 6.5 ? 1 : z > 5 ? 2 : z > 3.5 ? 5 : 10;
      const b = map.getBounds();
      const lines: Feature[] = [];
      for (let lon = Math.floor(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
        lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[lon, Math.max(-85, b.getSouth() - step)], [lon, Math.min(85, b.getNorth() + step)]] } });
      }
      for (let lat = Math.floor(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
        lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[b.getWest() - step, lat], [b.getEast() + step, lat]] } });
      }
      (map.getSource('graticule') as GeoJSONSource).setData(fc(lines));
    };
    draw();
    map.on('moveend', draw);
    return () => { map.off('moveend', draw); };
  }, [showGraticule, ready]);

  // ---- data layers -----------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    const features: Feature[] = [];
    for (const v of vectors) {
      const color = cssColor(v.color ?? (basemap === 'map' || basemap === 'bathymetry' ? '#1d6fa5' : '#67c7f0'));
      const icon = `vec|${color}`;
      ensureImage(map, icon, () => vectorArrow(color));
      features.push({ type: 'Feature', properties: { icon, rot: v.dirDeg, size: Math.min(26, 6 + v.magnitude * 11) / 26 }, geometry: { type: 'Point', coordinates: lngLat(v.position) } });
    }
    (map.getSource('vectors') as GeoJSONSource).setData(fc(features));
  }, [vectors, basemap, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    const features: Feature[] = [...polygons].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((p) => ({
      type: 'Feature',
      properties: {
        id: p.id, fill: cssColor(p.fill), stroke: cssColor(p.stroke), opacity: p.opacity ?? 1, z: p.z ?? 0,
        width: (p.strokeWidth ?? 1.4) * (p.selected ? 1.9 : 1), dashed: Boolean(p.dash), effect: p.effect ?? 'none',
      },
      // Each ring is its own shape (slick fragments are separate patches, not holes).
      geometry: { type: 'MultiPolygon', coordinates: p.rings.filter((r) => r.length >= 3).map((r) => [[...r, r[0]].map(lngLat)]) },
    }));
    (map.getSource('polygons') as GeoJSONSource).setData(fc(features.filter((f) => (f.geometry as GeoJSON.MultiPolygon).coordinates.length)));

    // Oil slicks are drawn by canvas sources, one per polygon, beneath the outline layers.
    const wanted = new Map<string, MapPolygon>();
    for (const p of polygons) {
      if (p.effect !== 'oil') continue;
      const key = `${p.id}|${p.rings.map((r) => r.map((q) => `${q.lat.toFixed(5)},${q.lon.toFixed(5)}`).join(';')).join('/')}`;
      wanted.set(key, p);
    }
    for (const [key, entry] of slicks.current) {
      if (wanted.has(key)) continue;
      if (map.getLayer(entry.id)) map.removeLayer(entry.id);
      if (map.getSource(entry.id)) map.removeSource(entry.id);
      slicks.current.delete(key);
    }
    for (const [key, p] of wanted) {
      if (slicks.current.has(key)) continue;
      const rings = p.rings.filter((r) => r.length >= 3);
      if (!rings.length) continue;
      const renderer = new SlickRenderer(rings);
      renderer.draw(0);
      const id = `oil-${++slickSeq.current}`;
      map.addSource(id, { type: 'canvas', canvas: renderer.canvas, coordinates: renderer.coordinates, animate: true });
      map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-fade-duration': 0, 'raster-opacity': p.opacity ?? 1 } }, 'poly-line');
      slicks.current.set(key, { id, renderer });
    }
    setSlickCount(slicks.current.size);
  }, [polygons, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    const rings: Feature[] = [];
    const labels: Feature[] = [];
    for (const c of circles) {
      if (!(c.radiusKm > 0)) continue;
      rings.push({
        type: 'Feature',
        properties: { fill: cssColor(c.fill), stroke: cssColor(c.stroke), opacity: c.opacity ?? 1, dashed: Boolean(c.dash) },
        geometry: { type: 'Polygon', coordinates: [circleRing(c.centre.lat, c.centre.lon, c.radiusKm)] },
      });
      if (c.label) {
        const top = circleRing(c.centre.lat, c.centre.lon, c.radiusKm, 4)[0];
        // Label only once the ring is wide enough on screen (radius above ~26 px).
        const minz = Math.log2((26 * 78271.51696 * Math.cos((c.centre.lat * Math.PI) / 180)) / (c.radiusKm * 1000));
        labels.push({ type: 'Feature', properties: { label: c.label, color: cssColor(c.stroke), minz }, geometry: { type: 'Point', coordinates: top } });
      }
    }
    (map.getSource('circles') as GeoJSONSource).setData(fc(rings));
    (map.getSource('circleLabels') as GeoJSONSource).setData(fc(labels));
  }, [circles, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    const lines: Feature[] = [];
    const arrows: Feature[] = [];
    for (const p of [...paths].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) {
      if (p.points.length < 2) continue;
      const stroke = cssColor(p.stroke);
      lines.push({
        type: 'Feature',
        properties: { id: p.id, stroke, width: p.strokeWidth ?? 1.8, opacity: p.opacity ?? 1, dashed: Boolean(p.dash), flow: Boolean(p.flow), z: p.z ?? 0 },
        geometry: { type: 'LineString', coordinates: p.points.map(lngLat) },
      });
      if (p.arrow) {
        const a = p.points[p.points.length - 2];
        const b = p.points[p.points.length - 1];
        const icon = `arrow|${stroke}`;
        ensureImage(map, icon, () => arrowHead(stroke));
        arrows.push({
          type: 'Feature',
          properties: { icon, rot: bearing(a, b), opacity: p.opacity ?? 1, size: Math.max(0.8, Math.min(1.5, (p.strokeWidth ?? 1.8) / 2)) },
          geometry: { type: 'Point', coordinates: lngLat(b) },
        });
      }
    }
    (map.getSource('paths') as GeoJSONSource).setData(fc(lines));
    (map.getSource('arrows') as GeoJSONSource).setData(fc(arrows));
  }, [paths, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    const features: Feature[] = [];
    const wantPulse = new Set<string>();
    for (const m of markers) {
      const color = cssColor(m.color ?? '#ef4444');
      const r = m.size ?? 6;
      const icon = `mk|${m.kind}|${color}|${r}`;
      ensureImage(map, icon, () => markerIcon(m.kind, color, r));
      let ring = '';
      if (m.selected) {
        ring = `ring|${color}|${r}`;
        ensureImage(map, ring, () => selectionRing(color, r));
      }
      features.push({
        type: 'Feature',
        properties: {
          id: m.id, icon, ring, label: m.label ?? '', selected: Boolean(m.selected), z: m.z ?? 0,
          rot: m.kind === 'vessel' ? m.headingDeg ?? 0 : 0, opacity: m.dimmed ? 0.35 : 1,
        },
        geometry: { type: 'Point', coordinates: lngLat(m.position) },
      });
      if (m.pulse && !m.dimmed) {
        const key = `${m.id}|${color}|${r}|${m.kind}`;
        wantPulse.add(key);
        const existing = pulseMarkers.current.get(key);
        if (existing) {
          existing.setLngLat(lngLat(m.position));
        } else {
          const el = document.createElement('div');
          el.className = m.kind === 'origin' ? 'os-pulse os-pulse-origin' : 'os-pulse';
          el.style.setProperty('--pulse-color', color);
          el.style.setProperty('--pulse-size', `${r * 2 + 4}px`);
          pulseMarkers.current.set(key, new maplibregl.Marker({ element: el }).setLngLat(lngLat(m.position)).addTo(map));
        }
      }
    }
    for (const [key, mk] of pulseMarkers.current) {
      if (!wantPulse.has(key)) { mk.remove(); pulseMarkers.current.delete(key); }
    }
    (map.getSource('markers') as GeoJSONSource).setData(fc(features));
    if (!showLabels) {
      map.setLayoutProperty('mk-labels', 'visibility', 'none');
      map.setLayoutProperty('mk-labels-selected', 'visibility', 'none');
    } else {
      map.setLayoutProperty('mk-labels', 'visibility', 'visible');
      map.setLayoutProperty('mk-labels-selected', 'visibility', 'visible');
    }
  }, [markers, ready, showLabels]);

  // ---- animation: oil shimmer, flowing trajectories, drift particles ---------------------------
  const hasOil = slickCount > 0;
  const hasFlow = paths.some((p) => p.flow);
  const particlesRef = useRef(particles);
  particlesRef.current = particles;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map) return;
    if (!particlesRef.current.length) {
      (map.getSource('particles') as GeoJSONSource).setData(fc([]));
      setFrameLabel(null);
    }
    if (!hasOil && !hasFlow && !particlesRef.current.length) return;

    const dashSteps = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
    let raf = 0;
    let lastSheen = 0;
    let lastDash = -1;
    const lastFrame = new Map<string, number>();
    const started = performance.now();

    const tick = (now: number) => {
      // rAF timestamps can precede the start time by a fraction of a frame.
      const elapsed = Math.max(0, now - started);
      if (hasOil && animating && now - lastSheen > 120) {
        lastSheen = now;
        const view = map.getBounds();
        for (const { renderer } of slicks.current.values()) {
          // Only redraw slicks that are on screen and large enough to see.
          const [[w, n], , [e, s]] = renderer.coordinates;
          if (e < view.getWest() || w > view.getEast() || s > view.getNorth() || n < view.getSouth()) continue;
          if (map.project([e, n]).x - map.project([w, n]).x < 4) continue;
          renderer.draw(elapsed);
        }
      }
      if (hasFlow && map.getLayer('path-flow')) {
        const step = Math.floor(elapsed / 55) % dashSteps.length;
        if (step !== lastDash) {
          lastDash = step;
          map.setPaintProperty('path-flow', 'line-dasharray', dashSteps[step]);
        }
      }
      const sets = particlesRef.current;
      if (sets.length && animating) {
        let changed = false;
        const labels: string[] = [];
        for (const set of sets) {
          const n = set.frames.length;
          if (!n) continue;
          const duration = set.durationMs ?? 9000;
          // Play through, then hold the final frame briefly before looping.
          const cycle = duration * 1.18;
          const progress = Math.min(1, (elapsed % cycle) / duration);
          const idx = Math.min(n - 1, Math.floor(progress * n));
          if (lastFrame.get(set.id) !== idx) { lastFrame.set(set.id, idx); changed = true; }
          const lbl = set.frames[idx].label;
          if (lbl) labels.push(lbl);
        }
        if (changed) {
          const features: Feature[] = [];
          for (const set of sets) {
            const frame = set.frames[lastFrame.get(set.id) ?? 0];
            if (!frame) continue;
            for (const p of frame.points) {
              features.push({ type: 'Feature', properties: { tone: set.tone }, geometry: { type: 'Point', coordinates: lngLat(p) } });
            }
          }
          (map.getSource('particles') as GeoJSONSource).setData(fc(features));
          setFrameLabel(labels.join('  ·  ') || null);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, hasOil, hasFlow, particles, animating]);

  // ---- fit to data -----------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styledMap.current !== map || !fitTo || fitTo.length === 0) return;
    const key = fitKey ?? 'default';
    const first = fitDone.current === undefined;
    if (fitDone.current === key) return;
    fitDone.current = key;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of fitTo) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    const padLat = Math.max((maxLat - minLat) * 0.35, 0.12);
    const padLon = Math.max((maxLon - minLon) * 0.35, 0.12);
    fitBounds.current = [[minLon - padLon, minLat - padLat], [maxLon + padLon, maxLat + padLat]];
    map.fitBounds(fitBounds.current, {
      padding: 12, maxZoom: 12, duration: first ? 0 : 900, essential: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready, fitTo && fitTo.length > 0]);

  const zoomBy = (d: number) => mapRef.current?.easeTo({ zoom: (mapRef.current?.getZoom() ?? 3) + d, duration: 250 });
  const resetView = () => mapRef.current?.flyTo({ center: lngLat(initialCentre), zoom: initialZoom - ZOOM_OFFSET, duration: 800 });

  const scaleBar = useMemo(() => {
    const metresPerPx = (78271.51696 * Math.cos((view.lat * Math.PI) / 180)) / Math.pow(2, view.zoom);
    const candidates = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000];
    let chosen = candidates[0];
    for (const c of candidates) if ((c * 1000) / metresPerPx <= 140) chosen = c;
    return { km: chosen, px: (chosen * 1000) / metresPerPx };
  }, [view]);

  return (
    <div ref={hostRef} className={`relative overflow-hidden select-none w-full h-full bg-[#aad3df] ${className}`}>
      <div ref={canvasHostRef} className="absolute inset-0" />

      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="w-6 h-6 border-[3px] border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {hover && (
        <div
          className="absolute z-30 pointer-events-none bg-white/95 backdrop-blur border border-gray-200 rounded-md shadow-lg px-2.5 py-1.5 text-[0.6875rem] max-w-[260px]"
          style={{ left: Math.min(hover.x + 14, (hostRef.current?.clientWidth ?? 600) - 240), top: Math.max(6, hover.y - 14) }}
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

      {interactive && (
        <div className="absolute top-3 right-3 z-20 flex flex-col gap-1.5">
          <div className="bg-white rounded-md shadow-md flex flex-col overflow-hidden border border-gray-200">
            <button onClick={() => zoomBy(0.6)} title="Zoom in" aria-label="Zoom in"
              className="w-8 h-8 hover:bg-gray-100 text-gray-800 text-lg leading-none font-semibold border-b border-gray-200">+</button>
            <button onClick={() => zoomBy(-0.6)} title="Zoom out" aria-label="Zoom out"
              className="w-8 h-8 hover:bg-gray-100 text-gray-800 text-lg leading-none font-semibold">−</button>
          </div>
          <button onClick={resetView} title="Reset view" aria-label="Reset view"
            className="w-8 h-8 bg-white rounded-md shadow-md border border-gray-200 hover:bg-gray-100 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-700">
              <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" fill="currentColor" />
            </svg>
          </button>
          {particles.length > 0 && (
            <button onClick={() => setAnimating((a) => !a)} title={animating ? 'Pause drift animation' : 'Play drift animation'}
              aria-label={animating ? 'Pause drift animation' : 'Play drift animation'}
              className="w-8 h-8 bg-white rounded-md shadow-md border border-gray-200 hover:bg-gray-100 flex items-center justify-center text-gray-700">
              {animating
                ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1" /><rect x="14" y="4" width="5" height="16" rx="1" /></svg>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z" /></svg>}
            </button>
          )}
        </div>
      )}

      {legend && (
        <>
          {/* On phones the legend folds away behind a toggle so it does not cover the map. */}
          <div className={legendOpen ? 'contents' : 'hidden sm:contents'}>{legend}</div>
          <button
            onClick={() => setLegendOpen((o) => !o)}
            className="sm:hidden absolute bottom-2 left-3 z-30 bg-white/95 border border-gray-200 rounded-md shadow-md px-2 py-1 text-[0.6875rem] font-semibold text-gray-700"
          >
            {legendOpen ? 'Hide legend' : 'Legend'}
          </button>
        </>
      )}
      {overlay}

      <div className="absolute bottom-2 right-3 z-20 flex flex-col items-end gap-1 pointer-events-none">
        {frameLabel && (
          <div className="bg-slate-900/80 text-white px-2 py-1 rounded text-[0.625rem] font-semibold font-mono shadow">{frameLabel}</div>
        )}
        <div className="flex items-center gap-1.5">
          <div className="bg-white/90 px-1.5 py-0.5 rounded text-[0.625rem] font-semibold text-gray-800 shadow-sm">{scaleBar.km} km</div>
          <div className="h-[6px] border-l-2 border-r-2 border-b-2 border-gray-800 bg-white/45" style={{ width: Math.max(18, scaleBar.px) }} />
        </div>
        <div className="bg-white/90 backdrop-blur px-2 py-1 rounded text-[0.625rem] font-mono font-medium text-gray-800 shadow-sm hidden sm:block">
          {cursor
            ? `${Math.abs(cursor.lat).toFixed(3)}° ${cursor.lat >= 0 ? 'N' : 'S'}  ${Math.abs(cursor.lon).toFixed(3)}° ${cursor.lon >= 0 ? 'E' : 'W'}`
            : `${Math.abs(view.lat).toFixed(3)}° N  ${Math.abs(view.lon).toFixed(3)}° E`}
          <span className="ml-2 text-gray-500">z{(view.zoom + ZOOM_OFFSET).toFixed(1)}</span>
        </div>
        <div className="bg-white/80 px-1.5 py-0.5 rounded text-[0.53125rem] text-gray-600 max-w-[260px] truncate" title={ATTRIBUTION[basemap]}>
          {tilesFailed ? 'Basemap tiles unavailable offline · ' : ''}{ATTRIBUTION[basemap]}
        </div>
      </div>

      {vectorLabel && vectors.length > 0 && (
        <div className={`absolute ${legend ? 'bottom-10 sm:bottom-2' : 'bottom-2'} left-3 z-20 bg-white/90 backdrop-blur px-2 py-1 rounded text-[0.625rem] font-medium text-gray-700 shadow-sm pointer-events-none max-w-[55%]`}>
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
    { v: 'bathymetry', label: 'Ocean' },
    { v: 'dark', label: 'Dark' },
  ];
  return (
    <div className="flex bg-white rounded-md shadow-md text-[0.6875rem] sm:text-xs font-semibold overflow-hidden border border-gray-200">
      {opts.map((o, i) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2 sm:px-2.5 py-1.5 transition-colors ${i > 0 ? 'border-l border-gray-200' : ''} ${
            value === o.v ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
