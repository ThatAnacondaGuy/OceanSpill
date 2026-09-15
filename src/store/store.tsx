import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { analysePolygon, haversineKm, type LatLon } from '../lib/geo';
import { forecast, hindcast, OIL_TYPES, weather, type ForecastResult, type HindcastResult } from '../engine/drift';
import { assessDetection, type DetectionAssessment } from '../engine/detection';
import { attributionVerdict, scoreCandidates, searchRadiusKm, DEFAULT_WEIGHTS, type ScoringWeights } from '../engine/attribution';
import { seaStateAt, type SeaState } from '../engine/ocean';
import { MODEL_SAMPLER, observedSampler, type FieldSampler, type SampledVector } from '../engine/forcing';
import { loadWorld, type World } from '../data/world';
import { ECOLOGICAL_AREAS } from '../data/geography';
import type { AuditEntry, CaseStatus, CommunityAlert, EnforcementAction, SightingReport, SpillCase, SystemUser, WorkflowStage } from '../data/types';

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
  setCaseStatus: (id: string, status: CaseStatus, detail?: string) => void;
  setWorkflowStage: (id: string, stage: WorkflowStage) => void;
  replayCase: (id: string) => void;
  pushToImac: (id: string) => void;
  draftAlert: (alert: Omit<CommunityAlert, 'id' | 'reach' | 'status' | 'provenance' | 'issuer'>) => void;
  addEnforcement: (a: Omit<EnforcementAction, 'id' | 'provenance'>) => void;
  addSighting: (s: Omit<SightingReport, 'id' | 'receivedAt' | 'verified' | 'provenance'>) => void;
  linkSighting: (sightingId: string, caseId: string) => void;
  verifySighting: (sightingId: string) => void;
  addUser: (u: Omit<SystemUser, 'id'>) => void;
  updateUser: (id: string, patch: Partial<SystemUser>) => void;
  toggleAoiPin: (id: string) => void;
  reorderAoi: (id: string, dir: -1 | 1) => void;
  log: (entry: Omit<AuditEntry, 'id' | 't' | 'provenance'>) => void;

  toasts: Toast[];
  dismissToast: (id: number) => void;
  notify: (t: Omit<Toast, 'id'>) => void;

  revision: number;
}

const Ctx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [world, setWorld] = useState<World | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadWorld().then(setWorld).catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#f0f4f8] p-6">
        <div className="bg-white border border-red-200 rounded-lg shadow p-6 max-w-lg">
          <h1 className="font-bold text-red-700 mb-2">Case data could not be loaded</h1>
          <p className="text-sm text-gray-700 mb-3">{error}</p>
          <p className="text-xs text-gray-500">Generate the artifacts with <code className="bg-gray-100 px-1 rounded">cd pipeline && uv run oceanspill build</code>, then reload.</p>
        </div>
      </div>
    );
  }
  if (!world) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#f0f4f8]">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-semibold text-gray-700">Loading real case data…</p>
        </div>
      </div>
    );
  }
  return <LoadedStore world={world}>{children}</LoadedStore>;
}

