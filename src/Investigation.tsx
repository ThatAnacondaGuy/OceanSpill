import { useEffect, useMemo, useState } from 'react';
import {
  Search, Ship, Crosshair, Wind, Waves, Clock, AlertTriangle, CheckCircle2, XCircle,
  Send, Radio, Scale, Sliders, ChevronRight, EyeOff, Beaker, Leaf, Info, Layers, FlaskConical,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPolygon, type MapPath, type MapCircle } from './components/MapView';
import {
  Tabs, Tier, StatusBadge, Badge, Button, ScoreBar, KeyValue, SearchInput, Toggle,
  InfoBanner, Modal, Field, Select, TextArea, Slider, EmptyState, TimeScrubber, usePlayback, ProvenanceBadge,
} from './components/ui';
import { analysePolygon, formatBearing, type LatLon, type PolygonShape } from './lib/geo';
import { interpolateTrack } from './engine/attribution';
import { OIL_TYPES, type OilProperties } from './engine/drift';
import { MODEL_STATUS } from './engine/detection';
import type { CaseAnalysis } from './store/store';
import type { SpillCase } from './data/types';
import { dataUrl } from './data/world';
import { ECOLOGICAL_AREAS } from './data/geography';
import { DEFAULT_WEIGHTS } from './engine/attribution';

export default function Investigation() {
  const store = useStore();
  const { world, now, selectedCaseId, setSelectedCaseId, getAnalysis, navigate, weights, setWeights, resetWeights, revision } = store;

  const [query, setQuery] = useState('');
  const [basemap, setBasemap] = useState<BasemapStyle>('satellite');
  const [tab, setTab] = useState('record');
  const [layers, setLayers] = useState({
    slick: true, hindcast: true, ensemble: true, forecast: true, tracks: true,
    candidates: true, esa: true, uncertainty: true, sar: true,
  });
  const [layersOpen, setLayersOpen] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [lookalikeOpen, setLookalikeOpen] = useState(false);
  const [focusMmsi, setFocusMmsi] = useState<string | null>(null);

  const cases = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.cases
      .filter((c) => !q || `${c.id} ${c.title} ${c.subRegion} ${c.status}`.toLowerCase().includes(q))
      .sort((a, b) => b.incidentTime - a.incidentTime);
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

    if (layers.sar) {
      active.detection.sarMeasurements.forEach((m) => m.spots.forEach((spot, i) => {
        if (spot.outline.length < 3) return;
        const chosen = active.detection.sarSpot?.scene === m.scene && active.detection.sarSpot.distanceKm === spot.distanceKm;
        polygons.push({
          id: `sar-${m.scene}-${i}`, rings: [spot.outline], fill: chosen ? 'rgba(220,38,38,0.25)' : 'rgba(220,38,38,0.08)',
          stroke: '#dc2626', strokeWidth: chosen ? 2 : 1, dash: chosen ? undefined : '3 3', z: 7,
        });
      }));
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
                ID: fmt.vesselId(vessel), Data: vessel.provenance === 'real' ? 'Real vessel, synthetic track' : 'Synthetic vessel', Speed: `${at.sog.toFixed(1)} kn`,
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
                meta: { ID: fmt.vesselId(vessel), 'Dark for': `${score.darkMinutes} min` },
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
                  <span className="font-bold text-[11px] text-gray-900 truncate" title={c.title}>{c.title}</span>
                  <Tier tier={c.tier} />
                </div>
                <p className="text-[9.5px] font-mono text-gray-400 truncate">{c.id}</p>
                <p className="text-[10px] text-gray-600 truncate">{c.subRegion}</p>
                <div className="flex items-center gap-1 mt-1">
                  <StatusBadge status={c.status} />
                  {a?.ranked.some((r) => r.darkDuringWindow) && <Badge tone="red">DARK</Badge>}
                </div>
                <p className="text-[9px] text-gray-400 mt-0.5">{fmt.precise(c.incidentTime, c.facts.incident.timePrecision)} · {fmt.ago(c.incidentTime, now)}</p>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Map */}
      <section className="flex-1 min-w-0 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-bold text-sm text-gray-900">{active.title}</span>
            <span className="text-[10px] text-gray-400 font-mono">{active.id}</span>
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
                      <Toggle checked={layers.sar} onChange={(v) => setLayers({ ...layers, sar: v })} label="SAR dark spots (processed)"
                        count={active.detection.sarMeasurements.reduce((n, m) => n + m.spots.length, 0)} />
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
                <LegendLine color="#f8fafc" fill="rgba(15,23,42,0.72)" label={active.detection.extentReported ? 'Reported slick extent' : 'Reported location'} swatch />
                <LegendLine color="#f59e0b" label="Hindcast (backward)" dash />
                <LegendLine color="#06b6d4" label="Forecast (forward)" />
                <LegendLine color="#f43f5e" label="Leading suspect track" />
                <LegendLine color="#dc2626" label="AIS gap (inferred)" dash />
                <LegendLine color="#64748b" label="Other candidate traffic" />
                <p className="text-[9px] text-gray-500 mt-1.5 max-w-[190px] leading-snug">AIS: {active.aisProvider}. Drift forcing: {analysis.sampler.label}.</p>
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
            { t: active.detection.acquiredAt, color: '#2563eb', label: 'Reference observation' },
            ...(['minute', 'hour'].includes(active.facts.incident.timePrecision) ? [{ t: active.incidentTime, color: '#dc2626', label: 'Reported incident' }] : []),
          ]}
        />
      </section>

      {/* Inspector */}
      <aside className="w-[390px] bg-white border-l border-gray-200 flex flex-col flex-shrink-0">
        <Tabs
          active={tab} onChange={setTab}
          tabs={[
            { id: 'record', label: 'Record' },
            { id: 'detection', label: 'Detection' },
            { id: 'drift', label: 'Drift' },
            { id: 'attribution', label: 'Suspects', count: analysis.ranked.length },
            { id: 'impact', label: 'Impact' },
          ]}
        />

        <div className="flex-1 overflow-y-auto">
          {tab === 'record' && <RecordTab active={active} />}
          {tab === 'detection' && <DetectionTab active={active} analysis={analysis} shape={shape} oil={oil} />}
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
                <p className="text-[9.5px] text-gray-500 flex items-center gap-1">{topVessel.flag ?? 'Flag n/a'} · {fmt.vesselId(topVessel)} <ProvenanceBadge p={topVessel.provenance} /></p>
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

