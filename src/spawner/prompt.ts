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
BRIDGE: ${ctx.bridgeUrl}

YOUR TASKS:
${taskList}

YOUR ALLOWED TOOLS:
${toolsList}

INSTRUCTIONS:
1. ${ctx.agent.key.includes('review') ? 'Read the artifacts from prior tasks in artifacts/ to understand what was built. Focus on changed files, not the entire codebase.' : 'Read the project to understand the codebase.'}
2. Execute your tasks in dependency order.
3. For each task:
   - Check if dependencies are completed (look for their deliverable files in artifacts/)
   - If blocked, wait and check again in 30 seconds
   - When ready, do the work thoroughly. Spawn sub-agents for exploration.
   - Write your deliverable to artifacts/${ctx.tasks[0]?.id ?? 'output'}.md

4. CRITICAL — After completing EACH task, report to the bridge:
   Run this PowerShell command (or equivalent curl):
   
   Invoke-RestMethod -Uri '${ctx.bridgeUrl}/tasks/{TASK_ID}' -Method PATCH -ContentType 'application/json' -Body '{"status":"completed","result":"Task completed successfully"}'
   
   Replace {TASK_ID} with the actual task ID from YOUR TASKS above.
   The task IDs are: ${ctx.tasks.map(t => t.id).join(', ')}

5. Be thorough. Tokens are not a concern. Quality is.
6. When all tasks are complete, exit.

DELIVERABLE FORMAT:
Every deliverable must include:
  - Summary (1-2 sentences)
  - Details / Files Changed
  - Acceptance Criteria Status (☑/☐ for each)

IMPORTANT: Begin by exploring the codebase. Then execute your tasks. ALWAYS report completion to the bridge after each task.`;
}
