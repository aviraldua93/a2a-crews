/**
 * Agent card helpers for A2A discovery protocol.
 * Uses official @a2a-js/sdk types (A2A spec v0.3.0).
 */
import type { AgentCard, AgentSkill } from '@a2a-js/sdk';

export type { AgentCard, AgentSkill };

/** Convenience alias for backward compatibility. */
export type AgentCardSkill = AgentSkill;

/**
 * Create a spec-compliant AgentCard.
 *
 * The returned card declares a JSON-RPC interface (the primary A2A transport)
 * and advertises text as both input and output mode.
 */
export function createAgentCard(
  name: string,
  description: string,
  skills: AgentSkill[],
  url: string,
): AgentCard {
  // Ensure all skills have required 'tags' field
  const normalizedSkills = skills.map(s => ({
    ...s,
    tags: s.tags ?? [s.id],
  }));

  return {
    name,
    description,
    url,
    version: '0.2.0',
    protocolVersion: '0.3.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    additionalInterfaces: [
      { url, transport: 'JSONRPC' },
    ],
    skills: normalizedSkills,
  };
}
