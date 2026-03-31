import { describe, expect, it } from 'bun:test';
import { Task, computeWaves, Agent, Crew } from '../src/crew';

describe('Task', () => {
  it('creates pending task with no deps', () => {
    const task = new Task({ id: 'design', title: 'Design spec', assignedTo: 'architect' });
    expect(task.status).toBe('pending');
  });

  it('creates blocked task with deps', () => {
    const task = new Task({ id: 'implement', title: 'Build it', assignedTo: 'coder', dependsOn: ['design'] });
    expect(task.status).toBe('blocked');
  });

  it('can start when deps are met', () => {
    const task = new Task({ id: 'implement', title: 'Build it', assignedTo: 'coder', dependsOn: ['design'] });
    expect(task.canStart(new Set(['design']))).toBe(true);
  });

  it('cannot start when deps are not met', () => {
    const task = new Task({ id: 'implement', title: 'Build it', assignedTo: 'coder', dependsOn: ['design'] });
    expect(task.canStart(new Set())).toBe(false);
  });
});

describe('computeWaves', () => {
  it('computes waves for feature template', () => {
    const tasks = [
      new Task({ id: 'design', title: 'Design', assignedTo: 'architect' }),
      new Task({ id: 'implement', title: 'Implement', assignedTo: 'coder', dependsOn: ['design'] }),
      new Task({ id: 'review', title: 'Review', assignedTo: 'reviewer', dependsOn: ['implement'] }),
    ];
    const waves = computeWaves(tasks);
    expect(waves.length).toBe(3);
    expect(waves[0].map(t => t.id)).toEqual(['design']);
    expect(waves[1].map(t => t.id)).toEqual(['implement']);
    expect(waves[2].map(t => t.id)).toEqual(['review']);
  });

  it('handles parallel tasks', () => {
    const tasks = [
      new Task({ id: 'design', title: 'Design', assignedTo: 'architect' }),
      new Task({ id: 'backend', title: 'Backend', assignedTo: 'backend', dependsOn: ['design'] }),
      new Task({ id: 'frontend', title: 'Frontend', assignedTo: 'frontend', dependsOn: ['design'] }),
      new Task({ id: 'review', title: 'Review', assignedTo: 'reviewer', dependsOn: ['backend', 'frontend'] }),
    ];
    const waves = computeWaves(tasks);
    expect(waves.length).toBe(3);
    expect(waves[0].map(t => t.id)).toEqual(['design']);
    expect(waves[1].map(t => t.id).sort()).toEqual(['backend', 'frontend']);
    expect(waves[2].map(t => t.id)).toEqual(['review']);
  });

  it('detects deadlock', () => {
    const tasks = [
      new Task({ id: 'a', title: 'A', assignedTo: 'x', dependsOn: ['b'] }),
      new Task({ id: 'b', title: 'B', assignedTo: 'y', dependsOn: ['a'] }),
    ];
    expect(() => computeWaves(tasks)).toThrow('Deadlock');
  });
});

describe('Agent', () => {
  it('creates agent with defaults', () => {
    const agent = new Agent({ key: 'coder', name: 'Coder', description: 'Writes code', skills: ['typescript'] });
    expect(agent.allowedTools.length).toBeGreaterThan(0);
  });

  it('generates agent card', () => {
    const agent = new Agent({ key: 'arch', name: 'Architect', description: 'Designs', skills: ['design', 'analysis'] });
    const card = agent.toAgentCard();
    expect(card.skills.length).toBe(2);
  });
});
