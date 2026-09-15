import { useMemo, useState } from 'react';
import {
  Satellite, FileText, Anchor, Activity, ClipboardList, Database,
  ArrowRight, Search, BarChart2, Settings, Layers, Megaphone, Wind, Shield,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPolygon } from './components/MapView';
import { Panel, StatCard, Tier, StatusBadge, Badge, Toggle, EmptyState, InfoBanner } from './components/ui';
import { analysePolygon } from './lib/geo';
import { ECOLOGICAL_AREAS, CORRIDORS, PORTS } from './data/geography';
import { sampleField } from './engine/ocean';

export default function Dashboard() {
  const { world, now, navigate, getAnalysis, revision } = useStore();
  const [basemap, setBasemap] = useState<BasemapStyle>('map');
  const [layers, setLayers] = useState({
    cases: true, eez: true, esa: false, corridors: false, ports: false, currents: false,
  });
  const [layersOpen, setLayersOpen] = useState(false);

  const openCases = useMemo(
    () => world.cases.filter((c) => !['Closed', 'Dismissed — Look-alike'].includes(c.status)),
    [world.cases, revision]
  );

  const stats = useMemo(() => {
    const passes24 = world.passes.filter((p) => p.start > now - 86400_000 && p.start <= now);
    const bySensor = passes24.reduce<Record<string, number>>((acc, p) => {
      acc[p.sensor] = (acc[p.sensor] ?? 0) + 1;
      return acc;
    }, {});
    const vesselsUnderInvestigation = new Set(openCases.flatMap((c) => c.candidateMmsis)).size;
    const alertsThisWeek = world.alerts.filter((a) => a.issuedAt > now - 7 * 86400_000).length;
    return {
      passes24: passes24.length,
      bySensor: Object.entries(bySensor).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s, n]) => `${s}: ${n}`).join(' · '),
      vesselsUnderInvestigation,
      alertsThisWeek,
      newToday: world.cases.filter((c) => c.createdAt > now - 86400_000).length,
    };
  }, [world, now, openCases, revision]);

  const urgent = useMemo(() => {
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return [...openCases]
      .sort((a, b) => rank[a.tier] - rank[b.tier] || b.detection.acquiredAt - a.detection.acquiredAt)
      .slice(0, 6);
  }, [openCases]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (layers.cases) {
      for (const c of world.cases) {
        const shape = analysePolygon(c.detection.polygon.ring);
        const closed = ['Closed', 'Dismissed — Look-alike'].includes(c.status);
        out.push({
          id: c.id,
          position: shape.centroid,
          kind: 'case',
          color: closed ? '#94a3b8' : c.tier === 'HIGH' ? '#dc2626' : c.tier === 'MEDIUM' ? '#f59e0b' : '#10b981',
          size: 5 + c.confidence * 5,
          label: c.id,
          sublabel: c.subRegion,
          pulse: !closed && c.tier === 'HIGH',
          dimmed: closed,
          z: closed ? 1 : 3,
          meta: {
            Status: c.status,
            Confidence: fmt.pct(c.confidence),
            Detected: fmt.utcShort(c.detection.acquiredAt),
            Area: `${shape.areaKm2.toFixed(1)} km²`,
          },
        });
      }
    }
    if (layers.ports) {
      for (const p of PORTS) {
        out.push({
          id: `port-${p.name}`, position: p, kind: 'port',
          color: p.oilTerminal ? '#7c3aed' : '#64748b', size: p.tier === 1 ? 4.5 : 3.5,
          label: p.name, sublabel: `${p.state}${p.oilTerminal ? ' · oil terminal' : ''}`, z: 2,
        });
      }
    }
    return out;
  }, [world.cases, layers.cases, layers.ports, revision]);

  const polygons = useMemo<MapPolygon[]>(() => {
    const out: MapPolygon[] = [];
    if (layers.esa) {
      for (const a of ECOLOGICAL_AREAS) {
        out.push({
          id: a.id, rings: [a.ring],
          fill: a.sensitivity >= 5 ? 'rgba(16,185,129,0.22)' : 'rgba(16,185,129,0.14)',
          stroke: '#059669', strokeWidth: 1.2, z: 0,
        });
      }
    }
    if (layers.cases) {
      for (const c of world.cases) {
        if (['Closed', 'Dismissed — Look-alike'].includes(c.status)) continue;
        out.push({
          id: `slick-${c.id}`,
          rings: [c.detection.polygon.ring, ...(c.detection.polygon.fragments ?? [])],
          fill: 'rgba(17,24,39,0.6)', stroke: '#111827', strokeWidth: 1, z: 2,
        });
      }
    }
    return out;
  }, [layers.esa, layers.cases, world.cases, revision]);

  const paths = useMemo(() => {
    if (!layers.corridors) return [];
    return CORRIDORS.map((c) => ({
      id: c.id, points: c.waypoints,
      stroke: c.highRisk ? '#f97316' : '#60a5fa',
      strokeWidth: 1.6, dash: '6 4', opacity: 0.75, z: 1,
    }));
  }, [layers.corridors]);

  const vectors = useMemo(() => {
    if (!layers.currents) return [];
    return sampleField({ north: 25, south: 4, east: 96, west: 65 }, new Date(now), 16, 12, 'current')
      .map((s) => ({ position: s.position, dirDeg: s.sample.dirTo, magnitude: s.sample.speed }));
  }, [layers.currents, now]);

  const health = useMemo(() => {
    const nextPass = (sensor: string) => world.passes.find((p) => p.sensor === sensor && p.start > now);
    return [
      { icon: <Satellite className="w-4 h-4" />, name: 'EOS-04', type: '(C-SAR)', ...srcStatus(world, 'DS-EOS4'), info: nextPass('EOS-04') ? `Next pass: ${fmt.utc(nextPass('EOS-04')!.start)}` : 'No pass scheduled' },
      { icon: <Satellite className="w-4 h-4" />, name: 'NISAR', type: '(L/S-SAR)', ...srcStatus(world, 'DS-NISAR'), info: nextPass('NISAR') ? `Next pass: ${fmt.utc(nextPass('NISAR')!.start)}` : 'No pass scheduled' },
      { icon: <Database className="w-4 h-4" />, name: 'INCOIS', type: '(Ocean model)', ...srcStatus(world, 'DS-INCOIS-OC'), info: `Last sync: ${fmt.ago(world.dataSources.find((d) => d.id === 'DS-INCOIS-OC')!.lastSync, now)}` },
      { icon: <Wind className="w-4 h-4" />, name: 'IMD', type: '(Wind grid)', ...srcStatus(world, 'DS-IMD'), info: `Last sync: ${fmt.ago(world.dataSources.find((d) => d.id === 'DS-IMD')!.lastSync, now)}` },
      { icon: <Anchor className="w-4 h-4" />, name: 'AIS', type: '(Terrestrial + S-AIS)', ...srcStatus(world, 'DS-AIS-TER'), info: `${fmt.num(world.dataSources.find((d) => d.id === 'DS-AIS-TER')!.recordsPerMin + world.dataSources.find((d) => d.id === 'DS-AIS-SAT')!.recordsPerMin)} records/min` },
    ];
  }, [world, now, revision]);

  const recentActivity = useMemo(
    () => world.audit.filter((a) => ['Detection', 'Analysis', 'Attribution', 'Dispatch', 'Alert'].includes(a.category)).slice(0, 7),
    [world.audit, revision]
  );

  const systemMessages = useMemo(
    () => world.audit.filter((a) => a.category === 'System' || a.category === 'Access').slice(0, 6),
    [world.audit, revision]
  );

  return (
    <main className="flex-1 min-h-0 p-3 grid grid-cols-12 gap-3 overflow-y-auto content-start">
      <div className="col-span-12 grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard
          icon={<ClipboardList className="w-6 h-6" />} title="Active cases" value={openCases.length}
          trend={stats.newToday > 0 ? `+${stats.newToday} in the last 24 h` : 'No new cases today'}
          trendTone={stats.newToday > 0 ? 'up' : 'neutral'}
          onClick={() => navigate({ tab: 'Spill Incidents' })}
        />
        <StatCard
          icon={<Satellite className="w-6 h-6" />} title="Satellite passes" subtitle="Last 24 hours" value={stats.passes24}
          trend={stats.bySensor} onClick={() => navigate({ tab: 'Satellite Tasking' })}
        />
        <StatCard
          icon={<Anchor className="w-6 h-6" />} title="Vessels under investigation" value={stats.vesselsUnderInvestigation}
          trend={`Across ${openCases.length} open case${openCases.length === 1 ? '' : 's'}`}
          onClick={() => navigate({ tab: 'Vessel Analysis' })}
        />
        <StatCard
          icon={<Megaphone className="w-6 h-6" />} title="Alerts dispatched" subtitle="This week" value={stats.alertsThisWeek}
          accent="amber" trend={`${fmt.num(world.alerts.reduce((s, a) => s + a.reach.reduce((x, r) => x + r.delivered, 0), 0))} recipients reached`}
          onClick={() => navigate({ tab: 'SACHET / SAMUDRA' })}
        />
        <StatCard
          icon={<Shield className="w-6 h-6" />} title="Repeat offenders" value={world.vessels.filter((v) => v.priorOffences >= 2).length}
          accent="red" trend={`${world.vessels.filter((v) => v.sanctioned).length} sanctioned vessels tracked`}
          onClick={() => navigate({ tab: 'Offender Registry' })}
        />
      </div>

      <div className="col-span-12 lg:col-span-8 xl:col-span-9 rounded-lg shadow-sm border border-gray-200 overflow-hidden relative bg-white" style={{ minHeight: 520 }}>
        <MapView
          basemap={basemap}
          initialCentre={{ lat: 14.5, lon: 80 }}
          initialZoom={3.9}
          markers={markers}
          polygons={polygons}
          paths={paths}
          vectors={vectors}
          vectorLabel={layers.currents ? `Surface current field · ${fmt.utcShort(now)}` : undefined}
          showEez={layers.eez}
          onMarkerClick={(m) => {
            if (m.kind === 'case') navigate({ tab: 'Investigation', caseId: m.id });
          }}
          overlay={
            <>
              <div className="absolute top-3 left-3 z-20 flex gap-2 items-start">
                <BasemapSwitch value={basemap} onChange={setBasemap} />
                <div className="relative">
                  <button
                    onClick={() => setLayersOpen((o) => !o)}
                    className="bg-white rounded shadow-md border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 flex items-center gap-1.5"
                  >
                    <Layers className="w-3.5 h-3.5" /> Layers
                  </button>
                  {layersOpen && (
                    <div className="absolute top-full mt-1 left-0 bg-white rounded shadow-xl border border-gray-300 p-2.5 w-52 z-30">
                      <p className="text-[10px] font-bold text-gray-500 uppercase mb-1.5">Map layers</p>
                      <Toggle checked={layers.cases} onChange={(v) => setLayers({ ...layers, cases: v })} label="Detected slicks" count={world.cases.length} />
                      <Toggle checked={layers.eez} onChange={(v) => setLayers({ ...layers, eez: v })} label="Indian EEZ boundary" />
                      <Toggle checked={layers.esa} onChange={(v) => setLayers({ ...layers, esa: v })} label="Sensitive areas (NCSCM)" count={ECOLOGICAL_AREAS.length} />
                      <Toggle checked={layers.corridors} onChange={(v) => setLayers({ ...layers, corridors: v })} label="Shipping corridors" count={CORRIDORS.length} />
                      <Toggle checked={layers.ports} onChange={(v) => setLayers({ ...layers, ports: v })} label="Ports & terminals" count={PORTS.length} />
                      <Toggle checked={layers.currents} onChange={(v) => setLayers({ ...layers, currents: v })} label="Surface currents" />
                    </div>
                  )}
                </div>
              </div>
            </>
          }
          legend={
            <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded-lg p-2.5 text-[10px] shadow-lg">
              <h4 className="font-bold mb-1.5 text-gray-700 uppercase tracking-wide">Case risk tier</h4>
              <LegendDot color="#dc2626" label="High" />
              <LegendDot color="#f59e0b" label="Medium" />
              <LegendDot color="#10b981" label="Low" />
              <LegendDot color="#94a3b8" label="Closed / dismissed" />
              <div className="flex items-center gap-2 border-t border-gray-200 pt-1.5 mt-1.5 text-gray-600">
                <div className="w-4 border-b-2 border-dashed border-blue-500" /> <span>Indian EEZ</span>
              </div>
              <p className="text-[9px] text-gray-400 mt-1.5 max-w-[150px] leading-tight">Marker size scales with detection confidence.</p>
            </div>
          }
        />
      </div>

      <div className="col-span-12 lg:col-span-4 xl:col-span-3 flex flex-col gap-3" style={{ minHeight: 520 }}>
        <Panel
          title="Urgent cases"
          subtitle={`${urgent.length} open, ordered by risk tier`}
          actions={<button onClick={() => navigate({ tab: 'Spill Incidents' })} className="text-[11px] text-blue-600 font-semibold hover:underline flex items-center gap-1">View all <ArrowRight className="w-3 h-3" /></button>}
          className="flex-1"
          bodyClass="overflow-y-auto"
          dense
        >
          {urgent.length === 0 ? (
            <EmptyState title="No open cases" body="Every detection has been resolved or dismissed." />
          ) : (
            urgent.map((c, i) => {
              const a = getAnalysis(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}
                  className="w-full text-left p-2.5 border-b border-gray-100 hover:bg-blue-50/60 flex items-start gap-2.5 group"
                >
                  <div className="font-bold text-gray-300 text-base pt-0.5 w-4 text-center flex-shrink-0">{i + 1}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start gap-2 mb-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-bold text-xs text-[#0a192f] group-hover:text-blue-700 truncate">{c.id}</span>
                        <Tier tier={c.tier} />
                      </div>
                      <span className="text-[10px] font-medium text-gray-400 flex-shrink-0">{fmt.ago(c.detection.acquiredAt, now)}</span>
                    </div>
                    <p className="text-[11px] text-gray-700 truncate">{c.subRegion}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <StatusBadge status={c.status} />
                      {a && a.ranked[0] && (
                        <span className="text-[9px] text-gray-500 truncate">
                          Top suspect {fmt.pct(a.ranked[0].total, 0)}
                        </span>
                      )}
                      {a && a.ranked.some((r) => r.darkDuringWindow) && <Badge tone="red">DARK</Badge>}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </Panel>

        <Panel title="Data source health" subtitle={`Checked ${fmt.ago(now - 120000, now)}`} dense>
          <div className="p-2.5 flex flex-col gap-2.5">
            {health.map((h) => (
              <div key={h.name} className="flex items-center gap-2.5">
                <div className="bg-blue-50 p-1.5 rounded text-blue-600 flex-shrink-0">{h.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="font-bold text-[11px] text-gray-800">{h.name}</span>
                    <span className="text-[10px] text-gray-500 truncate">{h.type}</span>
                    <span className="ml-auto flex-shrink-0"><StatusBadge status={h.status} /></span>
                  </div>
                  <p className="text-[9.5px] text-gray-600 truncate">{h.info}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="col-span-12 grid grid-cols-12 gap-3">
        <Panel title="Recent activity" className="col-span-12 lg:col-span-5" dense
          actions={<button onClick={() => navigate({ tab: 'Case Archive', section: 'audit' })} className="text-[11px] text-blue-600 font-semibold hover:underline flex items-center gap-1">Audit trail <ArrowRight className="w-3 h-3" /></button>}>
          <table className="w-full text-[11px] text-left">
            <thead className="text-[9.5px] text-gray-500 bg-gray-50 border-b border-gray-100 uppercase">
              <tr>
                <th className="px-3 py-1.5 font-bold">Time</th>
                <th className="px-3 py-1.5 font-bold">Event</th>
                <th className="px-3 py-1.5 font-bold">Target</th>
                <th className="px-3 py-1.5 font-bold">Category</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recentActivity.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => world.cases.some((c) => c.id === a.target) && navigate({ tab: 'Investigation', caseId: a.target })}>
                  <td className="px-3 py-1.5 text-gray-500 font-mono whitespace-nowrap">{fmt.utcShort(a.t)}</td>
                  <td className="px-3 py-1.5 text-gray-900 font-medium">{a.action}</td>
                  <td className="px-3 py-1.5 text-gray-600 font-mono text-[10px] truncate max-w-[130px]">{a.target}</td>
                  <td className="px-3 py-1.5"><Badge tone={categoryTone(a.category)}>{a.category}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="System messages" className="col-span-12 lg:col-span-4" dense>
          <table className="w-full text-[11px] text-left">
            <thead className="text-[9.5px] text-gray-500 bg-gray-50 border-b border-gray-100 uppercase">
              <tr><th className="px-3 py-1.5 font-bold w-24">Time</th><th className="px-3 py-1.5 font-bold">Message</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {systemMessages.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 text-gray-500 font-mono whitespace-nowrap">{fmt.utcShort(a.t)}</td>
                  <td className="px-3 py-1.5 text-gray-800">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <div className="col-span-12 lg:col-span-3 flex flex-col">
          <h3 className="font-bold text-gray-800 mb-2 pl-1 text-sm">Quick actions</h3>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <QuickAction icon={<FileText className="w-5 h-5 text-blue-600" />} label={'View all\nincidents'} onClick={() => navigate({ tab: 'Spill Incidents' })} />
            <QuickAction icon={<Search className="w-5 h-5 text-blue-600" />} label={'Open\ninvestigation'} onClick={() => navigate({ tab: 'Investigation', caseId: urgent[0]?.id })} />
            <QuickAction icon={<BarChart2 className="w-5 h-5 text-blue-600" />} label={'Generate\nreport'} onClick={() => navigate({ tab: 'Reports' })} />
            <QuickAction icon={<Settings className="w-5 h-5 text-blue-600" />} label={'Platform\nstatus'} onClick={() => navigate({ tab: 'Data Management', section: 'sources' })} />
          </div>
          <InfoBanner tone="blue" icon={<Activity className="w-3.5 h-3.5" />}>
            Detections, drift paths and suspect rankings on this dashboard are computed live from the
            physics and scoring models each time a case is opened.
          </InfoBanner>
        </div>
      </div>
    </main>
  );
}

function srcStatus(world: ReturnType<typeof useStore>['world'], id: string) {
  const s = world.dataSources.find((d) => d.id === id)!;
  return { status: s.status };
}

function categoryTone(c: string): string {
  return c === 'Detection' ? 'blue' : c === 'Attribution' ? 'violet' : c === 'Dispatch' ? 'amber'
    : c === 'Enforcement' ? 'red' : c === 'Alert' ? 'teal' : 'gray';
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
    <button onClick={onClick} className="bg-white border border-gray-200 rounded-lg p-2.5 flex flex-col items-center justify-center gap-1.5 shadow-sm hover:border-blue-400 hover:shadow-md transition-all text-center">
      <div className="bg-blue-50/60 p-1.5 rounded-lg">{icon}</div>
      <span className="text-[10px] font-semibold text-gray-700 whitespace-pre-line leading-tight">{label}</span>
    </button>
  );
}
