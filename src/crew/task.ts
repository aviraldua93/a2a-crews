export type TaskStatus = 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed' | 'canceled';

export interface TaskConfig {
  id: string;
  title: string;
  assignedTo: string;
  dependsOn?: string[];
  acceptanceCriteria?: string[];
  deliverable?: string;
}

export class Task {
  id: string;
  title: string;
  assignedTo: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  deliverable: string;
  status: TaskStatus;

  constructor(config: TaskConfig) {
    this.id = config.id;
    this.title = config.title;
    this.assignedTo = config.assignedTo;
    this.dependsOn = config.dependsOn ?? [];
    this.acceptanceCriteria = config.acceptanceCriteria ?? [];
    this.deliverable = config.deliverable ?? `artifacts/${config.id}.md`;
    this.status = this.dependsOn.length > 0 ? 'blocked' : 'pending';
  }

  isBlocked(completedTaskIds: Set<string>): boolean {
    return this.dependsOn.some(dep => !completedTaskIds.has(dep));
  }

  canStart(completedTaskIds: Set<string>): boolean {
    return this.status === 'pending' ||
           (this.status === 'blocked' && !this.isBlocked(completedTaskIds));
  }
}
