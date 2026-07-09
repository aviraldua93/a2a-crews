#!/usr/bin/env bun

import { join, resolve } from 'path';
import { mkdirSync, existsSync, writeFileSync, unlinkSync, readdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { composeFromTemplate, composeFromPlan, findBestTemplate, assessFeasibility, runAIPlanner, isAIPlannerAvailable } from '../planner';
import { planSummary, type Plan } from '../planner/plan';
import { Task } from '../crew/task';
import { Agent } from '../crew/agent';
import { computeWaves } from '../crew/process';
import { A2ABridge } from '../a2a/bridge';
import { spawnAgent } from '../spawner/terminal';
import { generateAgentPrompt } from '../spawner/prompt';
import { createWorktree, mergeWorktree, removeWorktree, cleanupAllWorktrees, pruneWorktrees } from '../spawner/worktree';
import { listPresets, loadPreset } from '../templates';
import { printHeader, printRoles, printTasks, printSummary, printGoalStatus } from './display';
import { GoalRunner, GoalStore, validateContract, type GoalContract } from '../goal';

// ── Central bridge registry (#19) ──────────────────────────────────
const REGISTRY_DIR = join(homedir(), '.a2a-crews', 'active-bridges');

function registerBridge(teamName: string, info: { url: string; port: number; pid: number; cwd: string; startedAt: string }): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(join(REGISTRY_DIR, `${teamName}.json`), JSON.stringify(info, null, 2));
}

function unregisterBridge(teamName: string): void {
  const path = join(REGISTRY_DIR, `${teamName}.json`);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* best-effort */ }
  }
}

function cleanupStaleBridges(): void {
  if (!existsSync(REGISTRY_DIR)) return;
  try {
    for (const file of readdirSync(REGISTRY_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const info = JSON.parse(readFileSync(join(REGISTRY_DIR, file), 'utf-8'));
        if (info.pid && !isProcessAlive(info.pid)) {
          unlinkSync(join(REGISTRY_DIR, file));
        }
      } catch {
        // Corrupt file — remove it
        try { unlinkSync(join(REGISTRY_DIR, file)); } catch { /* ignore */ }
      }
    }
  } catch { /* directory read failed */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Parse --project-dir / -d flag before command dispatch ────────────
function parseProjectDir(argv: string[]): { projectDir: string; filteredArgs: string[]; useWorktrees: boolean } {
  const filtered: string[] = [];
  let dir = process.cwd();
  let useWorktrees = false;

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--project-dir' || argv[i] === '-d') && argv[i + 1]) {
      dir = resolve(argv[i + 1]);
      i++; // skip value
    } else if (argv[i] === '--use-worktrees') {
      useWorktrees = true;
    } else {
      filtered.push(argv[i]);
    }
  }

  return { projectDir: dir, filteredArgs: filtered, useWorktrees };
}

const { projectDir, filteredArgs, useWorktrees } = parseProjectDir(process.argv.slice(2));
const command = filteredArgs[0];
const args = filteredArgs.slice(1);

const BASE_DIR = join(projectDir, '.a2a-crews');

/** Check if the project has recent uncommitted changes (proxy for agent activity). */
function isProjectActive(projectDir: string): boolean {
  try {
    const { execSync } = require('child_process');
    const diff = execSync(`git -C "${projectDir}" status --porcelain 2>nul || echo ""`, {
      encoding: 'utf-8', timeout: 5000,
    });
    return diff.trim().length > 0;
  } catch { return false; }
}

/** Generate a clean, readable team name from a scenario string. */
function generateTeamName(scenario: string): string {
  // Remove filler words to get a meaningful slug
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'be', 'are',
    'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
    'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
    'can', 'need', 'must', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'because', 'as', 'until', 'while',
    'about', 'between', 'through', 'during', 'before', 'after', 'above',
    'below', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
    'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
    'how', 'what', 'which', 'who', 'whom', 'build', 'create', 'make',
    'write', 'implement', 'add', 'using', 'use',
  ]);

  const words = scenario
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w));

  // Take up to 4 meaningful words, join with dash
  const slug = words.slice(0, 4).join('-');

  // Fallback if everything got filtered
  if (!slug) {
    return scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  }

  return slug.slice(0, 40).replace(/-$/, '');
}

switch (command) {
  case 'plan':
    await handlePlan(args.join(' '));
    break;
  case 'apply':
    await handleApply();
    break;
  case 'launch':
    await handleLaunch(args[0], useWorktrees);
    break;
  case 'watch':
    await handleWatch(args[0]);
    break;
  case 'stop':
    await handleStop(args[0]);
    break;
  case 'templates':
    handleTemplates();
    break;
  case 'goal':
    await handleGoal(args);
    break;
  default:
    printHelp();
}

