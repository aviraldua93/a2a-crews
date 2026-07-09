/**
 * Goal loop — durable, evaluator-graded autonomous work for a2a-crews.
 *
 * A goal is a 7-field contract with a transcript-verifiable stopping condition.
 * The {@link GoalRunner} drives a {@link Worker} toward that condition, grading
 * each turn with a *separate* {@link Evaluator}, checkpointing per cadence, and
 * persisting durable state under `audits/goals/<id>/`.
 *
 * @example
 * ```ts
 * import { GoalRunner, DefaultEvaluator, functionWorker } from './goal';
 *
 * const runner = new GoalRunner();
 * runner.start({
 *   objective: 'Migrate the router to the new API',
 *   stoppingCondition: '`bun test` exits 0 and coverage >= 80%',
 *   validationLoop: 'bun test',
 *   inputsToReadFirst: ['src/router.ts'],
 *   constraints: ['No route shape changes'],
 *   forbiddenMoves: ['Do not open a PR'],
 *   checkpointCadence: 'every file migrated + tests green',
 * });
 *
 * const worker = functionWorker('crew', () => ({
 *   turn: 1, summary: 'migrated router', command: 'bun test', result: 'coverage 82%', exitCode: 0,
 * }));
 * await runner.run(worker, new DefaultEvaluator());
 * ```
 */

export {
  CLEAR_ALIASES,
  contractToMarkdown,
  isClearAlias,
  isStoppingConditionVerifiable,
  normalizeContract,
  REQUIRED_CONTRACT_FIELDS,
  validateContract,
} from './contract';
export type {
  ClearAlias,
  ContractMarkdownMeta,
  ContractValidation,
  ExecutionContext,
  GoalContract,
  GoalState,
  RequiredContractField,
} from './contract';

export {
  assertSeparateEvaluator,
  DefaultEvaluator,
  EvaluatorSeparationError,
  functionEvaluator,
  functionWorker,
} from './evaluator';
export type {
  DefaultEvaluatorOptions,
  Evaluation,
  Evaluator,
  Evidence,
  Worker,
  WorkerResult,
  WorkerTurnContext,
} from './evaluator';

export {
  checkpointKey,
  defaultStage,
  GoalStore,
} from './store';
export type {
  GoalCheckpoint,
  GoalCheckpointDraft,
  GoalCheckpointValidation,
  GoalRecord,
  GoalStoreOptions,
  StageFn,
} from './store';

export {
  crewWorker,
  GoalRunner,
  nextAttempt,
} from './runner';
export type {
  CheckpointCadencePolicy,
  CrewStepContext,
  GoalRunnerOptions,
  GoalStatus,
  RunResult,
  TurnResult,
  WorkingState,
} from './runner';
