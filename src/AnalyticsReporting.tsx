import { useMemo, useState } from 'react';
import {
  BarChart2, FileText, AlertTriangle, Download, Target, Activity, Info, Scale, Database, Crosshair,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapCircle, type MapMarker, type MapPath } from './components/MapView';
import {
  Panel, Badge, Button, KeyValue, Tabs, StatCard, BarChart, InfoBanner, ProvenanceBadge,
  Select, Modal, Field, Toggle, triggerDownload,
} from './components/ui';
import { MODEL_STATUS } from './engine/detection';
import { haversineKm, type LatLon } from './lib/geo';
import { CORRIDORS } from './data/geography';
import type { HistoricalIncident } from './data/types';
import type { CaseAnalysis } from './store/store';

const OIL_OBSERVATIONS = new Set(['slick', 'sheen', 'shoreline', 'tarballs']);

function incidentYear(h: HistoricalIncident): number | null {
  const y = parseInt(h.date.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function coastOf(p: LatLon): string {
  if (p.lon > 91.5) return 'Andaman & Nicobar';
  if (p.lon < 74.2 && p.lat < 13) return 'Lakshadweep';
  if (p.lon < 78) return 'West coast';
  return 'East coast';
}

function sourceClass(h: HistoricalIncident): string {
  const c = `${h.cause ?? ''} ${h.name}`.toLowerCase();
  if (/pipeline|refinery|platform|rig|terminal|storm water/.test(c)) return 'Offshore / industrial';
  if (/tank washing|illegal discharge/.test(c)) return 'Operational discharge';
  if (/tanker|collision|grounding|sank|capsize|fire|explosion|hull|vessel|mv |mt |msc|ssl|wan hai/.test(c)) return 'Vessel casualty';
  return 'Not recorded';
}

export interface DriftCheck {
  caseId: string;
  title: string;
  from: { time: number; position: LatLon; type: string; source: string };
  to: { time: number; position: LatLon; type: string; source: string };
  hours: number;
  predicted: LatLon;
  errorKm: number;
  reportedDisplacementKm: number;
  precisionKm: number;
}

export default function AnalyticsReporting() {
  const { world, getAnalysis, navigate, revision } = useStore();
  const [tab, setTab] = useState('overview');
  const [basemap, setBasemap] = useState<BasemapStyle>('dark');
  const [period, setPeriod] = useState('all');
  const [reportOpen, setReportOpen] = useState(false);

  const inPeriod = useMemo(() => world.historical.filter((h) => {
    if (period === 'all') return true;
    const y = incidentYear(h);
    return y != null && Math.floor(y / 10) * 10 === Number(period);
  }), [world.historical, period]);

  const casesInPeriod = useMemo(() => world.cases.filter((c) => {
    if (period === 'all') return true;
    return Math.floor(new Date(c.incidentTime).getUTCFullYear() / 10) * 10 === Number(period);
  }), [world.cases, period, revision]);

  const stats = useMemo(() => {
    const withTonnes = inPeriod.filter((h) => h.tonnes != null);
    return {
      incidents: inPeriod.length,
      tonnes: withTonnes.reduce((s, h) => s + (h.tonnes ?? 0), 0),
      tonnesKnown: withTonnes.length,
      legal: inPeriod.filter((h) => h.legal?.length).length,
      analysed: casesInPeriod.length,
      sarScenes: casesInPeriod.reduce((s, c) => s + c.detection.scenes.length, 0),
    };
  }, [inPeriod, casesInPeriod]);

  const byDecade = useMemo(() => {
    const m = new Map<number, number>();
    for (const h of world.historical) {
      const y = incidentYear(h);
      if (y == null) continue;
      const d = Math.floor(y / 10) * 10;
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([d, value]) => ({ label: `${d}s`, value }));
  }, [world.historical]);

  const byCoast = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of inPeriod) {
      const k = h.lat != null && h.lon != null ? coastOf({ lat: h.lat, lon: h.lon }) : 'Position not recorded';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [inPeriod]);

  const bySource = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of inPeriod) m.set(sourceClass(h), (m.get(sourceClass(h)) ?? 0) + 1);
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [inPeriod]);

  const largest = useMemo(() => inPeriod.filter((h) => h.tonnes != null)
    .sort((a, b) => (b.tonnes ?? 0) - (a.tonnes ?? 0)).slice(0, 8)
    .map((h) => ({ label: `${h.name.slice(0, 26)} (${h.date.slice(0, 4)})`, value: h.tonnes ?? 0 })), [inPeriod]);

  /** Input completeness for each analysed case: what the analysis actually had to work with. */
  const completeness = useMemo(() => world.cases.map((c) => ({
    c,
    sar: c.detection.scenes.length > 0,
    sarCovers: c.detection.scenes.some((s) => s.coversIncident),
    wind: (c.forcingCoverage?.wind ?? 0) > 0,
    current: (c.forcingCoverage?.current ?? 0) > 0,
    extent: c.detection.extentReported,
    quantity: c.facts.oil.spilledTonnes != null,
    realAis: c.aisProvider === 'gfw' || c.aisProvider === 'dgll',
    precise: ['minute', 'hour'].includes(c.facts.incident.timePrecision),
  })), [world.cases]);

  /** Response timelines from the published event records. */
  const timelines = useMemo(() => world.cases.map((c) => {
    const events = c.facts.timeline.map((e) => Date.parse(e.time)).filter(Number.isFinite).sort((a, b) => a - b);
    const firstObs = c.facts.observations.map((o) => Date.parse(o.time)).sort((a, b) => a - b)[0];
    return {
      c,
      toObservationH: firstObs != null ? (firstObs - c.incidentTime) / 3600_000 : null,
      spanDays: events.length > 1 ? (events[events.length - 1] - events[0]) / 86400_000 : null,
      events: events.length,
    };
  }), [world.cases]);

  /** Drift skill: forecast from one reported oil observation, compared with a later one. */
  const driftChecks = useMemo<DriftCheck[]>(() => {
    const out: DriftCheck[] = [];
    for (const c of world.cases) {
      const obs = c.facts.observations
        .filter((o) => OIL_OBSERVATIONS.has(o.type) && o.lat != null && o.lon != null)
        .map((o) => ({ time: Date.parse(o.time), position: { lat: o.lat!, lon: o.lon! }, type: o.type, source: o.source }))
        .sort((a, b) => a.time - b.time);
      if (obs.length < 2) continue;
      const a: CaseAnalysis | null = getAnalysis(c.id);
      if (!a) continue;
      const first = obs[0];
      for (const later of obs.slice(1)) {
        const hours = (later.time - first.time) / 3600_000;
        if (hours <= 0 || hours > c.forecastHours) continue;
        // Identical reported positions are one approximate fix repeated, not two independent observations.
        if (haversineKm(first.position, later.position) < 0.5) continue;
        const step = a.forecast.steps.reduce((best, s) => (Math.abs(s.time - later.time) < Math.abs(best.time - later.time) ? s : best), a.forecast.steps[0]);
        out.push({
          caseId: c.id, title: c.title, from: first, to: later, hours, predicted: step.centroid,
          errorKm: haversineKm(step.centroid, later.position),
          reportedDisplacementKm: haversineKm(first.position, later.position),
          precisionKm: c.facts.incident.positionPrecisionKm,
        });
      }
    }
    return out;
  }, [world.cases, getAnalysis, revision]);

  /** Incidents in the register near each indicative shipping route. */
  const hotspots = useMemo(() => CORRIDORS.map((corridor) => {
    const near = world.historical.filter((h) => h.lat != null && h.lon != null && corridor.waypoints.some((w) => haversineKm(w, { lat: h.lat!, lon: h.lon! }) < 150));
    return { corridor, incidents: near, count: near.length, tonnes: near.reduce((s, h) => s + (h.tonnes ?? 0), 0) };
  }).sort((a, b) => b.count - a.count), [world.historical]);

  const hotspotMap = useMemo(() => {
    const circles: MapCircle[] = [];
    const markers: MapMarker[] = [];
    const paths: MapPath[] = [];
    for (const h of hotspots) {
      paths.push({ id: `cor-${h.corridor.id}`, points: h.corridor.waypoints, stroke: h.count ? '#f59e0b' : '#64748b', strokeWidth: 1.4, dash: '6 4', opacity: 0.6 });
    }
    for (const h of world.historical) {
      if (h.lat == null || h.lon == null) continue;
      markers.push({
        id: h.id, position: { lat: h.lat, lon: h.lon }, kind: 'case',
        color: h.activeCaseId ? '#3b82f6' : '#f59e0b',
        size: h.tonnes ? Math.min(11, 3 + Math.log10(h.tonnes + 1) * 1.8) : 4, label: h.name, sublabel: `${h.date} · ${h.location}`, z: 5,
        meta: { Oil: h.oil ?? 'n/r', Tonnes: h.tonnes ?? 'n/r', Source: sourceClass(h) },
      });
      if (h.positionPrecisionKm && h.positionPrecisionKm >= 20) {
        circles.push({ id: `pp-${h.id}`, centre: { lat: h.lat, lon: h.lon }, radiusKm: h.positionPrecisionKm, fill: 'rgba(245,158,11,0.05)', stroke: '#f59e0b', dash: '2 4', opacity: 0.5 });
      }
    }
    return { circles, markers, paths };
  }, [hotspots, world.historical]);

  const decades = useMemo(() => byDecade.map((d) => d.label.replace('s', '')), [byDecade]);

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-y-auto lg:overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0 flex-wrap gap-y-2">
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 text-white p-1.5 rounded"><BarChart2 className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2">Analytics &amp; reporting <ProvenanceBadge p="real" /></h2>
            <p className="text-[12px] text-gray-500">Computed from the historical register and the analysed cases; no invented metrics</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={period} onChange={setPeriod}
            options={[{ value: 'all', label: 'All years' }, ...decades.slice().reverse().map((d) => ({ value: d, label: `${d}s` }))]} />
          <Button size="sm" variant="primary" onClick={() => setReportOpen(true)} icon={<FileText className="w-3 h-3" />}>Build report</Button>
        </div>
      </div>

      <Tabs active={tab} onChange={setTab} className="bg-white px-3 flex-shrink-0" tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'hotspots', label: 'Incident map' },
        { id: 'performance', label: 'Model & data quality' },
      ]} />

      {tab === 'overview' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <StatCard icon={<Activity className="w-5 h-5" />} title="Recorded incidents" value={stats.incidents} trend={period === 'all' ? 'register since 1970' : `in the ${period}s`} />
            <StatCard icon={<AlertTriangle className="w-5 h-5" />} title="Published tonnage" value={`${fmt.num(stats.tonnes)} t`}
              trend={`${stats.tonnesKnown} of ${stats.incidents} report a quantity`} accent="amber" />
            <StatCard icon={<Scale className="w-5 h-5" />} title="Legal outcomes" value={stats.legal} trend="court or regulator action published" accent="red" />
            <StatCard icon={<Target className="w-5 h-5" />} title="Analysed cases" value={stats.analysed} trend="with drift and attribution" accent="green" />
            <StatCard icon={<Database className="w-5 h-5" />} title="SAR scenes found" value={stats.sarScenes} trend="catalogue hits for those cases" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Panel title="Recorded incidents by decade" dense>
              <div className="p-4">
                <BarChart data={byDecade} height={150} />
                <p className="text-[11px] text-gray-500 mt-2 leading-normal">
                  Reflects what was reported and published, not the true spill rate. Small spills before satellite
                  monitoring were rarely recorded.
                </p>
              </div>
            </Panel>
            <Panel title="By coast" dense>
              <div className="p-4"><BarChart horizontal data={byCoast} /></div>
            </Panel>
            <Panel title="By source" dense>
              <div className="p-4">
                <BarChart horizontal data={bySource} />
                <p className="text-[11px] text-gray-500 mt-2 leading-normal">Classified from the recorded cause text.</p>
              </div>
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Panel title="Largest published quantities (t)" dense>
              <div className="p-4">
                {largest.length ? <BarChart horizontal data={largest} valueFormat={(v) => fmt.num(v)} /> : <p className="text-[12px] text-gray-500">No quantities published in this period.</p>}
              </div>
            </Panel>
            <Panel title="Analysed cases: incident → first report" dense>
              <div className="p-4 space-y-2">
                {timelines.map(({ c, toObservationH, spanDays, events }) => (
                  <button key={c.id} onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}
                    className="w-full text-left flex items-center gap-2 text-[11.5px] hover:bg-gray-50 rounded px-1 py-0.5">
                    <span className="flex-1 truncate font-semibold text-gray-800" title={c.title}>{c.title}</span>
                    <span className="font-mono text-gray-700 w-16 text-right">{toObservationH != null && ['minute', 'hour'].includes(c.facts.incident.timePrecision) ? `${toObservationH.toFixed(1)} h` : 'n/a'}</span>
                    <span className="font-mono text-gray-400 w-20 text-right">{spanDays != null ? `${spanDays.toFixed(1)} d · ${events} ev` : '—'}</span>
                  </button>
                ))}
                <p className="text-[11px] text-gray-500 pt-1 leading-normal">
                  Hours from incident to the first published observation (only where the incident time is known to the hour),
                  then the span of the published timeline.
                </p>
              </div>
            </Panel>
            <Panel title="What the analyses had to work with" dense>
              <div className="p-4 space-y-3">
                <Coverage label="SAR scene in catalogue" value={completeness.filter((x) => x.sar).length} total={completeness.length} color="#3b82f6" />
                <Coverage label="Scene covering the incident" value={completeness.filter((x) => x.sarCovers).length} total={completeness.length} color="#6366f1" />
                <Coverage label="Reanalysis wind" value={completeness.filter((x) => x.wind).length} total={completeness.length} color="#0891b2" />
                <Coverage label="Reanalysis currents" value={completeness.filter((x) => x.current).length} total={completeness.length} color="#0d9488" />
                <Coverage label="Slick extent reported" value={completeness.filter((x) => x.extent).length} total={completeness.length} color="#f59e0b" />
                <Coverage label="Released quantity published" value={completeness.filter((x) => x.quantity).length} total={completeness.length} color="#ea580c" />
                <Coverage label="Real AIS data (GFW / DGLL)" value={completeness.filter((x) => x.realAis).length} total={completeness.length} color="#dc2626" />
                <p className="text-[11px] text-gray-500 mt-1 leading-normal">
                  Real AIS is the largest gap. Without it, attribution ranks synthetic tracks anchored to reported positions.
                </p>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {tab === 'hotspots' && (
        <div className="flex-none lg:flex-1 lg:min-h-0 flex flex-col lg:flex-row">
          <aside className="w-full lg:w-[280px] xl:w-[330px] bg-white border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col flex-shrink-0 max-h-[46vh] lg:max-h-none">
            <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
              <h3 className="text-[12px] font-bold text-gray-700">Incidents near shipping routes</h3>
              <p className="text-[11px] text-gray-500 mt-0.5">Register incidents within 150 km of an indicative route</p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {hotspots.map((h, i) => (
                <div key={h.corridor.id} className="px-2.5 py-2 border-b border-gray-100">
                  <div className="flex items-start gap-2">
                    <div className={`w-5 h-5 rounded flex items-center justify-center text-[11px] font-black flex-shrink-0 ${
                      i === 0 && h.count ? 'bg-red-600 text-white' : i < 3 && h.count ? 'bg-amber-500 text-white' : 'bg-gray-300 text-gray-700'}`}>{i + 1}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-bold text-gray-900 leading-snug">{h.corridor.name}</p>
                      <div className="flex gap-3 mt-1 text-[11px] text-gray-600">
                        <span>{h.count} incident{h.count === 1 ? '' : 's'}</span>
                        <span>{fmt.num(h.tonnes)} t published</span>
                      </div>
                      <div className="mt-1 h-1.5 bg-gray-200 rounded overflow-hidden">
                        <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, (h.count / Math.max(1, hotspots[0].count)) * 100)}%` }} />
                      </div>
                      {h.incidents.length > 0 && (
                        <p className="text-[11px] text-gray-500 mt-1 leading-normal">{h.incidents.map((x) => `${x.name.split(' (')[0]} ${x.date.slice(0, 4)}`).join(' · ')}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-2 border-t border-gray-200">
              <InfoBanner tone="amber" icon={<Info className="w-3 h-3" />}>
                Route lines are indicative. Traffic density needs real AIS (DGLL or GFW), so incidents are not yet normalised per transit.
              </InfoBanner>
            </div>
          </aside>
          <div className="flex-1 min-w-0 relative h-[65vh] lg:h-auto">
            <MapView
              basemap={basemap} circles={hotspotMap.circles} markers={hotspotMap.markers} paths={hotspotMap.paths}
              initialCentre={{ lat: 14, lon: 80 }} initialZoom={3.7}
              onMarkerClick={(m) => {
                const h = world.historical.find((x) => x.id === m.id);
                if (h?.activeCaseId) navigate({ tab: 'Investigation', caseId: h.activeCaseId });
                else navigate({ tab: 'Case Archive', section: 'historical' });
              }}
              overlay={<div className="absolute top-3 left-3 z-20"><BasemapSwitch value={basemap} onChange={setBasemap} /></div>}
              legend={
                <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-3 text-[11px] shadow-lg">
                  <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Historical register</h4>
                  <div className="flex items-center gap-2 mb-1"><div className="w-3 h-3 rounded-full bg-blue-500" /><span className="text-gray-700">Analysed case</span></div>
                  <div className="flex items-center gap-2 mb-1"><div className="w-3 h-3 rounded-full bg-amber-500" /><span className="text-gray-700">Register only</span></div>
                  <div className="flex items-center gap-2"><div className="w-4 border-t-2 border-dashed border-amber-500" /><span className="text-gray-700">Indicative route</span></div>
                  <p className="text-[10.5px] text-gray-400 mt-1.5 max-w-[160px]">Marker size scales with published tonnage. Dotted rings show position uncertainty.</p>
                </div>
              }
            />
          </div>
        </div>
      )}

      {tab === 'performance' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <InfoBanner tone="amber" icon={<Info className="w-3.5 h-3.5" />}>
            <b>No accuracy figures are shown.</b> {MODEL_STATUS.note}
          </InfoBanner>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Panel title="Segmentation model" subtitle="Status and evaluation plan" dense>
              <div className="p-4 space-y-4">
                <div className="flex items-center gap-2"><ProvenanceBadge p="pending" /><span className="text-[12px] font-semibold text-gray-700">Not trained</span></div>
                <KeyValue cols={1} items={[
                  ['Architecture', MODEL_STATUS.plannedArchitecture],
                  ['Training', MODEL_STATUS.plannedTraining],
                  ['Loss', MODEL_STATUS.plannedLoss],
                  ['Public dataset', <a href={MODEL_STATUS.datasetUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{MODEL_STATUS.datasetUrl}</a>],
                ]} />
                <div>
                  <p className="text-[11px] font-bold text-gray-600 uppercase mb-1">Metrics to report once trained</p>
                  <ul className="space-y-0.5">
                    {MODEL_STATUS.evaluation.map((e) => <li key={e} className="text-[11.5px] text-gray-700 flex gap-1.5"><span className="text-gray-400">•</span>{e}</li>)}
                  </ul>
                </div>
              </div>
            </Panel>

            <Panel title="Drift model check against reported observations" subtitle="Forecast from the first oil observation vs a later one" dense>
              <div className="p-4 space-y-3">
                {driftChecks.length === 0 && <p className="text-[12px] text-gray-500">No case has two positioned oil observations inside its forecast window.</p>}
                {driftChecks.map((d) => (
                  <div key={`${d.caseId}-${d.to.time}`} className="border border-gray-200 rounded p-2">
                    <div className="flex items-center justify-between gap-2">
                      <button onClick={() => navigate({ tab: 'Investigation', caseId: d.caseId })} className="text-[12px] font-bold text-blue-700 hover:underline text-left">{d.title}</button>
                      <Badge tone={d.errorKm <= Math.max(10, d.precisionKm) ? 'green' : 'amber'}><Crosshair className="w-2.5 h-2.5" /> {d.errorKm.toFixed(1)} km</Badge>
                    </div>
                    <KeyValue cols={2} items={[
                      ['From', `${d.from.type} · ${fmt.utcShort(d.from.time)}`],
                      ['To', `${d.to.type} · ${fmt.utcShort(d.to.time)}`],
                      ['Lead time', `${d.hours.toFixed(1)} h`],
                      ['No-drift baseline', `${d.reportedDisplacementKm.toFixed(1)} km error (${d.errorKm < d.reportedDisplacementKm ? 'model better' : 'model worse'})`],
                      ['Report precision', `± ${d.precisionKm} km`],
                      ['Currents', (world.cases.find((c) => c.id === d.caseId)?.forcingCoverage?.current ?? 0) > 0 ? 'reanalysis' : 'climatology model'],
                    ]} />
                  </div>
                ))}
                <p className="text-[11px] text-gray-500 leading-normal">
                  Sample size is tiny and reported positions are approximate, so this is a sanity check, not a skill score.
                  Proper validation needs SAR-derived slick outlines at two times.
                </p>
              </div>
            </Panel>
          </div>

          <Panel title="Detection basis per analysed case" dense>
            <div className="p-4 space-y-2">
              {completeness.map(({ c, sar, sarCovers, current, realAis, precise }) => (
                <button key={c.id} onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded border border-gray-200 hover:border-blue-400 hover:bg-blue-50/40">
                  <span className="text-[11.5px] font-bold text-gray-900 w-[220px] flex-shrink-0 truncate" title={c.title}>{c.title}</span>
                  <Badge tone={c.confidenceBasis === 'official-report' ? 'blue' : 'violet'} className="w-[84px] justify-center flex-shrink-0">{fmt.confidence(c)}</Badge>
                  <div className="flex-1 flex gap-1 flex-wrap">
                    <Badge tone={sar ? (sarCovers ? 'green' : 'teal') : 'gray'}>{sar ? (sarCovers ? 'SAR covers' : 'SAR nearby') : 'No SAR'}</Badge>
                    <Badge tone={current ? 'green' : 'amber'}>{current ? 'Currents: reanalysis' : 'Currents: model'}</Badge>
                    <Badge tone={realAis ? 'green' : 'violet'}>{realAis ? 'AIS events: real' : 'Synthetic AIS'}</Badge>
                    <Badge tone={precise ? 'green' : 'amber'}>Time: {c.facts.incident.timePrecision}</Badge>
                  </div>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      )}

      <ReportModal open={reportOpen} onClose={() => setReportOpen(false)} period={period} stats={stats}
        byCoast={byCoast} bySource={bySource} hotspots={hotspots} driftChecks={driftChecks} />
    </main>
  );
}

function Coverage({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-[11.5px] mb-0.5">
        <span className="text-gray-700">{label}</span>
        <span className="font-mono font-bold text-gray-900">{value}/{total}</span>
      </div>
      <div className="h-2 bg-gray-200 rounded overflow-hidden">
        <div className="h-full rounded" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

interface ReportProps {
  open: boolean;
  onClose: () => void;
  period: string;
  stats: { incidents: number; tonnes: number; tonnesKnown: number; legal: number; analysed: number; sarScenes: number };
  byCoast: { label: string; value: number }[];
  bySource: { label: string; value: number }[];
  hotspots: { corridor: { name: string }; count: number; tonnes: number; incidents: HistoricalIncident[] }[];
  driftChecks: DriftCheck[];
}

function ReportModal({ open, onClose, period, stats, byCoast, bySource, hotspots, driftChecks }: ReportProps) {
  const { world, now, currentUser, notify } = useStore();
  const [sections, setSections] = useState({
    summary: true, distribution: true, routes: true, cases: true, quality: true, caveats: true,
  });
  const [title, setTitle] = useState('Oil Pollution in Indian Waters — Retrospective Report');

  const build = () => {
    const L: string[] = [];
    L.push('='.repeat(72), title.toUpperCase(), '='.repeat(72), '');
    L.push(`Period           : ${period === 'all' ? 'All recorded years' : `${period}s`}`);
    L.push(`Prepared         : ${fmt.utc(now)}`);
    L.push(`Prepared by      : ${currentUser.name} (demo account)`);
    L.push(`Data build       : ${world.generatedAt}`, '');

    if (sections.summary) {
      L.push('1. SUMMARY', '-'.repeat(72));
      L.push(`Recorded incidents        : ${stats.incidents}`);
      L.push(`Published tonnage         : ${fmt.num(stats.tonnes)} t (${stats.tonnesKnown} incidents report a quantity)`);
      L.push(`Published legal outcomes  : ${stats.legal}`);
      L.push(`Cases analysed in detail  : ${stats.analysed}`);
      L.push(`SAR catalogue scenes found: ${stats.sarScenes}`, '');
    }
    if (sections.distribution) {
      L.push('2. DISTRIBUTION', '-'.repeat(72));
      for (const r of byCoast) L.push(`  ${r.label.padEnd(30)} ${String(r.value).padStart(3)}`);
      L.push('');
      for (const r of bySource) L.push(`  ${r.label.padEnd(30)} ${String(r.value).padStart(3)}`);
      L.push('');
    }
    if (sections.routes) {
      L.push('3. INCIDENTS NEAR SHIPPING ROUTES (within 150 km)', '-'.repeat(72));
      for (const h of hotspots.filter((x) => x.count > 0)) {
        L.push(`  ${h.corridor.name}: ${h.count} incident(s), ${fmt.num(h.tonnes)} t published`);
        L.push(`    ${h.incidents.map((x) => `${x.name} (${x.date})`).join('; ')}`, '');
      }
    }
    if (sections.cases) {
      L.push('4. ANALYSED CASES', '-'.repeat(72));
      for (const c of world.cases) {
        L.push(`  ${c.title} [${c.id}]`);
        L.push(`    ${c.subRegion}`);
        L.push(`    Incident ${fmt.precise(c.incidentTime, c.facts.incident.timePrecision)}; detection basis: ${fmt.confidence(c)}`);
        L.push(`    Oil quantity: ${c.oilQuantityTonnes != null ? `${c.oilQuantityTonnes} t` : 'not reported'}; SAR scenes: ${c.detection.scenes.length}; AIS: ${c.aisProvider}`);
        L.push(`    Finding: ${c.facts.officialFindings}`);
        if (c.lookalikeReason) L.push(`    RECLASSIFIED: ${c.lookalikeReason}`);
        L.push('');
      }
    }
    if (sections.quality) {
      L.push('5. MODEL AND DATA QUALITY', '-'.repeat(72));
      L.push(`  Segmentation model: ${MODEL_STATUS.trained ? MODEL_STATUS.version : 'not trained; no accuracy figures reported'}`);
      L.push(`  Planned: ${MODEL_STATUS.plannedArchitecture}`);
      L.push('  Drift checks against reported observations:');
      if (!driftChecks.length) L.push('    none available');
      for (const d of driftChecks) {
        L.push(`    ${d.title}: ${d.errorKm.toFixed(1)} km error after ${d.hours.toFixed(1)} h; no-drift baseline ${d.reportedDisplacementKm.toFixed(1)} km (report precision ± ${d.precisionKm} km)`);
      }
      L.push('');
    }
    if (sections.caveats) {
      L.push('6. LIMITATIONS', '-'.repeat(72));
      L.push('  a. The register is compiled from public sources and is not exhaustive. The Indian Coast Guard');
      L.push('     register is not published online.');
      L.push('  b. Vessel tracks for analysed cases are synthetic, anchored to reported positions, because');
      L.push('     real AIS was not available to this prototype. Attribution rankings are illustrative.');
      L.push('  c. Detection confidence is "Official" where an authority confirmed the spill. No SAR model');
      L.push('     output has been used.');
      L.push('  d. Currents before 2022 come from a climatological model, not reanalysis.');
      L.push('  e. Attribution scores prioritise inspection. They are not evidence of discharge.', '');
    }
    L.push('='.repeat(72));
    L.push('OceanSpill prototype — Smart India Hackathon PS 26143');
    return L.join('\n');
  };

  return (
    <Modal open={open} onClose={onClose} title="Build report"
      subtitle="Plain-text briefing computed from the loaded data."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            triggerDownload(`oceanspill-report-${period}.txt`, build());
            notify({ kind: 'success', title: 'Report generated', body: `${Object.values(sections).filter(Boolean).length} sections exported.` });
            onClose();
          }} icon={<Download className="w-3 h-3" />}>Generate</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Report title">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400" />
        </Field>
        <div>
          <p className="text-[11px] font-bold text-gray-600 uppercase mb-1">Sections to include</p>
          <Toggle checked={sections.summary} onChange={(v) => setSections({ ...sections, summary: v })} label="Summary" />
          <Toggle checked={sections.distribution} onChange={(v) => setSections({ ...sections, distribution: v })} label="Distribution by coast and source" />
          <Toggle checked={sections.routes} onChange={(v) => setSections({ ...sections, routes: v })} label="Incidents near shipping routes" />
          <Toggle checked={sections.cases} onChange={(v) => setSections({ ...sections, cases: v })} label="Analysed cases" />
          <Toggle checked={sections.quality} onChange={(v) => setSections({ ...sections, quality: v })} label="Model and data quality" />
          <Toggle checked={sections.caveats} onChange={(v) => setSections({ ...sections, caveats: v })} label="Limitations" />
        </div>
        <InfoBanner tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
          Keep the limitations section. It states which inputs are synthetic or modelled.
        </InfoBanner>
      </div>
    </Modal>
  );
}
