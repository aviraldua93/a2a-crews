import type { Agent } from './agent';
import type { Task } from './task';
import { computeWaves } from './process';
import { createCheckpoint, toGoalCheckpointDraft } from './checkpoint';
import { eventBus, type EventType } from './events';
import {
  assertSeparateEvaluator,
  EvaluatorSeparationError,
  functionEvaluator,
  GoalStore,
  nextAttempt,
  normalizeContract,
  type Evaluation,
  type Evaluator,
  type Evidence,
  type GoalContract,
  type GoalRecord,
  type WorkerResult,
} from '../goal';

export type ProcessType = 'sequential' | 'wave';

export interface CrewConfig {
  name: string;
  scenario: string;
  process?: ProcessType;
  agents: Agent[];
  tasks: Task[];
}

export class Crew {
  name: string;
  scenario: string;
  process: ProcessType;
  agents: Agent[];
  tasks: Task[];

  constructor(config: CrewConfig) {
    this.name = config.name;
    this.scenario = config.scenario;
    this.process = config.process ?? 'wave';
    this.agents = config.agents;
    this.tasks = config.tasks;
  }

  /**
   * Run the crew as a durable goal loop.
   *
   * Wave scheduling ({@link computeWaves}) is adapted into checkpoint/evaluator
   * cycles: each wave is one turn in which the crew (a) runs the wave's tasks
   * (the *worker*), (b) surfaces evidence to a **separate** {@link Evaluator}
   * that grades progress (the worker never grades itself), (c) writes a durable,
   * idempotent checkpoint under `audits/goals/<id>/`, and (d) stops when the
   * evaluator reports the stopping condition met (all tasks completed, none
   * failed). Durable state is git-staged on every checkpoint and survives a lost
   * session; re-running the same crew appends no duplicate checkpoints.
   *
   * `runTask` is the injection seam: the default marks tasks completed in-process
   * (useful for tests and dry runs), while production wiring supplies a
   * bridge-backed executor. There is one active goal per session.
   */
  async kickoff(options: KickoffOptions = {}): Promise<CrewOutput> {
    const now = options.now ?? (() => new Date().toISOString());
    const emit = (type: EventType, data: Record<string, unknown>): void => {
      if (options.emitEvents !== false) eventBus.emit(type, data);
    };
    const store = options.store ?? new GoalStore({ baseDir: options.baseDir, now });
    const runTask = options.runTask ?? defaultTaskRunner;
    const workerId = `crew:${this.name}`;
    const evaluator = options.evaluator ?? crewCompletionEvaluator();
    assertSeparateEvaluator({ id: workerId }, evaluator);

    const waves = computeWaves(this.tasks);
    const totalTasks = this.tasks.length;

    const contract = normalizeContract(options.contract ?? this.deriveContract(waves.length));
    const id = crewGoalId(this.name);
    const existing = store.readRecord(id);
    const record: GoalRecord = {
      id,
      contract,
      state: 'active',
      autopilot: true,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      achievedCondition: null,
    };
    store.writeRecord(record);
    emit('crew:started', { name: this.name, waves: waves.length, tasks: totalTasks });
    emit('goal:started', { goalId: id, objective: contract.objective });

    const startedAt = Date.now();
    const results: TaskRunResult[] = [];
    const completedIds = new Set<string>();
    const evaluations: Evaluation[] = [];
    let attempts = 0;
    let met = false;

    for (let w = 0; w < waves.length; w++) {
      const wave = waves[w];
      emit('wave:started', { wave: w + 1, of: waves.length, tasks: wave.map(t => t.id) });

      // ── Worker: run the wave's tasks ───────────────────────────────
      const waveResults: TaskRunResult[] = [];
      for (const task of wave) {
        task.status = 'in_progress';
        emit('task:started', { taskId: task.id });
        const outcome = await runTask(task, { crew: this, wave: w + 1 });
        task.status = outcome.status;
        results.push(outcome);
        waveResults.push(outcome);
        if (outcome.status === 'completed') {
          completedIds.add(task.id);
          emit('task:completed', { taskId: task.id });
        } else {
          emit('task:failed', { taskId: task.id, status: outcome.status });
        }
      }
      attempts = nextAttempt(attempts);

      const waveFailed = waveResults.some(r => r.status !== 'completed');
      const failedCount = results.filter(r => r.status !== 'completed').length;
      const allDone = completedIds.size === totalTasks;
      const ts = now();
      const summary =
        `wave ${w + 1}/${waves.length}: ` +
        `${waveResults.filter(r => r.status === 'completed').length}/${wave.length} tasks ok`;

      // Evidence the *separate* evaluator will grade — machine-checkable counts.
      const surfaced: WorkerResult = {
        workerId,
        turn: w + 1,
        summary,
        command: contract.validationLoop,
        result: `tasks_completed=${completedIds.size} tasks_total=${totalTasks} tasks_failed=${failedCount}`,
        exitCode: waveFailed ? 1 : 0,
      };

      // Crew checkpoint (checkpoint.ts): the worker's view of verified/remaining.
      const checkpoint = createCheckpoint({
        role: this.name,
        checkpointNumber: w + 1,
        currentTask: `wave ${w + 1}/${waves.length}`,
        taskStatus: allDone ? 'complete' : 'partial',
        completedWork: waveResults.filter(r => r.status === 'completed').map(r => r.taskId),
        remainingWork: this.tasks.filter(t => !completedIds.has(t.id)).map(t => t.id),
        notes: summary,
      });
      checkpoint.timestamp = ts;

      // ── Evaluator: a distinct grading step, reading only surfaced evidence ──
      const evaluation = await evaluator.evaluate(contract, surfaced, evaluations);
      if (evaluation.evaluatorId === workerId) throw new EvaluatorSeparationError(workerId);
      evaluations.push(evaluation);

      // Bridge the crew checkpoint into the durable, idempotent goal log.
      const draft = toGoalCheckpointDraft(checkpoint, {
        goalId: id,
        turn: w + 1,
        evaluatorId: evaluation.evaluatorId,
        progress: evaluation.progress,
        passed: !waveFailed,
        attempt: attempts,
        evidence: evaluation.evidence,
        command: surfaced.command,
        result: surfaced.result,
        timestamp: ts,
        blocked: waveFailed ? `wave ${w + 1} had ${failedCount} failed task(s) so far` : null,
      });
      const { checkpoint: written } = store.appendCheckpoint(draft);
      record.updatedAt = written.timestamp;
      store.writeRecord(record);
      emit('goal:checkpoint', { goalId: id, checkpointNumber: written.checkpointNumber });
      emit('wave:completed', { wave: w + 1, progress: evaluation.progress });

      if (evaluation.conditionMet) {
        met = true;
        break;
      }
    }

    const allCompleted = completedIds.size === totalTasks;
    record.state = allCompleted ? 'completed' : 'active';
    record.achievedCondition = allCompleted ? contract.stoppingCondition : null;
    record.updatedAt = now();
    store.writeRecord(record);
    if (allCompleted) {
      store.writeRetrospective(id, buildCrewRetrospective(record, store, now));
      store.stage(id);
      emit('goal:completed', { goalId: id, condition: contract.stoppingCondition });
      emit('crew:completed', { name: this.name });
    } else {
      emit('crew:failed', { name: this.name, completed: completedIds.size, total: totalTasks });
    }

    return {
      tasks: results.map(r => ({
        taskId: r.taskId,
        status: r.status,
        output: r.output,
        duration: r.durationMs,
      })),
      totalTime: Date.now() - startedAt,
      waves: met ? evaluations.length : waves.length,
    };
  }

