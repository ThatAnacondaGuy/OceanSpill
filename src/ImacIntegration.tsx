import { useEffect, useMemo, useState } from 'react';
import {
  Database, Radio, CheckCircle2, AlertTriangle, RefreshCw, Send, Server, Key,
  Activity, ArrowUpRight, Copy, Cable,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import {
  Badge, Button, KeyValue, Tabs, StatCard, DataTable, InfoBanner, EmptyState,
  Select, SearchInput, Modal, triggerDownload, type Column,
} from './components/ui';
import { analysePolygon } from './lib/geo';
import type { DataSource, SpillCase } from './data/types';

/**
 * Data management and the IMAC hand-off.
 *
 * The sync view is intentionally thin. The whole point of the IMAC integration is that the
 * Coast Guard should not need another screen — cases appear in the common operating picture
 * they already watch. This page exists so NTRO operators can confirm the hand-off worked,
 * not to present a maritime picture of its own.
 */
export default function ImacIntegration() {
  const { world, now, pushToImac, navigate, consumeSection, notify, log, currentUser, revision } = useStore();
  const [tab, setTab] = useState('imac');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [payloadFor, setPayloadFor] = useState<string | null>(null);

  useEffect(() => {
    const s = consumeSection();
    if (s === 'sources') setTab('sources');
  }, [consumeSection]);

  const pushed = useMemo(() => world.cases.filter((c) => c.imacPushed).sort((a, b) => (b.imacPushedAt ?? 0) - (a.imacPushedAt ?? 0)), [world.cases, revision]);
  const pending = useMemo(
    () => world.cases.filter((c) => !c.imacPushed && !['Dismissed — Look-alike'].includes(c.status)),
    [world.cases, revision]
  );

  const sources = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.dataSources.filter((d) => {
      if (q && !`${d.name} ${d.provider} ${d.endpoint}`.toLowerCase().includes(q)) return false;
      if (kindFilter !== 'all' && d.kind !== kindFilter) return false;
      return true;
    });
  }, [world.dataSources, query, kindFilter, revision]);

  const imacColumns: Column<SpillCase>[] = [
    { key: 'id', header: 'Case', width: '132px', value: (c) => c.id, render: (c) => <span className="font-mono font-bold text-gray-900">{c.id}</span> },
    { key: 'region', header: 'Location', value: (c) => c.subRegion, render: (c) => <span className="text-gray-700">{c.subRegion}</span> },
    {
      key: 'pushed', header: 'Synced at (UTC)', width: '146px', value: (c) => c.imacPushedAt ?? 0,
      render: (c) => c.imacPushedAt
        ? <div><div className="font-mono text-gray-800">{fmt.utcShort(c.imacPushedAt)}</div><div className="text-[9px] text-gray-400">{fmt.ago(c.imacPushedAt, now)}</div></div>
        : <span className="text-gray-300">—</span>,
    },
    { key: 'status', header: 'Case status', width: '140px', value: (c) => c.status, render: (c) => <Badge tone="blue">{c.status}</Badge> },
    {
      key: 'delivery', header: 'Delivery', width: '112px', sortable: false,
      render: () => <Badge tone="green"><CheckCircle2 className="w-2.5 h-2.5" /> Acknowledged</Badge>,
    },
    {
      key: 'payload', header: '', width: '110px', sortable: false,
      render: (c) => (
        <Button size="sm" onClick={(e) => { e.stopPropagation(); setPayloadFor(c.id); }}>View payload</Button>
      ),
    },
  ];

  const sourceColumns: Column<DataSource>[] = [
    {
      key: 'name', header: 'Source', value: (d) => d.name,
      render: (d) => (
        <div>
          <div className="font-bold text-gray-900">{d.name}</div>
          <div className="text-[9.5px] text-gray-500 font-mono truncate max-w-[280px]">{d.endpoint}</div>
        </div>
      ),
    },
    { key: 'kind', header: 'Type', width: '108px', value: (d) => d.kind, render: (d) => <Badge tone="gray">{d.kind}</Badge> },
    { key: 'provider', header: 'Provider', width: '180px', value: (d) => d.provider, render: (d) => <span className="text-gray-600">{d.provider}</span> },
    {
      key: 'status', header: 'Status', width: '92px', value: (d) => d.status,
      render: (d) => <Badge tone={d.status === 'Online' ? 'green' : d.status === 'Degraded' ? 'amber' : 'red'}>{d.status}</Badge>,
    },
    {
      key: 'latency', header: 'Latency', width: '86px', align: 'right', value: (d) => d.latencyMs,
      render: (d) => <span className={`font-mono ${d.latencyMs > 3000 ? 'text-red-600 font-bold' : d.latencyMs > 1500 ? 'text-amber-600' : 'text-gray-700'}`}>{fmt.num(d.latencyMs)} ms</span>,
    },
    { key: 'rate', header: 'Rate', width: '92px', align: 'right', value: (d) => d.recordsPerMin, render: (d) => <span className="font-mono text-gray-700">{d.recordsPerMin > 0 ? `${fmt.num(d.recordsPerMin)}/min` : '—'}</span> },
    { key: 'sync', header: 'Last sync', width: '104px', value: (d) => d.lastSync, render: (d) => <span className="text-gray-600">{fmt.ago(d.lastSync, now)}</span> },
    {
      key: 'quota', header: 'Quota', width: '96px', align: 'right', value: (d) => d.quotaUsedPct,
      render: (d) => (
        <div className="flex items-center gap-1.5 justify-end">
          <div className="w-10 h-1.5 bg-gray-200 rounded overflow-hidden">
            <div className={`h-full ${d.quotaUsedPct > 80 ? 'bg-red-500' : d.quotaUsedPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${d.quotaUsedPct}%` }} />
          </div>
          <span className="font-mono text-gray-700 w-7 text-right">{d.quotaUsedPct}%</span>
        </div>
      ),
    },
    { key: 'auth', header: 'Auth', width: '150px', value: (d) => d.authMode, render: (d) => <span className="text-gray-500 text-[10px]">{d.authMode}</span> },
  ];

  const health = useMemo(() => ({
    online: world.dataSources.filter((d) => d.status === 'Online').length,
    degraded: world.dataSources.filter((d) => d.status === 'Degraded').length,
    offline: world.dataSources.filter((d) => d.status === 'Offline').length,
    throughput: world.dataSources.reduce((s, d) => s + d.recordsPerMin, 0),
  }), [world.dataSources, revision]);

  const payloadCase = world.cases.find((c) => c.id === payloadFor);

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 text-white p-1.5 rounded"><Database className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Data management</h2>
            <p className="text-[11px] text-gray-500">IMAC hand-off and upstream data sources</p>
          </div>
        </div>
        <Button size="sm" onClick={() => {
          for (const d of world.dataSources) d.lastSync = now;
          log({ actor: currentUser.name, role: currentUser.role, action: 'Manual sync triggered', target: 'all sources', detail: `${world.dataSources.length} sources refreshed`, category: 'System' });
          notify({ kind: 'success', title: 'Sources refreshed', body: `${world.dataSources.length} upstream connections re-polled.` });
        }} icon={<RefreshCw className="w-3 h-3" />}>Refresh all sources</Button>
      </div>

      <Tabs active={tab} onChange={setTab} className="bg-white px-3 flex-shrink-0" tabs={[
        { id: 'imac', label: 'IMAC sync', count: pushed.length },
        { id: 'sources', label: 'Data sources', count: world.dataSources.length },
      ]} />

      {tab === 'imac' && (
        <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
          <div className="grid grid-cols-4 gap-3 flex-shrink-0">
            <StatCard icon={<Radio className="w-5 h-5" />} title="Published to IMAC" value={pushed.length} trend="records in the common operating picture" accent="green" />
            <StatCard icon={<Send className="w-5 h-5" />} title="Awaiting publication" value={pending.length} trend="open cases not yet synced" accent={pending.length > 0 ? 'amber' : 'blue'} />
            <StatCard icon={<CheckCircle2 className="w-5 h-5" />} title="Delivery success" value="100%" trend="no failed transmissions" accent="green" />
            <StatCard icon={<Activity className="w-5 h-5" />} title="Endpoint latency"
              value={`${world.dataSources.find((d) => d.id === 'DS-IMAC')?.latencyMs ?? 0} ms`} trend="mTLS, signed payload" />
          </div>

          <InfoBanner tone="blue" icon={<Cable className="w-3.5 h-3.5" />}>
            <b>This console is upstream of IMAC, not a replacement for it.</b> A verified case record is pushed
            into the Navy/Coast Guard common operating picture that watch officers already use. They never need
            to open this system — the record simply appears in theirs. This page exists so NTRO operators can
            confirm the hand-off worked, which is why it has a log and no map.
          </InfoBanner>

          <div className="flex-1 min-h-0 flex gap-3">
            <div className="flex-1 min-w-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
              <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <span className="text-[11px] font-bold text-gray-700">Published records</span>
              </div>
              <div className="flex-1 min-h-0">
                <DataTable columns={imacColumns} rows={pushed} rowKey={(c) => c.id} dense
                  onRowClick={(c) => navigate({ tab: 'Investigation', caseId: c.id })}
                  initialSort={{ key: 'pushed', dir: 'desc' }}
                  empty="No case records have been published to IMAC yet." />
              </div>
            </div>

            <div className="w-[320px] flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
              <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <span className="text-[11px] font-bold text-gray-700">Awaiting publication</span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {pending.length === 0 ? (
                  <EmptyState icon={<CheckCircle2 className="w-9 h-9" />} title="All caught up" body="Every open case has been published." />
                ) : pending.map((c) => (
                  <div key={c.id} className="px-2.5 py-2 border-b border-gray-100">
                    <div className="flex justify-between items-start gap-2 mb-1">
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold font-mono text-gray-900">{c.id}</p>
                        <p className="text-[10px] text-gray-600 truncate">{c.subRegion}</p>
                      </div>
                      <Badge tone={c.tier === 'HIGH' ? 'red' : c.tier === 'MEDIUM' ? 'amber' : 'gray'}>{c.tier}</Badge>
                    </div>
                    <p className="text-[9.5px] text-gray-400 mb-1.5">{c.status} · {fmt.ago(c.detection.acquiredAt, now)}</p>
                    <div className="flex gap-1.5">
                      <Button size="sm" className="flex-1 justify-center" onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}>Review</Button>
                      <Button size="sm" variant="primary" className="flex-1 justify-center" onClick={() => pushToImac(c.id)} icon={<ArrowUpRight className="w-3 h-3" />}>Publish</Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-2 border-t border-gray-200">
                <p className="text-[9.5px] text-gray-500 leading-snug">
                  Publication is a deliberate act, not automatic. An unreviewed detection should not enter a
                  shared operational picture where other agencies may act on it.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'sources' && (
        <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
          <div className="grid grid-cols-4 gap-3 flex-shrink-0">
            <StatCard icon={<Server className="w-5 h-5" />} title="Online" value={health.online} trend={`of ${world.dataSources.length} configured`} accent="green" />
            <StatCard icon={<AlertTriangle className="w-5 h-5" />} title="Degraded" value={health.degraded} trend="elevated latency or partial data" accent={health.degraded > 0 ? 'amber' : 'blue'} />
            <StatCard icon={<Activity className="w-5 h-5" />} title="Ingest rate" value={fmt.num(health.throughput)} trend="records per minute" />
            <StatCard icon={<Key className="w-5 h-5" />} title="Quota pressure"
              value={world.dataSources.filter((d) => d.quotaUsedPct > 75).length} trend="sources above 75% of quota"
              accent={world.dataSources.some((d) => d.quotaUsedPct > 80) ? 'red' : 'blue'} />
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <SearchInput value={query} onChange={setQuery} placeholder="Source, provider or endpoint…" className="w-72" />
            <Select value={kindFilter} onChange={setKindFilter}
              options={[{ value: 'all', label: 'All types' }, ...Array.from(new Set(world.dataSources.map((d) => d.kind))).map((k) => ({ value: k, label: k }))]} />
            <span className="text-[11px] text-gray-500 ml-auto">{sources.length} of {world.dataSources.length} shown</span>
          </div>

          <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
            <DataTable columns={sourceColumns} rows={sources} rowKey={(d) => d.id} dense
              initialSort={{ key: 'status', dir: 'asc' }} />
          </div>

          {world.dataSources.some((d) => d.status === 'Degraded') && (
            <InfoBanner tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
              {world.dataSources.filter((d) => d.status === 'Degraded').map((d) => d.name).join(', ')} is degraded.
              Ocean forcing latency directly widens the hindcast uncertainty envelope, which in turn widens the
              AIS search radius and admits more candidate vessels — a quiet degradation in attribution quality
              that would otherwise be invisible.
            </InfoBanner>
          )}
        </div>
      )}

      <Modal open={!!payloadCase} onClose={() => setPayloadFor(null)}
        title={payloadCase ? `IMAC payload — ${payloadCase.id}` : ''}
        subtitle="The exact record transmitted to the common operating picture"
        width="max-w-2xl"
        footer={
          payloadCase ? (
            <>
              <Button onClick={() => {
                navigator.clipboard?.writeText(buildPayload(payloadCase, world, now));
                notify({ kind: 'success', title: 'Payload copied to clipboard' });
              }} icon={<Copy className="w-3 h-3" />}>Copy</Button>
              <Button variant="primary" onClick={() => triggerDownload(`${payloadCase.id}-imac-payload.json`, buildPayload(payloadCase, world, now), 'application/json')}>
                Download JSON
              </Button>
            </>
          ) : null
        }>
        {payloadCase && (
          <div className="space-y-3">
            <KeyValue cols={2} items={[
              ['Endpoint', 'imac.navy.gov.in/cop/ingest'],
              ['Transport', 'mTLS + signed payload'],
              ['Published', payloadCase.imacPushedAt ? fmt.utc(payloadCase.imacPushedAt) : '—'],
              ['Acknowledgement', 'Received'],
            ]} />
            <pre className="bg-slate-900 text-slate-100 rounded p-3 text-[10px] font-mono overflow-x-auto leading-relaxed max-h-80 overflow-y-auto">
              {buildPayload(payloadCase, world, now)}
            </pre>
            <InfoBanner tone="blue">
              The payload carries the case, its geometry, the hindcast origin with its uncertainty, and the
              ranked suspects with their confidence band — deliberately including the uncertainty, so a watch
              officer reading it in IMAC sees the same caveats an analyst sees here.
            </InfoBanner>
          </div>
        )}
      </Modal>
    </main>
  );
}

function buildPayload(c: SpillCase, world: ReturnType<typeof useStore>['world'], now: number): string {
  const shape = analysePolygon(c.detection.polygon.ring);
  return JSON.stringify({
    schema: 'imac.cop.pollution.v1',
    publishedAt: new Date(c.imacPushedAt ?? now).toISOString(),
    source: { system: 'OceanWatch AI', agency: 'NTRO', classification: 'RESTRICTED' },
    incident: {
      id: c.id,
      type: 'MARINE_OIL_POLLUTION',
      status: c.status,
      riskTier: c.tier,
      detectedAt: new Date(c.detection.acquiredAt).toISOString(),
      region: c.region,
      subRegion: c.subRegion,
    },
    detection: {
      sensor: c.detection.sensor,
      mode: c.detection.mode,
      sceneId: c.detection.sceneId,
      confidence: Number(c.confidence.toFixed(3)),
      modelVersion: c.detection.modelVersion,
      geometry: {
        type: 'Polygon',
        coordinates: [c.detection.polygon.ring.map((p) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))])],
      },
      areaKm2: Number(shape.areaKm2.toFixed(2)),
      lengthKm: Number(shape.majorAxisKm.toFixed(2)),
      elongation: Number(shape.elongation.toFixed(2)),
      orientationDeg: Number(shape.orientationDeg.toFixed(1)),
    },
    estimatedVolumeM3: c.estimatedVolumeM3,
    suspects: c.candidateMmsis.slice(0, 3).map((m) => {
      const v = world.vesselsByMmsi.get(m);
      return v ? { mmsi: v.mmsi, imo: v.imo, name: v.name, flag: v.flag, type: v.type, priorOffences: v.priorOffences } : { mmsi: m };
    }),
    caveat: 'Attribution is a prioritisation score derived from spatio-temporal correlation with AIS. It is not evidence of discharge. Physical sampling and forensic fingerprint matching are required before enforcement.',
  }, null, 2);
}
