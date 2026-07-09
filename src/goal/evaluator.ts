/**
 * Evaluator abstraction for the goal loop.
 *
 * The worker performs one slice of work per turn and *surfaces* evidence
 * (a summary plus, optionally, the validation command it ran and that
 * command's result/exit code). A **separate** evaluator then grades progress
 * from that surfaced evidence alone — the worker never grades itself. The
 * interface is the pluggable seam: a2a-crews' model/provider layer can supply
 * any grader via {@link functionEvaluator} or a custom {@link Evaluator}.
 */

import type { GoalContract } from './contract';

/** Auditable evidence attached to every evaluation (reason/command/result). */
export interface Evidence {
  reason: string;
  command?: string;
  result?: string;
}

/**
 * Result surfaced by the worker for a single turn/slice. The evaluator may only
 * read what the worker surfaces here; it does not re-run the work.
 */
export interface WorkerResult {
  /** Identity of the worker that produced this result. Must differ from the evaluator. */
  workerId: string;
  turn: number;
  /** Compact description of the slice the worker completed this turn. */
  summary: string;
  /** Validation command the worker ran (if any). */
  command?: string;
  /** Surfaced output of the validation command (truncated transcript). */
  result?: string;
  /** Exit code of the validation command (0 = success). */
  exitCode?: number;
  /** Tokens spent this turn (for budget tracking). */
  tokens?: number;
  /** True when this slice targets the same failing area as the previous turn. */
  sameSlice?: boolean;
}

export interface Evaluation {
  conditionMet: boolean;
  /** 0..1 fraction of the stopping condition's checks satisfied by surfaced evidence. */
  progress: number;
  evidence: Evidence;
  /** Identity of the evaluator (proves separation from the worker). */
  evaluatorId: string;
}

export interface WorkerTurnContext {
  contract: GoalContract;
  turn: number;
  plan: readonly string[];
  lastEvaluation?: Evaluation;
}

/** A worker performs one slice of work per turn. Distinct from the evaluator. */
export interface Worker {
  readonly id: string;
  runTurn(context: WorkerTurnContext): WorkerResult | Promise<WorkerResult>;
}

/** A separate grader. The worker never grades itself; a distinct evaluator does. */
export interface Evaluator {
  readonly id: string;
  evaluate(
    contract: GoalContract,
    result: WorkerResult,
    history: readonly Evaluation[],
  ): Evaluation | Promise<Evaluation>;
}

/** Thrown when the evaluator is not separate from the worker. */
export class EvaluatorSeparationError extends Error {
  constructor(id: string) {
    super(`evaluator must be separate from the worker (both had id "${id}"); the worker cannot grade itself`);
    this.name = 'EvaluatorSeparationError';
  }
}

/**
 * Assert the evaluator is distinct from the worker. Enforces the core rule that
 * post-turn evaluation uses a separate grader, not the worker model.
 */
export function assertSeparateEvaluator(worker: { id: string }, evaluator: { id: string }): void {
  if (worker.id === evaluator.id) {
    throw new EvaluatorSeparationError(worker.id);
  }
}

type ThresholdOp = '>=' | '<=' | '>' | '<' | '==';
interface Threshold {
  op: ThresholdOp;
  value: number;
}

const THRESHOLD_RE = /(>=|<=|==|>|<|=)\s*(\d+(?:\.\d+)?)/g;
const NUMBER_RE = /\d+(?:\.\d+)?/g;
const POSITIVE_SIGNAL =
  /\b(?:pass(?:es|ed|ing)?|green|success(?:ful)?|succeeded|0\s+(?:matches|errors|failures)|no\s+(?:matches|errors|failures)|all tests? (?:pass|passed|green)|ok)\b/i;

function parseThresholds(condition: string): Threshold[] {
  const out: Threshold[] = [];
  let m: RegExpExecArray | null;
  THRESHOLD_RE.lastIndex = 0;
  while ((m = THRESHOLD_RE.exec(condition)) !== null) {
    const op = (m[1] === '=' ? '==' : m[1]) as ThresholdOp;
    out.push({ op, value: parseFloat(m[2]) });
  }
  return out;
}

