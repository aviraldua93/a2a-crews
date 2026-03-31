import type { Agent } from '../crew/agent';
import type { Task } from '../crew/task';

export interface PromptContext {
  agent: Agent;
  tasks: Task[];
  scenario: string;
  bridgeUrl: string;
  projectDir: string;
}

export function generateAgentPrompt(ctx: PromptContext): string {
  const taskList = ctx.tasks
    .map(t => {
      const deps = t.dependsOn.length > 0 ? ` (depends on: ${t.dependsOn.join(', ')})` : '';
      const criteria = t.acceptanceCriteria.length > 0
        ? '\n    Acceptance criteria:\n' + t.acceptanceCriteria.map(c => `      - ${c}`).join('\n')
        : '';
      return `  - ${t.id}: ${t.title}${deps}${criteria}`;
    })
    .join('\n');

  const toolsList = ctx.agent.allowedTools.map(t => `  - ${t}`).join('\n');

  return `You are the ${ctx.agent.name} on an A2A-coordinated team.

PROJECT: ${ctx.projectDir}
SCENARIO: ${ctx.scenario}
YOUR ROLE: ${ctx.agent.description}

YOUR TASKS:
${taskList}

YOUR ALLOWED TOOLS:
${toolsList}

INSTRUCTIONS:
1. Read the project to understand the codebase.
2. Execute your tasks in dependency order.
3. For each task:
   - Check if dependencies are completed (look for their deliverable files in artifacts/)
   - If blocked, wait and check again in 30 seconds
   - When ready, do the work thoroughly. Spawn sub-agents for exploration.
   - Write your deliverable to artifacts/${ctx.tasks[0]?.id ?? 'output'}.md
   - Mark task status as done
4. Be thorough. Tokens are not a concern. Quality is.
5. When all tasks are complete, exit.

DELIVERABLE FORMAT:
Every deliverable must include:
  - Summary (1-2 sentences)
  - Details / Files Changed
  - Acceptance Criteria Status (☑/☐ for each)

IMPORTANT: Begin by exploring the codebase. Then execute your tasks.`;
}