function LoadedStore({ world, children }: { world: World; children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(world.cases[0]?.id ?? null);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const [weights, setWeightsState] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [currentUser, setCurrentUser] = useState<SystemUser>(world.users[0]);

  const analysisCache = useRef(new Map<string, CaseAnalysis>());
  const samplers = useRef(new Map<string, FieldSampler>());
  const toastSeq = useRef(0);

  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(h);
  }, []);

  const bump = useCallback(() => setRevision((r) => r + 1), []);

  const notify = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastSeq.current;
    setToasts((list) => [...list, { ...t, id }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5200);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);

  const log = useCallback(
    (entry: Omit<AuditEntry, 'id' | 't' | 'provenance'>) => {
      world.audit.unshift({ ...entry, id: `SES-${String(world.audit.length + 1).padStart(5, '0')}`, t: Date.now(), provenance: 'session' });
      bump();
    },
    [world, bump]
  );

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
    const s = f ? observedSampler(f) : MODEL_SAMPLER;
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

      const { ranked, excluded } = scoreCandidates(candidates, {
        origin: hc.estimatedOrigin,
        originTime: hc.estimatedTime,
        windowHours: hc.timeWindowHours,
        uncertaintyKm: hc.uncertaintyRadiusKm,
        slickOrientationDeg: shape.orientationDeg,
        slickElongation: c.detection.extentReported ? shape.elongation : 1,
        weights,
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

      const windowMs = hc.timeWindowHours * HOUR;
      const result: CaseAnalysis = {
        caseId,
        assessment,
        sampler,
        hindcast: hc,
        forecast: fc,
        ranked,
        excluded,
        verdict: attributionVerdict(ranked),
        searchRadiusKm: searchRadiusKm(hc.uncertaintyRadiusKm),
        windowStart: hc.estimatedTime - windowMs * 1.35,
        windowEnd: hc.estimatedTime + windowMs,
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
      updateCase(id, { status });
      log({ actor: currentUser.name, role: currentUser.role, action: 'Status changed', target: id, detail: detail ?? `Status set to "${status}"`, category: 'Analysis' });
      notify({ kind: 'success', title: `${id} → ${status}`, body: detail });
    },
    [updateCase, log, notify, currentUser]
  );

  const setWorkflowStage = useCallback(
    (id: string, stage: WorkflowStage) => {
      updateCase(id, { workflowStage: stage });
      log({ actor: currentUser.name, role: currentUser.role, action: 'Workflow advanced', target: id, detail: `Moved to "${stage}"`, category: 'Dispatch' });
      notify({ kind: 'success', title: `${id} moved to ${stage}` });
    },
    [updateCase, log, notify, currentUser]
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
      log({ actor: currentUser.name, role: currentUser.role, action: 'IMAC payload generated', target: id, detail: 'Payload prepared locally; IMAC ingest endpoint not integrated', category: 'Dispatch' });
      notify({ kind: 'info', title: `IMAC payload generated for ${id}`, body: 'Delivery to IMAC needs Navy integration; the payload is available to download.' });
    },
    [updateCase, log, notify, currentUser]
  );

  const draftAlert = useCallback(
    (alert: Omit<CommunityAlert, 'id' | 'reach' | 'status' | 'provenance' | 'issuer'>) => {
      const id = `DRAFT-${String(world.alerts.length + 1).padStart(3, '0')}`;
      world.alerts.unshift({ ...alert, id, status: 'Draft', reach: null, issuer: currentUser.name, provenance: 'session' });
      const c = world.cases.find((x) => x.id === alert.caseId);
      if (c) c.alertDispatched = true;
      log({ actor: currentUser.name, role: currentUser.role, action: 'Community alert drafted', target: alert.caseId, detail: `${alert.channel.join(', ')} to ${alert.districts.join(', ')} (${alert.languages.join('/')})`, category: 'Alert' });
      notify({ kind: 'success', title: 'Alert drafted as CAP message', body: 'Publishing through SACHET requires NDMA authorisation.' });
      bump();
    },
    [world, log, notify, bump, currentUser]
  );

  const addEnforcement = useCallback(
    (a: Omit<EnforcementAction, 'id' | 'provenance'>) => {
      const id = `SES-ENF-${String(world.enforcement.length + 1).padStart(3, '0')}`;
      world.enforcement.unshift({ ...a, id, provenance: 'session' });
      log({ actor: currentUser.name, role: currentUser.role, action: a.type, target: a.caseId, detail: `${a.type} recorded against ${a.party}`, category: 'Enforcement' });
      notify({ kind: 'success', title: `${a.type} recorded`, body: a.party });
      bump();
    },
    [world, log, notify, bump, currentUser]
  );

  const addSighting = useCallback(
    (r: Omit<SightingReport, 'id' | 'receivedAt' | 'verified' | 'provenance'>) => {
      const id = `SES-RPT-${String(world.sightings.filter((x) => x.provenance === 'session').length + 1).padStart(3, '0')}`;
      world.sightings.unshift({ ...r, id, receivedAt: Date.now(), verified: false, provenance: 'session' });
      log({ actor: currentUser.name, role: currentUser.role, action: 'Field report logged', target: r.linkedCaseId ?? id, detail: `${r.severity} reported by ${r.reporter} (${r.district})`, category: 'Analysis' });
      notify({ kind: 'success', title: 'Field report logged', body: 'Marked unverified until an analyst confirms it.' });
      bump();
    },
    [world, log, notify, bump, currentUser]
  );

  const linkSighting = useCallback(
    (sightingId: string, caseId: string) => {
      const s = world.sightings.find((x) => x.id === sightingId);
      if (!s) return;
      s.linkedCaseId = caseId;
      log({ actor: currentUser.name, role: currentUser.role, action: 'Report linked to case', target: caseId, detail: `${sightingId} attached as corroborating evidence`, category: 'Analysis' });
      notify({ kind: 'success', title: `${sightingId} linked to ${caseId}` });
      bump();
    },
    [world, log, notify, bump, currentUser]
  );

  const verifySighting = useCallback(
    (sightingId: string) => {
      const s = world.sightings.find((x) => x.id === sightingId);
      if (!s) return;
      s.verified = true;
      log({ actor: currentUser.name, role: currentUser.role, action: 'Report verified', target: sightingId, detail: `Report from ${s.reporter} marked verified`, category: 'Analysis' });
      notify({ kind: 'success', title: 'Report verified' });
      bump();
    },
    [world, log, notify, bump, currentUser]
  );

  const addUser = useCallback(
    (u: Omit<SystemUser, 'id'>) => {
      const id = `U-${String(world.users.length + 1).padStart(3, '0')}`;
      world.users.push({ ...u, id });
      log({ actor: currentUser.name, role: currentUser.role, action: 'User created', target: id, detail: `${u.name} (${u.role}, ${u.agency})`, category: 'Access' });
      notify({ kind: 'success', title: 'User created', body: `${u.name} — ${u.role}` });
      bump();
    },
    [world, log, notify, bump, currentUser]
  );

  const updateUser = useCallback(
    (id: string, patch: Partial<SystemUser>) => {
      const u = world.users.find((x) => x.id === id);
      if (!u) return;
      Object.assign(u, patch);
      log({ actor: currentUser.name, role: currentUser.role, action: 'User updated', target: id, detail: Object.keys(patch).join(', '), category: 'Access' });
      bump();
    },
    [world, log, bump, currentUser]
  );

  const toggleAoiPin = useCallback(
    (id: string) => {
      const a = world.aois.find((x) => x.id === id);
      if (!a) return;
      a.pinned = !a.pinned;
      notify({ kind: 'info', title: a.pinned ? `${a.name} pinned` : `${a.name} unpinned` });
      bump();
    },
    [world, notify, bump]
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
      bump();
    },
    [world, bump]
  );

  const value = useMemo<StoreValue>(
    () => ({
      world, now, currentUser, setCurrentUser,
      activeTab, navigate, selectedCaseId, setSelectedCaseId, selectedMmsi, setSelectedMmsi,
      pendingSection, consumeSection, weights, setWeights, resetWeights, getAnalysis, samplerFor,
      updateCase, setCaseStatus, setWorkflowStage, replayCase, pushToImac, draftAlert, addEnforcement,
      addSighting, linkSighting, verifySighting, addUser, updateUser, toggleAoiPin, reorderAoi, log,
      toasts, dismissToast, notify, revision,
    }),
    [
      world, now, currentUser, activeTab, navigate, selectedCaseId, selectedMmsi, pendingSection, consumeSection,
      weights, setWeights, resetWeights, getAnalysis, samplerFor, updateCase, setCaseStatus, setWorkflowStage,
      replayCase, pushToImac, draftAlert, addEnforcement, addSighting, linkSighting, verifySighting, addUser, updateUser,
      toggleAoiPin, reorderAoi, log, toasts, dismissToast, notify, revision,
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

export const fmt = {
  utc(t: number): string {
    const d = new Date(t);
    return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  },
  utcShort(t: number): string {
    const d = new Date(t);
    return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  },
  date(t: number): string {
    const d = new Date(t);
    return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  },
  /** Formats a timestamp at the precision it is actually known to. */
  precise(t: number, precision: string): string {
    const d = new Date(t);
    if (precision === 'year') return String(d.getUTCFullYear());
    if (precision === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (precision === 'day') return fmt.date(t);
    return fmt.utc(t);
  },
  time(t: number): string {
    const d = new Date(t);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  },
  ago(t: number, now: number): string {
    const diff = now - t;
    const abs = Math.abs(diff);
    const suffix = diff < 0 ? 'from now' : 'ago';
    if (abs < 60_000) return 'just now';
    if (abs < HOUR) return `${Math.round(abs / 60000)} min ${suffix}`;
    if (abs < 86400_000) return `${(abs / HOUR).toFixed(1)} h ${suffix}`;
    if (abs < 60 * 86400_000) return `${Math.round(abs / 86400_000)} d ${suffix}`;
    if (abs < 730 * 86400_000) return `${Math.round(abs / (30.44 * 86400_000))} mo ${suffix}`;
    return `${(abs / (365.25 * 86400_000)).toFixed(1)} y ${suffix}`;
  },
  duration(msv: number): string {
    const h = Math.floor(msv / HOUR);
    const m = Math.round((msv % HOUR) / 60000);
    if (h === 0) return `${m} min`;
    if (h >= 48) return `${(msv / 86400_000).toFixed(1)} d`;
    return `${h} h ${String(m).padStart(2, '0')} min`;
  },
  num(n: number, digits = 0): string {
    return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  inr(n: number): string {
    if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
    if (n >= 100000) return `₹${(n / 100000).toFixed(2)} L`;
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
    if (v.mmsiNumber && !v.mmsiNumber.startsWith('999')) return `MMSI ${v.mmsiNumber}${v.imo ? ` · IMO ${v.imo}` : ''}`;
    if (v.mmsiNumber) return `Synthetic MMSI ${v.mmsiNumber}`;
    if (v.imo) return `IMO ${v.imo}`;
    return 'MMSI not public';
  },
};

export type { LatLon };
