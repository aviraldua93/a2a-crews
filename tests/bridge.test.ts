import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { A2ABridge } from '../src/a2a/bridge';

let bridge: A2ABridge;
let baseUrl: string;

beforeAll(() => {
  // Port 0 → Bun picks a random available port
  bridge = new A2ABridge(0);
  bridge.start();
  baseUrl = `http://localhost:${bridge.actualPort}`;
});

afterAll(() => {
  bridge.stop();
});

// ── 1. Status endpoint ──────────────────────────────────────────────

describe('GET /status', () => {
  test('responds with bridge health', async () => {
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bridge).toBe('running');
    expect(body.agents.total).toBe(0);
    expect(body.tasks.total).toBe(0);
  });
});

// ── 2. Agent registration ───────────────────────────────────────────

describe('POST /agents', () => {
  test('registers an agent', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'architect',
        description: 'System architect agent',
        skills: ['design', 'review'],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agent.name).toBe('architect');
    expect(body.agent.status).toBe('online');
  });

  test('rejects missing name', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'no name', skills: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('name');
  });

  test('rejects invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid JSON');
  });
});

// ── 3. Agent heartbeat ──────────────────────────────────────────────

describe('POST /agents/:name/heartbeat', () => {
  test('updates heartbeat and status', async () => {
    const res = await fetch(`${baseUrl}/agents/architect/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'busy' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.status).toBe('busy');
  });

  test('returns 404 for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/agents/ghost/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

// ── 4. Task creation ────────────────────────────────────────────────

describe('POST /tasks', () => {
  test('creates a task for a registered agent', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'architect',
        message: 'Design the auth module',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.task.status).toBe('submitted');
    expect(body.task.assignedTo).toBe('architect');
    expect(body.task.id).toBeDefined();
  });

  test('rejects task for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'nonexistent',
        message: 'Do something',
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('nonexistent');
  });
});

// ── 5. Task retrieval ───────────────────────────────────────────────

describe('GET /tasks/:id', () => {
  test('retrieves a created task', async () => {
    // Create a task first
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'architect',
        message: 'Review codebase',
      }),
    });
    const { task } = await createRes.json();

    const res = await fetch(`${baseUrl}/tasks/${task.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(task.id);
    expect(body.message).toBe('Review codebase');
  });

  test('returns 404 for unknown task', async () => {
    const res = await fetch(`${baseUrl}/tasks/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

// ── 6. Task update ──────────────────────────────────────────────────

describe('PATCH /tasks/:id', () => {
  test('updates task status and result', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'architect',
        message: 'Build feature X',
      }),
    });
    const { task } = await createRes.json();

    // Move to working
    let res = await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'working' }),
    });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.task.status).toBe('working');

    // Complete with result
    res = await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: 'Feature X done' }),
    });
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.task.status).toBe('completed');
    expect(body.task.result).toBe('Feature X done');
  });

  test('rejects invalid status', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'architect',
        message: 'Test invalid',
      }),
    });
    const { task } = await createRes.json();

    const res = await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});

// ── 7. Task list with filters ───────────────────────────────────────

describe('GET /tasks', () => {
  test('lists all tasks', async () => {
    const res = await fetch(`${baseUrl}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test('filters by status', async () => {
    const res = await fetch(`${baseUrl}/tasks?status=submitted`);
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const task of body) {
      expect(task.status).toBe('submitted');
    }
  });

  test('filters by assignedTo', async () => {
    const res = await fetch(`${baseUrl}/tasks?assignedTo=architect`);
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const task of body) {
      expect(task.assignedTo).toBe('architect');
    }
  });
});

// ── 8. Agent card serving ───────────────────────────────────────────

describe('Agent cards', () => {
  test('GET /agents/:name/card returns card for registered agent', async () => {
    const res = await fetch(`${baseUrl}/agents/architect/card`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('architect');
    expect(body.protocolVersion).toBe('0.3.0');
    expect(body.capabilities.streaming).toBe(true);
    expect(body.skills.length).toBeGreaterThan(0);
  });

  test('GET /.well-known/agent.json returns bridge card', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('a2a-bridge');
  });

  test('returns 404 for unknown agent card', async () => {
    const res = await fetch(`${baseUrl}/agents/nope/card`);
    expect(res.status).toBe(404);
  });
});

// ── 9. SSE event streaming ──────────────────────────────────────────

describe('GET /events (SSE)', () => {
  test('receives events when a task is created', async () => {
    const controller = new AbortController();
    const sseRes = await fetch(`${baseUrl}/events`, {
      signal: controller.signal,
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toBe('text/event-stream');

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];

    // Read the initial keepalive (:ok)
    const first = await reader.read();
    chunks.push(decoder.decode(first.value));

    // Now create a task to trigger an event
    await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'architect',
        message: 'SSE test task',
      }),
    });

    // Read the event data chunk
    const second = await reader.read();
    chunks.push(decoder.decode(second.value));
    controller.abort();
    reader.cancel().catch(() => {});

    const allText = chunks.join('');
    expect(allText).toContain(':ok');
    expect(allText).toContain('data:');
    expect(allText).toContain('task:created');
  });
});

