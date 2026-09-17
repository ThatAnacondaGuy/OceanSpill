import { useMemo, useState } from 'react';
import {
  Settings, Users, Shield, Database, Server, Activity, Key, Lock,
  Plus, Check, X, AlertTriangle, Info, Cpu, Globe,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import {
  Badge, Button, KeyValue, DataTable, SearchInput, Select, InfoBanner, Modal, Field,
  TextInput, StatCard, Toggle, ExportButton, downloadCsv, ProvenanceBadge, type Column,
} from './components/ui';
import { MODEL_STATUS, modelScoreLine } from './engine/detection';
import type { SystemUser } from './data/types';
import { MODULES, ROLE_MATRIX } from './data/access';
import { SetPasswordModal, resetUserMfa } from './components/AccountSecurity';

const SECTIONS = [
  { id: 'users', label: 'User management', icon: Users },
  { id: 'roles', label: 'Roles & permissions', icon: Shield },
  { id: 'sources', label: 'Data source configuration', icon: Database },
  { id: 'infra', label: 'Infrastructure & hosting', icon: Server },
  { id: 'models', label: 'Model registry', icon: Cpu },
  { id: 'audit', label: 'Access log', icon: Lock },
  { id: 'health', label: 'System health', icon: Activity },
];

// The matrix shown here is the one that controls navigation and editing across the app.
export default function SystemAdministration() {
  const { world, now, currentUser, addUser, updateUser, notify, revision, weights, getAnalysis, serverMode } = useStore();
  const [passwordFor, setPasswordFor] = useState<SystemUser | null>(null);
  const [section, setSection] = useState('users');
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [addOpen, setAddOpen] = useState(false);

  const { canEdit, resetSession } = useStore();
  const restricted = !canEdit('System Admin');

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
          <div className="text-[0.6875rem] text-gray-500">{u.email}</div>
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
      render: (u) => u.lastLogin ? <div><div className="font-mono text-gray-700">{fmt.utcShort(u.lastLogin)}</div><div className="text-[0.65625rem] text-gray-400">{fmt.ago(u.lastLogin, now)}</div></div> : <span className="text-gray-300">Never</span>,
    },
    {
      key: 'actions', header: '', width: serverMode ? '210px' : '150px', sortable: false,
      render: (u) => (
        <div className="flex gap-1">
          <Button size="sm" disabled={restricted} onClick={() => {
            updateUser(u.id, { status: u.status === 'Active' ? 'Suspended' : 'Active' });
            notify({ kind: 'info', title: `${u.name} ${u.status === 'Active' ? 'suspended' : 'reactivated'}` });
          }}>{u.status === 'Active' ? 'Suspend' : 'Activate'}</Button>
          {serverMode ? (
            <>
              <Button size="sm" disabled={restricted} onClick={() => setPasswordFor(u)}>Set password</Button>
              <Button size="sm" disabled={restricted || !u.mfa} onClick={() => {
                resetUserMfa(u.id)
                  .then(() => {
                    updateUser(u.id, { mfa: false });
                    notify({ kind: 'success', title: 'Two-factor reset', body: `${u.name} must enrol an authenticator app again.` });
                  })
                  .catch((e: Error) => notify({ kind: 'error', title: 'Not reset', body: e.message }));
              }}>Reset 2FA</Button>
            </>
          ) : (
            <Button size="sm" disabled={restricted || u.mfa} onClick={() => {
              updateUser(u.id, { mfa: true });
              notify({ kind: 'success', title: 'MFA enforced', body: `${u.name} must enrol at next sign-in.` });
            }}>Force MFA</Button>
          )}
        </div>
      ),
    },
  ];

  const accessLog = useMemo(() => world.audit.filter((e) => e.category === 'Access' || e.category === 'System'), [world.audit, revision]);

  // Measured in this browser: engine runtime per case (hindcast ensemble, forecast, scoring).
  const runtimes = useMemo(() => world.cases.map((c) => ({ c, ms: getAnalysis(c.id)?.runtimeMs ?? null })), [world.cases, getAnalysis]);
  const meanRuntime = runtimes.filter((r) => r.ms != null).reduce((s, r, _, arr) => s + (r.ms ?? 0) / arr.length, 0);

  return (
    <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
      <aside className="w-full lg:w-[210px] xl:w-[250px] bg-white border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col flex-shrink-0 max-h-[46vh] lg:max-h-none">
        <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Settings className="w-4 h-4 text-blue-600" /> System administration</h2>
          <p className="text-[0.6875rem] text-gray-500 mt-0.5">Users, sources, infrastructure</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-1">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button key={s.id} onClick={() => setSection(s.id)}
                className={`w-full text-left px-3 py-2 text-[0.78125rem] font-semibold flex items-center gap-2.5 border-l-[3px] ${
                  section === s.id ? 'bg-blue-50 text-blue-700 border-l-blue-600' : 'text-gray-600 hover:bg-gray-50 border-l-transparent'
                }`}>
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />{s.label}
              </button>
            );
          })}
        </nav>
        <div className="p-3 border-t border-gray-200">
          <div className="bg-gray-50 border border-gray-200 rounded p-2">
            <p className="text-[0.6875rem] font-bold text-gray-600 uppercase mb-1">Signed in as</p>
            <p className="text-[0.75rem] font-bold text-gray-900">{currentUser.name}</p>
            <p className="text-[0.6875rem] text-gray-500">{currentUser.role} · {currentUser.clearance}</p>
          </div>
        </div>
      </aside>

      <section className="flex-1 min-w-0 min-h-[72vh] lg:min-h-0 flex flex-col flex-shrink-0 lg:flex-shrink overflow-hidden">
        {restricted && (
          <div className="px-3 pt-3">
            <InfoBanner tone="amber" icon={<Lock className="w-3.5 h-3.5" />}>
              You are signed in as <b>{currentUser.role}</b>, which has read-only access here. Changes need an NTRO Admin account.
            </InfoBanner>
          </div>
        )}

        {section === 'users' && (
          <div className="flex-1 min-h-0 flex flex-col p-4 gap-4">
            <InfoBanner tone="amber" icon={<Info className="w-3.5 h-3.5" />}>
              Sign-in is not yet connected to an identity provider; accounts are switched from the header menu. Deployment will use the agency single sign-on (Parichay).
            </InfoBanner>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={<Users className="w-5 h-5" />} title="Total users" value={world.users.length} trend={`${world.users.filter((u) => u.status === 'Active').length} active`} />
              <StatCard icon={<Shield className="w-5 h-5" />} title="MFA enrolled" value={world.users.filter((u) => u.mfa).length}
                trend={`${world.users.filter((u) => !u.mfa).length} without MFA`} accent={world.users.some((u) => !u.mfa) ? 'amber' : 'green'} />
              <StatCard icon={<Globe className="w-5 h-5" />} title="Agencies" value={new Set(world.users.map((u) => u.agency)).size} trend="with accounts" />
              <StatCard icon={<Lock className="w-5 h-5" />} title="Secret clearance" value={world.users.filter((u) => u.clearance === 'Secret').length}
                trend="clearance level" accent="red" />
            </div>

            <div className="flex gap-2">
              <SearchInput value={query} onChange={setQuery} placeholder="Name, email, role or agency…" className="flex-1" />
              <Select value={roleFilter} onChange={setRoleFilter}
                options={[{ value: 'all', label: 'All roles' }, ...Array.from(new Set(world.users.map((u) => u.role))).map((r) => ({ value: r, label: r }))]} />
              <ExportButton onExport={() => downloadCsv('oceanspill-users.csv', userColumns.filter((c) => c.value), users)} />
              <Button size="sm" variant="primary" disabled={restricted} onClick={() => setAddOpen(true)} icon={<Plus className="w-3 h-3" />}>Add user</Button>
            </div>

            <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-gray-200">
              <DataTable columns={userColumns} rows={users} rowKey={(u) => u.id} dense initialSort={{ key: 'login', dir: 'desc' }} />
            </div>

            {world.users.some((u) => !u.mfa && u.status === 'Active') && (
              <InfoBanner tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
                {world.users.filter((u) => !u.mfa && u.status === 'Active').length} active account(s) have no second factor. Enable MFA for every account.
              </InfoBanner>
            )}
          </div>
        )}

        {section === 'roles' && (
          <div className="flex-1 overflow-auto p-4 space-y-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <h3 className="text-[0.75rem] font-bold text-gray-700">Role permission matrix</h3>
                <p className="text-[0.6875rem] text-gray-500">What each role can reach. Navigation adapts automatically when a role is switched.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[0.71875rem]">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-3 py-2 font-bold text-gray-600 uppercase text-[0.6875rem] sticky left-0 bg-gray-50">Module</th>
                      {Object.keys(ROLE_MATRIX).map((r) => (
                        <th key={r} className="px-2 py-2 font-bold text-gray-600 text-[0.6875rem] whitespace-nowrap">{r}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {MODULES.map((m) => (
                      <tr key={m.id} className="hover:bg-gray-50">
                        <td className="px-3 py-1.5 font-semibold text-gray-800 sticky left-0 bg-white">{m.label}</td>
                        {Object.keys(ROLE_MATRIX).map((r) => {
                          const lvl = ROLE_MATRIX[r][m.id];
                          return (
                            <td key={r} className="px-2 py-1.5 text-center">
                              {lvl === 'full' ? <Check className="w-3.5 h-3.5 text-emerald-600 mx-auto" strokeWidth={3} />
                                : lvl === 'read' ? <span className="text-[0.65625rem] font-bold text-amber-600">READ</span>
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
              Roles limit who sees raw SAR imagery and investigation tools; a DG Shipping regulator sees neither.
            </InfoBanner>
          </div>
        )}

        {section === 'sources' && (
          <div className="flex-1 overflow-auto p-4 space-y-3">
            <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
              Indian sources are listed first and used whenever they are available; foreign sources fill the gaps until then.
            </InfoBanner>
            {(['SAR', 'Metocean', 'AIS', 'Registry', 'Sanctions', 'Alerting', 'Operating picture'] as const).map((kind) => (
              <div key={kind}>
                <p className="text-[0.6875rem] font-bold text-gray-500 uppercase mt-2 mb-1">{kind}</p>
                {world.dataSources.filter((d) => d.kind === kind).map((d) => (
                  <div key={d.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-2">
                    <div className="flex justify-between items-start gap-3 mb-1">
                      <div className="min-w-0">
                        <h4 className="text-[0.75rem] font-bold text-gray-900">{d.name}</h4>
                        <p className="text-[0.6875rem] text-gray-500">{d.agency}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Badge tone={d.sovereign ? 'green' : 'gray'}>{d.sovereign ? 'Indian' : 'Foreign'}</Badge>
                        <Badge tone={d.role === 'primary' ? 'blue' : 'slate'}>{d.role}</Badge>
                        <Badge tone={d.status === 'Online' ? 'green' : d.status === 'Interim fallback' ? 'teal' : d.status === 'Not configured' ? 'amber' : 'gray'}>{d.status}</Badge>
                      </div>
                    </div>
                    <p className="text-[0.71875rem] text-gray-600 leading-normal">{d.message}</p>
                    <p className="text-[0.6875rem] text-gray-400 mt-1">{d.lastSync != null ? `Used in pipeline build ${fmt.ago(d.lastSync, now)}` : 'Not used in the current build'}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {section === 'infra' && (
          <div className="flex-1 overflow-auto p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <h4 className="text-[0.75rem] font-bold text-gray-700 uppercase mb-2 flex items-center gap-2">Current setup</h4>
                <KeyValue cols={1} items={[
                  ['Application', 'Web application served as a static site'],
                  ['Data processing', 'Scheduled pipeline that fetches SAR catalogues, AIS, ocean data and coastlines'],
                  ['Case data', 'Per-case files with forcing grids and coastlines'],
                  ['Last update', `${fmt.utc(Date.parse(world.generatedAt))} (${fmt.ago(Date.parse(world.generatedAt), now)})`],
                  ['Update failures', world.index.failures.length ? world.index.failures.map((f) => f.id).join(', ') : 'None'],
                  ['Drift and attribution', 'Computed on the analyst workstation from the case data'],
                  ['Authentication', 'Account switcher (single sign-on not yet connected)'],
                ]} />
              </div>
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <h4 className="text-[0.75rem] font-bold text-gray-700 uppercase mb-2 flex items-center gap-2">Target deployment <ProvenanceBadge p="pending" /></h4>
                <KeyValue cols={1} items={[
                  ['Hosting', 'MeghRaj / NIC government cloud (not provisioned)'],
                  ['Data residency', 'India only'],
                  ['Database', 'PostgreSQL + PostGIS; TimescaleDB for AIS'],
                  ['Object storage', 'S3-compatible store for SAR scenes'],
                  ['Inference', 'On-premises GPU (e.g. AIRAWAT allocation)'],
                  ['Network', 'NICNET, no public ingress, mTLS between services'],
                  ['Identity', 'Agency SSO with MFA'],
                ]} />
              </div>
            </div>
            <InfoBanner tone="amber" icon={<Shield className="w-3.5 h-3.5" />}>
              The right-hand column is the deployment plan; none of it is provisioned yet.
            </InfoBanner>
          </div>
        )}

        {section === 'models' && (
          <div className="flex-1 overflow-auto p-4 space-y-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h4 className="text-[0.75rem] font-bold text-gray-900">Segmentation model</h4>
                  <p className="text-[0.6875rem] text-gray-500">{MODEL_STATUS.version ?? 'No version'}</p>
                </div>
                <Badge tone={MODEL_STATUS.trained ? 'green' : 'gray'}>{MODEL_STATUS.trained ? 'Trained' : 'Not trained'}</Badge>
              </div>
              <KeyValue cols={1} items={[
                ['Accuracy', modelScoreLine(MODEL_STATUS.models.sarSegmentation)],
                ['Architecture', MODEL_STATUS.architecture],
                ['Trained on', MODEL_STATUS.training],
                ['Loss', MODEL_STATUS.loss],
                ['Scoring', MODEL_STATUS.evaluation.join('; ')],
              ]} />
              <p className="text-[0.6875rem] text-gray-500 mt-1.5">{MODEL_STATUS.note}</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <h4 className="text-[0.75rem] font-bold text-gray-900 mb-2">Drift model</h4>
              <KeyValue cols={2} items={[
                ['Method', 'Lagrangian particle tracking'],
                ['Formulation', 'u = u_current + u_stokes + windage × u_wind + diffusion'],
                ['Windage default', '3.0% of 10 m wind'],
                ['Stokes drift', '1.2% of 10 m wind'],
                ['Diffusivity', '8 m²/s horizontal'],
                ['Ensemble', '12 members, perturbed windage and diffusivity'],
                ['Currents (now)', 'SMOC via Open-Meteo (2022+), climatology before'],
                ['Wind (now)', 'ERA5 via Open-Meteo archive'],
                ['Currents (target)', 'INCOIS HOOFS (pending access)'],
                ['Wind (target)', 'IMD / MOSDAC scatterometer (pending access)'],
              ]} />
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <h4 className="text-[0.75rem] font-bold text-gray-900 mb-2">Attribution scoring</h4>
              <KeyValue cols={2} items={[
                ['Form', 'Transparent weighted sum (not a learned ranker)'],
                ['Proximity weight', String(weights.proximity)],
                ['Temporality weight', String(weights.temporality)],
                ['Trajectory weight', String(weights.trajectory)],
                ['Behaviour weight', String(weights.behaviour)],
                ['Registry prior weight', String(weights.vesselPrior)],
                ['Window', 'Asymmetric: wider before the estimated release'],
              ]} />
              <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
                Scores are a weighted sum: there are too few confirmed incident–vessel pairs to train a ranking model, and each term can be explained.
              </InfoBanner>
            </div>
          </div>
        )}

        {section === 'audit' && (
          <div className="flex-1 min-h-0 flex flex-col p-4 gap-2">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 flex-1 min-h-0 flex flex-col">
              <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg flex justify-between items-center">
                <h3 className="text-[0.75rem] font-bold text-gray-700">Access and system log</h3>
                <span className="text-[0.6875rem] text-gray-500">{accessLog.length} entries</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {accessLog.map((e) => (
                  <div key={e.id} className="px-3 py-2 border-b border-gray-100 hover:bg-gray-50 flex gap-3">
                    <span className="font-mono text-[0.6875rem] text-gray-400 w-32 flex-shrink-0">{fmt.utc(e.t)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[0.75rem] font-semibold text-gray-900">{e.action}</span>
                        <Badge tone={e.category === 'Access' ? 'violet' : 'gray'}>{e.category}</Badge>
                      </div>
                      <p className="text-[0.6875rem] text-gray-600">{e.detail}</p>
                      <p className="text-[0.6875rem] text-gray-400">{e.actor} · {e.role} · target {e.target}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {section === 'health' && (
          <div className="flex-1 overflow-auto p-4 space-y-4">
            <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">Changes saved in this browser</p>
                <p className="text-[0.75rem] text-gray-600 mt-0.5">Workflow moves, drafts, reports, users and audit entries are kept locally. Clearing restores the recorded cases.</p>
              </div>
              <Button variant="danger" size="sm" disabled={restricted} title={restricted ? 'Needs an NTRO Admin account' : undefined}
                onClick={() => { if (window.confirm('Clear all changes saved in this browser?')) resetSession(); }}>
                Clear saved changes
              </Button>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={<Activity className="w-5 h-5" />} title="Sources working"
                value={`${world.dataSources.filter((d) => d.status === 'Online' || d.status === 'Interim fallback').length}/${world.dataSources.length}`} trend="online or interim fallback" accent="green" />
              <StatCard icon={<Database className="w-5 h-5" />} title="Cases loaded" value={world.cases.length} trend={`${world.index.failures.length} build failures`} accent={world.index.failures.length ? 'amber' : 'green'} />
              <StatCard icon={<Cpu className="w-5 h-5" />} title="Engine runtime" value={`${meanRuntime.toFixed(0)} ms`} trend="mean per case, measured here" />
              <StatCard icon={<Key className="w-5 h-5" />} title="Authorisation required" value={world.dataSources.filter((d) => d.status === 'Authorisation required' || d.status === 'Not configured').length} trend="integrations waiting on credentials" accent="amber" />
            </div>
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <h4 className="text-[0.75rem] font-bold text-gray-700 uppercase mb-2">Analysis engine, measured in this browser</h4>
              <div className="space-y-1.5">
                {runtimes.map(({ c, ms }) => (
                  <div key={c.id} className="flex items-center gap-3 py-1 border-b border-gray-100 last:border-0">
                    <span className="text-[0.75rem] font-semibold text-gray-800 w-64 flex-shrink-0 truncate" title={c.title}>{c.title}</span>
                    <div className="flex-1 h-1.5 bg-gray-200 rounded overflow-hidden">
                      <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, ((ms ?? 0) / Math.max(1, ...runtimes.map((r) => r.ms ?? 0))) * 100)}%` }} />
                    </div>
                    <span className="text-[0.6875rem] font-mono text-gray-700 w-16 text-right">{ms != null ? `${ms.toFixed(0)} ms` : '—'}</span>
                  </div>
                ))}
              </div>
              <p className="text-[0.6875rem] text-gray-500 mt-2">12-member hindcast, forecast, look-alike checks and candidate scoring. Cached until the weights change.</p>
            </div>
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <h4 className="text-[0.75rem] font-bold text-gray-700 uppercase mb-2">Pipeline build</h4>
              <div className="space-y-3">
                {world.index.providers.map((p) => (
                  <div key={`${p.kind}-${p.name}`} className="flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${p.available ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    <span className="text-[0.75rem] font-semibold text-gray-800 w-52 flex-shrink-0">{p.agency}</span>
                    <span className="text-[0.6875rem] text-gray-500 flex-1">{p.message}</span>
                    <Badge tone="gray">{p.kind}</Badge>
                    <Badge tone={p.available ? 'green' : 'amber'}>{p.available ? 'Available' : 'Unavailable'}</Badge>
                  </div>
                ))}
                {world.index.failures.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 py-1.5 text-[0.6875rem] text-red-700"><AlertTriangle className="w-3 h-3" /> {f.id}: {f.error}</div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      <AddUserModal open={addOpen} onClose={() => setAddOpen(false)} onAdd={addUser} />
      <SetPasswordModal userId={passwordFor?.id ?? null} userName={passwordFor?.name ?? ''} onClose={() => setPasswordFor(null)} />
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
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Full name"><TextInput value={name} onChange={setName} placeholder="e.g. Cdr. A. Kulkarni" /></Field>
          <Field label="Official email"><TextInput value={email} onChange={setEmail} placeholder="name@agency.gov.in" /></Field>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
          The role decides which pages appear and whether they can be edited. For example, a Regulator sees the liability register but not investigation tools.
        </InfoBanner>
      </div>
    </Modal>
  );
}
