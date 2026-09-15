import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bell, HelpCircle, LogOut, Search, Satellite, Home, AlertTriangle, FileText, Anchor,
  Database, Activity, ChevronDown, Map as MapIcon, Megaphone, CheckSquare, Shield, Archive,
  Settings, Clock, X, CheckCircle2, Info, AlertCircle, User as UserIcon, Ship,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { StoreProvider, useStore, fmt } from './store/store';
import { Seal } from './components/Seal';
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

/** Navigation sections in workflow order, separated by dividers in the tab bar. */
const NAV_GROUPS: { title: string; items: string[] }[] = [
  { title: 'Operations', items: ['Dashboard', 'Spill Incidents', 'Investigation', 'Vessel Analysis'] },
  { title: 'Environment', items: ['Environmental Data', 'Satellite Tasking', 'NCSCM Ecological'] },
  { title: 'Response', items: ['SACHET / SAMUDRA', 'Workflow', 'Offender Registry'] },
  { title: 'Records', items: ['Reports', 'Data Management', 'Case Archive', 'System Admin'] },
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
  const { activeTab, navigate, now, currentUser, world } = store;
  const [userMenu, setUserMenu] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const [navOverflow, setNavOverflow] = useState({ left: false, right: false });

  // The tab bar scrolls sideways when it is wider than the screen; arrows show there is more.
  const updateNavOverflow = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setNavOverflow({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    updateNavOverflow();
    const ro = new ResizeObserver(updateNavOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateNavOverflow]);

  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  const scrollNav = (dir: number) => navRef.current?.scrollBy({ left: dir * 320, behavior: 'smooth' });

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
      if (`${c.id} ${c.title} ${c.region} ${c.subRegion}`.toLowerCase().includes(q)) {
        out.push({ kind: 'Case', label: c.title, sub: `${c.id} · ${c.subRegion}`, go: () => navigate({ tab: 'Investigation', caseId: c.id }) });
      }
    }
    for (const v of world.vessels) {
      if (v.name.toLowerCase().includes(q) || (v.mmsiNumber ?? '').includes(q) || (v.imo ?? '').includes(q)) {
        out.push({ kind: 'Vessel', label: v.name, sub: `${fmt.vesselId(v)} · ${v.type}${v.provenance === 'synthetic' ? ' · synthetic' : ''}`, go: () => navigate({ tab: 'Vessel Analysis', mmsi: v.mmsi }) });
      }
    }
    return out.slice(0, 9);
  }, [search, world, navigate]);

  const unread = useMemo(() => world.audit.filter((a) => a.t > now - 6 * 3600_000).slice(0, 8), [world.audit, now, store.revision]);

  const openCases = world.cases.filter((c) => !['Closed', 'Dismissed — Look-alike'].includes(c.status)).length;

  return (
    <div className="h-screen flex flex-col bg-[#f0f4f8] overflow-hidden">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] focus:bg-white focus:text-[#0b2a55] focus:px-3 focus:py-2 focus:rounded focus:shadow-lg text-sm font-semibold">
        Skip to main content
      </a>

      {/* Tricolour band and utility strip, in the layout of Indian public-sector portals. */}
      <div className="flex h-1 flex-shrink-0" aria-hidden>
        <span className="flex-1 bg-[#FF9933]" />
        <span className="flex-1 bg-white" />
        <span className="flex-1 bg-[#138808]" />
      </div>
      <div className="bg-[#0b2a55] text-slate-200 text-[11.5px] flex-shrink-0">
        <div className="px-3 sm:px-5 h-8 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span lang="hi" className="font-hindi whitespace-nowrap">समुद्री प्रदूषण निगरानी</span>
            <span className="text-slate-400">|</span>
            <span className="truncate">Maritime Pollution Surveillance</span>
          </div>
          <div className="flex items-center gap-3 sm:gap-4 flex-shrink-0">
            <span title={`Case data generated ${fmt.utc(new Date(world.generatedAt).getTime())}`} className="hidden lg:inline whitespace-nowrap">
              Replay mode · {world.cases.length} recorded incidents
            </span>
            <span className="hidden lg:inline text-slate-500">|</span>
            <span className="hidden sm:flex items-center gap-1.5 font-mono whitespace-nowrap">
              <Clock className="w-3 h-3" /> {fmt.utc(now)}
            </span>
            <span className="hidden sm:inline text-slate-500">|</span>
            <button onClick={() => setHelpOpen(true)} className="flex items-center gap-1 hover:text-white whitespace-nowrap">
              <HelpCircle className="w-3.5 h-3.5" /> Help
            </button>
          </div>
        </div>
      </div>

      <header className="relative bg-white border-b border-gray-200 px-3 sm:px-5 h-[68px] flex items-center gap-3 sm:gap-5 flex-shrink-0 z-30">
        <div className="flex items-center gap-2.5 sm:gap-3 cursor-pointer min-w-0 flex-shrink lg:flex-shrink-0" onClick={() => navigate({ tab: 'Dashboard' })}>
          <span className="sm:hidden"><Seal size={40} /></span>
          <span className="hidden sm:block"><Seal size={50} /></span>
          <div className="hidden sm:block w-px self-stretch my-1 bg-gray-300" aria-hidden />
          <div className="min-w-0 leading-tight">
            <p lang="hi" className="font-hindi text-[12px] sm:text-[13px] text-gray-700 truncate">समुद्री तेल रिसाव जाँच एवं पोत अभिनिर्धारण प्रणाली</p>
            <h1 className="text-[17px] sm:text-[19px] font-bold text-[#0b2a55] tracking-wide uppercase">OceanSpill</h1>
            <p className="hidden md:block text-[12px] text-gray-600 truncate">Oil Spill Detection &amp; Vessel Attribution System</p>
          </div>
        </div>

        <div
          ref={searchRef}
          className={`${mobileSearch ? 'absolute left-0 right-0 top-full block bg-white border-b border-gray-200 p-2 shadow-md' : 'hidden'} lg:static lg:block lg:p-0 lg:border-0 lg:shadow-none lg:bg-transparent flex-1 max-w-md lg:relative`}
        >
          <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search cases, vessels, MMSI or IMO…"
            aria-label="Search cases and vessels"
            className="w-full pl-9 pr-3 py-2 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#0b2a55]/40 focus:border-[#0b2a55]"
          />
          {searchOpen && results.length > 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-xl z-50 overflow-hidden">
              {results.map((r, i) => (
                <button
                  key={i}
                  onClick={() => { r.go(); setSearchOpen(false); setSearch(''); setMobileSearch(false); }}
                  className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-gray-100 last:border-0 flex items-center gap-2.5"
                >
                  {r.kind === 'Case' ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" /> : <Ship className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-gray-900 truncate">{r.label}</div>
                    <div className="text-[11px] text-gray-500 truncate">{r.sub}</div>
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
        </div>

        <div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0 ml-auto">
          <button onClick={() => setMobileSearch((o) => !o)} aria-label="Search" className="lg:hidden p-1.5 rounded text-gray-600 hover:bg-gray-100">
            {mobileSearch ? <X className="w-5 h-5" /> : <Search className="w-5 h-5" />}
          </button>

          <div className="relative">
            <button onClick={() => { setNotifOpen((o) => !o); setUserMenu(false); }} className="relative text-gray-600 hover:text-blue-600 p-1">
              <Bell className="w-5 h-5" />
              {unread.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10.5px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                  {unread.length}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute -right-24 sm:right-0 top-full mt-2 w-[calc(100vw-24px)] max-w-80 bg-white border border-gray-200 rounded-lg shadow-xl z-50">
                <div className="px-3 py-2 border-b border-gray-200 flex justify-between items-center bg-gray-50 rounded-t-lg">
                  <span className="text-xs font-bold text-gray-800">Recent system activity</span>
                  <button onClick={() => setNotifOpen(false)}><X className="w-3.5 h-3.5 text-gray-400" /></button>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {unread.length === 0 && <div className="px-3 py-6 text-center text-xs text-gray-400">Nothing in the last 6 hours.</div>}
                  {unread.map((a) => (
                    <div key={a.id} className="px-3 py-2 border-b border-gray-100 last:border-0 hover:bg-gray-50">
                      <div className="flex justify-between gap-2">
                        <span className="text-[12px] font-semibold text-gray-900">{a.action}</span>
                        <span className="text-[10.5px] text-gray-400 font-mono flex-shrink-0">{fmt.ago(a.t, now)}</span>
                      </div>
                      <p className="text-[11px] text-gray-600 mt-0.5 leading-normal">{a.detail}</p>
                      <p className="text-[10.5px] text-gray-400 mt-0.5 font-mono">{a.target}</p>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => { navigate({ tab: 'Case Archive', section: 'audit' }); setNotifOpen(false); }}
                  className="w-full px-3 py-2 text-[12px] font-semibold text-blue-600 hover:bg-blue-50 border-t border-gray-200 rounded-b-lg"
                >
                  View the full audit trail
                </button>
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => { setUserMenu((o) => !o); setNotifOpen(false); }}
              className="flex items-center gap-2 hover:bg-gray-50 px-1 sm:px-2 py-1 rounded border border-transparent hover:border-gray-200"
            >
              <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-700">
                <UserIcon className="w-4 h-4" />
              </div>
              <div className="hidden lg:block text-left">
                <div className="text-xs font-bold text-gray-800 leading-snug">{currentUser.name}</div>
                <div className="text-[10.5px] text-gray-500 leading-snug">{currentUser.role}</div>
              </div>
              <ChevronDown className="hidden sm:block w-3.5 h-3.5 text-gray-500" />
            </button>
            {userMenu && (
              <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-xl z-50">
                <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                  <div className="text-xs font-bold text-gray-800">{currentUser.name}</div>
                  <div className="text-[11px] text-gray-500">{currentUser.email}</div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    {currentUser.agency} · clearance <span className="font-semibold">{currentUser.clearance}</span>
                  </div>
                </div>
                <div className="px-3 py-2 border-b border-gray-200">
                  <p className="text-[11px] font-bold text-gray-600 uppercase mb-1.5">Switch role (demo accounts)</p>
                  <p className="text-[11px] text-gray-500 mb-2 leading-normal">
                    Navigation and page permissions change with the signed-in role.
                  </p>
                  <div className="space-y-0.5 max-h-52 overflow-y-auto">
                    {world.users.filter((u) => u.status === 'Active').map((u) => (
                      <button
                        key={u.id}
                        onClick={() => { store.setCurrentUser(u); setUserMenu(false); store.notify({ kind: 'info', title: `Signed in as ${u.name}`, body: `${u.role} — ${u.agency}` }); }}
                        className={`w-full text-left px-2 py-1.5 rounded text-[12px] flex justify-between items-center ${
                          u.id === currentUser.id ? 'bg-blue-50 text-blue-800 font-semibold' : 'hover:bg-gray-100 text-gray-700'
                        }`}
                      >
                        <span className="truncate">{u.name}</span>
                        <span className="text-[10.5px] text-gray-500 flex-shrink-0 ml-2">{u.role}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <button className="w-full px-3 py-2 text-[12px] font-semibold text-red-600 hover:bg-red-50 flex items-center gap-2 rounded-b-lg">
                  <LogOut className="w-3.5 h-3.5" /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="relative bg-[#0b1c3c] text-white flex-shrink-0 z-20" aria-label="Main">
        <div ref={navRef} onScroll={updateNavOverflow} className="no-scrollbar flex items-stretch overflow-x-auto px-2 sm:px-3">
          {NAV_GROUPS.map((g) => {
            const items = NAV.filter((n) => g.items.includes(n.label) && allowed.includes(n.label));
            if (!items.length) return null;
            return (
              <Fragment key={g.title}>
                <span className="first:hidden self-center h-5 w-px bg-white/15 mx-1.5 flex-shrink-0" aria-hidden />
                {items.map((n) => {
                  const current = activeTab === n.label;
                  return (
                    <button
                      key={n.label}
                      onClick={() => navigate({ tab: n.label })}
                      aria-current={current ? 'page' : undefined}
                      title={`${g.title} · ${n.label}`}
                      className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors flex-shrink-0 ${
                        current ? 'bg-[#153468] border-blue-400 text-white' : 'border-transparent text-slate-300 hover:text-white hover:bg-[#153468]/60'
                      }`}
                    >
                      {n.icon}
                      <span>{n.label}</span>
                      {n.label === 'Spill Incidents' && openCases > 0 && (
                        <span className="bg-amber-500 text-[11px] font-bold px-1.5 rounded text-white leading-4">{openCases}</span>
                      )}
                    </button>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
        {navOverflow.left && (
          <button onClick={() => scrollNav(-1)} aria-label="Scroll navigation left"
            className="absolute left-0 inset-y-0 w-9 flex items-center justify-start pl-1 bg-gradient-to-r from-[#0b1c3c] via-[#0b1c3c]/90 to-transparent text-slate-200 hover:text-white">
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
        {navOverflow.right && (
          <button onClick={() => scrollNav(1)} aria-label="Scroll navigation right"
            className="absolute right-0 inset-y-0 w-9 flex items-center justify-end pr-1 bg-gradient-to-l from-[#0b1c3c] via-[#0b1c3c]/90 to-transparent text-slate-200 hover:text-white">
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </nav>

      <div id="main-content" tabIndex={-1} className="flex-1 min-w-0 min-h-0 flex flex-col outline-none">
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
    <div className="fixed bottom-4 left-4 right-4 sm:left-auto z-[60] flex flex-col gap-2 sm:w-80 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className={`bg-white rounded shadow-lg border border-gray-200 border-l-4 ${tones[t.kind]} px-3 py-2.5 flex gap-2.5 items-start pointer-events-auto animate-[slideIn_0.2s_ease-out]`}>
          <div className="flex-shrink-0 mt-0.5">{icons[t.kind]}</div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-gray-900">{t.title}</p>
            {t.body && <p className="text-[12px] text-gray-600 mt-0.5 leading-normal">{t.body}</p>}
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
            <ol className="list-decimal ml-4 space-y-2">
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
              Each case page has its own time scrubber covering the incident window.
              Use the search box for any case ID, vessel name, MMSI or IMO number. Maps pan by dragging and zoom with the wheel.
              Switching the signed-in role from the user menu changes which pages are available.
            </p>
          </section>
          <section className="bg-amber-50 border border-amber-200 rounded p-4">
            <h4 className="font-bold text-amber-900 text-sm mb-1">What is real and what is not</h4>
            <ul className="text-amber-900 list-disc ml-4 space-y-1.5">
              <li><b>Real:</b> the seven incidents, their positions, times, vessels, quantities and outcomes (cited to official and public sources); Sentinel-1 scene catalogue entries; ERA5 wind and SMOC currents; UN sanctions checks.</li>
              <li><b>Synthetic:</b> AIS tracks (anchored to reported real positions) and all background traffic, which carries SYN names and 999 MMSIs.</li>
              <li><b>Pending:</b> SAR segmentation (no model trained yet), EOS-04 search (needs Bhoonidhi login), INCOIS and DGLL feeds.</li>
            </ul>
            <p className="text-amber-900 mt-2">Every value carries a REAL, OBSERVED, SYNTHETIC, MODELLED or PENDING badge. Cases start in replay mode: the workflow is this system's; the real-world outcome is shown beside it.</p>
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