// ── Plan ──────────────────────────────────────────────────────────────

async function handlePlan(scenario: string): Promise<void> {
  if (!scenario.trim()) {
    console.log('  Usage: crews plan "<scenario>"');
    console.log('  Example: crews plan "Build a REST API with auth and tests"');
    process.exit(1);
  }

  printHeader('PLANNING');
  console.log(`  Scenario: ${scenario}\n`);

  const planDir = join(projectDir, '.a2a-crews');

  // Remove old plan
  const oldPlan = join(planDir, 'plan.json');
  if (existsSync(oldPlan)) {
    unlinkSync(oldPlan);
  }

  // Try AI planner first
  if (isAIPlannerAvailable()) {
    console.log('  🤖 AI planner available — spawning intelligent planner\n');
    const success = await runAIPlanner(scenario, projectDir);

    if (success) {
      // Read and display the AI-generated plan
      const plan = await Bun.file(join(planDir, 'plan.json')).json() as Plan;
      displayPlan(plan);
      console.log(`  ✅ AI plan written to ${join(planDir, 'plan.json')}`);
      console.log('  Run `crews apply` to create the team.\n');
      process.exit(0);
    }

    console.log('  ⚠️  AI planner failed — falling back to template matching\n');
  } else {
    console.log('  ℹ️  Copilot CLI not found — using template matching\n');
  }

  // Fallback: keyword-based template matching
  const templateName = findBestTemplate(scenario);

  if (!templateName) {
    console.log('  ⚠️  No matching template found for this scenario.');
    console.log('  Try a more specific description, or run `crews templates` to see available presets.');
    process.exit(1);
  }

  console.log(`  📋 Best template: ${templateName}\n`);

  // Run heuristic feasibility assessment
  const assessment = assessFeasibility(scenario, projectDir);

  console.log(`  FEASIBILITY`);
  const icon = assessment.overall.verdict === 'go' ? '✅' : assessment.overall.verdict === 'risky' ? '⚠️' : '🛑';
  console.log(`    ${icon} ${assessment.overall.verdict.toUpperCase()} (${Math.round(assessment.overall.confidence * 100)}%)`);
  if (assessment.overall.concerns.length > 0) {
    for (const c of assessment.overall.concerns) {
      console.log(`    • ${c}`);
    }
  }
  console.log(`    ${assessment.overall.recommendation}\n`);

  const { agents, tasks } = composeFromTemplate(templateName, scenario);

  const plan: Plan = {
    scenario,
    feasibility: {
      verdict: assessment.overall.verdict,
      confidence: assessment.overall.confidence,
      concerns: assessment.overall.concerns,
      recommendation: assessment.overall.recommendation,
    },
    rationale: `Auto-composed from "${templateName}" preset based on keyword matching.`,
    roles: agents.map(a => ({
      key: a.key,
      description: a.description,
      skills: a.skills,
      why: `Matched from ${templateName} template`,
    })),
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      assignedTo: t.assignedTo,
      dependsOn: t.dependsOn,
      acceptanceCriteria: t.acceptanceCriteria,
    })),
    basedOnTemplate: templateName,
  };

  displayPlan(plan);

  // Write plan to disk
  mkdirSync(BASE_DIR, { recursive: true });
  const planPath = join(BASE_DIR, 'plan.json');
  await Bun.write(planPath, JSON.stringify(plan, null, 2));

  console.log(`  ✅ Plan written to ${planPath}`);
  console.log('  Run `crews apply` to create the team.\n');
}

function displayPlan(plan: Plan): void {
  // Feasibility
  console.log(`  FEASIBILITY`);
  const icon = plan.feasibility.verdict === 'go' ? '✅' : plan.feasibility.verdict === 'risky' ? '⚠️' : '🛑';
  console.log(`    ${icon} ${plan.feasibility.verdict.toUpperCase()} (${Math.round(plan.feasibility.confidence * 100)}%)`);
  if (plan.feasibility.concerns.length > 0) {
    for (const c of plan.feasibility.concerns) {
      console.log(`    • ${c}`);
    }
  }
  console.log(`    ${plan.feasibility.recommendation}\n`);

  // Summary
  console.log(`  ${planSummary(plan)}\n`);
  if (plan.rationale) {
    console.log(`  Rationale: ${plan.rationale}\n`);
  }

  // Roles & tasks
  printRoles(plan.roles.map(r => ({ key: r.key, description: r.description })));
  printTasks(plan.tasks.map(t => ({
    id: t.id,
    title: t.title,
    assignedTo: t.assignedTo,
    dependsOn: t.dependsOn,
    status: t.dependsOn.length > 0 ? 'blocked' : 'pending',
  })));
}

// ── Apply ─────────────────────────────────────────────────────────────

