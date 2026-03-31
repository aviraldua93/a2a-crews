import type { Agent } from './agent';
import type { Task } from './task';

export type ProcessType = 'sequential' | 'wave';

export interface CrewConfig {
  name: string;
  scenario: string;
  process?: ProcessType;
  agents: Agent[];
  tasks: Task[];
}

export class Crew {
  name: string;
  scenario: string;
  process: ProcessType;
  agents: Agent[];
  tasks: Task[];

  constructor(config: CrewConfig) {
    this.name = config.name;
    this.scenario = config.scenario;
    this.process = config.process ?? 'wave';
    this.agents = config.agents;
    this.tasks = config.tasks;
  }

  async kickoff(): Promise<CrewOutput> {
    // TODO: implement orchestration
    throw new Error('Not implemented');
  }
}

export interface CrewOutput {
  tasks: TaskOutput[];
  totalTime: number;
  waves: number;
}

export interface TaskOutput {
  taskId: string;
  status: 'completed' | 'failed' | 'canceled';
  output?: string;
  duration: number;
}
