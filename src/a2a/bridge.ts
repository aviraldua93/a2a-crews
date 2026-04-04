/**
 * Embedded A2A Bridge — Bun.serve coordination hub with @a2a-js/sdk types.
 *
 * Uses official SDK types (AgentCard, Message, Task, Part, Artifact, TaskState)
 * for full A2A protocol compliance. Implements both:
 *   1. **Standard A2A endpoints**: /.well-known/agent-card.json, POST / (JSON-RPC)
 *   2. **Orchestration endpoints**: /agents, /tasks, /events, /status
 *
 * JSON-RPC methods implemented:
 *   - message/send (tasks/send)  — create a task
 *   - message/stream             — create a task + SSE stream updates
 *   - tasks/get                  — retrieve task state
 *   - tasks/list                 — query tasks with filters
 *   - tasks/cancel               — cancel a running task
 *   - tasks/subscribe            — SSE stream for existing task updates
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

/** A2A Message stored in task history. */
export interface BridgeMessage {
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Agent runtime event reported via POST /agents/:name/events. */
export interface AgentEvent {
  agentName: string;
  type: 'error' | 'warning' | 'info' | 'port_conflict' | 'tool_failure' | 'dependency_missing' | 'context_overflow';
  message: string;
  taskId?: string;
  severity: 'fatal' | 'error' | 'warning' | 'info';
  timestamp: string;
  details?: Record<string, unknown>;
}

/** Relayed message between agents (#15). */
export interface RelayedMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  contextId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Token usage tracking per task (#16). */
export interface TaskUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  model?: string;
}

export interface BridgeTask {
  id: string;
  contextId: string;
  assignedTo: string;
  status: BridgeTaskStatus;
  message: string;
  result?: string;
  history: BridgeMessage[];
  metadata: Record<string, unknown>;
  usage?: TaskUsage;
  createdAt: string;
  updatedAt: string;
}

// Event names emitted on every state change
type BridgeEventType =
  | 'agent:registered'
  | 'agent:heartbeat'
  | 'agent:status'
  | 'agent:event'
  | 'task:created'
  | 'task:updated'
  | 'task:completed'
  | 'task:failed'
  | 'task:input-required'
  | 'message:relayed'
  | 'budget:exceeded';

// ─── Limits ────────────────────────────────────────────────────────

const MAX_TASKS = 100_000;
const MAX_AGENTS = 1_000;
const MAX_EVENT_LOG = 10_000;
const MAX_SSE_CONNECTIONS = 100;
const MAX_PARTS = 1_000;
const MAX_TEXT_LENGTH = 1_000_000; // 1 MB
const MAX_INBOX_SIZE = 1_000;      // per-agent message inbox
const MAX_TOTAL_TOKENS = 10_000_000;  // crew-wide budget (configurable)

// ─── Bridge ────────────────────────────────────────────────────────

export class A2ABridge {
  private agents: Map<string, RegisteredAgent> = new Map();
  private tasks: Map<string, BridgeTask> = new Map();
  private events: EventEmitter = new EventEmitter();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private eventLog: string[] = [];
  private activeSSEConnections = 0;
  private agentInboxes: Map<string, RelayedMessage[]> = new Map();
  private totalUsage: TaskUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
  private agentUsage: Map<string, TaskUsage> = new Map();

  constructor(port: number = 8222) {
    this.port = port;
    this.events.setMaxListeners(MAX_SSE_CONNECTIONS + 50);
  }

  private logEvent(type: string, taskId: string, agentName: string, detail: string): void {
    const entry = `${new Date().toISOString()}|${type}|${taskId}|${agentName}|${detail}`;
    this.eventLog.push(entry);
    // Circular buffer — prevent unbounded growth
    if (this.eventLog.length > MAX_EVENT_LOG) {
      this.eventLog = this.eventLog.slice(-MAX_EVENT_LOG);
    }
  }

