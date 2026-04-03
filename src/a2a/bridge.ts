/**
 * Embedded A2A Bridge — Bun.serve coordination hub with @a2a-js/sdk types.
 *
 * Uses official SDK types (AgentCard, Message, Task, Part, Artifact, TaskState)
 * for full A2A protocol compliance. Implements both:
 *   1. **Standard A2A endpoints**: /.well-known/agent-card.json, POST / (JSON-RPC)
 *   2. **Orchestration endpoints**: /agents, /tasks, /events, /status
 *
 * The bridge is both a spec-compliant A2A server AND a multi-agent orchestrator.
 */
import { EventEmitter } from 'events';
import type {
  AgentCard,
  AgentSkill,
  Task as A2ATask,
  Message as A2AMessage,
  TaskState,
  Artifact,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { createAgentCard } from './discovery';
import type { RegisteredAgent, BridgeTaskStatus } from './types';

// Re-export for backward compatibility
export type { RegisteredAgent, BridgeTaskStatus } from './types';

export interface BridgeTask {
  id: string;
  assignedTo: string;
  status: BridgeTaskStatus;
  message: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

// Event names emitted on every state change
type BridgeEventType =
  | 'agent:registered'
  | 'agent:heartbeat'
  | 'agent:status'
  | 'task:created'
  | 'task:updated'
  | 'task:completed'
  | 'task:failed';

// ─── Bridge ────────────────────────────────────────────────────────

export class A2ABridge {
  private agents: Map<string, RegisteredAgent> = new Map();
  private tasks: Map<string, BridgeTask> = new Map();
  private events: EventEmitter = new EventEmitter();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private eventLog: string[] = [];

  constructor(port: number = 8222) {
    this.port = port;
  }

  private logEvent(type: string, taskId: string, agentName: string, detail: string): void {
    const entry = `${new Date().toISOString()}|${type}|${taskId}|${agentName}|${detail}`;
    this.eventLog.push(entry);
  }

  /** Start the bridge HTTP server. */
  start(): void {
    this.server = Bun.serve({
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });
    // Bun may pick a different port if requested one is busy
    this.port = this.server.port ?? this.port;
    console.log(`🌉 A2A Bridge running on http://localhost:${this.port}`);
  }

  /** Stop the bridge HTTP server. */
  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** Actual port the server is listening on. */
  get actualPort(): number {
    return this.port;
  }

  // ── helpers ──────────────────────────────────────────────────────

  /** Emit a typed event to both the named channel and SSE listeners. */
  private emit(type: BridgeEventType, payload: Record<string, unknown>): void {
    const event = { type, timestamp: new Date().toISOString(), ...payload };
    this.events.emit(type, event);
    this.events.emit('*', event);
  }

  private jsonOk(data: unknown, status = 200): Response {
    return Response.json(data, { status });
  }

  private jsonErr(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
  }

  // ── router ───────────────────────────────────────────────────────

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // ── Agent routes ──────────────────────────────────────────
      if (method === 'POST' && path === '/agents') {
        return this.handleRegisterAgent(req);
      }
      if (method === 'POST' && path.match(/^\/agents\/[\w-]+\/heartbeat$/)) {
        return this.handleHeartbeat(path.split('/')[2], req);
      }
      if (method === 'GET' && path.match(/^\/agents\/[\w-]+\/card$/)) {
        return this.handleGetAgentCard(path.split('/')[2]);
      }

      // ── Task routes ───────────────────────────────────────────
      if (method === 'POST' && path === '/tasks') {
        return this.handleSendTask(req);
      }
      if (method === 'GET' && path === '/tasks') {
        return this.handleListTasks(url.searchParams);
      }
      if (method === 'GET' && path.match(/^\/tasks\/[\w-]+$/)) {
        return this.handleGetTask(path.split('/')[2]);
      }
      if (method === 'PATCH' && path.match(/^\/tasks\/[\w-]+$/)) {
        return this.handleUpdateTask(path.split('/')[2], req);
      }

      // ── SSE ───────────────────────────────────────────────────
      if (method === 'GET' && path === '/events') {
        return this.handleSSE(req);
      }

      // ── Event log (WAL) ────────────────────────────────────
      if (method === 'GET' && path === '/events/log') {
        return this.jsonOk(this.eventLog);
      }

      // ── Status ────────────────────────────────────────────────
      if (method === 'GET' && path === '/status') {
        return this.handleStatus();
      }

      // ── Well-known agent card (A2A discovery) ─────────────────
      if (
        method === 'GET' &&
        (path === `/${AGENT_CARD_PATH}` ||
         path === '/.well-known/agent.json' ||
         path === '/agent.json')
      ) {
        return this.handleBridgeCard();
      }

      // ── JSON-RPC dispatch (A2A standard) ──────────────────────
      if (method === 'POST' && (path === '/' || path === '/a2a')) {
        return this.handleJsonRpc(req);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return this.jsonErr(String(err), 500);
    }
  }

  // ── Agent handlers ─────────────────────────────────────────────

  private async handleRegisterAgent(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return this.jsonErr('Invalid JSON body');
    }

    const { name, description, skills, endpoint } = body as Record<string, unknown>;
    if (!name || typeof name !== 'string') {
      return this.jsonErr('Missing required field: name');
    }
    if (!description || typeof description !== 'string') {
      return this.jsonErr('Missing required field: description');
    }
    if (!Array.isArray(skills)) {
      return this.jsonErr('Missing required field: skills (array)');
    }
    if (!skills.every((s: unknown) => typeof s === 'string')) {
      return this.jsonErr('skills must be an array of strings');
    }

    const now = new Date().toISOString();
    const agent: RegisteredAgent = {
      name,
      description,
      skills: skills as string[],
      endpoint: typeof endpoint === 'string' ? endpoint : undefined,
      status: 'online',
      lastHeartbeat: now,
      registeredAt: now,
    };

    this.agents.set(name, agent);
    this.logEvent('agent_registered', '', name, (skills as string[]).join(','));
    this.emit('agent:registered', { agent: name });

    return this.jsonOk({ ok: true, agent }, 201);
  }

  private async handleHeartbeat(name: string, req: Request): Promise<Response> {
    const agent = this.agents.get(name);
    if (!agent) {
      return this.jsonErr(`Agent not found: ${name}`, 404);
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      // body is optional
    }

    agent.lastHeartbeat = new Date().toISOString();
    if (
      typeof body.status === 'string' &&
      ['online', 'idle', 'busy', 'offline'].includes(body.status)
    ) {
      agent.status = body.status as RegisteredAgent['status'];
    }
    this.logEvent('heartbeat', '', name, agent.status);
    this.emit('agent:heartbeat', { agent: name, status: agent.status });

    return this.jsonOk({ ok: true, agent });
  }

  private handleGetAgentCard(name: string): Response {
    const agent = this.agents.get(name);
    if (!agent) {
      return this.jsonErr(`Agent not found: ${name}`, 404);
    }

    const skills: AgentSkill[] = agent.skills.map((s) => ({
      id: s,
      name: s,
      description: s,
      tags: [s],
    }));

    const card: AgentCard = createAgentCard(
      agent.name,
      agent.description,
      skills,
      agent.endpoint ?? `http://localhost:${this.port}/agents/${agent.name}`,
    );

    return this.jsonOk(card);
  }

  // ── Task handlers ──────────────────────────────────────────────

  private async handleSendTask(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return this.jsonErr('Invalid JSON body');
    }

    const { assignedTo, message } = body as Record<string, unknown>;
    if (!assignedTo || typeof assignedTo !== 'string') {
      return this.jsonErr('Missing required field: assignedTo');
    }
    if (!message || typeof message !== 'string') {
      return this.jsonErr('Missing required field: message');
    }

    if (!this.agents.has(assignedTo)) {
      return this.jsonErr(`Unknown agent: ${assignedTo}`, 404);
    }

    const now = new Date().toISOString();
    const task: BridgeTask = {
      id: crypto.randomUUID(),
      assignedTo,
      status: 'submitted',
      message,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
    this.logEvent('task_created', task.id, assignedTo, task.message);
    this.emit('task:created', { taskId: task.id, assignedTo });

    return this.jsonOk({ ok: true, task }, 201);
  }

  private handleGetTask(id: string): Response {
    const task = this.tasks.get(id);
    if (!task) {
      return this.jsonErr(`Task not found: ${id}`, 404);
    }
    return this.jsonOk(task);
  }

  private async handleUpdateTask(id: string, req: Request): Promise<Response> {
    const task = this.tasks.get(id);
    if (!task) {
      return this.jsonErr(`Task not found: ${id}`, 404);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return this.jsonErr('Invalid JSON body');
    }

    const { status, result } = body as Record<string, unknown>;

    const validStatuses: BridgeTaskStatus[] = [
      'submitted', 'working', 'completed', 'failed', 'canceled',
    ];
    if (status !== undefined) {
      if (typeof status !== 'string' || !validStatuses.includes(status as BridgeTaskStatus)) {
        return this.jsonErr(
          `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        );
      }
      task.status = status as BridgeTaskStatus;
    }
    if (result !== undefined && typeof result === 'string') {
      task.result = result;
    }

    task.updatedAt = new Date().toISOString();
    this.logEvent('task_updated', id, task.assignedTo, task.status);

    if (task.status === 'completed') {
      this.emit('task:completed', { taskId: id });
    } else if (task.status === 'failed') {
      this.emit('task:failed', { taskId: id });
    } else {
      this.emit('task:updated', { taskId: id, status: task.status });
    }

    return this.jsonOk({ ok: true, task });
  }

  private handleListTasks(params: URLSearchParams): Response {
    let results = Array.from(this.tasks.values());

    const statusFilter = params.get('status');
    if (statusFilter) {
      results = results.filter((t) => t.status === statusFilter);
    }

    const agentFilter = params.get('assignedTo');
    if (agentFilter) {
      results = results.filter((t) => t.assignedTo === agentFilter);
    }

    return this.jsonOk(results);
  }

  // ── SSE ────────────────────────────────────────────────────────

  private handleSSE(req: Request): Response {
    const encoder = new TextEncoder();
    const bridge = this;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(':ok\n\n'));

        const handler = (event: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          } catch {
            // stream may be closed
          }
        };

        bridge.events.on('*', handler);

        req.signal.addEventListener('abort', () => {
          bridge.events.off('*', handler);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // ── Status / health ────────────────────────────────────────────

  private handleStatus(): Response {
    const agents = Array.from(this.agents.values());
    const tasks = Array.from(this.tasks.values());

    return this.jsonOk({
      bridge: 'running',
      port: this.port,
      agents: {
        total: agents.length,
        online: agents.filter((a) => a.status === 'online').length,
        busy: agents.filter((a) => a.status === 'busy').length,
        idle: agents.filter((a) => a.status === 'idle').length,
        offline: agents.filter((a) => a.status === 'offline').length,
        list: agents,
      },
      tasks: {
        total: tasks.length,
        submitted: tasks.filter((t) => t.status === 'submitted').length,
        working: tasks.filter((t) => t.status === 'working').length,
        completed: tasks.filter((t) => t.status === 'completed').length,
        failed: tasks.filter((t) => t.status === 'failed').length,
        canceled: tasks.filter((t) => t.status === 'canceled').length,
      },
    });
  }

  // ── Bridge agent card ──────────────────────────────────────────

  private handleBridgeCard(): Response {
    const card: AgentCard = createAgentCard(
      'a2a-bridge',
      'A2A Crews coordination bridge — routes tasks between agents',
      [
        {
          id: 'coordination',
          name: 'coordination',
          description: 'Multi-agent task coordination',
          tags: ['coordination', 'orchestration'],
        },
      ],
      `http://localhost:${this.port}`,
    );

    return this.jsonOk(card);
  }

  // ── JSON-RPC dispatch (A2A protocol) ───────────────────────────

  /**
   * Handles A2A JSON-RPC 2.0 requests at POST / and POST /a2a.
   * Supports both legacy method names (tasks/send) and spec v0.3.0 names (message/send).
   * Returns spec-compliant Task objects with kind:'task' discriminator.
   */
  private async handleJsonRpc(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return this.jsonErr('Invalid JSON body');
    }

    const { jsonrpc, id, method, params } = body as Record<string, unknown>;

    if (jsonrpc !== '2.0' || !method || typeof method !== 'string') {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32600, message: 'Invalid JSON-RPC request' },
        },
        { status: 400 },
      );
    }

    switch (method) {
      case 'tasks/send':
      case 'message/send': {
        const p = (params ?? {}) as Record<string, unknown>;
        const message = p.message as Record<string, unknown> | undefined;
        const taskId = (typeof p.id === 'string' ? p.id : null) ?? crypto.randomUUID();

        if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Missing or invalid message.parts in params' },
            },
            { status: 400 },
          );
        }

        // Support both 'type' (legacy) and 'kind' (v0.3.0) part discriminators
        const parts = message.parts as Array<Record<string, unknown>>;
        const textPart = parts.find(
          (p) => p.type === 'text' || p.kind === 'text',
        );
        const text = (textPart && typeof textPart.text === 'string')
          ? textPart.text
          : JSON.stringify(parts);

        // Resolve agent from metadata (request-level or message-level)
        const assignedTo =
          (p.metadata as Record<string, unknown>)?.assignedTo as string ??
          (message.metadata as Record<string, unknown>)?.assignedTo as string ??
          (this.agents.size > 0 ? this.agents.keys().next().value : undefined);

        const now = new Date().toISOString();
        const contextId = (message.contextId as string) ?? taskId;

        const task: BridgeTask = {
          id: taskId,
          assignedTo: (assignedTo as string) ?? 'unassigned',
          status: 'submitted',
          message: text,
          createdAt: now,
          updatedAt: now,
        };

        this.tasks.set(task.id, task);
        this.logEvent('task_created', task.id, task.assignedTo, task.message);
        this.emit('task:created', { taskId: task.id, assignedTo: task.assignedTo });

        // Return A2A spec-compliant Task object
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            kind: 'task',
            id: task.id,
            contextId,
            status: { state: task.status as TaskState, timestamp: now },
          },
        });
      }

      case 'tasks/get': {
        const p = (params ?? {}) as Record<string, unknown>;
        const taskId = typeof p.id === 'string' ? p.id : undefined;
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Task not found: ${taskId}`, data: { type: 'TaskNotFoundError' } },
            },
            { status: 404 },
          );
        }

        // Build spec-compliant artifacts array
        const artifacts: Artifact[] = task.result
          ? [{
              artifactId: 'result',
              parts: [{ kind: 'text' as const, text: task.result }],
            }]
          : [];

        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            kind: 'task',
            id: task.id,
            contextId: task.id,
            status: { state: task.status as TaskState, timestamp: task.updatedAt },
            artifacts,
          },
        });
      }

      case 'tasks/cancel': {
        const p = (params ?? {}) as Record<string, unknown>;
        const taskId = typeof p.id === 'string' ? p.id : undefined;
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Task not found: ${taskId}`, data: { type: 'TaskNotFoundError' } },
            },
            { status: 404 },
          );
        }
        task.status = 'canceled';
        task.updatedAt = new Date().toISOString();
        this.logEvent('task_updated', task.id, task.assignedTo, 'canceled');
        this.emit('task:updated', { taskId: task.id, status: 'canceled' });

        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            kind: 'task',
            id: task.id,
            contextId: task.id,
            status: { state: task.status as TaskState, timestamp: task.updatedAt },
          },
        });
      }

      default:
        return Response.json(
          {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          },
          { status: 400 },
        );
    }
  }
}