// ── 10. Unknown routes ──────────────────────────────────────────────

describe('Unknown routes', () => {
  test('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});

// ── 11. JSON-RPC dispatch ───────────────────────────────────────────

describe('POST / (JSON-RPC)', () => {
  test('tasks/send creates a task via JSON-RPC', async () => {
    // Register a second agent for JSON-RPC
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'coder',
        description: 'Coding agent',
        skills: ['code'],
      }),
    });

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Write auth module' }],
          },
          metadata: { assignedTo: 'coder' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.status.state).toBe('submitted');
  });

  test('tasks/get retrieves a task via JSON-RPC', async () => {
    // Create via JSON-RPC
    const createRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Get test' }],
          },
        },
      }),
    });
    const { result } = await createRes.json();

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/get',
        params: { id: result.id },
      }),
    });
    const body = await res.json();
    expect(body.result.id).toBe(result.id);
    expect(body.result.status.state).toBe('submitted');
  });

  test('rejects invalid JSON-RPC', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
  });

  test('returns method not found for unknown method', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tasks/nonexistent',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });
});

// ── 12. Task for unknown agent returns error ────────────────────────

describe('Edge cases', () => {
  test('task creation for unregistered agent fails', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'phantom',
        message: 'Should fail',
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('phantom');
  });
});

// ── 13. A2A spec compliance ─────────────────────────────────────────

