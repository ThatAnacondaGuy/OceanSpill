import { useMemo, useState } from 'react';
import { AlertTriangle, Filter, Target, Satellite, X, ArrowRight, Map as MapIcon, List } from 'lucide-react';
import { useStore, fmt } from './store/store';
import { reportedSource } from './data/world';
import {
  Panel, DataTable, SearchInput, Select, Tier, StatusBadge, Badge, Button, InfoBanner, ExportButton, downloadCsv, ProvenanceBadge, type Column,
} from './components/ui';
import { MapView, type MapMarker, type MapPolygon } from './components/MapView';
import { LiveMonitoring } from './components/LiveMonitoring';
import { analysePolygon, pointInPolygon } from './lib/geo';
import type { SpillCase } from './data/types';

export default function SpillIncidents() {
  const { world, navigate, getAnalysis, revision, serverMode } = useStore();
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('all');
  const [status, setStatus] = useState('all');
  const [tier, setTier] = useState('all');
  const [source, setSource] = useState('all');
  const [year, setYear] = useState('all');
  const [view, setView] = useState<'table' | 'map'>('table');
  const [filtersOpen, setFiltersOpen] = useState(true);

  const regions = useMemo(() => Array.from(new Set(world.cases.map((c) => c.region))).sort(), [world.cases]);
  const years = useMemo(() => Array.from(new Set(world.cases.map((c) => new Date(c.incidentTime).getUTCFullYear()))).sort((a, b) => b - a), [world.cases]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.cases.filter((c) => {
      if (q && !`${c.id} ${c.title} ${c.region} ${c.subRegion} ${c.assignedTo} ${c.status}`.toLowerCase().includes(q)) return false;
      if (region !== 'all' && c.region !== region) return false;
      if (status !== 'all' && c.status !== status) return false;
      if (tier !== 'all' && c.tier !== tier) return false;
      if (source !== 'all' && c.sourceType !== source) return false;
      if (year !== 'all' && new Date(c.incidentTime).getUTCFullYear() !== Number(year)) return false;
      return true;
    });
  }, [world.cases, query, region, status, tier, source, year, revision]);

  const columns: Column<SpillCase>[] = [
    {
      key: 'title', header: 'Case', width: '260px', value: (c) => c.title,
      render: (c) => (
        <div className="min-w-0">
          <div className="font-bold text-[#0a192f] leading-snug">{c.title}</div>
          <div className="text-[0.6875rem] font-mono text-gray-400">{c.id}</div>
        </div>
      ),
    },
    { key: 'tier', header: 'Tier', width: '64px', align: 'center', value: (c) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[c.tier]), render: (c) => <Tier tier={c.tier} /> },
    { key: 'region', header: 'Location', width: '170px', value: (c) => c.subRegion, render: (c) => <span className="text-gray-700 text-[0.71875rem]">{c.subRegion}</span> },
    {
      key: 'date', header: 'Incident (UTC)', width: '132px', value: (c) => c.incidentTime,
      render: (c) => (
        <div>
          <div className="font-mono text-gray-800">{fmt.precise(c.incidentTime, c.facts.incident.timePrecision)}</div>
          <div className="text-[0.6875rem] text-gray-400">precision: {c.facts.incident.timePrecision}</div>
        </div>
      ),
    },
    { key: 'source', header: 'Source type', width: '92px', value: (c) => c.sourceType, render: (c) => <Badge tone={c.sourceType === 'vessel' ? 'blue' : c.sourceType === 'unknown' ? 'amber' : 'violet'}>{c.sourceType}</Badge> },
    {
      key: 'oil', header: 'Oil (t)', width: '92px', align: 'right', value: (c) => c.oilQuantityTonnes ?? -1,
      render: (c) => c.oilQuantityTonnes != null
        ? <div><div className="font-mono text-gray-700">{fmt.num(c.oilQuantityTonnes)}</div><div className="text-[0.65625rem] text-gray-500">{c.oilQuantityBasis}</div></div>
        : <span className="text-gray-400 text-[0.6875rem]">Not reported</span>,
    },
    {
      key: 'confidence', header: 'Detection', width: '96px', value: (c) => c.confidence,
      render: (c) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-bold text-gray-800">{fmt.confidence(c)}</span>
          <span className="text-[0.65625rem] text-gray-400">{c.confidenceBasis === 'official-report' ? 'confirmed by authority' : 'SAR model'}</span>
        </div>
      ),
    },
    {
      key: 'sar', header: 'SAR scenes', width: '84px', align: 'center', value: (c) => c.detection.scenes.length,
      render: (c) => (
        <div className="flex flex-col items-center gap-0.5">
          <span className="font-mono font-bold text-gray-800">{c.detection.scenes.length}</span>
          <ProvenanceBadge p={c.detection.scenes.length ? 'real' : 'pending'} />
        </div>
      ),
    },
    {
      key: 'attribution', header: 'Source / top AIS candidate', width: '170px', value: (c) => getAnalysis(c.id)?.ranked[0]?.total ?? -1,
      render: (c) => {
        const a = getAnalysis(c.id);
        const top = a?.ranked[0];
        const src = reportedSource(world, c.id);
        const v = top ? world.vesselsByMmsi.get(top.mmsi) : undefined;
        return (
          <div className="space-y-1">
            {src && src.isFacility && (
              <div className="text-[0.6875rem] leading-snug">
                <span className="text-gray-500">Reported source: </span>
                <span className="font-semibold text-gray-800">{src.name}</span>
              </div>
            )}
            {top ? (
              <div>
                <div className="font-semibold text-gray-800 leading-snug" title={v?.name}>{src?.isFacility ? <span className="font-normal text-gray-500">Top AIS candidate: </span> : null}{v?.name ?? top.mmsi}</div>
                <div className="text-[0.6875rem] text-gray-500">
                  {a!.verdict.band} · score {(top.total * 100).toFixed(0)}
                  {world.tracks.get(top.mmsi)?.provenance !== 'real' && <span title="Track estimated between reported positions"> · estimated track</span>}
                </div>
              </div>
            ) : <span className="text-gray-400 text-[0.6875rem]">No vessel candidate</span>}
          </div>
        );
      },
    },
    {
      key: 'outcome', header: 'Public record outcome', width: '240px', value: (c) => c.facts.officialFindings,
      render: (c) => <span className="text-[0.71875rem] text-gray-700 leading-snug line-clamp-3" title={c.facts.officialFindings}>{c.facts.officialFindings}</span>,
    },
    { key: 'status', header: 'Workflow status', width: '120px', value: (c) => c.status, render: (c) => <StatusBadge status={c.status} /> },
    {
      key: 'go', header: '', width: '36px', sortable: false,
      render: (c) => (
        <button onClick={(e) => { e.stopPropagation(); navigate({ tab: 'Investigation', caseId: c.id }); }} className="text-blue-600 hover:text-blue-800 p-1" title="Open investigation">
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      ),
    },
  ];

  const markers = useMemo<MapMarker[]>(() => filtered.map((c) => {
    const shape = analysePolygon(c.detection.polygon.ring);
    return {
      id: c.id, position: shape.centroid, kind: 'case', color: c.tier === 'HIGH' ? '#dc2626' : c.tier === 'MEDIUM' ? '#f59e0b' : '#10b981',
      size: 7, label: c.title, sublabel: c.subRegion, pulse: c.tier === 'HIGH',
      meta: { Date: fmt.precise(c.incidentTime, c.facts.incident.timePrecision), 'SAR scenes': c.detection.scenes.length },
    };
  }), [filtered]);

  const polygons = useMemo<MapPolygon[]>(() => filtered.map((c) => ({
    id: `p-${c.id}`, rings: [c.detection.polygon.ring], fill: 'rgba(17,24,39,0.55)', stroke: '#111827', strokeWidth: 1,
  })), [filtered]);

  // Planning suggestion grounded in real data: recorded incidents per area, then least recent imagery.
  const suggestion = useMemo(() => {
    const scored = world.aois.map((a) => {
      const ring = [
        { lat: a.bounds.north, lon: a.bounds.west }, { lat: a.bounds.north, lon: a.bounds.east },
        { lat: a.bounds.south, lon: a.bounds.east }, { lat: a.bounds.south, lon: a.bounds.west },
      ];
      const incidents = world.historical.filter((h) => h.lat != null && h.lon != null && pointInPolygon({ lat: h.lat, lon: h.lon }, ring)).length;
      const lastScene = world.passes.filter((p) => p.footprint.some((pt) => pointInPolygon(pt, ring))).reduce((m, p) => Math.max(m, p.start), 0);
      return { aoi: a, incidents, lastScene };
    }).sort((x, y) => y.incidents - x.incidents || x.lastScene - y.lastScene);
    return scored[0];
  }, [world]);

  const activeFilters = [
    region !== 'all' && `Region: ${region}`, status !== 'all' && `Status: ${status}`, tier !== 'all' && `Tier: ${tier}`,
    source !== 'all' && `Source: ${source}`, year !== 'all' && `Year: ${year}`, query && `“${query}”`,
  ].filter(Boolean) as string[];

  const clearAll = () => { setQuery(''); setRegion('all'); setStatus('all'); setTier('all'); setSource('all'); setYear('all'); };

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-y-auto 2xl:overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0 flex-wrap gap-y-2">
        <div className="flex items-center gap-2.5">
          <div className="bg-amber-500 text-white p-1.5 rounded"><AlertTriangle className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2">Spill incidents <ProvenanceBadge p="real" /></h2>
            <p className="text-[0.75rem] text-gray-500">{filtered.length} of {world.cases.length} cases · {world.historical.length} incidents in the historical register</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded border border-gray-300 overflow-hidden">
            <button onClick={() => setView('table')} className={`px-2.5 py-1.5 text-[0.75rem] font-semibold flex items-center gap-1.5 ${view === 'table' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}><List className="w-3.5 h-3.5" /> Table</button>
            <button onClick={() => setView('map')} className={`px-2.5 py-1.5 text-[0.75rem] font-semibold flex items-center gap-1.5 border-l border-gray-300 ${view === 'map' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}><MapIcon className="w-3.5 h-3.5" /> Map</button>
          </div>
          <Button size="sm" onClick={() => setFiltersOpen((o) => !o)} icon={<Filter className="w-3 h-3" />}>Filters{activeFilters.length > 0 && ` (${activeFilters.length})`}</Button>
          <ExportButton onExport={() => downloadCsv('oceanspill-cases.csv', columns.filter((c) => c.value), filtered)} />
        </div>
      </div>

      {serverMode && <LiveMonitoring />}

      {filtersOpen && (
        <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5 flex-shrink-0">
          <div className="grid grid-cols-2 md:grid-cols-7 gap-4 items-end">
            <SearchInput value={query} onChange={setQuery} placeholder="Name, location, analyst…" className="md:col-span-2" />
            <Select label="Region" value={region} onChange={setRegion} options={[{ value: 'all', label: 'All regions' }, ...regions.map((r) => ({ value: r, label: r }))]} />
            <Select label="Status" value={status} onChange={setStatus}
              options={[{ value: 'all', label: 'All statuses' }, ...['Under Analysis', 'Attributed', 'Verification Dispatched', 'Verified', 'Enforcement', 'Closed', 'Dismissed — Look-alike'].map((s) => ({ value: s, label: s }))]} />
            <Select label="Risk tier" value={tier} onChange={setTier} options={[{ value: 'all', label: 'All tiers' }, { value: 'HIGH', label: 'High' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'LOW', label: 'Low' }]} />
            <Select label="Source type" value={source} onChange={setSource} options={[{ value: 'all', label: 'All sources' }, ...['vessel', 'facility', 'pipeline', 'unknown'].map((s) => ({ value: s, label: s }))]} />
            <Select label="Year" value={year} onChange={setYear} options={[{ value: 'all', label: 'All years' }, ...years.map((y) => ({ value: String(y), label: String(y) }))]} />
          </div>
          {activeFilters.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-2">
              {activeFilters.map((f) => <Badge key={f} tone="blue">{f}</Badge>)}
              <button onClick={clearAll} className="text-[0.75rem] text-gray-500 hover:text-red-600 font-semibold flex items-center gap-1"><X className="w-3 h-3" /> Clear</button>
            </div>
          )}
        </div>
      )}

      <div className="flex-none 2xl:flex-1 2xl:min-h-0 flex flex-col 2xl:flex-row gap-4 p-4">
        <div className="flex-none h-[78vh] 2xl:h-auto 2xl:flex-1 min-w-0 flex flex-col gap-3">
          <Panel className="flex-1" bodyClass="min-h-0">
            {view === 'table' ? (
              <DataTable columns={columns} rows={filtered} rowKey={(c) => c.id} dense onRowClick={(c) => navigate({ tab: 'Investigation', caseId: c.id })}
                initialSort={{ key: 'date', dir: 'desc' }} minWidth={1560}
                empty={<div className="space-y-3"><p>No cases match the current filters.</p>{activeFilters.length > 0 && <Button size="sm" onClick={clearAll}>Clear all filters</Button>}</div>} />
            ) : (
              <MapView initialCentre={{ lat: 15, lon: 80 }} initialZoom={3.9} markers={markers} polygons={polygons}
                onMarkerClick={(m) => navigate({ tab: 'Investigation', caseId: m.id })}
                fitTo={markers.length ? markers.map((m) => m.position) : undefined} fitKey={`${filtered.length}-${region}-${status}-${tier}-${year}`} />
            )}
          </Panel>
        </div>

        <div className="w-full 2xl:w-[300px] flex-shrink-0 grid grid-cols-1 md:grid-cols-3 2xl:flex 2xl:flex-col gap-4 items-start">
          <Panel title="Suggested next tasking" subtitle="Recorded incidents per planning area" dense>
            {suggestion && (
              <div className="p-4">
                <div className="flex items-start gap-2 mb-2">
                  <Target className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-xs text-gray-900 leading-snug">{suggestion.aoi.name}</p>
                    <p className="text-[0.6875rem] text-gray-500 mt-0.5">{suggestion.incidents} incident{suggestion.incidents === 1 ? '' : 's'} in the historical register</p>
                  </div>
                </div>
                <p className="text-[0.71875rem] text-gray-600 leading-normal mb-2">{suggestion.aoi.rationale}</p>
                <p className="text-[0.6875rem] text-gray-500 mb-2">Latest catalogued scene: {suggestion.lastScene ? fmt.date(suggestion.lastScene) : 'none in current case windows'}</p>
                <Button size="sm" variant="primary" className="w-full justify-center" onClick={() => navigate({ tab: 'Satellite Tasking', section: suggestion.aoi.id })} icon={<Satellite className="w-3 h-3" />}>Open tasking queue</Button>
              </div>
            )}
          </Panel>

          <Panel title="Breakdown" dense className="2xl:flex-1" bodyClass="overflow-y-auto">
            <div className="p-4 space-y-4">
              <Breakdown label="By status" items={countBy(filtered, (c) => c.status)} onPick={setStatus} />
              <Breakdown label="By region" items={countBy(filtered, (c) => c.region)} onPick={setRegion} />
              <Breakdown label="By source type" items={countBy(filtered, (c) => c.sourceType)} onPick={setSource} />
              <Breakdown label="By SAR catalogue" items={countBy(filtered.flatMap((c) => c.detection.scenes), (s) => s.platform)} />
            </div>
          </Panel>

          <InfoBanner tone="blue">
            <b>Official</b> means an authority confirmed the spill. A percentage appears once a SAR scene has been processed by the detection model.
          </InfoBanner>
        </div>
      </div>
    </main>
  );
}

function countBy<T>(rows: T[], key: (r: T) => string): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

function Breakdown({ label, items, onPick }: { label: string; items: { label: string; count: number }[]; onPick?: (k: string) => void }) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div>
      <p className="text-[0.6875rem] font-bold text-gray-500 uppercase mb-1.5">{label}</p>
      <div className="space-y-1.5">
        {items.length === 0 && <p className="text-[0.6875rem] text-gray-400">No data</p>}
        {items.map((i) => (
          <button key={i.label} onClick={() => onPick?.(i.label)} disabled={!onPick}
            className={`w-full flex items-center gap-2 text-[0.71875rem] ${onPick ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'} px-1 py-0.5 rounded`}>
            <span className="flex-1 text-left text-gray-700 truncate" title={i.label}>{i.label}</span>
            <div className="w-12 h-1.5 bg-gray-200 rounded overflow-hidden flex-shrink-0"><div className="h-full bg-blue-500 rounded" style={{ width: `${(i.count / max) * 100}%` }} /></div>
            <span className="font-mono font-bold text-gray-800 w-4 text-right flex-shrink-0">{i.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
