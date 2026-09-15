import { useMemo, useState } from 'react';
import { AlertTriangle, Filter, Target, Satellite, X, ArrowRight, Map as MapIcon, List } from 'lucide-react';
import { useStore, fmt } from './store/store';
import {
  Panel, DataTable, SearchInput, Select, Tier, StatusBadge, Badge, Button, Toggle,
  InfoBanner, ExportButton, downloadCsv, type Column, Slider,
} from './components/ui';
import { MapView, type MapMarker, type MapPolygon } from './components/MapView';
import { analysePolygon } from './lib/geo';
import type { SpillCase } from './data/types';

export default function SpillIncidents() {
  const { world, now, navigate, getAnalysis, revision } = useStore();
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('all');
  const [status, setStatus] = useState('all');
  const [tier, setTier] = useState('all');
  const [minConfidence, setMinConfidence] = useState(0);
  const [showLowConfidence, setShowLowConfidence] = useState(false);
  const [range, setRange] = useState('all');
  const [view, setView] = useState<'table' | 'map'>('table');
  const [filtersOpen, setFiltersOpen] = useState(true);

  const regions = useMemo(() => Array.from(new Set(world.cases.map((c) => c.region))).sort(), [world.cases]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cutoff =
      range === '24h' ? now - 86400_000 : range === '7d' ? now - 7 * 86400_000
      : range === '30d' ? now - 30 * 86400_000 : 0;

    return world.cases.filter((c) => {
      if (q && !(`${c.id} ${c.region} ${c.subRegion} ${c.assignedTo} ${c.status}`.toLowerCase().includes(q))) return false;
      if (region !== 'all' && c.region !== region) return false;
      if (status !== 'all' && c.status !== status) return false;
      if (tier !== 'all' && c.tier !== tier) return false;
      if (c.confidence < minConfidence) return false;
      // Low-confidence detections are hidden by default so probable look-alikes do not
      // crowd the queue, but they are never silently discarded.
      if (!showLowConfidence && c.confidence < 0.55) return false;
      if (cutoff && c.detection.acquiredAt < cutoff) return false;
      return true;
    });
  }, [world.cases, query, region, status, tier, minConfidence, showLowConfidence, range, now, revision]);

  const hiddenLowConfidence = useMemo(
    () => world.cases.filter((c) => c.confidence < 0.55).length,
    [world.cases, revision]
  );

  const columns: Column<SpillCase>[] = [
    {
      key: 'id', header: 'Case ID', width: '130px', value: (c) => c.id,
      render: (c) => (
        <div className="flex items-center gap-1.5">
          <span className="font-bold text-[#0a192f] font-mono">{c.id}</span>
          {c.imacPushed && <span title="Published to IMAC" className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
        </div>
      ),
    },
    {
      key: 'tier', header: 'Tier', width: '64px', align: 'center', value: (c) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[c.tier]),
      render: (c) => <Tier tier={c.tier} />,
    },
    { key: 'region', header: 'Location', value: (c) => c.subRegion, render: (c) => <span className="text-gray-700">{c.subRegion}</span> },
    {
      key: 'acquired', header: 'Acquisition (UTC)', width: '140px', value: (c) => c.detection.acquiredAt,
      render: (c) => (
        <div>
          <div className="font-mono text-gray-800">{fmt.utcShort(c.detection.acquiredAt)}</div>
          <div className="text-[9.5px] text-gray-400">{fmt.ago(c.detection.acquiredAt, now)}</div>
        </div>
      ),
    },
    {
      key: 'sensor', header: 'Sensor', width: '96px', value: (c) => c.detection.sensor,
      render: (c) => <span className="text-gray-600">{c.detection.sensor}</span>,
    },
    {
      key: 'confidence', header: 'Confidence', width: '106px', align: 'right', value: (c) => c.confidence,
      render: (c) => {
        const a = getAnalysis(c.id);
        const v = a?.assessment.confidence ?? c.confidence;
        return (
          <div className="flex items-center gap-1.5 justify-end">
            <div className="w-10 h-1.5 bg-gray-200 rounded overflow-hidden">
              <div className={`h-full ${v > 0.8 ? 'bg-emerald-500' : v > 0.55 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${v * 100}%` }} />
            </div>
            <span className="font-mono font-bold text-gray-800 w-8 text-right">{(v * 100).toFixed(0)}%</span>
          </div>
        );
      },
    },
    {
      key: 'area', header: 'Area', width: '78px', align: 'right',
      value: (c) => analysePolygon(c.detection.polygon.ring).areaKm2,
      render: (c) => <span className="font-mono text-gray-700">{analysePolygon(c.detection.polygon.ring).areaKm2.toFixed(1)} km²</span>,
    },
    {
      key: 'attribution', header: 'Attribution', width: '124px', value: (c) => getAnalysis(c.id)?.ranked[0]?.total ?? -1,
      render: (c) => {
        const a = getAnalysis(c.id);
        if (!a || !a.ranked.length) return <span className="text-gray-400 text-[10px]">Unscored</span>;
        const top = a.ranked[0];
        const v = world.vesselsByMmsi.get(top.mmsi);
        return (
          <div>
            <div className="flex items-center gap-1">
              <span className="font-semibold text-gray-800 truncate max-w-[74px]" title={v?.name}>{v?.name ?? top.mmsi}</span>
              {top.darkDuringWindow && <Badge tone="red">DARK</Badge>}
            </div>
            <div className="text-[9.5px] text-gray-500">{a.verdict.band} · {(top.total * 100).toFixed(0)}</div>
          </div>
        );
      },
    },
    { key: 'status', header: 'Status', width: '132px', value: (c) => c.status, render: (c) => <StatusBadge status={c.status} /> },
    { key: 'assigned', header: 'Assigned', width: '92px', value: (c) => c.assignedTo, render: (c) => <span className="text-gray-600">{c.assignedTo}</span> },
    {
      key: 'go', header: '', width: '40px', sortable: false,
      render: (c) => (
        <button onClick={(e) => { e.stopPropagation(); navigate({ tab: 'Investigation', caseId: c.id }); }}
          className="text-blue-600 hover:text-blue-800 p-1" title="Open investigation">
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      ),
    },
  ];

  const markers = useMemo<MapMarker[]>(
    () => filtered.map((c) => {
      const shape = analysePolygon(c.detection.polygon.ring);
      return {
        id: c.id, position: shape.centroid, kind: 'case',
        color: c.tier === 'HIGH' ? '#dc2626' : c.tier === 'MEDIUM' ? '#f59e0b' : '#10b981',
        size: 5 + c.confidence * 5, label: c.id, sublabel: c.subRegion,
        pulse: c.tier === 'HIGH' && !['Closed', 'Dismissed — Look-alike'].includes(c.status),
        meta: { Status: c.status, Confidence: fmt.pct(c.confidence), Area: `${shape.areaKm2.toFixed(1)} km²` },
      };
    }),
    [filtered]
  );

  const polygons = useMemo<MapPolygon[]>(
    () => filtered.map((c) => ({
      id: `p-${c.id}`, rings: [c.detection.polygon.ring, ...(c.detection.polygon.fragments ?? [])],
      fill: 'rgba(17,24,39,0.6)', stroke: '#111827', strokeWidth: 1,
    })),
    [filtered]
  );

  // Risk-weighted tasking suggestion: hit rate weighted by how long since the last pass.
  const suggestion = useMemo(() => {
    const scored = world.aois.map((a) => {
      const hoursSince = (now - a.lastCovered) / 3600_000;
      const staleness = Math.min(2.2, hoursSince / 14);
      return { aoi: a, score: a.hitRate * (0.55 + staleness), hoursSince };
    }).sort((x, y) => y.score - x.score);
    return scored[0];
  }, [world.aois, now, revision]);

  const activeFilters = [
    region !== 'all' && `Region: ${region}`,
    status !== 'all' && `Status: ${status}`,
    tier !== 'all' && `Tier: ${tier}`,
    minConfidence > 0 && `Confidence ≥ ${(minConfidence * 100).toFixed(0)}%`,
    range !== 'all' && `Last ${range}`,
    query && `“${query}”`,
  ].filter(Boolean) as string[];

  const clearAll = () => {
    setQuery(''); setRegion('all'); setStatus('all'); setTier('all');
    setMinConfidence(0); setRange('all');
  };

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="bg-amber-500 text-white p-1.5 rounded"><AlertTriangle className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Spill incidents</h2>
            <p className="text-[11px] text-gray-500">
              {filtered.length} of {world.cases.length} detections
              {hiddenLowConfidence > 0 && !showLowConfidence && ` · ${hiddenLowConfidence} low-confidence hidden`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-gray-300 overflow-hidden">
            <button onClick={() => setView('table')} className={`px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1.5 ${view === 'table' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              <List className="w-3.5 h-3.5" /> Table
            </button>
            <button onClick={() => setView('map')} className={`px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1.5 border-l border-gray-300 ${view === 'map' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              <MapIcon className="w-3.5 h-3.5" /> Map
            </button>
          </div>
          <Button size="sm" onClick={() => setFiltersOpen((o) => !o)} icon={<Filter className="w-3 h-3" />}>
            Filters{activeFilters.length > 0 && ` (${activeFilters.length})`}
          </Button>
          <ExportButton onExport={() => downloadCsv('oceanwatch-incidents.csv', columns.filter((c) => c.value), filtered)} />
        </div>
      </div>

      {filtersOpen && (
        <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5 flex-shrink-0">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
            <SearchInput value={query} onChange={setQuery} placeholder="Case ID, location, analyst…" className="md:col-span-2" />
            <Select label="Region" value={region} onChange={setRegion}
              options={[{ value: 'all', label: 'All regions' }, ...regions.map((r) => ({ value: r, label: r }))]} />
            <Select label="Status" value={status} onChange={setStatus}
              options={[{ value: 'all', label: 'All statuses' }, ...['New', 'Under Analysis', 'Attributed', 'Verification Dispatched', 'Verified', 'Enforcement', 'Closed', 'Dismissed — Look-alike'].map((s) => ({ value: s, label: s }))]} />
            <Select label="Risk tier" value={tier} onChange={setTier}
              options={[{ value: 'all', label: 'All tiers' }, { value: 'HIGH', label: 'High' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'LOW', label: 'Low' }]} />
            <Select label="Time range" value={range} onChange={setRange}
              options={[{ value: 'all', label: 'All time' }, { value: '24h', label: 'Last 24 hours' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }]} />
          </div>
          <div className="flex items-center gap-5 mt-2.5 flex-wrap">
            <div className="w-56">
              <Slider label="Minimum confidence" value={minConfidence} onChange={setMinConfidence} min={0} max={0.95} step={0.05}
                format={(v) => `${(v * 100).toFixed(0)}%`} />
            </div>
            <Toggle checked={showLowConfidence} onChange={setShowLowConfidence}
              label={<span>Include low-confidence detections <span className="text-gray-400">(&lt; 55% — probable look-alikes)</span></span>} />
            {activeFilters.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap ml-auto">
                {activeFilters.map((f) => <Badge key={f} tone="blue">{f}</Badge>)}
                <button onClick={clearAll} className="text-[11px] text-gray-500 hover:text-red-600 font-semibold flex items-center gap-1">
                  <X className="w-3 h-3" /> Clear
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-3 p-3">
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <Panel className="flex-1" bodyClass="min-h-0">
            {view === 'table' ? (
              <DataTable
                columns={columns} rows={filtered} rowKey={(c) => c.id} dense
                onRowClick={(c) => navigate({ tab: 'Investigation', caseId: c.id })}
                initialSort={{ key: 'acquired', dir: 'desc' }}
                empty={
                  <div className="space-y-2">
                    <p>No detections match the current filters.</p>
                    {activeFilters.length > 0 && <Button size="sm" onClick={clearAll}>Clear all filters</Button>}
                  </div>
                }
              />
            ) : (
              <MapView
                initialCentre={{ lat: 14.5, lon: 80 }} initialZoom={3.9}
                markers={markers} polygons={polygons}
                onMarkerClick={(m) => navigate({ tab: 'Investigation', caseId: m.id })}
                fitTo={markers.length ? markers.map((m) => m.position) : undefined}
                fitKey={`${filtered.length}-${region}-${status}-${tier}`}
              />
            )}
          </Panel>
        </div>

        <div className="w-[280px] flex-shrink-0 flex flex-col gap-3">
          <Panel title="Suggested next tasking" subtitle="Risk-weighted by hit rate and staleness" dense>
            {suggestion && (
              <div className="p-3">
                <div className="flex items-start gap-2 mb-2">
                  <Target className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-xs text-gray-900 leading-tight">{suggestion.aoi.name}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">Priority {suggestion.aoi.priority} · {suggestion.aoi.hitRate.toFixed(1)} detections per 100 passes</p>
                  </div>
                </div>
                <p className="text-[10.5px] text-gray-600 leading-snug mb-2">{suggestion.aoi.rationale}</p>
                <div className="bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-2">
                  <p className="text-[10px] text-amber-900">
                    Last covered {suggestion.hoursSince.toFixed(1)} h ago. Revisit gap is the dominant term in the
                    current ranking.
                  </p>
                </div>
                <Button size="sm" variant="primary" className="w-full justify-center"
                  onClick={() => navigate({ tab: 'Satellite Tasking', section: suggestion.aoi.id })}
                  icon={<Satellite className="w-3 h-3" />}>
                  Open tasking queue
                </Button>
              </div>
            )}
          </Panel>

          <Panel title="Queue breakdown" dense className="flex-1" bodyClass="overflow-y-auto">
            <div className="p-3 space-y-3">
              <Breakdown label="By status" items={countBy(filtered, (c) => c.status)} onPick={(k) => setStatus(k)} />
              <Breakdown label="By region" items={countBy(filtered, (c) => c.region)} onPick={(k) => setRegion(k)} />
              <Breakdown label="By sensor" items={countBy(filtered, (c) => c.detection.sensor)} />
              <Breakdown label="By assigned analyst" items={countBy(filtered, (c) => c.assignedTo)} />
            </div>
          </Panel>

          <InfoBanner tone="blue">
            Confidence is the probability the feature is mineral oil rather than a natural look-alike, after the
            wind, contrast, edge and geometry cross-checks. Low-confidence detections stay in the archive rather
            than being deleted.
          </InfoBanner>
        </div>
      </div>
    </main>
  );
}

function countBy<T>(rows: T[], key: (r: T) => string): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

function Breakdown({ label, items, onPick }: { label: string; items: { label: string; count: number }[]; onPick?: (k: string) => void }) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-500 uppercase mb-1.5">{label}</p>
      <div className="space-y-1">
        {items.length === 0 && <p className="text-[10px] text-gray-400">No data</p>}
        {items.map((i) => (
          <button key={i.label} onClick={() => onPick?.(i.label)} disabled={!onPick}
            className={`w-full flex items-center gap-2 text-[10.5px] ${onPick ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'} px-1 py-0.5 rounded`}>
            <span className="flex-1 text-left text-gray-700 truncate" title={i.label}>{i.label}</span>
            <div className="w-12 h-1.5 bg-gray-200 rounded overflow-hidden flex-shrink-0">
              <div className="h-full bg-blue-500 rounded" style={{ width: `${(i.count / max) * 100}%` }} />
            </div>
            <span className="font-mono font-bold text-gray-800 w-4 text-right flex-shrink-0">{i.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