async function handleApply(): Promise<void> {
  const planPath = join(BASE_DIR, 'plan.json');

  if (!existsSync(planPath)) {
    console.log('  ❌ No plan found. Run `crews plan "<scenario>"` first.');
    process.exit(1);
  }

  const planFile = Bun.file(planPath);
  const plan: Plan = await planFile.json();

  printHeader('APPLYING PLAN');
  console.log(`  Scenario: ${plan.scenario}`);
  console.log(`  ${planSummary(plan)}\n`);

  printRoles(plan.roles.map(r => ({ key: r.key, description: r.description })));
  printTasks(plan.tasks.map(t => ({
    id: t.id,
    title: t.title,
    assignedTo: t.assignedTo,
    dependsOn: t.dependsOn,
    status: t.dependsOn.length > 0 ? 'blocked' : 'pending',
  })));

  // Derive team name from scenario — smart slug, not dumb truncation
  const teamName = generateTeamName(plan.scenario);

  const teamDir = join(BASE_DIR, teamName);
  const artifactsDir = join(teamDir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  // Build crew config from plan
  const { agents, tasks } = composeFromPlan(plan);
  const crewConfig = {
    name: teamName,
    scenario: plan.scenario,
    process: 'wave' as const,
    agents: agents.map(a => ({
      key: a.key,
      name: a.name,
      description: a.description,
      skills: a.skills,
      model: a.model,
      allowedTools: a.allowedTools,
    })),
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      assignedTo: t.assignedTo,
      dependsOn: t.dependsOn,
      acceptanceCriteria: t.acceptanceCriteria,
      deliverable: t.deliverable,
    })),
  };

  await Bun.write(join(teamDir, 'crew.json'), JSON.stringify(crewConfig, null, 2));

  console.log(`  ✅ Team "${teamName}" created at ${teamDir}`);
  console.log(`  Run \`crews launch ${teamName}\` to start.\n`);
}

// ── Launch ────────────────────────────────────────────────────────────

