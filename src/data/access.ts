/**
 * Role permissions: one matrix drives both the navigation and whether a page allows changes.
 * 'read' shows a page without its editing actions; 'none' hides it.
 */
export type AccessLevel = 'full' | 'read' | 'none';

export const MODULES: { id: string; label: string; tabs: string[] }[] = [
  { id: 'incidents', label: 'Dashboard & incidents', tabs: ['Dashboard', 'Spill Incidents'] },
  { id: 'investigation', label: 'Investigation tools', tabs: ['Investigation'] },
  { id: 'vessels', label: 'Vessel analysis', tabs: ['Vessel Analysis'] },
  { id: 'environment', label: 'Environmental data', tabs: ['Environmental Data'] },
  { id: 'satellite', label: 'Satellite tasking', tabs: ['Satellite Tasking'] },
  { id: 'ecology', label: 'Ecological planning', tabs: ['NCSCM Ecological'] },
  { id: 'alerting', label: 'Community alerting', tabs: ['SACHET / SAMUDRA'] },
  { id: 'workflow', label: 'Workflow & enforcement', tabs: ['Workflow'] },
  { id: 'liability', label: 'Liability register', tabs: ['Offender Registry'] },
  { id: 'reports', label: 'Reports & analytics', tabs: ['Reports'] },
  { id: 'data', label: 'Data management & IMAC', tabs: ['Data Management'] },
  { id: 'archive', label: 'Case archive', tabs: ['Case Archive'] },
  { id: 'admin', label: 'System administration', tabs: ['System Admin'] },
];

const all = (level: AccessLevel, except: Record<string, AccessLevel> = {}) =>
  Object.fromEntries(MODULES.map((m) => [m.id, except[m.id] ?? level])) as Record<string, AccessLevel>;

export const ROLE_MATRIX: Record<string, Record<string, AccessLevel>> = {
  'NTRO Admin': all('full'),
  'NTRO Reviewer': all('full', { admin: 'read' }),
  Analyst: all('full', { admin: 'none', data: 'none' }),
  Regulator: all('none', { liability: 'full', workflow: 'full', incidents: 'read', reports: 'read', archive: 'read' }),
  Liaison: all('none', { data: 'full', incidents: 'read', investigation: 'read', workflow: 'read', archive: 'read' }),
  'Data Operator': all('none', { environment: 'full', satellite: 'full', data: 'read', incidents: 'read', reports: 'read' }),
  Viewer: all('none', { incidents: 'read', ecology: 'read', reports: 'read', archive: 'read' }),
};

export function moduleForTab(tab: string) {
  return MODULES.find((m) => m.tabs.includes(tab));
}

export function tabAccess(role: string, tab: string): AccessLevel {
  const m = moduleForTab(tab);
  return m ? ROLE_MATRIX[role]?.[m.id] ?? 'none' : 'none';
}

export function allowedTabs(role: string): string[] {
  return MODULES.flatMap((m) => ((ROLE_MATRIX[role]?.[m.id] ?? 'none') !== 'none' ? m.tabs : []));
}

/** Restricted clearance withholds raw SAR imagery and vessel identifiers (MMSI / IMO). */
export function clearanceAllowsIdentities(clearance: string): boolean {
  return clearance !== 'Restricted';
}

export const READ_ONLY_HINT = 'Your role has read-only access to this page';
