import { describe, expect, it } from 'bun:test';
import { composeFromTemplate, composeFromPlan, findBestTemplate } from '../src/planner/composer';
import { isPlanApproved, planSummary, type Plan } from '../src/planner/plan';

describe('composeFromTemplate', () => {
  it('creates agents and tasks from feature template', () => {
    const { agents, tasks } = composeFromTemplate('feature', 'Build a calculator');
    expect(agents.length).toBe(3);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(agents.map(a => a.key)).toContain('architect');
    expect(agents.map(a => a.key)).toContain('coder');
  });

  it('creates agents from fullstack template with parallel tasks', () => {
    const { agents, tasks } = composeFromTemplate('fullstack', 'Build a dashboard');
    expect(agents.length).toBe(4);
    const backendTask = tasks.find(t => t.assignedTo === 'backend');
    const frontendTask = tasks.find(t => t.assignedTo === 'frontend');
    expect(backendTask).toBeDefined();
    expect(frontendTask).toBeDefined();
  });

  it('works for all 13 templates', () => {
    const templates = ['feature', 'bugfix', 'refactor', 'fullstack', 'research', 'audit',
      'data-science', 'ml-experiment', 'data-pipeline', 'sprint', 'ship', 'harness', 'doc-review'];
    for (const name of templates) {
      const { agents, tasks } = composeFromTemplate(name, 'Test');
      expect(agents.length).toBeGreaterThan(0);
      expect(tasks.length).toBeGreaterThan(0);
    }
  });
});

describe('findBestTemplate', () => {
  it('matches feature scenarios', () => {
    expect(findBestTemplate('Build a login page')).toBe('feature');
  });
  it('matches bugfix scenarios', () => {
    expect(findBestTemplate('Fix the crash in auth module')).toBe('bugfix');
  });
  it('matches data science scenarios', () => {
    expect(findBestTemplate('Train a model on the iris dataset')).toBe('data-science');
  });
  it('matches audit scenarios', () => {
    expect(findBestTemplate('Security audit of the API')).toBe('audit');
  });
  it('returns null for unrecognized scenarios', () => {
    expect(findBestTemplate('xyzzy')).toBeNull();
  });
});

describe('isPlanApproved', () => {
  const makePlan = (verdict: 'go' | 'risky' | 'no-go'): Plan => ({
    scenario: 'test',
    feasibility: { verdict, confidence: 0.8, concerns: [], recommendation: '' },
    rationale: '',
    roles: [],
    tasks: [],
  });

  it('approves go', () => expect(isPlanApproved(makePlan('go'))).toBe(true));
  it('approves risky', () => expect(isPlanApproved(makePlan('risky'))).toBe(true));
  it('rejects no-go', () => expect(isPlanApproved(makePlan('no-go'))).toBe(false));
});

describe('planSummary', () => {
  it('formats summary correctly', () => {
    const plan: Plan = {
      scenario: 'test',
      feasibility: { verdict: 'go', confidence: 0.92, concerns: [], recommendation: '' },
      rationale: '',
      roles: [{ key: 'a', description: '', skills: [], why: '' }, { key: 'b', description: '', skills: [], why: '' }],
      tasks: [{ id: '1', title: '', assignedTo: 'a', dependsOn: [], acceptanceCriteria: [] }],
    };
    const summary = planSummary(plan);
    expect(summary).toContain('GO');
    expect(summary).toContain('92%');
    expect(summary).toContain('2 roles');
    expect(summary).toContain('1 tasks');
  });
});
