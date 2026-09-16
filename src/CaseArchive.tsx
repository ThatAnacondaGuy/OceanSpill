import { useEffect, useMemo, useState } from 'react';
import {
  Archive, FileText, Lock, Download, Clock, Hash, BookOpen, Scale, ExternalLink,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { legalSummary } from './data/world';
import { chainOfCustodyPdf } from './data/server';
import {
  Badge, Button, Tier, StatusBadge, KeyValue, Tabs, DataTable, SearchInput, Select,
  InfoBanner, EmptyState, ExportButton, downloadCsv, triggerDownload, StatCard, ProvenanceBadge, type Column,
} from './components/ui';
import { MapView, type MapMarker } from './components/MapView';
import { analysePolygon } from './lib/geo';
import { MODEL_STATUS, modelScoreLine } from './engine/detection';
import type { AuditEntry, HistoricalIncident, SpillCase } from './data/types';

/**
 * Case archive and audit trail.
 *
 * Closed cases move here rather than disappearing. The chain of custody — every model
 * version, every score, every human decision, with timestamps — is preserved because an
 * attribution may have to be defended months after the analyst has moved on.
 */
export default function CaseArchive() {
  const { world, now, getAnalysis, navigate, consumeSection, revision, weights, notify, serverMode } = useStore();
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
    if (s === 'audit' || s === 'historical') setTab(s);
  }, [consumeSection]);

  const archived = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.cases
      .filter((c) => {
        if (q && !`${c.id} ${c.title} ${c.subRegion} ${c.region} ${c.assignedTo} ${c.status}`.toLowerCase().includes(q)) return false;
        if (statusFilter !== 'all' && c.status !== statusFilter) return false;
        if (yearFilter !== 'all' && new Date(c.incidentTime).getUTCFullYear() !== Number(yearFilter)) return false;
        return true;
      })
      .sort((a, b) => b.incidentTime - a.incidentTime);
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
    {
      key: 'id', header: 'Case', value: (c) => c.title,
      render: (c) => <div><div className="font-bold text-gray-900">{c.title}</div><div className="text-[0.6875rem] font-mono text-gray-400">{c.id}</div></div>,
    },
    { key: 'tier', header: 'Tier', width: '62px', align: 'center', value: (c) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[c.tier]), render: (c) => <Tier tier={c.tier} /> },
    { key: 'loc', header: 'Location', width: '200px', value: (c) => c.subRegion, render: (c) => <span className="text-gray-700 text-[0.71875rem]">{c.subRegion}</span> },
    {
      key: 'detected', header: 'Incident', width: '130px', value: (c) => c.incidentTime,
      render: (c) => <span className="font-mono text-gray-700">{fmt.precise(c.incidentTime, c.facts.incident.timePrecision)}</span>,
    },
    { key: 'sources', header: 'Sources', width: '70px', align: 'center', value: (c) => c.facts.sources.length },
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
      render: (e) => <div><div className="font-mono text-gray-800">{fmt.utc(e.t)}</div><div className="text-[0.65625rem] text-gray-400">{fmt.ago(e.t, now)}</div></div>,
    },
    { key: 'prov', header: 'Record', width: '84px', value: (e) => e.provenance, render: (e) => <ProvenanceBadge p={e.provenance} /> },
    {
      key: 'actor', header: 'Actor', width: '160px', value: (e) => e.actor,
      render: (e) => <div><div className="font-semibold text-gray-900">{e.actor}</div><div className="text-[0.6875rem] text-gray-500">{e.role}</div></div>,
    },
    { key: 'action', header: 'Action', width: '190px', value: (e) => e.action, render: (e) => <span className="font-semibold text-gray-800">{e.action}</span> },
    {
      key: 'target', header: 'Target', width: '150px', value: (e) => e.target,
      render: (e) => world.cases.some((c) => c.id === e.target)
        ? <button onClick={() => navigate({ tab: 'Investigation', caseId: e.target })} className="font-mono text-blue-600 hover:underline">{e.target}</button>
        : <span className="font-mono text-gray-600 text-[0.6875rem]">{e.target}</span>,
    },
    { key: 'detail', header: 'Detail', value: (e) => e.detail, render: (e) => e.detail ? <span className="text-gray-600">{e.detail}</span> : <span className="text-gray-400">Case timeline entry</span> },
    {
      key: 'cat', header: 'Category', width: '108px', value: (e) => e.category,
      render: (e) => <Badge tone={
        e.category === 'Detection' ? 'blue' : e.category === 'Attribution' ? 'violet'
        : e.category === 'Enforcement' ? 'red' : e.category === 'Dispatch' ? 'amber'
        : e.category === 'Alert' ? 'teal' : 'gray'}>{e.category}</Badge>,
    },
  ];

  const exportChainOfCustody = (c: SpillCase) => {
    if (serverMode) {
      // The server builds this one from its own artifacts and audit trail and signs it, so the
      // document can be checked later rather than taken on trust.
      chainOfCustodyPdf(c.id)
        .then((filename) => notify({ kind: 'success', title: 'Signed record exported', body: filename }))
        .catch((e: Error) => notify({ kind: 'error', title: 'Record not exported', body: e.message }));
      return;
    }
    const a = getAnalysis(c.id);
    const shape = analysePolygon(c.detection.polygon.ring);
    const events = world.audit.filter((e) => e.target === c.id).sort((x, y) => x.t - y.t);
    const L: string[] = [];
    L.push('='.repeat(72), `CHAIN OF CUSTODY RECORD — ${c.id}`, '='.repeat(72), '');
    L.push('CLASSIFICATION: RESTRICTED — For Official Use');
    L.push(`Exported: ${fmt.utc(now)}`, '');
    L.push(`Case             : ${c.title}`);
    L.push('NOTE: Retrospective replay of a real incident. Vessel tracks are synthetic where real AIS was unavailable.', '');
    L.push('1. SOURCE RECORD', '-'.repeat(72));
    L.push(`  Incident time    : ${fmt.precise(c.incidentTime, c.facts.incident.timePrecision)} (precision: ${c.facts.incident.timePrecision})`);
    L.push(`  Position         : ${c.facts.incident.position.lat.toFixed(4)}N ${c.facts.incident.position.lon.toFixed(4)}E ± ${c.facts.incident.positionPrecisionKm} km (${c.facts.incident.positionSource})`);
    L.push(`  Official finding : ${c.facts.officialFindings}`);
    L.push('  Sources:');
    for (const src of c.facts.sources) L.push(`    - ${src.title}`, `      ${src.url}`);
    L.push('');
    L.push('2. OBSERVATION AND DETECTION', '-'.repeat(72));
    L.push(`  Reference obs.   : ${fmt.utc(c.detection.acquiredAt)} (${c.detection.observationSource})`);
    L.push(`  Geometry basis   : ${c.detection.geometryBasis}`);
    for (const g of c.detection.geometryAssumptions) L.push(`    assumption: ${g}`);
    L.push(`  SAR catalogue    : ${c.detection.scenes.length} scene(s)`);
    for (const sc of c.detection.scenes) L.push(`    ${sc.name} (${sc.provider}, ${fmt.utc(sc.start)}${sc.coversIncident ? ', covers incident' : ''})`);
    L.push(`  Segmentation     : ${MODEL_STATUS.trained ? `${MODEL_STATUS.version} (${modelScoreLine(MODEL_STATUS.models.sarSegmentation)})` : 'not run (no trained model yet)'}`);
    if (c.detection.classProbabilities) {
      const cp = c.detection.classProbabilities;
      L.push(`  Raw class scores : oil ${cp.oil.toFixed(3)}, look-alike ${cp.lookalike.toFixed(3)}, sea ${cp.sea.toFixed(3)}`);
    }
    if (a) {
      L.push(`  Detection basis  : ${a.assessment.confidenceBasis} (${a.assessment.verdict})`, '');
      L.push('  Cross-checks applied:');
      for (const ch of a.assessment.checks) {
        L.push(`    [${ch.status.toUpperCase()}] ${ch.name} (w ${ch.weight.toFixed(2)})`);
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
      L.push(`  Wind forcing : ${a.sampler.sources.wind}`);
      L.push(`  Current      : ${a.sampler.sources.current}`);
      L.push(`  Integration  : ${c.hindcastHours} h backward, ${a.hindcast.params.stepMinutes} min timestep`);
      L.push(`  Particles    : ${a.hindcast.params.particles}   Ensemble: ${a.hindcast.ensemble.length} members`);
      L.push(`  Windage      : ${fmt.pct(a.hindcast.params.windage)}   Diffusivity: ${a.hindcast.params.diffusivity} m²/s`);
      L.push(`  Origin       : ${a.hindcast.estimatedOrigin.lat.toFixed(5)}N ${a.hindcast.estimatedOrigin.lon.toFixed(5)}E`);
      L.push(`  Origin time  : ${fmt.utc(a.hindcast.estimatedTime)}`);
      L.push(`  Uncertainty  : ± ${a.hindcast.uncertaintyRadiusKm.toFixed(2)} km, ± ${a.hindcast.timeWindowHours.toFixed(2)} h`, '');
      L.push('5. ATTRIBUTION', '-'.repeat(72));
      L.push(`  AIS provider : ${c.aisProvider}`);
      L.push(`  Weights      : proximity ${weights.proximity}, temporality ${weights.temporality}, ` +
             `trajectory ${weights.trajectory}, behaviour ${weights.behaviour}, prior ${weights.vesselPrior}`);
      L.push(`  Window       : ${fmt.utc(a.windowStart)} → ${fmt.utc(a.windowEnd)}`);
      L.push(`  Search radius: ${a.searchRadiusKm.toFixed(1)} km`);
      L.push(`  Verdict      : ${a.verdict.band} — ${a.verdict.label}`, '');
      for (const s of a.ranked) {
        const v = world.vesselsByMmsi.get(s.mmsi);
        L.push(`  Rank ${s.rank}: ${v?.name ?? s.mmsi}  (${v ? fmt.vesselId(v) : s.mmsi}, flag ${v?.flag ?? '—'}, ${v?.provenance === 'real' ? 'real vessel, synthetic track' : 'SYNTHETIC vessel'})`);
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
      L.push(`  ${fmt.utc(e.t)}  ${e.actor} (${e.role}) [${e.provenance}]`);
      L.push(`    ${e.action}: ${e.detail}`);
    }
    L.push('');
    if (c.lookalikeReason) {
      L.push('7. RECLASSIFICATION', '-'.repeat(72));
      L.push(`  ${c.lookalikeReason}`, '');
    }
    L.push('='.repeat(72));
    L.push('This record lists every input with its provenance. Attribution scores are a prioritisation');
    L.push('tool derived from spatio-temporal correlation and do not constitute evidence of discharge.');
    if (c.warnings.length) {
      L.push('', 'Data warnings:');
      for (const w of c.warnings) L.push(`  - ${w}`);
    }
    L.push('='.repeat(72));
    triggerDownload(`${c.id}-chain-of-custody.txt`, L.join('\n'));
  };

  const stats = useMemo(() => ({
    total: world.cases.length,
    historical: world.historical.length,
    legal: legalSummary(world).incidents,
    events: world.audit.length,
  }), [world.cases, world.audit, world.historical, revision]);

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-y-auto lg:overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0 flex-wrap gap-y-2">
        <div className="flex items-center gap-2.5">
          <div className="bg-slate-700 text-white p-1.5 rounded"><Archive className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Case archive &amp; audit trail</h2>
            <p className="text-[0.75rem] text-gray-500">Case records, the historical incident register and the audit trail</p>
          </div>
        </div>
        <Badge tone="slate"><Lock className="w-2.5 h-2.5" /> Append-only audit trail</Badge>
      </div>

      <div className="bg-white border-b border-gray-200 px-3 py-2 grid grid-cols-2 lg:grid-cols-4 gap-4 flex-shrink-0">
        <StatCard icon={<Archive className="w-5 h-5" />} title="Analysed cases" value={stats.total} trend="recorded incidents" />
        <StatCard icon={<BookOpen className="w-5 h-5" />} title="Historical register" value={stats.historical} trend="Indian incidents since 1970" onClick={() => setTab('historical')} accent="amber" />
        <StatCard icon={<Scale className="w-5 h-5" />} title="Incidents with legal action" value={stats.legal} trend="court, tribunal, police or regulator" accent="red" />
        <StatCard icon={<Hash className="w-5 h-5" />} title="Audit events" value={fmt.num(stats.events)} trend="record, pipeline and session" />
      </div>

      <Tabs active={tab} onChange={setTab} className="bg-white px-3 flex-shrink-0" tabs={[
        { id: 'archive', label: 'Case archive', count: archived.length },
        { id: 'historical', label: 'Historical register', count: world.historical.length },
        { id: 'audit', label: 'Audit trail', count: audit.length },
      ]} />

      {tab === 'archive' && (
        <div className="flex-none lg:flex-1 lg:min-h-0 flex flex-col lg:flex-row gap-4 p-4">
          <div className="flex-none h-[70vh] lg:h-auto lg:flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex gap-2">
              <SearchInput value={query} onChange={setQuery} placeholder="Case ID, location, analyst…" className="flex-1" />
              <Select value={statusFilter} onChange={setStatusFilter}
                options={[{ value: 'all', label: 'All outcomes' }, ...Array.from(new Set(world.cases.map((c) => c.status))).map((s) => ({ value: s, label: s }))]} />
              <Select value={yearFilter} onChange={setYearFilter}
                options={[{ value: 'all', label: 'All years' }, ...Array.from(new Set(world.cases.map((c) => new Date(c.incidentTime).getUTCFullYear()))).sort((a, b) => b - a).map((y) => ({ value: String(y), label: String(y) }))]} />
              <ExportButton onExport={() => downloadCsv('oceanspill-case-archive.csv', caseColumns.filter((c) => c.value), archived)} />
            </div>
            <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
              <DataTable columns={caseColumns} rows={archived} rowKey={(c) => c.id} dense
                selectedId={selected} onRowClick={(c) => setSelected(c.id === selected ? null : c.id)}
                initialSort={{ key: 'detected', dir: 'desc' }} />
            </div>
          </div>

          <div className="w-full lg:w-[320px] xl:w-[360px] h-[80vh] lg:h-auto flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
            {!active || !activeAnalysis ? (
              <EmptyState icon={<FileText className="w-10 h-10" />} title="No case selected"
                body="Select an archived case to view its chain-of-custody record." />
            ) : (
              <>
                <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <h3 className="font-bold text-gray-900 text-sm">{active.title}</h3>
                      <p className="text-[0.6875rem] font-mono text-gray-400">{active.id}</p>
                      <p className="text-[0.6875rem] text-gray-500">{active.subRegion}</p>
                    </div>
                    <Tier tier={active.tier} />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <KeyValue cols={2} items={[
                    ['Outcome', active.status],
                    ['Workflow', active.workflowStage],
                    ['Incident', fmt.precise(active.incidentTime, active.facts.incident.timePrecision)],
                    ['Observed by', active.detection.observationSource],
                    ['Detection', fmt.confidence(active)],
                    ['Verdict', activeAnalysis.assessment.verdict],
                    ['SAR scenes', String(active.detection.scenes.length)],
                    ['Segmentation', active.detection.modelVersion ?? 'Not run'],
                  ]} />
                  <p className="text-[0.6875rem] text-gray-600 leading-normal">{active.facts.officialFindings}</p>
                  {active.facts.legal?.map((l) => (
                    <div key={l.action + l.authority} className="bg-amber-50 border border-amber-200 rounded p-2">
                      <p className="text-[0.71875rem] font-bold text-amber-900">{l.action}{l.amountInr ? ` · ${fmt.inr(l.amountInr)}` : ''}</p>
                      <p className="text-[0.6875rem] text-amber-800">{l.authority} → {l.party}</p>
                    </div>
                  ))}

                  {active.lookalikeReason && (
                    <InfoBanner tone="amber">
                      <b>Reclassified as a look-alike.</b> {active.lookalikeReason}
                    </InfoBanner>
                  )}

                  <div>
                    <p className="text-[0.6875rem] font-bold text-gray-600 uppercase mb-1.5">Attribution as recorded</p>
                    {activeAnalysis.ranked.length === 0 ? (
                      <p className="text-[0.71875rem] text-gray-500">No candidate vessel — suspected dark-vessel event.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {activeAnalysis.ranked.slice(0, 4).map((s) => {
                          const v = world.vesselsByMmsi.get(s.mmsi);
                          return (
                            <div key={s.mmsi} className="flex items-center gap-2 text-[0.71875rem] border-b border-gray-100 pb-1">
                              <span className="w-4 font-black text-gray-400">{s.rank}</span>
                              <span className="flex-1 font-semibold text-gray-800 truncate">{v?.name ?? s.mmsi}</span>
                              {v && <ProvenanceBadge p={v.provenance} />}
                              {s.darkDuringWindow && <Badge tone="red">DARK</Badge>}
                              <span className="font-mono font-bold text-gray-900">{(s.total * 100).toFixed(0)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-[0.6875rem] text-gray-500 mt-1.5">
                      Verdict: <b>{activeAnalysis.verdict.label}</b>
                    </p>
                  </div>

                  <div>
                    <p className="text-[0.6875rem] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5">
                      <Clock className="w-3 h-3" /> Decision trail
                    </p>
                    <div className="space-y-2">
                      {world.audit.filter((e) => e.target === active.id).sort((x, y) => x.t - y.t).map((e) => (
                        <div key={e.id} className="border-l-2 border-gray-200 pl-2">
                          <p className="text-[0.6875rem] font-mono text-gray-400 flex items-center gap-1">{fmt.utc(e.t)} <ProvenanceBadge p={e.provenance} /></p>
                          <p className="text-[0.71875rem] font-semibold text-gray-900">{e.action}</p>
                          {e.detail && <p className="text-[0.6875rem] text-gray-600 leading-normal">{e.detail}</p>}
                          <p className="text-[0.65625rem] text-gray-400">{e.actor} · {e.role}</p>
                        </div>
                      ))}
                    </div>
                    {active.facts.sources.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-gray-200">
                        <p className="text-[0.6875rem] font-bold text-gray-600 uppercase mb-1">Sources for this case</p>
                        <ul className="space-y-1">
                          {active.facts.sources.map((src) => (
                            <li key={src.url}>
                              <a href={src.url} target="_blank" rel="noreferrer" className="text-[0.71875rem] text-blue-600 hover:underline">{src.title}</a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
                <div className="p-3 border-t border-gray-200 flex gap-2">
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

      {tab === 'historical' && <HistoricalRegister />}

      {tab === 'audit' && (
        <div className="h-[85vh] flex-none lg:h-auto lg:flex-1 lg:min-h-0 flex flex-col p-4 gap-2">
          <div className="flex gap-2">
            <SearchInput value={auditQuery} onChange={setAuditQuery} placeholder="Action, target, actor or detail…" className="flex-1" />
            <Select value={auditCategory} onChange={setAuditCategory}
              options={[{ value: 'all', label: 'All categories' }, ...Array.from(new Set(world.audit.map((e) => e.category))).map((c) => ({ value: c, label: c }))]} />
            <Select value={auditActor} onChange={setAuditActor}
              options={[{ value: 'all', label: 'All actors' }, ...actors.map((a) => ({ value: a, label: a }))]} />
            <ExportButton onExport={() => downloadCsv('oceanspill-audit-trail.csv', auditColumns.filter((c) => c.value), audit)} label="Export audit" />
          </div>
          <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
            <DataTable columns={auditColumns} rows={audit} rowKey={(e) => e.id} dense
              initialSort={{ key: 't', dir: 'desc' }}
              empty="No audit events match the current filters." />
          </div>
          <InfoBanner tone="blue" icon={<Lock className="w-3.5 h-3.5" />}>
            Entries come from published incident timelines, data updates and actions taken here (marked SESSION). Session actions are kept in this browser.
          </InfoBanner>
        </div>
      )}
    </main>
  );
}

function HistoricalRegister() {
  const { world, navigate } = useStore();
  const [query, setQuery] = useState('');
  const [decade, setDecade] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);

  const decades = useMemo(() => Array.from(new Set(world.historical.filter((h) => /^\d{4}/.test(h.date)).map((h) => `${h.date.slice(0, 3)}0s`))).sort().reverse(), [world.historical]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.historical.filter((h) => {
      if (q && !`${h.name} ${h.location} ${h.oil ?? ''} ${h.cause ?? ''}`.toLowerCase().includes(q)) return false;
      if (decade !== 'all' && `${h.date.slice(0, 3)}0s` !== decade) return false;
      return true;
    });
  }, [world.historical, query, decade]);

  const columns: Column<HistoricalIncident>[] = [
    { key: 'date', header: 'Date', width: '84px', value: (h) => h.date, render: (h) => <span className="font-mono text-gray-700">{h.date}</span> },
    {
      key: 'name', header: 'Incident', value: (h) => h.name,
      render: (h) => (
        <div>
          <div className="font-bold text-gray-900 flex items-center gap-1.5">{h.name}{h.activeCaseId && <Badge tone="blue">Analysed</Badge>}</div>
          <div className="text-[0.6875rem] text-gray-500">{h.location}</div>
        </div>
      ),
    },
    { key: 'oil', header: 'Oil', width: '140px', value: (h) => h.oil ?? '', render: (h) => <span className="text-gray-700 text-[0.71875rem]">{h.oil ?? 'Not reported'}</span> },
    {
      key: 'tonnes', header: 'Released (t)', width: '96px', align: 'right', value: (h) => h.tonnes ?? -1,
      render: (h) => h.tonnes != null ? <span className="font-mono font-bold text-gray-900">{fmt.num(h.tonnes)}</span> : <span className="text-gray-400 text-[0.6875rem]">Not reported</span>,
    },
    { key: 'cause', header: 'Cause', width: '140px', value: (h) => h.cause ?? '', render: (h) => <span className="text-gray-600 text-[0.71875rem]">{h.cause ?? '—'}</span> },
    { key: 'legal', header: 'Legal', width: '60px', align: 'center', value: (h) => h.legal?.length ?? 0, render: (h) => h.legal?.length ? <Scale className="w-3.5 h-3.5 text-amber-600 mx-auto" /> : <span className="text-gray-300">—</span> },
  ];

  const markers = useMemo<MapMarker[]>(() => rows.filter((h) => h.lat != null && h.lon != null).map((h) => ({
    id: h.id, position: { lat: h.lat!, lon: h.lon! }, kind: 'case',
    color: h.activeCaseId ? '#2563eb' : '#b45309', size: h.tonnes ? Math.min(10, 3 + Math.log10(h.tonnes + 1) * 1.6) : 4,
    label: h.name, sublabel: `${h.date} · ${h.location}`, selected: h.id === selected,
    meta: { Oil: h.oil ?? 'Not reported', 'Released (t)': h.tonnes ?? 'Not reported', 'Position ±': h.positionPrecisionKm != null ? `${h.positionPrecisionKm} km` : 'Not reported' },
  })), [rows, selected]);

  const active = world.historical.find((h) => h.id === selected) ?? null;

  return (
    <div className="flex-none lg:flex-1 lg:min-h-0 flex flex-col lg:flex-row gap-4 p-4">
      <div className="flex-none h-[70vh] lg:h-auto lg:flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex gap-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Vessel, location, oil, cause…" className="flex-1" />
          <Select value={decade} onChange={setDecade} options={[{ value: 'all', label: 'All decades' }, ...decades.map((d) => ({ value: d, label: d }))]} />
          <ExportButton onExport={() => downloadCsv('oceanspill-historical-register.csv', columns.filter((c) => c.value), rows)} />
        </div>
        <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
          <DataTable columns={columns} rows={rows} rowKey={(h) => h.id} dense selectedId={selected}
            onRowClick={(h) => setSelected(h.id === selected ? null : h.id)} initialSort={{ key: 'date', dir: 'desc' }} />
        </div>
        <InfoBanner tone="amber">{world.index.historical.note}</InfoBanner>
      </div>
      <div className="w-full lg:w-[340px] xl:w-[400px] flex-shrink-0 flex flex-col gap-3">
        <div className="h-[300px] bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <MapView initialCentre={{ lat: 16, lon: 80 }} initialZoom={3.6} markers={markers}
            onMarkerClick={(m) => setSelected(m.id)}
            fitTo={active?.lat != null && active.lon != null ? [{ lat: active.lat - 1.5, lon: active.lon - 1.5 }, { lat: active.lat + 1.5, lon: active.lon + 1.5 }] : undefined}
            fitKey={selected ?? 'all'} />
        </div>
        <div className="max-h-[60vh] lg:max-h-none lg:flex-1 lg:min-h-0 bg-white rounded-lg shadow-sm border border-gray-200 overflow-y-auto">
          {!active ? (
            <EmptyState icon={<BookOpen className="w-10 h-10" />} title="Select an incident" body="Every entry cites its public source." />
          ) : (
            <div className="p-4 space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-bold text-gray-900 text-sm">{active.name}</h3>
                  <p className="text-[0.6875rem] text-gray-500">{active.date} · {active.location}</p>
                </div>
                <ProvenanceBadge p="real" />
              </div>
              <KeyValue cols={2} items={[
                ['Oil', active.oil ?? 'Not reported'],
                ['Quantity', active.tonnes != null ? `${fmt.num(active.tonnes)} t` : 'Not reported'],
                ['Cause', active.cause ?? '—'],
                ['Position ±', active.positionPrecisionKm != null ? `${active.positionPrecisionKm} km` : 'Unknown'],
              ]} />
              {active.tonnesNote && <p className="text-[0.6875rem] text-gray-500 leading-normal">{active.tonnesNote}</p>}
              {active.legal?.map((l) => (
                <div key={l.action + l.authority} className="bg-amber-50 border border-amber-200 rounded p-2">
                  <p className="text-[0.71875rem] font-bold text-amber-900">{l.action}{l.amountInr ? ` · ${fmt.inr(l.amountInr)}` : ''}</p>
                  <p className="text-[0.6875rem] text-amber-800">{l.authority} → {l.party}</p>
                  {l.note && <p className="text-[0.6875rem] text-amber-700 mt-0.5">{l.note}</p>}
                </div>
              ))}
              <div className="flex gap-2">
                <a href={active.source} target="_blank" rel="noreferrer" className="text-[0.71875rem] text-blue-600 hover:underline flex items-center gap-1">
                  <ExternalLink className="w-3 h-3" /> Source
                </a>
                {active.activeCaseId && (
                  <Button size="sm" variant="primary" onClick={() => navigate({ tab: 'Investigation', caseId: active.activeCaseId })}>Open analysed case</Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
