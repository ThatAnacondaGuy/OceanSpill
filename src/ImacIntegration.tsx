import { useEffect, useMemo, useState } from 'react';
import {
  Database, Radio, CheckCircle2, AlertTriangle, Send, Server, Key,
  ArrowUpRight, Copy, Cable, Terminal,
} from 'lucide-react';
import { useStore, fmt, type CaseAnalysis } from './store/store';
import {
  Badge, Button, KeyValue, Tabs, StatCard, DataTable, InfoBanner, EmptyState,
  Select, SearchInput, Modal, triggerDownload, ProvenanceBadge, type Column,
} from './components/ui';
import { analysePolygon } from './lib/geo';
import type { DataSource, SpillCase } from './data/types';
import { READ_ONLY_HINT } from './data/access';

/**
 * Data management and the IMAC hand-off. IMAC ingest is not integrated, so payloads are
 * generated locally in the format a Navy / Coast Guard common operating picture would ingest,
 * and can be downloaded. Nothing on this page claims delivery.
 */
export default function ImacIntegration() {
  const { world, now, pushToImac, navigate, consumeSection, notify, getAnalysis, revision, canEdit } = useStore();
  const [tab, setTab] = useState('imac');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [payloadFor, setPayloadFor] = useState<string | null>(null);

  useEffect(() => {
    const s = consumeSection();
    if (s === 'sources') setTab('sources');
  }, [consumeSection]);

  const generated = useMemo(() => world.cases.filter((c) => c.imacPushed).sort((a, b) => (b.imacPushedAt ?? 0) - (a.imacPushedAt ?? 0)), [world.cases, revision]);
  const pending = useMemo(
    () => world.cases.filter((c) => !c.imacPushed && c.status !== 'Dismissed — Look-alike'),
    [world.cases, revision]
  );

  const sources = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.dataSources.filter((d) => {
      if (q && !`${d.name} ${d.agency} ${d.message} ${d.id}`.toLowerCase().includes(q)) return false;
      if (kindFilter !== 'all' && d.kind !== kindFilter) return false;
      return true;
    });
  }, [world.dataSources, query, kindFilter, revision]);

  const imacColumns: Column<SpillCase>[] = [
    {
      key: 'id', header: 'Case', value: (c) => c.title,
      render: (c) => <div><div className="font-bold text-gray-900">{c.title}</div><div className="text-[0.6875rem] font-mono text-gray-400">{c.id}</div></div>,
    },
    { key: 'region', header: 'Location', width: '220px', value: (c) => c.subRegion, render: (c) => <span className="text-gray-700 text-[0.71875rem]">{c.subRegion}</span> },
    {
      key: 'pushed', header: 'Generated (UTC)', width: '140px', value: (c) => c.imacPushedAt ?? 0,
      render: (c) => c.imacPushedAt
        ? <div><div className="font-mono text-gray-800">{fmt.utcShort(c.imacPushedAt)}</div><div className="text-[0.65625rem] text-gray-400">{fmt.ago(c.imacPushedAt, now)}</div></div>
        : <span className="text-gray-300">—</span>,
    },
    { key: 'status', header: 'Case status', width: '130px', value: (c) => c.status, render: (c) => <Badge tone="blue">{c.status}</Badge> },
    {
      key: 'delivery', header: 'Delivery', width: '112px', sortable: false,
      render: () => <Badge tone="gray">Not sent</Badge>,
    },
    {
      key: 'payload', header: '', width: '110px', sortable: false,
      render: (c) => <Button size="sm" onClick={(e) => { e.stopPropagation(); setPayloadFor(c.id); }}>View payload</Button>,
    },
  ];

  const sourceColumns: Column<DataSource>[] = [
    {
      key: 'name', header: 'Source', value: (d) => d.name,
      render: (d) => (
        <div>
          <div className="font-bold text-gray-900">{d.name}</div>
          <div className="text-[0.6875rem] text-gray-500">{d.agency}</div>
        </div>
      ),
    },
    { key: 'kind', header: 'Type', width: '120px', value: (d) => d.kind, render: (d) => <Badge tone="gray">{d.kind}</Badge> },
    { key: 'sovereign', header: 'Origin', width: '84px', value: (d) => (d.sovereign ? 0 : 1), render: (d) => <Badge tone={d.sovereign ? 'green' : 'gray'}>{d.sovereign ? 'Indian' : 'Foreign'}</Badge> },
    { key: 'role', header: 'Role', width: '84px', value: (d) => d.role, render: (d) => <span className="text-gray-600">{d.role}</span> },
    {
      key: 'status', header: 'Status', width: '120px', value: (d) => ({ Online: 0, 'Interim fallback': 1, 'Not configured': 2, 'Pending access': 3 }[d.status]),
      render: (d) => <Badge tone={d.status === 'Online' ? 'green' : d.status === 'Interim fallback' ? 'teal' : d.status === 'Not configured' ? 'amber' : 'gray'}>{d.status}</Badge>,
    },
    { key: 'message', header: 'Detail', value: (d) => d.message, render: (d) => <span className="text-gray-600 text-[0.71875rem]">{d.message}</span> },
    {
      key: 'sync', header: 'Last build', width: '104px', value: (d) => d.lastSync ?? 0,
      render: (d) => d.lastSync != null ? <span className="text-gray-600">{fmt.ago(d.lastSync, now)}</span> : <span className="text-gray-300">—</span>,
    },
  ];

  const health = useMemo(() => ({
    online: world.dataSources.filter((d) => d.status === 'Online').length,
    fallback: world.dataSources.filter((d) => d.status === 'Interim fallback').length,
    notConfigured: world.dataSources.filter((d) => d.status === 'Not configured').length,
    pendingAccess: world.dataSources.filter((d) => d.status === 'Pending access').length,
  }), [world.dataSources, revision]);

  const payloadCase = world.cases.find((c) => c.id === payloadFor);
  const payloadText = payloadCase ? buildPayload(payloadCase, world, getAnalysis(payloadCase.id), now) : '';

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-y-auto lg:overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0 flex-wrap gap-y-2">
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 text-white p-1.5 rounded"><Database className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Data management</h2>
            <p className="text-[0.75rem] text-gray-500">IMAC payloads and data source status · data built {fmt.ago(Date.parse(world.generatedAt), now)}</p>
          </div>
        </div>
      </div>

      <Tabs active={tab} onChange={setTab} className="bg-white px-3 flex-shrink-0" tabs={[
        { id: 'imac', label: 'IMAC payloads', count: generated.length },
        { id: 'sources', label: 'Data sources', count: world.dataSources.length },
      ]} />

      {tab === 'imac' && (
        <div className="flex-none lg:flex-1 lg:min-h-0 flex flex-col p-4 gap-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 flex-shrink-0">
            <StatCard icon={<Radio className="w-5 h-5" />} title="Payloads generated" value={generated.length} trend="this session" accent="green" />
            <StatCard icon={<Send className="w-5 h-5" />} title="Not yet generated" value={pending.length} trend="open cases" accent={pending.length > 0 ? 'amber' : 'blue'} />
            <StatCard icon={<CheckCircle2 className="w-5 h-5" />} title="Delivered" value={0} trend="IMAC ingest not integrated" />
            <StatCard icon={<Key className="w-5 h-5" />} title="Integration" value="Pending" trend="needs Indian Navy access" accent="amber" />
          </div>

          <InfoBanner tone="amber" icon={<Cable className="w-3.5 h-3.5" />}>
            <b>IMAC is not connected.</b> Payloads are prepared here in GeoJSON for review; delivery will be added once Navy access is granted.
          </InfoBanner>

          <div className="flex-none lg:flex-1 lg:min-h-0 flex flex-col lg:flex-row gap-3">
            <div className="flex-none h-[70vh] lg:h-auto lg:flex-1 min-w-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
              <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <span className="text-[0.75rem] font-bold text-gray-700">Generated payloads</span>
              </div>
              <div className="flex-1 min-h-0">
                <DataTable columns={imacColumns} rows={generated} rowKey={(c) => c.id} dense
                  onRowClick={(c) => setPayloadFor(c.id)}
                  initialSort={{ key: 'pushed', dir: 'desc' }}
                  empty="No payloads generated yet. Use the list on the right." />
              </div>
            </div>

            <div className="w-full lg:w-[280px] xl:w-[320px] max-h-[70vh] lg:max-h-none flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
              <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <span className="text-[0.75rem] font-bold text-gray-700">Open cases</span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {pending.length === 0 ? (
                  <EmptyState icon={<CheckCircle2 className="w-9 h-9" />} title="All generated" body="Every open case has a payload." />
                ) : pending.map((c) => (
                  <div key={c.id} className="px-2.5 py-2 border-b border-gray-100">
                    <div className="flex justify-between items-start gap-2 mb-1">
                      <div className="min-w-0">
                        <p className="text-[0.75rem] font-bold text-gray-900 truncate">{c.title}</p>
                        <p className="text-[0.6875rem] text-gray-600 truncate">{c.subRegion}</p>
                      </div>
                      <Badge tone={c.tier === 'HIGH' ? 'red' : c.tier === 'MEDIUM' ? 'amber' : 'gray'}>{c.tier}</Badge>
                    </div>
                    <p className="text-[0.6875rem] text-gray-400 mb-1.5">{c.status} · {fmt.precise(c.incidentTime, c.facts.incident.timePrecision)}</p>
                    <div className="flex gap-1.5">
                      <Button size="sm" className="flex-1 justify-center" onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}>Review</Button>
                      <Button size="sm" variant="primary" className="flex-1 justify-center" disabled={!canEdit('Data Management')} title={canEdit('Data Management') ? undefined : READ_ONLY_HINT} onClick={() => { pushToImac(c.id); setPayloadFor(c.id); }} icon={<ArrowUpRight className="w-3 h-3" />}>Generate</Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-2 border-t border-gray-200">
                <p className="text-[0.6875rem] text-gray-500 leading-normal">
                  Generation is a deliberate act after review. An unreviewed detection should not enter a shared operational picture.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'sources' && (
        <div className="flex-none lg:flex-1 lg:min-h-0 flex flex-col p-4 gap-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 flex-shrink-0">
            <StatCard icon={<Server className="w-5 h-5" />} title="Online" value={health.online} trend={`of ${world.dataSources.length} listed`} accent="green" />
            <StatCard icon={<CheckCircle2 className="w-5 h-5" />} title="Interim fallback" value={health.fallback} trend="working stand-ins for pending sources" />
            <StatCard icon={<AlertTriangle className="w-5 h-5" />} title="Not configured" value={health.notConfigured} trend="adapter ready, credentials missing" accent="amber" />
            <StatCard icon={<Key className="w-5 h-5" />} title="Pending access" value={health.pendingAccess} trend="needs agency access" />
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <SearchInput value={query} onChange={setQuery} placeholder="Source, agency or detail…" className="w-72" />
            <Select value={kindFilter} onChange={setKindFilter}
              options={[{ value: 'all', label: 'All types' }, ...Array.from(new Set(world.dataSources.map((d) => d.kind))).map((k) => ({ value: k, label: k }))]} />
            <span className="text-[0.75rem] text-gray-500 ml-auto">{sources.length} of {world.dataSources.length} shown</span>
          </div>

          <div className="h-[70vh] flex-none lg:h-auto lg:flex-1 lg:min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
            <DataTable columns={sourceColumns} rows={sources} rowKey={(d) => d.id} dense
              initialSort={{ key: 'status', dir: 'asc' }} />
          </div>

          <InfoBanner tone="blue" icon={<Terminal className="w-3.5 h-3.5" />}>
            Status reflects the last data update, {fmt.ago(Date.parse(world.generatedAt), now)}.
          </InfoBanner>
        </div>
      )}

      <Modal open={!!payloadCase} onClose={() => setPayloadFor(null)}
        title={payloadCase ? `IMAC payload — ${payloadCase.title}` : ''}
        subtitle="Generated locally. Not transmitted."
        width="max-w-2xl"
        footer={
          payloadCase ? (
            <>
              <Button onClick={() => {
                navigator.clipboard?.writeText(payloadText);
                notify({ kind: 'success', title: 'Payload copied to clipboard' });
              }} icon={<Copy className="w-3 h-3" />}>Copy</Button>
              <Button variant="primary" onClick={() => triggerDownload(`${payloadCase.id}-imac-payload.json`, payloadText, 'application/json')}>
                Download JSON
              </Button>
            </>
          ) : null
        }>
        {payloadCase && (
          <div className="space-y-4">
            <KeyValue cols={2} items={[
              ['Format', 'GeoJSON FeatureCollection + case metadata'],
              ['Transport', 'Not integrated'],
              ['Generated', payloadCase.imacPushedAt ? fmt.utc(payloadCase.imacPushedAt) : 'Preview'],
              ['Suspect tracks', (() => {
                const kinds = new Set((getAnalysis(payloadCase.id)?.ranked ?? []).slice(0, 3).map((r) => world.tracks.get(r.mmsi)?.provenance));
                if (kinds.size === 1 && kinds.has('real')) return <span className="flex items-center gap-1">Real AIS (GFW hourly presence) <ProvenanceBadge p="real" /></span>;
                if (kinds.has('real')) return <span className="flex items-center gap-1">Mixed real and interpolated <ProvenanceBadge p="synthetic-anchored" /></span>;
                return <span className="flex items-center gap-1">Interpolated / synthetic <ProvenanceBadge p="synthetic" /></span>;
              })()],
            ]} />
            <pre className="bg-slate-900 text-slate-100 rounded p-4 text-[0.6875rem] font-mono overflow-x-auto leading-relaxed max-h-80 overflow-y-auto">
              {payloadText}
            </pre>
            <InfoBanner tone="blue">
              The payload includes the hindcast uncertainty and the data source of every suspect track.
            </InfoBanner>
          </div>
        )}
      </Modal>
    </main>
  );
}

function buildPayload(c: SpillCase, world: ReturnType<typeof useStore>['world'], a: CaseAnalysis | null, now: number): string {
  const shape = analysePolygon(c.detection.polygon.ring);
  const round = (n: number, d = 5) => Number(n.toFixed(d));
  const features: object[] = [
    {
      type: 'Feature',
      properties: { role: 'reported-extent', basis: c.detection.geometryBasis, observedAt: new Date(c.detection.acquiredAt).toISOString(), source: c.detection.observationSource },
      geometry: { type: 'Polygon', coordinates: [c.detection.polygon.ring.map((p) => [round(p.lon), round(p.lat)])] },
    },
  ];
  if (a) {
    features.push({
      type: 'Feature',
      properties: {
        role: 'hindcast-origin', estimatedTime: new Date(a.hindcast.estimatedTime).toISOString(),
        uncertaintyKm: round(a.hindcast.uncertaintyRadiusKm, 1), timeWindowHours: round(a.hindcast.timeWindowHours, 1), provenance: 'modelled',
      },
      geometry: { type: 'Point', coordinates: [round(a.hindcast.estimatedOrigin.lon), round(a.hindcast.estimatedOrigin.lat)] },
    });
    for (const h of a.forecast.horizons) {
      features.push({
        type: 'Feature',
        properties: { role: 'forecast', hours: h.hours, time: new Date(h.time).toISOString(), spreadKm: round(h.spreadKm, 1), provenance: 'modelled' },
        geometry: { type: 'Point', coordinates: [round(h.centroid.lon), round(h.centroid.lat)] },
      });
    }
  }
  return JSON.stringify({
    schema: 'oceanspill.cop.pollution.draft-1',
    generatedAt: new Date(c.imacPushedAt ?? now).toISOString(),
    status: 'DRAFT_NOT_TRANSMITTED',
    source: { system: 'OceanSpill', mode: 'retrospective-analysis' },
    incident: {
      id: c.id,
      title: c.title,
      type: 'MARINE_OIL_POLLUTION',
      caseStatus: c.status,
      riskTier: c.tier,
      incidentTime: new Date(c.incidentTime).toISOString(),
      incidentTimePrecision: c.facts.incident.timePrecision,
      region: c.region,
      subRegion: c.subRegion,
      sourceType: c.sourceType,
      oilQuantityTonnes: c.oilQuantityTonnes,
    },
    detection: {
      basis: c.confidenceBasis,
      confidence: c.confidence,
      sarScenes: c.detection.scenes.map((s) => ({ name: s.name, provider: s.provider, start: new Date(s.start).toISOString() })),
      areaKm2: round(shape.areaKm2, 2),
      extentReported: c.detection.extentReported,
    },
    forcing: a ? a.sampler.sources : null,
    geometry: { type: 'FeatureCollection', features },
    suspects: (a?.ranked ?? []).slice(0, 3).map((s) => {
      const v = world.vesselsByMmsi.get(s.mmsi);
      return {
        rank: s.rank, score: round(s.total, 3), name: v?.name ?? s.mmsi, mmsi: v?.mmsiNumber ?? null, imo: v?.imo ?? null,
        flag: v?.flag ?? null, type: v?.type ?? null, cpaKm: round(s.cpaKm, 1), darkDuringWindow: s.darkDuringWindow,
        vesselProvenance: v?.provenance ?? 'unknown', trackProvenance: world.tracks.get(s.mmsi)?.provenance ?? 'unknown',
      };
    }),
    verdict: a ? { band: a.verdict.band, label: a.verdict.label } : null,
    caveat: 'Attribution is a prioritisation score, not evidence of discharge. Check trackProvenance: only "real" tracks are observed AIS positions.',
    sources: c.facts.sources,
  }, null, 2);
}
