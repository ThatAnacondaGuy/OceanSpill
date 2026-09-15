import { useEffect, useMemo, useState } from 'react';
import {
  Shield, Ship, Scale, TrendingUp, Flag, Ban, Building2, ExternalLink,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import {
  Badge, Button, KeyValue, Select, SearchInput, InfoBanner, Tabs, StatCard,
  DataTable, EmptyState, Modal, Field, TextArea, ExportButton, downloadCsv,
  ScoreBar, BarChart, ProvenanceBadge, type Column,
} from './components/ui';
import type { EnforcementAction, Vessel } from './data/types';

/** Registry prior exactly as the attribution engine computes it, so the page shows the real input. */
function registryPrior(v: Vessel): { total: number; parts: { label: string; value: number }[] } {
  const parts: { label: string; value: number }[] = [];
  if (v.priorOffences > 0) parts.push({ label: `${v.priorOffences} prior attribution${v.priorOffences > 1 ? 's' : ''}`, value: Math.min(0.62, v.priorOffences * 0.22) });
  if (v.sanctioned) parts.push({ label: 'Sanctions listing', value: 0.25 });
  if (v.flagRisk === 'Black List') parts.push({ label: 'Black-list flag state', value: 0.12 });
  else if (v.flagRisk === 'Grey List') parts.push({ label: 'Grey-list flag state', value: 0.06 });
  if (v.pscDetentions && v.pscDetentions > 0) parts.push({ label: `${v.pscDetentions} PSC detention${v.pscDetentions > 1 ? 's' : ''}`, value: Math.min(0.14, v.pscDetentions * 0.07) });
  if (['Crude Oil Tanker', 'Product Tanker', 'Chemical Tanker'].includes(v.type)) parts.push({ label: 'Tanker type', value: 0.08 });
  return { total: Math.min(1, parts.reduce((s, p) => s + p.value, 0)), parts };
}

interface Party {
  key: string;
  name: string;
  vessel: Vessel | null;
  kind: 'Vessel' | 'Facility' | 'Company / crew';
  actions: EnforcementAction[];
  caseIds: string[];
  penalties: number;
  reportedSource: boolean;
  provenance: 'real' | 'synthetic' | 'session';
}

/**
 * Regulatory view. The liability register lists parties with published legal outcomes and the
 * reported sources of the analysed cases, all from public records. Synthetic vessels, whose
 * registry histories exist only to exercise the scoring model, are kept on a separate tab.
 */
export default function OffenderRegistry() {
  const { world, selectedMmsi, setSelectedMmsi, navigate, getAnalysis, revision, weights } = useStore();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('register');
  const [kindFilter, setKindFilter] = useState('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [actionFor, setActionFor] = useState<string | null>(null);

  const parties = useMemo<Party[]>(() => {
    const map = new Map<string, Party>();
    const ensure = (key: string, name: string, vessel: Vessel | null, provenance: Party['provenance']): Party => {
      let p = map.get(key);
      if (!p) {
        p = {
          key, name, vessel, provenance, actions: [], caseIds: [], penalties: 0, reportedSource: false,
          kind: vessel ? (vessel.isFacility ? 'Facility' : 'Vessel') : 'Company / crew',
        };
        map.set(key, p);
      }
      return p;
    };
    for (const v of world.vessels) {
      if (v.provenance === 'real' && v.role === 'source') {
        const p = ensure(v.mmsi, v.name, v, 'real');
        p.reportedSource = true;
        if (!p.caseIds.includes(v.caseId)) p.caseIds.push(v.caseId);
      }
    }
    for (const e of world.enforcement) {
      const v = e.mmsi ? world.vesselsByMmsi.get(e.mmsi) ?? null : null;
      const key = v ? v.mmsi : `PARTY-${e.party.toUpperCase()}`;
      const p = ensure(key, v?.name ?? e.party, v, v?.provenance === 'synthetic' ? 'synthetic' : e.provenance === 'session' ? 'session' : 'real');
      p.actions.push(e);
      p.penalties += e.amountInr ?? 0;
      if (!p.caseIds.includes(e.caseId)) p.caseIds.push(e.caseId);
    }
    return [...map.values()];
  }, [world, revision]);

  const register = useMemo(() => {
    const q = query.trim().toLowerCase();
    return parties.filter((p) => {
      if (p.provenance === 'synthetic') return false;
      if (q && !`${p.name} ${p.vessel?.imo ?? ''} ${p.vessel?.mmsiNumber ?? ''} ${p.vessel?.flag ?? ''} ${p.vessel?.operator ?? ''} ${p.actions.map((a) => a.party).join(' ')}`.toLowerCase().includes(q)) return false;
      if (kindFilter !== 'all' && p.kind !== kindFilter) return false;
      return true;
    }).sort((a, b) => b.penalties - a.penalties || b.actions.length - a.actions.length);
  }, [parties, query, kindFilter]);

  const synthetic = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.vessels
      .filter((v) => v.provenance === 'synthetic' && registryPrior(v).total > 0)
      .filter((v) => !q || `${v.name} ${v.mmsiNumber} ${v.flag} ${v.type}`.toLowerCase().includes(q))
      .map((v) => ({ vessel: v, prior: registryPrior(v) }))
      .sort((a, b) => b.prior.total - a.prior.total);
  }, [world.vessels, query]);

  useEffect(() => {
    if (selectedMmsi && parties.some((p) => p.key === selectedMmsi)) setSelectedKey(selectedMmsi);
  }, [selectedMmsi, parties]);

  const selected = parties.find((p) => p.key === selectedKey) ?? register[0] ?? null;

  const stats = useMemo(() => ({
    parties: register.length,
    withAction: register.filter((p) => p.actions.some((a) => a.provenance === 'real')).length,
    penalties: register.reduce((s, p) => s + p.actions.filter((a) => a.provenance === 'real').reduce((x, a) => x + (a.amountInr ?? 0), 0), 0),
    unverified: register.filter((p) => p.vessel && !p.vessel.registryVerified && !p.vessel.isFacility).length,
  }), [register]);

  const byAuthority = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of world.enforcement) m.set(e.authority, (m.get(e.authority) ?? 0) + 1);
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [world.enforcement, revision]);

  const byAction = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of world.enforcement) m.set(e.type, (m.get(e.type) ?? 0) + 1);
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [world.enforcement, revision]);

  const columns: Column<Party>[] = [
    {
      key: 'name', header: 'Party', value: (p) => p.name,
      render: (p) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-gray-900 truncate">{p.name}</span>
            <ProvenanceBadge p={p.provenance} />
            {p.vessel?.sanctioned && <Badge tone="slate"><Ban className="w-2.5 h-2.5" /> SANCTIONED</Badge>}
          </div>
          <div className="text-[9.5px] text-gray-500 font-mono">{p.vessel ? fmt.vesselId(p.vessel) : p.actions[0]?.outcome ?? '—'}</div>
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', width: '104px', value: (p) => p.kind, render: (p) => <Badge tone={p.kind === 'Vessel' ? 'blue' : p.kind === 'Facility' ? 'violet' : 'gray'}>{p.kind}</Badge> },
    { key: 'flag', header: 'Flag / operator', width: '160px', value: (p) => p.vessel?.flag ?? p.vessel?.operator ?? '', render: (p) => <span className="text-gray-700 text-[10.5px]">{[p.vessel?.flag, p.vessel?.operator].filter(Boolean).join(' · ') || '—'}</span> },
    {
      key: 'source', header: 'Reported source', width: '100px', align: 'center', value: (p) => (p.reportedSource ? 1 : 0),
      render: (p) => p.reportedSource ? <Badge tone="amber">Yes</Badge> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'actions', header: 'Legal actions', width: '96px', align: 'center', value: (p) => p.actions.length,
      render: (p) => p.actions.length > 0 ? <Badge tone="blue">{p.actions.length}</Badge> : <span className="text-gray-400 text-[10px]">none published</span>,
    },
    {
      key: 'penalty', header: 'Penalties', width: '96px', align: 'right', value: (p) => p.penalties,
      render: (p) => p.penalties > 0 ? <span className="font-mono font-bold text-gray-900">{fmt.inr(p.penalties)}</span> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'registry', header: 'Registry history', width: '118px', value: (p) => (p.vessel?.registryVerified ? 1 : 0),
      render: (p) => p.vessel && !p.vessel.isFacility
        ? <Badge tone={p.vessel.registryVerified ? 'green' : 'gray'}>{p.vessel.registryVerified ? 'Verified' : 'Not verified'}</Badge>
        : <span className="text-gray-300">n/a</span>,
    },
  ];

  const syntheticColumns: Column<{ vessel: Vessel; prior: ReturnType<typeof registryPrior> }>[] = [
    {
      key: 'name', header: 'Synthetic vessel', value: (r) => r.vessel.name,
      render: (r) => (
        <div>
          <div className="flex items-center gap-1.5"><span className="font-bold text-gray-900">{r.vessel.name}</span><ProvenanceBadge p="synthetic" /></div>
          <div className="text-[9.5px] text-gray-500 font-mono">{fmt.vesselId(r.vessel)} · case {r.vessel.caseId}</div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', width: '120px', value: (r) => r.vessel.type },
    { key: 'flag', header: 'Flag', width: '130px', value: (r) => r.vessel.flag ?? '', render: (r) => <span>{r.vessel.flag ?? '—'}{r.vessel.flagRisk && r.vessel.flagRisk !== 'Standard' ? <span className="text-[9px] text-amber-700 ml-1">({r.vessel.flagRisk})</span> : null}</span> },
    { key: 'priors', header: 'Priors', width: '60px', align: 'center', value: (r) => r.vessel.priorOffences },
    { key: 'psc', header: 'Detentions', width: '80px', align: 'center', value: (r) => r.vessel.pscDetentions ?? 0 },
    {
      key: 'boost', header: 'Prior → score', width: '120px', align: 'right', value: (r) => r.prior.total,
      render: (r) => (
        <div className="flex items-center gap-1.5 justify-end">
          <div className="w-10 h-1.5 bg-gray-200 rounded overflow-hidden"><div className="h-full bg-violet-500" style={{ width: `${r.prior.total * 100}%` }} /></div>
          <span className="font-mono font-bold text-violet-700 w-10 text-right">+{(r.prior.total * weights.vesselPrior * 100).toFixed(1)}</span>
        </div>
      ),
    },
  ];

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-gray-50">
      <div className="bg-white border-b-2 border-blue-600 px-4 py-3 flex items-center justify-between gap-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-blue-50 text-blue-700 p-2 rounded"><Shield className="w-5 h-5" /></div>
          <div>
            <h2 className="font-bold text-gray-900 text-base">Liability register</h2>
            <p className="text-xs text-gray-500">Parties in Indian oil pollution incidents and their published legal outcomes</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Name, IMO, MMSI, flag, operator…" className="w-64" />
          <Select value={kindFilter} onChange={setKindFilter}
            options={[{ value: 'all', label: 'All parties' }, ...['Vessel', 'Facility', 'Company / crew'].map((k) => ({ value: k, label: k }))]} />
          <ExportButton onExport={() => (tab === 'synthetic'
            ? downloadCsv('oceanspill-synthetic-watchlist.csv', syntheticColumns.filter((c) => c.value), synthetic)
            : downloadCsv('oceanspill-liability-register.csv', columns.filter((c) => c.value), register))} label="Export" />
        </div>
      </div>

      <div className="px-4 py-3 grid grid-cols-4 gap-3 flex-shrink-0">
        <StatCard icon={<Ship className="w-5 h-5" />} title="Parties on register" value={stats.parties} trend="reported sources and legal parties" />
        <StatCard icon={<Scale className="w-5 h-5" />} title="With published action" value={stats.withAction} trend="court, NGT, police or regulator" accent="red" />
        <StatCard icon={<Building2 className="w-5 h-5" />} title="Published penalties" value={fmt.inr(stats.penalties)} trend="as reported, not recovery status" accent="amber" />
        <StatCard icon={<Flag className="w-5 h-5" />} title="Registry unverified" value={stats.unverified} trend="needs DG Shipping / Equasis" />
      </div>

      <div className="flex-1 min-h-0 flex gap-3 px-4 pb-4">
        <div className="flex-1 min-w-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: 'register', label: 'Register', count: register.length },
            { id: 'analysis', label: 'Legal outcomes' },
            { id: 'synthetic', label: 'Synthetic watch list', count: synthetic.length },
          ]} className="px-2" />
          {tab === 'register' && (
            <div className="flex-1 min-h-0">
              <DataTable columns={columns} rows={register} rowKey={(p) => p.key} dense
                selectedId={selected?.key} onRowClick={(p) => { setSelectedKey(p.key); if (p.vessel) setSelectedMmsi(p.vessel.mmsi); }}
                initialSort={{ key: 'penalty', dir: 'desc' }}
                empty="No parties match the current filters." />
            </div>
          )}
          {tab === 'analysis' && (
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              <div>
                <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">Actions by authority</h4>
                <BarChart horizontal data={byAuthority} />
              </div>
              <div>
                <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">Actions by type</h4>
                <BarChart horizontal data={byAction} />
              </div>
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-gray-700 uppercase">All recorded actions</h4>
                {world.enforcement.map((e) => (
                  <div key={e.id} className="border border-gray-200 rounded p-2 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-gray-900">{e.party}</span>
                        <Badge tone={e.type === 'Fine Issued' ? 'red' : 'blue'}>{e.type}</Badge>
                        <ProvenanceBadge p={e.provenance} />
                      </div>
                      <p className="text-[10px] text-gray-600">{e.authority}{e.outcome ? ` · ${e.outcome}` : ''}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {e.amountInr ? <p className="text-[11px] font-mono font-bold text-gray-900">{fmt.inr(e.amountInr)}</p> : null}
                      {e.source && <a href={e.source} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline inline-flex items-center gap-0.5"><ExternalLink className="w-2.5 h-2.5" /> source</a>}
                    </div>
                  </div>
                ))}
              </div>
              <InfoBanner tone="amber" icon={<Scale className="w-3.5 h-3.5" />}>
                Amounts are as reported in the cited orders or news coverage. Appeal and recovery status is not tracked.
              </InfoBanner>
            </div>
          )}
          {tab === 'synthetic' && (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="p-2">
                <InfoBanner tone="amber" icon={<TrendingUp className="w-3.5 h-3.5" />}>
                  <b>Synthetic.</b> These vessels and their registry histories are generated so the registry prior in attribution
                  scoring has something to act on. Weight is {weights.vesselPrior}, so the maximum prior adds {(weights.vesselPrior * 100).toFixed(0)} points of 100.
                </InfoBanner>
              </div>
              <div className="flex-1 min-h-0">
                <DataTable columns={syntheticColumns} rows={synthetic} rowKey={(r) => r.vessel.mmsi} dense
                  onRowClick={(r) => navigate({ tab: 'Vessel Analysis', mmsi: r.vessel.mmsi })} initialSort={{ key: 'boost', dir: 'desc' }} />
              </div>
            </div>
          )}
        </div>

        <div className="w-[370px] flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
          {!selected ? (
            <EmptyState icon={<Shield className="w-10 h-10" />} title="No party selected" />
          ) : (
            <>
              <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <h3 className="font-bold text-gray-900 text-sm truncate">{selected.name}</h3>
                    <p className="text-[10px] text-gray-500 font-mono">{selected.vessel ? fmt.vesselId(selected.vessel) : selected.kind}</p>
                  </div>
                  <ProvenanceBadge p={selected.provenance} />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {selected.vessel && (
                  <KeyValue cols={2} items={[
                    ['Kind', selected.kind], ['Type', selected.vessel.type],
                    ['Flag', selected.vessel.flag ?? '—'], ['Operator', selected.vessel.operator ?? 'Not published'],
                    ['Sanctions', selected.vessel.sanctionsChecked ? (selected.vessel.sanctioned ? 'Listed' : 'Not listed (UNSC)') : 'Not checked'],
                    ['PSC detentions', selected.vessel.pscDetentions != null ? String(selected.vessel.pscDetentions) : 'Needs Equasis'],
                  ]} />
                )}
                {selected.vessel?.note && <p className="text-[10px] text-gray-500 leading-snug">{selected.vessel.note}</p>}

                {selected.vessel?.sanctioned && (
                  <InfoBanner tone="red" icon={<Ban className="w-3.5 h-3.5" />}>
                    Listed on {selected.vessel.sanctionsList}. Coordinate with MEA before any public attribution.
                  </InfoBanner>
                )}

                {selected.vessel && !selected.vessel.isFacility && (() => {
                  const prior = registryPrior(selected.vessel);
                  const applied = selected.vessel.provenance === 'synthetic' || selected.vessel.registryVerified;
                  return (
                    <div className="bg-violet-50 border border-violet-200 rounded p-2.5">
                      <p className="text-[10px] font-bold text-violet-900 uppercase mb-1.5">Contribution to attribution scoring</p>
                      <ScoreBar label="Registry prior (raw)" value={applied ? prior.total : 0} tone="violet" />
                      <div className="mt-2 space-y-1 text-[10px] text-violet-800">
                        {!applied && <p>Registry history not verified, so no prior is applied.</p>}
                        {applied && prior.parts.map((p) => <Row key={p.label} label={p.label} value={`+${p.value.toFixed(2)}`} />)}
                      </div>
                      <div className="mt-2 pt-2 border-t border-violet-200 flex justify-between text-[10px]">
                        <span className="font-semibold text-violet-900">Effective score contribution</span>
                        <span className="font-mono font-black text-violet-900">+{((applied ? prior.total : 0) * weights.vesselPrior * 100).toFixed(1)} of 100</span>
                      </div>
                    </div>
                  );
                })()}

                <div>
                  <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Cases</p>
                  <div className="space-y-1.5">
                    {selected.caseIds.map((id) => {
                      const c = world.cases.find((x) => x.id === id);
                      const h = world.historical.find((x) => x.id === id);
                      const score = c && selected.vessel ? getAnalysis(c.id)?.ranked.find((r) => r.mmsi === selected.vessel!.mmsi) : undefined;
                      return (
                        <button key={id} onClick={() => (c ? navigate({ tab: 'Investigation', caseId: c.id }) : navigate({ tab: 'Case Archive', section: 'historical' }))}
                          className="w-full text-left border border-gray-200 rounded p-2 hover:border-blue-400 hover:bg-blue-50/40">
                          <div className="flex justify-between items-start gap-2">
                            <div className="min-w-0">
                              <p className="text-[10.5px] font-bold text-gray-900">{c?.title ?? h?.name ?? id}</p>
                              <p className="text-[9.5px] text-gray-500 truncate">{c?.subRegion ?? h?.location}</p>
                              <p className="text-[9px] text-gray-400">{c ? fmt.precise(c.incidentTime, c.facts.incident.timePrecision) : h?.date}</p>
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
                </div>

                <div>
                  <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Legal and regulatory actions</p>
                  {selected.actions.length === 0 ? (
                    <p className="text-[10.5px] text-gray-500">No action found in the public record.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {selected.actions.map((a) => (
                        <div key={a.id} className="border border-gray-200 rounded p-2">
                          <div className="flex justify-between items-start gap-2 mb-1">
                            <Badge tone={a.type === 'Fine Issued' ? 'red' : 'blue'}>{a.type}</Badge>
                            <div className="flex gap-1"><Badge tone={a.status === 'Concluded' ? 'green' : a.status === 'Reported' ? 'blue' : 'amber'}>{a.status}</Badge><ProvenanceBadge p={a.provenance} /></div>
                          </div>
                          <p className="text-[9.5px] text-gray-600">{a.authority} → {a.party}</p>
                          {a.amountInr ? <p className="text-[10px] font-bold text-gray-900 mt-0.5">{fmt.inr(a.amountInr)}</p> : null}
                          {a.outcome && <p className="text-[9.5px] text-gray-600 mt-1 leading-snug">{a.outcome}</p>}
                          {a.source && <a href={a.source} target="_blank" rel="noreferrer" className="text-[9.5px] text-blue-600 hover:underline">Source</a>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="p-2.5 border-t border-gray-200 flex gap-2">
                <Button size="sm" className="flex-1 justify-center" disabled={!selected.vessel} onClick={() => selected.vessel && navigate({ tab: 'Vessel Analysis', mmsi: selected.vessel.mmsi })} icon={<Ship className="w-3 h-3" />}>
                  Track
                </Button>
                <Button size="sm" variant="primary" className="flex-1 justify-center" onClick={() => setActionFor(selected.key)} icon={<Building2 className="w-3 h-3" />}>
                  Record action
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <RegulatoryActionModal open={!!actionFor} onClose={() => setActionFor(null)} party={parties.find((p) => p.key === actionFor) ?? null} />
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><span>{label}</span><span className="font-mono font-semibold">{value}</span></div>;
}

function RegulatoryActionModal({ open, onClose, party }: { open: boolean; onClose: () => void; party: Party | null }) {
  const { world, addEnforcement, now } = useStore();
  const [type, setType] = useState<EnforcementAction['type']>('Inspection Ordered');
  const [caseId, setCaseId] = useState('');
  const [notes, setNotes] = useState('');

  const relatedCases = useMemo(() => {
    if (!party) return [];
    const ids = new Set(party.caseIds);
    if (party.vessel) world.cases.filter((c) => c.candidateMmsis.includes(party.vessel!.mmsi)).forEach((c) => ids.add(c.id));
    return world.cases.filter((c) => ids.has(c.id));
  }, [party, world.cases]);

  useEffect(() => { setCaseId(relatedCases[0]?.id ?? ''); }, [party?.key, relatedCases.length]);

  if (!party) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Record action — ${party.name}`}
      subtitle="Recorded in this session only; it does not represent an issued order."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!caseId} onClick={() => {
            addEnforcement({
              caseId, mmsi: party.vessel?.mmsi ?? '', party: party.name, type, issuedAt: now,
              authority: 'DG Shipping', reference: null, status: 'Pending', outcome: notes.trim() || undefined,
            });
            setNotes('');
            onClose();
          }}>Record</Button>
        </>
      }>
      <div className="space-y-3">
        <Field label="Related case">
          <Select value={caseId} onChange={setCaseId}
            options={relatedCases.map((c) => ({ value: c.id, label: c.title }))} />
        </Field>
        {relatedCases.length === 0 && <p className="text-[10.5px] text-amber-700">This party has no analysed case to attach an action to.</p>}
        <Field label="Action">
          <Select value={type} onChange={(v) => setType(v as EnforcementAction['type'])}
            options={['Inspection Ordered', 'Detention', 'Fine Issued', 'Insurance Flagged', 'Blacklist Recommended', 'Prosecution Referred'].map((t) => ({ value: t, label: t }))} />
        </Field>
        <Field label="Notes"><TextArea value={notes} onChange={setNotes} rows={3} placeholder="Basis for the action and any conditions attached…" /></Field>
        <InfoBanner tone="blue" icon={<Flag className="w-3.5 h-3.5" />}>
          In a deployment a confirmed action would feed the registry prior used in future attribution. Session records do not change the prior.
        </InfoBanner>
      </div>
    </Modal>
  );
}
