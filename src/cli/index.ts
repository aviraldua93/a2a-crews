#!/usr/bin/env bun

import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { composeFromTemplate, composeFromPlan, findBestTemplate, assessFeasibility } from '../planner';
import { planSummary, type Plan } from '../planner/plan';
import { Task } from '../crew/task';
import { Agent } from '../crew/agent';
import { computeWaves } from '../crew/process';
import { A2ABridge } from '../a2a/bridge';
import { spawnAgent } from '../spawner/terminal';
import { generateAgentPrompt } from '../spawner/prompt';
import { listPresets, loadPreset } from '../templates';
import { printHeader, printRoles, printTasks, printSummary } from './display';

const BASE_DIR = join(process.cwd(), '.a2a-crews');

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case 'plan':
    await handlePlan(args.join(' '));
    break;
  case 'apply':
    await handleApply();
    break;
  case 'launch':
    await handleLaunch(args[0]);
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

  const templateName = findBestTemplate(scenario);

  if (!templateName) {
    console.log('  ⚠️  No matching template found for this scenario.');
    console.log('  Try a more specific description, or run `crews templates` to see available presets.');
    process.exit(1);
  }

  console.log(`  📋 Best template: ${templateName}\n`);

  // Run heuristic feasibility assessment
  const assessment = assessFeasibility(scenario, process.cwd());

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
  const preset = loadPreset(templateName);

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

  console.log(`  ${planSummary(plan)}\n`);

  printRoles(plan.roles.map(r => ({ key: r.key, description: r.description })));
  printTasks(plan.tasks.map(t => ({
    id: t.id,
    title: t.title,
    assignedTo: t.assignedTo,
    dependsOn: t.dependsOn,
    status: t.dependsOn.length > 0 ? 'blocked' : 'pending',
  })));

  // Write plan to disk
  mkdirSync(BASE_DIR, { recursive: true });
  const planPath = join(BASE_DIR, 'plan.json');
  await Bun.write(planPath, JSON.stringify(plan, null, 2));

  console.log(`  ✅ Plan written to ${planPath}`);
  console.log('  Run `crews apply` to create the team.\n');
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

  // Derive team name from scenario
  const teamName = plan.scenario
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

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

async function handleLaunch(teamName?: string): Promise<void> {
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
    teamName = plan.scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
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
  await Bun.write(join(teamDir, 'bridge.json'), JSON.stringify({
    url: bridgeUrl,
    port: bridge.actualPort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2));

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
  console.log(`  📊 ${waves.length} waves, ${taskObjects.length} tasks, ${crewConfig.agents.length} agents\n`);

  const startTime = Date.now();
  let tasksCompleted = 0;
  let totalRetries = 0;
  let failedTasks = 0;
  const bridgeTaskIds: Map<string, string> = new Map(); // task.id -> bridge task UUID
  const spawnAttempts: Map<string, number> = new Map(); // task.id -> attempt count
  const taskSubmittedAt: Map<string, number> = new Map(); // task.id -> timestamp of last spawn

  const MAX_RETRIES = 3;
  const DEAD_AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx];
    console.log(`  ── Wave ${waveIdx + 1}/${waves.length} ──────────────────────────────────`);

    // Register agents and create tasks on bridge for this wave
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

      const prompt = generateAgentPrompt({
        agent,
        tasks: agentTasks,
        scenario: crewConfig.scenario,
        bridgeUrl,
        projectDir: process.cwd(),
      });

      console.log(`    🚀 Spawning ${agent.name} for task "${task.id}"`);
      await spawnAgent({
        name: agent.key,
        prompt,
        cwd: process.cwd(),
        model: agent.model,
        bridgeUrl,
        taskId: bridgeTaskIds.get(task.id),
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
          // Agent wrote deliverable but didn't update bridge — recover
          console.log(`    🔧 ${task.id} — recovered (deliverable exists, updating bridge)`);
          await fetch(`${bridgeUrl}/tasks/${uuid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed', result: 'Recovered from deliverable evidence' }),
          });
          continue;
        }

        // Dead agent detection: task stuck in 'submitted' with no deliverable
        if (body.status === 'submitted') {
          const submittedTime = taskSubmittedAt.get(task.id) ?? startTime;
          const stuckDuration = Date.now() - submittedTime;

          if (stuckDuration > DEAD_AGENT_TIMEOUT_MS) {
            const currentAttempts = spawnAttempts.get(task.id) ?? 0;

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

            console.log(`    🔄 ${task.id} — agent appears dead, retrying (attempt ${currentAttempts + 1}/${MAX_RETRIES})`);

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

              const prompt = generateAgentPrompt({
                agent,
                tasks: agentTasks,
                scenario: crewConfig.scenario,
                bridgeUrl,
                projectDir: process.cwd(),
              });

              await spawnAgent({
                name: agent.key,
                prompt,
                cwd: process.cwd(),
                model: agent.model,
                bridgeUrl,
                taskId: retryTaskBody.task.id,
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
      } else if (elapsed % 30 === 0) {
        console.log(`    ⏳ Still waiting... (${elapsed}s)`);
      }

      // Timeout after 15 min
      if (elapsed > 900) {
        console.log(`    ⚠️  Wave ${waveIdx + 1} timed out after 15 minutes`);
        break;
      }
    }
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

  bridge.stop();
  process.exit(0);
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

  const bridgePath = join(BASE_DIR, teamName, 'bridge.json');
  if (!existsSync(bridgePath)) {
    console.log(`  ❌ No bridge found for team "${teamName}".`);
    process.exit(1);
  }

  const bridgeInfo = await Bun.file(bridgePath).json() as { url: string };
  const bridgeUrl = bridgeInfo.url;

  printHeader('STOPPING CREW');

  try {
    // Fetch all tasks and cancel non-terminal ones
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

    console.log(`  Canceled ${canceled} task(s).`);

    // Stop bridge by sending an invalid request (graceful — bridge is in-process for launch,
    // but for stop we're a separate process, so we just report)
    console.log('  🛑 Stopped.');
    console.log(`  Note: The bridge process (in the launch terminal) should exit on its own.\n`);
  } catch {
    console.log('  ⚠️  Bridge unreachable — it may have already stopped.');
  }

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

// ── Help ──────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  a2a-crews — Turn one command into a team of AI agents

  Usage: crews <command> [options]

  Commands:
    plan <scenario>     Assess feasibility and compose a team
    apply               Review plan, approve, create team
    launch [name]       Spawn agents and orchestrate execution
    watch [name]        Stream live status from agents
    stop [name]         Cancel all tasks and stop agents
    templates           List all available crew templates

  Examples:
    crews plan "Build a REST API with auth and tests"
    crews apply
    crews launch my-api
    crews watch my-api
    crews templates

  Built on Google's A2A protocol. https://a2a-protocol.org
  `);
}
