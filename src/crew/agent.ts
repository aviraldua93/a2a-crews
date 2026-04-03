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

  toAgentCard() {
    return {
      name: this.name,
      description: this.description,
      skills: this.skills.map(s => ({
        id: s,
        name: s,
        description: `Skill: ${s}`,
        tags: [s],
      })),
    };
  }
}
