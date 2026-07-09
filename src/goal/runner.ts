/**
 * Goal-loop runner — the working tier of the two-tier memory model and the
 * engine that drives a crew/worker to a verifiable stopping condition.
 *
 * On each turn the runner (a) runs the worker, (b) invokes a *separate*
 * evaluator that grades progress from surfaced evidence, (c) writes a
 * checkpoint per the cadence, and (d) stops when the stopping condition is met.
 * It auto-pauses after two consecutive validation failures on the same slice so
 * it never compounds bad work.
 *
 * There is exactly one active goal per session; starting a new one replaces the
 * prior goal and resets the turn/token counters. Lifecycle operations mirror the
 * `/goal` slash commands: start/setObjective, pause, resume, clear (writes a
 * retrospective), status, checkpoint, show.
 */

import type { GoalContract, GoalState } from './contract';
import {
  CLEAR_ALIASES,
  contractToMarkdown,
  isClearAlias,
  normalizeContract,
} from './contract';
import {
  assertSeparateEvaluator,
  EvaluatorSeparationError,
  type Evaluation,
  type Evaluator,
  type Worker,
  type WorkerResult,
  type WorkerTurnContext,
} from './evaluator';
import {
  checkpointKey,
  GoalStore,
  type GoalCheckpoint,
  type GoalCheckpointDraft,
  type GoalRecord,
} from './store';
import { eventBus, type EventType } from '../crew/events';
import type { Crew } from '../crew/crew';

export { CLEAR_ALIASES, isClearAlias };

/** Increment a verification attempt counter that defaults to 0 (first attempt → 1). */
export function nextAttempt(current = 0): number {
  return current + 1;
}

/** In-memory (working-tier) state for the single active goal. */
export interface WorkingState {
  goalId: string;
  state: GoalState;
  turns: number;
  tokenSpend: number;
  consecutiveFailures: number;
  /** Verification attempts. Starts at 0; incremented once per turn. */
  attempts: number;
  checkpointCount: number;
  plan: string[];
  startedAt: string;
  lastReason: string;
  lastCheckpoint?: GoalCheckpoint;
  lastEvaluation?: Evaluation;
  achievedCondition?: string | null;
}

/** Compact, auditable status snapshot (used by `status`/`show`). */
export interface GoalStatus {
  goalId: string | null;
  state: GoalState | 'idle';
  objective: string | null;
  activeCondition: string | null;
  achievedCondition: string | null;
  turns: number;
  tokenSpend: number;
  checkpoints: number;
  consecutiveFailures: number;
  attempts: number;
  runtimeMs: number;
  lastReason: string;
  branch: string | null;
}

export interface TurnResult {
  result: WorkerResult;
  evaluation: Evaluation;
  checkpoint?: GoalCheckpoint;
  status: GoalStatus;
}

export interface RunResult {
  status: GoalStatus;
  checkpoints: GoalCheckpoint[];
  turnsRun: number;
}

export type CheckpointCadencePolicy =
  | 'every-turn'
  | ((ctx: { turn: number; validationPassed: boolean; evaluation: Evaluation }) => boolean);

export interface GoalRunnerOptions {
  store?: GoalStore;
  autopilot?: boolean;
  now?: () => string;
  idFactory?: (objective: string) => string;
  cadence?: CheckpointCadencePolicy;
  /** Auto-pause after this many consecutive failures on the same slice. Default 2. */
  maxConsecutiveFailures?: number;
  /** Emit lifecycle events to the crew event bus. Default true. */
  emitEvents?: boolean;
  /** Optional lifecycle hook (in addition to the event bus). */
  onEvent?: (type: EventType, data: Record<string, unknown>) => void;
}

