import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { analysePolygon, haversineKm, type LatLon } from '../lib/geo';
import { forecast, hindcast, OIL_TYPES, estimateAge, weather, type ForecastResult, type HindcastResult } from '../engine/drift';
import { assessDetection, type DetectionAssessment } from '../engine/detection';
import { attributionVerdict, scoreCandidates, searchRadiusKm, DEFAULT_WEIGHTS, type ScoringWeights } from '../engine/attribution';
import { seaStateAt, windAt, currentAt } from '../engine/ocean';
import { buildWorld, NOW, type World } from '../data/world';
import { ECOLOGICAL_AREAS } from '../data/geography';
import type {
  AttributionScore, AuditEntry, CaseStatus, CommunityAlert, EnforcementAction,
  SpillCase, SystemUser, WorkflowStage,
} from '../data/types';

const HOUR = 3600_000;

export interface CaseAnalysis {
  caseId: string;
  assessment: DetectionAssessment;
  hindcast: HindcastResult;
  forecast: ForecastResult;
  ranked: AttributionScore[];
  excluded: { mmsi: string; name: string; reason: string; cpaKm: number }[];
  verdict: ReturnType<typeof attributionVerdict>;
  searchRadiusKm: number;
  windowStart: number;
  windowEnd: number;
  age: ReturnType<typeof estimateAge>;
  weathering: ReturnType<typeof weather>;
  /** Ecologically sensitive areas the forecast path threatens, nearest first. */
  threatenedAreas: { id: string; name: string; category: string; sensitivity: number; distanceKm: number; hoursToImpact: number | null; state: string }[];
  conditions: { wind: ReturnType<typeof windAt>; sea: ReturnType<typeof seaStateAt>; current: ReturnType<typeof currentAt> };
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
  /** Live demonstration clock. */
  now: number;
  clockRunning: boolean;
  toggleClock: () => void;
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
  invalidate: (caseId?: string) => void;

  updateCase: (id: string, patch: Partial<SpillCase>) => void;
  setCaseStatus: (id: string, status: CaseStatus, detail?: string) => void;
  setWorkflowStage: (id: string, stage: WorkflowStage) => void;
  pushToImac: (id: string) => void;
  dispatchAlert: (alert: Omit<CommunityAlert, 'id' | 'reach' | 'status'>) => void;
  addEnforcement: (a: Omit<EnforcementAction, 'id'>) => void;
  linkSighting: (sightingId: string, caseId: string) => void;
  verifySighting: (sightingId: string) => void;
  addUser: (u: Omit<SystemUser, 'id'>) => void;
  updateUser: (id: string, patch: Partial<SystemUser>) => void;
  toggleAoiPin: (id: string) => void;
  reorderAoi: (id: string, dir: -1 | 1) => void;
  log: (entry: Omit<AuditEntry, 'id' | 't'>) => void;

  toasts: Toast[];
  dismissToast: (id: number) => void;
  notify: (t: Omit<Toast, 'id'>) => void;

  /** Bumped whenever the world mutates, so memoised consumers recompute. */
  revision: number;
}

