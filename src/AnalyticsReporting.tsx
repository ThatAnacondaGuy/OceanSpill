import { useMemo, useState } from 'react';
import {
  BarChart2, FileText, TrendingUp, AlertTriangle, Download, Target, Activity, Info,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapCircle, type MapMarker } from './components/MapView';
import {
  Panel, Badge, Button, KeyValue, Tabs, StatCard, BarChart, Donut, InfoBanner,
  Select, Modal, Field, Toggle, triggerDownload,
} from './components/ui';
import { MODEL_METRICS } from './engine/detection';
import { analysePolygon } from './lib/geo';
import { CORRIDORS } from './data/geography';

export default function AnalyticsReporting() {
  const { world, now, getAnalysis, navigate, revision } = useStore();
  const [tab, setTab] = useState('overview');
  const [basemap, setBasemap] = useState<BasemapStyle>('dark');
  const [period, setPeriod] = useState('90');
  const [reportOpen, setReportOpen] = useState(false);

  const cutoff = now - Number(period) * 86400_000;
  const inPeriod = useMemo(() => world.cases.filter((c) => c.detection.acquiredAt >= cutoff), [world.cases, cutoff, revision]);

  const stats = useMemo(() => {
    const dismissed = inPeriod.filter((c) => c.status === 'Dismissed — Look-alike');
    // A detection only counts as confirmed once it has survived the look-alike cross-checks
    // and has not been reclassified by an analyst.
    const confirmed = inPeriod.filter((c) => {
      const a = getAnalysis(c.id);
      return (a?.assessment.confidence ?? c.confidence) >= 0.62 && c.status !== 'Dismissed — Look-alike';
    });
    // Attribution is only meaningful for a confirmed spill, so it is scored over that subset.
    const attributed = confirmed.filter((c) => {
      const a = getAnalysis(c.id);
      return a && ['Strong', 'Moderate'].includes(a.verdict.band);
    });
    // Taken from the attributed subset so the funnel stays monotonic — a case cannot reach
    // enforcement without having been attributed first.
    const enforced = attributed.filter((c) => ['Enforcement', 'Closed'].includes(c.status));
    const darkEvents = inPeriod.filter((c) => {
      const a = getAnalysis(c.id);
      return a?.ranked.some((r) => r.darkDuringWindow);
    });
    const totalVolume = inPeriod.reduce((s, c) => s + c.estimatedVolumeM3, 0);
    const totalArea = inPeriod.reduce((s, c) => s + analysePolygon(c.detection.polygon.ring).areaKm2, 0);
    return {
      detections: inPeriod.length, confirmed: confirmed.length, dismissed: dismissed.length,
      attributed: attributed.length, enforced: enforced.length, darkEvents: darkEvents.length,
      totalVolume, totalArea,
      attributionRate: confirmed.length ? attributed.length / confirmed.length : 0,
      enforcementRate: attributed.length ? enforced.length / attributed.length : 0,
    };
  }, [inPeriod, getAnalysis]);

  const byRegion = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of inPeriod) m.set(c.region, (m.get(c.region) ?? 0) + 1);
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [inPeriod]);

  const bySensor = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of inPeriod) m.set(c.detection.sensor, (m.get(c.detection.sensor) ?? 0) + 1);
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [inPeriod]);

  const byVesselType = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of inPeriod) {
      const a = getAnalysis(c.id);
      const top = a?.ranked[0];
      if (!top) continue;
      const v = world.vesselsByMmsi.get(top.mmsi);
      if (v) m.set(v.type, (m.get(v.type) ?? 0) + 1);
    }
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [inPeriod, getAnalysis, world]);

  /** Monthly detection counts derived from the case dates. */
  const monthly = useMemo(() => {
    const months: { label: string; value: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - i, 1);
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      const n = world.cases.filter((c) => c.detection.acquiredAt >= start && c.detection.acquiredAt < end).length;
      months.push({ label: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()], value: n });
    }
    return months;
  }, [world.cases, now, revision]);

  /** Chronic pollution hotspots: detection density per corridor. */
  const hotspots = useMemo(() => {
    return CORRIDORS.map((corridor) => {
      let count = 0;
      let volume = 0;
      for (const c of world.cases) {
        const centre = analysePolygon(c.detection.polygon.ring).centroid;
        const near = corridor.waypoints.some((w) =>
          Math.hypot((w.lat - centre.lat) * 110.6, (w.lon - centre.lon) * 111.3 * Math.cos((centre.lat * Math.PI) / 180)) < 180
        );
        if (near) { count++; volume += c.estimatedVolumeM3; }
      }
      return { corridor, count, volume, intensity: count / Math.max(1, corridor.density / 50) };
    }).sort((a, b) => b.count - a.count);
  }, [world.cases, revision]);

  const hotspotMap = useMemo(() => {
    const circles: MapCircle[] = [];
    const markers: MapMarker[] = [];
    for (const h of hotspots) {
      if (h.count === 0) continue;
      const mid = h.corridor.waypoints[Math.floor(h.corridor.waypoints.length / 2)];
      circles.push({
        id: h.corridor.id, centre: mid, radiusKm: 60 + h.count * 45,
        fill: h.count >= 3 ? 'rgba(220,38,38,0.2)' : h.count >= 2 ? 'rgba(245,158,11,0.18)' : 'rgba(59,130,246,0.14)',
        stroke: h.count >= 3 ? '#dc2626' : h.count >= 2 ? '#f59e0b' : '#3b82f6',
        dash: '5 4', label: `${h.count} detections`,
      });
    }
    for (const c of world.cases) {
      const shape = analysePolygon(c.detection.polygon.ring);
      markers.push({
        id: c.id, position: shape.centroid, kind: 'case',
        color: c.tier === 'HIGH' ? '#dc2626' : c.tier === 'MEDIUM' ? '#f59e0b' : '#10b981',
        size: 3 + Math.min(6, c.estimatedVolumeM3 / 25), label: c.id, sublabel: c.subRegion, z: 5,
        meta: { Volume: `${c.estimatedVolumeM3} m³`, Area: `${shape.areaKm2.toFixed(1)} km²` },
      });
    }
    return { circles, markers };
  }, [hotspots, world.cases]);

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 text-white p-1.5 rounded"><BarChart2 className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Analytics &amp; reporting</h2>
            <p className="text-[11px] text-gray-500">Longitudinal performance and chronic pollution patterns</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={period} onChange={setPeriod}
            options={[{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '180', label: 'Last 6 months' }, { value: '365', label: 'Last year' }]} />
          <Button size="sm" variant="primary" onClick={() => setReportOpen(true)} icon={<FileText className="w-3 h-3" />}>Build report</Button>
        </div>
      </div>

      <Tabs active={tab} onChange={setTab} className="bg-white px-3 flex-shrink-0" tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'hotspots', label: 'Chronic hotspots' },
        { id: 'performance', label: 'Model performance' },
      ]} />

      {tab === 'overview' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="grid grid-cols-5 gap-3">
            <StatCard icon={<Activity className="w-5 h-5" />} title="Detections" value={stats.detections} trend={`in the last ${period} days`} />
            <StatCard icon={<Target className="w-5 h-5" />} title="Attributed" value={stats.attributed}
              trend={`${fmt.pct(stats.attributionRate, 0)} of confirmed spills`} accent="amber" />
            <StatCard icon={<AlertTriangle className="w-5 h-5" />} title="Dark-vessel events" value={stats.darkEvents}
              trend="AIS silent during the window" accent="red" />
            <StatCard icon={<TrendingUp className="w-5 h-5" />} title="Volume released" value={`${fmt.num(stats.totalVolume)} m³`}
              trend={`${stats.totalArea.toFixed(0)} km² affected`} />
            <StatCard icon={<FileText className="w-5 h-5" />} title="Reached enforcement" value={stats.enforced}
              trend={`${fmt.pct(stats.enforcementRate, 0)} of attributed cases`} accent="green" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Panel title="Detections by month" dense>
              <div className="p-3">
                <BarChart data={monthly} height={150} />
                <p className="text-[10px] text-gray-500 mt-2 leading-snug">
                  Counts track satellite revisit opportunity as much as actual discharge rate. A quiet month may
                  mean fewer passes, not cleaner water.
                </p>
              </div>
            </Panel>

            <Panel title="By region" dense>
              <div className="p-3">
                <BarChart horizontal data={byRegion} />
              </div>
            </Panel>

            <Panel title="Case funnel" dense>
              <div className="p-3 flex items-center gap-4">
                <Donut size={120} thickness={20}
                  segments={[
                    { label: 'Enforced', value: stats.enforced, color: '#059669' },
                    { label: 'Attributed', value: Math.max(0, stats.attributed - stats.enforced), color: '#f59e0b' },
                    { label: 'Unattributed', value: Math.max(0, stats.confirmed - stats.attributed), color: '#3b82f6' },
                    { label: 'Dismissed', value: stats.dismissed, color: '#94a3b8' },
                  ]}
                  centreLabel={stats.detections} centreSub="detections" />
                <div className="flex-1 space-y-1.5 text-[10.5px]">
                  <Legend color="#059669" label="Reached enforcement" value={stats.enforced} />
                  <Legend color="#f59e0b" label="Attributed, not enforced" value={Math.max(0, stats.attributed - stats.enforced)} />
                  <Legend color="#3b82f6" label="Confirmed, unattributed" value={Math.max(0, stats.confirmed - stats.attributed)} />
                  <Legend color="#94a3b8" label="Dismissed as look-alike" value={stats.dismissed} />
                </div>
              </div>
            </Panel>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Panel title="Detection sensor mix" dense>
              <div className="p-3"><BarChart horizontal data={bySensor} /></div>
            </Panel>
            <Panel title="Leading suspect by vessel type" dense>
              <div className="p-3">
                <BarChart horizontal data={byVesselType} />
                <p className="text-[10px] text-gray-500 mt-2 leading-snug">
                  Tanker over-representation is expected, but note this measures which vessels the model
                  <i> ranks first</i>, not which were confirmed guilty — the two diverge until forensic matching completes.
                </p>
              </div>
            </Panel>
            <Panel title="Attrition through the pipeline" dense>
              <div className="p-3 space-y-2">
                <Funnel label="Detections raised" value={stats.detections} total={stats.detections} color="#3b82f6" />
                <Funnel label="Survived look-alike checks" value={stats.confirmed} total={stats.detections} color="#6366f1" />
                <Funnel label="Attributed to a vessel" value={stats.attributed} total={stats.detections} color="#f59e0b" />
                <Funnel label="Reached enforcement" value={stats.enforced} total={stats.detections} color="#059669" />
                <p className="text-[10px] text-gray-500 mt-1 leading-snug">
                  The drop from attribution to enforcement is the honest bottleneck: correlation is cheap,
                  physical sampling in open water is not.
                </p>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {tab === 'hotspots' && (
        <div className="flex-1 min-h-0 flex">
          <aside className="w-[330px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
            <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
              <h3 className="text-[11px] font-bold text-gray-700">Chronic pollution hotspots</h3>
              <p className="text-[9.5px] text-gray-500 mt-0.5">Detection density along known traffic corridors</p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {hotspots.map((h, i) => (
                <div key={h.corridor.id} className="px-2.5 py-2 border-b border-gray-100">
                  <div className="flex items-start gap-2">
                    <div className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-black flex-shrink-0 ${
                      i === 0 ? 'bg-red-600 text-white' : i < 3 ? 'bg-amber-500 text-white' : 'bg-gray-300 text-gray-700'}`}>{i + 1}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold text-gray-900 leading-tight">{h.corridor.name}</p>
                      <div className="flex gap-3 mt-1 text-[9.5px] text-gray-600">
                        <span>{h.count} detections</span>
                        <span>{fmt.num(h.volume)} m³</span>
                        <span>{h.corridor.density}/day traffic</span>
                      </div>
                      <div className="mt-1 h-1.5 bg-gray-200 rounded overflow-hidden">
                        <div className={`h-full ${h.count >= 3 ? 'bg-red-500' : h.count >= 2 ? 'bg-amber-500' : 'bg-blue-500'}`}
                          style={{ width: `${Math.min(100, (h.count / Math.max(1, hotspots[0].count)) * 100)}%` }} />
                      </div>
                      <p className="text-[10px] text-gray-600 mt-1 leading-snug">{h.corridor.riskNote}</p>
                      {h.corridor.highRisk && <Badge tone="red" className="mt-1">High-risk corridor</Badge>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-2 border-t border-gray-200">
              <InfoBanner tone="blue" icon={<Info className="w-3 h-3" />}>
                Density is normalised against traffic volume, so a busy lane does not automatically look dirty.
                What stands out is discharge <i>per transit</i>.
              </InfoBanner>
            </div>
          </aside>
          <div className="flex-1 min-w-0 relative">
            <MapView
              basemap={basemap} circles={hotspotMap.circles} markers={hotspotMap.markers}
              initialCentre={{ lat: 14, lon: 80 }} initialZoom={3.7}
              onMarkerClick={(m) => navigate({ tab: 'Investigation', caseId: m.id })}
              overlay={<div className="absolute top-3 left-3 z-20"><BasemapSwitch value={basemap} onChange={setBasemap} /></div>}
              legend={
                <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2.5 text-[10px] shadow-lg">
                  <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Hotspot intensity</h4>
                  <div className="flex items-center gap-2 mb-1"><div className="w-3 h-3 rounded-full border-2 border-red-500 bg-red-500/20" /><span className="text-gray-700">3+ detections</span></div>
                  <div className="flex items-center gap-2 mb-1"><div className="w-3 h-3 rounded-full border-2 border-amber-500 bg-amber-500/20" /><span className="text-gray-700">2 detections</span></div>
                  <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full border-2 border-blue-500 bg-blue-500/20" /><span className="text-gray-700">1 detection</span></div>
                  <p className="text-[9px] text-gray-400 mt-1.5 max-w-[150px]">Marker size scales with released volume.</p>
                </div>
              }
            />
          </div>
        </div>
      )}

      {tab === 'performance' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <InfoBanner tone="amber" icon={<Info className="w-3.5 h-3.5" />}>
            <b>Per-class metrics, not a headline accuracy figure.</b> {MODEL_METRICS.note} A single "94% accurate"
            badge would be true and useless — the sea class alone is 93.8% of every scene.
          </InfoBanner>

          <div className="grid grid-cols-2 gap-3">
            <Panel title="Segmentation performance by class" subtitle={MODEL_METRICS.version} dense>
              <div className="p-3">
                <table className="w-full text-[11px]">
                  <thead className="text-[9.5px] text-gray-500 uppercase border-b border-gray-200">
                    <tr>
                      <th className="text-left py-1.5 font-bold">Class</th>
                      <th className="text-right py-1.5 font-bold">IoU</th>
                      <th className="text-right py-1.5 font-bold">Dice</th>
                      <th className="text-right py-1.5 font-bold">Pixel support</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {MODEL_METRICS.classes.map((c) => {
                      const key = c.name === 'Oil spill' || c.name === 'Look-alike';
                      return (
                        <tr key={c.name} className={key ? 'bg-amber-50/50' : ''}>
                          <td className="py-1.5 font-semibold text-gray-800">
                            {c.name}{key && <span className="text-[9px] text-amber-700 ml-1">operationally critical</span>}
                          </td>
                          <td className="py-1.5 text-right font-mono font-bold text-gray-900">{c.iou.toFixed(3)}</td>
                          <td className="py-1.5 text-right font-mono text-gray-700">{c.dice.toFixed(3)}</td>
                          <td className="py-1.5 text-right font-mono text-gray-500">{fmt.pct(c.support, 1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="bg-red-50 border border-red-200 rounded p-2">
                    <p className="text-[9.5px] font-bold text-red-900 uppercase">False positive rate</p>
                    <p className="text-lg font-black text-red-700">{fmt.pct(MODEL_METRICS.falsePositiveRate)}</p>
                    <p className="text-[9px] text-red-700">Look-alikes reported as oil</p>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded p-2">
                    <p className="text-[9.5px] font-bold text-amber-900 uppercase">False negative rate</p>
                    <p className="text-lg font-black text-amber-700">{fmt.pct(MODEL_METRICS.falseNegativeRate)}</p>
                    <p className="text-[9px] text-amber-700">Real spills missed</p>
                  </div>
                </div>
              </div>
            </Panel>

            <Panel title="Model configuration" dense>
              <div className="p-3 space-y-3">
                <KeyValue cols={1} items={[
                  ['Architecture', MODEL_METRICS.architecture],
                  ['Training corpus', MODEL_METRICS.trainedOn],
                  ['Loss function', MODEL_METRICS.loss],
                  ['Input', MODEL_METRICS.input],
                  ['Mean IoU', MODEL_METRICS.meanIou.toFixed(3)],
                  ['Inference', `${MODEL_METRICS.inferenceMsPerTile} ms per 256×256 tile`],
                ]} />
                <div>
                  <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Class imbalance</p>
                  <div className="flex h-5 rounded overflow-hidden border border-gray-200">
                    {MODEL_METRICS.classes.map((c, i) => (
                      <div key={c.name} title={`${c.name}: ${fmt.pct(c.support, 1)}`}
                        style={{ width: `${c.support * 100}%`, background: ['#cbd5e1', '#111827', '#f59e0b', '#ef4444', '#84cc16'][i] }} />
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1.5 leading-snug">
                    Oil occupies about 1.1% of annotated pixels. This is why the model trains against Dice and
                    focal loss rather than cross-entropy, and why IoU is the reported metric.
                  </p>
                </div>
              </div>
            </Panel>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Panel title="Detection outcome audit" subtitle="What happened to every detection raised" dense>
              <div className="p-3 space-y-2">
                {world.cases.map((c) => {
                  const a = getAnalysis(c.id);
                  const dismissed = c.status === 'Dismissed — Look-alike';
                  return (
                    <button key={c.id} onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}
                      className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded border border-gray-200 hover:border-blue-400 hover:bg-blue-50/40">
                      <span className="font-mono text-[10.5px] font-bold text-gray-900 w-[118px] flex-shrink-0">{c.id}</span>
                      <div className="flex-1 h-1.5 bg-gray-200 rounded overflow-hidden">
                        <div className={`h-full ${dismissed ? 'bg-slate-400' : (a?.assessment.confidence ?? 0) > 0.8 ? 'bg-emerald-500' : 'bg-amber-500'}`}
                          style={{ width: `${(a?.assessment.confidence ?? c.confidence) * 100}%` }} />
                      </div>
                      <span className="font-mono text-[10px] font-bold text-gray-700 w-10 text-right flex-shrink-0">
                        {fmt.pct(a?.assessment.confidence ?? c.confidence, 0)}
                      </span>
                      <Badge tone={dismissed ? 'gray' : c.status === 'Closed' ? 'green' : 'blue'} className="w-[96px] justify-center flex-shrink-0">
                        {dismissed ? 'Look-alike' : c.status}
                      </Badge>
                    </button>
                  );
                })}
                <p className="text-[10px] text-gray-500 leading-snug pt-1">
                  Dismissed detections stay on this list permanently. Removing them would make the system look
                  more accurate than it is, and would destroy the only record from which the real false-positive
                  rate can be measured.
                </p>
              </div>
            </Panel>

            <Panel title="Operational timeliness" dense>
              <div className="p-3 space-y-3">
                {[
                  { label: 'Acquisition → detection raised', minutes: 6, target: 15 },
                  { label: 'Detection → hindcast complete', minutes: 26, target: 30 },
                  { label: 'Hindcast → candidates scored', minutes: 41, target: 60 },
                  { label: 'Scored → analyst review', minutes: 90, target: 120 },
                  { label: 'Review → verification dispatched', minutes: 210, target: 240 },
                ].map((m) => (
                  <div key={m.label}>
                    <div className="flex justify-between text-[10.5px] mb-0.5">
                      <span className="text-gray-700">{m.label}</span>
                      <span className={`font-mono font-bold ${m.minutes <= m.target ? 'text-emerald-600' : 'text-red-600'}`}>
                        {m.minutes} min <span className="text-gray-400 font-normal">/ {m.target}</span>
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-200 rounded overflow-hidden">
                      <div className={`h-full ${m.minutes <= m.target ? 'bg-emerald-500' : 'bg-red-500'}`}
                        style={{ width: `${Math.min(100, (m.minutes / m.target) * 100)}%` }} />
                    </div>
                  </div>
                ))}
                <p className="text-[10px] text-gray-500 leading-snug">
                  The binding constraint is not compute — the full pipeline runs in under an hour. It is satellite
                  revisit interval, which is why tasking optimisation matters more than model speed.
                </p>
              </div>
            </Panel>
          </div>
        </div>
      )}

      <ReportModal open={reportOpen} onClose={() => setReportOpen(false)} period={period} stats={stats}
        byRegion={byRegion} hotspots={hotspots} />
    </main>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />
      <span className="flex-1 text-gray-700">{label}</span>
      <span className="font-mono font-bold text-gray-900">{value}</span>
    </div>
  );
}

function Funnel({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-[10.5px] mb-0.5">
        <span className="text-gray-700">{label}</span>
        <span className="font-mono font-bold text-gray-900">{value} <span className="text-gray-400 font-normal">({pct.toFixed(0)}%)</span></span>
      </div>
      <div className="h-2 bg-gray-200 rounded overflow-hidden">
        <div className="h-full rounded" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function ReportModal({ open, onClose, period, stats, byRegion, hotspots }: any) {
  const { world, now, currentUser, notify } = useStore();
  const [sections, setSections] = useState({
    summary: true, regional: true, hotspots: true, performance: true, cases: true, caveats: true,
  });
  const [title, setTitle] = useState('Marine Pollution Surveillance — Periodic Report');

  const build = () => {
    const L: string[] = [];
    L.push('='.repeat(72), title.toUpperCase(), '='.repeat(72), '');
    L.push(`Reporting period : last ${period} days`);
    L.push(`Prepared         : ${fmt.utc(now)}`);
    L.push(`Prepared by      : ${currentUser.name}, ${currentUser.role}, ${currentUser.agency}`);
    L.push(`Classification   : RESTRICTED — For Official Use`, '');

    if (sections.summary) {
      L.push('1. EXECUTIVE SUMMARY', '-'.repeat(72));
      L.push(`Detections raised              : ${stats.detections}`);
      L.push(`Survived look-alike screening  : ${stats.confirmed}`);
      L.push(`Dismissed as natural features  : ${stats.dismissed}`);
      L.push(`Attributed to a vessel         : ${stats.attributed} (${fmt.pct(stats.attributionRate, 0)} of confirmed)`);
      L.push(`Suspected dark-vessel events   : ${stats.darkEvents}`);
      L.push(`Progressed to enforcement      : ${stats.enforced}`);
      L.push(`Estimated volume released      : ${fmt.num(stats.totalVolume)} m³`);
      L.push(`Sea surface affected           : ${stats.totalArea.toFixed(1)} km²`, '');
    }
    if (sections.regional) {
      L.push('2. REGIONAL DISTRIBUTION', '-'.repeat(72));
      for (const r of byRegion) L.push(`  ${r.label.padEnd(30)} ${String(r.value).padStart(3)} detections`);
      L.push('');
    }
    if (sections.hotspots) {
      L.push('3. CHRONIC POLLUTION HOTSPOTS', '-'.repeat(72));
      for (const h of hotspots.filter((x: any) => x.count > 0)) {
        L.push(`  ${h.corridor.name}`);
        L.push(`    Detections : ${h.count}   Volume : ${fmt.num(h.volume)} m³   Traffic : ${h.corridor.density}/day`);
        L.push(`    ${h.corridor.riskNote}`, '');
      }
    }
    if (sections.performance) {
      L.push('4. MODEL PERFORMANCE', '-'.repeat(72));
      L.push(`  Version : ${MODEL_METRICS.version}`);
      L.push(`  ${MODEL_METRICS.architecture}`, '');
      L.push('  Class                 IoU     Dice    Support');
      for (const c of MODEL_METRICS.classes) {
        L.push(`  ${c.name.padEnd(20)} ${c.iou.toFixed(3)}   ${c.dice.toFixed(3)}   ${fmt.pct(c.support, 1)}`);
      }
      L.push('');
      L.push(`  False positive rate : ${fmt.pct(MODEL_METRICS.falsePositiveRate)}`);
      L.push(`  False negative rate : ${fmt.pct(MODEL_METRICS.falseNegativeRate)}`);
      L.push(`  Note: ${MODEL_METRICS.note}`, '');
    }
    if (sections.cases) {
      L.push('5. CASE REGISTER', '-'.repeat(72));
      for (const c of world.cases) {
        L.push(`  ${c.id}  [${c.tier}]  ${c.status}`);
        L.push(`    ${c.subRegion}`);
        L.push(`    Detected ${fmt.utc(c.detection.acquiredAt)} by ${c.detection.sensor}`);
        L.push(`    Confidence ${fmt.pct(c.confidence)}   Volume ${c.estimatedVolumeM3} m³`);
        if (c.lookalikeReason) L.push(`    DISMISSED: ${c.lookalikeReason}`);
        L.push('');
      }
    }
    if (sections.caveats) {
      L.push('6. INTERPRETATION AND LIMITATIONS', '-'.repeat(72));
      L.push('  a. Detection counts reflect satellite revisit opportunity as much as discharge rate.');
      L.push('     A reduction between periods may indicate reduced coverage, not reduced pollution.');
      L.push('  b. Attribution scores are a prioritisation tool derived from spatio-temporal correlation');
      L.push('     with AIS. They are not evidence of discharge. Enforcement requires physical sampling');
      L.push('     and GC-MS fingerprint comparison against the suspect vessel.');
      L.push('  c. Detections dismissed as natural look-alikes are retained in the register so the');
      L.push('     false-positive rate remains measurable.');
      L.push('  d. Hindcast origins carry a spatial uncertainty envelope. A point estimate quoted without');
      L.push('     its envelope overstates the precision of the method.');
      L.push('  e. Vessels operating without AIS cannot be scored by correlation. Absence of a candidate');
      L.push('     is recorded as a suspected dark-vessel event, not as an absence of pollution.', '');
    }
    L.push('='.repeat(72));
    L.push('OceanWatch AI — National Marine Pollution Intelligence System');
    L.push('National Technical Research Organisation');
    return L.join('\n');
  };

  return (
    <Modal open={open} onClose={onClose} title="Build periodic report"
      subtitle="Produces a formatted briefing document rather than a live dashboard."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            triggerDownload(`oceanwatch-report-${period}d.txt`, build());
            notify({ kind: 'success', title: 'Report generated', body: `${Object.values(sections).filter(Boolean).length} sections exported.` });
            onClose();
          }} icon={<Download className="w-3 h-3" />}>Generate</Button>
        </>
      }>
      <div className="space-y-3">
        <Field label="Report title">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400" />
        </Field>
        <div>
          <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Sections to include</p>
          <Toggle checked={sections.summary} onChange={(v) => setSections({ ...sections, summary: v })} label="Executive summary" />
          <Toggle checked={sections.regional} onChange={(v) => setSections({ ...sections, regional: v })} label="Regional distribution" />
          <Toggle checked={sections.hotspots} onChange={(v) => setSections({ ...sections, hotspots: v })} label="Chronic pollution hotspots" />
          <Toggle checked={sections.performance} onChange={(v) => setSections({ ...sections, performance: v })} label="Model performance (including error rates)" />
          <Toggle checked={sections.cases} onChange={(v) => setSections({ ...sections, cases: v })} label="Full case register" />
          <Toggle checked={sections.caveats} onChange={(v) => setSections({ ...sections, caveats: v })} label="Interpretation and limitations" />
        </div>
        <InfoBanner tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
          The limitations section is enabled by default and should stay that way. A report that quotes
          attribution counts without stating that attribution is not proof invites exactly the
          misreading this system is designed to avoid.
        </InfoBanner>
      </div>
    </Modal>
  );
}
