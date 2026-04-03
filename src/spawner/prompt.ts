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
${ctx.agent.key.includes('review') ? `
REVIEW FEEDBACK LOOP:
If you find blocking or medium-severity issues:
1. Write your review findings to your deliverable (as normal)
2. For each BLOCKING issue, create a fix task file at artifacts/fix-{N}.json:
   {"id": "fix-1", "title": "Fix: description of issue", "assignedTo": "coder", "severity": "blocking"}
3. The orchestrator will detect these fix files and run another wave
4. LOW severity: mention in review only, don't create fix tasks
5. If everything is clean: just write your review, no fix files needed
` : ''}
2. Execute your tasks in dependency order.
3. For each task:
   - Check if dependencies are completed (look for their deliverable files in artifacts/)
   - If blocked, wait and check again in 30 seconds
   - When ready, do the work thoroughly. Spawn sub-agents for exploration.
   - Write your deliverable to artifacts/${ctx.tasks[0]?.id ?? 'output'}.md

4. CRITICAL — After completing EACH task, report to the bridge:
   Run this PowerShell command (or equivalent curl):
   
   Invoke-RestMethod -Uri '${ctx.bridgeUrl}/tasks/{TASK_ID}' -Method PATCH -ContentType 'application/json' -Body '{"status":"completed","result":"Task completed successfully"}'
   
   Or use the A2A JSON-RPC endpoint:
   Invoke-RestMethod -Uri '${ctx.bridgeUrl}/' -Method POST -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"tasks/send","params":{"message":{"kind":"message","messageId":"done","role":"agent","parts":[{"kind":"text","text":"completed"}]}}}'
   
   Replace {TASK_ID} with the actual task ID from YOUR TASKS above.
   The task IDs are: ${ctx.tasks.map(t => t.id).join(', ')}

5. Be thorough. Tokens are not a concern. Quality is.
6. When all tasks are complete, exit.

PORT COORDINATION:
If your task involves starting a server or service:
- Do NOT use common ports (3000, 8080, 8000, 5000) — they may be in use
- Use a random high port (49152-65535) or check if your chosen port is available first
- If a port is taken, pick another one automatically — don't fail

CONTEXT CHECKPOINTS:
If you are running low on context or have been working for a long time:
1. Write a checkpoint file to artifacts/checkpoints/{your-role}-checkpoint.json
2. Include: completed work, remaining work, key decisions, files modified
3. A fresh session can resume from your checkpoint

DELIVERABLE FORMAT:
Every deliverable must include:
  - Summary (1-2 sentences)
  - Details / Files Changed
  - Acceptance Criteria Status (☑/☐ for each)

IMPORTANT: Begin by exploring the codebase. Then execute your tasks. ALWAYS report completion to the bridge after each task.`;
}
