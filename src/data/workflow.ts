import type { CaseStatus, WorkflowStage } from './types';

/** Verification stages in order. A case moves one stage at a time, forward or back. */
export const WORKFLOW_ORDER: WorkflowStage[] = [
  'Awaiting Dispatch', 'Patrol En Route', 'Sample Collected', 'Forensic Match Pending', 'Port Inspection Requested', 'Closed',
];

export const stageIndex = (s: WorkflowStage) => WORKFLOW_ORDER.indexOf(s);

export function canMoveStage(from: WorkflowStage, to: WorkflowStage): { ok: boolean; reason?: string } {
  if (from === to) return { ok: true };
  const d = stageIndex(to) - stageIndex(from);
  if (Math.abs(d) === 1) return { ok: true };
  return { ok: false, reason: `Cases move one stage at a time; "${from}" can only go to "${WORKFLOW_ORDER[stageIndex(from) + 1] ?? from}"` };
}

/** The earliest stage a case must have reached before it can carry each status. */
const STATUS_MIN_STAGE: Partial<Record<CaseStatus, WorkflowStage>> = {
  'Verification Dispatched': 'Patrol En Route',
  Verified: 'Sample Collected',
  Enforcement: 'Forensic Match Pending',
};

export function canSetStatus(status: CaseStatus, stage: WorkflowStage): { ok: boolean; reason?: string } {
  const min = STATUS_MIN_STAGE[status];
  if (!min || stageIndex(stage) >= stageIndex(min)) return { ok: true };
  return { ok: false, reason: `"${status}" needs the case to reach "${min}" first` };
}

export const CASE_STATUSES: CaseStatus[] = ['New', 'Under Analysis', 'Attributed', 'Verification Dispatched', 'Verified', 'Enforcement', 'Closed'];