const Ctx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const worldRef = useRef<World>(null as unknown as World);
  if (!worldRef.current) worldRef.current = buildWorld();
  const world = worldRef.current;

  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(NOW);
  const [clockRunning, setClockRunning] = useState(true);
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(world.cases[0]?.id ?? null);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const [weights, setWeightsState] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [currentUser, setCurrentUser] = useState<SystemUser>(world.users[0]);

  const analysisCache = useRef(new Map<string, CaseAnalysis>());
  const toastSeq = useRef(0);

  // The demonstration clock advances at 60x so drift and pass schedules visibly move.
  useEffect(() => {
    if (!clockRunning) return;
    const h = window.setInterval(() => setNow((t) => t + 60_000), 1000);
    return () => window.clearInterval(h);
  }, [clockRunning]);

  const bump = useCallback(() => setRevision((r) => r + 1), []);

  const notify = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastSeq.current;
    setToasts((list) => [...list, { ...t, id }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5200);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);

  const log = useCallback(
    (entry: Omit<AuditEntry, 'id' | 't'>) => {
      world.audit.unshift({ ...entry, id: `AUD-${String(world.audit.length + 1).padStart(5, '0')}`, t: Date.now() % 1 === 0 ? nowRef.current : nowRef.current });
      bump();
    },
    [world, bump]
  );

  const nowRef = useRef(now);
  nowRef.current = now;

  const invalidate = useCallback((caseId?: string) => {
    if (caseId) analysisCache.current.delete(caseId);
    else analysisCache.current.clear();
    bump();
  }, [bump]);

  const setWeights = useCallback((w: ScoringWeights) => {
    setWeightsState(w);
    analysisCache.current.clear();
    bump();
  }, [bump]);

  const resetWeights = useCallback(() => setWeights(DEFAULT_WEIGHTS), [setWeights]);

  const getAnalysis = useCallback(
    (caseId: string): CaseAnalysis | null => {
      const key = `${caseId}|${weights.proximity}|${weights.temporality}|${weights.trajectory}|${weights.behaviour}|${weights.vesselPrior}`;
      const cached = analysisCache.current.get(key);
      if (cached) return cached;

      const c = world.cases.find((x) => x.id === caseId);
      if (!c) return null;

      const shape = analysePolygon(c.detection.polygon.ring);
      const assessment = assessDetection(c.detection);
      const hc = hindcast(shape.centroid, c.detection.acquiredAt, c.hindcastHours, {}, 12, hashSeed(c.id));
      const fc = forecast(shape.centroid, c.detection.acquiredAt, c.forecastHours, {}, hashSeed(c.id) + 5);

      const candidates = c.candidateMmsis
        .map((m) => ({ vessel: world.vesselsByMmsi.get(m)!, track: world.tracks.get(m)! }))
        .filter((x) => x.vessel && x.track);

      const { ranked, excluded } = scoreCandidates(candidates, {
        origin: hc.estimatedOrigin,
        originTime: hc.estimatedTime,
        windowHours: hc.timeWindowHours,
        uncertaintyKm: hc.uncertaintyRadiusKm,
        slickOrientationDeg: shape.orientationDeg,
        slickElongation: shape.elongation,
        weights,
      });

      const conditions = {
        wind: windAt(shape.centroid, new Date(c.detection.acquiredAt)),
        sea: seaStateAt(shape.centroid, new Date(c.detection.acquiredAt)),
        current: currentAt(shape.centroid, new Date(c.detection.acquiredAt)),
      };

      const oil = OIL_TYPES[c.oilType];
      const age = estimateAge(
        oil,
        shape.areaKm2,
        assessment.contrastDb,
        c.estimatedVolumeM3,
        conditions.wind.speed,
        conditions.sea.seaSurfaceTempC
      );
      const weathering = weather(oil, age.ageHours, conditions.wind.speed, conditions.sea.seaSurfaceTempC);

      // Which protected areas the forecast envelope approaches, and how soon.
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
        for (const pt of area.ring) {
          const d = haversineKm(shape.centroid, pt);
          if (d < minDist) minDist = d;
        }
        return {
          id: area.id,
          name: area.name,
          category: area.category,
          sensitivity: area.sensitivity,
          state: area.state,
          distanceKm: Math.max(0, minDist),
          hoursToImpact,
        };
      })
        .filter((a) => a.distanceKm < 400)
        .sort((a, b) => a.distanceKm - b.distanceKm);

      const windowMs = hc.timeWindowHours * HOUR;
      const result: CaseAnalysis = {
        caseId,
        assessment,
        hindcast: hc,
        forecast: fc,
        ranked,
        excluded,
        verdict: attributionVerdict(ranked),
        searchRadiusKm: searchRadiusKm(hc.uncertaintyRadiusKm),
        windowStart: hc.estimatedTime - windowMs * 1.35,
        windowEnd: hc.estimatedTime + windowMs,
        age,
        weathering,
        threatenedAreas,
        conditions,
      };
      analysisCache.current.set(key, result);
      return result;
    },
    [world, weights]
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
      Object.assign(c, patch, { updatedAt: nowRef.current });
      analysisCache.current.clear();
      bump();
    },
    [world, bump]
  );

  const setCaseStatus = useCallback(
    (id: string, status: CaseStatus, detail?: string) => {
      updateCase(id, { status });
      log({
        actor: currentUser.name, role: currentUser.role, action: 'Status changed',
        target: id, detail: detail ?? `Status set to "${status}"`, category: 'Analysis',
      });
      notify({ kind: 'success', title: `${id} → ${status}`, body: detail });
    },
    [updateCase, log, notify, currentUser]
  );

  const setWorkflowStage = useCallback(
    (id: string, stage: WorkflowStage) => {
      updateCase(id, { workflowStage: stage });
      log({
        actor: currentUser.name, role: currentUser.role, action: 'Workflow advanced',
        target: id, detail: `Moved to "${stage}"`, category: 'Dispatch',
      });
      notify({ kind: 'success', title: `${id} moved to ${stage}` });
    },
    [updateCase, log, notify, currentUser]
  );

  const pushToImac = useCallback(
    (id: string) => {
      updateCase(id, { imacPushed: true, imacPushedAt: nowRef.current });
      log({
        actor: currentUser.name, role: currentUser.role, action: 'Pushed to IMAC',
        target: id, detail: 'Case record published to the common operating picture', category: 'Dispatch',
      });
      notify({ kind: 'success', title: `${id} published to IMAC`, body: 'Record is now visible in the Navy/Coast Guard common operating picture.' });
    },
    [updateCase, log, notify, currentUser]
  );

  const dispatchAlert = useCallback(
    (alert: Omit<CommunityAlert, 'id' | 'reach' | 'status'>) => {
      // Reach is modelled from district population coverage with realistic delivery failure.
      const perDistrict = 4800;
      const reach = alert.channel.map((ch) => {
        const base = ch === 'SMS' ? perDistrict * alert.districts.length
          : ch === 'WhatsApp' ? Math.round(perDistrict * alert.districts.length * 0.61)
          : ch === 'App Push' ? Math.round(perDistrict * alert.districts.length * 0.22)
          : ch === 'Coastal Siren' ? alert.districts.length * 3
          : alert.districts.length * 2;
        const failRate = ch === 'SMS' ? 0.048 : ch === 'WhatsApp' ? 0.037 : ch === 'App Push' ? 0.087 : 0;
        const failed = Math.round(base * failRate);
        return { channel: ch, sent: base, delivered: base - failed, failed };
      });
      const id = `ALT-2025-${String(43 + world.alerts.length).padStart(4, '0')}`;
      world.alerts.unshift({ ...alert, id, status: 'Dispatched', reach });
      const c = world.cases.find((x) => x.id === alert.caseId);
      if (c) c.alertDispatched = true;
      log({
        actor: currentUser.name, role: currentUser.role, action: 'Community alert dispatched',
        target: alert.caseId, detail: `${alert.channel.join(', ')} to ${alert.districts.join(', ')} in ${alert.languages.join('/')}`,
        category: 'Alert',
      });
      const total = reach.reduce((s, r) => s + r.delivered, 0);
      notify({ kind: 'success', title: 'Alert dispatched via SACHET', body: `${total.toLocaleString('en-IN')} recipients reached across ${alert.districts.length} districts.` });
      bump();
    },
    [world, log, notify, bump, currentUser]
  );

  const addEnforcement = useCallback(
    (a: Omit<EnforcementAction, 'id'>) => {
      const id = `ENF-2025-${String(12 + world.enforcement.length).padStart(4, '0')}`;
      world.enforcement.unshift({ ...a, id });
      log({
        actor: currentUser.name, role: currentUser.role, action: a.type,
        target: a.caseId, detail: `${a.type} issued by ${a.authority} (${a.reference})`, category: 'Enforcement',
      });
      notify({ kind: 'success', title: `${a.type} recorded`, body: a.reference });
      bump();
    },
    [world, log, notify, bump, currentUser]
  );

  const linkSighting = useCallback(
    (sightingId: string, caseId: string) => {
      const s = world.sightings.find((x) => x.id === sightingId);
      if (!s) return;
      s.linkedCaseId = caseId;
      log({
        actor: currentUser.name, role: currentUser.role, action: 'Sighting linked to case',
        target: caseId, detail: `Crowdsourced report ${sightingId} attached as corroborating evidence`, category: 'Analysis',
      });
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
      log({
        actor: currentUser.name, role: currentUser.role, action: 'Sighting verified',
        target: sightingId, detail: `Report from ${s.reporter} (${s.district}) marked verified`, category: 'Analysis',
      });
      notify({ kind: 'success', title: 'Sighting verified' });
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

  const toggleClock = useCallback(() => setClockRunning((r) => !r), []);

  const value = useMemo<StoreValue>(
    () => ({
      world, now, clockRunning, toggleClock, currentUser, setCurrentUser,
      activeTab, navigate, selectedCaseId, setSelectedCaseId, selectedMmsi, setSelectedMmsi,
      pendingSection, consumeSection,
      weights, setWeights, resetWeights,
      getAnalysis, invalidate,
      updateCase, setCaseStatus, setWorkflowStage, pushToImac, dispatchAlert, addEnforcement,
      linkSighting, verifySighting, addUser, updateUser, toggleAoiPin, reorderAoi, log,
      toasts, dismissToast, notify, revision,
    }),
    [
      world, now, clockRunning, toggleClock, currentUser, activeTab, navigate, selectedCaseId,
      selectedMmsi, pendingSection, consumeSection, weights, setWeights, resetWeights, getAnalysis,
      invalidate, updateCase, setCaseStatus, setWorkflowStage, pushToImac, dispatchAlert,
      addEnforcement, linkSighting, verifySighting, addUser, updateUser, toggleAoiPin, reorderAoi,
      log, toasts, dismissToast, notify, revision,
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

/** Shared formatting helpers used across every page. */
export const fmt = {
  utc(t: number): string {
    const d = new Date(t);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  },
  utcShort(t: number): string {
    const d = new Date(t);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  },
  time(t: number): string {
    const d = new Date(t);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  },
  ago(t: number, now: number): string {
    const diff = now - t;
    if (diff < 0) {
      const ahead = -diff;
      if (ahead < 3600_000) return `in ${Math.round(ahead / 60000)} min`;
      if (ahead < 86400_000) return `in ${(ahead / 3600_000).toFixed(1)} h`;
      return `in ${Math.round(ahead / 86400_000)} d`;
    }
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.round(diff / 60000)} min ago`;
    if (diff < 86400_000) return `${(diff / 3600_000).toFixed(1)} h ago`;
    return `${Math.round(diff / 86400_000)} d ago`;
  },
  duration(ms: number): string {
    const h = Math.floor(ms / 3600_000);
    const m = Math.round((ms % 3600_000) / 60000);
    if (h === 0) return `${m} min`;
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
};

export type { LatLon };
