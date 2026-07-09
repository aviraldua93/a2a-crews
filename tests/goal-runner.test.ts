import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertSeparateEvaluator,
  DefaultEvaluator,
  EvaluatorSeparationError,
  functionEvaluator,
  functionWorker,
  GoalRunner,
  GoalStore,
  nextAttempt,
  type GoalContract,
  type Worker,
  type WorkerResult,
} from '../src/goal';

function contract(overrides: Partial<GoalContract> = {}): Partial<GoalContract> {
  return {
    objective: 'Raise coverage to 80%',
    stoppingCondition: '`bun test` exits 0 and coverage >= 80%',
    validationLoop: 'bun test',
    inputsToReadFirst: ['tests/'],
    constraints: ['Tests stay green'],
    forbiddenMoves: ['No no-op tests'],
    checkpointCadence: 'every test file + suite green',
    ...overrides,
  };
}

/** Emits one scripted result per turn (repeats the last step when exhausted). */
function scriptedWorker(id: string, steps: Array<Omit<WorkerResult, 'workerId' | 'turn'>>): Worker {
  let i = 0;
  return functionWorker(id, ctx => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return { turn: ctx.turn, ...step };
  });
}

let base: string;
let runner: GoalRunner;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'a2a-goal-runner-'));
  runner = new GoalRunner({ store: new GoalStore({ baseDir: base, autoStage: false }), emitEvents: false });
});
afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── Evaluator is separate from the worker ────────────────────────────

describe('evaluator separation (worker does not self-grade)', () => {
  test('assertSeparateEvaluator throws when ids match', () => {
    expect(() => assertSeparateEvaluator({ id: 'same' }, { id: 'same' })).toThrow(EvaluatorSeparationError);
    expect(() => assertSeparateEvaluator({ id: 'worker' }, { id: 'grader' })).not.toThrow();
  });

  test('runTurn refuses a worker and evaluator that share an id', async () => {
    runner.start(contract());
    const worker = functionWorker('shared', ctx => ({ turn: ctx.turn, summary: 'did work' }));
    const evaluator = functionEvaluator('shared', () => ({ conditionMet: false, progress: 0, evidence: { reason: 'x' } }));
    await expect(runner.runTurn(worker, evaluator)).rejects.toThrow(EvaluatorSeparationError);
  });

  test('the grade comes from the evaluator, not the worker result', async () => {
    runner.start(contract());
    const worker = functionWorker('worker', ctx => ({ turn: ctx.turn, summary: 'claims success', command: 'bun test', result: 'coverage 99%', exitCode: 0 }));
    // A separate evaluator that always withholds completion, regardless of surfaced "success".
    const strict = functionEvaluator('strict-grader', () => ({ conditionMet: false, progress: 0.5, evidence: { reason: 'not yet' } }));
    const { evaluation } = await runner.runTurn(worker, strict);
    expect(evaluation.evaluatorId).toBe('strict-grader');
    expect(evaluation.conditionMet).toBe(false);
    expect(runner.status().state).toBe('active');
  });
});

// ── DefaultEvaluator grades only from surfaced evidence ──────────────

describe('DefaultEvaluator', () => {
  const evaluator = new DefaultEvaluator();

  test('declares met on clean validation + positive signal + threshold satisfied', () => {
    const result: WorkerResult = { workerId: 'w', turn: 1, summary: 'ran suite', command: 'bun test', result: 'all tests pass, coverage 82%', exitCode: 0 };
    const evaluation = evaluator.evaluate(contract() as GoalContract, result, []);
    expect(evaluation.conditionMet).toBe(true);
    expect(evaluation.progress).toBe(1);
  });

  test('withholds completion when the threshold is unmet even if validation is clean', () => {
    const result: WorkerResult = { workerId: 'w', turn: 1, summary: 'ran suite', command: 'bun test', result: 'all tests pass, coverage 61%', exitCode: 0 };
    const evaluation = evaluator.evaluate(contract() as GoalContract, result, []);
    expect(evaluation.conditionMet).toBe(false);
  });

  test('withholds completion when validation fails', () => {
    const result: WorkerResult = { workerId: 'w', turn: 1, summary: 'ran suite', command: 'bun test', result: 'coverage 90% but 2 failing', exitCode: 1 };
    const evaluation = evaluator.evaluate(contract() as GoalContract, result, []);
    expect(evaluation.conditionMet).toBe(false);
  });

  test('records auditable evidence (reason/command/result)', () => {
    const result: WorkerResult = { workerId: 'w', turn: 1, summary: 's', command: 'bun test', result: 'coverage 82% pass', exitCode: 0 };
    const evaluation = evaluator.evaluate(contract() as GoalContract, result, []);
    expect(evaluation.evidence.command).toBe('bun test');
    expect(evaluation.evidence.reason.length).toBeGreaterThan(0);
  });
});

