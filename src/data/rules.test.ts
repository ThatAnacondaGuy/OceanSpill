/**
 * The web app and the API read the same rule files. These tests pin the behaviour the screens rely
 * on; the matching Python tests pin the server side.
 */
import { describe, expect, it } from 'vitest';
import { CASE_STATUSES, WORKFLOW_ORDER, canMoveStage, canSetStatus } from './workflow';
import { MODULES, ROLE_MATRIX, allowedTabs, clearanceAllowsIdentities, moduleForTab, tabAccess } from './access';

describe('workflow', () => {
  it('moves one stage at a time, forward or back', () => {
    expect(canMoveStage('Awaiting Dispatch', 'Patrol En Route').ok).toBe(true);
    expect(canMoveStage('Patrol En Route', 'Awaiting Dispatch').ok).toBe(true);
    expect(canMoveStage('Awaiting Dispatch', 'Closed').ok).toBe(false);
  });

  it('explains a refused move in terms of the next stage', () => {
    const { reason } = canMoveStage('Awaiting Dispatch', 'Forensic Match Pending');
    expect(reason).toContain('Patrol En Route');
  });

  it('holds a status back until the case reaches the stage that supports it', () => {
    expect(canSetStatus('Verified', 'Awaiting Dispatch').ok).toBe(false);
    expect(canSetStatus('Verified', 'Sample Collected').ok).toBe(true);
    expect(canSetStatus('Enforcement', 'Sample Collected').ok).toBe(false);
    expect(canSetStatus('Enforcement', 'Forensic Match Pending').ok).toBe(true);
  });

  it('leaves the look-alike outcome out of the ordinary status list', () => {
    expect(CASE_STATUSES).not.toContain('Dismissed — Look-alike');
    expect(WORKFLOW_ORDER[0]).toBe('Awaiting Dispatch');
    expect(WORKFLOW_ORDER[WORKFLOW_ORDER.length - 1]).toBe('Closed');
  });
});

describe('role permissions', () => {
  it('gives the administrator role every module in full', () => {
    for (const m of MODULES) expect(ROLE_MATRIX['NTRO Admin'][m.id]).toBe('full');
  });

  it('keeps a viewer read-only everywhere they can go', () => {
    for (const m of MODULES) expect(ROLE_MATRIX.Viewer[m.id]).not.toBe('full');
  });

  it('keeps account administration away from everyone but NTRO', () => {
    expect(ROLE_MATRIX.Analyst.admin).toBe('none');
    expect(ROLE_MATRIX.Regulator.admin).toBe('none');
    expect(ROLE_MATRIX['NTRO Reviewer'].admin).toBe('read');
  });

  it('maps every tab to a module', () => {
    for (const m of MODULES) for (const tab of m.tabs) expect(moduleForTab(tab)?.id).toBe(m.id);
    expect(moduleForTab('Not a tab')).toBeUndefined();
  });

  it('only offers tabs a role may open', () => {
    const tabs = allowedTabs('Viewer');
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) expect(tabAccess('Viewer', tab)).not.toBe('none');
    expect(allowedTabs('NTRO Admin').length).toBeGreaterThan(tabs.length);
  });

  it('withholds vessel identifiers at restricted clearance only', () => {
    expect(clearanceAllowsIdentities('Restricted')).toBe(false);
    expect(clearanceAllowsIdentities('Confidential')).toBe(true);
    expect(clearanceAllowsIdentities('Secret')).toBe(true);
  });
});
