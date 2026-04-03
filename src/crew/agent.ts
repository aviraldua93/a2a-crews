import type { AgentCard, AgentSkill } from '@a2a-js/sdk';

export interface AgentConfig {
  key: string;
  name: string;
  description: string;
  skills: string[];
  model?: string;
  allowedTools?: string[];
}

export class Agent {
  key: string;
  name: string;
  description: string;
  skills: string[];
  model?: string;
  allowedTools: string[];

  constructor(config: AgentConfig) {
    this.key = config.key;
    this.name = config.name;
    this.description = config.description;
    this.skills = config.skills;
    this.model = config.model;
    this.allowedTools = config.allowedTools ?? ['view', 'glob', 'grep', 'explore', 'edit', 'create', 'powershell'];
  }

  /** Build a spec-compliant A2A AgentCard for this agent. */
  toAgentCard(url?: string): AgentCard {
    const skills: AgentSkill[] = this.skills.map(s => ({
      id: s,
      name: s,
      description: `Skill: ${s}`,
      tags: [s],
    }));

    return {
      name: this.name,
      description: this.description,
      url: url ?? `http://localhost:8222/agents/${this.key}`,
      version: '0.2.0',
      protocolVersion: '0.3.0',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      additionalInterfaces: [
        { url: url ?? `http://localhost:8222/agents/${this.key}`, transport: 'JSONRPC' },
      ],
      skills,
    };
  }
}
