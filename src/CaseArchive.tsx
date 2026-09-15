import { useEffect, useMemo, useState } from 'react';
import {
  Archive, FileText, Lock, Download, ShieldCheck, Clock, Hash, Info,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import {
  Badge, Button, Tier, StatusBadge, KeyValue, Tabs, DataTable, SearchInput, Select,
  InfoBanner, EmptyState, ExportButton, downloadCsv, triggerDownload, StatCard, type Column,
} from './components/ui';
import { analysePolygon } from './lib/geo';
import { MODEL_METRICS } from './engine/detection';
import { DEFAULT_WEIGHTS } from './engine/attribution';
import type { AuditEntry, SpillCase } from './data/types';

/**
 * Case archive and audit trail.
 *
 * Closed cases move here rather than disappearing. The chain of custody — every model
 * version, every score, every human decision, with timestamps — is preserved because an
 * attribution may have to be defended months after the analyst has moved on.
 */
export default function CaseArchive() {
  const { world, now, getAnalysis, navigate, consumeSection, revision } = useStore();
  const [tab, setTab] = useState('archive');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [yearFilter, setYearFilter] = useState('all');
  const [auditQuery, setAuditQuery] = useState('');
  const [auditCategory, setAuditCategory] = useState('all');
  const [auditActor, setAuditActor] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const s = consumeSection();
    if (s === 'audit') setTab('audit');
  }, [consumeSection]);

  const archived = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.cases
      .filter((c) => {
        if (q && !`${c.id} ${c.subRegion} ${c.region} ${c.assignedTo} ${c.status}`.toLowerCase().includes(q)) return false;
        if (statusFilter !== 'all' && c.status !== statusFilter) return false;
        if (yearFilter !== 'all' && new Date(c.detection.acquiredAt).getUTCFullYear() !== Number(yearFilter)) return false;
        return true;
      })
      .sort((a, b) => b.detection.acquiredAt - a.detection.acquiredAt);
  }, [world.cases, query, statusFilter, yearFilter, revision]);

  const audit = useMemo(() => {
    const q = auditQuery.trim().toLowerCase();
    return world.audit.filter((e) => {
      if (q && !`${e.action} ${e.target} ${e.detail} ${e.actor}`.toLowerCase().includes(q)) return false;
      if (auditCategory !== 'all' && e.category !== auditCategory) return false;
      if (auditActor !== 'all' && e.actor !== auditActor) return false;
      return true;
    });
  }, [world.audit, auditQuery, auditCategory, auditActor, revision]);

  const actors = useMemo(() => Array.from(new Set(world.audit.map((e) => e.actor))).sort(), [world.audit, revision]);
  const active = world.cases.find((c) => c.id === selected) ?? null;
  const activeAnalysis = active ? getAnalysis(active.id) : null;

  const caseColumns: Column<SpillCase>[] = [
    { key: 'id', header: 'Case', width: '130px', value: (c) => c.id, render: (c) => <span className="font-mono font-bold text-gray-900">{c.id}</span> },
    { key: 'tier', header: 'Tier', width: '62px', align: 'center', value: (c) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[c.tier]), render: (c) => <Tier tier={c.tier} /> },
    { key: 'loc', header: 'Location', value: (c) => c.subRegion, render: (c) => <span className="text-gray-700">{c.subRegion}</span> },
    {
      key: 'detected', header: 'Detected (UTC)', width: '136px', value: (c) => c.detection.acquiredAt,
      render: (c) => <span className="font-mono text-gray-700">{fmt.utc(c.detection.acquiredAt)}</span>,
    },
    { key: 'sensor', header: 'Sensor', width: '96px', value: (c) => c.detection.sensor },
    { key: 'status', header: 'Outcome', width: '146px', value: (c) => c.status, render: (c) => <StatusBadge status={c.status} /> },
    { key: 'analyst', header: 'Analyst', width: '92px', value: (c) => c.assignedTo },
    {
      key: 'events', header: 'Audit events', width: '94px', align: 'center',
      value: (c) => world.audit.filter((e) => e.target === c.id).length,
      render: (c) => <Badge tone="gray">{world.audit.filter((e) => e.target === c.id).length}</Badge>,
    },
  ];

  const auditColumns: Column<AuditEntry>[] = [
    {
      key: 't', header: 'Timestamp (UTC)', width: '140px', value: (e) => e.t,
      render: (e) => <div><div className="font-mono text-gray-800">{fmt.utc(e.t)}</div><div className="text-[9px] text-gray-400">{fmt.ago(e.t, now)}</div></div>,
    },
    {
      key: 'actor', header: 'Actor', width: '160px', value: (e) => e.actor,
      render: (e) => <div><div className="font-semibold text-gray-900">{e.actor}</div><div className="text-[9.5px] text-gray-500">{e.role}</div></div>,
    },
    { key: 'action', header: 'Action', width: '190px', value: (e) => e.action, render: (e) => <span className="font-semibold text-gray-800">{e.action}</span> },
    {
      key: 'target', header: 'Target', width: '150px', value: (e) => e.target,
      render: (e) => world.cases.some((c) => c.id === e.target)
        ? <button onClick={() => navigate({ tab: 'Investigation', caseId: e.target })} className="font-mono text-blue-600 hover:underline">{e.target}</button>
        : <span className="font-mono text-gray-600 text-[10px]">{e.target}</span>,
    },
    { key: 'detail', header: 'Detail', value: (e) => e.detail, render: (e) => <span className="text-gray-600">{e.detail}</span> },
    {
      key: 'cat', header: 'Category', width: '108px', value: (e) => e.category,
      render: (e) => <Badge tone={
        e.category === 'Detection' ? 'blue' : e.category === 'Attribution' ? 'violet'
        : e.category === 'Enforcement' ? 'red' : e.category === 'Dispatch' ? 'amber'
        : e.category === 'Alert' ? 'teal' : 'gray'}>{e.category}</Badge>,
    },
  ];

  const exportChainOfCustody = (c: SpillCase) => {
    const a = getAnalysis(c.id);
    const shape = analysePolygon(c.detection.polygon.ring);
    const events = world.audit.filter((e) => e.target === c.id).sort((x, y) => x.t - y.t);
    const L: string[] = [];
    L.push('='.repeat(72), `CHAIN OF CUSTODY RECORD — ${c.id}`, '='.repeat(72), '');
    L.push('CLASSIFICATION: RESTRICTED — For Official Use');
    L.push(`Exported: ${fmt.utc(now)}`, '');
    L.push('1. ACQUISITION', '-'.repeat(72));
    L.push(`  Scene identifier : ${c.detection.sceneId}`);
    L.push(`  Platform         : ${c.detection.sensor}`);
    L.push(`  Mode             : ${c.detection.mode}`);
    L.push(`  Polarisation     : ${c.detection.polarisation}`);
    L.push(`  Resolution       : ${c.detection.resolutionM} m`);
    L.push(`  Incidence angle  : ${c.detection.incidenceAngleDeg}°`);
    L.push(`  Acquired at      : ${fmt.utc(c.detection.acquiredAt)}`, '');
    L.push('2. DETECTION', '-'.repeat(72));
    L.push(`  Model version    : ${c.detection.modelVersion}`);
    L.push(`  Architecture     : ${MODEL_METRICS.architecture}`);
    L.push(`  Raw class scores : oil ${c.detection.classProbabilities.oil.toFixed(3)}, ` +
           `look-alike ${c.detection.classProbabilities.lookalike.toFixed(3)}, sea ${c.detection.classProbabilities.sea.toFixed(3)}`);
    if (a) {
      L.push(`  Adjusted conf.   : ${fmt.pct(a.assessment.confidence)} (${a.assessment.verdict})`, '');
      L.push('  Cross-checks applied:');
      for (const ch of a.assessment.checks) {
        L.push(`    [${ch.passed ? 'PASS' : 'FAIL'}] ${ch.name} (w ${ch.weight.toFixed(2)})`);
        L.push(`           ${ch.detail}`);
      }
      L.push('');
    }
    L.push('3. GEOMETRY', '-'.repeat(72));
    L.push(`  Centroid    : ${shape.centroid.lat.toFixed(5)}N ${shape.centroid.lon.toFixed(5)}E`);
    L.push(`  Area        : ${shape.areaKm2.toFixed(3)} km²`);
    L.push(`  Perimeter   : ${shape.perimeterKm.toFixed(2)} km`);
    L.push(`  Major axis  : ${shape.majorAxisKm.toFixed(3)} km`);
    L.push(`  Elongation  : ${shape.elongation.toFixed(3)}`);
    L.push(`  Orientation : ${shape.orientationDeg.toFixed(1)}°`);
    L.push(`  Vertices    : ${c.detection.polygon.ring.length}`, '');
    if (a) {
      L.push('4. HINDCAST', '-'.repeat(72));
      L.push(`  Method       : Lagrangian particle tracking (current + Stokes + windage)`);
      L.push(`  Integration  : ${c.hindcastHours} h backward, ${a.hindcast.params.stepMinutes} min timestep`);
      L.push(`  Particles    : ${a.hindcast.params.particles}   Ensemble: ${a.hindcast.ensemble.length} members`);
      L.push(`  Windage      : ${fmt.pct(a.hindcast.params.windage)}   Diffusivity: ${a.hindcast.params.diffusivity} m²/s`);
      L.push(`  Origin       : ${a.hindcast.estimatedOrigin.lat.toFixed(5)}N ${a.hindcast.estimatedOrigin.lon.toFixed(5)}E`);
      L.push(`  Origin time  : ${fmt.utc(a.hindcast.estimatedTime)}`);
      L.push(`  Uncertainty  : ± ${a.hindcast.uncertaintyRadiusKm.toFixed(2)} km, ± ${a.hindcast.timeWindowHours.toFixed(2)} h`, '');
      L.push('5. ATTRIBUTION', '-'.repeat(72));
      L.push(`  Weights      : proximity ${DEFAULT_WEIGHTS.proximity}, temporality ${DEFAULT_WEIGHTS.temporality}, ` +
             `trajectory ${DEFAULT_WEIGHTS.trajectory}, behaviour ${DEFAULT_WEIGHTS.behaviour}, prior ${DEFAULT_WEIGHTS.vesselPrior}`);
      L.push(`  Window       : ${fmt.utc(a.windowStart)} → ${fmt.utc(a.windowEnd)}`);
      L.push(`  Search radius: ${a.searchRadiusKm.toFixed(1)} km`);
      L.push(`  Verdict      : ${a.verdict.band} — ${a.verdict.label}`, '');
      for (const s of a.ranked) {
        const v = world.vesselsByMmsi.get(s.mmsi);
        L.push(`  Rank ${s.rank}: ${v?.name ?? s.mmsi}  (MMSI ${s.mmsi}, IMO ${v?.imo ?? '—'}, flag ${v?.flag ?? '—'})`);
        L.push(`    Total ${(s.total * 100).toFixed(1)} = prox ${(s.proximity * 100).toFixed(0)} · temp ${(s.temporality * 100).toFixed(0)} · ` +
               `traj ${(s.trajectory * 100).toFixed(0)} · behav ${(s.behaviour * 100).toFixed(0)} · prior ${(s.vesselPrior * 100).toFixed(0)}`);
        L.push(`    CPA ${s.cpaKm.toFixed(2)} km at ${fmt.utc(s.cpaTime)} (Δt ${s.deltaTimeMin.toFixed(0)} min)`);
        if (s.darkDuringWindow) L.push(`    AIS DARK for ${s.darkMinutes} minutes within the window`);
        for (const r of s.reasons) L.push(`    - ${r}`);
        L.push('');
      }
      if (a.excluded.length) {
        L.push('  Excluded from scoring:');
        for (const e of a.excluded) L.push(`    ${e.name} (${e.mmsi}) — ${e.reason}`);
        L.push('');
      }
    }
    L.push('6. HUMAN DECISION TRAIL', '-'.repeat(72));
    for (const e of events) {
      L.push(`  ${fmt.utc(e.t)}  ${e.actor} (${e.role})`);
      L.push(`    ${e.action}: ${e.detail}`);
    }
    L.push('');
    if (c.lookalikeReason) {
      L.push('7. RECLASSIFICATION', '-'.repeat(72));
      L.push(`  ${c.lookalikeReason}`, '');
    }
    L.push('='.repeat(72));
    L.push('This record preserves the model versions, parameters and scores exactly as they stood at');
    L.push('the time of analysis. Attribution scores are a prioritisation tool derived from');
    L.push('spatio-temporal correlation and do not constitute evidence of discharge.');
    L.push('='.repeat(72));
    triggerDownload(`${c.id}-chain-of-custody.txt`, L.join('\n'));
  };

  const stats = useMemo(() => ({
    total: world.cases.length,
    closed: world.cases.filter((c) => c.status === 'Closed').length,
    dismissed: world.cases.filter((c) => c.status === 'Dismissed — Look-alike').length,
    events: world.audit.length,
  }), [world.cases, world.audit, revision]);

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="bg-slate-700 text-white p-1.5 rounded"><Archive className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Case archive &amp; audit trail</h2>
            <p className="text-[11px] text-gray-500">Read-only historical record with full chain of custody</p>
          </div>
        </div>
        <Badge tone="slate"><Lock className="w-2.5 h-2.5" /> Immutable record</Badge>
      </div>

      <div className="bg-white border-b border-gray-200 px-3 py-2 grid grid-cols-4 gap-3 flex-shrink-0">
        <StatCard icon={<Archive className="w-5 h-5" />} title="Cases on record" value={stats.total} trend="including dismissed detections" />
        <StatCard icon={<ShieldCheck className="w-5 h-5" />} title="Concluded" value={stats.closed} trend="with an enforcement outcome" accent="green" />
        <StatCard icon={<Info className="w-5 h-5" />} title="Dismissed" value={stats.dismissed} trend="retained to keep error rates measurable" />
        <StatCard icon={<Hash className="w-5 h-5" />} title="Audit events" value={fmt.num(stats.events)} trend="timestamped actions" />
      </div>

      <Tabs active={tab} onChange={setTab} className="bg-white px-3 flex-shrink-0" tabs={[
        { id: 'archive', label: 'Case archive', count: archived.length },
        { id: 'audit', label: 'Audit trail', count: audit.length },
      ]} />

      {tab === 'archive' && (
        <div className="flex-1 min-h-0 flex gap-3 p-3">
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex gap-2">
              <SearchInput value={query} onChange={setQuery} placeholder="Case ID, location, analyst…" className="flex-1" />
              <Select value={statusFilter} onChange={setStatusFilter}
                options={[{ value: 'all', label: 'All outcomes' }, ...Array.from(new Set(world.cases.map((c) => c.status))).map((s) => ({ value: s, label: s }))]} />
              <Select value={yearFilter} onChange={setYearFilter}
                options={[{ value: 'all', label: 'All years' }, ...Array.from(new Set(world.cases.map((c) => new Date(c.detection.acquiredAt).getUTCFullYear()))).map((y) => ({ value: String(y), label: String(y) }))]} />
              <ExportButton onExport={() => downloadCsv('oceanwatch-case-archive.csv', caseColumns.filter((c) => c.value), archived)} />
            </div>
            <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
              <DataTable columns={caseColumns} rows={archived} rowKey={(c) => c.id} dense
                selectedId={selected} onRowClick={(c) => setSelected(c.id === selected ? null : c.id)}
                initialSort={{ key: 'detected', dir: 'desc' }} />
            </div>
          </div>

          <div className="w-[360px] flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
            {!active || !activeAnalysis ? (
              <EmptyState icon={<FileText className="w-10 h-10" />} title="No case selected"
                body="Select an archived case to view its chain-of-custody record." />
            ) : (
              <>
                <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <h3 className="font-bold text-gray-900 text-sm font-mono">{active.id}</h3>
                      <p className="text-[10px] text-gray-500">{active.subRegion}</p>
                    </div>
                    <Tier tier={active.tier} />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  <KeyValue cols={2} items={[
                    ['Outcome', active.status],
                    ['Workflow', active.workflowStage],
                    ['Detected', fmt.utcShort(active.detection.acquiredAt)],
                    ['Sensor', active.detection.sensor],
                    ['Confidence', fmt.pct(activeAnalysis.assessment.confidence)],
                    ['Verdict', activeAnalysis.assessment.verdict],
                    ['Analyst', active.assignedTo],
                    ['Model', active.detection.modelVersion],
                  ]} />

                  {active.lookalikeReason && (
                    <InfoBanner tone="amber">
                      <b>Reclassified as a look-alike.</b> {active.lookalikeReason}
                    </InfoBanner>
                  )}

                  <div>
                    <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Attribution as recorded</p>
                    {activeAnalysis.ranked.length === 0 ? (
                      <p className="text-[10.5px] text-gray-500">No candidate vessel — suspected dark-vessel event.</p>
                    ) : (
                      <div className="space-y-1">
                        {activeAnalysis.ranked.slice(0, 4).map((s) => {
                          const v = world.vesselsByMmsi.get(s.mmsi);
                          return (
                            <div key={s.mmsi} className="flex items-center gap-2 text-[10.5px] border-b border-gray-100 pb-1">
                              <span className="w-4 font-black text-gray-400">{s.rank}</span>
                              <span className="flex-1 font-semibold text-gray-800 truncate">{v?.name ?? s.mmsi}</span>
                              {s.darkDuringWindow && <Badge tone="red">DARK</Badge>}
                              <span className="font-mono font-bold text-gray-900">{(s.total * 100).toFixed(0)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-[9.5px] text-gray-500 mt-1.5">
                      Verdict: <b>{activeAnalysis.verdict.band}</b> — {activeAnalysis.verdict.label}
                    </p>
                  </div>

                  <div>
                    <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5">
                      <Clock className="w-3 h-3" /> Decision trail
                    </p>
                    <div className="space-y-1.5">
                      {world.audit.filter((e) => e.target === active.id).sort((a, b) => a.t - b.t).map((e) => (
                        <div key={e.id} className="border-l-2 border-gray-200 pl-2">
                          <p className="text-[9.5px] font-mono text-gray-400">{fmt.utc(e.t)}</p>
                          <p className="text-[10.5px] font-semibold text-gray-900">{e.action}</p>
                          <p className="text-[10px] text-gray-600 leading-snug">{e.detail}</p>
                          <p className="text-[9px] text-gray-400">{e.actor} · {e.role}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="p-2.5 border-t border-gray-200 flex gap-2">
                  <Button size="sm" className="flex-1 justify-center" onClick={() => navigate({ tab: 'Investigation', caseId: active.id })}>
                    Reopen in workspace
                  </Button>
                  <Button size="sm" variant="primary" className="flex-1 justify-center" onClick={() => exportChainOfCustody(active)} icon={<Download className="w-3 h-3" />}>
                    Chain of custody
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
          <div className="flex gap-2">
            <SearchInput value={auditQuery} onChange={setAuditQuery} placeholder="Action, target, actor or detail…" className="flex-1" />
            <Select value={auditCategory} onChange={setAuditCategory}
              options={[{ value: 'all', label: 'All categories' }, ...Array.from(new Set(world.audit.map((e) => e.category))).map((c) => ({ value: c, label: c }))]} />
            <Select value={auditActor} onChange={setAuditActor}
              options={[{ value: 'all', label: 'All actors' }, ...actors.map((a) => ({ value: a, label: a }))]} />
            <ExportButton onExport={() => downloadCsv('oceanwatch-audit-trail.csv', auditColumns.filter((c) => c.value), audit)} label="Export audit" />
          </div>
          <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
            <DataTable columns={auditColumns} rows={audit} rowKey={(e) => e.id} dense
              initialSort={{ key: 't', dir: 'desc' }}
              empty="No audit events match the current filters." />
          </div>
          <InfoBanner tone="blue" icon={<Lock className="w-3.5 h-3.5" />}>
            Every model run, score and human decision is appended here and never edited. Values are preserved
            as they stood at the time — if the scoring weights change later, historical records keep the
            weights that actually produced them.
          </InfoBanner>
        </div>
      )}
    </main>
  );
}
