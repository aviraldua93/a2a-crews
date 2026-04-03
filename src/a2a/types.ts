/**
 * A2A SDK type re-exports and bridge-specific extensions.
 *
 * All protocol types come from the official @a2a-js/sdk.
 * Bridge-specific types extend them for orchestration needs.
 */

// ─── Core protocol types (from @a2a-js/sdk) ─────────────────────────
export type {
  AgentCard,
  AgentSkill,
  AgentCapabilities,
  AgentInterface,
  AgentProvider,
  AgentExtension,
  Message,
  Part,
  TextPart,
  FilePart,
  DataPart,
  Artifact,
  Task,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  MessageSendParams,
  SendMessageRequest,
  TaskIdParams,
  TaskQueryParams,
  SecurityScheme,
  TransportProtocol,
} from '@a2a-js/sdk';

export { AGENT_CARD_PATH } from '@a2a-js/sdk';

// ─── Client components (runtime-safe on Bun) ────────────────────────
export { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk/client';

// ─── Bridge-specific types ──────────────────────────────────────────

/** Agent registered on the bridge with heartbeat tracking. */
export interface RegisteredAgent {
  name: string;
  description: string;
  skills: string[];
  endpoint?: string;
  status: 'online' | 'idle' | 'busy' | 'offline';
  lastHeartbeat: string;
  registeredAt: string;
}

/** Internal bridge task status — maps to A2A TaskState. */
export type BridgeTaskStatus =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Maps BridgeTaskStatus to official A2A TaskState string. */
export function toA2ATaskState(status: BridgeTaskStatus): string {
  return status; // A2A spec uses identical string values
}
