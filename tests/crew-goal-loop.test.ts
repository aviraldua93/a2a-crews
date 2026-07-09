import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  Crew,
  Task,
  createCheckpoint,
  crewCompletionEvaluator,
  crewGoalId,
  toGoalCheckpointDraft,
  type TaskRunner,
} from '../src/crew';
import { EvaluatorSeparationError, GoalStore, type Evaluator } from '../src/goal';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'a2a-crew-loop-'));
});
afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function fixedNow(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString();
}

/** A store rooted at the isolated temp dir; staging disabled so no git side effects. */
function store(): GoalStore {
  return new GoalStore({ baseDir: base, autoStage: false, now: fixedNow() });
}

function featureCrew(): Crew {
  return new Crew({
    name: 'Feature Team',
    scenario: 'ship feature X',
    process: 'wave',
    agents: [],
    tasks: [
      new Task({ id: 'design', title: 'Design', assignedTo: 'architect' }),
      new Task({ id: 'build', title: 'Build', assignedTo: 'coder', dependsOn: ['design'] }),
      new Task({ id: 'review', title: 'Review', assignedTo: 'reviewer', dependsOn: ['build'] }),
    ],
  });
}

// ── Checkpoint → goal-checkpoint bridge ────────────────────────────────

describe('toGoalCheckpointDraft', () => {
  test('maps a crew checkpoint into a durable, keyed draft', () => {
    const cp = createCheckpoint({
      role: 'coder',
      checkpointNumber: 2,
      currentTask: 'wave 2/3',
      taskStatus: 'partial',
      completedWork: ['build'],
      remainingWork: ['review'],
    });
    const draft = toGoalCheckpointDraft(cp, {
      goalId: 'crew-x',
      turn: 2,
      evaluatorId: 'crew-evaluator',
      progress: 0.66,
      passed: true,
      attempt: 2,
      evidence: { reason: '2/3 done' },
      command: 'crews watch',
      result: 'tasks_completed=2 tasks_total=3 tasks_failed=0',
    });
    expect(draft.goalId).toBe('crew-x');
    expect(draft.turn).toBe(2);
    expect(draft.verified).toBe('build');
    expect(draft.remains).toBe('review');
    expect(draft.evaluatorId).toBe('crew-evaluator');
    expect(draft.validation.passed).toBe(true);
    expect(draft.validation.attempt).toBe(2);
    expect(draft.evidence.reason).toBe('2/3 done');
    expect(draft.key).toMatch(/^[0-9a-f]{16}$/);
  });

  test('key is stable for identical content and changes with content', () => {
    const cp = createCheckpoint({ role: 'r', checkpointNumber: 1, currentTask: 'wave 1/1', completedWork: ['a'] });
    const keyFor = (result: string): string =>
      toGoalCheckpointDraft(cp, {
        goalId: 'g',
        turn: 1,
        evaluatorId: 'e',
        progress: 1,
        passed: true,
        attempt: 1,
        evidence: { reason: 'done' },
        command: 'c',
        result,
      }).key;
    expect(keyFor('same')).toBe(keyFor('same'));
    expect(keyFor('same')).not.toBe(keyFor('different'));
  });
});

// ── Crew.kickoff durable loop ──────────────────────────────────────────

