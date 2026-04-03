/**
 * A2A Client wrapper — uses the official @a2a-js/sdk ClientFactory
 * for spec-compliant agent-to-bridge communication.
 */
import { ClientFactory } from '@a2a-js/sdk/client';
import type { Message, MessageSendParams } from '@a2a-js/sdk';

/**
 * Create a properly-formatted A2A user message.
 */
export function createUserMessage(text: string, metadata?: Record<string, unknown>): Message {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text }],
    metadata,
  };
}

/**
 * Create MessageSendParams for sending a task via the A2A client.
 */
export function createSendParams(
  text: string,
  assignedTo?: string,
  taskId?: string,
): MessageSendParams {
  return {
    message: createUserMessage(text, assignedTo ? { assignedTo } : undefined),
    ...(taskId ? { id: taskId } : {}),
  } as MessageSendParams;
}

/**
 * Create an A2A client connected to a bridge URL.
 * Uses the SDK's ClientFactory for automatic agent card discovery.
 */
export async function createA2AClient(bridgeUrl: string) {
  const factory = new ClientFactory();
  return factory.createFromUrl(bridgeUrl);
}
