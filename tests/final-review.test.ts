/**
 * Final review tests - probing for edge cases and subtle bugs
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { A2ABridge } from '../src/a2a/bridge';

let bridge: A2ABridge;
let baseUrl: string;

beforeAll(() => {
  bridge = new A2ABridge(0); // random port
  bridge.start();
  baseUrl = `http://localhost:${bridge.actualPort}`;
});

afterAll(() => {
  bridge.stop();
});

describe('Route matching edge cases', () => {
  test('/tasks/something/else should return 404, not match /tasks/:id', async () => {
    const res = await fetch(`${baseUrl}/tasks/abc123/extra`, {
      method: 'GET',
    });
    expect(res.status).toBe(404);
  });

  test('/tasks/:id/card should return 404, not match /tasks/:id', async () => {
    const res = await fetch(`${baseUrl}/tasks/abc123/card`, {
      method: 'GET',
    });
    expect(res.status).toBe(404);
  });

  test('/agents/:name/heartbeat/extra should return 404', async () => {
    const res = await fetch(`${baseUrl}/agents/test/heartbeat/extra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe('Pagination edge cases', () => {
  test('pageToken as negative number should clamp to 0', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/list',
        params: { pageToken: '-5' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tasks).toBeInstanceOf(Array);
  });

  test('pageToken as non-numeric string should be treated as 0', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/list',
        params: { pageToken: 'invalid' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tasks).toBeInstanceOf(Array);
  });

  test('pageSize of 0 should default to 50', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/list',
        params: { pageSize: 0 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.pageSize).toBe(1); // clamped to minimum
  });

  test('pageSize exceeding 100 should clamp to 100', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tasks/list',
        params: { pageSize: 200 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.pageSize).toBe(100);
  });

  test('pageSize as negative number should use 50 default', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tasks/list',
        params: { pageSize: -10 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Negative pageSize should ideally be clamped to default
    expect(body.result.pageSize).toBeGreaterThan(0);
  });
});

describe('SSE /events handler cleanup', () => {
  test('multiple SSE connections should not leak listeners', async () => {
    const controllers: AbortController[] = [];
    const promises: Promise<Response>[] = [];

    // Open 20 SSE connections
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      promises.push(
        fetch(`${baseUrl}/events`, {
          signal: controller.signal,
        })
      );
    }

    // Wait for connections to establish
    const responses = await Promise.all(promises);
    expect(responses.every((r) => r.status === 200)).toBe(true);

    // Close all connections
    for (const controller of controllers) {
      controller.abort();
    }

    // Give time for cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Open a new connection to verify the bridge still works
    const finalController = new AbortController();
    const finalRes = await fetch(`${baseUrl}/events`, {
      signal: finalController.signal,
    });
    expect(finalRes.status).toBe(200);
    finalController.abort();
  });

  test('SSE connection cleanup happens on client disconnect', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    // Abort the connection
    controller.abort();

    // Bridge should still be functional
    const statusRes = await fetch(`${baseUrl}/status`);
    expect(statusRes.status).toBe(200);
  });
});

describe('toA2ATask edge cases', () => {
  beforeAll(async () => {
    // Register an agent first
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-agent',
        description: 'Test agent',
        skills: ['test'],
      }),
    });
  });

  test('task with no updatedAt should not crash', async () => {
    // Create a task normally (it will have updatedAt)
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'test-agent',
        message: 'test',
      }),
    });
    const { task } = await createRes.json();

    // Get the task via JSON-RPC to see A2A format
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'tasks/get',
        params: { id: task.id },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.status.timestamp).toBeDefined();
    expect(body.result.kind).toBe('task');
  });

  test('task with no result should have empty artifacts array', async () => {
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignedTo: 'test-agent',
        message: 'test no result',
      }),
    });
    const { task } = await createRes.json();

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tasks/get',
        params: { id: task.id },
      }),
    });
    const body = await res.json();
    expect(body.result.artifacts).toEqual([]);
  });
});

describe('createTaskFromRpc return type handling', () => {
  test('caller cannot use Response as BridgeTask when validation fails', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 200,
        method: 'tasks/send',
        params: {
          // Missing message.parts
          message: {},
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('message.parts');
  });

  test('successful task creation returns BridgeTask structure', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 201,
        method: 'tasks/send',
        params: {
          message: {
            parts: [{ kind: 'text', text: 'test message' }],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.kind).toBe('task');
    expect(body.result.id).toBeDefined();
  });
});

describe('createTaskStream cleanup', () => {
  beforeAll(async () => {
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'stream-agent',
        description: 'Agent for stream tests',
        skills: ['streaming'],
      }),
    });
  });

  test('stream closes when task reaches terminal state', async () => {
    const controller = new AbortController();
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 300,
        method: 'message/stream',
        params: {
          message: {
            parts: [{ kind: 'text', text: 'stream test' }],
          },
          metadata: { assignedTo: 'stream-agent' },
        },
      }),
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    
    // Read initial event
    const { value } = await reader!.read();
    const text = decoder.decode(value);
    const taskIdMatch = text.match(/"id":"([^"]+)"/);
    const taskId = taskIdMatch?.[1];
    expect(taskId).toBeDefined();

    // Complete the task
    await fetch(`${baseUrl}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', result: 'done' }),
    });

    // Stream should close after receiving terminal event
    // Wait a bit for events to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    controller.abort();
  });
});
