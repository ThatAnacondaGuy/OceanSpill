import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { analysePolygon, haversineKm, type LatLon } from '../lib/geo';
import { forecast, hindcast, OIL_TYPES, weather, type ForecastResult, type HindcastResult } from '../engine/drift';
import { assessDetection, type DetectionAssessment } from '../engine/detection';
import { attributionVerdict, scoreCandidates, searchRadiusKm, DEFAULT_WEIGHTS, type ScoringWeights } from '../engine/attribution';
import { seaStateAt, type SeaState } from '../engine/ocean';
import { MODEL_SAMPLER, observedSampler, type FieldSampler, type SampledVector } from '../engine/forcing';
import { LandGrid } from '../engine/land';
import { loadWorld, type World } from '../data/world';
import { ApiError, hasToken, serverMode, setSignedOutHandler, signOut as apiSignOut, streamNotifications, whoAmI, type Account } from '../data/api';
import * as server from '../data/server';
import { SignIn } from '../SignIn';
import { ECOLOGICAL_AREAS } from '../data/geography';
import type { AreaOfInterest, AuditEntry, CaseStatus, CommunityAlert, EnforcementAction, SightingReport, SpillCase, SystemUser, WorkflowStage } from '../data/types';
import { clearanceAllowsIdentities, tabAccess, type AccessLevel } from '../data/access';
import { canMoveStage, canSetStatus } from '../data/workflow';

const HOUR = 3600_000;

export interface CaseAnalysis {
  caseId: string;
  assessment: DetectionAssessment;
  sampler: FieldSampler;
  hindcast: HindcastResult;
  forecast: ForecastResult;
  ranked: ReturnType<typeof scoreCandidates>['ranked'];
  excluded: ReturnType<typeof scoreCandidates>['excluded'];
  verdict: ReturnType<typeof attributionVerdict>;
  searchRadiusKm: number;
  /** Point vessels are scored against: the reported release point when known, else the hindcast estimate. */
  originBasis: 'reported' | 'hindcast';
  attributionOrigin: LatLon;
  attributionTime: number;
  windowStart: number;
  windowEnd: number;
  /** Hours between the incident and the reference observation, when the incident time is precise enough. */
  knownAgeHours: number | null;
  weathering: ReturnType<typeof weather> | null;
  threatenedAreas: { id: string; name: string; category: string; sensitivity: number; distanceKm: number; hoursToImpact: number | null; state: string }[];
  conditions: { wind: SampledVector; current: SampledVector; sea: SeaState };
  runtimeMs: number;
}

export interface Toast {
  id: number;
  kind: 'success' | 'info' | 'warn' | 'error';
  title: string;
  body?: string;
}

export interface NavTarget {
  tab: string;
  caseId?: string;
  mmsi?: string;
  section?: string;
}

interface StoreValue {
  world: World;
  now: number;
  currentUser: SystemUser;
  setCurrentUser: (u: SystemUser) => void;

  activeTab: string;
  navigate: (t: NavTarget) => void;
  selectedCaseId: string | null;
  setSelectedCaseId: (id: string | null) => void;
  selectedMmsi: string | null;
  setSelectedMmsi: (m: string | null) => void;
  pendingSection: string | null;
  consumeSection: () => string | null;

  weights: ScoringWeights;
  setWeights: (w: ScoringWeights) => void;
  resetWeights: () => void;

  getAnalysis: (caseId: string) => CaseAnalysis | null;
  samplerFor: (caseId: string) => FieldSampler;

  updateCase: (id: string, patch: Partial<SpillCase>) => void;
  setCaseStatus: (id: string, status: CaseStatus, detail?: string) => boolean;
  setWorkflowStage: (id: string, stage: WorkflowStage) => boolean;
  replayCase: (id: string) => void;
  /** Access level of the signed-in role for a page. */
  access: (tab: string) => AccessLevel;
  canEdit: (tab: string) => boolean;
  identitiesVisible: boolean;
  signedOut: boolean;
  signOut: () => void;
  signIn: (u: SystemUser) => void;
  timeZone: DisplayTimeZone;
  setTimeZone: (tz: DisplayTimeZone) => void;
  /** Discards changes saved in this browser and reloads the recorded cases. */
  resetSession: () => void;
  /** False when signed in against a server: the role then comes from the account, not a menu. */
  canSwitchAccount: boolean;
  /** True when the site is running against the server rather than the recorded files. */
  serverMode: boolean;
  /** Re-reads the shared state from the server. */
  refreshState: () => Promise<void>;
  pushToImac: (id: string) => void;
  draftAlert: (alert: Omit<CommunityAlert, 'id' | 'reach' | 'status' | 'provenance' | 'issuer'>) => void;
  addEnforcement: (a: Omit<EnforcementAction, 'id' | 'provenance'>) => void;
  addSighting: (s: Omit<SightingReport, 'id' | 'receivedAt' | 'verified' | 'provenance'>) => void;
  linkSighting: (sightingId: string, caseId: string) => void;
  verifySighting: (sightingId: string) => void;
  addUser: (u: Omit<SystemUser, 'id'>) => void;
  addAoi: (a: Omit<AreaOfInterest, 'id' | 'provenance' | 'pinned' | 'requestedBy'>) => void;
  updateUser: (id: string, patch: Partial<SystemUser>) => void;
  toggleAoiPin: (id: string) => void;
  reorderAoi: (id: string, dir: -1 | 1) => void;
  /** Adds an entry to the audit trail. `server: true` also sends it, for actions the browser
   * performs by itself; anything the server did records itself. */
  log: (entry: Omit<AuditEntry, 'id' | 't' | 'provenance'>, options?: { server?: boolean }) => void;