async function handleLaunch(teamName?: string, useWorktrees: boolean = false): Promise<void> {
  // Resolve crew config
  let crewConfig: {
    name: string;
    scenario: string;
    agents: { key: string; name: string; description: string; skills: string[]; model?: string; allowedTools: string[] }[];
    tasks: { id: string; title: string; assignedTo: string; dependsOn: string[]; acceptanceCriteria: string[]; deliverable?: string }[];
  };

  if (teamName) {
    const crewPath = join(BASE_DIR, teamName, 'crew.json');
    if (!existsSync(crewPath)) {
      console.log(`  ❌ Team "${teamName}" not found at ${crewPath}`);
      process.exit(1);
    }
    crewConfig = await Bun.file(crewPath).json();
  } else {
    // Fall back to plan.json
    const planPath = join(BASE_DIR, 'plan.json');
    if (!existsSync(planPath)) {
      console.log('  ❌ No team or plan found. Run `crews plan` and `crews apply` first.');
      process.exit(1);
    }
    const plan: Plan = await Bun.file(planPath).json();
    const { agents, tasks } = composeFromPlan(plan);
    teamName = generateTeamName(plan.scenario);
    crewConfig = {
      name: teamName,
      scenario: plan.scenario,
      agents: agents.map(a => ({ key: a.key, name: a.name, description: a.description, skills: a.skills, model: a.model, allowedTools: a.allowedTools })),
      tasks: tasks.map(t => ({ id: t.id, title: t.title, assignedTo: t.assignedTo, dependsOn: t.dependsOn, acceptanceCriteria: t.acceptanceCriteria, deliverable: t.deliverable })),
    };
  }

  printHeader('LAUNCHING CREW');
  console.log(`  Team: ${crewConfig.name}`);
  console.log(`  Scenario: ${crewConfig.scenario}\n`);

  // Start bridge on random port
  const port = 49152 + Math.floor(Math.random() * (65535 - 49152));
  const bridge = new A2ABridge(port);
  bridge.start();
  const bridgeUrl = `http://localhost:${bridge.actualPort}`;

  // Save bridge info so watch/stop can find it
  const teamDir = join(BASE_DIR, crewConfig.name);
  mkdirSync(teamDir, { recursive: true });
  const bridgeInfo = {
    url: bridgeUrl,
    port: bridge.actualPort,
    pid: process.pid,
    cwd: projectDir,
    startedAt: new Date().toISOString(),
  };
  await Bun.write(join(teamDir, 'bridge.json'), JSON.stringify(bridgeInfo, null, 2));

  // Register in central registry for cross-repo discovery (#19)
  cleanupStaleBridges();
  registerBridge(crewConfig.name, bridgeInfo);

  // Build Task objects for wave computation
  const taskObjects = crewConfig.tasks.map(t => new Task({
    id: t.id,
    title: t.title,
    assignedTo: t.assignedTo,
    dependsOn: t.dependsOn,
    acceptanceCriteria: t.acceptanceCriteria,
  }));

  const agentMap = new Map(crewConfig.agents.map(a => [a.key, new Agent({
    key: a.key,
    name: a.name,
    description: a.description,
    skills: a.skills,
    model: a.model,
    allowedTools: a.allowedTools,
  })]));

  const waves = computeWaves(taskObjects);
  console.log(`  📊 ${waves.length} waves, ${taskObjects.length} tasks, ${crewConfig.agents.length} agents`);
  if (useWorktrees) {
    console.log(`  🌳 Worktree isolation enabled`);
  }
  console.log();

  const startTime = Date.now();
  let tasksCompleted = 0;
  let totalRetries = 0;
  let failedTasks = 0;
  const bridgeTaskIds: Map<string, string> = new Map(); // task.id -> bridge task UUID
  const spawnAttempts: Map<string, number> = new Map(); // task.id -> attempt count
  const taskSubmittedAt: Map<string, number> = new Map(); // task.id -> timestamp of last spawn
  const agentWorktrees: Map<string, string> = new Map(); // agent.key -> worktree path

  const MAX_RETRIES = 3;
  const BASE_TIMEOUT_MS = 10 * 60 * 1000;     // 10 minutes base (was 5 — too aggressive)
  const ACTIVE_MULTIPLIER = 3;                  // 3x timeout when agent shows activity
  const BACKOFF_MULTIPLIER = 1.5;               // exponential backoff per retry

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx];
    console.log(`  ── Wave ${waveIdx + 1}/${waves.length} ──────────────────────────────────`);

    // Register agents and create tasks on bridge for this wave
    // If using worktrees, create one per unique agent in this wave
    const waveAgentKeys = new Set(wave.map(t => t.assignedTo));
    if (useWorktrees) {
      for (const agentKey of waveAgentKeys) {
        if (agentWorktrees.has(agentKey)) continue;
        try {
          const wtPath = await createWorktree(projectDir, agentKey);
          agentWorktrees.set(agentKey, wtPath);
          console.log(`    🌳 Worktree created for ${agentKey} at ${wtPath}`);
        } catch (err) {
          console.log(`    ⚠️  Failed to create worktree for ${agentKey}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    for (const task of wave) {
      const agent = agentMap.get(task.assignedTo);
      if (!agent) continue;

      // Check if task has exceeded max retries (poison pill)
      const attempts = spawnAttempts.get(task.id) ?? 0;
      if (attempts >= MAX_RETRIES) {
        console.log(`    ☠️  ${task.id} — exceeded max retries, marking failed`);
        const existingUuid = bridgeTaskIds.get(task.id);
        if (existingUuid) {
          await fetch(`${bridgeUrl}/tasks/${existingUuid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'failed', result: 'Max retries exceeded' }),
          });
        }
        failedTasks++;
        continue;
      }

      // Register agent on bridge (idempotent — re-registration overwrites)
      await fetch(`${bridgeUrl}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: agent.key,
          description: agent.description,
          skills: agent.skills,
        }),
      });

      // Create task on bridge
      const taskRes = await fetch(`${bridgeUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedTo: agent.key,
          message: task.title,
        }),
      });
      const taskBody = await taskRes.json() as { task: { id: string } };
      bridgeTaskIds.set(task.id, taskBody.task.id);

      // Generate prompt and spawn agent
      const agentTasks = crewConfig.tasks
        .filter(t => t.assignedTo === agent.key)
        .map(t => new Task({
          id: t.id,
          title: t.title,
          assignedTo: t.assignedTo,
          dependsOn: t.dependsOn,
          acceptanceCriteria: t.acceptanceCriteria,
        }));

      const agentWtPath = useWorktrees ? agentWorktrees.get(agent.key) : undefined;

      const prompt = generateAgentPrompt({
        agent,
        tasks: agentTasks,
        scenario: crewConfig.scenario,
        bridgeUrl,
        projectDir: projectDir,
        worktreePath: agentWtPath,
      });

      console.log(`    🚀 Spawning ${agent.name} for task "${task.id}"`);
      await spawnAgent({
        name: agent.key,
        prompt,
        cwd: projectDir,
        model: agent.model,
        bridgeUrl,
        taskId: bridgeTaskIds.get(task.id),
        worktreePath: agentWtPath,
      });
      spawnAttempts.set(task.id, (spawnAttempts.get(task.id) ?? 0) + 1);
      taskSubmittedAt.set(task.id, Date.now());
    }

    // Poll bridge for wave completion (with evidence-based fallback)
    console.log(`    ⏳ Waiting for wave ${waveIdx + 1} to complete...`);
    const waveTaskUuids: string[] = wave.map(t => bridgeTaskIds.get(t.id)!);
    let waveComplete = false;
    let elapsed = 0;

    while (!waveComplete) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      elapsed += 5;

      let allDone = true;
      for (let i = 0; i < waveTaskUuids.length; i++) {
        const uuid = waveTaskUuids[i];
        const task = wave[i];
        const res = await fetch(`${bridgeUrl}/tasks/${uuid}`);
        const body = await res.json() as { status: string };

        if (['completed', 'failed', 'canceled'].includes(body.status)) {
          continue; // Already done on bridge
        }

        // Evidence-based recovery: check if deliverable file exists
        const deliverablePath = join(teamDir, task.deliverable);
        if (existsSync(deliverablePath)) {
          console.log(`    🔧 ${task.id} — recovered (deliverable exists, updating bridge)`);
          await fetch(`${bridgeUrl}/tasks/${uuid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed', result: 'Recovered from deliverable evidence' }),
          });
          continue;
        }

        // Dead agent detection: task stuck in non-terminal state
        if (body.status === 'submitted' || body.status === 'working') {
          const submittedTime = taskSubmittedAt.get(task.id) ?? startTime;
          const stuckDuration = Date.now() - submittedTime;
          const currentAttempts = spawnAttempts.get(task.id) ?? 0;

          // Exponential backoff: increase timeout with each retry attempt
          const effectiveTimeout = BASE_TIMEOUT_MS * Math.pow(BACKOFF_MULTIPLIER, currentAttempts);

          // Check for evidence of agent activity
          const projectActive = isProjectActive(projectDir);

          // If project files are changing, extend timeout significantly
          const timeout = projectActive
            ? effectiveTimeout * ACTIVE_MULTIPLIER
            : effectiveTimeout;

          // Log activity status periodically
          if (projectActive && elapsed % 60 === 0) {
            const timeoutMin = Math.round(timeout / 60000);
            console.log(`    ⏳ ${task.id} — still working (files changing, timeout extended to ${timeoutMin}m)`);
          }

          if (stuckDuration > timeout) {
            // Final deliverable check before retry (file may have appeared during wait)
            if (existsSync(deliverablePath)) {
              console.log(`    🔧 ${task.id} — late recovery (deliverable appeared, updating bridge)`);
              await fetch(`${bridgeUrl}/tasks/${uuid}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed', result: 'Late recovery from deliverable evidence' }),
              });
              continue;
            }

            if (currentAttempts >= MAX_RETRIES) {
              console.log(`    ☠️  ${task.id} — agent dead, max retries exhausted (${currentAttempts}/${MAX_RETRIES})`);
              await fetch(`${bridgeUrl}/tasks/${uuid}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'failed', result: 'Max retries exceeded — agent unresponsive' }),
              });
              failedTasks++;
              continue;
            }

            const timeoutMin = Math.round(timeout / 60000);
            console.log(`    🔄 ${task.id} — no activity for ${timeoutMin}m, retrying (attempt ${currentAttempts + 1}/${MAX_RETRIES})`);

            // Re-create task on bridge (old one is stale)
            const retryTaskRes = await fetch(`${bridgeUrl}/tasks`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                assignedTo: task.assignedTo,
                message: task.title,
              }),
            });
            const retryTaskBody = await retryTaskRes.json() as { task: { id: string } };

            // Cancel the old stale task
            await fetch(`${bridgeUrl}/tasks/${uuid}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'canceled', result: 'Replaced by retry' }),
            });

            // Update tracking to new bridge UUID
            bridgeTaskIds.set(task.id, retryTaskBody.task.id);
            waveTaskUuids[i] = retryTaskBody.task.id;

            // Re-spawn the agent
            const agent = agentMap.get(task.assignedTo);
            if (agent) {
              const agentTasks = crewConfig.tasks
                .filter(t => t.assignedTo === agent.key)
                .map(t => new Task({
                  id: t.id,
                  title: t.title,
                  assignedTo: t.assignedTo,
                  dependsOn: t.dependsOn,
                  acceptanceCriteria: t.acceptanceCriteria,
                }));

              const retryWtPath = useWorktrees ? agentWorktrees.get(agent.key) : undefined;

              const prompt = generateAgentPrompt({
                agent,
                tasks: agentTasks,
                scenario: crewConfig.scenario,
                bridgeUrl,
                projectDir: projectDir,
                worktreePath: retryWtPath,
              });

              await spawnAgent({
                name: agent.key,
                prompt,
                cwd: projectDir,
                model: agent.model,
                bridgeUrl,
                taskId: retryTaskBody.task.id,
                worktreePath: retryWtPath,
              });
            }

            spawnAttempts.set(task.id, currentAttempts + 1);
            taskSubmittedAt.set(task.id, Date.now());
            totalRetries++;
          }
        }

        allDone = false;
      }

      if (allDone) {
        waveComplete = true;
        tasksCompleted += wave.length;
        console.log(`    ✅ Wave ${waveIdx + 1} complete (${elapsed}s)\n`);

        // Merge and clean up worktrees for this wave's agents
        if (useWorktrees) {
          for (const agentKey of waveAgentKeys) {
            if (!agentWorktrees.has(agentKey)) continue;
            try {
              const merged = await mergeWorktree(projectDir, agentKey);
              if (merged) {
                console.log(`    🔀 Merged worktree for ${agentKey}`);
              } else {
                console.log(`    ⚠️  Merge conflict for ${agentKey} — manual resolution needed`);
              }
            } catch (err) {
              console.log(`    ⚠️  Merge failed for ${agentKey}: ${err instanceof Error ? err.message : err}`);
            }
            try {
              await removeWorktree(projectDir, agentKey);
              agentWorktrees.delete(agentKey);
              console.log(`    🧹 Cleaned up worktree for ${agentKey}`);
            } catch (err) {
              console.log(`    ⚠️  Worktree cleanup failed for ${agentKey}: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      } else if (elapsed % 30 === 0) {
        console.log(`    ⏳ Still waiting... (${elapsed}s)`);
      }

      // Timeout after 30 min
      if (elapsed > 1800) {
        console.log(`    ⚠️  Wave ${waveIdx + 1} timed out after 30 minutes`);
        // Clean up worktrees on timeout
        if (useWorktrees) {
          console.log(`    🧹 Cleaning up worktrees after timeout...`);
          await cleanupAllWorktrees(projectDir);
          agentWorktrees.clear();
        }
        break;
      }
    }
  }

  // Final worktree cleanup — catch any leftovers
  if (useWorktrees && agentWorktrees.size > 0) {
    console.log(`  🧹 Final worktree cleanup...`);
    await cleanupAllWorktrees(projectDir);
    agentWorktrees.clear();
  }

  const totalTime = (Date.now() - startTime) / 1000;
  printSummary(totalTime, waves.length, tasksCompleted, taskObjects.length, totalRetries, failedTasks);

  // Persist event log before stopping the bridge
  try {
    const logRes = await fetch(`${bridgeUrl}/events/log`);
    const logEntries = await logRes.json() as string[];
    writeFileSync(join(teamDir, 'events.log'), logEntries.join('\n') + '\n');
  } catch {
    // Bridge may already be unreachable — best-effort
  }

  // Don't stop bridge — agents may still need it
  const stopFile = join(teamDir, '.stop');
  console.log(`  🌉 Bridge still running on port ${bridge.actualPort}. Run 'crews stop ${teamName}' or press Ctrl+C.`);

  // Handle graceful shutdown via Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n  🛑 Stopping bridge...');
    if (useWorktrees) {
      console.log('  🧹 Cleaning up worktrees...');
      await cleanupAllWorktrees(projectDir);
    }
    bridge.stop();
    unregisterBridge(crewConfig.name);
    process.exit(0);
  });

  // Poll for stop signal file (from crews stop command)
  const keepAlive = setInterval(async () => {
    if (existsSync(stopFile)) {
      clearInterval(keepAlive);
      bridge.stop();
      unregisterBridge(crewConfig.name);
      unlinkSync(stopFile);
      console.log('  🛑 Bridge stopped via crews stop.');
      process.exit(0);
    }
  }, 2000);
}

// ── Watch ─────────────────────────────────────────────────────────────

async function handleWatch(teamName?: string): Promise<void> {
  if (!teamName) {
    console.log('  Usage: crews watch <teamName>');
    process.exit(1);
  }

  const bridgePath = join(BASE_DIR, teamName, 'bridge.json');
  if (!existsSync(bridgePath)) {
    console.log(`  ❌ No bridge found for team "${teamName}".`);
    console.log('  Is the team launched? Run `crews launch` first.');
    process.exit(1);
  }

  const bridgeInfo = await Bun.file(bridgePath).json() as { url: string };
  const bridgeUrl = bridgeInfo.url;

  console.log(`  👀 Watching team "${teamName}" at ${bridgeUrl}\n`);
  console.log('  Press Ctrl+C to stop watching.\n');

  while (true) {
    try {
      const res = await fetch(`${bridgeUrl}/status`);
      const status = await res.json() as {
        bridge: string;
        agents: { total: number; online: number; busy: number; idle: number; offline: number; list: { name: string; status: string }[] };
        tasks: { total: number; submitted: number; working: number; completed: number; failed: number; canceled: number };
      };

      // Clear screen and redraw
      console.clear();
      printHeader(`WATCHING: ${teamName}`);

      console.log(`  Bridge: ${status.bridge}`);
      console.log(`  Agents: ${status.agents.total} (${status.agents.online} online, ${status.agents.busy} busy, ${status.agents.idle} idle)\n`);

      if (status.agents.list && status.agents.list.length > 0) {
        console.log('  AGENTS');
        for (const a of status.agents.list) {
          const icon = a.status === 'online' ? '🟢' : a.status === 'busy' ? '🔵' : a.status === 'idle' ? '🟡' : '🔴';
          console.log(`    ${icon} ${a.name} [${a.status}]`);
        }
        console.log();
      }

      console.log(`  TASKS: ${status.tasks.completed}/${status.tasks.total} completed`);
      console.log(`    ⏳ Submitted: ${status.tasks.submitted}  🔄 Working: ${status.tasks.working}  ✅ Done: ${status.tasks.completed}  ❌ Failed: ${status.tasks.failed}`);
      console.log();

      // Fetch individual tasks for detail
      const tasksRes = await fetch(`${bridgeUrl}/tasks`);
      const tasks = await tasksRes.json() as { id: string; assignedTo: string; status: string; message: string }[];
      if (tasks.length > 0) {
        printTasks(tasks.map(t => ({
          id: t.id.slice(0, 8),
          title: t.message,
          assignedTo: t.assignedTo,
          dependsOn: [],
          status: t.status,
        })));
      }
    } catch {
      console.log('  ⚠️  Bridge unreachable. It may have stopped.');
      process.exit(1);
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

// ── Stop ──────────────────────────────────────────────────────────────

async function handleStop(teamName?: string): Promise<void> {
  if (!teamName) {
    console.log('  Usage: crews stop <teamName>');
    process.exit(1);
  }

  const teamDir = join(BASE_DIR, teamName);
  if (!existsSync(teamDir)) {
    console.log(`  Team '${teamName}' not found.`);
    process.exit(1);
  }

  printHeader('STOPPING CREW');

  const bridgePath = join(teamDir, 'bridge.json');
  if (existsSync(bridgePath)) {
    const bridgeInfo = await Bun.file(bridgePath).json() as { url: string };
    const bridgeUrl = bridgeInfo.url;

    try {
      // Cancel non-terminal tasks before sending stop signal
      const tasksRes = await fetch(`${bridgeUrl}/tasks`);
      const tasks = await tasksRes.json() as { id: string; status: string }[];

      let canceled = 0;
      for (const task of tasks) {
        if (!['completed', 'failed', 'canceled'].includes(task.status)) {
          await fetch(`${bridgeUrl}/tasks/${task.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'canceled' }),
          });
          canceled++;
        }
      }
      if (canceled > 0) {
        console.log(`  Canceled ${canceled} task(s).`);
      }
    } catch {
      // Bridge may already be unreachable — proceed with stop signal anyway
    }
  }

  // Write stop signal file — the launch process polls for this
  await Bun.write(join(teamDir, '.stop'), new Date().toISOString());
  unregisterBridge(teamName);
  console.log(`  🛑 Stop signal sent to team '${teamName}'. Bridge will shut down shortly.`);
  process.exit(0);
}

