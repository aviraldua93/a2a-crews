export interface Checkpoint {
  role: string;
  checkpointNumber: number;
  timestamp: string;
  currentTask: string;
  taskStatus: 'partial' | 'complete';
  completedWork: string[];
  remainingWork: string[];
  keyDecisions: string[];
  filesModified: string[];
  notes: string;
}

export function createCheckpoint(data: Partial<Checkpoint> & { role: string; currentTask: string }): Checkpoint {
  return {
    role: data.role,
    checkpointNumber: data.checkpointNumber ?? 1,
    timestamp: new Date().toISOString(),
    currentTask: data.currentTask,
    taskStatus: data.taskStatus ?? 'partial',
    completedWork: data.completedWork ?? [],
    remainingWork: data.remainingWork ?? [],
    keyDecisions: data.keyDecisions ?? [],
    filesModified: data.filesModified ?? [],
    notes: data.notes ?? '',
  };
}

export function checkpointToString(cp: Checkpoint): string {
  return JSON.stringify(cp, null, 2);
}