// ── Run loop: stop on met, auto-pause on repeated failure ────────────

describe('run loop', () => {
  test('stops when the stopping condition is met', async () => {
    runner.start(contract());
    const worker = scriptedWorker('worker', [
      { summary: 'baseline', command: 'bun test', result: 'coverage 60% pass', exitCode: 0 },
      { summary: 'added tests', command: 'bun test', result: 'coverage 85%, all tests pass', exitCode: 0 },
    ]);
    const out = await runner.run(worker, new DefaultEvaluator(), { maxTurns: 10 });
    expect(out.status.state).toBe('completed');
    expect(out.status.achievedCondition).toBe('`bun test` exits 0 and coverage >= 80%');
    expect(out.turnsRun).toBe(2);
  });

  test('auto-pauses after two consecutive failures on the same slice', async () => {
    runner.start(contract());
    const worker = scriptedWorker('worker', [
      { summary: 'attempt', command: 'bun test', result: 'boom', exitCode: 1, sameSlice: true },
    ]);
    const out = await runner.run(worker, new DefaultEvaluator(), { maxTurns: 10 });
    expect(out.status.state).toBe('paused');
    expect(out.status.consecutiveFailures).toBe(2);
    expect(out.turnsRun).toBe(2);
  });

  test('a new slice resets the consecutive-failure counter', async () => {
    runner.start(contract());
    const worker = scriptedWorker('worker', [
      { summary: 'fail A', command: 'bun test', result: 'x', exitCode: 1, sameSlice: true },
      { summary: 'fail B (new slice)', command: 'bun test', result: 'x', exitCode: 1, sameSlice: false },
    ]);
    const first = await runner.runTurn(worker, new DefaultEvaluator());
    expect(first.status.consecutiveFailures).toBe(1);
    const second = await runner.runTurn(worker, new DefaultEvaluator());
    expect(second.status.consecutiveFailures).toBe(1);
    expect(second.status.state).toBe('active');
  });

  test('a checkpoint is written durably each turn', async () => {
    const rec = runner.start(contract());
    const worker = scriptedWorker('worker', [{ summary: 'slice', command: 'bun test', result: 'coverage 61% pass', exitCode: 0 }]);
    await runner.runTurn(worker, new DefaultEvaluator());
    await runner.runTurn(worker, new DefaultEvaluator());
    const checkpoints = runner.getStore().readCheckpoints(rec.id);
    expect(checkpoints.length).toBe(2);
    expect(existsSync(runner.getStore().checkpointsPath(rec.id))).toBe(true);
  });
});

// ── Attempt counter defaults to 0 (off-by-one fix) ───────────────────

describe('verification attempt counter', () => {
  test('nextAttempt defaults to 0 and first attempt is 1', () => {
    expect(nextAttempt()).toBe(1);
    expect(nextAttempt(0)).toBe(1);
    expect(nextAttempt(1)).toBe(2);
  });

  test('a fresh goal starts at 0 attempts and reaches 1 after one turn (no double count)', async () => {
    runner.start(contract());
    expect(runner.status().attempts).toBe(0);
    const worker = scriptedWorker('worker', [{ summary: 's', command: 'bun test', result: 'coverage 61% pass', exitCode: 0 }]);
    const { checkpoint } = await runner.runTurn(worker, new DefaultEvaluator());
    expect(runner.status().attempts).toBe(1);
    expect(checkpoint?.validation.attempt).toBe(1);
  });
});

// ── One active goal per session; replacement resets counters ─────────

