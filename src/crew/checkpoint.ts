import { checkpointKey, type GoalCheckpointDraft } from '../goal/store';
import type { Evidence } from '../goal/evaluator';

export interface Checkpoint {
  role: string;
  checkpointNumber: number;
  timestamp: string;
  currentTask: string;
  taskStatus: 'partial' | 'complete';
  completedWork: string[];
  remainingWork: string[];
  keyDecisions: string[];
  filesModified: string[];
  notes: string;
}

export function createCheckpoint(data: Partial<Checkpoint> & { role: string; currentTask: string }): Checkpoint {
  return {
    role: data.role,
    checkpointNumber: data.checkpointNumber ?? 1,
    timestamp: new Date().toISOString(),
    currentTask: data.currentTask,
    taskStatus: data.taskStatus ?? 'partial',
    completedWork: data.completedWork ?? [],
    remainingWork: data.remainingWork ?? [],
    keyDecisions: data.keyDecisions ?? [],
    filesModified: data.filesModified ?? [],
    notes: data.notes ?? '',
  };
}

export function checkpointToString(cp: Checkpoint): string {
  return JSON.stringify(cp, null, 2);
}

/**
 * Grading metadata attached by a *separate* evaluator when a crew checkpoint is
 * promoted into the durable goal-checkpoint log. Kept distinct from the crew
 * checkpoint itself so the worker (which builds the {@link Checkpoint}) never
 * supplies its own grade.
 */
export interface GoalCheckpointBridge {
  goalId: string;
  turn: number;
  /** Identity of the evaluator that graded this slice (proves worker separation). */
  evaluatorId: string;
  /** 0..1 progress toward the stopping condition, per the evaluator. */
  progress: number;
  /** Whether validation passed for this slice. */
  passed: boolean;
  /** Verification attempt count (defaults to 0 upstream; first attempt is 1). */
  attempt: number;
  /** Auditable evidence (reason/command/result) from the evaluator. */
  evidence: Evidence;
  command?: string;
  result?: string;
  timestamp?: string;
  blocked?: string | null;
}

/**
 * Bridge a crew {@link Checkpoint} into a durable {@link GoalCheckpointDraft}.
 *
 * This is how the crew's native checkpoint shape becomes an append-only entry in
 * `audits/goals/<id>/checkpoints.jsonl`. The draft is content-keyed via
 * {@link checkpointKey} so re-appending the same slice is a no-op (idempotent),
 * and the evaluator's grade travels alongside the worker's verified/remaining
 * work rather than being merged into it.
 */
export function toGoalCheckpointDraft(cp: Checkpoint, bridge: GoalCheckpointBridge): GoalCheckpointDraft {
  const verified = cp.completedWork.length
    ? cp.completedWork.join('; ')
    : cp.taskStatus === 'complete'
      ? cp.currentTask
      : `${cp.currentTask} (in progress)`;
  const remains = cp.remainingWork.length
    ? cp.remainingWork.join('; ')
    : cp.taskStatus === 'complete'
      ? 'none'
      : 'in progress';
  const title = `${cp.currentTask} — checkpoint ${cp.checkpointNumber}`.slice(0, 140);
  return {
    goalId: bridge.goalId,
    turn: bridge.turn,
    timestamp: bridge.timestamp ?? cp.timestamp,
    title,
    verified,
    remains,
    blocked: bridge.blocked ?? null,
    validation: {
      command: bridge.command,
      result: bridge.result,
      passed: bridge.passed,
      attempt: bridge.attempt,
    },
    evidence: bridge.evidence,
    evaluatorId: bridge.evaluatorId,
    progress: bridge.progress,
    key: checkpointKey({
      goalId: bridge.goalId,
      turn: bridge.turn,
      title,
      verified,
      validationResult: bridge.result,
      reason: bridge.evidence.reason,
    }),
  };
}
