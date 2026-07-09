import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  checkpointKey,
  GoalStore,
  normalizeContract,
  type GoalCheckpointDraft,
  type GoalContract,
  type GoalRecord,
} from '../src/goal';

function contract(): GoalContract {
  return normalizeContract({
    objective: 'Raise coverage',
    stoppingCondition: '`bun test` exits 0 and coverage >= 80%',
    validationLoop: 'bun test',
    inputsToReadFirst: ['tests/'],
    constraints: ['Tests stay green'],
    forbiddenMoves: ['No no-op tests'],
    checkpointCadence: 'every test file + suite green',
  });
}

function record(id: string, state: GoalRecord['state'] = 'active'): GoalRecord {
  const ts = '2026-01-01T00:00:00.000Z';
  return { id, contract: contract(), state, autopilot: true, createdAt: ts, updatedAt: ts, achievedCondition: null };
}

function draft(goalId: string, overrides: Partial<GoalCheckpointDraft> = {}): GoalCheckpointDraft {
  const base: GoalCheckpointDraft = {
    goalId,
    turn: 1,
    timestamp: '2026-01-01T00:01:00.000Z',
    title: 'turn 1: baseline',
    verified: 'baseline measured',
    remains: 'stopping condition not yet met',
    blocked: null,
    validation: { command: 'bun test', result: 'coverage 60%', passed: true, attempt: 1 },
    evidence: { reason: 'progress 1/3' },
    evaluatorId: 'default-evaluator',
    progress: 0.33,
    key: 'k-baseline',
  };
  return { ...base, ...overrides };
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'a2a-goal-store-'));
});
afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── Durability ───────────────────────────────────────────────────────

describe('GoalStore durability', () => {
  test('writeRecord persists contract.json + goal.md and round-trips', () => {
    const store = new GoalStore({ baseDir: base, autoStage: false });
    const rec = record('coverage-1');
    store.writeRecord(rec);

    expect(existsSync(store.contractJsonPath('coverage-1'))).toBe(true);
    expect(existsSync(store.goalMdPath('coverage-1'))).toBe(true);

    const loaded = store.readRecord('coverage-1');
    expect(loaded?.contract.objective).toBe('Raise coverage');
    expect(readFileSync(store.goalMdPath('coverage-1'), 'utf-8')).toContain('# Goal: Raise coverage');
  });

  test('appendCheckpoint writes an append-only log', () => {
    const store = new GoalStore({ baseDir: base, autoStage: false });
    store.writeRecord(record('cov'));

    const first = store.appendCheckpoint(draft('cov', { key: 'k1', title: 't1' }));
    const second = store.appendCheckpoint(draft('cov', { key: 'k2', title: 't2', turn: 2 }));

    expect(first.appended).toBe(true);
    expect(first.checkpoint.checkpointNumber).toBe(1);
    expect(second.checkpoint.checkpointNumber).toBe(2);

    const all = store.readCheckpoints('cov');
    expect(all.map(c => c.title)).toEqual(['t1', 't2']);
    // durable file has exactly two JSONL lines
    const lines = readFileSync(store.checkpointsPath('cov'), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────

describe('GoalStore idempotency', () => {
  test('re-appending the same key is a no-op', () => {
    const store = new GoalStore({ baseDir: base, autoStage: false });
    store.writeRecord(record('cov'));

    const a = store.appendCheckpoint(draft('cov', { key: 'same' }));
    const b = store.appendCheckpoint(draft('cov', { key: 'same' }));

    expect(a.appended).toBe(true);
    expect(b.appended).toBe(false);
    expect(store.readCheckpoints('cov').length).toBe(1);
  });

  test('checkpointKey is deterministic for identical content', () => {
    const parts = { goalId: 'g', turn: 3, title: 't', verified: 'v', validationResult: 'r', reason: 'why' };
    expect(checkpointKey(parts)).toBe(checkpointKey({ ...parts }));
    expect(checkpointKey(parts)).not.toBe(checkpointKey({ ...parts, turn: 4 }));
  });

  test('writeRecord overwrites rather than duplicating', () => {
    const store = new GoalStore({ baseDir: base, autoStage: false });
    store.writeRecord(record('cov'));
    store.writeRecord(record('cov', 'paused'));
    expect(store.readRecord('cov')?.state).toBe('paused');
    expect(store.listRecords().length).toBe(1);
  });
});

// ── Staging (durability fix) ─────────────────────────────────────────

describe('GoalStore staging', () => {
  test('invokes the stage hook with durable paths on every write', () => {
    const staged: string[] = [];
    const store = new GoalStore({ baseDir: base, stage: paths => staged.push(...paths) });
    store.writeRecord(record('cov'));
    store.appendCheckpoint(draft('cov'));

    expect(staged.some(p => p.endsWith('contract.json'))).toBe(true);
    expect(staged.some(p => p.endsWith('goal.md'))).toBe(true);
    expect(staged.some(p => p.endsWith('checkpoints.jsonl'))).toBe(true);
  });

  test('durable files are git-staged in a real repo (source forgot to stage)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'a2a-goal-git-'));
    try {
      execSync('git init', { cwd: repo, stdio: 'pipe' });
      execSync('git config user.email "t@t.com"', { cwd: repo, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });

      const store = new GoalStore({ baseDir: repo });
      store.writeRecord(record('cov'));
      store.appendCheckpoint(draft('cov'));

      const stagedOutput = execSync('git diff --cached --name-only', { cwd: repo, encoding: 'utf-8' });
      expect(stagedOutput).toContain('audits/goals/cov/contract.json');
      expect(stagedOutput).toContain('audits/goals/cov/checkpoints.jsonl');
      expect(stagedOutput).toContain('audits/goals/cov/goal.md');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('timestamps come from the runtime clock, never a shell', () => {
    const fixed = '2027-07-07T07:07:07.000Z';
    const store = new GoalStore({ baseDir: base, autoStage: false, now: () => fixed });
    expect(store.now()).toBe(fixed);
    expect(new Date(store.now()).toISOString()).toBe(fixed);
  });
});
