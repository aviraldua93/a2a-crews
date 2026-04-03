/**
 * Bridge AgentExecutor — routes incoming A2A messages to registered crew agents.
 *
 * Implements the @a2a-js/sdk AgentExecutor interface so the bridge can be
 * driven by the SDK's DefaultRequestHandler and Express middleware.
 */
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import type { Task, TaskStatusUpdateEvent, Message } from '@a2a-js/sdk';
import type { RegisteredAgent } from './types';

/**
 * The BridgeExecutor receives messages from A2A clients (via message/send),
 * creates a task on the bridge, and publishes status events as the task progresses.
 *
 * It holds a reference to the mutable agent registry and a callback so the
 * bridge's orchestration layer can be notified when new tasks arrive.
 */
export class BridgeExecutor implements AgentExecutor {
  private agents: Map<string, RegisteredAgent>;
  private onTaskCreated?: (taskId: string, contextId: string, assignedTo: string, text: string) => void;
  private cancelledTasks = new Set<string>();

  constructor(
    agents: Map<string, RegisteredAgent>,
    onTaskCreated?: (taskId: string, contextId: string, assignedTo: string, text: string) => void,
  ) {
    this.agents = agents;
    this.onTaskCreated = onTaskCreated;
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

    // Extract text from message parts
    const textParts = userMessage.parts.filter((p): p is { kind: 'text'; text: string } & Record<string, unknown> => p.kind === 'text');
    const text = textParts.map(p => p.text).join('\n') || 'No message content';

    // Determine which agent to route to from metadata
    const assignedTo =
      (userMessage.metadata?.assignedTo as string) ??
      (this.agents.size > 0 ? this.agents.keys().next().value : 'unassigned');

    // Publish initial task if it doesn't exist yet
    if (!task) {
      const initialTask: Task = {
        kind: 'task',
        id: taskId,
        contextId,
        status: {
          state: 'submitted',
          timestamp: new Date().toISOString(),
        },
        history: [userMessage],
      };
      eventBus.publish(initialTask);
    }

    // Notify the orchestration layer
    this.onTaskCreated?.(taskId, contextId, assignedTo as string, text);

    // Mark as working
    const workingUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    };
    eventBus.publish(workingUpdate);

    // The task will be completed asynchronously by the orchestration layer
    // calling completeTask() on the bridge. For now, signal finished so the
    // request handler doesn't block forever.
    eventBus.finished();
  }

  async cancelTask(
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    this.cancelledTasks.add(taskId);

    const update: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId: taskId, // contextId defaults to taskId
      status: { state: 'canceled', timestamp: new Date().toISOString() },
      final: true,
    };
    eventBus.publish(update);
    eventBus.finished();
  }
}
