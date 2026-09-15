import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bell, HelpCircle, LogOut, Search, Satellite, Home, AlertTriangle, FileText, Anchor,
  Database, Activity, ChevronDown, Map as MapIcon, Megaphone, CheckSquare, Shield, Archive,
  Settings, Pause, Play, X, CheckCircle2, Info, AlertCircle, User as UserIcon, Ship, Waves,
} from 'lucide-react';
import { StoreProvider, useStore, fmt } from './store/store';
import Dashboard from './Dashboard';
import SpillIncidents from './SpillIncidents';
import Investigation from './Investigation';
import SatelliteTasking from './SatelliteTasking';
import VesselAnalysis from './VesselAnalysis';
import EnvironmentalData from './EnvironmentalData';
import NcscmEcological from './NcscmEcological';
import SachetSamudra from './SachetSamudra';
import Workflow from './Workflow';
import OffenderRegistry from './OffenderRegistry';
import ImacIntegration from './ImacIntegration';
import AnalyticsReporting from './AnalyticsReporting';
import CaseArchive from './CaseArchive';
import SystemAdministration from './SystemAdministration';

const NAV: { label: string; icon: ReactNode }[] = [
  { label: 'Dashboard', icon: <Home className="w-4 h-4" /> },
  { label: 'Spill Incidents', icon: <AlertTriangle className="w-4 h-4" /> },
  { label: 'Investigation', icon: <Search className="w-4 h-4" /> },
  { label: 'Vessel Analysis', icon: <Anchor className="w-4 h-4" /> },
  { label: 'Environmental Data', icon: <Activity className="w-4 h-4" /> },
  { label: 'Satellite Tasking', icon: <Satellite className="w-4 h-4" /> },
  { label: 'NCSCM Ecological', icon: <MapIcon className="w-4 h-4" /> },
  { label: 'SACHET / SAMUDRA', icon: <Megaphone className="w-4 h-4" /> },
  { label: 'Workflow', icon: <CheckSquare className="w-4 h-4" /> },
  { label: 'Offender Registry', icon: <Shield className="w-4 h-4" /> },
  { label: 'Reports', icon: <FileText className="w-4 h-4" /> },
  { label: 'Data Management', icon: <Database className="w-4 h-4" /> },
  { label: 'Case Archive', icon: <Archive className="w-4 h-4" /> },
  { label: 'System Admin', icon: <Settings className="w-4 h-4" /> },
];

/** Pages a role is permitted to open. Anything else is hidden from the nav entirely. */
const ROLE_ACCESS: Record<string, string[] | 'all'> = {
  'NTRO Admin': 'all',
  'NTRO Reviewer': 'all',
  Analyst: ['Dashboard', 'Spill Incidents', 'Investigation', 'Vessel Analysis', 'Environmental Data', 'Satellite Tasking', 'NCSCM Ecological', 'SACHET / SAMUDRA', 'Workflow', 'Offender Registry', 'Reports', 'Case Archive'],
  Regulator: ['Dashboard', 'Spill Incidents', 'Offender Registry', 'Workflow', 'Reports', 'Case Archive'],
  Liaison: ['Dashboard', 'Spill Incidents', 'Investigation', 'Workflow', 'Data Management', 'Case Archive'],
  'Data Operator': ['Dashboard', 'Environmental Data', 'Satellite Tasking', 'Data Management', 'Reports'],
  Viewer: ['Dashboard', 'Spill Incidents', 'NCSCM Ecological', 'Reports', 'Case Archive'],
};

