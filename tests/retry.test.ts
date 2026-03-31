import { describe, expect, it } from 'bun:test';

/**
 * Unit tests for auto-retry and dead agent detection logic.
 * These test the retry tracking data structures and poison pill logic
 * that the orchestrator uses in handleLaunch.
 */

describe('spawnAttempts tracking', () => {
  it('initializes at 0 for unknown tasks', () => {
    const spawnAttempts = new Map<string, number>();
    expect(spawnAttempts.get('task-1') ?? 0).toBe(0);
  });

  it('increments attempts on each spawn', () => {
    const spawnAttempts = new Map<string, number>();
    const taskId = 'design-spec';

    // First spawn
    spawnAttempts.set(taskId, (spawnAttempts.get(taskId) ?? 0) + 1);
    expect(spawnAttempts.get(taskId)).toBe(1);

    // Second spawn (retry)
    spawnAttempts.set(taskId, (spawnAttempts.get(taskId) ?? 0) + 1);
    expect(spawnAttempts.get(taskId)).toBe(2);

    // Third spawn (retry)
    spawnAttempts.set(taskId, (spawnAttempts.get(taskId) ?? 0) + 1);
    expect(spawnAttempts.get(taskId)).toBe(3);
  });

  it('tracks multiple tasks independently', () => {
    const spawnAttempts = new Map<string, number>();

    spawnAttempts.set('task-a', 1);
    spawnAttempts.set('task-b', 3);
    spawnAttempts.set('task-c', 0);

    expect(spawnAttempts.get('task-a')).toBe(1);
    expect(spawnAttempts.get('task-b')).toBe(3);
    expect(spawnAttempts.get('task-c')).toBe(0);
  });
});

describe('max retries (poison pill)', () => {
  const MAX_RETRIES = 3;

  it('allows spawn when under max retries', () => {
    const spawnAttempts = new Map<string, number>();
    spawnAttempts.set('task-1', 0);
    spawnAttempts.set('task-2', 1);
    spawnAttempts.set('task-3', 2);

    for (const [taskId] of spawnAttempts) {
      const attempts = spawnAttempts.get(taskId) ?? 0;
      expect(attempts < MAX_RETRIES).toBe(true);
    }
  });

  it('blocks spawn when at max retries', () => {
    const spawnAttempts = new Map<string, number>();
    spawnAttempts.set('task-1', 3);

    const attempts = spawnAttempts.get('task-1') ?? 0;
    expect(attempts >= MAX_RETRIES).toBe(true);
  });

  it('blocks spawn when over max retries', () => {
    const spawnAttempts = new Map<string, number>();
    spawnAttempts.set('task-1', 5);

    const attempts = spawnAttempts.get('task-1') ?? 0;
    expect(attempts >= MAX_RETRIES).toBe(true);
  });
});

describe('dead agent detection', () => {
  const DEAD_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

  it('does not flag tasks under timeout threshold', () => {
    const submittedAt = Date.now() - (4 * 60 * 1000); // 4 minutes ago
    const stuckDuration = Date.now() - submittedAt;
    expect(stuckDuration > DEAD_AGENT_TIMEOUT_MS).toBe(false);
  });

  it('flags tasks over timeout threshold', () => {
    const submittedAt = Date.now() - (6 * 60 * 1000); // 6 minutes ago
    const stuckDuration = Date.now() - submittedAt;
    expect(stuckDuration > DEAD_AGENT_TIMEOUT_MS).toBe(true);
  });

  it('flags tasks exactly at boundary', () => {
    const submittedAt = Date.now() - DEAD_AGENT_TIMEOUT_MS - 1; // just over
    const stuckDuration = Date.now() - submittedAt;
    expect(stuckDuration > DEAD_AGENT_TIMEOUT_MS).toBe(true);
  });

  it('combines timeout + retry check correctly', () => {
    const MAX_RETRIES = 3;
    const spawnAttempts = new Map<string, number>();
    const taskSubmittedAt = new Map<string, number>();

    // Task stuck for 6min with 1 attempt — should retry
    spawnAttempts.set('task-a', 1);
    taskSubmittedAt.set('task-a', Date.now() - (6 * 60 * 1000));

    const attemptsA = spawnAttempts.get('task-a') ?? 0;
    const stuckA = Date.now() - (taskSubmittedAt.get('task-a') ?? 0);
    expect(stuckA > DEAD_AGENT_TIMEOUT_MS && attemptsA < MAX_RETRIES).toBe(true);

    // Task stuck for 6min with 3 attempts — should NOT retry (poison pill)
    spawnAttempts.set('task-b', 3);
    taskSubmittedAt.set('task-b', Date.now() - (6 * 60 * 1000));

    const attemptsB = spawnAttempts.get('task-b') ?? 0;
    const stuckB = Date.now() - (taskSubmittedAt.get('task-b') ?? 0);
    expect(stuckB > DEAD_AGENT_TIMEOUT_MS && attemptsB < MAX_RETRIES).toBe(false);

    // Task NOT stuck (2min) with 1 attempt — should NOT retry yet
    spawnAttempts.set('task-c', 1);
    taskSubmittedAt.set('task-c', Date.now() - (2 * 60 * 1000));

    const attemptsC = spawnAttempts.get('task-c') ?? 0;
    const stuckC = Date.now() - (taskSubmittedAt.get('task-c') ?? 0);
    expect(stuckC > DEAD_AGENT_TIMEOUT_MS && attemptsC < MAX_RETRIES).toBe(false);
  });
});