function defaultIdFactory(objective: string): string {
  const slug =
    objective
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'goal';
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${slug}-${suffix}`;
}

export class GoalRunner {
  private readonly store: GoalStore;
  private readonly autopilot: boolean;
  private readonly now: () => string;
  private readonly idFactory: (objective: string) => string;
  private readonly cadence: CheckpointCadencePolicy;
  private readonly maxConsecutiveFailures: number;
  private readonly emitEvents: boolean;
  private readonly onEvent?: (type: EventType, data: Record<string, unknown>) => void;

  private record: GoalRecord | null = null;
  private working: WorkingState | null = null;
  private evaluations: Evaluation[] = [];

  constructor(options: GoalRunnerOptions = {}) {
    this.store = options.store ?? new GoalStore();
    this.autopilot = options.autopilot ?? true;
    this.now = options.now ?? this.store.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.cadence = options.cadence ?? 'every-turn';
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 2;
    this.emitEvents = options.emitEvents ?? true;
    this.onEvent = options.onEvent;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Start (or replace) the goal. Validates the 7-field contract, clears any
   * prior active goal (one active goal per session), persists the durable
   * contract, and resets the working counters.
   */
  start(input: Partial<GoalContract>, opts: { branch?: string; autopilot?: boolean } = {}): GoalRecord {
    const contract = normalizeContract(input); // throws on incomplete/unverifiable

    const priorActive = this.store.findActive();
    if (priorActive) this.clearRecord(priorActive, 'replaced by a new goal');
    if (this.record && this.working && this.working.state === 'active' && this.record.id !== priorActive?.id) {
      this.clearRecord(this.record, 'replaced by a new goal');
    }

    const id = this.idFactory(contract.objective);
    const ts = this.now();
    const record: GoalRecord = {
      id,
      contract,
      state: 'active',
      branch: opts.branch,
      autopilot: opts.autopilot ?? this.autopilot,
      createdAt: ts,
      updatedAt: ts,
      achievedCondition: null,
    };
    this.record = record;
    this.working = {
      goalId: id,
      state: 'active',
      turns: 0,
      tokenSpend: 0,
      consecutiveFailures: 0,
      attempts: 0,
      checkpointCount: 0,
      plan: [],
      startedAt: ts,
      lastReason: 'goal set',
      achievedCondition: null,
    };
    this.evaluations = [];
    this.store.writeRecord(record);
    this.emit('goal:started', { goalId: id, objective: contract.objective });
    return record;
  }

  /** Alias for {@link start}. */
  setObjective(input: Partial<GoalContract>, opts: { branch?: string; autopilot?: boolean } = {}): GoalRecord {
    return this.start(input, opts);
  }

  pause(): GoalStatus {
    const { working, record } = this.requireActive('pause');
    working.state = 'paused';
    record.state = 'paused';
    working.lastReason = 'paused';
    this.persist();
    this.emit('goal:paused', { goalId: working.goalId });
    return this.status();
  }

  /** Re-prime from the durable contract + last checkpoint, then continue. */
  resume(): GoalStatus {
    if (!this.working || !this.record) throw new Error('resume: no goal loaded');
    if (this.working.state !== 'paused') {
      throw new Error(`resume: requires paused state, got '${this.working.state}'`);
    }
    const fresh = this.store.readRecord(this.record.id);
    if (fresh) this.record = fresh;
    const checkpoints = this.store.readCheckpoints(this.record.id);
    this.working.lastCheckpoint = checkpoints[checkpoints.length - 1];
    this.working.checkpointCount = checkpoints.length;
    this.working.state = 'active';
    this.record.state = 'active';
    this.working.consecutiveFailures = 0;
    this.working.lastReason = 'resumed';
    this.persist();
    this.emit('goal:resumed', { goalId: this.working.goalId });
    return this.status();
  }

  /** Clear the goal (aliases: stop/off/reset/none/cancel). Writes a retrospective; keeps history. */
  clear(reason: string = 'clear'): GoalStatus {
    if (!this.working || !this.record) throw new Error('clear: no goal loaded');
    const normalized = isClearAlias(reason) ? reason.trim().toLowerCase() : reason;
    this.clearRecord(this.record, normalized);
    this.working.state = 'cleared';
    this.working.achievedCondition = this.record.achievedCondition ?? this.working.achievedCondition ?? null;
    this.working.lastReason = `goal ${normalized}`;
    this.emit('goal:cleared', { goalId: this.working.goalId, reason: normalized });
    return this.status();
  }

  status(): GoalStatus {
    if (!this.working || !this.record) {
      return {
        goalId: null,
        state: 'idle',
        objective: null,
        activeCondition: null,
        achievedCondition: null,
        turns: 0,
        tokenSpend: 0,
        checkpoints: 0,
        consecutiveFailures: 0,
        attempts: 0,
        runtimeMs: 0,
        lastReason: '',
        branch: null,
      };
    }
    const w = this.working;
    const r = this.record;
    const runtimeMs = Date.parse(this.now()) - Date.parse(w.startedAt);
    return {
      goalId: w.goalId,
      state: w.state,
      objective: r.contract.objective,
      activeCondition: w.state === 'active' ? r.contract.stoppingCondition : null,
      achievedCondition: w.achievedCondition ?? r.achievedCondition ?? null,
      turns: w.turns,
      tokenSpend: w.tokenSpend,
      checkpoints: w.checkpointCount,
      consecutiveFailures: w.consecutiveFailures,
      attempts: w.attempts,
      runtimeMs: Number.isFinite(runtimeMs) ? Math.max(0, runtimeMs) : 0,
      lastReason: w.lastReason,
      branch: r.branch ?? null,
    };
  }

  /** Full contract (equivalent to `/goal show`). */
  show(): { record: GoalRecord; contract: GoalContract; markdown: string } | null {
    if (!this.record) return null;
    return {
      record: this.record,
      contract: this.record.contract,
      markdown: contractToMarkdown(this.record.contract, {
        id: this.record.id,
        state: this.record.state,
        branch: this.record.branch,
        startedAt: this.record.createdAt,
        lastCheckpointAt: this.record.updatedAt,
        autopilot: this.record.autopilot,
      }),
    };
  }

  /** Force-write a checkpoint now (equivalent to `/goal checkpoint`). Idempotent. */
  checkpoint(input: { title?: string; verified?: string; remains?: string; passed?: boolean } = {}): GoalCheckpoint {
    const { working, record } = this.requireLoaded('checkpoint');
    const title = input.title ?? `manual checkpoint at turn ${working.turns}`;
    const verified = input.verified ?? '';
    const reason = `manual checkpoint: ${verified || 'progress recorded'}`;
    const draft: GoalCheckpointDraft = {
      goalId: working.goalId,
      turn: working.turns,
      timestamp: this.now(),
      title,
      verified,
      remains: input.remains ?? '',
      blocked: null,
      validation: { passed: input.passed ?? true, attempt: working.attempts },
      evidence: { reason },
      evaluatorId: 'manual',
      progress: working.lastEvaluation?.progress ?? 0,
      key: checkpointKey({ goalId: working.goalId, turn: working.turns, title, verified, reason }),
    };
    const { checkpoint, appended } = this.store.appendCheckpoint(draft);
    working.checkpointCount = this.store.readCheckpoints(working.goalId).length;
    working.lastCheckpoint = checkpoint;
    if (appended) {
      record.updatedAt = checkpoint.timestamp;
      this.store.writeRecord(record);
      this.emit('goal:checkpoint', { goalId: working.goalId, checkpointNumber: checkpoint.checkpointNumber, manual: true });
    }
    return checkpoint;
  }

  // ── Run loop ─────────────────────────────────────────────────────────

  /** Run one turn: worker → separate evaluator → checkpoint → stop-check. */
  async runTurn(worker: Worker, evaluator: Evaluator): Promise<TurnResult> {
    const { working, record } = this.requireActive('runTurn');
    assertSeparateEvaluator(worker, evaluator);

    const context: WorkerTurnContext = {
      contract: record.contract,
      turn: working.turns + 1,
      plan: working.plan,
      lastEvaluation: working.lastEvaluation,
    };
    const result = await worker.runTurn(context);
    if (result.workerId === evaluator.id) throw new EvaluatorSeparationError(evaluator.id);

    working.turns += 1;
    working.tokenSpend += result.tokens ?? 0;
    working.attempts = nextAttempt(working.attempts);

    const commandSurfaced = typeof result.command === 'string' && result.command.trim().length > 0;
    const validationRan = commandSurfaced && result.exitCode !== undefined;
    const validationPassed = validationRan ? result.exitCode === 0 : true;
    const validationFailed = validationRan && result.exitCode !== 0;

    if (validationFailed) {
      working.consecutiveFailures = result.sameSlice === false ? 1 : working.consecutiveFailures + 1;
    } else {
      working.consecutiveFailures = 0;
    }

    const evaluation = await evaluator.evaluate(record.contract, result, this.evaluations);
    this.evaluations.push(evaluation);
    working.lastEvaluation = evaluation;
    working.lastReason = evaluation.evidence.reason;

    const autoPause = working.consecutiveFailures >= this.maxConsecutiveFailures;
    const cadenceFires = this.shouldCheckpoint({ turn: working.turns, validationPassed, evaluation });

    let checkpoint: GoalCheckpoint | undefined;
    if (evaluation.conditionMet || cadenceFires || autoPause) {
      checkpoint = this.writeCheckpoint({
        working,
        record,
        result,
        evaluation,
        validationPassed,
        autoPause,
        title: evaluation.conditionMet ? `turn ${working.turns}: stopping condition met` : undefined,
      });
    }

    if (evaluation.conditionMet) {
      working.state = 'completed';
      record.state = 'completed';
      working.achievedCondition = record.contract.stoppingCondition;
      record.achievedCondition = record.contract.stoppingCondition;
      record.updatedAt = this.now();
      this.store.writeRecord(record);
      this.store.writeRetrospective(record.id, this.buildRetrospective(record, 'completed'));
      this.store.stage(record.id);
      this.emit('goal:completed', { goalId: working.goalId, condition: record.contract.stoppingCondition });
    } else if (autoPause) {
      working.state = 'paused';
      record.state = 'paused';
      working.lastReason = `auto-paused after ${working.consecutiveFailures} consecutive validation failures`;
      this.persist();
      this.emit('goal:paused', { goalId: working.goalId, auto: true });
    } else {
      this.persist();
    }

    return { result, evaluation, checkpoint, status: this.status() };
  }

  /** Run turns until the goal completes, auto-pauses, or the turn cap is hit. */
  async run(worker: Worker, evaluator: Evaluator, opts: { maxTurns?: number } = {}): Promise<RunResult> {
    assertSeparateEvaluator(worker, evaluator);
    const maxTurns = opts.maxTurns ?? 50;
    let turnsRun = 0;
    while (this.working && this.working.state === 'active' && turnsRun < maxTurns) {
      await this.runTurn(worker, evaluator);
      turnsRun += 1;
    }
    return {
      status: this.status(),
      checkpoints: this.working ? this.store.readCheckpoints(this.working.goalId) : [],
      turnsRun,
    };
  }

  // ── Durable ↔ working rehydration ────────────────────────────────────

  /** Load the single active goal from durable storage into working memory. */
  loadActive(): GoalRecord | null {
    const active = this.store.findActive();
    return active ? this.load(active.id) : null;
  }

  /** Hydrate working state from a durable record + its checkpoint log. */
  load(id: string): GoalRecord | null {
    const record = this.store.readRecord(id);
    if (!record) return null;
    const checkpoints = this.store.readCheckpoints(id);
    const last = checkpoints[checkpoints.length - 1];
    this.record = record;
    this.working = {
      goalId: id,
      state: record.state,
      turns: last?.turn ?? 0,
      tokenSpend: 0, // working-tier only; not persisted durably
      consecutiveFailures: 0,
      attempts: last?.validation.attempt ?? 0,
      checkpointCount: checkpoints.length,
      plan: [],
      startedAt: record.createdAt,
      lastReason: last?.evidence.reason ?? record.state,
      lastCheckpoint: last,
      achievedCondition: record.achievedCondition ?? null,
    };
    this.evaluations = [];
    return record;
  }

  getStore(): GoalStore {
    return this.store;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private shouldCheckpoint(ctx: { turn: number; validationPassed: boolean; evaluation: Evaluation }): boolean {
    return this.cadence === 'every-turn' ? true : this.cadence(ctx);
  }

  private writeCheckpoint(args: {
    working: WorkingState;
    record: GoalRecord;
    result: WorkerResult;
    evaluation: Evaluation;
    validationPassed: boolean;
    autoPause: boolean;
    title?: string;
  }): GoalCheckpoint {
    const { working, record, result, evaluation, validationPassed, autoPause } = args;
    const title = (args.title ?? `turn ${working.turns}: ${result.summary}`).slice(0, 140);
    const verified = validationPassed ? result.summary || 'slice complete' : 'validation failing';
    const remains = evaluation.conditionMet ? 'none' : 'stopping condition not yet met';
    const blocked = autoPause ? `auto-paused after ${working.consecutiveFailures} consecutive failures` : null;
    const draft: GoalCheckpointDraft = {
      goalId: working.goalId,
      turn: working.turns,
      timestamp: this.now(),
      title,
      verified,
      remains,
      blocked,
      validation: {
        command: result.command,
        result: result.result,
        passed: validationPassed,
        attempt: working.attempts,
      },
      evidence: evaluation.evidence,
      evaluatorId: evaluation.evaluatorId,
      progress: evaluation.progress,
      key: checkpointKey({
        goalId: working.goalId,
        turn: working.turns,
        title,
        verified,
        validationResult: result.result,
        reason: evaluation.evidence.reason,
      }),
    };
    const { checkpoint, appended } = this.store.appendCheckpoint(draft);
    working.checkpointCount = this.store.readCheckpoints(working.goalId).length;
    working.lastCheckpoint = checkpoint;
    if (appended) {
      record.updatedAt = checkpoint.timestamp;
      this.store.writeRecord(record);
      this.emit('goal:checkpoint', { goalId: working.goalId, checkpointNumber: checkpoint.checkpointNumber });
    }
    return checkpoint;
  }

  private buildRetrospective(record: GoalRecord, reason: string): string {
    const checkpoints = this.store.readCheckpoints(record.id);
    const shipped = checkpoints.filter(c => c.validation.passed).map(c => `- ${c.title}`);
    return [
      `# Retrospective: ${record.contract.objective}`,
      '',
      `**Outcome:** ${reason}`,
      `**State:** ${record.state}`,
      `**Checkpoints:** ${checkpoints.length}`,
      `**Generated:** ${this.now()}`,
      '',
      '## What shipped',
      shipped.length ? shipped.join('\n') : '- (no passing checkpoints recorded)',
      '',
      '## Stopping condition',
      `- ${record.contract.stoppingCondition}`,
      `- Verified: ${record.achievedCondition ? 'yes' : 'no'}`,
      '',
      '## Constraints held',
      record.contract.constraints.length ? record.contract.constraints.map(c => `- ${c}`).join('\n') : '- (none)',
      '',
    ].join('\n');
  }

  private clearRecord(record: GoalRecord, reason: string): void {
    record.state = 'cleared';
    record.updatedAt = this.now();
    this.store.writeRecord(record);
    this.store.writeRetrospective(record.id, this.buildRetrospective(record, reason));
    this.store.stage(record.id);
  }

  private persist(): void {
    if (!this.record || !this.working) return;
    this.record.updatedAt = this.now();
    this.store.writeRecord(this.record);
  }

  private requireLoaded(action: string): { working: WorkingState; record: GoalRecord } {
    if (!this.working || !this.record) throw new Error(`${action}: no goal loaded`);
    return { working: this.working, record: this.record };
  }

  private requireActive(action: string): { working: WorkingState; record: GoalRecord } {
    const { working, record } = this.requireLoaded(action);
    if (working.state !== 'active') {
      throw new Error(`${action}: requires an active goal, got '${working.state}'`);
    }
    return { working, record };
  }

  private emit(type: EventType, data: Record<string, unknown>): void {
    if (this.emitEvents) eventBus.emit(type, data);
    this.onEvent?.(type, data);
  }
}

// ── Crew integration ───────────────────────────────────────────────────

export interface CrewStepContext extends WorkerTurnContext {
  crew: Crew;
}

/**
 * Wrap a crew run as a {@link Worker}: each turn calls `step`, which runs the
 * crew's next slice and surfaces the evidence the evaluator will grade. This is
 * the seam that puts a crew run under a goal loop without the worker grading
 * itself.
 */
export function crewWorker(
  crew: Crew,
  step: (context: CrewStepContext) => Omit<WorkerResult, 'workerId'> | Promise<Omit<WorkerResult, 'workerId'>>,
  id?: string,
): Worker {
  const workerId = id ?? `crew:${crew.name}`;
  return {
    id: workerId,
    async runTurn(context) {
      const partial = await step({ ...context, crew });
      return { ...partial, workerId };
    },
  };
}
