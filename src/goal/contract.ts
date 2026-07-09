/**
 * Goal contract — the durable, verifiable agreement that drives an autonomous
 * goal loop.
 *
 * A goal is a 7-field contract. Every field is required before a goal can
 * activate; missing any one means the runner refuses to start. The stopping
 * condition must be transcript/state-verifiable so a *separate* evaluator can
 * judge completion from surfaced evidence alone — it never re-runs the work.
 */

export type GoalState = 'draft' | 'active' | 'paused' | 'completed' | 'cleared';

/** Clear aliases accepted by the lifecycle (mirrors the /goal contract). */
export const CLEAR_ALIASES = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'] as const;
export type ClearAlias = typeof CLEAR_ALIASES[number];

export function isClearAlias(word: string): word is ClearAlias {
  return (CLEAR_ALIASES as readonly string[]).includes(word.trim().toLowerCase());
}

/** Optional but strongly recommended context describing where/how the loop runs. */
export interface ExecutionContext {
  cwd?: string;
  shell?: string;
  timeoutSeconds?: number;
  requiredServices?: string[];
  networkPolicy?: string;
  sideEffectBoundaries?: string;
}

/** The 7-field goal contract (+ optional execution context). */
export interface GoalContract {
  /** One sentence: what the agent is trying to achieve. */
  objective: string;
  /** Exactly when to stop. Must be runnable or observable (transcript-verifiable). */
  stoppingCondition: string;
  /** Command(s) that prove progress at every checkpoint. */
  validationLoop: string;
  /** Files, docs, issues, logs to read before acting. */
  inputsToReadFirst: string[];
  /** Hard rules that must hold throughout. */
  constraints: string[];
  /** Specific actions the agent must not take. */
  forbiddenMoves: string[];
  /** How often to write a progress entry and what proves a checkpoint complete. */
  checkpointCadence: string;
  /** Optional execution context (cwd, shell, timeout, services, side-effects). */
  executionContext?: ExecutionContext;
}

export const REQUIRED_CONTRACT_FIELDS = [
  'objective',
  'stoppingCondition',
  'validationLoop',
  'inputsToReadFirst',
  'constraints',
  'forbiddenMoves',
  'checkpointCadence',
] as const;

export type RequiredContractField = typeof REQUIRED_CONTRACT_FIELDS[number];

const ARRAY_FIELDS: readonly RequiredContractField[] = [
  'inputsToReadFirst',
  'constraints',
  'forbiddenMoves',
];

export interface ContractValidation {
  valid: boolean;
  missing: RequiredContractField[];
  errors: string[];
}

/**
 * Signals that make a stopping condition transcript-verifiable: a runnable
 * command, a measurable threshold, or an observable artifact.
 */
