import type { Task } from './task';

export function computeWaves(tasks: Task[]): Task[][] {
  const waves: Task[][] = [];
  const completed = new Set<string>();
  const remaining = [...tasks];

  while (remaining.length > 0) {
    const wave = remaining.filter(t => !t.isBlocked(completed));
    if (wave.length === 0) {
      throw new Error(`Deadlock: ${remaining.map(t => t.id).join(', ')} cannot be scheduled`);
    }
    waves.push(wave);
    for (const t of wave) {
      completed.add(t.id);
      remaining.splice(remaining.indexOf(t), 1);
    }
  }

  return waves;
}