  toasts: Toast[];
  dismissToast: (id: number) => void;
  notify: (t: Omit<Toast, 'id'>) => void;

  revision: number;
}

const Ctx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [world, setWorld] = useState<World | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  // Against a server, nothing is loaded until we know who is asking.
  const [checkingSession, setCheckingSession] = useState(serverMode);

  useEffect(() => {
    if (!serverMode) return;
    setSignedOutHandler(() => {
      setAccount(null);
      setWorld(null);
    });
    if (!hasToken()) {
      setCheckingSession(false);
      return () => setSignedOutHandler(null);
    }
    whoAmI()
      .then(setAccount)
      .catch(() => undefined)
      .finally(() => setCheckingSession(false));
    return () => setSignedOutHandler(null);
  }, []);

  useEffect(() => {
    if (serverMode && !account) return;
    // Keep the first loaded world: a second load (React runs effects twice in development) would
    // replace the restored session with a fresh copy and overwrite what was saved.
    (async () => {
      const w = await loadWorld();
      if (serverMode) server.applyState(w, await server.fetchState());
      setWorld((prev) => prev ?? w);
    })().catch((e: Error) => setError(e.message));
  }, [account]);

  if (serverMode && checkingSession) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#f0f4f8]">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (serverMode && !account) return <SignIn onSignedIn={setAccount} />;

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#f0f4f8] p-6">
        <div className="bg-white border border-red-200 rounded-lg shadow p-6 max-w-lg">
          <h1 className="font-bold text-red-700 mb-2">Case data could not be loaded</h1>
          <p className="text-sm text-gray-700 mb-3">{error}</p>
          <p className="text-xs text-gray-500">Try reloading. If the problem continues, contact the system administrator.</p>
        </div>
      </div>
    );
  }
  if (!world) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#f0f4f8]">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-semibold text-gray-700">Loading case data…</p>
        </div>
      </div>
    );
  }
  return <LoadedStore world={world} account={account}>{children}</LoadedStore>;
}

/** The signed-in account as the app's own user record. */
function asUser(account: Account): SystemUser {
  return {
    id: account.id, name: account.name, email: account.email, role: account.role as SystemUser['role'],
    agency: account.agency, status: account.status, lastLogin: account.lastLogin, mfa: account.mfa,
    clearance: account.clearance,
  };
}

const SESSION_KEY = 'oceanspill.session.v1';
const PREFS_KEY = 'oceanspill.prefs.v1';
const CASE_FIELDS = ['status', 'workflowStage', 'imacPushed', 'imacPushedAt', 'alertDispatched', 'lookalikeReason', 'updatedAt'] as const;

interface SessionSnapshot {
  cases: Record<string, Partial<SpillCase>>;
  audit: AuditEntry[];
  alerts: CommunityAlert[];
  enforcement: EnforcementAction[];
  sightings: SightingReport[];
  sightingPatches: Record<string, { linkedCaseId?: string; verified: boolean }>;
  users: SystemUser[];
  aois: AreaOfInterest[];
  aoiPatches: Record<string, { pinned: boolean; priority: number }>;
  weights: ScoringWeights;
  currentUserId: string;
  signedOut: boolean;
}

/** Actions taken in the app are kept in this browser so they survive a reload. */
function saveSession(world: World, weights: ScoringWeights, currentUserId: string, signedOut: boolean) {
  const snap: SessionSnapshot = {
    cases: Object.fromEntries(world.cases.map((c) => [c.id, Object.fromEntries(CASE_FIELDS.map((f) => [f, c[f]]))])),
    audit: world.audit.filter((a) => a.provenance === 'session'),
    alerts: world.alerts.filter((a) => a.provenance === 'session'),
    enforcement: world.enforcement.filter((e) => e.provenance === 'session'),
    sightings: world.sightings.filter((x) => x.provenance === 'session'),
    sightingPatches: Object.fromEntries(world.sightings.filter((x) => x.provenance !== 'session').map((x) => [x.id, { linkedCaseId: x.linkedCaseId, verified: x.verified }])),
    users: world.users,
    aois: world.aois.filter((a) => a.provenance === 'session'),
    aoiPatches: Object.fromEntries(world.aois.map((a) => [a.id, { pinned: a.pinned, priority: a.priority }])),
    weights,
    currentUserId,
    signedOut,
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(snap));
  } catch {
    // Storage full or disabled: the session simply is not kept.
  }
}

