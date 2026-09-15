import { useMemo, useState } from 'react';
import {
  CheckSquare, ArrowRight, ArrowLeft, Clock, AlertTriangle, Ship, Scale, Lock,
  Plane, FlaskConical, Building2, CheckCircle2,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import {
  Badge, Button, Tier, StatusBadge, KeyValue, InfoBanner, Select, SearchInput,
  Modal, Field, TextArea, StatCard, DataTable, ProvenanceBadge, type Column,
} from './components/ui';
import type { SpillCase, WorkflowStage, EnforcementAction } from './data/types';

/**
 * Verification and enforcement tracker.
 *
 * The stages are ordered and a case may only advance one step at a time. That constraint is
 * the point: it makes "confidence, not proof" an enforced property of the workflow rather
 * than a discipline the operator has to remember.
 */
const STAGES: { id: WorkflowStage; label: string; icon: any; tone: string; help: string }[] = [
  { id: 'Awaiting Dispatch', label: 'Awaiting dispatch', icon: Clock, tone: 'bg-slate-100 border-slate-300 text-slate-700', help: 'Attribution complete. Nothing has been physically confirmed yet.' },
  { id: 'Patrol En Route', label: 'Patrol en route', icon: Plane, tone: 'bg-blue-100 border-blue-300 text-blue-700', help: 'An ICG aircraft or vessel has been tasked to the position.' },
  { id: 'Sample Collected', label: 'Sample collected', icon: FlaskConical, tone: 'bg-violet-100 border-violet-300 text-violet-700', help: 'On-scene confirmation obtained and an oil sample recovered.' },
  { id: 'Forensic Match Pending', label: 'Forensic match pending', icon: Scale, tone: 'bg-amber-100 border-amber-300 text-amber-700', help: 'GC-MS fingerprint comparison against the suspect vessel\'s slop tank.' },
  { id: 'Port Inspection Requested', label: 'Port inspection', icon: Building2, tone: 'bg-orange-100 border-orange-300 text-orange-700', help: 'Inspection ordered at the vessel\'s next Indian port call.' },
  { id: 'Closed', label: 'Closed', icon: CheckCircle2, tone: 'bg-emerald-100 border-emerald-300 text-emerald-700', help: 'Concluded — either an enforcement outcome or a documented dismissal.' },
];

export default function Workflow() {
  const { world, now, setWorkflowStage, navigate, getAnalysis, revision } = useStore();
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const [view, setView] = useState<'board' | 'enforcement'>('board');
  const [detail, setDetail] = useState<string | null>(null);
  const [enforceFor, setEnforceFor] = useState<string | null>(null);

  const cases = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.cases.filter((c) => {
      if (q && !`${c.id} ${c.title} ${c.subRegion} ${c.assignedTo}`.toLowerCase().includes(q)) return false;
      if (tierFilter !== 'all' && c.tier !== tierFilter) return false;
      return true;
    });
  }, [world.cases, query, tierFilter, revision]);

  const byStage = useMemo(() => {
    const m = new Map<WorkflowStage, SpillCase[]>();
    for (const s of STAGES) m.set(s.id, []);
    for (const c of cases) m.get(c.workflowStage)?.push(c);
    return m;
  }, [cases]);

  const stageIndex = (s: WorkflowStage) => STAGES.findIndex((x) => x.id === s);

  const advance = (c: SpillCase, dir: 1 | -1) => {
    const i = stageIndex(c.workflowStage);
    const next = STAGES[i + dir];
    if (!next) return;
    setWorkflowStage(c.id, next.id);
  };

  const active = world.cases.find((c) => c.id === detail) ?? null;
  const activeAnalysis = active ? getAnalysis(active.id) : null;

  const enforcementColumns: Column<EnforcementAction>[] = [
    {
      key: 'id', header: 'Record', width: '120px', value: (a) => a.id,
      render: (a) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-mono font-bold text-gray-900">{a.id}</span>
          <ProvenanceBadge p={a.provenance} />
        </div>
      ),
    },
    {
      key: 'case', header: 'Case', width: '132px', value: (a) => a.caseId,
      render: (a) => <button onClick={() => navigate({ tab: 'Investigation', caseId: a.caseId })} className="font-mono text-blue-600 hover:underline font-semibold">{a.caseId}</button>,
    },
    {
      key: 'vessel', header: 'Party', value: (a) => a.party,
      render: (a) => {
        const v = world.vesselsByMmsi.get(a.mmsi);
        return v ? (
          <button onClick={() => navigate({ tab: 'Vessel Analysis', mmsi: a.mmsi })} className="text-left hover:underline">
            <div className="font-semibold text-gray-900">{a.party}</div>
            <div className="text-[9.5px] text-gray-500 font-mono">{fmt.vesselId(v)}</div>
          </button>
        ) : <span className="text-gray-800 font-semibold">{a.party}</span>;
      },
    },
    { key: 'type', header: 'Action', width: '150px', value: (a) => a.type, render: (a) => <Badge tone={a.type === 'Fine Issued' ? 'red' : a.type === 'Detention' ? 'amber' : 'blue'}>{a.type}</Badge> },
    { key: 'authority', header: 'Authority', value: (a) => a.authority, render: (a) => <span className="text-gray-600 text-[10.5px]">{a.authority}</span> },
    {
      key: 'ref', header: 'Reference / source', width: '170px', value: (a) => a.reference ?? a.source ?? '',
      render: (a) => a.source
        ? <a href={a.source} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-[10px] break-all">{a.reference ?? 'Public source'}</a>
        : <span className="font-mono text-gray-500 text-[10px]">{a.reference ?? 'Not issued'}</span>,
    },
    {
      key: 'amount', header: 'Penalty', width: '92px', align: 'right', value: (a) => a.amountInr ?? 0,
      render: (a) => a.amountInr ? <span className="font-mono font-bold text-gray-900">{fmt.inr(a.amountInr)}</span> : <span className="text-gray-300">—</span>,
    },
    { key: 'issued', header: 'Date', width: '104px', value: (a) => a.issuedAt ?? 0, render: (a) => a.issuedAt != null ? <span className="font-mono text-gray-600">{fmt.date(a.issuedAt)}</span> : <span className="text-gray-400">Not published</span> },
    {
      key: 'status', header: 'Status', width: '96px', value: (a) => a.status,
      render: (a) => <Badge tone={a.status === 'Concluded' ? 'green' : a.status === 'Contested' ? 'red' : a.status === 'Served' || a.status === 'Reported' ? 'blue' : 'amber'}>{a.status}</Badge>,
    },
  ];

  const stats = useMemo(() => ({
    awaiting: byStage.get('Awaiting Dispatch')?.length ?? 0,
    inProgress: STAGES.slice(1, 5).reduce((s, st) => s + (byStage.get(st.id)?.length ?? 0), 0),
    closed: byStage.get('Closed')?.length ?? 0,
    penalties: world.enforcement.reduce((s, e) => s + (e.amountInr ?? 0), 0),
  }), [byStage, world.enforcement, revision]);

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-y-auto lg:overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-4 flex-shrink-0 flex-wrap gap-y-2">
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 text-white p-1.5 rounded"><CheckSquare className="w-4 h-4" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">Verification &amp; enforcement</h2>
            <p className="text-[11px] text-gray-500">Tracks human action, not model output</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Case, location, analyst…" className="w-full sm:w-56" />
          <Select value={tierFilter} onChange={setTierFilter}
            options={[{ value: 'all', label: 'All tiers' }, { value: 'HIGH', label: 'High' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'LOW', label: 'Low' }]} />
          <div className="flex rounded border border-gray-300 overflow-hidden">
            <button onClick={() => setView('board')} className={`px-2.5 py-1.5 text-[11px] font-semibold ${view === 'board' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Board</button>
            <button onClick={() => setView('enforcement')} className={`px-2.5 py-1.5 text-[11px] font-semibold border-l border-gray-300 ${view === 'enforcement' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              Enforcement register
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white border-b border-gray-200 px-3 py-2 flex gap-3 flex-wrap flex-shrink-0">
        <StatCard icon={<Clock className="w-4 h-4" />} title="Awaiting dispatch" value={stats.awaiting} trend="no physical confirmation yet" accent="amber" />
        <StatCard icon={<Plane className="w-4 h-4" />} title="In verification" value={stats.inProgress} trend="assets tasked or results pending" />
        <StatCard icon={<CheckCircle2 className="w-4 h-4" />} title="Concluded" value={stats.closed} trend="closed cases" accent="green" />
        <StatCard icon={<Scale className="w-4 h-4" />} title="Penalties (public record)" value={fmt.inr(stats.penalties)} trend={`${world.enforcement.length} legal actions recorded`} accent="red" />
      </div>

      {view === 'board' ? (
        <div className="h-[80vh] flex-none lg:h-auto lg:flex-1 lg:min-h-0 overflow-x-auto p-3">
          <div className="flex gap-3 h-full" style={{ minWidth: 'max-content' }}>
            {STAGES.map((stage, si) => {
              const items = byStage.get(stage.id) ?? [];
              const Icon = stage.icon;
              return (
                <div key={stage.id} className="w-[270px] flex flex-col bg-gray-50 rounded-lg border border-gray-200 flex-shrink-0">
                  <div className={`px-2.5 py-2 border-b rounded-t-lg ${stage.tone}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="text-[11px] font-bold truncate">{stage.label}</span>
                      </div>
                      <span className="text-[10px] font-black bg-white/70 px-1.5 rounded flex-shrink-0">{items.length}</span>
                    </div>
                    <p className="text-[9.5px] opacity-80 mt-0.5 leading-snug">{stage.help}</p>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {items.length === 0 && <p className="text-[10px] text-gray-400 text-center py-6">No cases</p>}
                    {items.map((c) => {
                      const a = getAnalysis(c.id);
                      const top = a?.ranked[0];
                      const vessel = top ? world.vesselsByMmsi.get(top.mmsi) : null;
                      return (
                        <div key={c.id} className="bg-white rounded border border-gray-200 p-2 shadow-sm hover:border-blue-400 hover:shadow transition-all">
                          <button onClick={() => setDetail(c.id)} className="w-full text-left">
                            <div className="flex items-center justify-between gap-1.5 mb-1">
                              <span className="font-bold text-[11px] text-gray-900 truncate" title={c.title}>{c.title}</span>
                              <Tier tier={c.tier} />
                            </div>
                            <p className="text-[10px] text-gray-600 truncate">{c.subRegion}</p>
                            {vessel && (
                              <div className="flex items-center gap-1 mt-1 text-[10px] text-gray-700">
                                <Ship className="w-3 h-3 text-gray-400 flex-shrink-0" />
                                <span className="truncate font-semibold">{vessel.name}</span>
                                <ProvenanceBadge p={vessel.provenance} />
                                {top?.darkDuringWindow && <Badge tone="red">DARK</Badge>}
                              </div>
                            )}
                            <div className="flex items-center justify-between mt-1.5 text-[9px] text-gray-400">
                              <span>{c.assignedTo}</span>
                              <span>{fmt.ago(c.updatedAt, now)}</span>
                            </div>
                          </button>
                          <div className="flex gap-1 mt-1.5 pt-1.5 border-t border-gray-100">
                            <button onClick={() => advance(c, -1)} disabled={si === 0}
                              title={si === 0 ? 'Already at the first stage' : `Move back to ${STAGES[si - 1]?.label}`}
                              className="flex-1 text-[9.5px] font-semibold py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-0.5">
                              <ArrowLeft className="w-2.5 h-2.5" />
                            </button>
                            <button onClick={() => advance(c, 1)} disabled={si === STAGES.length - 1}
                              title={si === STAGES.length - 1 ? 'Case is closed' : `Advance to ${STAGES[si + 1]?.label}`}
                              className="flex-[2] text-[9.5px] font-semibold py-1 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1">
                              {si === STAGES.length - 1 ? 'Closed' : <>Advance <ArrowRight className="w-2.5 h-2.5" /></>}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="h-[80vh] flex-none lg:h-auto lg:flex-1 lg:min-h-0 p-3">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 h-full flex flex-col">
            <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
              <span className="text-[11px] font-bold text-gray-700">Enforcement register — {world.enforcement.length} actions</span>
              <span className="text-[10px] text-gray-500">Real outcomes from public records, plus actions recorded in this session · total penalties {fmt.inr(stats.penalties)}</span>
            </div>
            <div className="flex-1 min-h-0">
              <DataTable columns={enforcementColumns} rows={world.enforcement} rowKey={(a) => a.id} dense
                initialSort={{ key: 'issued', dir: 'desc' }}
                empty="No enforcement actions have been recorded." />
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border-t border-gray-200 px-3 py-2 flex-shrink-0">
        <InfoBanner tone="blue" icon={<Lock className="w-3.5 h-3.5" />}>
          Cases move one stage at a time and cannot skip ahead. A detection cannot become an enforcement
          action without passing through on-scene verification and a forensic match — the interface enforces
          that sequence rather than relying on the operator to observe it.
        </InfoBanner>
      </div>

      <Modal open={!!active} onClose={() => setDetail(null)} title={active ? `${active.title} — verification status` : ''}
        subtitle={active?.subRegion} width="max-w-3xl"
        footer={
          active ? (
            <>
              <Button onClick={() => { navigate({ tab: 'Investigation', caseId: active.id }); setDetail(null); }}>Open investigation</Button>
              <Button variant="danger" disabled={stageIndex(active.workflowStage) < 2}
                title={stageIndex(active.workflowStage) < 2 ? 'Requires a collected sample before enforcement can be raised' : undefined}
                onClick={() => { setEnforceFor(active.id); setDetail(null); }} icon={<Scale className="w-3 h-3" />}>
                Raise enforcement action
              </Button>
            </>
          ) : null
        }>
        {active && activeAnalysis && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Tier tier={active.tier} />
              <StatusBadge status={active.status} />
              <Badge tone="blue">{active.workflowStage}</Badge>
              {active.imacPushed && <Badge tone="teal">IMAC payload</Badge>}
              {active.alertDispatched && <Badge tone="amber">Alert drafted</Badge>}
            </div>

            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {STAGES.map((s, i) => {
                const current = stageIndex(active.workflowStage);
                const done = i < current;
                const isNow = i === current;
                return (
                  <div key={s.id} className="flex items-center gap-1 flex-shrink-0">
                    <div className={`px-2 py-1 rounded text-[10px] font-semibold border ${
                      done ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                      : isNow ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
                      {s.label}
                    </div>
                    {i < STAGES.length - 1 && <ArrowRight className={`w-3 h-3 ${done ? 'text-emerald-400' : 'text-gray-300'}`} />}
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Case</p>
                <KeyValue cols={1} items={[
                  ['Incident', fmt.precise(active.incidentTime, active.facts.incident.timePrecision)],
                  ['Observed by', active.detection.observationSource],
                  ['Detection', `${fmt.confidence(active)} — ${activeAnalysis.assessment.verdict}`],
                  ['Oil quantity', active.oilQuantityTonnes != null ? `${fmt.num(active.oilQuantityTonnes)} t` : 'Not reported'],
                  ['Assigned', active.assignedTo],
                  ['Last update', fmt.ago(active.updatedAt, now)],
                ]} />
              </div>
              <div>
                <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Leading suspect</p>
                {activeAnalysis.ranked[0] ? (() => {
                  const top = activeAnalysis.ranked[0];
                  const v = world.vesselsByMmsi.get(top.mmsi)!;
                  return (
                    <KeyValue cols={1} items={[
                      ['Vessel', <span className="flex items-center gap-1">{v.name} <ProvenanceBadge p={v.provenance} /></span>], ['Flag', v.flag ?? '—'], ['Type', v.type],
                      ['Score', `${(top.total * 100).toFixed(0)} / 100 (${activeAnalysis.verdict.band})`],
                      ['CPA', `${top.cpaKm.toFixed(1)} km`],
                      ['Prior offences', v.registryVerified ? String(v.priorOffences) : 'Not verified'],
                    ]} />
                  );
                })() : <p className="text-[11px] text-gray-500">No candidate vessel — suspected dark-vessel event.</p>}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Case history</p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {world.audit.filter((e) => e.target === active.id).map((e) => (
                  <div key={e.id} className="flex gap-2 text-[10px] border-b border-gray-100 pb-1">
                    <span className="font-mono text-gray-400 w-24 flex-shrink-0">{fmt.utcShort(e.t)}</span>
                    <div className="min-w-0">
                      <span className="font-semibold text-gray-900">{e.action}</span>
                      <span className="text-gray-500"> — {e.detail}</span>
                      <div className="text-[9px] text-gray-400">{e.actor} ({e.role})</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {stageIndex(active.workflowStage) < 2 && (
              <InfoBanner tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
                Enforcement is unavailable until a physical sample has been collected. The attribution score
                prioritises inspection; it does not substitute for evidence.
              </InfoBanner>
            )}
          </div>
        )}
      </Modal>

      <EnforcementModal open={!!enforceFor} onClose={() => setEnforceFor(null)} caseId={enforceFor} />
    </main>
  );
}

function EnforcementModal({ open, onClose, caseId }: { open: boolean; onClose: () => void; caseId: string | null }) {
  const { world, getAnalysis, addEnforcement, now } = useStore();
  const [type, setType] = useState<EnforcementAction['type']>('Inspection Ordered');
  const [authority, setAuthority] = useState('DG Shipping — Mercantile Marine Department, Mumbai');
  const [amount, setAmount] = useState('');
  const [outcome, setOutcome] = useState('');

  const c = world.cases.find((x) => x.id === caseId);
  const analysis = c ? getAnalysis(c.id) : null;
  const top = analysis?.ranked[0];
  const vessel = top ? world.vesselsByMmsi.get(top.mmsi) : null;

  if (!c) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Raise enforcement action — ${c.id}`}
      subtitle={vessel ? `Against ${vessel.name} (${vessel.flag ?? 'flag n/a'}, ${fmt.vesselId(vessel)})` : 'No identified vessel'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            addEnforcement({
              caseId: c.id, mmsi: top?.mmsi ?? '', party: vessel?.name ?? 'Unidentified source', type, issuedAt: now, authority,
              reference: null,
              amountInr: amount ? Number(amount) : undefined,
              status: 'Pending', outcome: outcome.trim() || undefined,
            });
            setOutcome(''); setAmount('');
            onClose();
          }}>Record action</Button>
        </>
      }>
      <div className="space-y-3">
        {vessel && (
          <div className="bg-gray-50 border border-gray-200 rounded p-2.5">
            <KeyValue cols={2} items={[
              ['Vessel', vessel.name], ['IMO', vessel.imo ?? '—'],
              ['Flag', `${vessel.flag ?? 'n/a'}${vessel.flagRisk ? ` (${vessel.flagRisk})` : ''}`], ['Operator', vessel.operator ?? 'Not published'],
              ['Attribution score', `${(top!.total * 100).toFixed(0)} / 100`],
              ['Verdict', analysis!.verdict.band],
            ]} />
          </div>
        )}
        <Field label="Action type">
          <Select value={type} onChange={(v) => setType(v as EnforcementAction['type'])}
            options={['Inspection Ordered', 'Detention', 'Fine Issued', 'Insurance Flagged', 'Blacklist Recommended', 'Prosecution Referred'].map((t) => ({ value: t, label: t }))} />
        </Field>
        <Field label="Issuing authority"><Select value={authority} onChange={setAuthority}
          options={[
            'DG Shipping — Mercantile Marine Department, Mumbai',
            'DG Shipping — Mercantile Marine Department, Chennai',
            'DG Shipping — Mercantile Marine Department, Kolkata',
            'Indian Coast Guard — Regional Headquarters',
            'State Pollution Control Board',
          ].map((a) => ({ value: a, label: a }))} /></Field>
        {type === 'Fine Issued' && (
          <Field label="Penalty amount (INR)" hint="Section 356J of the Merchant Shipping Act 1958 provides for penalties for discharge in Indian waters.">
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="4200000"
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded font-mono focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </Field>
        )}
        <Field label="Notes"><TextArea value={outcome} onChange={setOutcome} rows={3}
          placeholder="Basis for the action, evidence relied on, and any conditions…" /></Field>
        <InfoBanner tone="amber" icon={<Scale className="w-3.5 h-3.5" />}>
          A named vessel carries legal and diplomatic consequence. Record the evidentiary basis — sample
          reference and fingerprint match result — not just the attribution score.
        </InfoBanner>
      </div>
    </Modal>
  );
}
