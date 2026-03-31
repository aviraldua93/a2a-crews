import { describe, expect, it } from 'bun:test';
import { generateAgentPrompt } from '../src/spawner/prompt';
import { Agent } from '../src/crew/agent';
import { Task } from '../src/crew/task';

describe('review feedback loop', () => {
  it('reviewer prompt includes feedback loop instructions', () => {
    const agent = new Agent({ key: 'reviewer', name: 'Reviewer', description: 'Reviews', skills: ['review'] });
    const tasks = [new Task({ id: 'review', title: 'Review code', assignedTo: 'reviewer' })];
    const prompt = generateAgentPrompt({ agent, tasks, scenario: 'Test', bridgeUrl: 'http://localhost:8222', projectDir: '/tmp' });
    expect(prompt).toContain('REVIEW FEEDBACK LOOP');
    expect(prompt).toContain('fix-');
    expect(prompt).toContain('BLOCKING');
  });

  it('non-reviewer prompt does not include feedback loop', () => {
    const agent = new Agent({ key: 'coder', name: 'Coder', description: 'Codes', skills: ['code'] });
    const tasks = [new Task({ id: 'impl', title: 'Implement', assignedTo: 'coder' })];
    const prompt = generateAgentPrompt({ agent, tasks, scenario: 'Test', bridgeUrl: 'http://localhost:8222', projectDir: '/tmp' });
    expect(prompt).not.toContain('REVIEW FEEDBACK LOOP');
  });
});
