/**
 * Role permissions: one matrix drives the navigation, whether a page allows changes, and the API.
 * 'read' shows a page without its editing actions; 'none' hides it. The matrix lives in
 * shared/access.json so the server enforces exactly what the web app shows.
 */
import shared from '../../shared/access.json';

export type AccessLevel = 'full' | 'read' | 'none';

export const MODULES: { id: string; label: string; tabs: string[] }[] = shared.modules;

export const ROLE_MATRIX = shared.roles as Record<string, Record<string, AccessLevel>>;

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
  return !shared.restrictedClearance.includes(clearance);
}

export const READ_ONLY_HINT = 'Your role has read-only access to this page';
