import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnTab, detectPlatform } from '../spawner/terminal';
import type { Plan } from './plan';

const PLANNER_PROMPT = (scenario: string, projectDir: string, planOutputPath: string) => `You are an AI Team Planner for a2a-crews.

PROJECT DIRECTORY: ${projectDir}
SCENARIO: ${scenario}

YOUR JOB:
1. Explore this project — read file tree, package.json/pyproject.toml, README, and key source files
2. Understand what kind of task this is (ML? API? frontend? data pipeline? infra? docs?)
3. Design a custom team with roles tailored to THIS specific task
4. Assess feasibility — what could go wrong? What's missing?
5. Write your plan to: ${planOutputPath}

OUTPUT FORMAT (JSON):
{
  "scenario": "${scenario}",
  "feasibility": {
    "verdict": "go|risky|no-go",
    "confidence": 0.0-1.0,
    "concerns": ["specific concern 1", "specific concern 2"],
    "recommendation": "what to do"
  },
  "rationale": "1-2 sentences on why this team structure fits THIS project",
  "roles": [
    {
      "key": "role-key",
      "description": "what this role does for THIS specific task",
      "model": null,
      "skills": ["skill1", "skill2"],
      "why": "why this role is needed"
    }
  ],
  "tasks": [
    {
      "id": "task-id",
      "title": "specific task title",
      "assignedTo": "role-key",
      "dependsOn": [],
      "acceptanceCriteria": [
        "Specific verifiable criterion 1",
        "Specific verifiable criterion 2"
      ]
    }
  ]
}

RULES:
- Max 5 roles. If you need more, the task should be split.
- Max 3 tasks per role.
- Every task MUST have 2-5 acceptance criteria that are specific and verifiable.
- Roles must be specific to the task — NOT generic "architect/coder/reviewer".
  For ML: use data-engineer, modeler, evaluator
  For API: use api-designer, backend-dev, tester
  For frontend: use ux-designer, frontend-dev, qa
  For data: use data-engineer, pipeline-builder, validator
- Feasibility must consider: does the project have the right dependencies? Is there training data? Are there existing patterns to follow?
- Write ONLY the JSON file. Do not modify any project files.
- After writing, stop.`;

export async function runAIPlanner(scenario: string, projectDir: string): Promise<boolean> {
  const planDir = join(projectDir, '.a2a-crews');
  if (!existsSync(planDir)) mkdirSync(planDir, { recursive: true });

  const sep = detectPlatform() === 'windows' ? '\\' : '/';
  const planOutputPath = join(planDir, 'plan.json').replace(/\//g, sep);
  const promptFile = join(planDir, '.planner-prompt.txt').replace(/\//g, sep);
  const prompt = PLANNER_PROMPT(scenario, projectDir, planOutputPath);

  await Bun.write(promptFile, prompt);

  const platform = detectPlatform();
  let command: string;
  if (platform === 'windows') {
    command = `$p = Get-Content '${promptFile}' -Raw; copilot -p $p --yolo`;
  } else {
    command = `copilot -p "$(cat '${promptFile}')" --yolo`;
  }

  console.log('  🤖 Spawning AI planner...');
  console.log('     The planner will explore your project and write a custom plan.');
  console.log('');

  await spawnTab({
    title: 'Planner (a2a-crews)',
    command,
    cwd: projectDir,
  });

  // Poll for plan.json to appear
  console.log('  ⏳ Waiting for planner to finish...');
  const startTime = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 5000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (existsSync(join(planDir, 'plan.json'))) {
      // Verify it's valid JSON
      try {
        const content = await Bun.file(join(planDir, 'plan.json')).text();
        JSON.parse(content);
        console.log(`  ✅ AI planner completed (${elapsed}s)`);
        return true;
      } catch {
        // File exists but not valid JSON yet — still writing
      }
    }

    if (elapsed % 30 === 0) {
      console.log(`  ⏳ Still planning... (${elapsed}s)`);
    }
  }

  console.log('  ⚠️  Planner timed out after 5 minutes');
  return false;
}

export function isAIPlannerAvailable(): boolean {
  try {
    const { execSync } = require('child_process');
    execSync('copilot --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