describe('single active goal', () => {
  test('starting a new goal replaces the prior and resets counters', async () => {
    const first = runner.start(contract({ objective: 'Goal A' }));
    const worker = scriptedWorker('worker', [{ summary: 's', command: 'bun test', result: 'coverage 61% pass', exitCode: 0, tokens: 500 }]);
    await runner.runTurn(worker, new DefaultEvaluator());
    expect(runner.status().turns).toBe(1);
    expect(runner.status().tokenSpend).toBe(500);

    runner.start(contract({ objective: 'Goal B' }));
    const status = runner.status();
    expect(status.objective).toBe('Goal B');
    expect(status.turns).toBe(0);
    expect(status.tokenSpend).toBe(0);
    expect(status.attempts).toBe(0);

    // The prior goal is cleared in durable storage, not deleted.
    expect(runner.getStore().readRecord(first.id)?.state).toBe('cleared');
  });
});

// ── Lifecycle: pause / resume / clear + retrospective ────────────────

describe('lifecycle', () => {
  test('pause preserves state and resume re-primes to active', async () => {
    runner.start(contract());
    const worker = scriptedWorker('worker', [{ summary: 's', command: 'bun test', result: 'coverage 61% pass', exitCode: 0 }]);
    await runner.runTurn(worker, new DefaultEvaluator());

    expect(runner.pause().state).toBe('paused');
    const resumed = runner.resume();
    expect(resumed.state).toBe('active');
    expect(resumed.turns).toBe(1); // counters preserved across pause/resume
  });

  test('clear writes a retrospective and keeps history', () => {
    const rec = runner.start(contract());
    const status = runner.clear();
    expect(status.state).toBe('cleared');
    expect(existsSync(runner.getStore().retrospectivePath(rec.id))).toBe(true);
    expect(runner.getStore().readRecord(rec.id)?.state).toBe('cleared');
  });

  test('clear accepts aliases', () => {
    for (const alias of ['stop', 'off', 'reset', 'none', 'cancel']) {
      const local = new GoalRunner({ store: new GoalStore({ baseDir: base, autoStage: false }), emitEvents: false });
      local.start(contract());
      expect(local.clear(alias).state).toBe('cleared');
    }
  });
});

// ── Two-tier memory: durable → working rehydration ───────────────────

describe('two-tier memory', () => {
  test('loadActive rehydrates working state from durable storage', async () => {
    const rec = runner.start(contract());
    const worker = scriptedWorker('worker', [{ summary: 's', command: 'bun test', result: 'coverage 61% pass', exitCode: 0 }]);
    await runner.runTurn(worker, new DefaultEvaluator());

    // A fresh runner (new session) recovers the goal from disk.
    const revived = new GoalRunner({ store: new GoalStore({ baseDir: base, autoStage: false }), emitEvents: false });
    const loaded = revived.loadActive();
    expect(loaded?.id).toBe(rec.id);
    expect(revived.status().state).toBe('active');
    expect(revived.status().checkpoints).toBe(1);
  });
});

// ── Ported replay semantics (mirrors validate_goal_e2e.py) ───────────

describe('lifecycle replay: set → fail → fail → pause → resume → pass → met', () => {
  test('drives the full state machine to completion', async () => {
    runner.start(contract());
    const failing = scriptedWorker('worker', [{ summary: 'red', command: 'bun test', result: 'failing', exitCode: 1, sameSlice: true }]);
    const evaluator = new DefaultEvaluator();

    await runner.runTurn(failing, evaluator); // fail 1
    expect(runner.status().state).toBe('active');
    await runner.runTurn(failing, evaluator); // fail 2 → auto-pause
    expect(runner.status().state).toBe('paused');

    runner.resume();
    expect(runner.status().state).toBe('active');

    const passing = scriptedWorker('worker', [{ summary: 'green', command: 'bun test', result: 'all tests pass, coverage 88%', exitCode: 0 }]);
    const final = await runner.runTurn(passing, evaluator);
    expect(final.evaluation.conditionMet).toBe(true);
    expect(runner.status().state).toBe('completed');
    expect(runner.status().achievedCondition).toBeTruthy();
  });
});
