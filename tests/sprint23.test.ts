/**
 * Sprint 2-3 Tests — Issues #15 + #16
 *
 * #15: Agent-to-agent messaging via bridge relay
 * #16: Cost and token usage tracking per agent and task
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

  for (const agent of [
    { name: 'architect', description: 'System architect', skills: ['design'] },
    { name: 'coder', description: 'Developer', skills: ['code'] },
    { name: 'reviewer', description: 'Code reviewer', skills: ['review'] },
  ]) {
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agent),
    });
  }
});

afterAll(() => bridge.stop());

// ── #15: Agent-to-agent messaging ─────────────────────────────────

describe('#15: message/relay', () => {
  test('coder can send message to architect', async () => {
    const result = await client.relay('coder', 'architect', 'Should UserService extend BaseService?');
    expect((result as any).ok).toBe(true);
    expect((result as any).message.from).toBe('coder');
    expect((result as any).message.to).toBe('architect');
    expect((result as any).message.text).toContain('UserService');
  });

  test('relayed message appears in architect inbox', async () => {
    const result = await client.poll('architect');
    expect((result as any).count).toBeGreaterThan(0);
    const messages = (result as any).messages;
    const found = messages.find((m: any) => m.from === 'coder');
    expect(found).toBeDefined();
    expect(found.text).toContain('UserService');
  });

  test('messages/poll with since filter', async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const future = new Date(Date.now() + 60000).toISOString();

    const pastResult = await client.poll('architect', past);
    expect((pastResult as any).count).toBeGreaterThan(0);

    const futureResult = await client.poll('architect', future);
    expect((futureResult as any).count).toBe(0);
  });

  test('relay to unknown agent returns error', async () => {
    try {
      await client.relay('coder', 'ghost', 'Hello?');
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('AgentNotFoundError');
    }
  });

  test('multiple messages build conversation', async () => {
    await client.relay('architect', 'coder', 'Use standalone class with dependency injection');
    await client.relay('coder', 'architect', 'Got it, implementing now');
    await client.relay('reviewer', 'coder', 'Remember to add unit tests');

    const coderInbox = await client.poll('coder');
    expect((coderInbox as any).count).toBeGreaterThanOrEqual(2);

    const architectInbox = await client.poll('architect');
    expect((architectInbox as any).count).toBeGreaterThanOrEqual(2);
  });

  test('relay with contextId links to task', async () => {
    const task = await client.sendMessage('Build auth', { assignedTo: 'coder' });
    const result = await client.relay('coder', 'architect', 'Need auth strategy advice', task.id as string);
    expect((result as any).message.contextId).toBe(task.id);
  });

  test('relay event appears in event log', async () => {
    const logRes = await fetch(`${baseUrl}/events/log`);
    const log = await logRes.json();
    const relayEntries = log.filter((e: string) => e.includes('message_relayed'));
    expect(relayEntries.length).toBeGreaterThan(0);
  });

  test('empty inbox returns zero messages', async () => {
    // Register a fresh agent with no messages
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'lonely', description: 'No friends', skills: ['solo'] }),
    });
    const result = await client.poll('lonely');
    expect((result as any).count).toBe(0);
    expect((result as any).messages).toEqual([]);
  });
});

// ── #16: Cost and token tracking ──────────────────────────────────

describe('#16: Token usage tracking', () => {
  test('PATCH /tasks/:id accepts usage data', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'coder', message: 'Build endpoint' }),
    });
    const { task } = await createRes.json();

    const updateRes = await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        result: 'Endpoint built',
        usage: {
          promptTokens: 15000,
          completionTokens: 3200,
          totalTokens: 18200,
          estimatedCostUsd: 0.09,
          model: 'claude-sonnet-4-20250514',
        },
      }),
    });
    expect(updateRes.status).toBe(200);

    // Verify usage stored on task
    const getRes = await fetch(`${baseUrl}/tasks/${task.id}`);
    const updated = await getRes.json();
    expect(updated.usage).toBeDefined();
    expect(updated.usage.totalTokens).toBe(18200);
    expect(updated.usage.model).toBe('claude-sonnet-4-20250514');
  });

  test('usage appears in toA2ATask metadata', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'reviewer', message: 'Review code' }),
    });
    const { task } = await createRes.json();

    await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        result: 'LGTM',
        usage: { promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
      }),
    });

    // Get via JSON-RPC to see A2A format
    const rpcResult = await client.getTask(task.id);
    expect((rpcResult as any).metadata?.usage).toBeDefined();
    expect((rpcResult as any).metadata.usage.totalTokens).toBe(6000);
  });

  test('/status shows aggregate usage', async () => {
    const statusRes = await fetch(`${baseUrl}/status`);
    const status = await statusRes.json();

    expect(status.usage).toBeDefined();
    expect(status.usage.totalTokens).toBeGreaterThan(0);
    expect(status.usage.promptTokens).toBeGreaterThan(0);
    expect(status.usage.completionTokens).toBeGreaterThan(0);
    expect(typeof status.usage.budgetLimit).toBe('number');
  });

  test('/status shows per-agent usage breakdown', async () => {
    const statusRes = await fetch(`${baseUrl}/status`);
    const status = await statusRes.json();

    expect(status.usage.byAgent).toBeDefined();
    expect(status.usage.byAgent.coder).toBeDefined();
    expect(status.usage.byAgent.coder.totalTokens).toBeGreaterThan(0);
  });

  test('usage logged in event log', async () => {
    const logRes = await fetch(`${baseUrl}/events/log`);
    const log = await logRes.json();
    const usageEntries = log.filter((e: string) => e.includes('usage_reported'));
    expect(usageEntries.length).toBeGreaterThan(0);
  });

  test('/status includes messaging stats', async () => {
    const statusRes = await fetch(`${baseUrl}/status`);
    const status = await statusRes.json();
    expect(status.messaging).toBeDefined();
    expect(status.messaging.totalMessages).toBeGreaterThan(0);
  });
});