function numbersIn(text: string): number[] {
  return (text.match(NUMBER_RE) ?? []).map(parseFloat);
}

function thresholdSatisfied(t: Threshold, nums: readonly number[]): boolean {
  return nums.some(n => {
    switch (t.op) {
      case '>=':
        return n >= t.value;
      case '<=':
        return n <= t.value;
      case '>':
        return n > t.value;
      case '<':
        return n < t.value;
      case '==':
        return n === t.value;
      default:
        return false;
    }
  });
}

function truncate(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface DefaultEvaluatorOptions {
  id?: string;
}

/**
 * Conservative default grader. It declares the goal met only when the worker
 * surfaces a *clean validation run* (a command with exit code 0) AND every
 * numeric threshold in the stopping condition is satisfied by a number in the
 * surfaced output AND the surfaced output shows a positive signal
 * (pass/green/0 errors/success). It never trusts a worker's self-assessment;
 * it reads only surfaced command/result evidence. Richer graders can be
 * plugged via {@link functionEvaluator} or a custom {@link Evaluator}.
 */
export class DefaultEvaluator implements Evaluator {
  readonly id: string;

  constructor(options: DefaultEvaluatorOptions = {}) {
    this.id = options.id ?? 'default-evaluator';
  }

  evaluate(contract: GoalContract, result: WorkerResult): Evaluation {
    const surfaced = `${result.summary}\n${result.result ?? ''}`;
    const thresholds = parseThresholds(contract.stoppingCondition);
    const nums = numbersIn(surfaced);

    const commandSurfaced = typeof result.command === 'string' && result.command.trim().length > 0;
    const cleanExit = commandSurfaced && result.exitCode === 0;
    const positive = POSITIVE_SIGNAL.test(surfaced);

    // Individual checks that contribute to progress.
    const checks: boolean[] = [cleanExit, positive, ...thresholds.map(t => thresholdSatisfied(t, nums))];
    const passed = checks.filter(Boolean).length;
    const progress = checks.length === 0 ? 0 : passed / checks.length;

    const thresholdsOk = thresholds.every(t => thresholdSatisfied(t, nums));
    const conditionMet = cleanExit && positive && thresholdsOk;

    const reason = conditionMet
      ? `stopping condition satisfied: clean validation (exit 0), positive signal, ${thresholds.length} threshold(s) met`
      : [
          cleanExit ? 'validation clean' : commandSurfaced ? `validation exit ${result.exitCode}` : 'no validation surfaced',
          positive ? 'positive signal' : 'no positive signal',
          thresholds.length ? `${thresholds.filter(t => thresholdSatisfied(t, nums)).length}/${thresholds.length} thresholds` : 'no thresholds',
        ].join('; ');

    const evidence: Evidence = { reason };
    if (result.command !== undefined) evidence.command = result.command;
    const trimmedResult = truncate(result.result, 600);
    if (trimmedResult !== undefined) evidence.result = trimmedResult;

    return { conditionMet, progress, evaluatorId: this.id, evidence };
  }
}

/**
 * Wrap a plain grading function as an {@link Evaluator}. Lets a model/provider
 * hook supply the grader while the runner enforces separation from the worker.
 */
export function functionEvaluator(
  id: string,
  fn: (
    contract: GoalContract,
    result: WorkerResult,
    history: readonly Evaluation[],
  ) => Omit<Evaluation, 'evaluatorId'> | Promise<Omit<Evaluation, 'evaluatorId'>>,
): Evaluator {
  return {
    id,
    async evaluate(contract, result, history) {
      const partial = await fn(contract, result, history);
      return { ...partial, evaluatorId: id };
    },
  };
}

/** Wrap a plain function as a {@link Worker}. */
export function functionWorker(
  id: string,
  fn: (context: WorkerTurnContext) => Omit<WorkerResult, 'workerId'> | Promise<Omit<WorkerResult, 'workerId'>>,
): Worker {
  return {
    id,
    async runTurn(context) {
      const partial = await fn(context);
      return { ...partial, workerId: id };
    },
  };
}
