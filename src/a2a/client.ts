/**
 * A2A Client — create proper A2A messages and connect to any A2A server.
 *
 * Uses official @a2a-js/sdk ClientFactory for spec-compliant communication.
 * Also provides standalone helpers for environments where the SDK client
 * can't resolve its transitive deps (e.g., Bun on Windows).
 */
import type { Message, AgentCard, MessageSendParams } from '@a2a-js/sdk';

// ─── Message helpers ─────────────────────────────────────────────

/** Create a spec-compliant A2A user message. */
export function createUserMessage(text: string, metadata?: Record<string, unknown>): Message {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text }],
    metadata,
  };
}

/** Create a spec-compliant A2A agent message. */
export function createAgentMessage(text: string, metadata?: Record<string, unknown>): Message {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'agent',
    parts: [{ kind: 'text', text }],
    metadata,
  };
}

/** Create MessageSendParams for the JSON-RPC message/send method. */
export function createSendParams(
  text: string,
  assignedTo?: string,
): MessageSendParams {
  return {
    message: createUserMessage(text, assignedTo ? { assignedTo } : undefined),
  };
}

// ─── Fetch-based A2A client (works everywhere) ──────────────────

/**
 * Lightweight A2A client using fetch — works on any runtime.
 * No dependency on SDK client internals (which need uuid at runtime).
 */
export class A2AClient {
  constructor(private baseUrl: string) {}

  /** Fetch the agent card from /.well-known/agent-card.json */
  async getAgentCard(): Promise<AgentCard> {
    const res = await fetch(`${this.baseUrl}/.well-known/agent-card.json`);
    if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.status}`);
    return res.json() as Promise<AgentCard>;
  }

  /** Send a message via JSON-RPC message/send. Returns the task. */
  async sendMessage(text: string, metadata?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'message/send',
        params: {
          message: createUserMessage(text, metadata),
        },
      }),
    });
    const body = await res.json() as Record<string, unknown>;
    if ((body as any).error) throw new Error(`JSON-RPC error: ${JSON.stringify((body as any).error)}`);
    return (body as any).result;
  }

  /** Get a task by ID via JSON-RPC tasks/get. */
  async getTask(taskId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tasks/get',
        params: { id: taskId },
      }),
    });
    const body = await res.json() as Record<string, unknown>;
    if ((body as any).error) throw new Error(`JSON-RPC error: ${JSON.stringify((body as any).error)}`);
    return (body as any).result;
  }

  /** List tasks via JSON-RPC tasks/list. */
  async listTasks(filters?: { status?: string; pageSize?: number }): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tasks/list',
        params: filters ?? {},
      }),
    });
    const body = await res.json() as Record<string, unknown>;
    if ((body as any).error) throw new Error(`JSON-RPC error: ${JSON.stringify((body as any).error)}`);
    return (body as any).result;
  }

  /** Cancel a task via JSON-RPC tasks/cancel. */
  async cancelTask(taskId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tasks/cancel',
        params: { id: taskId },
      }),
    });
    const body = await res.json() as Record<string, unknown>;
    if ((body as any).error) throw new Error(`JSON-RPC error: ${JSON.stringify((body as any).error)}`);
    return (body as any).result;
  }

  /** Subscribe to task updates via JSON-RPC tasks/subscribe (SSE). */
  async subscribe(taskId: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${this.baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tasks/subscribe',
        params: { id: taskId },
      }),
      signal,
    });
    if (!res.body) throw new Error('No response body for subscribe');
    return res.body;
  }
}