function DetectionTab({ active, analysis, shape, oil }: { active: SpillCase; analysis: CaseAnalysis; shape: PolygonShape; oil: OilProperties | undefined }) {
  const a = analysis.assessment;
  const det = active.detection;
  const pendingCount = a.checks.filter((c) => c.status === 'pending').length;
  const w = analysis.weathering;
  return (
    <div className="p-3 space-y-3">
      <div className={`rounded border p-2.5 ${
        a.verdict === 'Officially confirmed' || a.verdict === 'Confirmed oil' ? 'bg-red-50 border-red-200'
        : a.verdict === 'Probable oil' ? 'bg-amber-50 border-amber-200'
        : a.verdict === 'Ambiguous' ? 'bg-yellow-50 border-yellow-200' : 'bg-slate-50 border-slate-200'}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-bold text-gray-900">{a.verdict}</span>
          <span className="text-lg font-black text-gray-900">{a.confidenceBasis === 'official-report' ? 'Official' : fmt.pct(a.confidence, 0)}</span>
        </div>
        {a.confidenceBasis === 'official-report' ? (
          <p className="text-[10px] text-gray-700 leading-snug">
            The spill was confirmed by an authority ({det.observationSource}). This is a report, not a model output:
            SAR checks that need a processed scene are shown as pending below.
          </p>
        ) : a.rawModelConfidence != null ? (
          <p className="text-[10px] text-gray-700 leading-snug">
            Raw segmentation output was {fmt.pct(a.rawModelConfidence)}; the cross-checks below moved it to {fmt.pct(a.confidence)}.
          </p>
        ) : (
          <p className="text-[10px] text-gray-700 leading-snug">Not officially confirmed and no SAR model output yet.</p>
        )}
        {a.lookalikeHypothesis && (
          <p className="text-[10px] font-semibold text-slate-700 mt-1.5 pt-1.5 border-t border-slate-200">
            Most likely natural alternative: {a.lookalikeHypothesis}
          </p>
        )}
      </div>

      <Section title="Look-alike discrimination" icon={<FlaskConical className="w-3.5 h-3.5" />}>
        <p className="text-[10px] text-gray-500 mb-2 leading-snug">
          Separating oil from wind shadows, algal films and current shear. {pendingCount > 0 && `${pendingCount} check${pendingCount === 1 ? '' : 's'} need a downloaded and segmented SAR scene.`}
        </p>
        <div className="space-y-1.5">
          {a.checks.map((c) => (
            <div key={c.name} className={`rounded border p-2 ${
              c.status === 'passed' ? 'bg-emerald-50/60 border-emerald-200' : c.status === 'failed' ? 'bg-red-50/60 border-red-200' : 'bg-gray-50 border-gray-200 border-dashed'}`}>
              <div className="flex items-start gap-1.5">
                {c.status === 'passed' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
                  : c.status === 'failed' ? <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0 mt-0.5" />
                  : <Clock className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5" />}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10.5px] font-bold text-gray-900">{c.name}</span>
                    {c.status === 'pending' ? <ProvenanceBadge p="pending" /> : <span className="text-[9px] text-gray-400">weight {c.weight.toFixed(2)}</span>}
                  </div>
                  <p className="text-[10px] text-gray-600 leading-snug mt-0.5">{c.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Reported geometry" icon={<Crosshair className="w-3.5 h-3.5" />}>
        <div className="flex items-center gap-1.5 mb-1.5">
          <Badge tone="blue">{det.geometryBasis}</Badge>
          <ProvenanceBadge p={det.extentReported ? 'real' : 'modelled'} />
        </div>
        <KeyValue cols={2} items={[
          ['Area', `${shape.areaKm2.toFixed(2)} km²`],
          ['Major axis', `${shape.majorAxisKm.toFixed(2)} km`],
          ['Elongation', det.extentReported ? `${shape.elongation.toFixed(2)} : 1` : 'n/a (marker)'],
          ['Orientation', det.extentReported ? `${shape.orientationDeg.toFixed(0)}° (${formatBearing(shape.orientationDeg)})` : 'n/a (marker)'],
          ['Observed', fmt.utc(det.acquiredAt)],
          ['Source', det.observationSource],
        ]} />
        {det.geometryAssumptions.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {det.geometryAssumptions.map((s) => <li key={s} className="text-[9.5px] text-gray-500 leading-snug flex gap-1"><span>•</span><span>{s}</span></li>)}
          </ul>
        )}
        <div className="mt-2 bg-blue-50 border border-blue-200 rounded p-2">
          <p className="text-[10px] font-bold text-blue-900 mb-0.5">Source</p>
          <p className="text-[10px] text-blue-800 leading-snug">{a.sourceInference}</p>
        </div>
      </Section>

      <Section title="Weathering" icon={<Beaker className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          ['Oil type (model)', oil?.label ?? active.oilType],
          ['Quantity', active.oilQuantityTonnes != null ? `${fmt.num(active.oilQuantityTonnes)} t` : 'Not reported'],
          ['Age at observation', analysis.knownAgeHours != null ? `${analysis.knownAgeHours.toFixed(1)} h` : 'Unknown (incident time imprecise)'],
          ['Incident time', fmt.precise(active.incidentTime, active.facts.incident.timePrecision)],
        ]} />
        {w ? (
          <>
            <p className="text-[10px] text-gray-500 my-1.5 leading-snug flex items-center gap-1.5">
              <ProvenanceBadge p="modelled" /> Weathering state from the empirical model at the known age, using the observed wind.
            </p>
            <KeyValue cols={2} items={[
              ['Evaporated', `${w.evaporatedPct}%`],
              ['Water content', `${w.waterContentPct}%`],
              ['Film thickness', `${w.thicknessUm} µm`],
              ['Viscosity', `${fmt.num(w.viscosityCp)} cP`],
              ['Surface remaining', `${w.remainingPct}%`],
              ['Appearance', w.appearance],
            ]} />
          </>
        ) : (
          <p className="text-[10px] text-gray-500 mt-1.5">Weathering is not modelled because the release time is only known to the {active.facts.incident.timePrecision}.</p>
        )}
        {active.facts.oil.spilledNote && <p className="text-[9.5px] text-gray-500 mt-1.5 leading-snug">{active.facts.oil.spilledNote}</p>}
      </Section>

      <Section title="Conditions at the observation" icon={<Wind className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          [<span className="flex items-center gap-1">Wind <ProvenanceBadge p={analysis.conditions.wind.origin} /></span>, `${analysis.conditions.wind.speed.toFixed(1)} m/s from ${formatBearing(analysis.conditions.wind.dirFrom)}`],
          [<span className="flex items-center gap-1">Current <ProvenanceBadge p={analysis.conditions.current.origin} /></span>, `${(analysis.conditions.current.speed * 1.944).toFixed(2)} kn to ${formatBearing(analysis.conditions.current.dirTo)}`],
          ['Sea state', `Bft ${analysis.conditions.sea.beaufort} · ${analysis.conditions.sea.beaufortLabel}`],
          ['SAR window', analysis.conditions.sea.sarDetectability],
        ]} />
        <InfoBanner tone={analysis.conditions.sea.sarDetectability === 'Optimal' ? 'green' : 'amber'} icon={<Info className="w-3 h-3" />}>
          {a.detectabilityNote}
        </InfoBanner>
      </Section>

      <Section title={`SAR catalogue (${det.scenes.length})`} icon={<Layers className="w-3.5 h-3.5" />}>
        <div className="space-y-1 mb-2">
          {det.sarProviders.map((p) => (
            <div key={p.name} className="flex items-center gap-1.5 text-[10px]">
              <Badge tone={p.sovereign ? 'green' : 'gray'}>{p.sovereign ? 'IN' : 'EXT'}</Badge>
              <span className="font-semibold text-gray-800">{p.name}</span>
              <span className={`ml-auto ${p.ok ? 'text-emerald-700' : 'text-amber-700'}`}>{p.ok ? `${p.count} found` : 'not searched'}</span>
            </div>
          ))}
        </div>
        {det.scenes.length === 0 ? (
          <p className="text-[10px] text-gray-500">No scene in the search window.</p>
        ) : (
          <div className="space-y-1">
            {det.scenes.map((s) => (
              <div key={s.id} className="bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold text-gray-800">{s.platform} {s.mode} {s.productType}</span>
                  <ProvenanceBadge p="real" />
                </div>
                <p className="text-[9.5px] text-gray-500">{fmt.utc(s.start)} · {s.orbitDirection ?? 'orbit n/a'} · {s.coversIncident ? 'covers incident' : 'near incident'}</p>
                <p className="text-[9px] text-gray-400 font-mono break-all">{s.name}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {det.sarMeasurements.length > 0 && (
        <Section title={`Processed scenes (${det.sarMeasurements.length})`} icon={<Layers className="w-3.5 h-3.5" />}>
          {det.sarMeasurements.map((m) => (
            <div key={m.scene} className="border border-gray-200 rounded p-2 mb-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] font-bold text-gray-800 truncate" title={m.scene}>{m.scene}</span>
                <ProvenanceBadge p="observed" />
              </div>
              <img src={dataUrl(m.quicklook)} alt={`Calibrated ${m.polarisation} sigma0 quicklook with detected dark spots outlined`}
                className="w-full rounded border border-gray-200 bg-gray-900" />
              <p className="text-[9.5px] text-gray-500 mt-1 leading-snug">{m.method}</p>
              <KeyValue cols={2} items={[
                ['Polarisation', m.polarisation],
                ['Pixel spacing', `${m.parameters.pixelSpacingM} m`],
                ['Sea background', m.sea.meanDb != null ? `${m.sea.meanDb} dB` : '—'],
                ['Incidence', `${m.incidenceDeg}°`],
              ]} />
              <div className="mt-1.5 space-y-1">
                {m.spots.length === 0 && <p className="text-[10px] text-gray-500">No dark spot above the thresholds.</p>}
                {m.spots.slice(0, 5).map((spot, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px]">
                    <span className="w-14 font-mono text-gray-700">{spot.distanceKm.toFixed(1)} km</span>
                    <span className="flex-1 text-gray-600">{spot.areaKm2.toFixed(2)} km² · {spot.elongation.toFixed(1)}:1 · {spot.orientationDeg.toFixed(0)}°</span>
                    <span className="font-mono font-bold text-gray-900">{spot.contrastDb.toFixed(1)} dB</span>
                  </div>
                ))}
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {m.limitations.map((l) => <li key={l} className="text-[9px] text-gray-400 leading-snug">• {l}</li>)}
              </ul>
            </div>
          ))}
        </Section>
      )}

      <Section title="Segmentation model" icon={<Layers className="w-3.5 h-3.5" />}>
        <div className="flex items-center gap-1.5 mb-1.5"><ProvenanceBadge p="pending" /><span className="text-[10px] text-gray-600">Not trained</span></div>
        <KeyValue cols={1} items={[
          ['Architecture', MODEL_STATUS.plannedArchitecture],
          ['Training plan', MODEL_STATUS.plannedTraining],
          ['Loss', MODEL_STATUS.plannedLoss],
        ]} />
        <p className="text-[9.5px] text-gray-500 mt-1.5 leading-snug">{MODEL_STATUS.note}</p>
      </Section>

      {active.lookalikeReason && (
        <InfoBanner tone="amber" icon={<EyeOff className="w-3.5 h-3.5" />}>
          <b>Reclassified as look-alike.</b> {active.lookalikeReason}
        </InfoBanner>
      )}
    </div>
  );
}

function RecordTab({ active }: { active: SpillCase }) {
  const f = active.facts;
  return (
    <div className="p-3 space-y-3">
      <div className="bg-slate-50 border border-slate-200 rounded p-2.5">
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-xs font-bold text-gray-900">{f.title}</p>
          <ProvenanceBadge p="real" />
        </div>
        <p className="text-[10px] text-gray-600 leading-snug">{f.officialFindings}</p>
      </div>

      <Section title="Incident" icon={<Info className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          ['Time', fmt.precise(active.incidentTime, f.incident.timePrecision)],
          ['Precision', f.incident.timePrecision],
          ['Position', `${f.incident.position.lat.toFixed(4)}, ${f.incident.position.lon.toFixed(4)}`],
          ['Position ±', `${f.incident.positionPrecisionKm} km`],
          ['Source type', f.sourceType],
          ['Position source', f.incident.positionSource],
        ]} />
        {f.incident.timeNote && <p className="text-[9.5px] text-gray-500 mt-1">{f.incident.timeNote}</p>}
      </Section>

      <Section title="Oil" icon={<Beaker className="w-3.5 h-3.5" />}>
        <div className="space-y-1">
          {f.oil.onboard.map((o) => (
            <div key={o.product} className="flex justify-between gap-2 text-[10.5px]">
              <span className="text-gray-700">{o.product}{o.note && <span className="text-gray-400"> · {o.note}</span>}</span>
              <span className="font-mono font-bold text-gray-900 flex-shrink-0">{o.tonnes != null ? `${fmt.num(o.tonnes, o.tonnes % 1 ? 1 : 0)} t` : o.cubicMetres != null ? `${fmt.num(o.cubicMetres)} m³` : 'n/r'}</span>
            </div>
          ))}
          <div className="flex justify-between gap-2 text-[10.5px] pt-1 border-t border-gray-200">
            <span className="text-gray-700 font-semibold">Released</span>
            <span className="font-mono font-bold text-gray-900">{f.oil.spilledTonnes != null ? `${fmt.num(f.oil.spilledTonnes)} t` : 'Not published'}</span>
          </div>
        </div>
      </Section>

      <Section title="Observations" icon={<Crosshair className="w-3.5 h-3.5" />}>
        <div className="space-y-1">
          {f.observations.map((o) => (
            <div key={`${o.time}-${o.type}`} className="bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
              <div className="flex justify-between gap-2">
                <span className="text-[10px] font-bold text-gray-800">{o.type}</span>
                <span className="text-[9.5px] font-mono text-gray-500">{fmt.utcShort(Date.parse(o.time))}</span>
              </div>
              <p className="text-[10px] text-gray-600 leading-snug">{o.description}</p>
              <p className="text-[9px] text-gray-400">{o.source}{o.extentKm2 != null ? ` · ${o.extentKm2} km²` : ''}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Timeline" icon={<Clock className="w-3.5 h-3.5" />}>
        <ol className="relative border-l border-gray-300 ml-1.5 space-y-2">
          {f.timeline.map((e) => (
            <li key={`${e.time}-${e.event}`} className="ml-3">
              <span className="absolute -left-[4.5px] w-2 h-2 rounded-full bg-blue-500 mt-1" />
              <p className="text-[9.5px] font-mono text-gray-500">{fmt.precise(Date.parse(e.time), e.timePrecision ?? 'minute')}</p>
              <p className="text-[10.5px] text-gray-800 leading-snug">{e.event}</p>
            </li>
          ))}
        </ol>
      </Section>

      {f.response.length > 0 && (
        <Section title="Response" icon={<Radio className="w-3.5 h-3.5" />}>
          <div className="flex flex-wrap gap-1">{f.response.map((r) => <Badge key={r} tone="blue">{r}</Badge>)}</div>
        </Section>
      )}

      {Object.keys(f.impact).length > 0 && (
        <Section title="Impact (reported)" icon={<Leaf className="w-3.5 h-3.5" />}>
          <KeyValue cols={2} items={Object.entries(f.impact).map(([k, v]) => [k.replace(/([A-Z])/g, ' $1').replace(/^./, (x) => x.toUpperCase()), fmt.num(v)])} />
        </Section>
      )}

      {f.legal && f.legal.length > 0 && (
        <Section title="Legal outcome" icon={<Scale className="w-3.5 h-3.5" />}>
          {f.legal.map((l) => (
            <div key={`${l.authority}-${l.action}`} className="bg-amber-50 border border-amber-200 rounded p-2 mb-1">
              <p className="text-[10.5px] font-bold text-amber-900">{l.action}{l.amountInr ? ` · ${fmt.inr(l.amountInr)}` : ''}</p>
              <p className="text-[10px] text-amber-800">{l.authority} → {l.party}</p>
              {l.note && <p className="text-[9.5px] text-amber-700 mt-0.5">{l.note}</p>}
            </div>
          ))}
        </Section>
      )}

      {active.warnings.length > 0 && (
        <Section title="Data warnings" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
          <ul className="space-y-1">
            {active.warnings.map((w) => <li key={w} className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">{w}</li>)}
          </ul>
        </Section>
      )}

      <Section title={`Sources (${f.sources.length})`} icon={<Info className="w-3.5 h-3.5" />}>
        <ul className="space-y-1">
          {f.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer" className="text-[10.5px] text-blue-700 hover:underline leading-snug break-words">{s.title}</a>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function DriftTab({ active, analysis }: { active: SpillCase; analysis: CaseAnalysis }) {
  const hc = analysis.hindcast;
  const fc = analysis.forecast;
  return (
    <div className="p-3 space-y-3">
      <Section title="Hindcast — where it came from" icon={<Clock className="w-3.5 h-3.5" />}>
        <p className="text-[10px] text-gray-500 mb-2 leading-snug">
          A particle cloud is integrated backward from the reported observation under current + Stokes drift +
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
          ['Integration', `${((active.detection.acquiredAt - hc.estimatedTime) / 3600_000).toFixed(1)} h backward${
            (active.detection.acquiredAt - hc.estimatedTime) / 3600_000 < active.hindcastHours - 0.01 ? ' (to reported incident)' : ''}`],
          ['Timestep', `${hc.params.stepMinutes} min`],
          ['Particles', fmt.num(hc.params.particles)],
          ['Windage', fmt.pct(hc.params.windage)],
          ['Diffusivity', `${hc.params.diffusivity} m²/s`],
          ['Ensemble', `${hc.ensemble.length} members`],
          ['Confidence', fmt.pct(hc.confidence)],
          ['Drift distance', `${distance(hc.path).toFixed(1)} km`],
        ]} />
      </Section>

      <Section title="Forecast — where it is going" icon={<Waves className="w-3.5 h-3.5" />}>
        <div className="space-y-1.5">
          {fc.horizons.map((h) => (
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

      <Section title="Forcing at the observation" icon={<Wind className="w-3.5 h-3.5" />}>
        <KeyValue cols={2} items={[
          [<span className="flex items-center gap-1">Wind <ProvenanceBadge p={analysis.conditions.wind.origin} /></span>, `${analysis.conditions.wind.speed.toFixed(1)} m/s`],
          ['Wind from', `${analysis.conditions.wind.dirFrom.toFixed(0)}° ${formatBearing(analysis.conditions.wind.dirFrom)}`],
          [<span className="flex items-center gap-1">Current <ProvenanceBadge p={analysis.conditions.current.origin} /></span>, `${(analysis.conditions.current.speed * 1.944).toFixed(2)} kn`],
          ['Current toward', `${analysis.conditions.current.dirTo.toFixed(0)}° ${formatBearing(analysis.conditions.current.dirTo)}`],
          [<span className="flex items-center gap-1">SST <ProvenanceBadge p="modelled" /></span>, `${analysis.conditions.sea.seaSurfaceTempC} °C`],
          ['Wave height', `${analysis.conditions.sea.significantWaveHeightM} m`],
        ]} />
        <div className="mt-2 space-y-0.5 text-[9.5px] text-gray-500">
          <p><b>Wind:</b> {analysis.sampler.sources.wind}</p>
          <p><b>Current:</b> {analysis.sampler.sources.current}</p>
          {active.forcingCoverage && (
            <p>Grid coverage: wind {fmt.pct(active.forcingCoverage.wind, 0)} · current {fmt.pct(active.forcingCoverage.current, 0)} · waves {fmt.pct(active.forcingCoverage.waves, 0)}</p>
          )}
          <p>Cells without observed values fall back to the climatological model; samples say which was used.</p>
        </div>
      </Section>

      <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
        Same Lagrangian approach as OpenDrift OpenOil and NOAA GNOME, run in the browser. Operational use should
        switch the forcing to INCOIS HOOFS currents once access is granted.
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
                    <ProvenanceBadge p={v.provenance} />
                  </div>
                  <p className="text-[9.5px] text-gray-500 mt-0.5">
                    {v.type} · {v.flag ?? 'flag n/a'} · {fmt.vesselId(v)}
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
                  ['IMO', v.imo ?? '—'], ['Role', v.role],
                  ['Operator', v.operator ?? 'Not published'], ['Flag risk', v.flagRisk ?? 'Not assessed'],
                  ['Sanctions', v.sanctionsChecked ? (v.sanctioned ? `Listed (${v.sanctionsList ?? 'UNSC'})` : 'Not listed (UNSC)') : 'Not checked'],
                  ['PSC detentions', v.pscDetentions != null ? String(v.pscDetentions) : 'Needs Equasis'],
                ]} />
                {v.note && <p className="text-[9.5px] text-gray-500 leading-snug">{v.note}</p>}
                {(() => {
                  const t = world.tracks.get(v.mmsi);
                  return t ? (
                    <p className="text-[9.5px] text-gray-500 leading-snug flex items-start gap-1">
                      <ProvenanceBadge p={t.provenance} /> <span>{t.notes[0] ?? ''}</span>
                    </p>
                  ) : null;
                })()}

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
          ['Community alert', active.alertDispatched ? 'Drafted' : 'Not drafted'],
          ['Assigned analyst', active.assignedTo],
          ['Oil quantity', active.oilQuantityTonnes != null ? `${fmt.num(active.oilQuantityTonnes)} t` : 'Not reported'],
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
              {c.imacPushed ? 'IMAC payload generated' : 'Generate IMAC payload'}
            </Button>
            <Button icon={<AlertTriangle className="w-3 h-3" />} onClick={() => { navigate({ tab: 'SACHET / SAMUDRA', caseId }); onClose(); }}>
              Compose community alert
            </Button>
            <Button variant="danger" icon={<Scale className="w-3 h-3" />}
              disabled={c.workflowStage === 'Awaiting Dispatch'}
              title={c.workflowStage === 'Awaiting Dispatch' ? 'A case cannot reach enforcement before human verification' : undefined}
              onClick={() => {
                const top = useStoreSafeTop(world, caseId);
                const party = top ? world.vesselsByMmsi.get(top)?.name ?? top : 'Unidentified source';
                addEnforcement({
                  caseId, mmsi: top ?? '', party, type: 'Inspection Ordered', issuedAt: Date.now(),
                  authority: 'DG Shipping — Mercantile Marine Department', reference: null,
                  status: 'Pending', outcome: note || 'Referral recorded in this session; no order has been issued.',
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
