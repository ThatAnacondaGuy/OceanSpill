import { useEffect, useMemo, useState } from 'react';
import {
  Shield, Ship, Scale, TrendingUp, Flag, Ban, Building2, Repeat,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import {
  Badge, Button, KeyValue, Select, SearchInput, InfoBanner, Tabs, StatCard,
  DataTable, EmptyState, Modal, Field, TextArea, ExportButton, downloadCsv,
  ScoreBar, BarChart, type Column,
} from './components/ui';
import { DEFAULT_WEIGHTS } from './engine/attribution';

/**
 * DG Shipping regulatory view.
 *
 * Deliberately lighter than the intelligence console — the audience here is a compliance
 * officer, not an analyst. The page's distinctive job is to make the feedback loop visible:
 * every registry entry shows the prior-offender boost it currently contributes to future
 * attribution scoring, so regulatory work is legible as an input to detection, not a dead end.
 */
export default function OffenderRegistry() {
  const { world, selectedMmsi, setSelectedMmsi, navigate, getAnalysis, revision } = useStore();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('registry');
  const [riskFilter, setRiskFilter] = useState('all');
  const [actionFor, setActionFor] = useState<string | null>(null);

  /**
   * Registry membership: a confirmed prior, a sanctions listing, a port-state detention, or
   * any enforcement action already recorded against the vessel. The last condition matters —
   * a vessel that has been fined belongs on the register even if it had a clean record before.
   */
  const registry = useMemo(() => {
    const enforced = new Set(world.enforcement.map((e) => e.mmsi));
    return world.vessels
      .filter((v) => v.priorOffences > 0 || v.sanctioned || v.psc.detentions > 0 || enforced.has(v.mmsi))
      .map((v) => {
        const cases = world.cases.filter((c) => c.candidateMmsis.includes(v.mmsi));
        const attributions = cases.filter((c) => {
          const a = getAnalysis(c.id);
          return a?.ranked[0]?.mmsi === v.mmsi && ['Enforcement', 'Closed', 'Verified'].includes(c.status);
        });
        const actions = world.enforcement.filter((e) => e.mmsi === v.mmsi);
        const penalties = actions.reduce((s, e) => s + (e.amountInr ?? 0), 0);

        // The boost this vessel currently contributes to its own attribution prior.
        const priorBoost = Math.min(0.62, v.priorOffences * 0.22)
          + (v.sanctioned ? 0.25 : 0)
          + (v.flagRisk === 'Black List' ? 0.12 : v.flagRisk === 'Grey List' ? 0.06 : 0)
          + Math.min(0.14, v.psc.detentions * 0.07);
        const weightedContribution = Math.min(1, priorBoost) * DEFAULT_WEIGHTS.vesselPrior;

        const risk = v.sanctioned ? 'Critical' : v.priorOffences >= 2 ? 'High' : v.priorOffences === 1 || v.psc.detentions >= 2 ? 'Elevated' : 'Watch';
        return { vessel: v, cases, attributions, actions, penalties, priorBoost: Math.min(1, priorBoost), weightedContribution, risk };
      })
      .filter((r) => {
        const q = query.trim().toLowerCase();
        if (q && !`${r.vessel.name} ${r.vessel.mmsi} ${r.vessel.imo} ${r.vessel.flag} ${r.vessel.owner}`.toLowerCase().includes(q)) return false;
        if (riskFilter !== 'all' && r.risk !== riskFilter) return false;
        return true;
      })
      .sort((a, b) => b.priorBoost - a.priorBoost);
  }, [world, query, riskFilter, getAnalysis, revision]);

  const selected = registry.find((r) => r.vessel.mmsi === selectedMmsi) ?? registry[0] ?? null;

  useEffect(() => {
    if (!selectedMmsi && registry.length) setSelectedMmsi(registry[0].vessel.mmsi);
  }, [selectedMmsi, registry, setSelectedMmsi]);

  const stats = useMemo(() => ({
    total: registry.length,
    repeat: registry.filter((r) => r.vessel.priorOffences >= 2).length,
    sanctioned: registry.filter((r) => r.vessel.sanctioned).length,
    penalties: registry.reduce((s, r) => s + r.penalties, 0),
  }), [registry]);

  const byFlag = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of registry) m.set(r.vessel.flag, (m.get(r.vessel.flag) ?? 0) + 1);
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [registry]);

  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of registry) m.set(r.vessel.type, (m.get(r.vessel.type) ?? 0) + 1);
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [registry]);

  type Row = typeof registry[number];

  const columns: Column<Row>[] = [
    {
      key: 'name', header: 'Vessel', value: (r) => r.vessel.name,
      render: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-gray-900 truncate">{r.vessel.name}</span>
            {r.vessel.sanctioned && <Badge tone="slate"><Ban className="w-2.5 h-2.5" /> SANCTIONED</Badge>}
          </div>
          <div className="text-[9.5px] text-gray-500 font-mono">IMO {r.vessel.imo} · MMSI {r.vessel.mmsi}</div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', width: '116px', value: (r) => r.vessel.type, render: (r) => <span className="text-gray-600">{r.vessel.type}</span> },
    {
      key: 'flag', header: 'Flag', width: '118px', value: (r) => r.vessel.flag,
      render: (r) => (
        <div>
          <span className="text-gray-700">{r.vessel.flag}</span>
          {r.vessel.flagRisk !== 'Standard' && (
            <div className={`text-[9px] font-semibold ${r.vessel.flagRisk === 'Black List' ? 'text-red-600' : 'text-amber-600'}`}>
              Paris MoU {r.vessel.flagRisk.toLowerCase()}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'risk', header: 'Risk', width: '84px', value: (r) => ({ Critical: 0, High: 1, Elevated: 2, Watch: 3 }[r.risk as string] ?? 4),
      render: (r) => <Badge tone={r.risk === 'Critical' ? 'slate' : r.risk === 'High' ? 'red' : r.risk === 'Elevated' ? 'amber' : 'gray'}>{r.risk}</Badge>,
    },
    {
      key: 'priors', header: 'Priors', width: '58px', align: 'center', value: (r) => r.vessel.priorOffences,
      render: (r) => r.vessel.priorOffences > 0 ? <span className="font-black text-red-600">{r.vessel.priorOffences}</span> : <span className="text-gray-300">0</span>,
    },
    {
      key: 'psc', header: 'PSC', width: '76px', align: 'center', value: (r) => r.vessel.psc.detentions,
      render: (r) => (
        <span className="text-gray-700 font-mono text-[10px]">
          {r.vessel.psc.detentions}D / {r.vessel.psc.deficiencies}F
        </span>
      ),
    },
    {
      key: 'actions', header: 'Actions', width: '66px', align: 'center', value: (r) => r.actions.length,
      render: (r) => r.actions.length > 0 ? <Badge tone="blue">{r.actions.length}</Badge> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'penalty', header: 'Penalties', width: '92px', align: 'right', value: (r) => r.penalties,
      render: (r) => r.penalties > 0 ? <span className="font-mono font-bold text-gray-900">{fmt.inr(r.penalties)}</span> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'boost', header: 'Model boost', width: '108px', align: 'right', value: (r) => r.priorBoost,
      render: (r) => (
        <div className="flex items-center gap-1.5 justify-end">
          <div className="w-10 h-1.5 bg-gray-200 rounded overflow-hidden">
            <div className="h-full bg-violet-500" style={{ width: `${r.priorBoost * 100}%` }} />
          </div>
          <span className="font-mono font-bold text-violet-700 w-9 text-right">+{(r.weightedContribution * 100).toFixed(1)}</span>
        </div>
      ),
    },
  ];

  const exportRegister = () => {
    downloadCsv('dgshipping-offender-registry.csv', columns.filter((c) => c.value), registry);
  };

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-gray-50">
      {/* Lighter, report-style header — this page is regulatory, not operational. */}
      <div className="bg-white border-b-2 border-blue-600 px-4 py-3 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-blue-50 text-blue-700 p-2 rounded"><Shield className="w-5 h-5" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-base">Offender registry</h2>
            <p className="text-xs text-gray-500">Directorate General of Shipping · marine pollution compliance record</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Vessel, IMO, MMSI, owner…" className="w-64" />
          <Select value={riskFilter} onChange={setRiskFilter}
            options={[{ value: 'all', label: 'All risk bands' }, ...['Critical', 'High', 'Elevated', 'Watch'].map((r) => ({ value: r, label: r }))]} />
          <ExportButton onExport={exportRegister} label="Export register" />
        </div>
      </div>

      <div className="px-4 py-3 grid grid-cols-4 gap-3 flex-shrink-0">
        <StatCard icon={<Ship className="w-5 h-5" />} title="Vessels on register" value={stats.total} trend="with priors, detentions or sanctions" />
        <StatCard icon={<Repeat className="w-5 h-5" />} title="Repeat offenders" value={stats.repeat} trend="two or more confirmed attributions" accent="red" />
        <StatCard icon={<Ban className="w-5 h-5" />} title="Sanctioned" value={stats.sanctioned} trend="matched against watchlists" accent="amber" />
        <StatCard icon={<Scale className="w-5 h-5" />} title="Penalties recovered" value={fmt.inr(stats.penalties)} trend={`across ${world.enforcement.length} actions`} accent="green" />
      </div>

      <div className="flex-1 min-h-0 flex gap-3 px-4 pb-4">
        <div className="flex-1 min-w-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'registry', label: 'Register', count: registry.length },
            { id: 'analysis', label: 'Pattern analysis' },
          ]} className="px-2" />
          {tab === 'registry' ? (
            <div className="flex-1 min-h-0">
              <DataTable columns={columns} rows={registry} rowKey={(r) => r.vessel.mmsi} dense
                selectedId={selected?.vessel.mmsi} onRowClick={(r) => setSelectedMmsi(r.vessel.mmsi)}
                initialSort={{ key: 'boost', dir: 'desc' }}
                empty="No vessels match the current filters." />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              <div>
                <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">Registered vessels by flag state</h4>
                <BarChart horizontal data={byFlag.map((f) => ({
                  label: f.label, value: f.value,
                  color: world.vessels.find((v) => v.flag === f.label)?.flagRisk === 'Black List' ? '#dc2626'
                    : world.vessels.find((v) => v.flag === f.label)?.flagRisk === 'Grey List' ? '#f59e0b' : '#2563eb',
                }))} />
                <p className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                  Open registries dominate the register. That is the pattern the flag-risk prior encodes, and it
                  is why flag alone is a weak signal — it must be combined with inspection history and observed
                  behaviour rather than used on its own.
                </p>
              </div>
              <div>
                <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">By vessel type</h4>
                <BarChart horizontal data={byType.map((t) => ({ label: t.label, value: t.value }))} />
                <p className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                  Tankers are over-represented because they carry the cargo residues and slop volumes consistent
                  with observed slick sizes — the same reasoning the scoring model applies as a weak prior.
                </p>
              </div>
              <div className="bg-violet-50 border border-violet-200 rounded p-3">
                <h4 className="text-xs font-bold text-violet-900 uppercase mb-1.5 flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5" /> The feedback loop
                </h4>
                <p className="text-[11px] text-violet-900 leading-relaxed">
                  Every confirmed attribution recorded here raises that vessel's registry prior, which feeds
                  back into future attribution scoring at a weight of {DEFAULT_WEIGHTS.vesselPrior}. Regulatory work is
                  therefore an input to detection, not the end of the process. The weight is kept deliberately
                  low: a prior should tip a close decision, never manufacture one. A vessel with the maximum
                  possible registry prior gains only {(DEFAULT_WEIGHTS.vesselPrior * 100).toFixed(0)} points of a 100-point score.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="w-[370px] flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
          {!selected ? (
            <EmptyState icon={<Shield className="w-10 h-10" />} title="No vessel selected" />
          ) : (
            <>
              <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <h3 className="font-bold text-gray-900 text-sm truncate">{selected.vessel.name}</h3>
                    <p className="text-[10px] text-gray-500 font-mono">IMO {selected.vessel.imo}</p>
                  </div>
                  <Badge tone={selected.risk === 'Critical' ? 'slate' : selected.risk === 'High' ? 'red' : 'amber'}>{selected.risk}</Badge>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                <KeyValue cols={2} items={[
                  ['Flag', selected.vessel.flag], ['Type', selected.vessel.type],
                  ['Built', String(selected.vessel.builtYear)], ['DWT', fmt.num(selected.vessel.deadweightT)],
                  ['Owner', selected.vessel.owner], ['Operator', selected.vessel.operator],
                  ['Class', selected.vessel.classSociety], ['P&I club', selected.vessel.piClub],
                ]} />

                {selected.vessel.sanctioned && (
                  <InfoBanner tone="red" icon={<Ban className="w-3.5 h-3.5" />}>
                    Listed on {selected.vessel.sanctionsList}. Enforcement involving this vessel should be
                    coordinated with the Ministry of External Affairs before any public attribution.
                  </InfoBanner>
                )}

                <div className="bg-violet-50 border border-violet-200 rounded p-2.5">
                  <p className="text-[10px] font-bold text-violet-900 uppercase mb-1.5">Contribution to attribution scoring</p>
                  <ScoreBar label="Registry prior (raw)" value={selected.priorBoost} tone="violet" />
                  <div className="mt-2 space-y-1 text-[10px] text-violet-800">
                    {selected.vessel.priorOffences > 0 && <Row label={`${selected.vessel.priorOffences} prior attribution${selected.vessel.priorOffences > 1 ? 's' : ''}`} value={`+${Math.min(0.62, selected.vessel.priorOffences * 0.22).toFixed(2)}`} />}
                    {selected.vessel.sanctioned && <Row label="Sanctions listing" value="+0.25" />}
                    {selected.vessel.flagRisk === 'Black List' && <Row label="Black-list flag state" value="+0.12" />}
                    {selected.vessel.flagRisk === 'Grey List' && <Row label="Grey-list flag state" value="+0.06" />}
                    {selected.vessel.psc.detentions > 0 && <Row label={`${selected.vessel.psc.detentions} PSC detention${selected.vessel.psc.detentions > 1 ? 's' : ''}`} value={`+${Math.min(0.14, selected.vessel.psc.detentions * 0.07).toFixed(2)}`} />}
                  </div>
                  <div className="mt-2 pt-2 border-t border-violet-200 flex justify-between text-[10px]">
                    <span className="font-semibold text-violet-900">Effective score contribution</span>
                    <span className="font-mono font-black text-violet-900">+{(selected.weightedContribution * 100).toFixed(1)} of 100</span>
                  </div>
                </div>

                <div>
                  <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Port state control</p>
                  <KeyValue cols={2} items={[
                    ['Detentions', String(selected.vessel.psc.detentions)],
                    ['Deficiencies', String(selected.vessel.psc.deficiencies)],
                    ['Last inspection', selected.vessel.psc.lastInspection],
                    ['Inspected at', selected.vessel.psc.lastPort],
                  ]} />
                </div>

                <div>
                  <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Incident history</p>
                  {selected.cases.length === 0 ? (
                    <p className="text-[10.5px] text-gray-500">No detections list this vessel as a candidate.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {selected.cases.map((c) => {
                        const a = getAnalysis(c.id);
                        const score = a?.ranked.find((r) => r.mmsi === selected.vessel.mmsi);
                        return (
                          <button key={c.id} onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}
                            className="w-full text-left border border-gray-200 rounded p-2 hover:border-blue-400 hover:bg-blue-50/40">
                            <div className="flex justify-between items-start gap-2">
                              <div className="min-w-0">
                                <p className="text-[10.5px] font-bold font-mono text-gray-900">{c.id}</p>
                                <p className="text-[9.5px] text-gray-500 truncate">{c.subRegion}</p>
                                <p className="text-[9px] text-gray-400">{fmt.utc(c.detection.acquiredAt)}</p>
                              </div>
                              {score && (
                                <div className="text-right flex-shrink-0">
                                  <div className={`text-sm font-black leading-none ${score.rank === 1 ? 'text-red-600' : 'text-gray-500'}`}>{(score.total * 100).toFixed(0)}</div>
                                  <div className="text-[9px] text-gray-400">rank {score.rank}</div>
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Regulatory actions</p>
                  {selected.actions.length === 0 ? (
                    <p className="text-[10.5px] text-gray-500">No actions recorded against this vessel.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {selected.actions.map((a) => (
                        <div key={a.id} className="border border-gray-200 rounded p-2">
                          <div className="flex justify-between items-start gap-2 mb-1">
                            <Badge tone={a.type === 'Fine Issued' ? 'red' : 'blue'}>{a.type}</Badge>
                            <Badge tone={a.status === 'Concluded' ? 'green' : 'amber'}>{a.status}</Badge>
                          </div>
                          <p className="text-[9.5px] text-gray-500 font-mono">{a.reference}</p>
                          <p className="text-[9.5px] text-gray-600 mt-0.5">{a.authority}</p>
                          {a.amountInr && <p className="text-[10px] font-bold text-gray-900 mt-0.5">{fmt.inr(a.amountInr)}</p>}
                          {a.outcome && <p className="text-[9.5px] text-gray-600 mt-1 leading-snug">{a.outcome}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="p-2.5 border-t border-gray-200 flex gap-2">
                <Button size="sm" className="flex-1 justify-center" onClick={() => navigate({ tab: 'Vessel Analysis', mmsi: selected.vessel.mmsi })} icon={<Ship className="w-3 h-3" />}>
                  Track record
                </Button>
                <Button size="sm" variant="primary" className="flex-1 justify-center" onClick={() => setActionFor(selected.vessel.mmsi)} icon={<Building2 className="w-3 h-3" />}>
                  Record action
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <RegulatoryActionModal open={!!actionFor} onClose={() => setActionFor(null)} mmsi={actionFor} />
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><span>{label}</span><span className="font-mono font-semibold">{value}</span></div>;
}

function RegulatoryActionModal({ open, onClose, mmsi }: { open: boolean; onClose: () => void; mmsi: string | null }) {
  const { world, addEnforcement, now } = useStore();
  const [type, setType] = useState('Inspection Ordered');
  const [caseId, setCaseId] = useState('');
  const [notes, setNotes] = useState('');

  const vessel = world.vesselsByMmsi.get(mmsi ?? '');
  const relatedCases = useMemo(
    () => (mmsi ? world.cases.filter((c) => c.candidateMmsis.includes(mmsi)) : []),
    [mmsi, world.cases]
  );

  useEffect(() => { if (relatedCases.length) setCaseId(relatedCases[0].id); }, [mmsi, relatedCases.length]);

  if (!vessel) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Record regulatory action — ${vessel.name}`}
      subtitle={`IMO ${vessel.imo} · ${vessel.flag}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!caseId} onClick={() => {
            addEnforcement({
              caseId, mmsi: vessel.mmsi, type: type as any, issuedAt: now,
              authority: 'DG Shipping', reference: `DGS/ENF/2025/${String(Math.floor(Math.random() * 900 + 100))}`,
              status: 'Pending', outcome: notes.trim() || undefined,
            });
            setNotes('');
            onClose();
          }}>Record</Button>
        </>
      }>
      <div className="space-y-3">
        <Field label="Related case">
          <Select value={caseId} onChange={setCaseId}
            options={relatedCases.map((c) => ({ value: c.id, label: `${c.id} — ${c.subRegion}` }))} />
        </Field>
        <Field label="Action">
          <Select value={type} onChange={setType}
            options={['Inspection Ordered', 'Detention', 'Fine Issued', 'Insurance Flagged', 'Blacklist Recommended', 'Prosecution Referred'].map((t) => ({ value: t, label: t }))} />
        </Field>
        <Field label="Notes"><TextArea value={notes} onChange={setNotes} rows={3} placeholder="Basis for the action and any conditions attached…" /></Field>
        <InfoBanner tone="blue" icon={<Flag className="w-3.5 h-3.5" />}>
          Recording an action here updates the vessel's registry prior, which raises its score in future
          attribution runs. That is intentional — but the weight is small by design, so history informs the
          ranking without predetermining it.
        </InfoBanner>
      </div>
    </Modal>
  );
}
