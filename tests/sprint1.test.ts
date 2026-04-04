/**
 * Sprint 1 Tests — Issues #17, #14, #18, #13
 *
 * #17: toA2ATask() returns complete Task objects (contextId, history, metadata)
 * #14: Task message history tracking
 * #18: Agent runtime error reporting via POST /agents/:name/events
 * #13: input-required TaskState for human-in-the-loop
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { A2ABridge } from '../src/a2a/bridge';
import { A2AClient } from '../src/a2a/client';

let bridge: A2ABridge;
let baseUrl: string;
let client: A2AClient;

beforeAll(async () => {
  bridge = new A2ABridge(0);
  bridge.start();
  baseUrl = `http://localhost:${bridge.actualPort}`;
  client = new A2AClient(baseUrl);

  // Register test agents
  for (const agent of [
    { name: 'worker', description: 'Worker agent', skills: ['code'] },
    { name: 'reviewer', description: 'Review agent', skills: ['review'] },
  ]) {
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agent),
    });
  }
});

afterAll(() => bridge.stop());

// ── #17: Complete Task objects ─────────────────────────────────────

describe('#17: toA2ATask produces complete Task objects', () => {
  test('JSON-RPC task has contextId field', async () => {
    const result = await client.sendMessage('Test contextId', { assignedTo: 'worker' });
    expect(result.contextId).toBeDefined();
    expect(typeof result.contextId).toBe('string');
    expect((result.contextId as string).length).toBeGreaterThan(0);
  });

  test('JSON-RPC task has history array with initial message', async () => {
    const result = await client.sendMessage('Test history', { assignedTo: 'worker' });
    const task = await client.getTask(result.id as string);
    expect((task as any).history).toBeInstanceOf(Array);
    expect((task as any).history.length).toBeGreaterThanOrEqual(1);
    expect((task as any).history[0].role).toBe('user');
    expect((task as any).history[0].parts[0].text).toContain('Test history');
  });

  test('REST task has contextId and history', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'worker', message: 'REST history test' }),
    });
    const { task } = await createRes.json();
    expect(task.contextId).toBeDefined();
    expect(task.history).toBeInstanceOf(Array);
    expect(task.history.length).toBe(1);
    expect(task.history[0].role).toBe('user');
    expect(task.history[0].text).toBe('REST history test');
  });

  test('task metadata is preserved', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'message/send',
        params: {
          message: { kind: 'message', messageId: 'meta-test', role: 'user', parts: [{ kind: 'text', text: 'metadata test' }] },
          metadata: { assignedTo: 'worker', priority: 'high', customField: 42 },
        },
      }),
    });
    const body = await res.json();
    const task = await client.getTask(body.result.id);
    expect((task as any).metadata).toBeDefined();
    expect((task as any).metadata.priority).toBe('high');
    expect((task as any).metadata.customField).toBe(42);
  });
});

// ── #14: Task message history tracking ────────────────────────────

describe('#14: Task message history tracking', () => {
  test('completing a task adds agent message to history', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'worker', message: 'Build auth module' }),
    });
    const { task } = await createRes.json();

    // Complete with result
    await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: 'JWT auth implemented' }),
    });

    // Check history has both messages
    const result = await client.getTask(task.id);
    const history = (result as any).history;
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('agent');
    expect(history[1].parts[0].text).toBe('JWT auth implemented');
  });

  test('history preserves chronological order', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'worker', message: 'Start task' }),
    });
    const { task } = await createRes.json();

    // Working update
    await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'working' }),
    });

    // Complete
    await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: 'Done!' }),
    });

    const result = await client.getTask(task.id);
    const history = (result as any).history;
    expect(history.length).toBe(2); // user + completion (working doesn't add to history)
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('agent');
  });
});

// ── #18: Agent runtime error reporting ────────────────────────────

describe('#18: Agent runtime error reporting', () => {
  test('POST /agents/:name/events accepts error report', async () => {
    const res = await fetch(`${baseUrl}/agents/worker/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'port_conflict',
        message: 'Port 3000 already in use',
        severity: 'warning',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.event.type).toBe('port_conflict');
    expect(body.event.agentName).toBe('worker');
    expect(body.event.severity).toBe('warning');
  });

  test('error event appears in event log', async () => {
    await fetch(`${baseUrl}/agents/worker/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tool_failure', message: 'npm install failed', severity: 'error' }),
    });

    const logRes = await fetch(`${baseUrl}/events/log`);
    const log = await logRes.json();
    const errorEntries = log.filter((e: string) => e.includes('agent_event:tool_failure'));
    expect(errorEntries.length).toBeGreaterThan(0);
    expect(errorEntries[errorEntries.length - 1]).toContain('npm install failed');
  });

  test('fatal error auto-fails linked task', async () => {
    // Create a task
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'worker', message: 'Will crash' }),
    });
    const { task } = await createRes.json();

    // Report fatal error linked to that task
    await fetch(`${baseUrl}/agents/worker/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'error',
        message: 'Out of memory',
        taskId: task.id,
        severity: 'fatal',
      }),
    });

    // Task should now be failed
    const getRes = await fetch(`${baseUrl}/tasks/${task.id}`);
    const updated = await getRes.json();
    expect(updated.status).toBe('failed');
    expect(updated.result).toContain('Out of memory');
  });

  test('rejects unknown agent', async () => {
    const res = await fetch(`${baseUrl}/agents/ghost/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'error', message: 'test' }),
    });
    expect(res.status).toBe(404);
  });

  test('rejects invalid event type', async () => {
    const res = await fetch(`${baseUrl}/agents/worker/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'invalid_type', message: 'test' }),
    });
    expect(res.status).toBe(400);
  });

  test('A2AClient.reportEvent() works', async () => {
    const result = await client.reportEvent('worker', 'warning', 'Disk space low', {
      severity: 'warning',
      details: { freeSpace: '100MB' },
    });
    expect((result as any).ok).toBe(true);
    expect((result as any).event.type).toBe('warning');
    expect((result as any).event.details.freeSpace).toBe('100MB');
  });
});

// ── #13: input-required TaskState ─────────────────────────────────

describe('#13: input-required TaskState', () => {
  test('task can be set to input-required', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'worker', message: 'Need user input' }),
    });
    const { task } = await createRes.json();

    const updateRes = await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'input-required', result: 'Which database? PostgreSQL or MySQL?' }),
    });
    expect(updateRes.status).toBe(200);
    const body = await updateRes.json();
    expect(body.task.status).toBe('input-required');
  });

  test('input-required task shows in JSON-RPC tasks/get', async () => {
    const result = await client.sendMessage('Interactive task', { assignedTo: 'worker' });
    const taskId = result.id as string;

    await fetch(`${baseUrl}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'input-required', result: 'Pick a framework' }),
    });

    const task = await client.getTask(taskId);
    expect((task as any).status.state).toBe('input-required');
  });

  test('input-required task can be resumed to working', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'worker', message: 'Resume test' }),
    });
    const { task } = await createRes.json();

    // Set to input-required
    await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'input-required', result: 'Which approach?' }),
    });

    // Resume to working
    await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'working', result: 'User chose approach A' }),
    });

    const getRes = await fetch(`${baseUrl}/tasks/${task.id}`);
    const updated = await getRes.json();
    expect(updated.status).toBe('working');
    expect(updated.history.length).toBeGreaterThanOrEqual(3); // user + input-required + resume
  });

  test('input-required tasks filterable via tasks/list', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tasks/list',
        params: { status: 'input-required' },
      }),
    });
    const body = await res.json();
    for (const task of body.result.tasks) {
      expect(task.status.state).toBe('input-required');
    }
  });
});