  /** Accumulate token usage for an agent and crew-wide total. */
  private trackUsage(agentName: string, usage: TaskUsage): void {
    // Agent-level
    const existing = this.agentUsage.get(agentName) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
    existing.promptTokens += usage.promptTokens;
    existing.completionTokens += usage.completionTokens;
    existing.totalTokens += usage.totalTokens;
    existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + (usage.estimatedCostUsd ?? 0);
    this.agentUsage.set(agentName, existing);

    // Crew-wide total
    this.totalUsage.promptTokens += usage.promptTokens;
    this.totalUsage.completionTokens += usage.completionTokens;
    this.totalUsage.totalTokens += usage.totalTokens;
    this.totalUsage.estimatedCostUsd = (this.totalUsage.estimatedCostUsd ?? 0) + (usage.estimatedCostUsd ?? 0);

    this.logEvent('usage_reported', '', agentName, `${usage.totalTokens} tokens`);

    // Budget check
    if (this.totalUsage.totalTokens > MAX_TOTAL_TOKENS) {
      this.emit('budget:exceeded', {
        totalTokens: this.totalUsage.totalTokens,
        limit: MAX_TOTAL_TOKENS,
        agent: agentName,
      });
    }
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

  /** Convert internal BridgeTask to A2A spec-compliant Task object. */
  private toA2ATask(task: BridgeTask): Record<string, unknown> {
    const artifacts: Artifact[] = task.result
      ? [{ artifactId: 'result', parts: [{ kind: 'text' as const, text: task.result }] }]
      : [];
    const meta: Record<string, unknown> = { ...task.metadata };
    if (task.usage) meta.usage = task.usage;
    return {
      kind: 'task',
      id: task.id,
      contextId: task.contextId,
      status: { state: task.status as TaskState, timestamp: task.updatedAt },
      artifacts,
      history: task.history.map(m => ({
        kind: 'message',
        messageId: `${task.id}-${m.timestamp}`,
        role: m.role,
        parts: [{ kind: 'text', text: m.text }],
        metadata: m.metadata,
      })),
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    };
  }

  /** Create an SSE stream that follows a task until it reaches a terminal state. */
  private createTaskStream(taskId: string, initialResult?: Record<string, unknown>): Response {
    const encoder = new TextEncoder();
    const bridge = this;
    const TERMINAL_STATES = ['completed', 'failed', 'canceled'];
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let handler: ((event: Record<string, unknown>) => void) | null = null;

    const cleanup = (controller?: ReadableStreamDefaultController) => {
      if (timeout) { clearTimeout(timeout); timeout = null; }
      if (handler) { bridge.events.off('*', handler); handler = null; }
      try { controller?.close(); } catch { /* already closed */ }
    };

    const stream = new ReadableStream({
      start(controller) {
        // Send initial task state
        if (initialResult) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialResult)}\n\n`));
        }

        const task = bridge.tasks.get(taskId);
        if (task && TERMINAL_STATES.includes(task.status)) {
          controller.close();
          return;
        }

        handler = (event: Record<string, unknown>) => {
          if ((event.taskId as string) !== taskId) return;

          try {
            const currentTask = bridge.tasks.get(taskId);
            if (!currentTask) return;

            const update = {
              kind: 'status-update',
              taskId,
              contextId: currentTask.contextId,
              status: { state: currentTask.status, timestamp: currentTask.updatedAt },
              final: TERMINAL_STATES.includes(currentTask.status),
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`));

            if (currentTask.result && currentTask.status === 'completed') {
              const artifactUpdate = {
                kind: 'artifact-update',
                taskId,
                contextId: currentTask.contextId,
                artifact: {
                  artifactId: 'result',
                  parts: [{ kind: 'text', text: currentTask.result }],
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(artifactUpdate)}\n\n`));
            }

            if (TERMINAL_STATES.includes(currentTask.status)) {
              cleanup(controller);
            }
          } catch {
            // stream may be closed by client
          }
        };

        bridge.events.on('*', handler);

        // Safety timeout: 10 minutes max
        timeout = setTimeout(() => cleanup(controller), 10 * 60 * 1000);

        // Re-check after registration to close the race window
        const recheck = bridge.tasks.get(taskId);
        if (recheck && TERMINAL_STATES.includes(recheck.status)) {
          cleanup(controller);
        }
      },

      cancel() {
        // Called when client disconnects — clean up handler + timeout
        cleanup();
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
      if (method === 'POST' && path.match(/^\/agents\/[\w-]+\/events$/)) {
        return this.handleAgentEvent(path.split('/')[2], req);
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

    // Rate limit: prevent DoS via unlimited agent registration
    if (!this.agents.has(name as string) && this.agents.size >= MAX_AGENTS) {
      return this.jsonErr('Agent limit reached', 429);
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

  // ── Agent event reporting (#6, #18) ────────────────────────────

  private async handleAgentEvent(agentName: string, req: Request): Promise<Response> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      return this.jsonErr(`Agent not found: ${agentName}`, 404);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return this.jsonErr('Invalid JSON body');
    }

    const { type, message, taskId, severity, details } = body as Record<string, unknown>;
    if (!type || typeof type !== 'string') {
      return this.jsonErr('Missing required field: type');
    }
    if (!message || typeof message !== 'string') {
      return this.jsonErr('Missing required field: message');
    }

    const validTypes = ['error', 'warning', 'info', 'port_conflict', 'tool_failure', 'dependency_missing', 'context_overflow'];
    if (!validTypes.includes(type)) {
      return this.jsonErr(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }

    const validSeverities = ['fatal', 'error', 'warning', 'info'];
    const sev = typeof severity === 'string' && validSeverities.includes(severity)
      ? severity as AgentEvent['severity']
      : 'error';

    const event: AgentEvent = {
      agentName,
      type: type as AgentEvent['type'],
      message: message as string,
      taskId: typeof taskId === 'string' ? taskId : undefined,
      severity: sev,
      timestamp: new Date().toISOString(),
      details: typeof details === 'object' && details !== null ? details as Record<string, unknown> : undefined,
    };

    this.logEvent(`agent_event:${type}`, (event.taskId ?? ''), agentName, message as string);
    this.emit('agent:event', { event });

    // If severity is fatal and linked to a task, auto-fail the task
    if (sev === 'fatal' && event.taskId) {
      const task = this.tasks.get(event.taskId);
      if (task && !['completed', 'failed', 'canceled'].includes(task.status)) {
        task.status = 'failed';
        task.result = `Agent error (${type}): ${message}`;
        task.history.push({ role: 'agent', text: `FATAL: ${message}`, timestamp: event.timestamp });
        task.updatedAt = event.timestamp;
        this.emit('task:failed', { taskId: event.taskId });
      }
    }

    return this.jsonOk({ ok: true, event }, 201);
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

    if (this.tasks.size >= MAX_TASKS) {
      return this.jsonErr('Task limit reached', 429);
    }

    const now = new Date().toISOString();
    const taskId = crypto.randomUUID();
    const task: BridgeTask = {
      id: taskId,
      contextId: taskId,
      assignedTo,
      status: 'submitted',
      message,
      history: [{ role: 'user', text: message, timestamp: now }],
      metadata: {},
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
      'submitted', 'working', 'input-required', 'completed', 'failed', 'canceled',
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
      // Only append to history if result actually changed (avoid duplicates on retry)
      if (task.result !== result) {
        task.history.push({ role: 'agent', text: result, timestamp: new Date().toISOString() });
      }
      task.result = result;
    }

    // Track token usage (#16)
    const { usage } = body as Record<string, unknown>;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      const taskUsage: TaskUsage = {
        promptTokens: typeof u.promptTokens === 'number' ? u.promptTokens : 0,
        completionTokens: typeof u.completionTokens === 'number' ? u.completionTokens : 0,
        totalTokens: typeof u.totalTokens === 'number' ? u.totalTokens : 0,
        estimatedCostUsd: typeof u.estimatedCostUsd === 'number' ? u.estimatedCostUsd : undefined,
        model: typeof u.model === 'string' ? u.model : undefined,
      };
      task.usage = taskUsage;
      this.trackUsage(task.assignedTo, taskUsage);
    }

    task.updatedAt = new Date().toISOString();
    this.logEvent('task_updated', id, task.assignedTo, task.status);

    if (task.status === 'completed') {
      this.emit('task:completed', { taskId: id });
    } else if (task.status === 'failed') {
      this.emit('task:failed', { taskId: id });
    } else if (task.status === 'input-required') {
      this.emit('task:input-required', { taskId: id });
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
    if (this.activeSSEConnections >= MAX_SSE_CONNECTIONS) {
      return this.jsonErr('Too many SSE connections', 429);
    }
    this.activeSSEConnections++;

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
          bridge.activeSSEConnections--;
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

    const byAgent: Record<string, TaskUsage> = {};
    for (const [name, usage] of this.agentUsage.entries()) {
      byAgent[name] = usage;
    }

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
      usage: {
        totalTokens: this.totalUsage.totalTokens,
        promptTokens: this.totalUsage.promptTokens,
        completionTokens: this.totalUsage.completionTokens,
        estimatedCostUsd: this.totalUsage.estimatedCostUsd,
        budgetLimit: MAX_TOTAL_TOKENS,
        byAgent,
      },
      messaging: {
        totalInboxes: this.agentInboxes.size,
        totalMessages: Array.from(this.agentInboxes.values()).reduce((sum, inbox) => sum + inbox.length, 0),
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
        const task = this.createTaskFromRpc(id, params);
        if (task instanceof Response) return task; // validation error
        return Response.json({ jsonrpc: '2.0', id, result: this.toA2ATask(task) });
      }

      case 'message/stream':
      case 'tasks/sendSubscribe': {
        const task = this.createTaskFromRpc(id, params);
        if (task instanceof Response) return task; // validation error
        return this.createTaskStream(task.id, this.toA2ATask(task));
      }

      case 'tasks/get': {
        const p = (params ?? {}) as Record<string, unknown>;
        const taskId = typeof p.id === 'string' ? p.id : undefined;
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task) {
          return Response.json(
            { jsonrpc: '2.0', id, error: { code: -32602, message: `Task not found: ${taskId}`, data: { type: 'TaskNotFoundError' } } },
            { status: 404 },
          );
        }
        return Response.json({ jsonrpc: '2.0', id, result: this.toA2ATask(task) });
      }

      case 'tasks/list': {
        const p = (params ?? {}) as Record<string, unknown>;
        let results = Array.from(this.tasks.values());

        // Filter by contextId
        if (typeof p.contextId === 'string') {
          results = results.filter(t => t.id === p.contextId);
        }
        // Filter by status
        if (typeof p.status === 'string') {
          results = results.filter(t => t.status === p.status);
        }
        // Filter by assignedTo (extension)
        if (typeof p.assignedTo === 'string') {
          results = results.filter(t => t.assignedTo === p.assignedTo);
        }
        // Pagination
        const pageSize = typeof p.pageSize === 'number' ? Math.max(1, Math.min(p.pageSize, 100)) : 50;
        const pageToken = typeof p.pageToken === 'string' ? parseInt(p.pageToken, 10) : 0;
        const offset = isNaN(pageToken) ? 0 : pageToken;
        const page = results.slice(offset, offset + pageSize);
        const nextPageToken = offset + pageSize < results.length ? String(offset + pageSize) : '';

        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            tasks: page.map(t => this.toA2ATask(t)),
            nextPageToken,
            pageSize,
            totalSize: results.length,
          },
        });
      }

      case 'tasks/cancel': {
        const p = (params ?? {}) as Record<string, unknown>;
        const taskId = typeof p.id === 'string' ? p.id : undefined;
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task) {
          return Response.json(
            { jsonrpc: '2.0', id, error: { code: -32602, message: `Task not found: ${taskId}`, data: { type: 'TaskNotFoundError' } } },
            { status: 404 },
          );
        }
        if (['completed', 'failed', 'canceled'].includes(task.status)) {
          return Response.json(
            { jsonrpc: '2.0', id, error: { code: -32602, message: `Task not cancelable: ${taskId}`, data: { type: 'TaskNotCancelableError' } } },
            { status: 400 },
          );
        }
        task.status = 'canceled';
        task.updatedAt = new Date().toISOString();
        this.logEvent('task_updated', task.id, task.assignedTo, 'canceled');
        this.emit('task:updated', { taskId: task.id, status: 'canceled' });
        return Response.json({ jsonrpc: '2.0', id, result: this.toA2ATask(task) });
      }

      case 'tasks/subscribe':
      case 'tasks/resubscribe': {
        const p = (params ?? {}) as Record<string, unknown>;
        const taskId = typeof p.id === 'string' ? p.id : undefined;
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task) {
          return Response.json(
            { jsonrpc: '2.0', id, error: { code: -32602, message: `Task not found: ${taskId}`, data: { type: 'TaskNotFoundError' } } },
            { status: 404 },
          );
        }
        return this.createTaskStream(task.id, this.toA2ATask(task));
      }

      // ── Agent-to-agent messaging (#15) ──────────────────────
      case 'message/relay': {
        const p = (params ?? {}) as Record<string, unknown>;
        const from = typeof p.from === 'string' ? p.from : undefined;
        const to = typeof p.to === 'string' ? p.to : undefined;
        const msg = p.message as Record<string, unknown> | undefined;

        if (!from || !to) {
          return Response.json(
            { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing from or to field' } },
            { status: 400 },
          );
        }
        if (!this.agents.has(to)) {
          return Response.json(
            { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown target agent: ${to}`, data: { type: 'AgentNotFoundError' } } },
            { status: 404 },
          );
        }

