import { describe, expect, it } from 'bun:test';
import { detectPlatform, type Platform } from '../src/spawner/terminal';
import { generateAgentPrompt } from '../src/spawner/prompt';
import { Agent } from '../src/crew/agent';
import { Task } from '../src/crew/task';

describe('detectPlatform', () => {
  it('returns a valid platform', () => {
    const p = detectPlatform();
    expect(['windows', 'macos', 'linux']).toContain(p);
  });
});

describe('generateAgentPrompt', () => {
  it('generates prompt with role and tasks', () => {
    const agent = new Agent({
      key: 'architect',
      name: 'Architect',
      description: 'Designs the spec',
      skills: ['design'],
    });
    const tasks = [
      new Task({ id: 'design', title: 'Design the architecture', assignedTo: 'architect' }),
    ];
    const prompt = generateAgentPrompt({
      agent,
      tasks,
      scenario: 'Build a calculator',
      bridgeUrl: 'http://localhost:8222',
      projectDir: '/tmp/test',
    });

    expect(prompt).toContain('Architect');
    expect(prompt).toContain('Build a calculator');
    expect(prompt).toContain('design');
    expect(prompt).toContain('Designs the spec');
    expect(prompt).toContain('/tmp/test');
  });

  it('includes acceptance criteria in prompt', () => {
    const agent = new Agent({ key: 'coder', name: 'Coder', description: 'Codes', skills: ['code'] });
    const tasks = [
      new Task({
        id: 'impl',
        title: 'Implement',
        assignedTo: 'coder',
        acceptanceCriteria: ['Tests pass', 'No lint errors'],
      }),
    ];
    const prompt = generateAgentPrompt({
      agent,
      tasks,
      scenario: 'Test',
      bridgeUrl: 'http://localhost:8222',
      projectDir: '/tmp',
    });

    expect(prompt).toContain('Tests pass');
    expect(prompt).toContain('No lint errors');
  });

  it('shows dependencies in task list', () => {
    const agent = new Agent({ key: 'coder', name: 'Coder', description: 'Codes', skills: ['code'] });
    const tasks = [
      new Task({ id: 'impl', title: 'Implement', assignedTo: 'coder', dependsOn: ['design'] }),
    ];
    const prompt = generateAgentPrompt({
      agent,
      tasks,
      scenario: 'Test',
      bridgeUrl: 'http://localhost:8222',
      projectDir: '/tmp',
    });

    expect(prompt).toContain('depends on: design');
  });
});
