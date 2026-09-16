/**
 * Server mode: reading the shared state and sending changes back.
 *
 * The screens work on the same `World` object in both modes. Here the state that people change —
 * workflow, drafts, reports, planning areas, accounts and the audit trail — is read from the server
 * and merged into that object, and each action is sent back as it happens.
 */
import { api, serverMode, type Account } from './api';
import type {
  AreaOfInterest, AuditEntry, CaseStatus, CommunityAlert, EnforcementAction, SightingReport, SystemUser, WorkflowStage,
} from './types';
import type { World } from './world';

export interface CaseStateRow {
  caseId: string;
  status: CaseStatus;
  workflowStage: WorkflowStage;
  imacPushed: boolean;
  imacPushedAt: number | null;
  alertDispatched: boolean;
  lookalikeReason: string | null;
  updatedAt: number;
  version: number;
}

export interface SharedState {
  cases: Record<string, CaseStateRow>;
  alerts: CommunityAlert[];
  enforcement: EnforcementAction[];
  sightings: SightingReport[];
  sightingPatches: Record<string, { linkedCaseId: string | null; verified: boolean }>;
  aois: AreaOfInterest[];
  aoiPatches: Record<string, { pinned: boolean; priority: number; monitored: boolean }>;
  audit: AuditEntry[];
  users: SystemUser[];
}

export interface Detection {
  id: string;
  sceneId: string;
  aoiId: string | null;
  acquiredAt: number;
  outline: { lat: number; lon: number }[];
  position: { lat: number; lon: number };
  areaKm2: number;
  score: number | null;
  method: string;
  measurements: Record<string, number | null>;
  status: 'new' | 'confirmed' | 'dismissed' | 'promoted';
  reviewedAt: number | null;
  notes: string | null;
  caseId: string | null;
  createdAt: number;
}

export interface MonitoringSummary {
  newDetections: Detection[];
  scenesLastWeek: number;
  scenesLastDay: number;
  monitoredAreas: string[];
  queued: number;
  running: number;
  failedLastDay: number;
  lastScene: number | null;
}

export interface Scene {
  id: string;
  provider: string;
  platform: string;
  start: number;
  aoiId: string | null;
  sizeBytes: number | null;
  status: string;
  foundAt: number;
}

/** The server's own case state, which the version number protects against two people overwriting. */
const versions = new Map<string, number>();

export function caseVersion(caseId: string): number | undefined {
  return versions.get(caseId);
}

export function fetchState(): Promise<SharedState> {
  return api.get<SharedState>('/api/state');
}

/** Copies everything people have changed onto the case data loaded from the artifacts. */
export function applyState(world: World, state: SharedState): void {
  for (const c of world.cases) {
    const row = state.cases[c.id];
    if (!row) continue;
    versions.set(c.id, row.version);
    c.status = row.status;
    c.workflowStage = row.workflowStage;
    c.imacPushed = row.imacPushed;
    c.imacPushedAt = row.imacPushedAt ?? undefined;
    c.alertDispatched = row.alertDispatched;
    c.lookalikeReason = row.lookalikeReason ?? undefined;
    if (row.updatedAt) c.updatedAt = row.updatedAt;
  }

  replaceSession(world.alerts, state.alerts);
  replaceSession(world.enforcement, state.enforcement);
  replaceSession(world.sightings, state.sightings);
  for (const s of world.sightings) {
    const patch = state.sightingPatches[s.id];
    if (!patch) continue;
    s.linkedCaseId = patch.linkedCaseId ?? undefined;
    s.verified = patch.verified;
  }

  replaceSession(world.aois, state.aois);
  for (const a of world.aois) {
    const patch = state.aoiPatches[a.id];
    if (patch) {
      a.pinned = patch.pinned;
      a.priority = patch.priority;
    }
  }
  world.aois.sort((a, b) => a.priority - b.priority);

  world.audit.splice(0, world.audit.length, ...state.audit, ...world.audit.filter((a) => a.provenance !== 'session'));
  world.audit.sort((a, b) => b.t - a.t);

  if (state.users.length) world.users.splice(0, world.users.length, ...state.users);
}

/** Replaces the rows that came from this system, leaving the published record alone. */
function replaceSession<T extends { provenance: string }>(target: T[], incoming: T[]): void {
  const published = target.filter((x) => x.provenance !== 'session');
  target.splice(0, target.length, ...incoming, ...published);
}

export interface CaseStatePatch {
  status?: CaseStatus;
  workflowStage?: WorkflowStage;
  note?: string;
  imacPushed?: boolean;
  alertDispatched?: boolean;
  lookalikeReason?: string;
}

export async function patchCaseState(caseId: string, patch: CaseStatePatch): Promise<CaseStateRow> {
  const row = await api.patch<CaseStateRow>(`/api/cases/${caseId}/state`, { ...patch, version: versions.get(caseId) });
  versions.set(caseId, row.version);
  return row;
}