const VERIFICATION_SIGNALS: readonly RegExp[] = [
  /`[^`]+`/, // inline command or artifact in backticks
  /\bexit(?:s|ed|ing)?\b[^.]*\b\d+\b/i, // "exits 0", "exit code 0"
  /\bexit code\b/i,
  /\bpass(?:es|ing|ed)?\b/i,
  /\bgreen\b/i,
  /\b0\s+(?:matches|errors|failures|warnings)\b/i,
  /\bno\s+(?:matches|errors|failures|warnings)\b/i,
  /\breturns?\b/i,
  /\breports?\b/i,
  /\bsucceeds?\b/i,
  /[<>]=?\s*\d/, // threshold e.g. ">= 80"
  /\b\d+(?:\.\d+)?\s*%/, // percentage threshold
  /\b[\w./-]+\.(?:ts|js|tsx|jsx|py|go|json|md|txt|out|xml|yml|yaml|toml|lock|html|csv|cfg|ini)\b/i, // artifact file
  /\b(?:test|tests|suite|build|lint|typecheck|coverage|compiles?)\b/i,
];

/** Pure "vibe" conditions the evaluator could never judge — rejected outright. */
const VIBE_ONLY = /^(?:make it (?:better|nicer|good|work)|looks? good|done|finish(?:ed)?|improve(?: it)?|good enough|works?|ship it|clean it up|polish(?: it)?|be careful)\.?$/i;

/**
 * A stopping condition is verifiable when it references something an evaluator
 * can judge from surfaced evidence: a command, a measurable threshold, or an
 * observable artifact — and it is not a bare "vibe" phrase.
 */
export function isStoppingConditionVerifiable(condition: string): boolean {
  const c = (condition ?? '').trim();
  if (c.length < 8) return false;
  if (VIBE_ONLY.test(c)) return false;
  return VERIFICATION_SIGNALS.some(rx => rx.test(c));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate contract completeness + stopping-condition verifiability. */
export function validateContract(partial: Partial<GoalContract> | null | undefined): ContractValidation {
  const c = (partial ?? {}) as Record<string, unknown>;
  const missing: RequiredContractField[] = [];
  const errors: string[] = [];

  for (const field of REQUIRED_CONTRACT_FIELDS) {
    const value = c[field];
    if (ARRAY_FIELDS.includes(field)) {
      if (!Array.isArray(value) || value.length === 0 || !value.some(isNonEmptyString)) {
        missing.push(field);
      }
    } else if (!isNonEmptyString(value)) {
      missing.push(field);
    }
  }

  if (isNonEmptyString(c.stoppingCondition) && !isStoppingConditionVerifiable(c.stoppingCondition as string)) {
    errors.push(
      'stoppingCondition is not transcript-verifiable: reference a runnable command, ' +
        'a measurable threshold, or an observable artifact',
    );
  }

  return { valid: missing.length === 0 && errors.length === 0, missing, errors };
}

/** Trim strings and drop empty array entries, producing a validated contract. */
export function normalizeContract(partial: Partial<GoalContract>): GoalContract {
  const validation = validateContract(partial);
  if (!validation.valid) {
    const problems = [
      validation.missing.length ? `missing: ${validation.missing.join(', ')}` : '',
      ...validation.errors,
    ].filter(Boolean);
    throw new Error(`Invalid goal contract — ${problems.join('; ')}`);
  }

  const cleanArray = (values: string[] | undefined): string[] =>
    (values ?? []).map(v => v.trim()).filter(v => v.length > 0);

  const contract: GoalContract = {
    objective: partial.objective!.trim(),
    stoppingCondition: partial.stoppingCondition!.trim(),
    validationLoop: partial.validationLoop!.trim(),
    inputsToReadFirst: cleanArray(partial.inputsToReadFirst),
    constraints: cleanArray(partial.constraints),
    forbiddenMoves: cleanArray(partial.forbiddenMoves),
    checkpointCadence: partial.checkpointCadence!.trim(),
  };
  if (partial.executionContext) {
    contract.executionContext = partial.executionContext;
  }
  return contract;
}

export interface ContractMarkdownMeta {
  id?: string;
  state?: GoalState;
  branch?: string;
  startedAt?: string;
  lastCheckpointAt?: string;
  autopilot?: boolean;
}

function bullets(items: string[]): string {
  return items.length ? items.map(i => `  - ${i}`).join('\n') : '  - (none)';
}

/** Render a human-readable, git-trackable goal contract (mirrors the template). */
export function contractToMarkdown(contract: GoalContract, meta: ContractMarkdownMeta = {}): string {
  const ctx = contract.executionContext;
  const lines: string[] = [
    `# Goal: ${contract.objective}`,
    '',
    `**State:** ${meta.state ?? 'draft'}`,
  ];
  if (meta.id) lines.push(`**Id:** ${meta.id}`);
  if (meta.branch) lines.push(`**Branch:** ${meta.branch}`);
  if (meta.startedAt) lines.push(`**Started:** ${meta.startedAt}`);
  if (meta.lastCheckpointAt) lines.push(`**Last checkpoint:** ${meta.lastCheckpointAt}`);
  if (meta.autopilot !== undefined) lines.push(`**Autopilot:** ${meta.autopilot ? 'yes' : 'no'}`);
  lines.push(
    '',
    '## Contract',
    '',
    `- **Objective:** ${contract.objective}`,
    `- **Stopping condition:** ${contract.stoppingCondition}`,
    `- **Validation loop:** \`${contract.validationLoop}\``,
    '- **Inputs to read first:**',
    bullets(contract.inputsToReadFirst),
    '- **Constraints:**',
    bullets(contract.constraints),
    '- **Forbidden moves:**',
    bullets(contract.forbiddenMoves),
    `- **Checkpoint cadence:** ${contract.checkpointCadence}`,
  );
  if (ctx) {
    lines.push('- **Execution context:**');
    if (ctx.cwd) lines.push(`  - cwd: \`${ctx.cwd}\``);
    if (ctx.shell) lines.push(`  - shell: \`${ctx.shell}\``);
    if (ctx.timeoutSeconds !== undefined) lines.push(`  - timeout per validation run: \`${ctx.timeoutSeconds}s\``);
    if (ctx.requiredServices?.length) lines.push(`  - required services: ${ctx.requiredServices.join(', ')}`);
    if (ctx.networkPolicy) lines.push(`  - network/secrets policy: ${ctx.networkPolicy}`);
    if (ctx.sideEffectBoundaries) lines.push(`  - side-effect boundaries: ${ctx.sideEffectBoundaries}`);
  }
  lines.push('');
  return lines.join('\n');
}