  /** Derive a verifiable 7-field contract from the crew's shape. */
  private deriveContract(waveCount: number): Partial<GoalContract> {
    return {
      objective: `Complete crew "${this.name}": ${this.scenario}`,
      stoppingCondition:
        `All ${this.tasks.length} crew task(s) reach status \`completed\` with 0 \`failed\` ` +
        `(state-verifiable from each Task.status)`,
      validationLoop: `crews watch ${this.name}`,
      inputsToReadFirst: [`${this.tasks.length} task(s) scheduled across ${waveCount} wave(s)`],
      constraints: [`process: ${this.process}`, 'one active goal per session'],
      forbiddenMoves: ['do not mark a task completed unless its acceptance criteria are met'],
      checkpointCadence: 'one durable checkpoint per wave',
    };
  }
}

export interface CrewOutput {
  tasks: TaskOutput[];
  totalTime: number;
  waves: number;
}

export interface TaskOutput {
  taskId: string;
  status: 'completed' | 'failed' | 'canceled';
  output?: string;
  duration: number;
}

/** Result of running a single task within a wave. */
export interface TaskRunResult {
  taskId: string;
  status: 'completed' | 'failed' | 'canceled';
  output?: string;
  durationMs: number;
}

/** Executes a single task. The injection seam for real (bridge-backed) execution. */
export type TaskRunner = (
  task: Task,
  ctx: { crew: Crew; wave: number; agent?: Agent },
) => TaskRunResult | Promise<TaskRunResult>;

