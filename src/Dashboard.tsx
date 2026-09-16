import { useEffect, useMemo, useState } from 'react';
import {
  Satellite, FileText, Anchor, Activity, ClipboardList, ArrowRight, Search, BarChart2, Settings, Layers, Scale, History, AlertTriangle,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { legalSummary, reportedSource } from './data/world';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPolygon } from './components/MapView';
import { Panel, StatCard, Tier, StatusBadge, Badge, Toggle, InfoBanner, ProvenanceBadge } from './components/ui';
import { analysePolygon } from './lib/geo';
import { ECOLOGICAL_AREAS, CORRIDORS, PORTS } from './data/geography';
import { sampleField } from './engine/ocean';
import { fetchMonitoring, serverMode, type Detection } from './data/server';

export default function Dashboard() {
  const { world, now, navigate, getAnalysis, revision } = useStore();
  const [basemap, setBasemap] = useState<BasemapStyle>('map');
  const [layers, setLayers] = useState({ cases: true, historical: true, eez: true, esa: false, corridors: false, ports: false, currents: false, detections: true });
  const [layersOpen, setLayersOpen] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);

  // What the scene watcher has found and nobody has judged yet. Only the server watches, so in
  // static mode this stays empty and the layer toggle simply has nothing to show.
  useEffect(() => {
    if (!serverMode) return;
    let live = true;
    const load = () => { void fetchMonitoring().then((s) => { if (live) setDetections(s.newDetections); }).catch(() => {}); };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  const stats = useMemo(() => {
    const scenes = world.passes.length;
    const eosScenes = world.passes.filter((p) => p.provider === 'bhoonidhi').length;
    const real = world.vessels.filter((v) => v.provenance === 'real' && !v.isFacility).length;
    const synthetic = world.vessels.filter((v) => v.provenance === 'synthetic').length;
    const legal = legalSummary(world);
    return { scenes, eosScenes, real, synthetic, legal: legal.actions, legalIncidents: legal.incidents, fines: legal.penaltiesInr, high: world.cases.filter((c) => c.tier === 'HIGH').length };
  }, [world, revision]);

  const ordered = useMemo(() => {
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return [...world.cases].sort((a, b) => rank[a.tier] - rank[b.tier] || b.incidentTime - a.incidentTime);
  }, [world.cases, revision]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (layers.historical) {
      for (const h of world.historical) {
        if (h.activeCaseId || h.lat == null || h.lon == null) continue;
        out.push({
          id: h.id, position: { lat: h.lat, lon: h.lon }, kind: 'sighting', color: '#64748b', size: 4,
          label: h.name, sublabel: `${h.date} · ${h.location}`, z: 1,
          meta: { Oil: h.oil ?? 'not reported', Tonnes: h.tonnes != null ? fmt.num(h.tonnes) : 'not reported' },
        });
      }
    }
    if (layers.cases) {
      for (const c of world.cases) {
        const shape = analysePolygon(c.detection.polygon.ring);
        out.push({
          id: c.id, position: shape.centroid, kind: 'case',
          color: c.tier === 'HIGH' ? '#dc2626' : c.tier === 'MEDIUM' ? '#f59e0b' : '#10b981',
          size: 7, label: c.title, sublabel: c.subRegion, pulse: c.tier === 'HIGH', z: 3,
          meta: {
            Date: fmt.precise(c.incidentTime, c.facts.incident.timePrecision),
            Source: c.sourceType,
            'SAR scenes': c.detection.scenes.length,
            Position: `±${c.facts.incident.positionPrecisionKm} km`,
          },
        });
      }
    }
    if (layers.ports) {
      for (const p of PORTS) {
        out.push({ id: `port-${p.name}`, position: p, kind: 'port', color: p.oilTerminal ? '#7c3aed' : '#64748b', size: p.tier === 1 ? 4.5 : 3.5, label: p.name, sublabel: p.state, z: 2 });
      }
    }
    // Dark patches the watcher found and nobody has looked at yet. They sit above the recorded cases
    // because they are the only thing on this map that needs a decision today, and they are drawn in
    // a colour of their own: a detection is a candidate, not a spill.
    if (layers.detections) {
      for (const d of detections) {
        out.push({
          id: `det-${d.id}`, position: d.position, kind: 'detection', color: '#7c3aed', size: 6,
          label: `${d.areaKm2.toFixed(1)} km² dark patch`, sublabel: 'awaiting review', pulse: true, z: 4,
          meta: {
            Seen: fmt.utcShort(d.acquiredAt),
            Scene: d.sceneId,
            Method: d.method,
            Age: fmt.hoursOrDays((now - d.acquiredAt) / 3600_000),
          },
        });
      }
    }
    return out;
  }, [world, layers, detections, now]);

  const polygons = useMemo<MapPolygon[]>(() => {
    const out: MapPolygon[] = [];
    if (layers.esa) {
      for (const a of ECOLOGICAL_AREAS) out.push({ id: a.id, rings: [a.ring], fill: 'rgba(16,185,129,0.18)', stroke: '#059669', strokeWidth: 1.2, z: 0 });
    }
    if (layers.cases) {
      for (const c of world.cases) out.push({ id: `slick-${c.id}`, rings: [c.detection.polygon.ring], fill: 'rgba(17,24,39,0.55)', stroke: '#111827', strokeWidth: 1, z: 2 });
    }
    return out;
  }, [layers.esa, layers.cases, world.cases]);

  const paths = useMemo(() => (layers.corridors
    ? CORRIDORS.map((c) => ({ id: c.id, points: c.waypoints, stroke: c.highRisk ? '#f97316' : '#60a5fa', strokeWidth: 1.6, dash: '6 4', opacity: 0.75, z: 1 }))
    : []), [layers.corridors]);

  const vectors = useMemo(() => (layers.currents
    ? sampleField({ north: 25, south: 4, east: 96, west: 65 }, new Date(now), 16, 12, 'current').map((s) => ({ position: s.position, dirDeg: s.sample.dirTo, magnitude: s.sample.speed }))
    : []), [layers.currents, now]);

  const recordEvents = useMemo(() => world.audit.filter((a) => a.category !== 'Access' && a.category !== 'System').slice(0, 8), [world.audit, revision]);
  const warnings = useMemo(() => world.cases.flatMap((c) => c.warnings.map((w) => ({ caseId: c.id, text: w }))), [world.cases]);

  return (
    <main className="flex-1 min-h-0 p-4 grid grid-cols-12 gap-4 overflow-y-auto content-start">
      <div className="col-span-12 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <StatCard icon={<ClipboardList className="w-6 h-6" />} title="Recorded cases" value={world.cases.length}
          trend={`${stats.high} high tier · retrospective`} onClick={() => navigate({ tab: 'Spill Incidents' })} />
        <StatCard icon={<Satellite className="w-6 h-6" />} title="SAR scenes catalogued" value={stats.scenes}
          trend={`${stats.eosScenes} EOS-04 · ${stats.scenes - stats.eosScenes} Sentinel-1`} onClick={() => navigate({ tab: 'Satellite Tasking' })} />
        <StatCard icon={<Anchor className="w-6 h-6" />} title="Vessels in case windows" value={stats.real + stats.synthetic}
          trend={stats.synthetic ? `${stats.synthetic} synthetic` : `across ${world.cases.length} cases`} onClick={() => navigate({ tab: 'Vessel Analysis' })} />
        <StatCard icon={<History className="w-6 h-6" />} title="Historical incidents" value={world.historical.length}
          accent="amber" trend="Indian waters, 1970–2025" onClick={() => navigate({ tab: 'Case Archive', section: 'historical' })} />
        <StatCard icon={<Scale className="w-6 h-6" />} title="Legal actions on record" value={stats.legal}
          accent="red" trend={`${stats.legalIncidents} incidents${stats.fines ? ` · ${fmt.inr(stats.fines)} in fines` : ''}`} onClick={() => navigate({ tab: 'Workflow', section: 'enforcement' })} />
      </div>

      <div className="col-span-12 lg:col-span-8 xl:col-span-9 h-[560px] rounded-lg shadow-sm border border-gray-200 overflow-hidden relative bg-white">
        <MapView
          basemap={basemap} initialCentre={{ lat: 15, lon: 80 }} initialZoom={3.9}
          markers={markers} polygons={polygons} paths={paths} vectors={vectors}
          vectorLabel={layers.currents ? 'Modelled current climatology (not observed data)' : undefined}
          showEez={layers.eez}
          onMarkerClick={(m) => {
            if (m.kind === 'case') navigate({ tab: 'Investigation', caseId: m.id });
            // A detection needs a decision, and the queue is where that is made.
            else if (m.kind === 'detection') navigate({ tab: 'Live Operations' });
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
                  <div className="absolute top-full mt-1 left-0 bg-white rounded shadow-xl border border-gray-300 p-3 w-56 z-30">
                    <Toggle checked={layers.cases} onChange={(v) => setLayers({ ...layers, cases: v })} label="Recorded cases" count={world.cases.length} />
                    {serverMode && (
                      <Toggle checked={layers.detections} onChange={(v) => setLayers({ ...layers, detections: v })}
                        label="Awaiting review" count={detections.length} />
                    )}
                    <Toggle checked={layers.historical} onChange={(v) => setLayers({ ...layers, historical: v })} label="Historical register" count={world.historical.filter((h) => !h.activeCaseId && h.lat != null).length} />
                    <Toggle checked={layers.eez} onChange={(v) => setLayers({ ...layers, eez: v })} label="Indian EEZ (approx.)" />
                    <Toggle checked={layers.esa} onChange={(v) => setLayers({ ...layers, esa: v })} label="Sensitive areas" count={ECOLOGICAL_AREAS.length} />
                    <Toggle checked={layers.corridors} onChange={(v) => setLayers({ ...layers, corridors: v })} label="Shipping corridors" count={CORRIDORS.length} />
                    <Toggle checked={layers.ports} onChange={(v) => setLayers({ ...layers, ports: v })} label="Ports & terminals" count={PORTS.length} />
                    <Toggle checked={layers.currents} onChange={(v) => setLayers({ ...layers, currents: v })} label="Current climatology (modelled)" />
                  </div>
                )}
              </div>
            </div>
          }
          legend={
            <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded-lg p-3 text-[0.6875rem] shadow-lg">
              <h4 className="font-bold mb-1.5 text-gray-700 uppercase tracking-wide">Legend</h4>
              <LegendDot color="#dc2626" label="Case, high tier (≥250 t)" />
              <LegendDot color="#f59e0b" label="Case, medium / unknown quantity" />
              <LegendDot color="#10b981" label="Case, low tier" />
              <div className="flex items-center gap-2 mb-1"><span className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[7px] border-l-transparent border-r-transparent border-b-slate-500" /><span className="text-gray-700">Historical incident</span></div>
              <p className="text-[0.65625rem] text-gray-400 mt-1 max-w-[170px] leading-snug">Tier from oil quantity on board or released, as reported.</p>
            </div>
          }
        />
      </div>

        <Panel title="Cases" subtitle="Ordered by tier, then most recent"
          actions={<button onClick={() => navigate({ tab: 'Spill Incidents' })} className="text-[0.75rem] text-blue-600 font-semibold hover:underline flex items-center gap-1">All <ArrowRight className="w-3 h-3" /></button>}
          className="col-span-12 lg:col-span-4 xl:col-span-3 h-[560px]" bodyClass="overflow-y-auto" dense>
          {ordered.map((c, i) => {
            const a = getAnalysis(c.id);
            return (
              <button key={c.id} onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}
                className="w-full text-left px-4 py-3.5 border-b border-gray-100 hover:bg-blue-50/60 flex items-start gap-3 group">
                <div className="font-bold text-gray-300 text-base pt-0.5 w-4 text-center flex-shrink-0">{i + 1}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start gap-2 mb-0.5">
                    <span className="font-bold text-[0.75rem] text-[#0a192f] group-hover:text-blue-700 leading-snug">{c.title}</span>
                    <Tier tier={c.tier} />
                  </div>
                  <p className="text-[0.6875rem] text-gray-500 truncate">{fmt.precise(c.incidentTime, c.facts.incident.timePrecision)} · {c.region}</p>
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    <StatusBadge status={c.status} />
                    <Badge tone="gray">{c.detection.scenes.length} SAR</Badge>
                    {(() => {
                      const src = reportedSource(world, c.id);
                      if (src?.isFacility) return <span className="text-[0.65625rem] text-gray-500 truncate">Reported source: {src.name}</span>;
                      return a?.ranked[0] && <span className="text-[0.65625rem] text-gray-500 truncate">Top AIS candidate: {world.vesselsByMmsi.get(a.ranked[0].mmsi)?.name}</span>;
                    })()}
                  </div>
                </div>
              </button>
            );
          })}
        </Panel>

      <div className="col-span-12 grid grid-cols-12 gap-4">
        <Panel title="Case record events" className="col-span-12 lg:col-span-7" dense
          actions={<button onClick={() => navigate({ tab: 'Case Archive', section: 'audit' })} className="text-[0.75rem] text-blue-600 font-semibold hover:underline flex items-center gap-1">Audit trail <ArrowRight className="w-3 h-3" /></button>}>
          <table className="w-full text-[0.75rem] text-left">
            <thead className="text-[0.6875rem] text-gray-500 bg-gray-50 border-b border-gray-100 uppercase">
              <tr><th className="px-4 py-2 font-bold">When (UTC)</th><th className="px-4 py-2 font-bold">Event</th><th className="px-4 py-2 font-bold">Case</th><th className="px-4 py-2 font-bold" /></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recordEvents.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => world.cases.some((c) => c.id === a.target) && navigate({ tab: 'Investigation', caseId: a.target })}>
                  <td className="px-4 py-2 text-gray-500 font-mono whitespace-nowrap">{fmt.utcShort(a.t)}</td>
                  <td className="px-4 py-2 text-gray-900">{a.action}</td>
                  <td className="px-4 py-2 text-gray-600 font-mono text-[0.6875rem] truncate max-w-[150px]">{a.target}</td>
                  <td className="px-4 py-2"><ProvenanceBadge p={a.provenance} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Data quality warnings" subtitle="From the pipeline build" className="col-span-12 lg:col-span-5" dense>
          <div className="p-4 space-y-2.5 max-h-72 overflow-y-auto">
            {warnings.length === 0 && <p className="text-[0.75rem] text-gray-400">No warnings.</p>}
            {warnings.map((w, i) => (
              <button key={i} onClick={() => navigate({ tab: 'Investigation', caseId: w.caseId })} className="w-full text-left flex gap-2 text-[0.75rem] leading-normal hover:bg-amber-50 rounded px-1.5 py-1">
                <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" />
                <span><span className="font-mono text-[0.6875rem] text-gray-500">{w.caseId.slice(4)}</span> {w.text}</span>
              </button>
            ))}
          </div>
        </Panel>
      </div>

      <div className="col-span-12 grid grid-cols-12 gap-4 items-start">
        <Panel title="Integration status" subtitle="Indian primary first, fallbacks after" className="col-span-12 lg:col-span-8" dense
          actions={<button onClick={() => navigate({ tab: 'Data Management', section: 'sources' })} className="text-[0.75rem] text-blue-600 font-semibold hover:underline">Details</button>}>
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2.5">
            {world.dataSources.map((d) => (
              <div key={d.id} className="flex items-center gap-2.5 text-[0.75rem] min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${d.status === 'Online' ? 'bg-emerald-500' : d.status === 'Interim fallback' ? 'bg-amber-500' : d.status === 'Not configured' ? 'bg-blue-400' : 'bg-slate-300'}`} />
                <span className="font-semibold text-gray-800 truncate flex-1" title={d.message}>{d.name}</span>
                <span className="text-[0.65625rem] text-gray-400 flex-shrink-0">{d.kind}</span>
                <span className={`text-[0.65625rem] font-bold flex-shrink-0 ${d.sovereign ? 'text-emerald-700' : 'text-gray-400'}`}>{d.sovereign ? 'IN' : 'EXT'}</span>
              </div>
            ))}
          </div>
        </Panel>

        <div className="col-span-12 lg:col-span-4 flex flex-col">
          <h3 className="font-bold text-gray-800 mb-2 pl-1 text-sm">Quick actions</h3>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <QuickAction icon={<FileText className="w-5 h-5 text-blue-600" />} label={'All\ncases'} onClick={() => navigate({ tab: 'Spill Incidents' })} />
            <QuickAction icon={<Search className="w-5 h-5 text-blue-600" />} label={'Open top\ncase'} onClick={() => navigate({ tab: 'Investigation', caseId: ordered[0]?.id })} />
            <QuickAction icon={<BarChart2 className="w-5 h-5 text-blue-600" />} label={'Generate\nreport'} onClick={() => navigate({ tab: 'Reports' })} />
            <QuickAction icon={<Settings className="w-5 h-5 text-blue-600" />} label={'Integration\nstatus'} onClick={() => navigate({ tab: 'Data Management', section: 'sources' })} />
          </div>
          <InfoBanner tone="blue" icon={<Activity className="w-3.5 h-3.5" />}>
            Case data updated {fmt.ago(new Date(world.generatedAt).getTime(), now)}.
          </InfoBanner>
        </div>
      </div>
    </main>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      <div className="w-2.5 h-2.5 rounded-full border border-white shadow" style={{ background: color }} /> <span className="text-gray-700">{label}</span>
    </div>
  );
}

function QuickAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="bg-white border border-gray-200 rounded-lg p-3 flex flex-col items-center justify-center gap-1.5 shadow-sm hover:border-blue-400 hover:shadow-md transition-all text-center">
      <div className="bg-blue-50/60 p-1.5 rounded-lg">{icon}</div>
      <span className="text-[0.6875rem] font-semibold text-gray-700 whitespace-pre-line leading-snug">{label}</span>
    </button>
  );
}