// ── Templates ─────────────────────────────────────────────────────────

function handleTemplates(): void {
  printHeader('AVAILABLE TEMPLATES');

  const names = listPresets();
  const rows: { name: string; description: string; roles: number; tasks: number }[] = [];

  for (const name of names) {
    const preset = loadPreset(name);
    rows.push({
      name: preset.name,
      description: preset.description,
      roles: preset.roles.length,
      tasks: preset.tasks.length,
    });
  }

  // Table header
  const nameW = 18;
  const descW = 50;
  console.log(`  ${'Name'.padEnd(nameW)} ${'Description'.padEnd(descW)} Roles  Tasks`);
  console.log(`  ${'─'.repeat(nameW)} ${'─'.repeat(descW)} ${'─'.repeat(5)}  ${'─'.repeat(5)}`);

  for (const r of rows) {
    const desc = r.description.length > descW ? r.description.slice(0, descW - 1) + '…' : r.description;
    console.log(`  ${r.name.padEnd(nameW)} ${desc.padEnd(descW)} ${String(r.roles).padStart(5)}  ${String(r.tasks).padStart(5)}`);
  }

  console.log(`\n  ${rows.length} templates available.`);
  console.log('  Use: crews plan "<scenario>" to auto-select a template.\n');
}

// ── Goal loop ─────────────────────────────────────────────────────────