describe('A2A spec compliance', () => {
  test('GET /.well-known/agent-card.json returns spec-compliant card', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json();
    // Required fields per A2A spec
    expect(card.name).toBe('a2a-bridge');
    expect(card.description).toBeDefined();
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.version).toBeDefined();
    expect(card.url).toBeDefined();
    expect(card.capabilities).toBeDefined();
    expect(card.skills).toBeInstanceOf(Array);
    expect(card.skills.length).toBeGreaterThan(0);
    // New fields from A2A v0.3.0
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
    expect(card.additionalInterfaces).toBeInstanceOf(Array);
    expect(card.additionalInterfaces[0].transport).toBe('JSONRPC');
  });

  test('JSON-RPC response includes kind:task discriminator', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'tasks/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'test-1',
            role: 'user',
            parts: [{ kind: 'text', text: 'Test with kind discriminator' }],
          },
          metadata: { assignedTo: 'architect' },
        },
      }),
    });
    const body = await res.json();
    expect(body.result.kind).toBe('task');
    expect(body.result.contextId).toBeDefined();
    expect(body.result.status.state).toBe('submitted');
  });

  test('message/send works as alias for tasks/send', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'test-2',
            role: 'user',
            parts: [{ kind: 'text', text: 'Via message/send' }],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.kind).toBe('task');
    expect(body.result.id).toBeDefined();
  });

  test('tasks/get returns artifacts in spec format', async () => {
    // Create a task and mark it completed with result
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'architect', message: 'artifact test' }),
    });
    const { task } = await createRes.json();

    await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: 'Test artifact content' }),
    });

    // Get via JSON-RPC
    const rpcRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 102,
        method: 'tasks/get',
        params: { id: task.id },
      }),
    });
    const body = await rpcRes.json();
    expect(body.result.kind).toBe('task');
    expect(body.result.artifacts).toBeInstanceOf(Array);
    expect(body.result.artifacts.length).toBe(1);
    expect(body.result.artifacts[0].artifactId).toBe('result');
    expect(body.result.artifacts[0].parts[0].kind).toBe('text');
    expect(body.result.artifacts[0].parts[0].text).toBe('Test artifact content');
  });

  test('agent card skills have required tags field', async () => {
    const res = await fetch(`${baseUrl}/agents/architect/card`);
    const card = await res.json();
    for (const skill of card.skills) {
      expect(skill.tags).toBeInstanceOf(Array);
      expect(skill.tags.length).toBeGreaterThan(0);
    }
  });

  test('POST /a2a handles JSON-RPC', async () => {
    const res = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 103,
        method: 'tasks/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'a2a-test',
            role: 'user',
            parts: [{ kind: 'text', text: 'Via /a2a endpoint' }],
          },
          metadata: { assignedTo: 'architect' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.kind).toBe('task');
  });

  test('tasks/get returns TaskNotFoundError with proper error code', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 200,
        method: 'tasks/get',
        params: { id: 'nonexistent-task-id' },
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.data?.type).toBe('TaskNotFoundError');
  });

  test('rejects non-string skills in agent registration', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-agent',
        description: 'Has bad skills',
        skills: [1, null, 'valid'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('strings');
  });

  test('rejects non-array message.parts in JSON-RPC', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 201,
        method: 'message/send',
        params: {
          message: { kind: 'message', messageId: 'x', role: 'user', parts: 'not-an-array' },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
  });

  test('handles non-text parts gracefully via JSON fallback', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 202,
        method: 'tasks/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'data-msg',
            role: 'user',
            parts: [{ kind: 'data', data: { key: 'value' } }],
          },
          metadata: { assignedTo: 'architect' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.kind).toBe('task');
  });

  test('event log endpoint returns entries', async () => {
    const res = await fetch(`${baseUrl}/events/log`);
    expect(res.status).toBe(200);
    const log = await res.json();
    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBeGreaterThan(0);
    // WAL entries are pipe-delimited
    expect(log[0]).toContain('|');
  });

  test('tasks/list returns all tasks with pagination', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 300,
        method: 'tasks/list',
        params: { pageSize: 5 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tasks).toBeInstanceOf(Array);
    expect(body.result.tasks.length).toBeGreaterThan(0);
    expect(body.result.totalSize).toBeGreaterThan(0);
    expect(typeof body.result.pageSize).toBe('number');
    for (const task of body.result.tasks) {
      expect(task.kind).toBe('task');
      expect(task.status.state).toBeDefined();
    }
  });

  test('tasks/list filters by status', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 301,
        method: 'tasks/list',
        params: { status: 'completed' },
      }),
    });
    const body = await res.json();
    for (const task of body.result.tasks) {
      expect(task.status.state).toBe('completed');
    }
  });

  test('tasks/cancel returns TaskNotCancelableError for completed task', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'architect', message: 'cancel test' }),
    });
    const { task } = await createRes.json();
    await fetch(`${baseUrl}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: 'done' }),
    });

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 302,
        method: 'tasks/cancel',
        params: { id: task.id },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.data?.type).toBe('TaskNotCancelableError');
  });

  test('message/stream returns SSE stream', async () => {
    const controller = new AbortController();
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 303,
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'stream-test',
            role: 'user',
            parts: [{ kind: 'text', text: 'Stream me' }],
          },
          metadata: { assignedTo: 'architect' },
        },
      }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('"kind":"task"');
    expect(text).toContain('"submitted"');

    controller.abort();
    reader.cancel().catch(() => {});
  });

  test('tasks/subscribe returns SSE stream for existing task', async () => {
    const createRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 304,
        method: 'message/send',
        params: {
          message: { kind: 'message', messageId: 'sub-test', role: 'user', parts: [{ kind: 'text', text: 'Subscribe' }] },
          metadata: { assignedTo: 'architect' },
        },
      }),
    });
    const { result } = await createRes.json();
    const taskId = result.id;

    const controller = new AbortController();
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 305,
        method: 'tasks/subscribe',
        params: { id: taskId },
      }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain(taskId);
    expect(text).toContain('"kind":"task"');

    controller.abort();
    reader.cancel().catch(() => {});
  });
});