        // Extract text from message parts or use raw string
        let text = '';
        if (msg && Array.isArray(msg.parts)) {
          const textPart = (msg.parts as Array<Record<string, unknown>>).find(
            (p) => p.kind === 'text' || p.type === 'text',
          );
          text = (textPart && typeof textPart.text === 'string') ? textPart.text : JSON.stringify(msg.parts);
        } else if (typeof p.text === 'string') {
          text = p.text;
        }

        const relayed: RelayedMessage = {
          id: crypto.randomUUID(),
          from,
          to,
          text,
          contextId: typeof p.contextId === 'string' ? p.contextId : undefined,
          timestamp: new Date().toISOString(),
          metadata: typeof msg?.metadata === 'object' ? msg.metadata as Record<string, unknown> : undefined,
        };

        // Deliver to inbox
        let inbox = this.agentInboxes.get(to);
        if (!inbox) {
          inbox = [];
          this.agentInboxes.set(to, inbox);
        }
        inbox.push(relayed);
        // Trim inbox if over limit
        if (inbox.length > MAX_INBOX_SIZE) {
          inbox.splice(0, inbox.length - MAX_INBOX_SIZE);
        }

        this.logEvent('message_relayed', relayed.contextId ?? '', `${from}->${to}`, text.slice(0, 100));
        this.emit('message:relayed', { from, to, messageId: relayed.id, contextId: relayed.contextId });