async function handleGoal(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? 'status').toLowerCase();
  const store = new GoalStore({ baseDir: projectDir });
  const runner = new GoalRunner({ store, emitEvents: false });

  // Load the current goal: active first, else the most recent paused one.
  const loadCurrent = (): boolean => {
    if (runner.loadActive()) return true;
    const paused = store.listRecords().filter(r => r.state === 'paused');
    if (paused.length > 0) {
      runner.load(paused[paused.length - 1].id);
      return true;
    }
    return false;
  };

  switch (sub) {
    case 'status': {
      if (!loadCurrent()) {
        printHeader('GOAL');
        console.log('  No active goal. Start one with:');
        console.log('    crews goal start <contract.json>\n');
        return;
      }
      printGoalStatus(runner.status());
      return;
    }

    case 'show': {
      if (!loadCurrent()) {
        console.log('  No goal to show.');
        return;
      }
      const shown = runner.show();
      if (shown) console.log(`\n${shown.markdown}`);
      return;
    }

    case 'list': {
      const records = store.listRecords();
      printHeader('GOALS');
      if (records.length === 0) {
        console.log('  (none)\n');
        return;
      }
      for (const r of records) {
        console.log(`  [${r.state.padEnd(9)}] ${r.id}`);
        console.log(`       ${r.contract.objective}`);
      }
      console.log();
      return;
    }

    case 'start':
    case 'set': {
      const file = argv[1];
      if (!file) {
        console.log('  Usage: crews goal start <contract.json>');
        return;
      }
      const path = resolve(projectDir, file);
      if (!existsSync(path)) {
        console.log(`  Contract file not found: ${path}`);
        return;
      }
      let parsed: Partial<GoalContract>;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GoalContract>;
      } catch (e) {
        console.log(`  Invalid JSON: ${(e as Error).message}`);
        return;
      }
      const validation = validateContract(parsed);
      if (!validation.valid) {
        printHeader('GOAL — INVALID CONTRACT');
        if (validation.missing.length) console.log(`  Missing fields: ${validation.missing.join(', ')}`);
        for (const err of validation.errors) console.log(`  ✗ ${err}`);
        console.log();
        return;
      }
      const record = runner.start(parsed);
      printHeader('GOAL ACTIVATED');
      console.log(`  ${record.contract.objective}`);
      console.log(`  Stopping condition: ${record.contract.stoppingCondition}`);
      console.log(`  Durable state: audits/goals/${record.id}/\n`);
      return;
    }

    case 'checkpoint': {
      if (!loadCurrent()) {
        console.log('  No goal to checkpoint.');
        return;
      }
      const title = argv.slice(1).join(' ') || undefined;
      const cp = runner.checkpoint({ title });
      console.log(`  ✅ Checkpoint #${cp.checkpointNumber} → audits/goals/${cp.goalId}/checkpoints.jsonl`);
      return;
    }

    case 'pause': {
      if (!loadCurrent()) {
        console.log('  No active goal to pause.');
        return;
      }
      try {
        printGoalStatus(runner.pause());
      } catch (e) {
        console.log(`  ${(e as Error).message}`);
      }
      return;
    }

    case 'resume': {
      if (!loadCurrent()) {
        console.log('  No goal to resume.');
        return;
      }
      try {
        printGoalStatus(runner.resume());
      } catch (e) {
        console.log(`  ${(e as Error).message}`);
      }
      return;
    }

    case 'clear':
    case 'stop':
    case 'off':
    case 'reset':
    case 'none':
    case 'cancel': {
      if (!loadCurrent()) {
        console.log('  No goal to clear.');
        return;
      }
      runner.clear(sub);
      console.log(`  Goal cleared (${sub}). Retrospective written; history kept.\n`);
      return;
    }

    default:
      console.log(`  Unknown goal subcommand: ${sub}`);
      console.log('  Try: status | show | list | start <file> | checkpoint | pause | resume | clear');
  }
}

// ── Help ──────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  a2a-crews — Turn one command into a team of AI agents

  Usage: crews [options] <command> [args]

  Commands:
    plan <scenario>     Assess feasibility and compose a team
    apply               Review plan, approve, create team
    launch [name]       Spawn agents and orchestrate execution
    watch [name]        Stream live status from agents
    stop [name]         Cancel all tasks and stop agents
    templates           List all available crew templates
    goal <subcommand>   Drive a durable, evaluator-graded goal loop

  Goal subcommands:
    goal status            Show the active goal (default)
    goal show              Print the full goal contract
    goal list              List every goal in audits/goals/
    goal start <file>      Activate a goal from a 7-field contract JSON
    goal checkpoint [note] Force-write a checkpoint now
    goal pause | resume    Pause / re-prime and continue the loop
    goal clear             Clear the goal and write a retrospective

  Options:
    --project-dir, -d   Target project directory (default: cwd)
    --use-worktrees     Give each agent its own git worktree (isolated branches)

  Examples:
    crews plan "Build a REST API with auth and tests"
    crews apply
    crews launch my-api
    crews -d /path/to/project plan "Build a dashboard"

  Built on Google's A2A protocol. https://a2aproject.org
  `);
}