describe('Crew.kickoff', () => {
  test('completes when all tasks succeed and writes durable two-tier state', async () => {
    const crew = featureCrew();
    const s = store();
    const out = await crew.kickoff({ store: s, now: fixedNow(), emitEvents: false });

    // Working tier: returned in-memory result.
    expect(out.tasks.length).toBe(3);
    expect(out.tasks.every(t => t.status === 'completed')).toBe(true);
    expect(out.waves).toBe(3);

    // Durable tier: files under audits/goals/<id>/.
    const id = crewGoalId('Feature Team');
    expect(id).toBe('crew-feature-team');
    expect(existsSync(s.contractJsonPath(id))).toBe(true);
    expect(existsSync(s.goalMdPath(id))).toBe(true);
    expect(existsSync(s.retrospectivePath(id))).toBe(true);

    const rec = s.readRecord(id);
    expect(rec).not.toBeNull();
    expect(rec!.state).toBe('completed');
    expect(rec!.achievedCondition).toBe(rec!.contract.stoppingCondition);

    const cps = s.readCheckpoints(id);
    expect(cps.length).toBe(3);
    expect(cps[cps.length - 1].progress).toBe(1);
    // Every checkpoint was graded by the separate evaluator, not the worker.
    expect(cps.every(c => c.evaluatorId === 'crew-evaluator')).toBe(true);
    expect(cps.every(c => c.evaluatorId !== 'crew:Feature Team')).toBe(true);
  });

  test('runs waves in dependency order through the worker', async () => {
    const crew = featureCrew();
    const seen: string[] = [];
    const runTask: TaskRunner = (task, ctx) => {
      seen.push(`${ctx.wave}:${task.id}`);
      return { taskId: task.id, status: 'completed', durationMs: 1 };
    };
    const out = await crew.kickoff({ store: store(), runTask, emitEvents: false });
    expect(seen).toEqual(['1:design', '2:build', '3:review']);
    expect(out.waves).toBe(3);
  });

  test('rejects an evaluator whose id collides with the worker', async () => {
    const crew = featureCrew();
    const collide = crewCompletionEvaluator('crew:Feature Team');
    await expect(crew.kickoff({ store: store(), evaluator: collide, emitEvents: false })).rejects.toThrow(
      EvaluatorSeparationError,
    );
  });

  test('throws if the evaluator impersonates the worker id at grade time', async () => {
    const crew = featureCrew();
    const liar: Evaluator = {
      id: 'honest-id',
      evaluate: () => ({ conditionMet: false, progress: 0, evaluatorId: 'crew:Feature Team', evidence: { reason: 'x' } }),
    };
    await expect(crew.kickoff({ store: store(), evaluator: liar, emitEvents: false })).rejects.toThrow(
      EvaluatorSeparationError,
    );
  });

  test('does not falsely complete when a task fails', async () => {
    const crew = featureCrew();
    const runTask: TaskRunner = task =>
      task.id === 'build'
        ? { taskId: task.id, status: 'failed', durationMs: 1 }
        : { taskId: task.id, status: 'completed', durationMs: 1 };
    const s = store();
    const out = await crew.kickoff({ store: s, runTask, now: fixedNow(), emitEvents: false });

    const id = crewGoalId('Feature Team');
    const rec = s.readRecord(id);
    expect(rec!.state).toBe('active'); // not 'completed'
    expect(rec!.achievedCondition).toBeNull();
    expect(out.tasks.find(t => t.taskId === 'build')!.status).toBe('failed');
    expect(existsSync(s.retrospectivePath(id))).toBe(false); // retro only on completion
  });

  test('re-running the same crew appends no duplicate durable checkpoints', async () => {
    const s = store();
    await featureCrew().kickoff({ store: s, now: fixedNow(), emitEvents: false });
    const id = crewGoalId('Feature Team');
    const firstCount = s.readCheckpoints(id).length;
    expect(firstCount).toBe(3);

    await featureCrew().kickoff({ store: s, now: fixedNow(), emitEvents: false });
    expect(s.readCheckpoints(id).length).toBe(firstCount);
  });

  test('stages durable files on every checkpoint', async () => {
    const crew = featureCrew();
    const staged: string[] = [];
    const s = new GoalStore({ baseDir: base, stage: paths => staged.push(...paths), now: fixedNow() });
    await crew.kickoff({ store: s, now: fixedNow(), emitEvents: false });

    expect(staged.filter(p => p.endsWith('checkpoints.jsonl')).length).toBeGreaterThanOrEqual(3);
    expect(staged.some(p => p.endsWith('contract.json'))).toBe(true);
    expect(staged.some(p => p.endsWith('goal.md'))).toBe(true);
  });
});
