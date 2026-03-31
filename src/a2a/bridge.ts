/**
 * Embedded A2A Bridge — lightweight HTTP coordination hub.
 *
 * Bun.serve based server implementing python-a2a route structure
 * with full A2A task lifecycle (submitted → working → completed/failed).
 */
import { EventEmitter } from 'events';
import { createAgentCard, type AgentCard, type AgentCardSkill } from './discovery';

// ─── Domain types ──────────────────────────────────────────────────

export interface RegisteredAgent {
  name: string;
  description: string;
  skills: string[];
  endpoint?: string;
  status: 'online' | 'idle' | 'busy' | 'offline';
  lastHeartbeat: string;
  registeredAt: string;
}

export type BridgeTaskStatus =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled';

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
const EVENT_TYPES = [
  'agent:registered',
  'agent:heartbeat',
  'agent:status',
  'task:created',
  'task:updated',
  'task:completed',
  'task:failed',
] as const;

type BridgeEventType = (typeof EVENT_TYPES)[number];

// ─── Bridge ────────────────────────────────────────────────────────

export class A2ABridge {
  private agents: Map<string, RegisteredAgent> = new Map();
  private tasks: Map<string, BridgeTask> = new Map();
  private events: EventEmitter = new EventEmitter();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;

  constructor(port: number = 8222) {
    this.port = port;
  }

  /** Start the bridge HTTP server. */
  start(): void {
    this.server = Bun.serve({
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });
    // Bun may pick a different port if requested one is busy
    this.port = this.server.port;
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
    // Wildcard channel used by SSE handler
    this.events.emit('*', event);
  }

  private jsonOk(data: unknown, status = 200): Response {
    return Response.json(data, { status });
  }

  private jsonErr(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
  }

  private generateId(): string {
    return crypto.randomUUID();
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

      // ── Status ────────────────────────────────────────────────
      if (method === 'GET' && path === '/status') {
        return this.handleStatus();
      }

      // ── Well-known agent card (bridge itself) ─────────────────
      if (
        method === 'GET' &&
        (path === '/.well-known/agent.json' || path === '/agent.json')
      ) {
        return this.handleBridgeCard();
      }

      // ── JSON-RPC dispatch (A2A standard) ──────────────────────
      if (method === 'POST' && path === '/') {
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

    const { name, description, skills, endpoint } = body as Record<
      string,
      unknown
    >;
    if (!name || typeof name !== 'string') {
      return this.jsonErr('Missing required field: name');
    }
    if (!description || typeof description !== 'string') {
      return this.jsonErr('Missing required field: description');
    }
    if (!Array.isArray(skills)) {
      return this.jsonErr('Missing required field: skills (array)');
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
    this.emit('agent:registered', { agent: name });

    return this.jsonOk({ ok: true, agent }, 201);
  }

  private async handleHeartbeat(
    name: string,
    req: Request,
  ): Promise<Response> {
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
    this.emit('agent:heartbeat', { agent: name, status: agent.status });

    return this.jsonOk({ ok: true, agent });
  }

  private handleGetAgentCard(name: string): Response {
    const agent = this.agents.get(name);
    if (!agent) {
      return this.jsonErr(`Agent not found: ${name}`, 404);
    }

    const skills: AgentCardSkill[] = agent.skills.map((s) => ({
      id: s,
      name: s,
      description: s,
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
      id: this.generateId(),
      assignedTo,
      status: 'submitted',
      message,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
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

  private async handleUpdateTask(
    id: string,
    req: Request,
  ): Promise<Response> {
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
      'submitted',
      'working',
      'completed',
      'failed',
      'canceled',
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
        // Flush an SSE comment so the client's fetch() resolves immediately
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

        // Listen on the wildcard channel (all events go here)
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
        },
      ],
      `http://localhost:${this.port}`,
    );

    return this.jsonOk(card);
  }

  // ── JSON-RPC dispatch ──────────────────────────────────────────

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
      case 'tasks/send': {
        const p = (params ?? {}) as Record<string, unknown>;
        const message = p.message as Record<string, unknown> | undefined;
        const taskId = (p.id as string) ?? this.generateId();

        if (!message || !message.parts) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Missing message.parts in params' },
            },
            { status: 400 },
          );
        }

        const textPart = (message.parts as Array<Record<string, unknown>>).find(
          (p) => p.type === 'text',
        );
        const text = textPart ? (textPart.text as string) : JSON.stringify(message.parts);

        // Pick first available agent or use metadata.assignedTo
        const assignedTo =
          (p.metadata as Record<string, unknown>)?.assignedTo as string ??
          (this.agents.size > 0 ? this.agents.keys().next().value : undefined);

        const now = new Date().toISOString();
        const task: BridgeTask = {
          id: taskId,
          assignedTo: assignedTo ?? 'unassigned',
          status: 'submitted',
          message: text,
          createdAt: now,
          updatedAt: now,
        };

        this.tasks.set(task.id, task);
        this.emit('task:created', { taskId: task.id, assignedTo: task.assignedTo });

        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            id: task.id,
            status: { state: task.status, timestamp: now },
          },
        });
      }

      case 'tasks/get': {
        const p = (params ?? {}) as Record<string, unknown>;
        const taskId = p.id as string;
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id,
              error: { code: -32001, message: `Task not found: ${taskId}` },
            },
            { status: 404 },
          );
        }
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            id: task.id,
            status: { state: task.status, timestamp: task.updatedAt },
            artifacts: task.result
              ? [{ parts: [{ type: 'text', text: task.result }] }]
              : [],
          },
        });
      }

      case 'tasks/cancel': {
        const p = (params ?? {}) as Record<string, unknown>;
        const taskId = p.id as string;
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task) {
          return Response.json(
            {
              jsonrpc: '2.0',
              id,
              error: { code: -32001, message: `Task not found: ${taskId}` },
            },
            { status: 404 },
          );
        }
        task.status = 'canceled';
        task.updatedAt = new Date().toISOString();
        this.emit('task:updated', { taskId: task.id, status: 'canceled' });

        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            id: task.id,
            status: { state: task.status, timestamp: task.updatedAt },
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
