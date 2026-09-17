import type { CaseStatus, WorkflowStage } from './types';
import shared from '../../shared/workflow.json';

/** Verification stages in order. A case moves one stage at a time, forward or back. The rules are
 * in shared/workflow.json so the API enforces the same sequence. */
export const WORKFLOW_ORDER = shared.stages as WorkflowStage[];

export const stageIndex = (s: WorkflowStage) => WORKFLOW_ORDER.indexOf(s);

export function canMoveStage(from: WorkflowStage, to: WorkflowStage): { ok: boolean; reason?: string } {
  if (from === to) return { ok: true };
  const d = stageIndex(to) - stageIndex(from);
  if (Math.abs(d) === 1) return { ok: true };
  return { ok: false, reason: `Cases move one stage at a time; "${from}" can only go to "${WORKFLOW_ORDER[stageIndex(from) + 1] ?? from}"` };
}

const STATUS_MIN_STAGE = shared.statusMinStage as Partial<Record<CaseStatus, WorkflowStage>>;

export function canSetStatus(status: CaseStatus, stage: WorkflowStage): { ok: boolean; reason?: string } {
  const min = STATUS_MIN_STAGE[status];
  if (!min || stageIndex(stage) >= stageIndex(min)) return { ok: true };
  return { ok: false, reason: `"${status}" needs the case to reach "${min}" first` };
}

export const CASE_STATUSES = (shared.statuses as CaseStatus[]).filter((s) => s !== 'Dismissed — Look-alike');
