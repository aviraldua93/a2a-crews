import { describe, expect, test } from 'bun:test';
import {
  contractToMarkdown,
  isStoppingConditionVerifiable,
  normalizeContract,
  REQUIRED_CONTRACT_FIELDS,
  validateContract,
  type GoalContract,
} from '../src/goal';

function validContract(overrides: Partial<GoalContract> = {}): Partial<GoalContract> {
  return {
    objective: 'Migrate the router to the new API',
    stoppingCondition: '`bun test` exits 0 and coverage >= 80%',
    validationLoop: 'bun test',
    inputsToReadFirst: ['src/router.ts'],
    constraints: ['No route shape changes'],
    forbiddenMoves: ['Do not open a PR'],
    checkpointCadence: 'every file migrated + tests green',
    ...overrides,
  };
}

// ── Contract completeness ───────────────────────────────────────────

describe('validateContract — completeness', () => {
  test('accepts a complete 7-field contract', () => {
    const result = validateContract(validContract());
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('ExecutionContext is optional', () => {
    const withCtx = validContract({ executionContext: { cwd: '/repo', shell: 'pwsh' } });
    expect(validateContract(withCtx).valid).toBe(true);
    expect(validateContract(validContract()).valid).toBe(true);
  });

  test('flags every missing required field', () => {
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      const partial = validContract();
      delete (partial as Record<string, unknown>)[field];
      const result = validateContract(partial);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain(field);
    }
  });

  test('treats empty strings and empty arrays as missing', () => {
    const blankString = validateContract(validContract({ objective: '   ' }));
    expect(blankString.missing).toContain('objective');

    const emptyArray = validateContract(validContract({ constraints: [] }));
    expect(emptyArray.missing).toContain('constraints');

    const blankArrayEntries = validateContract(validContract({ forbiddenMoves: ['', '   '] }));
    expect(blankArrayEntries.missing).toContain('forbiddenMoves');
  });

  test('null/undefined input reports all fields missing', () => {
    expect(validateContract(null).missing.length).toBe(REQUIRED_CONTRACT_FIELDS.length);
    expect(validateContract(undefined).valid).toBe(false);
  });
});

// ── Stopping-condition verifiability ────────────────────────────────

describe('isStoppingConditionVerifiable', () => {
  test('accepts runnable / measurable / observable conditions', () => {
    expect(isStoppingConditionVerifiable('`bun test` exits 0')).toBe(true);
    expect(isStoppingConditionVerifiable('coverage >= 80%')).toBe(true);
    expect(isStoppingConditionVerifiable('rg "gin\\." returns 0 matches')).toBe(true);
    expect(isStoppingConditionVerifiable('the test suite passes')).toBe(true);
    expect(isStoppingConditionVerifiable('produces a summary file at pr-summary.md')).toBe(true);
  });

  test('rejects vibe-only conditions', () => {
    expect(isStoppingConditionVerifiable('make it better')).toBe(false);
    expect(isStoppingConditionVerifiable('looks good')).toBe(false);
    expect(isStoppingConditionVerifiable('done')).toBe(false);
    expect(isStoppingConditionVerifiable('improve it')).toBe(false);
  });

  test('rejects empty or too-short conditions', () => {
    expect(isStoppingConditionVerifiable('')).toBe(false);
    expect(isStoppingConditionVerifiable('ok')).toBe(false);
  });

  test('validateContract surfaces an unverifiable stopping condition as an error', () => {
    const result = validateContract(validContract({ stoppingCondition: 'make it nicer' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('transcript-verifiable'))).toBe(true);
  });
});

// ── Normalization + markdown ────────────────────────────────────────

describe('normalizeContract', () => {
  test('trims strings and drops blank array entries', () => {
    const contract = normalizeContract(
      validContract({
        objective: '  Migrate router  ',
        inputsToReadFirst: ['src/router.ts', '', '  '],
        constraints: ['  No route changes  '],
      }),
    );
    expect(contract.objective).toBe('Migrate router');
    expect(contract.inputsToReadFirst).toEqual(['src/router.ts']);
    expect(contract.constraints).toEqual(['No route changes']);
  });

  test('throws on an invalid contract', () => {
    expect(() => normalizeContract(validContract({ objective: '' }))).toThrow(/Invalid goal contract/);
    expect(() => normalizeContract(validContract({ stoppingCondition: 'looks good' }))).toThrow(
      /transcript-verifiable/,
    );
  });
});

describe('contractToMarkdown', () => {
  test('renders every field with metadata', () => {
    const md = contractToMarkdown(normalizeContract(validContract()), { id: 'g1', state: 'active', autopilot: true });
    expect(md).toContain('# Goal: Migrate the router to the new API');
    expect(md).toContain('**State:** active');
    expect(md).toContain('**Stopping condition:**');
    expect(md).toContain('**Validation loop:** `bun test`');
    expect(md).toContain('**Forbidden moves:**');
    expect(md).toContain('**Checkpoint cadence:**');
  });
});
