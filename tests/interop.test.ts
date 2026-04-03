/**
 * A2A Interop Tests — proves external agents can connect to the bridge
 * using only the A2AClient (no internal bridge APIs).
 *
 * This validates the core A2A interop story: an external A2A client
 * can discover the bridge, send messages, track tasks, and receive results.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { A2ABridge } from '../src/a2a/bridge';
import { A2AClient } from '../src/a2a/client';

let bridge: A2ABridge;
let client: A2AClient;

beforeAll(() => {
  bridge = new A2ABridge(0);
  bridge.start();
  const baseUrl = `http://localhost:${bridge.actualPort}`;
  client = new A2AClient(baseUrl);

  // Register an agent via REST (simulating an agent self-registering)
  return fetch(`${baseUrl}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'external-worker', description: 'External A2A agent', skills: ['code', 'review'] }),
  });
});

afterAll(() => {
  bridge.stop();
});

// ── Discovery ───────────────────────────────────────────────────────

describe('A2A client discovery', () => {
  test('fetches agent card from /.well-known/agent-card.json', async () => {
    const card = await client.getAgentCard();
    expect(card.name).toBe('a2a-bridge');
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.defaultInputModes).toContain('text');
    expect(card.skills.length).toBeGreaterThan(0);
    expect(card.additionalInterfaces?.length).toBeGreaterThan(0);
  });
});

// ── Task lifecycle via JSON-RPC ─────────────────────────────────────

describe('A2A client task lifecycle', () => {
  let taskId: string;

  test('sends a message and receives a task', async () => {
    const result = await client.sendMessage('Build authentication module', { assignedTo: 'external-worker' });
    expect(result.kind).toBe('task');
    expect(result.id).toBeDefined();
    expect((result.status as any).state).toBe('submitted');
    taskId = result.id as string;
  });

  test('retrieves task state', async () => {
    const result = await client.getTask(taskId);
    expect(result.kind).toBe('task');
    expect(result.id).toBe(taskId);
    expect((result.status as any).state).toBe('submitted');
  });

  test('lists tasks and finds our task', async () => {
    const result = await client.listTasks({ status: 'submitted' });
    const tasks = (result as any).tasks as any[];
    expect(tasks.length).toBeGreaterThan(0);
    const found = tasks.find((t: any) => t.id === taskId);
    expect(found).toBeDefined();
    expect(found.kind).toBe('task');
  });

  test('completes task via REST PATCH (simulating agent work)', async () => {
    const baseUrl = `http://localhost:${bridge.actualPort}`;
    await fetch(`${baseUrl}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: 'JWT auth implemented with refresh tokens' }),
    });

    const result = await client.getTask(taskId);
    expect((result.status as any).state).toBe('completed');
    expect((result as any).artifacts?.length).toBe(1);
    expect((result as any).artifacts[0].parts[0].text).toContain('JWT');
  });
});

// ── Error handling via client ───────────────────────────────────────

describe('A2A client error handling', () => {
  test('getTask throws on nonexistent task', async () => {
    try {
      await client.getTask('nonexistent-task-id');
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.message).toContain('JSON-RPC error');
      expect(e.message).toContain('TaskNotFoundError');
    }
  });

  test('cancelTask throws on completed task', async () => {
    // Create and complete a task first
    const result = await client.sendMessage('Cancel test', { assignedTo: 'external-worker' });
    const id = result.id as string;
    const baseUrl = `http://localhost:${bridge.actualPort}`;
    await fetch(`${baseUrl}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: 'done' }),
    });

    try {
      await client.cancelTask(id);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('TaskNotCancelableError');
    }
  });
});

// ── Streaming via client ────────────────────────────────────────────

describe('A2A client streaming', () => {
  test('subscribes to task updates via SSE', async () => {
    const result = await client.sendMessage('Stream test', { assignedTo: 'external-worker' });
    const taskId = result.id as string;

    const controller = new AbortController();
    const stream = await client.subscribe(taskId, controller.signal);

    const reader = stream.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    expect(text).toContain(taskId);
    expect(text).toContain('"kind":"task"');

    controller.abort();
    reader.cancel().catch(() => {});
  });
});

// ── Agent card from crew/agent.ts ───────────────────────────────────

describe('Agent.toAgentCard() SDK compliance', () => {
  test('produces a spec-compliant AgentCard', async () => {
    const { Agent } = await import('../src/crew/agent');
    const agent = new Agent({
      key: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      skills: ['coding', 'testing'],
    });

    const card = agent.toAgentCard('http://localhost:9999');
    expect(card.name).toBe('Test Agent');
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.url).toBe('http://localhost:9999');
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.additionalInterfaces?.length).toBe(1);
    expect(card.additionalInterfaces![0].transport).toBe('JSONRPC');
    expect(card.skills.length).toBe(2);
    expect(card.skills[0].tags).toEqual(['coding']);
    expect(card.skills[1].tags).toEqual(['testing']);
  });
});