        return Response.json({ jsonrpc: '2.0', id, result: { ok: true, message: relayed } });
      }

      case 'messages/poll': {
        const p = (params ?? {}) as Record<string, unknown>;
        const agent = typeof p.agent === 'string' ? p.agent : undefined;
        if (!agent) {
          return Response.json(
            { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing agent field' } },
            { status: 400 },
          );
        }

        const inbox = this.agentInboxes.get(agent) ?? [];
        const since = typeof p.since === 'string' ? p.since : undefined;

        let messages = inbox;
        if (since) {
          messages = inbox.filter(m => m.timestamp > since);
        }

        return Response.json({
          jsonrpc: '2.0',
          id,
          result: { messages, count: messages.length },
        });
      }

      default:
        return Response.json(
          { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } },
          { status: 400 },
        );
    }
  }

  /**
   * Extract and validate a task from JSON-RPC params.
   * Returns a BridgeTask on success, or a Response on validation error.
   */
  private createTaskFromRpc(rpcId: unknown, params: unknown): BridgeTask | Response {
    const p = (params ?? {}) as Record<string, unknown>;
    const message = p.message as Record<string, unknown> | undefined;
    const taskId = (typeof p.id === 'string' ? p.id : null) ?? crypto.randomUUID();

    if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
      return Response.json(
        { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'Missing or invalid message.parts in params' } },
        { status: 400 },
      );
    }

    // Payload size limits
    if (message.parts.length > MAX_PARTS) {
      return Response.json(
        { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: `Too many parts (max ${MAX_PARTS})` } },
        { status: 400 },
      );
    }

    if (this.tasks.size >= MAX_TASKS) {
      return Response.json(
        { jsonrpc: '2.0', id: rpcId, error: { code: -32603, message: 'Task limit reached' } },
        { status: 429 },
      );
    }

    const parts = message.parts as Array<Record<string, unknown>>;
    const textPart = parts.find((p) => p.type === 'text' || p.kind === 'text');
    let text = (textPart && typeof textPart.text === 'string')
      ? textPart.text
      : JSON.stringify(parts);

    // Truncate excessively long messages
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH);
    }

    const assignedTo =
      (p.metadata as Record<string, unknown>)?.assignedTo as string ??
      (message.metadata as Record<string, unknown>)?.assignedTo as string ??
      (this.agents.size > 0 ? this.agents.keys().next().value : undefined);

    const now = new Date().toISOString();
    const task: BridgeTask = {
      id: taskId,
      contextId: (typeof (p as any).contextId === 'string' ? (p as any).contextId : null) ?? taskId,
      assignedTo: (assignedTo as string) ?? 'unassigned',
      status: 'submitted',
      message: text,
      history: [{ role: 'user', text, timestamp: now, metadata: message.metadata as Record<string, unknown> | undefined }],
      metadata: {
        ...((typeof message.metadata === 'object' && message.metadata !== null ? message.metadata : {}) as Record<string, unknown>),
        ...((typeof p.metadata === 'object' && p.metadata !== null ? p.metadata : {}) as Record<string, unknown>),
      },
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
    this.logEvent('task_created', task.id, task.assignedTo, task.message);
    this.emit('task:created', { taskId: task.id, assignedTo: task.assignedTo });

    return task;
  }
}