function restoreSession(world: World): SessionSnapshot | null {
  let snap: SessionSnapshot;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    snap = JSON.parse(raw);
  } catch {
    return null;
  }
  // Restoring can run twice (React re-runs state initialisers in development), so skip entries already present.
  const fresh = <T extends { id: string }>(existing: T[], incoming: T[] | undefined) =>
    (incoming ?? []).filter((x) => !existing.some((y) => y.id === x.id));
  for (const c of world.cases) Object.assign(c, snap.cases?.[c.id] ?? {});
  world.audit.unshift(...fresh(world.audit, snap.audit));
  world.audit.sort((x, y) => y.t - x.t);
  world.alerts.unshift(...fresh(world.alerts, snap.alerts));
  world.enforcement.unshift(...fresh(world.enforcement, snap.enforcement));
  world.sightings.unshift(...fresh(world.sightings, snap.sightings));
  for (const x of world.sightings) Object.assign(x, snap.sightingPatches?.[x.id] ?? {});
  if (snap.users?.length) world.users.splice(0, world.users.length, ...snap.users);
  world.aois.push(...(snap.aois ?? []).filter((a) => !world.aois.some((b) => b.id === a.id)));
  for (const a of world.aois) Object.assign(a, snap.aoiPatches?.[a.id] ?? {});
  return snap;
}

export type DisplayTimeZone = 'UTC' | 'IST';