export function postAlert(alert: Omit<CommunityAlert, 'id' | 'reach' | 'status' | 'provenance' | 'issuer'> & { capXml?: string }) {
  return api.post<CommunityAlert>('/api/alerts', {
    caseId: alert.caseId, channel: alert.channel, languages: alert.languages, districts: alert.districts,
    headline: alert.headline, body: alert.body, noGoRadiusKm: alert.noGoRadiusKm, centre: alert.centre,
    validUntil: alert.validUntil, capXml: alert.capXml,
  });
}

export function postEnforcement(action: Omit<EnforcementAction, 'id' | 'provenance'>) {
  return api.post<EnforcementAction>('/api/enforcement', action);
}

export function postSighting(report: Omit<SightingReport, 'id' | 'receivedAt' | 'verified' | 'provenance'>) {
  return api.post<SightingReport>('/api/sightings', report);
}

export function linkSighting(sightingId: string, caseId: string) {
  return api.post(`/api/sightings/${sightingId}/link`, { caseId });
}

export function verifySighting(sightingId: string) {
  return api.post(`/api/sightings/${sightingId}/verify`);
}

export function postAoi(aoi: Omit<AreaOfInterest, 'id' | 'provenance' | 'pinned' | 'requestedBy'> & { monitored?: boolean }) {
  return api.post<AreaOfInterest>('/api/aois', {
    name: aoi.name, priority: aoi.priority, bounds: aoi.bounds, rationale: aoi.rationale, monitored: aoi.monitored ?? false,
  });
}

export function patchAoi(id: string, patch: { pinned?: boolean; priority?: number; monitored?: boolean }) {
  return api.patch<AreaOfInterest>(`/api/aois/${id}`, patch);
}

export function postUser(user: Omit<SystemUser, 'id' | 'lastLogin' | 'mfa'> & { password?: string }) {
  return api.post<Account>('/api/users', {
    name: user.name, email: user.email, role: user.role, agency: user.agency,
    clearance: user.clearance, status: user.status, password: user.password,
  });
}

export function patchUser(id: string, patch: Partial<Pick<SystemUser, 'name' | 'role' | 'agency' | 'clearance' | 'status'>>) {
  return api.patch<Account>(`/api/users/${id}`, patch);
}

export function setUserPassword(id: string, password: string) {
  return api.post<Account>(`/api/users/${id}/password`, { password });
}

export function resetUserMfa(id: string) {
  return api.post<Account>(`/api/users/${id}/mfa/reset`);
}

export function postAudit(entry: Pick<AuditEntry, 'action' | 'target' | 'detail' | 'category'>) {
  return api.post<AuditEntry>('/api/audit', entry);
}

export function fetchMonitoring(): Promise<MonitoringSummary> {
  return api.get<MonitoringSummary>('/api/monitoring/summary');
}

export function fetchScenes(days = 14): Promise<Scene[]> {
  return api.get<Scene[]>(`/api/scenes?days=${days}`);
}

export function reviewDetection(id: string, status: 'confirmed' | 'dismissed', notes?: string) {
  return api.post<Detection>(`/api/detections/${id}/review`, { status, notes });
}

export interface ReportSection {
  heading: string;
  lines?: string[];
  pairs?: [string, string][];
  columns?: string[];
  rows?: string[][];
}

/** Renders a document on the server, which signs it, and hands the file to the browser. */
export async function downloadDocument(path: string, body?: unknown): Promise<string> {
  const { blob, filename } = await api.download(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

export function chainOfCustodyPdf(caseId: string): Promise<string> {
  return downloadDocument(`/api/cases/${caseId}/chain-of-custody`);
}

/**
 * Turns a plain-text briefing into document sections, so the same wording the screens compose is
 * what gets rendered and signed. Headings look like "3. INCIDENTS NEAR SHIPPING ROUTES".
 */
export function textToSections(text: string): ReportSection[] {
  const sections: ReportSection[] = [];
  let current: ReportSection | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^[=-]{10,}$/.test(line.trim())) continue;
    const heading = /^(\d+)\.\s+([A-Z][A-Z0-9 ,'()/&–—-]+)$/.exec(line.trim());
    if (heading) {
      current = { heading: heading[2].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { heading: 'Summary', lines: [] };
      sections.push(current);
    }
    current.lines!.push(line.replace(/^ {2}/, ''));
  }
  // Trim the blank lines that separate blocks in the text version.
  for (const s of sections) {
    while (s.lines?.length && !s.lines[0].trim()) s.lines.shift();
    while (s.lines?.length && !s.lines[s.lines.length - 1].trim()) s.lines.pop();
  }
  return sections.filter((s) => s.lines?.length);
}

export function reportPdf(body: { caseId?: string; kind: string; title: string; subtitle?: string; footnote?: string; sections: ReportSection[] }): Promise<string> {
  return downloadDocument('/api/reports', body);
}

export { serverMode };