function Shell() {
  const store = useStore();
  const { activeTab, navigate, now, clockRunning, toggleClock, currentUser, world } = store;
  const [userMenu, setUserMenu] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const allowed = useMemo(() => {
    const a = ROLE_ACCESS[currentUser.role];
    return a === 'all' ? NAV.map((n) => n.label) : a;
  }, [currentUser.role]);

  useEffect(() => {
    if (!allowed.includes(activeTab)) navigate({ tab: 'Dashboard' });
  }, [allowed, activeTab, navigate]);

  // Close popovers on an outside click.
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, []);

  // Global search across cases, vessels and protected areas.
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { kind: string; label: string; sub: string; go: () => void }[] = [];
    for (const c of world.cases) {
      if (c.id.toLowerCase().includes(q) || c.region.toLowerCase().includes(q) || c.subRegion.toLowerCase().includes(q)) {
        out.push({ kind: 'Case', label: c.id, sub: `${c.subRegion} · ${c.status}`, go: () => navigate({ tab: 'Investigation', caseId: c.id }) });
      }
    }
    for (const v of world.vessels) {
      if (v.name.toLowerCase().includes(q) || v.mmsi.includes(q) || v.imo.includes(q)) {
        out.push({ kind: 'Vessel', label: v.name, sub: `MMSI ${v.mmsi} · ${v.type} · ${v.flag}`, go: () => navigate({ tab: 'Vessel Analysis', mmsi: v.mmsi }) });
      }
    }
    return out.slice(0, 9);
  }, [search, world, navigate]);

  const unread = useMemo(() => world.audit.filter((a) => a.t > now - 6 * 3600_000).slice(0, 8), [world.audit, now, store.revision]);

  const openCases = world.cases.filter((c) => !['Closed', 'Dismissed — Look-alike'].includes(c.status)).length;

  return (
    <div className="h-screen flex flex-col bg-[#f0f4f8] overflow-hidden">
      <header className="bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between flex-shrink-0 gap-4">
        <div className="flex items-center gap-3 cursor-pointer flex-shrink-0" onClick={() => navigate({ tab: 'Dashboard' })}>
          <div className="bg-gradient-to-br from-blue-600 to-blue-800 rounded-full w-10 h-10 flex items-center justify-center text-white shadow-sm">
            <Waves className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">OceanWatch AI</h1>
            <p className="text-[10px] text-gray-500 font-medium leading-tight">Forensic Oil Spill Detection &amp; Vessel Attribution</p>
            <p className="text-[9px] text-gray-400 leading-tight">National Marine Pollution Intelligence System</p>
          </div>
        </div>

        <div className="flex-1 max-w-md relative" ref={searchRef}>
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search cases, vessels, MMSI or IMO…"
            className="w-full pl-9 pr-3 py-1.5 text-xs border border-gray-300 rounded-full bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          {searchOpen && results.length > 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-xl z-50 overflow-hidden">
              {results.map((r, i) => (
                <button
                  key={i}
                  onClick={() => { r.go(); setSearchOpen(false); setSearch(''); }}
                  className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-gray-100 last:border-0 flex items-center gap-2.5"
                >
                  {r.kind === 'Case' ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" /> : <Ship className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-gray-900 truncate">{r.label}</div>
                    <div className="text-[10px] text-gray-500 truncate">{r.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {searchOpen && search.trim().length >= 2 && results.length === 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-xl z-50 px-3 py-3 text-xs text-gray-500">
              No cases or vessels match “{search}”.
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 flex-shrink-0">
          <button
            onClick={toggleClock}
            title={clockRunning ? 'Pause the demonstration clock' : 'Resume the demonstration clock'}
            className="flex items-center gap-2 text-xs font-mono font-semibold text-gray-700 hover:text-blue-700 bg-gray-50 hover:bg-blue-50 px-2.5 py-1.5 rounded border border-gray-200"
          >
            {clockRunning ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            {fmt.utc(now)}
          </button>

          <div className="relative">
            <button onClick={() => { setNotifOpen((o) => !o); setUserMenu(false); }} className="relative text-gray-600 hover:text-blue-600 p-1">
              <Bell className="w-5 h-5" />
              {unread.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                  {unread.length}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-xl z-50">
                <div className="px-3 py-2 border-b border-gray-200 flex justify-between items-center bg-gray-50 rounded-t-lg">
                  <span className="text-xs font-bold text-gray-800">Recent system activity</span>
                  <button onClick={() => setNotifOpen(false)}><X className="w-3.5 h-3.5 text-gray-400" /></button>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {unread.length === 0 && <div className="px-3 py-6 text-center text-xs text-gray-400">Nothing in the last 6 hours.</div>}
                  {unread.map((a) => (
                    <div key={a.id} className="px-3 py-2 border-b border-gray-100 last:border-0 hover:bg-gray-50">
                      <div className="flex justify-between gap-2">
                        <span className="text-[11px] font-semibold text-gray-900">{a.action}</span>
                        <span className="text-[9px] text-gray-400 font-mono flex-shrink-0">{fmt.ago(a.t, now)}</span>
                      </div>
                      <p className="text-[10px] text-gray-600 mt-0.5 leading-snug">{a.detail}</p>
                      <p className="text-[9px] text-gray-400 mt-0.5 font-mono">{a.target}</p>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => { navigate({ tab: 'Case Archive', section: 'audit' }); setNotifOpen(false); }}
                  className="w-full px-3 py-2 text-[11px] font-semibold text-blue-600 hover:bg-blue-50 border-t border-gray-200 rounded-b-lg"
                >
                  View the full audit trail
                </button>
              </div>
            )}
          </div>

          <button onClick={() => setHelpOpen(true)} className="flex items-center gap-1 text-gray-600 hover:text-blue-600">
            <HelpCircle className="w-5 h-5" /><span className="text-xs font-medium">Help</span>
          </button>

          <div className="relative">
            <button
              onClick={() => { setUserMenu((o) => !o); setNotifOpen(false); }}
              className="flex items-center gap-2 hover:bg-gray-50 px-2 py-1 rounded border border-transparent hover:border-gray-200"
            >
              <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-700">
                <UserIcon className="w-4 h-4" />
              </div>
              <div className="text-left">
                <div className="text-xs font-bold text-gray-800 leading-tight">{currentUser.name}</div>
                <div className="text-[9px] text-gray-500 leading-tight">{currentUser.role}</div>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
            </button>
            {userMenu && (
              <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-xl z-50">
                <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                  <div className="text-xs font-bold text-gray-800">{currentUser.name}</div>
                  <div className="text-[10px] text-gray-500">{currentUser.email}</div>
                  <div className="text-[10px] text-gray-500 mt-1">
                    {currentUser.agency} · clearance <span className="font-semibold">{currentUser.clearance}</span>
                  </div>
                </div>
                <div className="px-3 py-2 border-b border-gray-200">
                  <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Switch role (demonstration)</p>
                  <p className="text-[10px] text-gray-500 mb-2 leading-snug">
                    Navigation and page permissions change with the signed-in role.
                  </p>
                  <div className="space-y-0.5 max-h-52 overflow-y-auto">
                    {world.users.filter((u) => u.status === 'Active').map((u) => (
                      <button
                        key={u.id}
                        onClick={() => { store.setCurrentUser(u); setUserMenu(false); store.notify({ kind: 'info', title: `Signed in as ${u.name}`, body: `${u.role} — ${u.agency}` }); }}
                        className={`w-full text-left px-2 py-1.5 rounded text-[11px] flex justify-between items-center ${
                          u.id === currentUser.id ? 'bg-blue-50 text-blue-800 font-semibold' : 'hover:bg-gray-100 text-gray-700'
                        }`}
                      >
                        <span className="truncate">{u.name}</span>
                        <span className="text-[9px] text-gray-500 flex-shrink-0 ml-2">{u.role}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <button className="w-full px-3 py-2 text-[11px] font-semibold text-red-600 hover:bg-red-50 flex items-center gap-2 rounded-b-lg">
                  <LogOut className="w-3.5 h-3.5" /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="bg-[#0b1c3c] text-white px-2 overflow-x-auto flex-shrink-0">
        <ul className="flex items-center gap-0.5 text-xs font-medium whitespace-nowrap">
          {NAV.filter((n) => allowed.includes(n.label)).map((n) => (
            <li key={n.label}>
              <button
                onClick={() => navigate({ tab: n.label })}
                aria-current={activeTab === n.label ? 'page' : undefined}
                className={`flex items-center gap-1.5 px-3 py-2.5 border-b-2 transition-colors ${
                  activeTab === n.label
                    ? 'bg-[#153468] border-blue-400 text-white'
                    : 'border-transparent text-gray-300 hover:text-white hover:bg-[#153468]/60'
                }`}
              >
                {n.icon}
                <span>{n.label}</span>
                {n.label === 'Spill Incidents' && openCases > 0 && (
                  <span className="bg-amber-500 text-[9px] font-bold px-1 rounded text-white ml-0.5">{openCases}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab === 'Dashboard' && <Dashboard />}
        {activeTab === 'Spill Incidents' && <SpillIncidents />}
        {activeTab === 'Investigation' && <Investigation />}
        {activeTab === 'Vessel Analysis' && <VesselAnalysis />}
        {activeTab === 'Environmental Data' && <EnvironmentalData />}
        {activeTab === 'Satellite Tasking' && <SatelliteTasking />}
        {activeTab === 'NCSCM Ecological' && <NcscmEcological />}
        {activeTab === 'SACHET / SAMUDRA' && <SachetSamudra />}
        {activeTab === 'Workflow' && <Workflow />}
        {activeTab === 'Offender Registry' && <OffenderRegistry />}
        {activeTab === 'Reports' && <AnalyticsReporting />}
        {activeTab === 'Data Management' && <ImacIntegration />}
        {activeTab === 'Case Archive' && <CaseArchive />}
        {activeTab === 'System Admin' && <SystemAdministration />}
      </div>

      <ToastHost />
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function ToastHost() {
  const { toasts, dismissToast } = useStore();
  const icons = {
    success: <CheckCircle2 className="w-4 h-4 text-emerald-600" />,
    info: <Info className="w-4 h-4 text-blue-600" />,
    warn: <AlertTriangle className="w-4 h-4 text-amber-600" />,
    error: <AlertCircle className="w-4 h-4 text-red-600" />,
  };
  const tones = {
    success: 'border-l-emerald-500', info: 'border-l-blue-500',
    warn: 'border-l-amber-500', error: 'border-l-red-500',
  };
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-80 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className={`bg-white rounded shadow-lg border border-gray-200 border-l-4 ${tones[t.kind]} px-3 py-2.5 flex gap-2.5 items-start pointer-events-auto animate-[slideIn_0.2s_ease-out]`}>
          <div className="flex-shrink-0 mt-0.5">{icons[t.kind]}</div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-gray-900">{t.title}</p>
            {t.body && <p className="text-[11px] text-gray-600 mt-0.5 leading-snug">{t.body}</p>}
          </div>
          <button onClick={() => dismissToast(t.id)} className="text-gray-400 hover:text-gray-700 flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] bg-black/45 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
          <h3 className="font-bold text-gray-900">How this system works</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400 hover:text-gray-700" /></button>
        </div>
        <div className="p-4 overflow-y-auto text-xs text-gray-700 space-y-4 leading-relaxed">
          <section>
            <h4 className="font-bold text-gray-900 text-sm mb-1">The four-stage pipeline</h4>
            <ol className="list-decimal ml-4 space-y-1.5">
              <li><b>Detection.</b> SAR scenes are segmented pixel-by-pixel into sea, oil, look-alike, ship and land. Dark patches are the easy part; separating oil from wind shadows and algal films is the hard part, and it is done with cross-checks on wind speed, backscatter contrast, edge definition and slick geometry.</li>
              <li><b>Hindcast.</b> A Lagrangian particle model runs backward from the observed slick using ocean currents, Stokes drift and windage, producing an origin point and a discharge time window with an honest uncertainty envelope rather than a single point.</li>
              <li><b>Attribution.</b> AIS traffic intersecting that window is scored on proximity, temporality, course parity, behavioural anomalies and registry priors. Every sub-score is shown so the ranking can be inspected rather than trusted blindly.</li>
              <li><b>Response.</b> Confirmed cases drive verification dispatch, community alerting through SACHET, ecological impact assessment, and the hand-off to IMAC.</li>
            </ol>
          </section>
          <section>
            <h4 className="font-bold text-gray-900 text-sm mb-1">Reading the confidence figures</h4>
            <p>
              Detection confidence is the probability that the feature is mineral oil rather than a natural look-alike.
              Attribution confidence is a <i>prioritisation</i> score, not proof of guilt. A high-ranking vessel is a vessel
              worth inspecting; the evidentiary step is a physical sample and a GC-MS fingerprint match against the vessel's
              slop tank. The interface never allows a case to reach enforcement without passing through a human verification stage.
            </p>
          </section>
          <section>
            <h4 className="font-bold text-gray-900 text-sm mb-1">Navigating</h4>
            <p>
              The demonstration clock in the header drives drift animation and pass scheduling; pause it to freeze the state.
              Use the search box for any case ID, vessel name, MMSI or IMO number. Maps pan by dragging and zoom with the wheel.
              Switching the signed-in role from the user menu changes which pages are available.
            </p>
          </section>
          <section className="bg-amber-50 border border-amber-200 rounded p-3">
            <h4 className="font-bold text-amber-900 text-sm mb-1">Demonstration data</h4>
            <p className="text-amber-900">
              Vessel identities, AIS tracks and detections in this build are synthetic. The ocean forcing, drift physics,
              weathering chemistry, geometry and scoring are all computed live from the models described above — the numbers
              on screen are calculated, not stored.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