function loadPrefs(): { timeZone: DisplayTimeZone } {
  try {
    return { timeZone: 'UTC', ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { timeZone: 'UTC' };
  }
}

function LoadedStore({ world, account, children }: { world: World; account: Account | null; children: ReactNode }) {
  // With a server, the server is the record: nothing is restored from or kept in this browser.
  const [restored] = useState(() => (serverMode ? null : restoreSession(world)));
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(world.cases[0]?.id ?? null);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const [weights, setWeightsState] = useState<ScoringWeights>(restored?.weights ?? DEFAULT_WEIGHTS);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [currentUser, setCurrentUserState] = useState<SystemUser>(
    () => (account ? world.users.find((u) => u.id === account.id) ?? asUser(account) : null)
      ?? world.users.find((u) => u.id === restored?.currentUserId)
      ?? world.users[0]
  );
  const [signedOut, setSignedOut] = useState(restored?.signedOut ?? false);
  const [timeZone, setTimeZoneState] = useState<DisplayTimeZone>(() => {
    const tz = loadPrefs().timeZone;
    setDisplayTimeZone(tz);
    return tz;
  });
  identitiesVisibleFlag = clearanceAllowsIdentities(currentUser.clearance);

  const analysisCache = useRef(new Map<string, CaseAnalysis>());
  const samplers = useRef(new Map<string, FieldSampler>());
  const toastSeq = useRef(0);

  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(h);
  }, []);

  const bump = useCallback(() => setRevision((r) => r + 1), []);

  useEffect(() => {
    if (serverMode) return;
    saveSession(world, weights, currentUser.id, signedOut);
  }, [world, weights, currentUser, signedOut, revision]);

  const notify = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastSeq.current;
    setToasts((list) => [...list, { ...t, id }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5200);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);

  const log = useCallback(
    (entry: Omit<AuditEntry, 'id' | 't' | 'provenance'>, options?: { server?: boolean }) => {
      world.audit.unshift({ ...entry, id: `SES-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, t: Date.now(), provenance: 'session' });
      bump();
      // The server records everything it was asked to do, so entries are only sent for what the
      // browser does on its own; otherwise the same action would appear twice in the trail.
      if (serverMode && options?.server) {
        void server.postAudit({ action: entry.action, target: entry.target, detail: entry.detail, category: entry.category }).catch(() => undefined);
      }
    },
    [world, bump]
  );

  /** Re-reads the shared state, so the screen matches the record after anything unexpected. */
  const refreshState = useCallback(async () => {
    if (!serverMode) return;
    try {
      server.applyState(world, await server.fetchState());
      bump();
    } catch {
      // Leave what is on screen; the next action or notification will try again.
    }
  }, [world, bump]);

  /**
   * Sends a change to the server. The screen has already been updated, so a refusal — a permission,
   * a workflow rule, someone else editing the same case — is reported and the record read back.
   */
  const sync = useCallback(
    (run: () => Promise<unknown>, title: string) => {
      if (!serverMode) return;
      run().catch(async (e: unknown) => {
        notify({ kind: 'error', title, body: e instanceof ApiError ? e.message : 'The server could not be reached.' });
        await refreshState();
      });
    },
    [notify, refreshState]
  );

  useEffect(() => {
    if (!serverMode) return;
    // Anything the server or the background worker does reaches the people signed in.
    return streamNotifications(0, (n) => {
      notify({ kind: n.kind === 'warning' ? 'warn' : n.kind === 'error' ? 'error' : n.kind === 'success' ? 'success' : 'info', title: n.title, body: n.body });
      void refreshState();
    });
  }, [notify, refreshState]);

  const setWeights = useCallback((w: ScoringWeights) => {
    setWeightsState(w);
    analysisCache.current.clear();
    bump();
  }, [bump]);

  const resetWeights = useCallback(() => setWeights(DEFAULT_WEIGHTS), [setWeights]);

  const samplerFor = useCallback((caseId: string): FieldSampler => {
    const cached = samplers.current.get(caseId);
    if (cached) return cached;
    const f = world.forcing.get(caseId);
    const coast = world.coast.get(caseId);
    const base = f ? observedSampler(f) : MODEL_SAMPLER;
    const s: FieldSampler = coast ? { ...base, land: new LandGrid(coast) } : base;
    samplers.current.set(caseId, s);
    return s;
  }, [world]);

  const getAnalysis = useCallback(
    (caseId: string): CaseAnalysis | null => {
      const key = `${caseId}|${Object.values(weights).join('|')}`;
      const cached = analysisCache.current.get(key);
      if (cached) return cached;
      const c = world.cases.find((x) => x.id === caseId);
      if (!c) return null;

      const t0 = performance.now();
      const sampler = samplerFor(caseId);
      const shape = analysePolygon(c.detection.polygon.ring);
      const ref = c.detection.acquiredAt;
      const assessment = assessDetection(c.detection, c.facts.officiallyConfirmed, c.sourceType);
      // When the incident time is reported to the hour and precedes the observation within the
      // hindcast horizon, integrate back to it: the release time is known, not something to estimate.
      // Otherwise (imprecise dates, or a later observation of a continuing leak) use the full horizon.
      const age = (ref - c.incidentTime) / HOUR;
      const ageUsable = age >= 0 && age <= c.hindcastHours;
      const precision = c.facts.incident.timePrecision;
      const hoursBack = ['minute', 'hour'].includes(precision) && ageUsable ? Math.max(0.5, age) : c.hindcastHours;
      const hc = hindcast(shape.centroid, ref, hoursBack, {}, 12, hashSeed(c.id), sampler);
      const fc = forecast(shape.centroid, ref, c.forecastHours, {}, hashSeed(c.id) + 5, sampler);

      const candidates = c.candidateMmsis
        .map((m) => ({ vessel: world.vesselsByMmsi.get(m)!, track: world.tracks.get(m)! }))
        .filter((x) => x.vessel && x.track);

      // When authorities reported where and when the release happened, score vessels against that
      // point; the hindcast estimate is only needed when the origin is unknown.
      const knownOrigin = ['minute', 'hour'].includes(precision) && ageUsable && c.facts.incident.positionPrecisionKm <= 5;
      const attributionOrigin = knownOrigin ? c.facts.incident.position : hc.estimatedOrigin;
      const attributionTime = knownOrigin ? c.incidentTime : hc.estimatedTime;
      const attributionUncertaintyKm = knownOrigin ? Math.max(2, c.facts.incident.positionPrecisionKm) : hc.uncertaintyRadiusKm;
      const windowHours = knownOrigin ? 1.5 : hc.timeWindowHours;

      const { ranked, excluded } = scoreCandidates(candidates, {
        origin: attributionOrigin,
        originTime: attributionTime,
        windowHours,
        uncertaintyKm: attributionUncertaintyKm,
        slickOrientationDeg: shape.orientationDeg,
        slickElongation: c.detection.extentReported ? shape.elongation : 1,
        weights,
        originBasis: knownOrigin ? 'reported' : 'hindcast',
      });

      const windSample = sampler.wind(shape.centroid, ref);
      const currentSample = sampler.current(shape.centroid, ref);
      const sea = seaStateAt(shape.centroid, new Date(ref), {
        windSpeedMs: windSample.origin === 'observed' ? windSample.speed : null,
        waveHeightM: sampler.waveHeight(shape.centroid, ref),
      });

      const knownAgeHours = ['minute', 'hour', 'day'].includes(precision) && ageUsable ? age : null;
      const oil = OIL_TYPES[c.oilType];
      const weathering = oil && knownAgeHours != null ? weather(oil, Math.max(0.1, knownAgeHours), windSample.speed, sea.seaSurfaceTempC) : null;

      const threatenedAreas = ECOLOGICAL_AREAS.map((area) => {
        let minDist = Infinity;
        let hoursToImpact: number | null = null;
        for (const h of fc.horizons) {
          for (const pt of area.ring) {
            const d = haversineKm(h.centroid, pt) - h.spreadKm;
            if (d < minDist) {
              minDist = d;
              if (d <= 0 && hoursToImpact === null) hoursToImpact = h.hours;
            }
          }
        }
        for (const pt of area.ring) minDist = Math.min(minDist, haversineKm(shape.centroid, pt));
        return { id: area.id, name: area.name, category: area.category, sensitivity: area.sensitivity, state: area.state, distanceKm: Math.max(0, minDist), hoursToImpact };
      })
        .filter((a) => a.distanceKm < 400)
        .sort((a, b) => a.distanceKm - b.distanceKm);

      const windowMs = windowHours * HOUR;
      const result: CaseAnalysis = {
        caseId,
        assessment,
        sampler,
        hindcast: hc,
        forecast: fc,
        ranked,
        excluded,
        verdict: attributionVerdict(ranked, knownOrigin ? 'reported' : 'hindcast'),
        searchRadiusKm: searchRadiusKm(attributionUncertaintyKm),
        windowStart: attributionTime - windowMs * 1.35,
        windowEnd: attributionTime + windowMs,
        originBasis: knownOrigin ? 'reported' : 'hindcast',
        attributionOrigin,
        attributionTime,
        knownAgeHours,
        weathering,
        threatenedAreas,
        conditions: { wind: windSample, current: currentSample, sea },
        runtimeMs: performance.now() - t0,
      };
      analysisCache.current.set(key, result);
      return result;
    },
    [world, weights, samplerFor]
  );

  const navigate = useCallback((t: NavTarget) => {
    setActiveTab(t.tab);
    if (t.caseId !== undefined) setSelectedCaseId(t.caseId);
    if (t.mmsi !== undefined) setSelectedMmsi(t.mmsi);
    setPendingSection(t.section ?? null);
  }, []);

  const consumeSection = useCallback(() => {
    const s = pendingSection;
    setPendingSection(null);
    return s;
  }, [pendingSection]);

  const updateCase = useCallback(
    (id: string, patch: Partial<SpillCase>) => {
      const c = world.cases.find((x) => x.id === id);
      if (!c) return;
      Object.assign(c, patch, { updatedAt: Date.now() });
      bump();
    },
    [world, bump]
  );

  const setCaseStatus = useCallback(
    (id: string, status: CaseStatus, detail?: string) => {
      const c = world.cases.find((x) => x.id === id);
      if (!c) return false;
      const check = canSetStatus(status, c.workflowStage);
      if (!check.ok) {
        notify({ kind: 'error', title: 'Status not changed', body: check.reason });
        return false;
      }
      updateCase(id, { status });
      sync(() => server.patchCaseState(id, { status, note: detail }), 'Status not saved');
      log({ actor: currentUser.name, role: currentUser.role, action: 'Status changed', target: id, detail: detail ?? `Status set to "${status}"`, category: 'Analysis' });
      notify({ kind: 'success', title: `${id} → ${status}`, body: detail });
      return true;
    },
    [world, updateCase, log, notify, sync, currentUser]
  );

  const setWorkflowStage = useCallback(
    (id: string, stage: WorkflowStage) => {
      const c = world.cases.find((x) => x.id === id);
      if (!c) return false;
      const check = canMoveStage(c.workflowStage, stage);
      if (!check.ok) {
        notify({ kind: 'error', title: 'Stage not changed', body: check.reason });
        return false;
      }
      updateCase(id, { workflowStage: stage });
      sync(() => server.patchCaseState(id, { workflowStage: stage }), 'Stage not saved');
      log({ actor: currentUser.name, role: currentUser.role, action: 'Workflow advanced', target: id, detail: `Moved to "${stage}"`, category: 'Dispatch' });
      notify({ kind: 'success', title: `${id} moved to ${stage}` });
      return true;
    },
    [world, updateCase, log, notify, sync, currentUser]
  );

  const replayCase = useCallback(
    (id: string) => {
      updateCase(id, { status: 'Under Analysis', workflowStage: 'Awaiting Dispatch', imacPushed: false, alertDispatched: false, lookalikeReason: undefined });
      log({ actor: currentUser.name, role: currentUser.role, action: 'Replay restarted', target: id, detail: 'Workflow reset for retrospective replay', category: 'Analysis' });
      notify({ kind: 'info', title: `${id} reset for replay` });
    },
    [updateCase, log, notify, currentUser]
  );

  const pushToImac = useCallback(
    (id: string) => {
      updateCase(id, { imacPushed: true, imacPushedAt: Date.now() });
      sync(() => server.patchCaseState(id, { imacPushed: true }), 'Not recorded on the server');
      log({ actor: currentUser.name, role: currentUser.role, action: 'IMAC payload generated', target: id, detail: 'Payload prepared locally; IMAC ingest endpoint not integrated', category: 'Dispatch' });
      notify({ kind: 'info', title: `IMAC payload generated for ${id}`, body: 'Delivery to IMAC needs Navy integration; the payload is available to download.' });
    },
    [updateCase, log, notify, sync, currentUser]
  );

  const draftAlert = useCallback(
    (alert: Omit<CommunityAlert, 'id' | 'reach' | 'status' | 'provenance' | 'issuer'>) => {
      const id = `DRAFT-${String(world.alerts.length + 1).padStart(3, '0')}`;
      const draft: CommunityAlert = { ...alert, id, status: 'Draft', reach: null, issuer: currentUser.name, provenance: 'session' };
      if (serverMode) {
        sync(async () => {
          const saved = await server.postAlert(alert);
          world.alerts.unshift(saved);
          const target = world.cases.find((x) => x.id === alert.caseId);
          if (target) target.alertDispatched = true;
          bump();
        }, 'Alert not saved');
      } else {
        world.alerts.unshift(draft);
      }
      const c = world.cases.find((x) => x.id === alert.caseId);
      if (c) c.alertDispatched = true;
      log({ actor: currentUser.name, role: currentUser.role, action: 'Community alert drafted', target: alert.caseId, detail: `${alert.channel.join(', ')} to ${alert.districts.join(', ')} (${alert.languages.join('/')})`, category: 'Alert' });
      notify({ kind: 'success', title: 'Alert drafted as CAP message', body: 'Publishing through SACHET requires NDMA authorisation.' });
      bump();
    },
    [world, log, notify, bump, sync, currentUser]
  );

  const addEnforcement = useCallback(
    (a: Omit<EnforcementAction, 'id' | 'provenance'>) => {
      const id = `SES-ENF-${String(world.enforcement.length + 1).padStart(3, '0')}`;
      if (serverMode) {
        sync(async () => {
          world.enforcement.unshift(await server.postEnforcement(a));
          bump();
        }, 'Action not saved');
      } else {
        world.enforcement.unshift({ ...a, id, provenance: 'session' });
      }
      log({ actor: currentUser.name, role: currentUser.role, action: a.type, target: a.caseId, detail: `${a.type} recorded against ${a.party}`, category: 'Enforcement' });
      notify({ kind: 'success', title: `${a.type} recorded`, body: a.party });
      bump();
    },
    [world, log, notify, bump, sync, currentUser]
  );

  const addSighting = useCallback(
    (r: Omit<SightingReport, 'id' | 'receivedAt' | 'verified' | 'provenance'>) => {
      const id = `SES-RPT-${String(world.sightings.filter((x) => x.provenance === 'session').length + 1).padStart(3, '0')}`;
      if (serverMode) {
        sync(async () => {
          world.sightings.unshift(await server.postSighting(r));
          bump();
        }, 'Report not saved');
      } else {
        world.sightings.unshift({ ...r, id, receivedAt: Date.now(), verified: false, provenance: 'session' });
      }
      log({ actor: currentUser.name, role: currentUser.role, action: 'Field report logged', target: r.linkedCaseId ?? id, detail: `${r.severity} reported by ${r.reporter} (${r.district})`, category: 'Analysis' });
      notify({ kind: 'success', title: 'Field report logged', body: 'Marked unverified until an analyst confirms it.' });
      bump();
    },
    [world, log, notify, bump, sync, currentUser]
  );

  const linkSighting = useCallback(
    (sightingId: string, caseId: string) => {
      const s = world.sightings.find((x) => x.id === sightingId);
      if (!s) return;
      s.linkedCaseId = caseId;
      sync(() => server.linkSighting(sightingId, caseId), 'Link not saved');
      log({ actor: currentUser.name, role: currentUser.role, action: 'Report linked to case', target: caseId, detail: `${sightingId} attached as corroborating evidence`, category: 'Analysis' });
      notify({ kind: 'success', title: `${sightingId} linked to ${caseId}` });
      bump();
    },
    [world, log, notify, bump, sync, currentUser]
  );

  const verifySighting = useCallback(
    (sightingId: string) => {
      const s = world.sightings.find((x) => x.id === sightingId);
      if (!s) return;
      s.verified = true;
      sync(() => server.verifySighting(sightingId), 'Not saved');
      log({ actor: currentUser.name, role: currentUser.role, action: 'Report verified', target: sightingId, detail: `Report from ${s.reporter} marked verified`, category: 'Analysis' });
      notify({ kind: 'success', title: 'Report verified' });
      bump();
    },
    [world, log, notify, bump, sync, currentUser]
  );

  const addUser = useCallback(
    (u: Omit<SystemUser, 'id'>) => {
      const id = `U-${String(world.users.length + 1).padStart(3, '0')}`;
      if (serverMode) {
        sync(async () => {
          const created = await server.postUser(u);
          world.users.push(asUser(created));
          bump();
        }, 'Account not created');
      } else {
        world.users.push({ ...u, id });
      }
      log({ actor: currentUser.name, role: currentUser.role, action: 'User created', target: id, detail: `${u.name} (${u.role}, ${u.agency})`, category: 'Access' });
      notify({ kind: 'success', title: 'User created', body: `${u.name} — ${u.role}` });
      bump();
    },
    [world, log, notify, bump, sync, currentUser]
  );

  const updateUser = useCallback(
    (id: string, patch: Partial<SystemUser>) => {
      const u = world.users.find((x) => x.id === id);
      if (!u) return;
      Object.assign(u, patch);
      sync(() => server.patchUser(id, patch), 'Account not updated');
      log({ actor: currentUser.name, role: currentUser.role, action: 'User updated', target: id, detail: Object.keys(patch).join(', '), category: 'Access' });
      bump();
    },
    [world, log, bump, sync, currentUser]
  );

  const addAoi = useCallback(
    (a: Omit<AreaOfInterest, 'id' | 'provenance' | 'pinned' | 'requestedBy'>) => {
      const id = `AOI-SES-${String(world.aois.length + 1).padStart(2, '0')}`;
      const local: AreaOfInterest = { ...a, id, pinned: false, requestedBy: currentUser.role, provenance: 'session' };
      if (serverMode) {
        sync(async () => {
          world.aois.push(await server.postAoi(a));
          bump();
        }, 'Planning area not saved');
      } else {
        world.aois.push(local);
      }
      log({ actor: currentUser.name, role: currentUser.role, action: 'Planning area created', target: id, detail: a.name, category: 'System' });
      bump();
    },
    [world, log, bump, sync, currentUser]
  );

  const toggleAoiPin = useCallback(
    (id: string) => {
      const a = world.aois.find((x) => x.id === id);
      if (!a) return;
      a.pinned = !a.pinned;
      sync(() => server.patchAoi(id, { pinned: a.pinned }), 'Not saved');
      notify({ kind: 'info', title: a.pinned ? `${a.name} pinned` : `${a.name} unpinned` });
      bump();
    },
    [world, notify, bump, sync]
  );

  const reorderAoi = useCallback(
    (id: string, dir: -1 | 1) => {
      const sorted = [...world.aois].sort((a, b) => a.priority - b.priority);
      const i = sorted.findIndex((a) => a.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sorted.length) return;
      const pi = sorted[i].priority;
      sorted[i].priority = sorted[j].priority;
      sorted[j].priority = pi;
      sync(async () => {
        await server.patchAoi(sorted[i].id, { priority: sorted[i].priority });
        await server.patchAoi(sorted[j].id, { priority: sorted[j].priority });
      }, 'Order not saved');
      bump();
    },
    [world, bump, sync]
  );

  const setCurrentUser = useCallback((u: SystemUser) => {
    setCurrentUserState(u);
    analysisCache.current.clear();
  }, []);

  const access = useCallback((tab: string) => tabAccess(currentUser.role, tab), [currentUser.role]);
  const canEdit = useCallback((tab: string) => tabAccess(currentUser.role, tab) === 'full', [currentUser.role]);

  const signOut = useCallback(() => {
    if (serverMode) {
      // Ends the session on the server too, then the app returns to the sign-in screen.
      void apiSignOut().finally(() => setSignedOutHandler(null));
      window.setTimeout(() => window.location.reload(), 150);
      return;
    }
    log({ actor: currentUser.name, role: currentUser.role, action: 'Signed out', target: currentUser.id, detail: currentUser.email, category: 'Access' });
    setSignedOut(true);
  }, [log, currentUser]);

  const signIn = useCallback((u: SystemUser) => {
    setCurrentUser(u);
    setSignedOut(false);
    log({ actor: u.name, role: u.role, action: 'Signed in', target: u.id, detail: u.email, category: 'Access' });
  }, [log, setCurrentUser]);

  const setTimeZone = useCallback((tz: DisplayTimeZone) => {
    setDisplayTimeZone(tz);
    setTimeZoneState(tz);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), timeZone: tz }));
    } catch {
      // Preference is only kept for this visit.
    }
    bump();
  }, [bump]);

  const resetSession = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    window.location.reload();
  }, []);

  const identitiesVisible = clearanceAllowsIdentities(currentUser.clearance);
  // Against a server the role comes from the account you signed in with, so it cannot be switched here.
  const canSwitchAccount = !serverMode;

  const value = useMemo<StoreValue>(
    () => ({
      world, now, currentUser, setCurrentUser,
      activeTab, navigate, selectedCaseId, setSelectedCaseId, selectedMmsi, setSelectedMmsi,
      pendingSection, consumeSection, weights, setWeights, resetWeights, getAnalysis, samplerFor,
      updateCase, setCaseStatus, setWorkflowStage, replayCase, pushToImac, draftAlert, addEnforcement,
      addSighting, linkSighting, verifySighting, addUser, updateUser, addAoi, toggleAoiPin, reorderAoi, log,
      toasts, dismissToast, notify, revision,
      access, canEdit, identitiesVisible, signedOut, signOut, signIn, timeZone, setTimeZone, resetSession,
      canSwitchAccount, serverMode, refreshState,
    }),
    [
      world, now, currentUser, activeTab, navigate, selectedCaseId, selectedMmsi, pendingSection, consumeSection,
      weights, setWeights, resetWeights, getAnalysis, samplerFor, updateCase, setCaseStatus, setWorkflowStage,
      replayCase, pushToImac, draftAlert, addEnforcement, addSighting, linkSighting, verifySighting, addUser, updateUser,
      addAoi, toggleAoiPin, reorderAoi, log, toasts, dismissToast, notify, revision,
      access, canEdit, identitiesVisible, signedOut, signOut, signIn, timeZone, setTimeZone, resetSession,
      canSwitchAccount, refreshState,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore must be used inside StoreProvider');
  return v;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let displayTz: DisplayTimeZone = 'UTC';
let identitiesVisibleFlag = true;

/** Chooses whether timestamps are shown in UTC or Indian Standard Time (UTC+05:30). */
export function setDisplayTimeZone(tz: DisplayTimeZone) {
  displayTz = tz;
}

/** A Date whose UTC fields read as the selected display time zone. */
function shifted(t: number): Date {
  return new Date(displayTz === 'IST' ? t + 5.5 * HOUR : t);
}

const pad = (n: number) => String(n).padStart(2, '0');

export const fmt = {
  zone(): DisplayTimeZone {
    return displayTz;
  },
  utc(t: number): string {
    const d = shifted(t);
    return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${displayTz}`;
  },
  utcShort(t: number): string {
    const d = shifted(t);
    return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  },
  date(t: number): string {
    const d = shifted(t);
    return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  },
  /** Formats a timestamp at the precision it is actually known to. */
  precise(t: number, precision: string): string {
    const d = shifted(t);
    if (precision === 'year') return String(d.getUTCFullYear());
    if (precision === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (precision === 'day') return fmt.date(t);
    return fmt.utc(t);
  },
  time(t: number): string {
    const d = shifted(t);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  },
  ago(t: number, now: number): string {
    const diff = now - t;
    const abs = Math.abs(diff);
    const suffix = diff < 0 ? 'from now' : 'ago';
    if (abs < 60_000) return 'just now';
    if (abs < HOUR) return `${Math.round(abs / 60000)} min ${suffix}`;
    if (abs < 86400_000) return `${(abs / HOUR).toFixed(1)} h ${suffix}`;
    if (abs < 60 * 86400_000) return `${Math.round(abs / 86400_000)} d ${suffix}`;
    if (abs < 730 * 86400_000) return `${Math.round(abs / (30.44 * 86400_000))} months ${suffix}`;
    return `${(abs / (365.25 * 86400_000)).toFixed(1)} years ${suffix}`;
  },
  duration(msv: number): string {
    const h = Math.floor(msv / HOUR);
    const m = Math.round((msv % HOUR) / 60000);
    if (h === 0) return `${m} min`;
    if (h >= 48) return `${(msv / 86400_000).toFixed(1)} d`;
    return `${h} h ${String(m).padStart(2, '0')} min`;
  },
  /** Hours for short spans, days beyond three days. */
  hoursOrDays(hours: number): string {
    return hours > 72 ? `${(hours / 24).toFixed(1)} d` : `${hours.toFixed(1)} h`;
  },
  num(n: number, digits = 0): string {
    return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  inr(n: number): string {
    // Drop trailing zeros: ₹110 Cr, ₹5.25 Cr.
    const trim = (x: number) => String(Number(x.toFixed(2)));
    if (n >= 10000000) return `₹${trim(n / 10000000)} Cr`;
    if (n >= 100000) return `₹${trim(n / 100000)} L`;
    return `₹${n.toLocaleString('en-IN')}`;
  },
  pct(n: number, digits = 1): string {
    return `${(n * 100).toFixed(digits)}%`;
  },
  /** Confidence text that never presents an official confirmation as a model probability. */
  confidence(c: Pick<SpillCase, 'confidence' | 'confidenceBasis'>): string {
    return c.confidenceBasis === 'official-report' ? 'Official' : `${(c.confidence * 100).toFixed(0)}%`;
  },
  vesselId(v: { mmsiNumber: string | null; imo: string | null; isFacility: boolean }): string {
    if (v.isFacility) return 'Fixed facility';
    if (!identitiesVisibleFlag) return 'MMSI / IMO withheld at your clearance';
    if (v.mmsiNumber && !v.mmsiNumber.startsWith('999')) return `MMSI ${v.mmsiNumber}${v.imo ? ` · IMO ${v.imo}` : ''}`;
    if (v.mmsiNumber) return `Synthetic MMSI ${v.mmsiNumber}`;
    if (v.imo) return `IMO ${v.imo}`;
    return 'MMSI not public';
  },
  /** A single identifier (MMSI or IMO) respecting the viewer's clearance. */
  ident(value: string | null | undefined, fallback = '—'): string {
    if (!value) return fallback;
    return identitiesVisibleFlag ? value : 'Withheld';
  },
};

export type { LatLon };
