import { useMemo, useState } from 'react';
import {
  Settings, Users, Shield, Database, Server, Activity, Key, HardDrive, Lock,
  Plus, Check, X, AlertTriangle, Info, Cpu, Globe,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import {
  Badge, Button, KeyValue, DataTable, SearchInput, Select, InfoBanner, Modal, Field,
  TextInput, StatCard, Toggle, ExportButton, downloadCsv, type Column,
} from './components/ui';
import { MODEL_METRICS } from './engine/detection';
import { DEFAULT_WEIGHTS } from './engine/attribution';
import type { SystemUser } from './data/types';

const SECTIONS = [
  { id: 'users', label: 'User management', icon: Users },
  { id: 'roles', label: 'Roles & permissions', icon: Shield },
  { id: 'sources', label: 'Data source configuration', icon: Database },
  { id: 'infra', label: 'Infrastructure & hosting', icon: Server },
  { id: 'models', label: 'Model registry', icon: Cpu },
  { id: 'audit', label: 'Access log', icon: Lock },
  { id: 'health', label: 'System health', icon: Activity },
];

const MODULES = [
  'Dashboard & incidents', 'Investigation tools', 'Vessel analysis', 'Environmental data',
  'Satellite tasking', 'Ecological planning', 'Community alerting', 'Workflow & enforcement',
  'Offender registry', 'Reports & analytics', 'IMAC integration', 'Case archive', 'System administration',
];

const ROLE_MATRIX: Record<string, Record<string, 'full' | 'read' | 'none'>> = {
  'NTRO Admin': Object.fromEntries(MODULES.map((m) => [m, 'full'])),
  'NTRO Reviewer': Object.fromEntries(MODULES.map((m) => [m, m === 'System administration' ? 'read' : 'full'])),
  Analyst: Object.fromEntries(MODULES.map((m) => [m,
    ['System administration', 'IMAC integration'].includes(m) ? 'none' : 'full'])),
  Regulator: Object.fromEntries(MODULES.map((m) => [m,
    ['Offender registry', 'Workflow & enforcement'].includes(m) ? 'full'
    : ['Dashboard & incidents', 'Reports & analytics', 'Case archive'].includes(m) ? 'read' : 'none'])),
  Liaison: Object.fromEntries(MODULES.map((m) => [m,
    m === 'IMAC integration' ? 'full'
    : ['Dashboard & incidents', 'Investigation tools', 'Workflow & enforcement', 'Case archive'].includes(m) ? 'read' : 'none'])),
  'Data Operator': Object.fromEntries(MODULES.map((m) => [m,
    ['Environmental data', 'Satellite tasking'].includes(m) ? 'full'
    : ['Dashboard & incidents', 'Reports & analytics'].includes(m) ? 'read' : 'none'])),
  Viewer: Object.fromEntries(MODULES.map((m) => [m,
    ['Dashboard & incidents', 'Ecological planning', 'Reports & analytics', 'Case archive'].includes(m) ? 'read' : 'none'])),
};

export default function SystemAdministration() {
  const { world, now, currentUser, addUser, updateUser, notify, revision } = useStore();
  const [section, setSection] = useState('users');
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [addOpen, setAddOpen] = useState(false);

  const restricted = !['NTRO Admin', 'NTRO Reviewer'].includes(currentUser.role);

  const users = useMemo(() => {
    const q = query.trim().toLowerCase();
    return world.users.filter((u) => {
      if (q && !`${u.name} ${u.email} ${u.role} ${u.agency}`.toLowerCase().includes(q)) return false;
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      return true;
    });
  }, [world.users, query, roleFilter, revision]);

  const userColumns: Column<SystemUser>[] = [
    {
      key: 'name', header: 'User', value: (u) => u.name,
      render: (u) => (
        <div>
          <div className="font-bold text-gray-900">{u.name}</div>
          <div className="text-[9.5px] text-gray-500">{u.email}</div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', width: '124px', value: (u) => u.role, render: (u) => <Badge tone={u.role.startsWith('NTRO') ? 'violet' : 'blue'}>{u.role}</Badge> },
    { key: 'agency', header: 'Agency', width: '160px', value: (u) => u.agency, render: (u) => <span className="text-gray-700">{u.agency}</span> },
    {
      key: 'clearance', header: 'Clearance', width: '104px', value: (u) => u.clearance,
      render: (u) => <Badge tone={u.clearance === 'Secret' ? 'red' : u.clearance === 'Confidential' ? 'amber' : 'gray'}>{u.clearance}</Badge>,
    },
    {
      key: 'mfa', header: 'MFA', width: '62px', align: 'center', value: (u) => (u.mfa ? 1 : 0),
      render: (u) => u.mfa
        ? <Check className="w-3.5 h-3.5 text-emerald-600 mx-auto" strokeWidth={3} />
        : <X className="w-3.5 h-3.5 text-red-500 mx-auto" strokeWidth={3} />,
    },
    {
      key: 'status', header: 'Status', width: '92px', value: (u) => u.status,
      render: (u) => <Badge tone={u.status === 'Active' ? 'green' : u.status === 'Suspended' ? 'red' : 'amber'}>{u.status}</Badge>,
    },
    {
      key: 'login', header: 'Last sign-in', width: '130px', value: (u) => u.lastLogin,
      render: (u) => u.lastLogin ? <div><div className="font-mono text-gray-700">{fmt.utcShort(u.lastLogin)}</div><div className="text-[9px] text-gray-400">{fmt.ago(u.lastLogin, now)}</div></div> : <span className="text-gray-300">Never</span>,
    },
    {
      key: 'actions', header: '', width: '150px', sortable: false,
      render: (u) => (
        <div className="flex gap-1">
          <Button size="sm" disabled={restricted} onClick={() => {
            updateUser(u.id, { status: u.status === 'Active' ? 'Suspended' : 'Active' });
            notify({ kind: 'info', title: `${u.name} ${u.status === 'Active' ? 'suspended' : 'reactivated'}` });
          }}>{u.status === 'Active' ? 'Suspend' : 'Activate'}</Button>
          <Button size="sm" disabled={restricted || u.mfa} onClick={() => {
            updateUser(u.id, { mfa: true });
            notify({ kind: 'success', title: 'MFA enforced', body: `${u.name} must enrol at next sign-in.` });
          }}>Force MFA</Button>
        </div>
      ),
    },
  ];

  const accessLog = useMemo(() => world.audit.filter((e) => e.category === 'Access' || e.category === 'System'), [world.audit, revision]);

  return (
    <main className="flex-1 min-h-0 flex overflow-hidden">
      <aside className="w-[250px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Settings className="w-4 h-4 text-blue-600" /> System administration</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">Users, sources, infrastructure</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-1">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button key={s.id} onClick={() => setSection(s.id)}
                className={`w-full text-left px-3 py-2 text-[11.5px] font-semibold flex items-center gap-2.5 border-l-[3px] ${
                  section === s.id ? 'bg-blue-50 text-blue-700 border-l-blue-600' : 'text-gray-600 hover:bg-gray-50 border-l-transparent'
                }`}>
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />{s.label}
              </button>
            );
          })}
        </nav>
        <div className="p-2.5 border-t border-gray-200">
          <div className="bg-gray-50 border border-gray-200 rounded p-2">
            <p className="text-[9.5px] font-bold text-gray-600 uppercase mb-1">Signed in as</p>
            <p className="text-[11px] font-bold text-gray-900">{currentUser.name}</p>
            <p className="text-[10px] text-gray-500">{currentUser.role} · {currentUser.clearance}</p>
          </div>
        </div>
      </aside>

      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {restricted && (
          <div className="px-3 pt-3">
            <InfoBanner tone="amber" icon={<Lock className="w-3.5 h-3.5" />}>
              You are signed in as <b>{currentUser.role}</b>. This page is visible in read-only form; changes
              require an NTRO Admin or NTRO Reviewer role.
            </InfoBanner>
          </div>
        )}

        {section === 'users' && (
          <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
            <div className="grid grid-cols-4 gap-3">
              <StatCard icon={<Users className="w-5 h-5" />} title="Total users" value={world.users.length} trend={`${world.users.filter((u) => u.status === 'Active').length} active`} />
              <StatCard icon={<Shield className="w-5 h-5" />} title="MFA enrolled" value={world.users.filter((u) => u.mfa).length}
                trend={`${world.users.filter((u) => !u.mfa).length} without MFA`} accent={world.users.some((u) => !u.mfa) ? 'amber' : 'green'} />
              <StatCard icon={<Globe className="w-5 h-5" />} title="Agencies" value={new Set(world.users.map((u) => u.agency)).size} trend="with federated access" />
              <StatCard icon={<Lock className="w-5 h-5" />} title="Secret clearance" value={world.users.filter((u) => u.clearance === 'Secret').length}
                trend="full raw-imagery access" accent="red" />
            </div>

            <div className="flex gap-2">
              <SearchInput value={query} onChange={setQuery} placeholder="Name, email, role or agency…" className="flex-1" />
              <Select value={roleFilter} onChange={setRoleFilter}
                options={[{ value: 'all', label: 'All roles' }, ...Array.from(new Set(world.users.map((u) => u.role))).map((r) => ({ value: r, label: r }))]} />
              <ExportButton onExport={() => downloadCsv('oceanwatch-users.csv', userColumns.filter((c) => c.value), users)} />
              <Button size="sm" variant="primary" disabled={restricted} onClick={() => setAddOpen(true)} icon={<Plus className="w-3 h-3" />}>Add user</Button>
            </div>

            <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
              <DataTable columns={userColumns} rows={users} rowKey={(u) => u.id} dense initialSort={{ key: 'login', dir: 'desc' }} />
            </div>

            {world.users.some((u) => !u.mfa && u.status === 'Active') && (
              <InfoBanner tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
                {world.users.filter((u) => !u.mfa && u.status === 'Active').length} active account(s) have no
                second factor. For a system holding vessel-attribution material, MFA should be mandatory rather
                than optional.
              </InfoBanner>
            )}
          </div>
        )}

        {section === 'roles' && (
          <div className="flex-1 overflow-auto p-3 space-y-3">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <h3 className="text-[11px] font-bold text-gray-700">Role permission matrix</h3>
                <p className="text-[9.5px] text-gray-500">What each role can reach. Navigation adapts automatically when a role is switched.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10.5px]">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-3 py-2 font-bold text-gray-600 uppercase text-[9.5px] sticky left-0 bg-gray-50">Module</th>
                      {Object.keys(ROLE_MATRIX).map((r) => (
                        <th key={r} className="px-2 py-2 font-bold text-gray-600 text-[9.5px] whitespace-nowrap">{r}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {MODULES.map((m) => (
                      <tr key={m} className="hover:bg-gray-50">
                        <td className="px-3 py-1.5 font-semibold text-gray-800 sticky left-0 bg-white">{m}</td>
                        {Object.keys(ROLE_MATRIX).map((r) => {
                          const lvl = ROLE_MATRIX[r][m];
                          return (
                            <td key={r} className="px-2 py-1.5 text-center">
                              {lvl === 'full' ? <Check className="w-3.5 h-3.5 text-emerald-600 mx-auto" strokeWidth={3} />
                                : lvl === 'read' ? <span className="text-[9px] font-bold text-amber-600">READ</span>
                                : <span className="text-gray-200">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
              A DG Shipping regulator never sees raw SAR imagery or investigation tools. This is not only access
              control — it limits how widely the sensing capability itself is exposed, which matters when the
              resolution and revisit characteristics of the platforms are themselves sensitive.
            </InfoBanner>
          </div>
        )}

        {section === 'sources' && (
          <div className="flex-1 overflow-auto p-3 space-y-2">
            {world.dataSources.map((d) => (
              <div key={d.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
                <div className="flex justify-between items-start gap-3 mb-2">
                  <div className="min-w-0">
                    <h4 className="text-[12px] font-bold text-gray-900">{d.name}</h4>
                    <p className="text-[10px] text-gray-500 font-mono break-all">{d.endpoint}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Badge tone="gray">{d.kind}</Badge>
                    <Badge tone={d.status === 'Online' ? 'green' : d.status === 'Degraded' ? 'amber' : 'red'}>{d.status}</Badge>
                  </div>
                </div>
                <KeyValue cols={4} items={[
                  ['Provider', d.provider], ['Auth', d.authMode],
                  ['Latency', `${fmt.num(d.latencyMs)} ms`], ['Rate', d.recordsPerMin > 0 ? `${fmt.num(d.recordsPerMin)}/min` : '—'],
                  ['Last sync', fmt.ago(d.lastSync, now)], ['Quota used', `${d.quotaUsedPct}%`],
                ]} />
                {d.quotaUsedPct > 75 && (
                  <p className="text-[10px] text-amber-700 mt-1.5 flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3" /> Approaching quota. Exhaustion here silently degrades
                    attribution quality rather than producing a visible error.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {section === 'infra' && (
          <div className="flex-1 overflow-auto p-3 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <StatCard icon={<Server className="w-5 h-5" />} title="Hosting" value="MeghRaj" trend="NIC Government Cloud" />
              <StatCard icon={<HardDrive className="w-5 h-5" />} title="Data residency" value="India" trend="all data at rest in-country" accent="green" />
              <StatCard icon={<Cpu className="w-5 h-5" />} title="Inference" value="On-premises" trend="imagery never leaves the enclave" accent="green" />
            </div>
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
              <h4 className="text-[11px] font-bold text-gray-700 uppercase mb-2">Deployment configuration</h4>
              <KeyValue cols={2} items={[
                ['Primary region', 'NIC Data Centre, Delhi'],
                ['Disaster recovery', 'NIC Data Centre, Hyderabad'],
                ['Object storage', 'NIC S3-compatible, AES-256 at rest'],
                ['Database', 'PostgreSQL 16 + PostGIS 3.4'],
                ['Time-series store', 'TimescaleDB (AIS ingest)'],
                ['Inference runtime', 'ONNX Runtime, CUDA 12 · 2× A100'],
                ['Network', 'NICNET, no public ingress'],
                ['Transport security', 'mTLS between all services'],
                ['Backup schedule', 'Hourly incremental, daily full, 7-year retention'],
                ['Recovery objective', 'RPO 1 h · RTO 4 h'],
              ]} />
            </div>
            <InfoBanner tone="green" icon={<Shield className="w-3.5 h-3.5" />}>
              Satellite imagery and AIS archives stay inside government infrastructure. Model inference runs
              on-premises rather than through a commercial API, because sending EEZ imagery to an external
              service would itself be the disclosure the system exists to prevent.
            </InfoBanner>
          </div>
        )}

        {section === 'models' && (
          <div className="flex-1 overflow-auto p-3 space-y-3">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h4 className="text-[12px] font-bold text-gray-900">Segmentation model</h4>
                  <p className="text-[10px] text-gray-500 font-mono">{MODEL_METRICS.version}</p>
                </div>
                <Badge tone="green">Deployed</Badge>
              </div>
              <KeyValue cols={2} items={[
                ['Architecture', MODEL_METRICS.architecture],
                ['Training corpus', MODEL_METRICS.trainedOn],
                ['Loss', MODEL_METRICS.loss],
                ['Input', MODEL_METRICS.input],
                ['Mean IoU', MODEL_METRICS.meanIou.toFixed(3)],
                ['Oil-class IoU', MODEL_METRICS.classes[1].iou.toFixed(3)],
                ['Inference', `${MODEL_METRICS.inferenceMsPerTile} ms/tile`],
                ['False positive rate', fmt.pct(MODEL_METRICS.falsePositiveRate)],
              ]} />
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
              <h4 className="text-[12px] font-bold text-gray-900 mb-2">Drift model</h4>
              <KeyValue cols={2} items={[
                ['Method', 'Lagrangian particle tracking'],
                ['Formulation', 'u = u_current + u_stokes + windage × u_wind + diffusion'],
                ['Windage default', '3.0% of 10 m wind'],
                ['Stokes drift', '1.2% of 10 m wind'],
                ['Diffusivity', '8 m²/s horizontal'],
                ['Ensemble', '12 members, perturbed windage and diffusivity'],
                ['Forcing — currents', 'INCOIS HOOFS'],
                ['Forcing — wind', 'IMD forecast grid'],
              ]} />
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
              <h4 className="text-[12px] font-bold text-gray-900 mb-2">Attribution scoring</h4>
              <KeyValue cols={2} items={[
                ['Form', 'Transparent weighted sum (not a learned ranker)'],
                ['Proximity weight', String(DEFAULT_WEIGHTS.proximity)],
                ['Temporality weight', String(DEFAULT_WEIGHTS.temporality)],
                ['Trajectory weight', String(DEFAULT_WEIGHTS.trajectory)],
                ['Behaviour weight', String(DEFAULT_WEIGHTS.behaviour)],
                ['Registry prior weight', String(DEFAULT_WEIGHTS.vesselPrior)],
                ['Window', 'Asymmetric — wider before the estimated release'],
              ]} />
              <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
                A weighted sum is used deliberately in place of a learned ranker. There are too few
                ground-truthed incident–vessel pairs to train one honestly, and an attribution that cannot be
                explained term by term cannot be defended when a named vessel disputes it.
              </InfoBanner>
            </div>
          </div>
        )}

        {section === 'audit' && (
          <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 flex-1 min-h-0 flex flex-col">
              <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg flex justify-between items-center">
                <h3 className="text-[11px] font-bold text-gray-700">Access and system log</h3>
                <span className="text-[10px] text-gray-500">{accessLog.length} entries</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {accessLog.map((e) => (
                  <div key={e.id} className="px-3 py-2 border-b border-gray-100 hover:bg-gray-50 flex gap-3">
                    <span className="font-mono text-[10px] text-gray-400 w-32 flex-shrink-0">{fmt.utc(e.t)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold text-gray-900">{e.action}</span>
                        <Badge tone={e.category === 'Access' ? 'violet' : 'gray'}>{e.category}</Badge>
                      </div>
                      <p className="text-[10px] text-gray-600">{e.detail}</p>
                      <p className="text-[9.5px] text-gray-400">{e.actor} · {e.role} · target {e.target}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {section === 'health' && (
          <div className="flex-1 overflow-auto p-3 space-y-3">
            <div className="grid grid-cols-4 gap-3">
              <StatCard icon={<Activity className="w-5 h-5" />} title="Services online"
                value={`${world.dataSources.filter((d) => d.status === 'Online').length}/${world.dataSources.length}`} trend="upstream connections" accent="green" />
              <StatCard icon={<Database className="w-5 h-5" />} title="Ingest rate"
                value={fmt.num(world.dataSources.reduce((s, d) => s + d.recordsPerMin, 0))} trend="records per minute" />
              <StatCard icon={<Key className="w-5 h-5" />} title="Active sessions" value={world.users.filter((u) => u.status === 'Active' && now - u.lastLogin < 12 * 3600_000).length} trend="in the last 12 hours" />
              <StatCard icon={<Server className="w-5 h-5" />} title="Uptime" value="99.94%" trend="rolling 30 days" accent="green" />
            </div>
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
              <h4 className="text-[11px] font-bold text-gray-700 uppercase mb-2">Component status</h4>
              <div className="space-y-2">
                {[
                  { name: 'Scene ingestion service', status: 'Healthy', detail: 'Last scene processed 6 min ago' },
                  { name: 'Segmentation inference', status: 'Healthy', detail: `${MODEL_METRICS.inferenceMsPerTile} ms per tile, queue empty` },
                  { name: 'Drift solver', status: 'Healthy', detail: 'Mean runtime 3.1 s per 12-member ensemble' },
                  { name: 'Attribution engine', status: 'Healthy', detail: 'Mean runtime 240 ms per case' },
                  { name: 'AIS ingest pipeline', status: 'Healthy', detail: `${fmt.num(world.dataSources.find((d) => d.id === 'DS-AIS-TER')?.recordsPerMin ?? 0)} msg/min, no backlog` },
                  { name: 'Ocean forcing sync', status: world.dataSources.find((d) => d.id === 'DS-INCOIS-WV')?.status === 'Degraded' ? 'Degraded' : 'Healthy', detail: 'Wave service latency above threshold' },
                  { name: 'SACHET alert gateway', status: 'Healthy', detail: 'Last publish acknowledged' },
                  { name: 'IMAC publisher', status: 'Healthy', detail: 'mTLS handshake nominal' },
                ].map((c) => (
                  <div key={c.name} className="flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.status === 'Healthy' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    <span className="text-[11px] font-semibold text-gray-800 w-52 flex-shrink-0">{c.name}</span>
                    <span className="text-[10px] text-gray-500 flex-1">{c.detail}</span>
                    <Badge tone={c.status === 'Healthy' ? 'green' : 'amber'}>{c.status}</Badge>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      <AddUserModal open={addOpen} onClose={() => setAddOpen(false)} onAdd={addUser} />
    </main>
  );
}

function AddUserModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (u: Omit<SystemUser, 'id'>) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<SystemUser['role']>('Analyst');
  const [agency, setAgency] = useState('Indian Coast Guard');
  const [clearance, setClearance] = useState<SystemUser['clearance']>('Restricted');
  const [mfa, setMfa] = useState(true);

  const submit = () => {
    onAdd({ name: name.trim(), email: email.trim(), role, agency, status: 'Pending', lastLogin: 0, mfa, clearance });
    setName(''); setEmail('');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add user" subtitle="The account is created in a pending state until first sign-in."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || !email.trim()} onClick={submit}>Create account</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Full name"><TextInput value={name} onChange={setName} placeholder="e.g. Cdr. A. Kulkarni" /></Field>
          <Field label="Official email"><TextInput value={email} onChange={setEmail} placeholder="name@agency.gov.in" /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <Select value={role} onChange={(v) => setRole(v as SystemUser['role'])}
              options={['NTRO Admin', 'NTRO Reviewer', 'Analyst', 'Regulator', 'Liaison', 'Data Operator', 'Viewer'].map((r) => ({ value: r, label: r }))} />
          </Field>
          <Field label="Agency">
            <Select value={agency} onChange={setAgency}
              options={['NTRO', 'Indian Coast Guard', 'Indian Navy (IMAC)', 'DG Shipping', 'MoEFCC', 'INCOIS', 'NCSCM', 'NRSC'].map((a) => ({ value: a, label: a }))} />
          </Field>
        </div>
        <Field label="Clearance" hint="Determines whether raw SAR imagery and vessel identities are visible.">
          <Select value={clearance} onChange={(v) => setClearance(v as SystemUser['clearance'])}
            options={['Restricted', 'Confidential', 'Secret'].map((c) => ({ value: c, label: c }))} />
        </Field>
        <Toggle checked={mfa} onChange={setMfa} label="Require multi-factor authentication at first sign-in" />
        <InfoBanner tone="blue" icon={<Shield className="w-3.5 h-3.5" />}>
          The role determines which pages appear in navigation. Switching the signed-in user from the header
          menu demonstrates this — a Regulator sees the offender registry but not investigation tools.
        </InfoBanner>
      </div>
    </Modal>
  );
}
