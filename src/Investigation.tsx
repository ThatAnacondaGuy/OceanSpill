import { useEffect, useMemo, useState } from 'react';
import {
  Search, Ship, Crosshair, Wind, Waves, Clock, AlertTriangle, CheckCircle2, XCircle,
  Send, Radio, Scale, Sliders, ChevronRight, EyeOff, Beaker, Leaf, Info, Layers, FlaskConical,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPolygon, type MapPath, type MapCircle } from './components/MapView';
import {
  Tabs, Tier, StatusBadge, Badge, Button, ScoreBar, KeyValue, SearchInput, Toggle,
  InfoBanner, Modal, Field, Select, TextArea, Slider, LineChart, EmptyState, TimeScrubber, usePlayback,
} from './components/ui';
import { analysePolygon, formatBearing, type LatLon } from './lib/geo';
import { interpolateTrack } from './engine/attribution';
import { OIL_TYPES } from './engine/drift';
import { MODEL_METRICS, segmentationStats } from './engine/detection';
import { ECOLOGICAL_AREAS } from './data/geography';
import { DEFAULT_WEIGHTS } from './engine/attribution';

export default function Investigation() {
  const store = useStore();
  const { world, now, selectedCaseId, setSelectedCaseId, getAnalysis, navigate, weights, setWeights, resetWeights, revision } = store;

  const [query, setQuery] = useState('');
  const [basemap, setBasemap] = useState<BasemapStyle>('satellite');
  const [tab, setTab] = useState('detection');
  const [layers, setLayers] = useState({
    slick: true, hindcast: true, ensemble: true, forecast: true, tracks: true,
    candidates: true, esa: true, uncertainty: true,
  });
  const [layersOpen, setLayersOpen] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [lookalikeOpen, setLookalikeOpen] = useState(false);
  const [focusMmsi, setFocusMmsi] = useState<string | null>(null);

  const cases = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.cases
      .filter((c) => !q || `${c.id} ${c.subRegion} ${c.status}`.toLowerCase().includes(q))
      .sort((a, b) => b.detection.acquiredAt - a.detection.acquiredAt);
  }, [world.cases, query, revision]);

  const active = world.cases.find((c) => c.id === selectedCaseId) ?? cases[0] ?? null;
  const analysis = active ? getAnalysis(active.id) : null;

  // AIS replay window spans the discharge window plus the acquisition.
  const replayBounds = useMemo(() => {
    if (!analysis || !active) return { min: now - 3600_000, max: now };
    return {
      min: Math.min(analysis.windowStart, analysis.hindcast.estimatedTime) - 3 * 3600_000,
      max: active.detection.acquiredAt + 2 * 3600_000,
    };
  }, [analysis, active, now]);

  const playback = usePlayback(replayBounds.min, replayBounds.max, replayBounds.max);

  useEffect(() => {
    playback.setValue(replayBounds.max);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  const shape = useMemo(() => (active ? analysePolygon(active.detection.polygon.ring) : null), [active]);

  const mapLayers = useMemo(() => {
    if (!active || !analysis || !shape) {
      return { markers: [] as MapMarker[], polygons: [] as MapPolygon[], paths: [] as MapPath[], circles: [] as MapCircle[] };
    }
    const markers: MapMarker[] = [];
    const polygons: MapPolygon[] = [];
    const paths: MapPath[] = [];
    const circles: MapCircle[] = [];

    if (layers.esa) {
      for (const area of ECOLOGICAL_AREAS) {
        const threat = analysis.threatenedAreas.find((t) => t.id === area.id);
        if (!threat || threat.distanceKm > 320) continue;
        polygons.push({
          id: area.id, rings: [area.ring],
          fill: threat.hoursToImpact !== null ? 'rgba(220,38,38,0.2)' : 'rgba(16,185,129,0.18)',
          stroke: threat.hoursToImpact !== null ? '#dc2626' : '#059669', strokeWidth: 1.3, z: 0,
        });
      }
    }

    if (layers.slick) {
      polygons.push({
        id: 'slick', rings: [active.detection.polygon.ring, ...(active.detection.polygon.fragments ?? [])],
        fill: 'rgba(15,23,42,0.72)', stroke: '#f8fafc', strokeWidth: 1.6, z: 6,
      });
    }

    if (layers.ensemble) {
      analysis.hindcast.ensemble.forEach((e, i) => {
        paths.push({ id: `ens-${i}`, points: e.path, stroke: '#f59e0b', strokeWidth: 0.8, opacity: 0.28, z: 2 });
      });
    }

    if (layers.hindcast) {
      paths.push({ id: 'hindcast', points: analysis.hindcast.path, stroke: '#f59e0b', strokeWidth: 2.6, dash: '8 4', arrow: true, z: 4 });
      markers.push({
        id: 'origin', position: analysis.hindcast.estimatedOrigin, kind: 'origin', color: '#f59e0b', size: 9,
        label: 'Hindcast origin', sublabel: fmt.utc(analysis.hindcast.estimatedTime), z: 8,
        meta: {
          'Uncertainty': `±${analysis.hindcast.uncertaintyRadiusKm.toFixed(1)} km`,
          'Window': `±${analysis.hindcast.timeWindowHours.toFixed(1)} h`,
          'Confidence': fmt.pct(analysis.hindcast.confidence),
        },
      });
    }

    if (layers.uncertainty) {
      circles.push({
        id: 'unc', centre: analysis.hindcast.estimatedOrigin, radiusKm: analysis.hindcast.uncertaintyRadiusKm,
        fill: 'rgba(245,158,11,0.13)', stroke: '#f59e0b', dash: '5 4', label: `±${analysis.hindcast.uncertaintyRadiusKm.toFixed(0)} km`,
      });
      circles.push({
        id: 'search', centre: analysis.hindcast.estimatedOrigin, radiusKm: analysis.searchRadiusKm,
        fill: 'rgba(59,130,246,0.06)', stroke: '#3b82f6', dash: '3 6', label: `AIS search ${analysis.searchRadiusKm.toFixed(0)} km`,
      });
    }

    if (layers.forecast) {
      paths.push({ id: 'forecast', points: analysis.forecast.path, stroke: '#06b6d4', strokeWidth: 2.4, arrow: true, z: 4 });
      for (const h of analysis.forecast.horizons) {
        circles.push({
          id: `fc-${h.hours}`, centre: h.centroid, radiusKm: Math.max(h.spreadKm, 1.5),
          fill: 'rgba(6,182,212,0.1)', stroke: '#06b6d4', dash: '4 3', opacity: 0.85, label: `+${h.hours} h`,
        });
      }
    }

    if (layers.tracks || layers.candidates) {
      for (const score of analysis.ranked) {
        const track = world.tracks.get(score.mmsi);
        const vessel = world.vesselsByMmsi.get(score.mmsi);
        if (!track || !vessel) continue;
        const isTop = score.rank === 1;
        const focused = focusMmsi === score.mmsi;
        const dim = focusMmsi !== null && !focused;
        const color = score.darkDuringWindow ? '#dc2626' : isTop ? '#f43f5e' : score.rank <= 3 ? '#f97316' : '#64748b';

        if (layers.tracks) {
          const pts = track.pings.filter((p) => p.t >= replayBounds.min && p.t <= playback.value);
          if (pts.length > 1) {
            paths.push({
              id: `trk-${score.mmsi}`, points: pts, stroke: color,
              strokeWidth: focused ? 2.6 : isTop ? 2.1 : 1.3,
              opacity: dim ? 0.2 : isTop || focused ? 0.95 : 0.55, z: isTop ? 5 : 3,
            });
          }
          // Draw the transmission gap as a dashed inference, not a solid track.
          for (const g of track.gaps) {
            if (g.end < replayBounds.min || g.start > playback.value) continue;
            const a = track.pings.filter((p) => p.t <= g.start).pop();
            const b = track.pings.find((p) => p.t >= g.end);
            if (a && b) {
              paths.push({
                id: `gap-${score.mmsi}-${g.start}`, points: [a, b], stroke: '#dc2626',
                strokeWidth: 1.8, dash: '3 5', opacity: dim ? 0.2 : 0.8, z: 4,
              });
            }
          }
        }

        if (layers.candidates) {
          const at = interpolateTrack(track, playback.value);
          const isDarkNow = track.gaps.some((g) => playback.value >= g.start && playback.value <= g.end);
          if (at) {
            markers.push({
              id: `v-${score.mmsi}`, position: at, kind: 'vessel', color, size: focused ? 8 : isTop ? 7 : 5.5,
              headingDeg: at.cog, label: vessel.name, sublabel: `Rank ${score.rank} · score ${(score.total * 100).toFixed(0)}`,
              selected: focused, dimmed: dim, z: isTop ? 9 : 7,
              meta: {
                MMSI: vessel.mmsi, Type: vessel.type, Speed: `${at.sog.toFixed(1)} kn`,
                Course: `${at.cog.toFixed(0)}°`, CPA: `${score.cpaKm.toFixed(1)} km`,
              },
            });
          } else if (isDarkNow) {
            const last = track.pings.filter((p) => p.t < playback.value).pop();
            if (last) {
              markers.push({
                id: `v-dark-${score.mmsi}`, position: last, kind: 'vessel', color: '#dc2626',
                size: 6, headingDeg: last.cog, label: `${vessel.name} (dark)`,
                sublabel: 'Transponder silent — last known position', dimmed: dim, pulse: true, z: 8,
                meta: { MMSI: vessel.mmsi, 'Dark for': `${score.darkMinutes} min` },
              });
            }
          }
        }
      }
    }

    return { markers, polygons, paths, circles };
  }, [active, analysis, shape, layers, playback.value, focusMmsi, world, replayBounds.min]);

  if (!active || !analysis || !shape) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <EmptyState icon={<Search className="w-12 h-12" />} title="No case selected" body="Choose a detection from the incident queue." />
      </main>
    );
  }

  const oil = OIL_TYPES[active.oilType];
  const segStats = segmentationStats(active.detection, analysis.assessment);
  const topScore = analysis.ranked[0];
  const topVessel = topScore ? world.vesselsByMmsi.get(topScore.mmsi) : null;

  return (
    <main className="flex-1 min-h-0 flex overflow-hidden">
      {/* Case rail */}
      <aside className="w-[220px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="p-2 border-b border-gray-200">
          <SearchInput value={query} onChange={setQuery} placeholder="Filter cases…" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {cases.map((c) => {
            const a = getAnalysis(c.id);
            return (
              <button key={c.id} onClick={() => { setSelectedCaseId(c.id); setFocusMmsi(null); }}
                className={`w-full text-left px-2.5 py-2 border-b border-gray-100 ${
                  c.id === active.id ? 'bg-blue-50 border-l-[3px] border-l-blue-600' : 'hover:bg-gray-50 border-l-[3px] border-l-transparent'
                }`}>
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <span className="font-bold text-[11px] font-mono text-gray-900 truncate">{c.id}</span>
                  <Tier tier={c.tier} />
                </div>
                <p className="text-[10px] text-gray-600 truncate">{c.subRegion}</p>
                <div className="flex items-center gap-1 mt-1">
                  <StatusBadge status={c.status} />
                  {a?.ranked.some((r) => r.darkDuringWindow) && <Badge tone="red">DARK</Badge>}
                </div>
                <p className="text-[9px] text-gray-400 mt-0.5">{fmt.ago(c.detection.acquiredAt, now)}</p>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Map */}
      <section className="flex-1 min-w-0 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-bold text-sm text-gray-900 font-mono">{active.id}</span>
            <Tier tier={active.tier} />
            <StatusBadge status={active.status} />
            <span className="text-[11px] text-gray-500 truncate">{active.subRegion}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button size="sm" onClick={() => setWeightsOpen(true)} icon={<Sliders className="w-3 h-3" />}>Scoring weights</Button>
            <Button size="sm" onClick={() => setLookalikeOpen(true)} icon={<EyeOff className="w-3 h-3" />}>Reclassify</Button>
            <Button size="sm" variant="primary" onClick={() => setDispatchOpen(true)} icon={<Send className="w-3 h-3" />}>Actions</Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            markers={mapLayers.markers}
            polygons={mapLayers.polygons}
            paths={mapLayers.paths}
            circles={mapLayers.circles}
            fitTo={[...active.detection.polygon.ring, analysis.hindcast.estimatedOrigin, ...analysis.forecast.horizons.map((h) => h.centroid)]}
            fitKey={active.id}
            onMarkerClick={(m) => {
              if (m.id.startsWith('v-')) {
                const mmsi = m.id.replace('v-dark-', '').replace('v-', '');
                setFocusMmsi((f) => (f === mmsi ? null : mmsi));
                setTab('attribution');
              }
            }}
            overlay={
              <div className="absolute top-3 left-3 z-20 flex gap-2 items-start">
                <BasemapSwitch value={basemap} onChange={setBasemap} />
                <div className="relative">
                  <button onClick={() => setLayersOpen((o) => !o)}
                    className="bg-white rounded shadow-md border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" /> Layers
                  </button>
                  {layersOpen && (
                    <div className="absolute top-full mt-1 left-0 bg-white rounded shadow-xl border border-gray-300 p-2.5 w-56 z-30">
                      <p className="text-[10px] font-bold text-gray-500 uppercase mb-1.5">Analysis layers</p>
                      <Toggle checked={layers.slick} onChange={(v) => setLayers({ ...layers, slick: v })} label="Detected slick polygon" />
                      <Toggle checked={layers.hindcast} onChange={(v) => setLayers({ ...layers, hindcast: v })} label="Hindcast trajectory" />
                      <Toggle checked={layers.ensemble} onChange={(v) => setLayers({ ...layers, ensemble: v })} label="Hindcast ensemble (12)" />
                      <Toggle checked={layers.uncertainty} onChange={(v) => setLayers({ ...layers, uncertainty: v })} label="Uncertainty & search radius" />
                      <Toggle checked={layers.forecast} onChange={(v) => setLayers({ ...layers, forecast: v })} label="Forward drift forecast" />
                      <Toggle checked={layers.tracks} onChange={(v) => setLayers({ ...layers, tracks: v })} label="AIS tracks" count={analysis.ranked.length} />
                      <Toggle checked={layers.candidates} onChange={(v) => setLayers({ ...layers, candidates: v })} label="Vessel positions" />
                      <Toggle checked={layers.esa} onChange={(v) => setLayers({ ...layers, esa: v })} label="Sensitive areas" />
                      {focusMmsi && (
                        <button onClick={() => setFocusMmsi(null)} className="mt-2 w-full text-[10px] font-semibold text-blue-600 hover:underline">
                          Clear vessel focus
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2.5 text-[10px] shadow-lg">
                <h4 className="font-bold mb-1.5 text-gray-700 uppercase tracking-wide">Analysis legend</h4>
                <LegendLine color="#f8fafc" fill="rgba(15,23,42,0.72)" label="Detected slick" swatch />
                <LegendLine color="#f59e0b" label="Hindcast (backward)" dash />
                <LegendLine color="#06b6d4" label="Forecast (forward)" />
                <LegendLine color="#f43f5e" label="Leading suspect track" />
                <LegendLine color="#dc2626" label="AIS gap (inferred)" dash />
                <LegendLine color="#64748b" label="Other candidate traffic" />
              </div>
            }
          />
        </div>

        <TimeScrubber
          min={replayBounds.min} max={replayBounds.max} value={playback.value} onChange={playback.setValue}
          format={(v) => fmt.utc(v)} playing={playback.playing} onPlayToggle={playback.toggle}
          speed={playback.speed} onSpeedChange={playback.setSpeed}
          marks={[
            { t: analysis.hindcast.estimatedTime, color: '#f59e0b', label: 'Estimated discharge' },
            { t: analysis.windowStart, color: '#94a3b8', label: 'Window opens' },
            { t: analysis.windowEnd, color: '#94a3b8', label: 'Window closes' },
            { t: active.detection.acquiredAt, color: '#2563eb', label: 'Satellite acquisition' },
          ]}
        />
      </section>

      {/* Inspector */}
      <aside className="w-[390px] bg-white border-l border-gray-200 flex flex-col flex-shrink-0">
        <Tabs
          active={tab} onChange={setTab}
          tabs={[
            { id: 'detection', label: 'Detection' },
            { id: 'drift', label: 'Drift' },
            { id: 'attribution', label: 'Suspects', count: analysis.ranked.length },
            { id: 'impact', label: 'Impact' },
          ]}
        />

        <div className="flex-1 overflow-y-auto">
          {tab === 'detection' && <DetectionTab active={active} analysis={analysis} shape={shape} segStats={segStats} oil={oil} />}
          {tab === 'drift' && <DriftTab active={active} analysis={analysis} />}
          {tab === 'attribution' && (
            <AttributionTab
              analysis={analysis} world={world} focusMmsi={focusMmsi} setFocusMmsi={setFocusMmsi}
              navigate={navigate} onSeek={(t: number) => playback.setValue(t)}
            />
          )}
          {tab === 'impact' && <ImpactTab active={active} analysis={analysis} navigate={navigate} />}
        </div>

        <div className="border-t border-gray-200 p-2.5 bg-gray-50 flex-shrink-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold text-gray-600 uppercase">Overall assessment</span>
            <Badge tone={analysis.verdict.band === 'Strong' ? 'red' : analysis.verdict.band === 'Moderate' ? 'amber' : 'gray'}>
              {analysis.verdict.band}
            </Badge>
          </div>
          <p className="text-[10px] text-gray-600 leading-snug mb-2">{analysis.verdict.detail}</p>
          {topVessel && topScore && (
            <div className="bg-white border border-gray-200 rounded p-2 flex items-center gap-2">
              <Ship className="w-4 h-4 text-rose-600 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-gray-900 truncate">{topVessel.name}</p>
                <p className="text-[9.5px] text-gray-500">{topVessel.flag} · MMSI {topVessel.mmsi}</p>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-base font-black text-rose-600 leading-none">{(topScore.total * 100).toFixed(0)}</div>
                <div className="text-[9px] text-gray-400">score</div>
              </div>
            </div>
          )}
        </div>
      </aside>

      <WeightsModal open={weightsOpen} onClose={() => setWeightsOpen(false)} weights={weights} setWeights={setWeights} reset={resetWeights} />
      <ActionsModal open={dispatchOpen} onClose={() => setDispatchOpen(false)} caseId={active.id} />
      <LookalikeModal open={lookalikeOpen} onClose={() => setLookalikeOpen(false)} caseId={active.id} />
    </main>
  );
}

function LegendLine({ color, label, dash, swatch, fill }: { color: string; label: string; dash?: boolean; swatch?: boolean; fill?: string }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      {swatch
        ? <div className="w-4 h-2.5 border" style={{ background: fill, borderColor: color }} />
        : <div className="w-4 border-t-2" style={{ borderColor: color, borderStyle: dash ? 'dashed' : 'solid' }} />}
      <span className="text-gray-700">{label}</span>
    </div>
  );
}

function DetectionTab({ active, analysis, shape, segStats, oil }: any) {
  const a = analysis.assessment;
  return (
    <div className="p-3 space-y-3">
      <div className={`rounded border p-2.5 ${
        a.verdict === 'Confirmed oil' ? 'bg-red-50 border-red-200'
        : a.verdict === 'Probable oil' ? 'bg-amber-50 border-amber-200'
        : a.verdict === 'Ambiguous' ? 'bg-yellow-50 border-yellow-200' : 'bg-slate-50 border-slate-200'}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-bold text-gray-900">{a.verdict}</span>
          <span className="text-lg font-black text-gray-900">{(a.confidence * 100).toFixed(1)}%</span>
        </div>
        <div className="h-1.5 bg-white/70 rounded overflow-hidden mb-1.5">
          <div className={`h-full ${a.confidence > 0.8 ? 'bg-red-500' : a.confidence > 0.55 ? 'bg-amber-500' : 'bg-slate-400'}`}
            style={{ width: `${a.confidence * 100}%` }} />
        </div>
        <p className="text-[10px] text-gray-700 leading-snug">
          Raw segmentation output was {(a.rawModelConfidence * 100).toFixed(1)}%; the cross-checks below moved it
          to {(a.confidence * 100).toFixed(1)}%.
        </p>
        {a.lookalikeHypothesis && (
          <p className="text-[10px] font-semibold text-slate-700 mt-1.5 pt-1.5 border-t border-slate-200">
            Most likely natural alternative: {a.lookalikeHypothesis}
          </p>
        )}
      </div>

      <Section title="Look-alike discrimination" icon={<FlaskConical className="w-3.5 h-3.5" />}>
        <p className="text-[10px] text-gray-500 mb-2 leading-snug">
          Finding dark patches in SAR is easy. Separating oil from wind shadows, algal films and
          current shear is the hard part, and it is what these checks do.
        </p>
        <div className="space-y-1.5">
          {a.checks.map((c: any) => (
            <div key={c.name} className={`rounded border p-2 ${c.passed ? 'bg-emerald-50/60 border-emerald-200' : 'bg-red-50/60 border-red-200'}`}>
              <div className="flex items-start gap-1.5">
                {c.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
                  : <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0 mt-0.5" />}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10.5px] font-bold text-gray-900">{c.name}</span>
                    <span className="text-[9px] text-gray-400">weight {c.weight.toFixed(2)}</span>
                  </div>
                  <p className="text-[10px] text-gray-600 leading-snug mt-0.5">{c.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Slick geometry" icon={<Crosshair className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          ['Area', `${shape.areaKm2.toFixed(2)} km²`],
          ['Perimeter', `${shape.perimeterKm.toFixed(1)} km`],
          ['Major axis', `${shape.majorAxisKm.toFixed(2)} km`],
          ['Minor axis', `${shape.minorAxisKm.toFixed(2)} km`],
          ['Elongation', `${shape.elongation.toFixed(2)} : 1`],
          ['Compactness', shape.compactness.toFixed(3)],
          ['Orientation', `${shape.orientationDeg.toFixed(0)}° (${formatBearing(shape.orientationDeg)})`],
          ['Fragments', String(1 + (active.detection.polygon.fragments?.length ?? 0))],
        ]} />
        <div className="mt-2 bg-blue-50 border border-blue-200 rounded p-2">
          <p className="text-[10px] font-bold text-blue-900 mb-0.5">Source inference</p>
          <p className="text-[10px] text-blue-800 leading-snug">{a.sourceInference}</p>
        </div>
      </Section>

      <Section title="Weathering & age estimate" icon={<Beaker className="w-3.5 h-3.5" />}>
        <div className="bg-gray-50 border border-gray-200 rounded p-2 mb-2">
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] text-gray-600">Estimated age at acquisition</span>
            <span className="text-base font-black text-gray-900">{analysis.age.ageHours.toFixed(1)} h</span>
          </div>
          <div className="flex justify-between text-[9.5px] text-gray-500 mt-0.5">
            <span>Fit confidence</span>
            <span className="font-mono">{fmt.pct(analysis.age.confidence, 0)} · residual {analysis.age.residual.toFixed(2)}</span>
          </div>
        </div>
        <p className="text-[10px] text-gray-500 mb-2 leading-snug">
          Age is recovered by inverting the weathering model — finding the age whose predicted area and
          radar contrast best match what was observed. It is the least well-constrained output on this page.
        </p>
        <KeyValue cols={2} items={[
          ['Oil type', oil.label],
          ['Released volume', `${active.estimatedVolumeM3} m³`],
          ['Evaporated', `${analysis.weathering.evaporatedPct}%`],
          ['Water content', `${analysis.weathering.waterContentPct}%`],
          ['Film thickness', `${analysis.weathering.thicknessUm} µm`],
          ['Viscosity', `${fmt.num(analysis.weathering.viscosityCp)} cP`],
          ['Surface remaining', `${analysis.weathering.remainingPct}%`],
          ['Appearance', analysis.weathering.appearance],
        ]} />
        <div className="mt-2">
          <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Predicted area vs age</p>
          <LineChart
            height={110}
            series={[{ name: 'area', color: '#2563eb', points: analysis.age.curve.filter((_: any, i: number) => i % 4 === 0).map((c: any) => c.predictedAreaKm2) }]}
            xLabels={['0 h', '24 h', '48 h', '72 h', '96 h']}
            markers={[{ x: Math.round(analysis.age.ageHours / 2), label: 'best fit', color: '#dc2626' }]}
            yFormat={(v) => v.toFixed(1)} showArea
          />
        </div>
      </Section>

      <Section title="Acquisition" icon={<Wind className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          ['Sensor', active.detection.sensor],
          ['Mode', active.detection.mode],
          ['Polarisation', active.detection.polarisation],
          ['Resolution', `${active.detection.resolutionM} m`],
          ['Incidence', `${active.detection.incidenceAngleDeg}°`],
          ['Acquired', fmt.utc(active.detection.acquiredAt)],
          ['Wind at scene', `${analysis.conditions.wind.speed.toFixed(1)} m/s ${formatBearing(analysis.conditions.wind.dirFrom)}`],
          ['Sea state', `Bft ${analysis.conditions.sea.beaufort} · Hs ${analysis.conditions.sea.significantWaveHeightM} m`],
          ['Mean backscatter', `${active.detection.meanBackscatterDb} dB`],
          ['Contrast', `${analysis.assessment.contrastDb.toFixed(1)} dB`],
        ]} />
        <p className="text-[9.5px] text-gray-500 font-mono mt-1.5 break-all">Scene: {active.detection.sceneId}</p>
        <InfoBanner tone={analysis.conditions.sea.sarDetectability === 'Optimal' ? 'green' : 'amber'} icon={<Info className="w-3 h-3" />}>
          {analysis.assessment.detectabilityNote}
        </InfoBanner>
      </Section>

      <Section title="Segmentation model" icon={<Layers className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          ['Version', MODEL_METRICS.version],
          ['Oil-class IoU', MODEL_METRICS.classes[1].iou.toFixed(3)],
          ['Look-alike IoU', MODEL_METRICS.classes[2].iou.toFixed(3)],
          ['False positive rate', fmt.pct(MODEL_METRICS.falsePositiveRate)],
          ['Oil pixels', fmt.num(segStats.oilPixels)],
          ['Class imbalance', `1 : ${fmt.num(segStats.imbalanceRatio)}`],
        ]} />
        <p className="text-[9.5px] text-gray-500 mt-1.5 leading-snug">{MODEL_METRICS.note}</p>
      </Section>

      {active.lookalikeReason && (
        <InfoBanner tone="amber" icon={<EyeOff className="w-3.5 h-3.5" />}>
          <b>Reclassified as look-alike.</b> {active.lookalikeReason}
        </InfoBanner>
      )}
    </div>
  );
}

function DriftTab({ active, analysis }: any) {
  const hc = analysis.hindcast;
  const fc = analysis.forecast;
  return (
    <div className="p-3 space-y-3">
      <Section title="Hindcast — where it came from" icon={<Clock className="w-3.5 h-3.5" />}>
        <p className="text-[10px] text-gray-500 mb-2 leading-snug">
          A particle cloud is integrated backward from the observed slick under current + Stokes drift +
          3% windage. Twelve ensemble members with perturbed windage and diffusivity give the uncertainty.
        </p>
        <div className="bg-amber-50 border border-amber-200 rounded p-2.5 mb-2">
          <p className="text-[10px] font-bold text-amber-900 uppercase mb-1">Estimated release</p>
          <p className="font-mono text-xs font-bold text-amber-900">
            {Math.abs(hc.estimatedOrigin.lat).toFixed(4)}° N &nbsp; {Math.abs(hc.estimatedOrigin.lon).toFixed(4)}° E
          </p>
          <p className="text-[11px] text-amber-800 mt-1">{fmt.utc(hc.estimatedTime)}</p>
          <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-amber-200">
            <div>
              <p className="text-[9px] text-amber-700 uppercase font-bold">Spatial</p>
              <p className="text-[11px] font-bold text-amber-900">± {hc.uncertaintyRadiusKm.toFixed(1)} km</p>
            </div>
            <div>
              <p className="text-[9px] text-amber-700 uppercase font-bold">Temporal</p>
              <p className="text-[11px] font-bold text-amber-900">± {hc.timeWindowHours.toFixed(1)} h</p>
            </div>
          </div>
        </div>
        <KeyValue cols={2} items={[
          ['Integration', `${active.hindcastHours} h backward`],
          ['Timestep', `${hc.params.stepMinutes} min`],
          ['Particles', fmt.num(hc.params.particles)],
          ['Windage', fmt.pct(hc.params.windage)],
          ['Diffusivity', `${hc.params.diffusivity} m²/s`],
          ['Ensemble', `${hc.ensemble.length} members`],
          ['Confidence', fmt.pct(hc.confidence)],
          ['Drift distance', `${(hc.uncertaintyRadiusKm * 0 + distance(hc.path)).toFixed(1)} km`],
        ]} />
      </Section>

      <Section title="Forecast — where it is going" icon={<Waves className="w-3.5 h-3.5" />}>
        <div className="space-y-1.5">
          {fc.horizons.map((h: any) => (
            <div key={h.hours} className="flex items-center gap-2 bg-cyan-50 border border-cyan-200 rounded px-2 py-1.5">
              <div className="w-10 text-[11px] font-black text-cyan-800 flex-shrink-0">+{h.hours} h</div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[10px] text-cyan-900 truncate">
                  {h.centroid.lat.toFixed(3)}° N  {h.centroid.lon.toFixed(3)}° E
                </p>
                <p className="text-[9.5px] text-cyan-700">{fmt.utc(h.time)}</p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-[10px] font-bold text-cyan-900">± {h.spreadKm.toFixed(1)} km</p>
                <p className="text-[9px] text-cyan-600">spread</p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-gray-500 mt-2 leading-snug">
          The spread radius grows with time because turbulent diffusion and forcing uncertainty compound.
          A single predicted point would be misleading past about 24 hours.
        </p>
      </Section>

      <Section title="Forcing at the origin" icon={<Wind className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          ['Wind speed', `${analysis.conditions.wind.speed.toFixed(1)} m/s`],
          ['Wind from', `${analysis.conditions.wind.dirFrom.toFixed(0)}° ${formatBearing(analysis.conditions.wind.dirFrom)}`],
          ['Current', `${(analysis.conditions.current.speed * 1.944).toFixed(2)} kn`],
          ['Current toward', `${analysis.conditions.current.dirTo.toFixed(0)}° ${formatBearing(analysis.conditions.current.dirTo)}`],
          ['SST', `${analysis.conditions.sea.seaSurfaceTempC} °C`],
          ['Wave height', `${analysis.conditions.sea.significantWaveHeightM} m`],
        ]} />
      </Section>

      <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
        The drift solver is the same integration used by OpenDrift's OpenOil module and NOAA GNOME.
        The 2011 MV Rak hindcast off Mumbai used this approach against INCOIS forcing, which is the closest
        validated Indian precedent for this method.
      </InfoBanner>
    </div>
  );
}

function distance(path: LatLon[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    d += Math.hypot((b.lat - a.lat) * 110.574, (b.lon - a.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180));
  }
  return d;
}

function AttributionTab({ analysis, world, focusMmsi, setFocusMmsi, navigate, onSeek }: any) {
  const [showExcluded, setShowExcluded] = useState(false);
  return (
    <div className="p-3 space-y-3">
      <div className={`rounded border p-2.5 ${
        analysis.verdict.band === 'Strong' ? 'bg-red-50 border-red-200'
        : analysis.verdict.band === 'Moderate' ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
        <p className="text-xs font-bold text-gray-900 mb-1">{analysis.verdict.label}</p>
        <p className="text-[10px] text-gray-700 leading-snug">{analysis.verdict.detail}</p>
        <div className="flex gap-4 mt-2 pt-2 border-t border-gray-200/70 text-[10px]">
          <span className="text-gray-600">Separation from #2: <b className="text-gray-900">{(analysis.verdict.separation * 100).toFixed(1)}</b></span>
          <span className="text-gray-600">Search radius: <b className="text-gray-900">{analysis.searchRadiusKm.toFixed(0)} km</b></span>
        </div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded p-2 text-[10px] text-gray-600">
        <p className="font-bold text-gray-700 mb-0.5">Discharge window evaluated</p>
        <p className="font-mono">{fmt.utc(analysis.windowStart)}</p>
        <p className="font-mono">→ {fmt.utc(analysis.windowEnd)}</p>
        <p className="mt-1">The window is asymmetric — wider before the estimated release than after, because a
        slick can only be observed after it forms.</p>
      </div>

      {analysis.ranked.length === 0 && (
        <InfoBanner tone="red" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
          No AIS traffic intersected the discharge window. Treat this as a suspected dark-vessel event rather
          than an absence of evidence.
        </InfoBanner>
      )}

      {analysis.ranked.map((s: any) => {
        const v = world.vesselsByMmsi.get(s.mmsi);
        if (!v) return null;
        const open = focusMmsi === s.mmsi;
        return (
          <div key={s.mmsi}
            className={`rounded border transition-all ${
              s.darkDuringWindow ? 'border-red-400 border-2 bg-red-50/40'
              : open ? 'border-blue-400 border-2 bg-blue-50/30'
              : s.rank === 1 ? 'border-rose-300 bg-rose-50/30' : 'border-gray-200 bg-white'}`}>
            <button onClick={() => setFocusMmsi(open ? null : s.mmsi)} className="w-full text-left p-2.5">
              <div className="flex items-start gap-2">
                <div className={`w-6 h-6 rounded flex items-center justify-center font-black text-[11px] flex-shrink-0 ${
                  s.rank === 1 ? 'bg-rose-600 text-white' : s.rank <= 3 ? 'bg-orange-500 text-white' : 'bg-gray-300 text-gray-700'}`}>
                  {s.rank}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-[11.5px] text-gray-900 truncate">{v.name}</span>
                    {s.darkDuringWindow && <Badge tone="red">DARK VESSEL</Badge>}
                    {v.sanctioned && <Badge tone="slate">SANCTIONED</Badge>}
                  </div>
                  <p className="text-[9.5px] text-gray-500 mt-0.5">
                    {v.type} · {v.flag} · MMSI {v.mmsi}
                  </p>
                  <div className="flex gap-3 mt-1 text-[9.5px] text-gray-600">
                    <span>CPA <b className="font-mono">{s.cpaKm.toFixed(1)} km</b></span>
                    <span>Δt <b className="font-mono">{s.deltaTimeMin >= 0 ? '+' : ''}{s.deltaTimeMin.toFixed(0)} min</b></span>
                    <span>Δθ <b className="font-mono">{s.courseAlignmentDeg.toFixed(0)}°</b></span>
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className={`text-lg font-black leading-none ${s.rank === 1 ? 'text-rose-600' : 'text-gray-700'}`}>
                    {(s.total * 100).toFixed(0)}
                  </div>
                  <ChevronRight className={`w-3.5 h-3.5 text-gray-400 ml-auto mt-1 transition-transform ${open ? 'rotate-90' : ''}`} />
                </div>
              </div>
            </button>

            {open && (
              <div className="px-2.5 pb-2.5 space-y-2.5 border-t border-gray-200 pt-2.5">
                <div className="space-y-1.5">
                  <ScoreBar label={`Proximity (w ${DEFAULT_WEIGHTS.proximity})`} value={s.proximity} tone="blue" />
                  <ScoreBar label={`Temporality (w ${DEFAULT_WEIGHTS.temporality})`} value={s.temporality} tone="violet" />
                  <ScoreBar label={`Trajectory parity (w ${DEFAULT_WEIGHTS.trajectory})`} value={s.trajectory} tone="teal" />
                  <ScoreBar label={`Behaviour (w ${DEFAULT_WEIGHTS.behaviour})`} value={s.behaviour} tone="amber" />
                  <ScoreBar label={`Registry prior (w ${DEFAULT_WEIGHTS.vesselPrior})`} value={s.vesselPrior} tone="red" />
                </div>

                <div>
                  <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Why this ranking</p>
                  <ul className="space-y-1">
                    {s.reasons.map((r: string, i: number) => (
                      <li key={i} className="text-[10px] text-gray-700 leading-snug flex gap-1.5">
                        <span className="text-gray-400 flex-shrink-0">•</span><span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {s.flags.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded p-2">
                    <p className="text-[10px] font-bold text-red-900 uppercase mb-1">Registry flags</p>
                    <ul className="space-y-0.5">
                      {s.flags.map((f: string, i: number) => (
                        <li key={i} className="text-[10px] text-red-800 flex gap-1.5">
                          <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" /><span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <KeyValue cols={2} items={[
                  ['IMO', v.imo], ['Call sign', v.callSign],
                  ['Built', String(v.builtYear)], ['DWT', fmt.num(v.deadweightT)],
                  ['Operator', v.operator], ['Class', v.classSociety],
                  ['P&I club', v.piClub], ['Last port', v.lastPort],
                  ['Detentions', String(v.psc.detentions)], ['Deficiencies', String(v.psc.deficiencies)],
                ]} />

                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => onSeek(s.cpaTime)} icon={<Clock className="w-3 h-3" />}>Seek to CPA</Button>
                  <Button size="sm" onClick={() => navigate({ tab: 'Vessel Analysis', mmsi: s.mmsi })} icon={<Ship className="w-3 h-3" />}>Vessel record</Button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {analysis.excluded.length > 0 && (
        <div>
          <button onClick={() => setShowExcluded((o) => !o)}
            className="w-full text-left text-[10px] font-bold text-gray-500 uppercase hover:text-gray-800 flex items-center gap-1.5 py-1">
            <ChevronRight className={`w-3 h-3 transition-transform ${showExcluded ? 'rotate-90' : ''}`} />
            Filtered out ({analysis.excluded.length})
          </button>
          {showExcluded && (
            <div className="space-y-1 mt-1">
              <p className="text-[10px] text-gray-500 leading-snug mb-1.5">
                Traffic that was evaluated and rejected. The exclusion list matters as much as the ranking
                when an attribution has to be defended.
              </p>
              {analysis.excluded.map((e: any) => (
                <div key={e.mmsi} className="bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                  <div className="flex justify-between gap-2">
                    <span className="text-[10px] font-semibold text-gray-700 truncate">{e.name}</span>
                    <span className="text-[9.5px] font-mono text-gray-500 flex-shrink-0">
                      {Number.isFinite(e.cpaKm) ? `${e.cpaKm.toFixed(0)} km` : '—'}
                    </span>
                  </div>
                  <p className="text-[9.5px] text-gray-500 leading-snug">{e.reason}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <InfoBanner tone="amber" icon={<Scale className="w-3.5 h-3.5" />}>
        This ranking prioritises inspection. It is not proof of discharge. Evidentiary attribution requires a
        physical sample and a GC-MS fingerprint match against the vessel's slop tank.
      </InfoBanner>
    </div>
  );
}

function ImpactTab({ active, analysis, navigate }: any) {
  const threatened = analysis.threatenedAreas.filter((t: any) => t.distanceKm < 250);
  return (
    <div className="p-3 space-y-3">
      <Section title="Ecological exposure" icon={<Leaf className="w-3.5 h-3.5" />}>
        {threatened.length === 0 ? (
          <p className="text-[11px] text-gray-500">No designated sensitive area lies within 250 km of the forecast envelope.</p>
        ) : (
          <div className="space-y-1.5">
            {threatened.map((t: any) => (
              <div key={t.id} className={`rounded border p-2 ${t.hoursToImpact !== null ? 'bg-red-50 border-red-300' : t.distanceKm < 60 ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold text-gray-900 leading-tight">{t.name}</p>
                    <p className="text-[9.5px] text-gray-500">{t.category} · {t.state}</p>
                  </div>
                  <div className="flex flex-col items-end flex-shrink-0">
                    <Badge tone={t.sensitivity >= 5 ? 'red' : t.sensitivity >= 4 ? 'amber' : 'gray'}>S{t.sensitivity}</Badge>
                    <span className="text-[10px] font-mono font-bold text-gray-700 mt-0.5">{t.distanceKm.toFixed(1)} km</span>
                  </div>
                </div>
                {t.hoursToImpact !== null && (
                  <p className="text-[10px] font-bold text-red-700 mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Forecast envelope reaches this area within {t.hoursToImpact} h
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        <Button size="sm" className="mt-2 w-full justify-center" onClick={() => navigate({ tab: 'NCSCM Ecological', caseId: active.id })}>
          Open response planning
        </Button>
      </Section>

      <Section title="Response readiness" icon={<Radio className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          ['Case status', active.status],
          ['Workflow stage', active.workflowStage],
          ['Published to IMAC', active.imacPushed ? 'Yes' : 'Not yet'],
          ['Community alert', active.alertDispatched ? 'Dispatched' : 'Not issued'],
          ['Assigned analyst', active.assignedTo],
          ['Volume estimate', `${active.estimatedVolumeM3} m³`],
        ]} />
      </Section>

      <Section title="Case notes">
        <p className="text-[11px] text-gray-700 leading-relaxed">{active.notes}</p>
      </Section>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon?: any; children: any }) {
  return (
    <div>
      <h4 className="text-[10px] font-bold text-gray-600 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
        {icon}{title}
      </h4>
      {children}
    </div>
  );
}

function WeightsModal({ open, onClose, weights, setWeights, reset }: any) {
  const total = Object.values(weights).reduce((s: any, v: any) => s + v, 0) as number;
  return (
    <Modal open={open} onClose={onClose} title="Attribution scoring weights"
      subtitle="Adjust how each signal contributes. Rankings recompute immediately across every case."
      footer={<><Button onClick={reset}>Reset to defaults</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <div className="space-y-4">
        <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
          Weights are exposed deliberately. An analyst who cannot see how a ranking was produced cannot
          defend it, and a weighting that suits a coastal discharge is wrong for an open-ocean one.
        </InfoBanner>
        {([
          ['proximity', 'Proximity', 'Distance from the vessel track to the hindcast origin, scaled by the origin uncertainty.'],
          ['temporality', 'Temporality', 'How closely the closest approach aligns with the estimated discharge time.'],
          ['trajectory', 'Trajectory parity', 'Agreement between the vessel course and the slick major axis. Automatically down-weighted for compact slicks.'],
          ['behaviour', 'Behavioural anomaly', 'Speed reduction, loitering, sharp manoeuvres and AIS transmission gaps.'],
          ['vesselPrior', 'Registry prior', 'Prior confirmed attributions, sanctions listing, flag risk and port-state detention history.'],
        ] as const).map(([key, label, help]) => (
          <div key={key}>
            <Slider label={label} value={weights[key]} min={0} max={0.6} step={0.01}
              onChange={(v) => setWeights({ ...weights, [key]: v })} format={(v) => v.toFixed(2)} />
            <p className="text-[10px] text-gray-500 mt-0.5 leading-snug">{help}</p>
          </div>
        ))}
        <div className={`rounded border p-2 text-[11px] ${Math.abs(total - 1) < 0.02 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
          Weights sum to <b>{total.toFixed(2)}</b>.{Math.abs(total - 1) >= 0.02 && ' Scores remain comparable within a case but are no longer on a 0–1 scale.'}
        </div>
      </div>
    </Modal>
  );
}

function ActionsModal({ open, onClose, caseId }: { open: boolean; onClose: () => void; caseId: string }) {
  const { world, setWorkflowStage, setCaseStatus, pushToImac, addEnforcement, navigate } = useStore();
  const c = world.cases.find((x) => x.id === caseId)!;
  const [stage, setStage] = useState(c.workflowStage);
  const [status, setStatus] = useState(c.status);
  const [note, setNote] = useState('');

  useEffect(() => { setStage(c.workflowStage); setStatus(c.status); }, [caseId, c.workflowStage, c.status]);

  return (
    <Modal open={open} onClose={onClose} title={`Case actions — ${caseId}`} subtitle="Every action is timestamped into the audit trail."
      footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Case status">
            <Select value={status} onChange={(v) => setStatus(v as any)}
              options={['New', 'Under Analysis', 'Attributed', 'Verification Dispatched', 'Verified', 'Enforcement', 'Closed'].map((s) => ({ value: s, label: s }))} />
          </Field>
          <Field label="Workflow stage">
            <Select value={stage} onChange={(v) => setStage(v as any)}
              options={['Awaiting Dispatch', 'Patrol En Route', 'Sample Collected', 'Forensic Match Pending', 'Port Inspection Requested', 'Closed'].map((s) => ({ value: s, label: s }))} />
          </Field>
        </div>
        <Field label="Note for the audit record">
          <TextArea value={note} onChange={setNote} rows={2} placeholder="Optional context recorded against this action…" />
        </Field>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => {
            if (status !== c.status) setCaseStatus(caseId, status, note || undefined);
            if (stage !== c.workflowStage) setWorkflowStage(caseId, stage);
            onClose();
          }}>Apply changes</Button>
        </div>

        <div className="border-t border-gray-200 pt-4 space-y-2">
          <p className="text-[10px] font-bold text-gray-600 uppercase">Dispatch and hand-off</p>
          <div className="grid grid-cols-2 gap-2">
            <Button icon={<Send className="w-3 h-3" />} onClick={() => { setWorkflowStage(caseId, 'Patrol En Route'); onClose(); }}>
              Dispatch ICG verification
            </Button>
            <Button icon={<Radio className="w-3 h-3" />} disabled={c.imacPushed} onClick={() => { pushToImac(caseId); onClose(); }}>
              {c.imacPushed ? 'Already on IMAC' : 'Publish to IMAC'}
            </Button>
            <Button icon={<AlertTriangle className="w-3 h-3" />} onClick={() => { navigate({ tab: 'SACHET / SAMUDRA', caseId }); onClose(); }}>
              Compose community alert
            </Button>
            <Button variant="danger" icon={<Scale className="w-3 h-3" />}
              disabled={c.workflowStage === 'Awaiting Dispatch'}
              title={c.workflowStage === 'Awaiting Dispatch' ? 'A case cannot reach enforcement before human verification' : undefined}
              onClick={() => {
                const top = useStoreSafeTop(world, caseId);
                addEnforcement({
                  caseId, mmsi: top ?? '', type: 'Inspection Ordered', issuedAt: Date.now(),
                  authority: 'DG Shipping — Mercantile Marine Department', reference: `MMD/POL/2025/${Math.floor(Math.random() * 900 + 100)}`,
                  status: 'Pending', outcome: note || 'Inspection ordered on the next Indian port call.',
                });
                setCaseStatus(caseId, 'Enforcement', 'Referred for regulatory action');
                onClose();
              }}>
              Refer to enforcement
            </Button>
          </div>
          {c.workflowStage === 'Awaiting Dispatch' && (
            <InfoBanner tone="amber" icon={<Info className="w-3.5 h-3.5" />}>
              Enforcement is blocked until the case has passed through a human verification stage. This is
              enforced by the workflow, not left to discipline.
            </InfoBanner>
          )}
        </div>
      </div>
    </Modal>
  );
}

function useStoreSafeTop(world: any, caseId: string): string | undefined {
  const c = world.cases.find((x: any) => x.id === caseId);
  return c?.candidateMmsis?.[0];
}

function LookalikeModal({ open, onClose, caseId }: { open: boolean; onClose: () => void; caseId: string }) {
  const { updateCase, notify } = useStore();
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState('Biogenic surfactant film (algal bloom)');
  return (
    <Modal open={open} onClose={onClose} title={`Reclassify ${caseId} as a look-alike`}
      subtitle="Use when corroborating evidence shows the feature is a natural phenomenon."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!reason.trim()} onClick={() => {
            updateCase(caseId, { status: 'Dismissed — Look-alike', lookalikeReason: `${kind} — ${reason.trim()}`, workflowStage: 'Closed' });
            notify({ kind: 'info', title: `${caseId} reclassified`, body: 'Retained in the archive with the reasoning recorded.' });
            setReason('');
            onClose();
          }}>Reclassify</Button>
        </>
      }>
      <div className="space-y-3">
        <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
          Reclassified detections are never deleted. They stay in the archive with the reasoning attached, so
          the false-positive rate can be measured honestly rather than hidden.
        </InfoBanner>
        <Field label="Look-alike category">
          <Select value={kind} onChange={setKind} options={[
            'Biogenic surfactant film (algal bloom)', 'Low-wind cell / wind shadow',
            'Current shear or internal-wave signature', 'Rain cell', 'Upwelling front',
            'Sediment plume', 'Grease ice / surface scum',
          ].map((k) => ({ value: k, label: k }))} />
        </Field>
        <Field label="Corroborating evidence" hint="Cite the bulletin, report or observation that supports the reclassification.">
          <TextArea value={reason} onChange={setReason} rows={3}
            placeholder="e.g. NCCR Chennai algal bloom bulletin dated 07 Mar 2025 covering the same 48-hour period…" />
        </Field>
      </div>
    </Modal>
  );
}
