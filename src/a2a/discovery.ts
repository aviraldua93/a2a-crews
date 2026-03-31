/**
 * Agent card helpers for A2A discovery protocol.
 * Source: A2A spec section 7 (Agent Card)
 */

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: AgentCardSkill[];
}

export function createAgentCard(
  name: string,
  description: string,
  skills: AgentCardSkill[],
  url: string,
): AgentCard {
  return {
    name,
    description,
    url,
    version: '0.1.0',
    protocolVersion: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    skills,
  };
}
