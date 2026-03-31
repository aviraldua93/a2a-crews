import { loadPreset, listPresets, type Preset } from '../templates';
import { Agent, type AgentConfig } from '../crew/agent';
import { Task, type TaskConfig } from '../crew/task';
import type { Plan, PlannedRole, PlannedTask } from './plan';

export function composeFromTemplate(templateName: string, scenario: string): {
  agents: Agent[];
  tasks: Task[];
} {
  const preset = loadPreset(templateName);

  const agents = preset.roles.map(r => new Agent({
    key: r.key,
    name: r.key.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
    description: r.description,
    skills: [r.key], // Default skill = role key
    model: r.model ?? undefined,
    allowedTools: r.allowed_tools,
  }));

  const tasks = preset.tasks.map(t => new Task({
    id: t.id,
    title: t.title,
    assignedTo: t.assigned_to,
    dependsOn: t.depends_on,
  }));

  return { agents, tasks };
}

export function composeFromPlan(plan: Plan): {
  agents: Agent[];
  tasks: Task[];
} {
  const agents = plan.roles.map(r => new Agent({
    key: r.key,
    name: r.key.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
    description: r.description,
    skills: r.skills,
    model: r.model ?? undefined,
  }));

  const tasks = plan.tasks.map(t => new Task({
    id: t.id,
    title: t.title,
    assignedTo: t.assignedTo,
    dependsOn: t.dependsOn,
    acceptanceCriteria: t.acceptanceCriteria,
  }));

  return { agents, tasks };
}

export function findBestTemplate(scenario: string): string | null {
  // Simple keyword matching for template suggestion
  const lower = scenario.toLowerCase();
  const keywords: Record<string, string[]> = {
    'feature': ['feature', 'build', 'implement', 'create', 'add'],
    'bugfix': ['bug', 'fix', 'error', 'crash', 'broken', 'issue'],
    'refactor': ['refactor', 'restructure', 'reorganize', 'clean up', 'migrate'],
    'fullstack': ['fullstack', 'full-stack', 'frontend', 'backend', 'api + ui'],
    'research': ['research', 'investigate', 'explore', 'compare', 'evaluate'],
    'audit': ['audit', 'review', 'security', 'performance', 'quality'],
    'data-science': ['data', 'model', 'train', 'predict', 'dataset', 'ml', 'machine learning'],
    'sprint': ['sprint', 'milestone', 'iteration', 'user story'],
    'ship': ['ship', 'release', 'deploy', 'version', 'launch'],
    'harness': ['iterate', 'refine', 'improve', 'loop', 'evaluate'],
    'doc-review': ['documentation', 'docs', 'readme', 'guide'],
  };

  let bestMatch = '';
  let bestScore = 0;

  for (const [template, words] of Object.entries(keywords)) {
    const score = words.filter(w => lower.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}
