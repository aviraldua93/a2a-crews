import { describe, test, expect } from 'bun:test';
import { createCheckpoint, checkpointToString, type Checkpoint } from '../src/crew/checkpoint';

// ── 1. Checkpoint creation with defaults ────────────────────────────

describe('createCheckpoint', () => {
  test('creates checkpoint with required fields and defaults', () => {
    const cp = createCheckpoint({ role: 'architect', currentTask: 'design-api' });

    expect(cp.role).toBe('architect');
    expect(cp.currentTask).toBe('design-api');
    expect(cp.checkpointNumber).toBe(1);
    expect(cp.taskStatus).toBe('partial');
    expect(cp.completedWork).toEqual([]);
    expect(cp.remainingWork).toEqual([]);
    expect(cp.keyDecisions).toEqual([]);
    expect(cp.filesModified).toEqual([]);
    expect(cp.notes).toBe('');
    expect(cp.timestamp).toBeTruthy();
  });

  test('respects explicit overrides', () => {
    const cp = createCheckpoint({
      role: 'coder',
      currentTask: 'implement-auth',
      checkpointNumber: 3,
      taskStatus: 'complete',
      completedWork: ['wrote login endpoint'],
      remainingWork: ['add tests'],
      keyDecisions: ['chose JWT over sessions'],
      filesModified: ['src/auth.ts'],
      notes: 'blocked on DB migration',
    });

    expect(cp.checkpointNumber).toBe(3);
    expect(cp.taskStatus).toBe('complete');
    expect(cp.completedWork).toEqual(['wrote login endpoint']);
    expect(cp.remainingWork).toEqual(['add tests']);
    expect(cp.keyDecisions).toEqual(['chose JWT over sessions']);
    expect(cp.filesModified).toEqual(['src/auth.ts']);
    expect(cp.notes).toBe('blocked on DB migration');
  });
});

// ── 2. Checkpoint serialization ─────────────────────────────────────

describe('checkpointToString', () => {
  test('serializes checkpoint to pretty JSON', () => {
    const cp = createCheckpoint({ role: 'reviewer', currentTask: 'review-pr' });
    const str = checkpointToString(cp);
    const parsed = JSON.parse(str) as Checkpoint;

    expect(parsed.role).toBe('reviewer');
    expect(parsed.currentTask).toBe('review-pr');
    // Pretty-printed: should contain newlines
    expect(str).toContain('\n');
  });
});

// ── 3. Event log entry formatting ───────────────────────────────────

describe('Event log entries', () => {
  test('entries follow pipe-delimited WAL format', async () => {
    const { A2ABridge } = await import('../src/a2a/bridge');
    const bridge = new A2ABridge(0);
    bridge.start();
    const baseUrl = `http://localhost:${bridge.actualPort}`;

    try {
      // Register agent to produce an event
      await fetch(`${baseUrl}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-agent',
          description: 'Test',
          skills: ['skill-a', 'skill-b'],
        }),
      });

      // Create a task
      await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedTo: 'test-agent', message: 'do something' }),
      });

      const res = await fetch(`${baseUrl}/events/log`);
      expect(res.status).toBe(200);
      const entries = await res.json() as string[];

      expect(entries.length).toBeGreaterThanOrEqual(2);

      // Validate format: ISO|type|taskId|agentName|detail
      for (const entry of entries) {
        const parts = entry.split('|');
        expect(parts.length).toBe(5);
        // First part should be a valid ISO timestamp
        expect(new Date(parts[0]).toISOString()).toBe(parts[0]);
      }

      // Check specific entries
      const regEntry = entries.find(e => e.includes('agent_registered'));
      expect(regEntry).toBeDefined();
      expect(regEntry).toContain('test-agent');
      expect(regEntry).toContain('skill-a,skill-b');

      const taskEntry = entries.find(e => e.includes('task_created'));
      expect(taskEntry).toBeDefined();
      expect(taskEntry).toContain('do something');
    } finally {
      bridge.stop();
    }
  });

  test('heartbeat events are logged', async () => {
    const { A2ABridge } = await import('../src/a2a/bridge');
    const bridge = new A2ABridge(0);
    bridge.start();
    const baseUrl = `http://localhost:${bridge.actualPort}`;

    try {
      await fetch(`${baseUrl}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hb-agent', description: 'HB', skills: ['x'] }),
      });

      await fetch(`${baseUrl}/agents/hb-agent/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'busy' }),
      });

      const res = await fetch(`${baseUrl}/events/log`);
      const entries = await res.json() as string[];

      const hbEntry = entries.find(e => e.includes('heartbeat'));
      expect(hbEntry).toBeDefined();
      expect(hbEntry).toContain('hb-agent');
      expect(hbEntry).toContain('busy');
    } finally {
      bridge.stop();
    }
  });

  test('task update events are logged', async () => {
    const { A2ABridge } = await import('../src/a2a/bridge');
    const bridge = new A2ABridge(0);
    bridge.start();
    const baseUrl = `http://localhost:${bridge.actualPort}`;

    try {
      await fetch(`${baseUrl}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'upd-agent', description: 'U', skills: ['y'] }),
      });

      const createRes = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedTo: 'upd-agent', message: 'update test' }),
      });
      const { task } = await createRes.json() as { task: { id: string } };

      await fetch(`${baseUrl}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', result: 'done' }),
      });

      const res = await fetch(`${baseUrl}/events/log`);
      const entries = await res.json() as string[];

      const updEntry = entries.find(e => e.includes('task_updated'));
      expect(updEntry).toBeDefined();
      expect(updEntry).toContain('completed');
    } finally {
      bridge.stop();
    }
  });
});