export interface KickoffOptions {
  /** How to execute a single task. Defaults to an in-process runner that completes it. */
  runTask?: TaskRunner;
  /** Separate grader. Defaults to a crew-completion evaluator distinct from the worker. */
  evaluator?: Evaluator;
  /** Root under which durable goal state (`audits/goals/<id>/`) is written. Defaults to cwd. */
  baseDir?: string;
  /** Injected store (tests); takes precedence over {@link KickoffOptions.baseDir}. */
  store?: GoalStore;
  /** Timestamp source. Defaults to the runtime ISO clock (never a shell). */
  now?: () => string;
  /** Emit lifecycle events on the crew event bus. Default true. */
  emitEvents?: boolean;
  /** Override the contract derived from the crew's shape. */
  contract?: Partial<GoalContract>;
}

/** Stable, idempotent durable id for a crew's goal loop (same crew ⇒ same id). */
export function crewGoalId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'crew';
  return `crew-${slug}`;
}

/** In-process default runner: marks a task completed. Replaced by real execution in production. */
async function defaultTaskRunner(task: Task): Promise<TaskRunResult> {
  return { taskId: task.id, status: 'completed', output: `completed: ${task.title}`, durationMs: 0 };
}

function parseMetric(text: string, key: string): number | undefined {
  const m = new RegExp(`${key}=(\\d+)`).exec(text);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

/**
 * A separate evaluator for crew completion. It grades purely from the evidence
 * the worker surfaces (`tasks_completed`/`tasks_total`/`tasks_failed` plus the
 * validation exit code) and never re-runs the work. Its id differs from the
 * worker's, so the loop's separation invariant holds.
 */
export function crewCompletionEvaluator(id = 'crew-evaluator'): Evaluator {
  return functionEvaluator(id, (_contract, result) => {
    const surfaced = `${result.summary}\n${result.result ?? ''}`;
    const total = parseMetric(surfaced, 'tasks_total') ?? 0;
    const completed = parseMetric(surfaced, 'tasks_completed') ?? 0;
    const failed = parseMetric(surfaced, 'tasks_failed') ?? 0;
    const cleanExit = typeof result.command === 'string' && result.exitCode === 0;
    const conditionMet = total > 0 && completed === total && failed === 0 && cleanExit;
    const progress = total > 0 ? completed / total : 0;
    const reason = conditionMet
      ? `all ${total} task(s) completed, 0 failed, clean validation run`
      : `${completed}/${total} task(s) completed, ${failed} failed${cleanExit ? '' : ', validation not clean'}`;
    const evidence: Evidence = { reason };
    if (result.command !== undefined) evidence.command = result.command;
    if (result.result !== undefined) evidence.result = result.result;
    return { conditionMet, progress, evidence };
  });
}

function buildCrewRetrospective(record: GoalRecord, store: GoalStore, now: () => string): string {
  const checkpoints = store.readCheckpoints(record.id);
  const shipped = checkpoints.filter(c => c.validation.passed).map(c => `- ${c.title}`);
  return [
    `# Retrospective: ${record.contract.objective}`,
    '',
    `**Outcome:** ${record.state}`,
    `**Checkpoints:** ${checkpoints.length}`,
    `**Generated:** ${now()}`,
    '',
    '## What shipped',
    shipped.length ? shipped.join('\n') : '- (no passing checkpoints recorded)',
    '',
    '## Stopping condition',
    `- ${record.contract.stoppingCondition}`,
    `- Verified: ${record.achievedCondition ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}
