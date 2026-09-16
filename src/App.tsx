import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bell, HelpCircle, LogOut, Search, Satellite, Home, AlertTriangle, FileText, Anchor,
  Database, Activity, ChevronDown, Map as MapIcon, Megaphone, CheckSquare, Shield, Archive,
  Settings, Clock, X, CheckCircle2, Info, AlertCircle, User as UserIcon, Ship,
  ChevronLeft, ChevronRight, Contrast, Leaf, History, Radar, KeyRound,
} from 'lucide-react';
import { allowedTabs } from './data/access';
import { ECOLOGICAL_AREAS } from './data/geography';
import { StoreProvider, useStore, fmt } from './store/store';
import { Seal } from './components/Seal';
import { MyAccount } from './components/AccountSecurity';
import { Button, Modal } from './components/ui';
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

/** `label` is the page id used for navigation; `display` is shown when it differs. */
const NAV: { label: string; display?: string; icon: ReactNode }[] = [
  { label: 'Dashboard', icon: <Home className="w-4 h-4" /> },
  { label: 'Spill Incidents', icon: <AlertTriangle className="w-4 h-4" /> },
  { label: 'Investigation', icon: <Search className="w-4 h-4" /> },
  { label: 'Vessel Analysis', icon: <Anchor className="w-4 h-4" /> },
  { label: 'Environmental Data', icon: <Activity className="w-4 h-4" /> },
  { label: 'Satellite Tasking', icon: <Satellite className="w-4 h-4" /> },
  { label: 'NCSCM Ecological', icon: <MapIcon className="w-4 h-4" /> },
  { label: 'SACHET / SAMUDRA', icon: <Megaphone className="w-4 h-4" /> },
  { label: 'Workflow', icon: <CheckSquare className="w-4 h-4" /> },
  { label: 'Offender Registry', display: 'Liability Register', icon: <Shield className="w-4 h-4" /> },
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

const A11Y_KEY = 'oceanspill.a11y.v1';
const TEXT_SCALES = ['100%', '112.5%', '125%'];

function loadA11y(): { scale: number; contrast: boolean } {
  try {
    return { scale: 0, contrast: false, ...JSON.parse(localStorage.getItem(A11Y_KEY) ?? '{}') };
  } catch {
    return { scale: 0, contrast: false };
  }
}

function Shell() {
  const store = useStore();
  const { activeTab, navigate, now, currentUser, world, timeZone, setTimeZone } = store;
  const [a11y, setA11y] = useState(loadA11y);

  // Text size and contrast, kept for this browser like on public-sector portals.
  useEffect(() => {
    document.documentElement.style.fontSize = TEXT_SCALES[a11y.scale] ?? '100%';
    document.documentElement.classList.toggle('hc', a11y.contrast);
    try {
      localStorage.setItem(A11Y_KEY, JSON.stringify(a11y));
    } catch {
      // Not kept if storage is unavailable.
    }
  }, [a11y]);
  const [userMenu, setUserMenu] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
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

  const allowed = useMemo(() => allowedTabs(currentUser.role), [currentUser.role]);

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

  // Global search across cases, vessels, protected areas, the historical register and SAR scenes.
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { kind: string; label: string; sub: string; go: () => void }[] = [];
    const can = (tab: string) => allowed.includes(tab);
    for (const c of world.cases) {
      if (`${c.id} ${c.title} ${c.region} ${c.subRegion}`.toLowerCase().includes(q)) {
        out.push({ kind: 'Case', label: c.title, sub: `${c.id} · ${c.subRegion}`, go: () => navigate({ tab: can('Investigation') ? 'Investigation' : 'Spill Incidents', caseId: c.id }) });
      }
    }
    if (can('Vessel Analysis')) {
      for (const v of world.vessels) {
        if (v.name.toLowerCase().includes(q) || (store.identitiesVisible && ((v.mmsiNumber ?? '').includes(q) || (v.imo ?? '').includes(q)))) {
          out.push({ kind: 'Vessel', label: v.name, sub: `${fmt.vesselId(v)} · ${v.type}${v.provenance === 'synthetic' ? ' · synthetic' : ''}`, go: () => navigate({ tab: 'Vessel Analysis', mmsi: v.mmsi }) });
        }
      }
    }
    if (can('NCSCM Ecological')) {
      for (const a of ECOLOGICAL_AREAS) {
        if (`${a.name} ${a.category} ${a.state}`.toLowerCase().includes(q)) {
          out.push({ kind: 'Area', label: a.name, sub: `${a.category} · ${a.state}`, go: () => navigate({ tab: 'NCSCM Ecological', section: a.id }) });
        }
      }
    }
    if (can('Case Archive')) {
      for (const h of world.historical) {
        if (h.activeCaseId) continue;
        if (`${h.name} ${h.location} ${h.date}`.toLowerCase().includes(q)) {
          out.push({ kind: 'Historical', label: `${h.name} (${h.date.slice(0, 4)})`, sub: h.location, go: () => navigate({ tab: 'Case Archive', section: 'historical' }) });
        }
      }
    }
    if (can('Satellite Tasking')) {
      for (const p of world.passes) {
        if (p.name.toLowerCase().includes(q)) {
          out.push({ kind: 'Scene', label: p.name, sub: `${p.sensor} · ${fmt.utc(p.start)}`, go: () => navigate({ tab: 'Satellite Tasking', caseId: p.caseIds[0] }) });
        }
      }
    }
    return out.slice(0, 10);
  }, [search, world, navigate, allowed, store.identitiesVisible]);

  const unread = useMemo(() => world.audit.filter((a) => a.t > now - 6 * 3600_000).slice(0, 8), [world.audit, now, store.revision]);

  const openCases = world.cases.filter((c) => !['Closed', 'Dismissed — Look-alike'].includes(c.status)).length;

  if (store.signedOut) return <SignedOut />;

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
      <div className="bg-[#0b2a55] text-slate-200 text-[0.71875rem] flex-shrink-0">
        <div className="px-3 sm:px-5 h-8 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span lang="hi" className="font-hindi whitespace-nowrap">समुद्री प्रदूषण निगरानी</span>
            <span className="text-slate-400">|</span>
            <span className="truncate">Maritime Pollution Surveillance</span>
          </div>
          <div className="flex items-center gap-3 sm:gap-4 flex-shrink-0">
            <span title={`Case data updated ${fmt.utc(new Date(world.generatedAt).getTime())}`} className="hidden xl:inline whitespace-nowrap">
              Retrospective analysis · {world.cases.length} recorded incidents
            </span>
            <span className="hidden xl:inline text-slate-500">|</span>
            <span className="hidden sm:flex items-center gap-1.5 font-mono whitespace-nowrap">
              <Clock className="w-3 h-3" /> {fmt.utc(now)}
            </span>
            <div className="hidden sm:flex rounded border border-white/25 overflow-hidden" role="group" aria-label="Time zone">
              {(['UTC', 'IST'] as const).map((tz) => (
                <button key={tz} onClick={() => setTimeZone(tz)} aria-pressed={timeZone === tz}
                  className={`px-1.5 leading-5 ${timeZone === tz ? 'bg-white text-[#0b2a55] font-semibold' : 'hover:bg-white/10'}`}>{tz}</button>
              ))}
            </div>
            <span className="hidden md:inline text-slate-500">|</span>
            <div className="hidden md:flex items-center gap-0.5" role="group" aria-label="Text size">
              <button onClick={() => setA11y((a) => ({ ...a, scale: Math.max(0, a.scale - 1) }))} disabled={a11y.scale === 0}
                title="Smaller text" aria-label="Smaller text" className="px-1 rounded hover:bg-white/10 disabled:opacity-40">A-</button>
              <button onClick={() => setA11y((a) => ({ ...a, scale: 0 }))} title="Normal text" aria-label="Normal text size"
                className={`px-1 rounded hover:bg-white/10 ${a11y.scale === 0 ? 'underline underline-offset-2' : ''}`}>A</button>
              <button onClick={() => setA11y((a) => ({ ...a, scale: Math.min(TEXT_SCALES.length - 1, a.scale + 1) }))} disabled={a11y.scale === TEXT_SCALES.length - 1}
                title="Larger text" aria-label="Larger text" className="px-1 rounded hover:bg-white/10 disabled:opacity-40">A+</button>
              <button onClick={() => setA11y((a) => ({ ...a, contrast: !a.contrast }))} aria-pressed={a11y.contrast}
                title="High contrast" aria-label="High contrast" className={`ml-1 p-1 rounded hover:bg-white/10 ${a11y.contrast ? 'bg-white/20' : ''}`}>
                <Contrast className="w-3.5 h-3.5" />
              </button>
            </div>
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
            <p lang="hi" className="font-hindi text-[0.75rem] sm:text-[0.8125rem] text-gray-700 truncate">समुद्री तेल रिसाव जाँच एवं पोत अभिनिर्धारण प्रणाली</p>
            <h1 className="text-[1.0625rem] sm:text-[1.1875rem] font-bold text-[#0b2a55] tracking-wide uppercase">OceanSpill</h1>
            <p className="hidden md:block text-[0.75rem] text-gray-600 truncate">Oil Spill Detection &amp; Vessel Attribution System</p>
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
            placeholder="Search cases, vessels, areas, scenes…"
            aria-label="Search cases, vessels, protected areas, historical incidents and scenes"
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
                  {r.kind === 'Case' ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    : r.kind === 'Vessel' ? <Ship className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                    : r.kind === 'Area' ? <Leaf className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                    : r.kind === 'Historical' ? <History className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                    : <Radar className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-gray-900 truncate">{r.label}</div>
                    <div className="text-[0.6875rem] text-gray-500 truncate">{r.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {searchOpen && search.trim().length >= 2 && results.length === 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-xl z-50 px-3 py-3 text-xs text-gray-500">
              Nothing matches “{search}”.
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
                <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[0.65625rem] font-bold w-4 h-4 rounded-full flex items-center justify-center">
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
                        <span className="text-[0.75rem] font-semibold text-gray-900">{a.action}</span>
                        <span className="text-[0.65625rem] text-gray-400 font-mono flex-shrink-0">{fmt.ago(a.t, now)}</span>
                      </div>
                      <p className="text-[0.6875rem] text-gray-600 mt-0.5 leading-normal">{a.detail}</p>
                      <p className="text-[0.65625rem] text-gray-400 mt-0.5 font-mono">{a.target}</p>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => { navigate({ tab: 'Case Archive', section: 'audit' }); setNotifOpen(false); }}
                  className="w-full px-3 py-2 text-[0.75rem] font-semibold text-blue-600 hover:bg-blue-50 border-t border-gray-200 rounded-b-lg"
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
                <div className="text-[0.65625rem] text-gray-500 leading-snug">{currentUser.role}</div>
              </div>
              <ChevronDown className="hidden sm:block w-3.5 h-3.5 text-gray-500" />
            </button>
            {userMenu && (
              <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-xl z-50">
                <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                  <div className="text-xs font-bold text-gray-800">{currentUser.name}</div>
                  <div className="text-[0.6875rem] text-gray-500">{currentUser.email}</div>
                  <div className="text-[0.6875rem] text-gray-500 mt-1">
                    {currentUser.agency} · clearance <span className="font-semibold">{currentUser.clearance}</span>
                  </div>
                </div>
                {/* Display controls, which the utility strip hides on small screens. */}
                <div className="px-3 py-2 border-b border-gray-200 md:hidden">
                  <p className="text-[0.6875rem] font-bold text-gray-600 uppercase mb-1.5">Display</p>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[0.75rem] text-gray-700">Times shown in</span>
                    <div className="flex rounded border border-gray-300 overflow-hidden" role="group" aria-label="Time zone">
                      {(['UTC', 'IST'] as const).map((tz) => (
                        <button key={tz} onClick={() => setTimeZone(tz)} aria-pressed={timeZone === tz}
                          className={`px-2 py-0.5 text-[0.75rem] ${timeZone === tz ? 'bg-[#0b2a55] text-white font-semibold' : 'text-gray-700 hover:bg-gray-100'}`}>
                          {tz}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.75rem] text-gray-700">Text size</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setA11y((a) => ({ ...a, scale: Math.max(0, a.scale - 1) }))} disabled={a11y.scale === 0}
                        aria-label="Smaller text" className="px-2 py-0.5 rounded border border-gray-300 text-[0.75rem] disabled:opacity-40">A-</button>
                      <button onClick={() => setA11y((a) => ({ ...a, scale: 0 }))} aria-label="Normal text size"
                        className={`px-2 py-0.5 rounded border border-gray-300 text-[0.75rem] ${a11y.scale === 0 ? 'bg-gray-100 font-semibold' : ''}`}>A</button>
                      <button onClick={() => setA11y((a) => ({ ...a, scale: Math.min(TEXT_SCALES.length - 1, a.scale + 1) }))} disabled={a11y.scale === TEXT_SCALES.length - 1}
                        aria-label="Larger text" className="px-2 py-0.5 rounded border border-gray-300 text-[0.75rem] disabled:opacity-40">A+</button>
                      <button onClick={() => setA11y((a) => ({ ...a, contrast: !a.contrast }))} aria-pressed={a11y.contrast} aria-label="High contrast"
                        className={`p-1 rounded border border-gray-300 ${a11y.contrast ? 'bg-gray-200' : ''}`}>
                        <Contrast className="w-3.5 h-3.5 text-gray-700" />
                      </button>
                    </div>
                  </div>
                </div>
                {store.canSwitchAccount && (
                <div className="px-3 py-2 border-b border-gray-200">
                  <p className="text-[0.6875rem] font-bold text-gray-600 uppercase mb-1.5">Switch account</p>
                  <p className="text-[0.6875rem] text-gray-500 mb-2 leading-normal">
                    Pages and permissions follow the selected account's role.
                  </p>
                  <div className="space-y-0.5 max-h-52 overflow-y-auto">
                    {world.users.filter((u) => u.status === 'Active').map((u) => (
                      <button
                        key={u.id}
                        onClick={() => { store.setCurrentUser(u); setUserMenu(false); store.notify({ kind: 'info', title: `Signed in as ${u.name}`, body: `${u.role} — ${u.agency}` }); }}
                        className={`w-full text-left px-2 py-1.5 rounded text-[0.75rem] flex justify-between items-center ${
                          u.id === currentUser.id ? 'bg-blue-50 text-blue-800 font-semibold' : 'hover:bg-gray-100 text-gray-700'
                        }`}
                      >
                        <span className="truncate">{u.name}</span>
                        <span className="text-[0.65625rem] text-gray-500 flex-shrink-0 ml-2">{u.role}</span>
                      </button>
                    ))}
                  </div>
                </div>
                )}
                {store.serverMode && (
                  <button onClick={() => { setUserMenu(false); setAccountOpen(true); }}
                    className="w-full px-3 py-2 text-[0.75rem] font-semibold text-gray-700 hover:bg-gray-50 flex items-center gap-2 border-b border-gray-200">
                    <KeyRound className="w-3.5 h-3.5" /> Password and two-factor sign-in
                  </button>
                )}
                <button onClick={() => { setUserMenu(false); store.signOut(); }}
                  className="w-full px-3 py-2 text-[0.75rem] font-semibold text-red-600 hover:bg-red-50 flex items-center gap-2 rounded-b-lg">
                  <LogOut className="w-3.5 h-3.5" /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="relative bg-[#0b1c3c] text-white flex-shrink-0 z-20" aria-label="Main">
        <div ref={navRef} onScroll={updateNavOverflow} className="no-scrollbar flex items-stretch overflow-x-auto px-1 2xl:px-3">
          {NAV_GROUPS.map((g) => {
            const items = NAV.filter((n) => g.items.includes(n.label) && allowed.includes(n.label));
            if (!items.length) return null;
            return (
              <Fragment key={g.title}>
                <span className="first:hidden self-center h-5 w-px bg-white/15 mx-0.5 2xl:mx-1.5 flex-shrink-0" aria-hidden />
                {items.map((n) => {
                  const current = activeTab === n.label;
                  return (
                    <button
                      key={n.label}
                      onClick={() => navigate({ tab: n.label })}
                      aria-current={current ? 'page' : undefined}
                      title={`${g.title} · ${n.display ?? n.label}`}
                      className={`flex items-center gap-1.5 px-2 2xl:px-3 py-2.5 text-[0.71875rem] 2xl:text-xs font-medium whitespace-nowrap border-b-2 transition-colors flex-shrink-0 ${
                        current ? 'bg-[#153468] border-blue-400 text-white' : 'border-transparent text-slate-300 hover:text-white hover:bg-[#153468]/60'
                      }`}
                    >
                      <span className="hidden 2xl:inline">{n.icon}</span>
                      <span>{n.display ?? n.label}</span>
                      {n.label === 'Spill Incidents' && openCases > 0 && (
                        <span className="bg-amber-500 text-[0.6875rem] font-bold px-1.5 rounded text-white leading-4">{openCases}</span>
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

      {/* Keyed by time zone so every formatted time on the page is recomputed when it changes. */}
      <div key={timeZone} id="main-content" tabIndex={-1} className="flex-1 min-w-0 min-h-0 flex flex-col outline-none">
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

      <Modal open={accountOpen} onClose={() => setAccountOpen(false)} title="Your account"
        subtitle={`${currentUser.name} · ${currentUser.role}, ${currentUser.agency}`}
        footer={<Button onClick={() => setAccountOpen(false)}>Close</Button>}>
        <MyAccount />
      </Modal>
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
            {t.body && <p className="text-[0.75rem] text-gray-600 mt-0.5 leading-normal">{t.body}</p>}
          </div>
          <button onClick={() => dismissToast(t.id)} className="text-gray-400 hover:text-gray-700 flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

function SignedOut() {
  const { world, signIn } = useStore();
  const accounts = world.users.filter((u) => u.status === 'Active');
  return (
    <div className="min-h-screen bg-[#f0f4f8] flex flex-col">
      <div className="flex h-1" aria-hidden>
        <span className="flex-1 bg-[#FF9933]" />
        <span className="flex-1 bg-white" />
        <span className="flex-1 bg-[#138808]" />
      </div>
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm w-full max-w-md">
          <div className="px-6 pt-6 pb-4 flex items-center gap-3 border-b border-gray-200">
            <Seal size={48} />
            <div>
              <p lang="hi" className="font-hindi text-[0.8125rem] text-gray-700">समुद्री तेल रिसाव जाँच एवं पोत अभिनिर्धारण प्रणाली</p>
              <h1 className="text-lg font-bold text-[#0b2a55] tracking-wide uppercase">OceanSpill</h1>
            </div>
          </div>
          <div className="px-6 py-5">
            <h2 className="font-semibold text-gray-900">You have signed out</h2>
            <p className="text-sm text-gray-600 mt-1">Choose an account to sign in again.</p>
            <div className="mt-4 divide-y divide-gray-100 border border-gray-200 rounded-md">
              {accounts.map((u) => (
                <button key={u.id} onClick={() => signIn(u)} className="w-full text-left px-4 py-3 hover:bg-blue-50 flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-gray-900 truncate">{u.name}</span>
                    <span className="block text-xs text-gray-500 truncate">{u.agency}</span>
                  </span>
                  <span className="text-xs text-gray-600 flex-shrink-0">{u.role}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] bg-black/45 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
          <h3 className="font-bold text-gray-900">Help</h3>
          <button onClick={onClose} aria-label="Close help"><X className="w-5 h-5 text-gray-400 hover:text-gray-700" /></button>
        </div>
        <div className="p-4 overflow-y-auto text-xs text-gray-700 space-y-4 leading-relaxed">
          <section>
            <h4 className="font-bold text-gray-900 text-sm mb-1">How a case is analysed</h4>
            <ol className="list-decimal ml-4 space-y-1.5">
              <li><b>Detection.</b> The slick comes from the official report. SAR scenes from EOS-04 and Sentinel-1 are listed for each case; processed scenes add dark-spot measurements.</li>
              <li><b>Hindcast.</b> A particle model runs backward from the slick using currents, wind drift and the coastline, giving an estimated release point, time window and uncertainty.</li>
              <li><b>Attribution.</b> Vessels near that point and time are scored on proximity, timing, course, behaviour and registry history. When authorities reported the release point, vessels are scored against it instead.</li>
              <li><b>Response.</b> Verification, community alerts, ecological impact and the IMAC hand-off follow the workflow stages in order.</li>
            </ol>
          </section>
          <section>
            <h4 className="font-bold text-gray-900 text-sm mb-1">Reading the scores</h4>
            <p>
              Attribution scores rank vessels for inspection; they are not proof. Enforcement needs on-scene verification
              and a forensic match, and a case reaches enforcement only through those stages.
            </p>
          </section>
          <section>
            <h4 className="font-bold text-gray-900 text-sm mb-1">Using the system</h4>
            <ul className="list-disc ml-4 space-y-1">
              <li>Search finds cases, vessels (name, MMSI, IMO), protected areas, historical incidents and SAR scenes.</li>
              <li>Maps pan by dragging and zoom with the wheel. Case pages have a time scrubber for the incident window.</li>
              <li>The top bar switches times between UTC and IST and adjusts text size and contrast.</li>
              <li>Pages and editing rights follow the signed-in account's role. Your actions are kept in this browser.</li>
            </ul>
          </section>
          <section className="bg-slate-50 border border-slate-200 rounded p-4">
            <h4 className="font-bold text-gray-900 text-sm mb-1">Data sources</h4>
            <ul className="list-disc ml-4 space-y-1.5">
              <li><b>Incidents:</b> seven Indian oil spills with positions, times, vessels, quantities and outcomes from official and public sources.</li>
              <li><b>AIS:</b> Global Fishing Watch hourly vessel positions; national AIS (DGLL) is not connected.</li>
              <li><b>SAR:</b> ISRO Bhoonidhi (EOS-04) and Copernicus (Sentinel-1) catalogues. No segmentation model is trained yet.</li>
              <li><b>Ocean and weather:</b> ERA5 wind, Météo-France SMOC and Copernicus Marine currents; INCOIS feeds are not connected.</li>
              <li><b>Coastline:</b> OpenStreetMap.</li>
            </ul>
            <p className="mt-2">Values that are modelled, synthetic or still pending are labelled as such.</p>
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
