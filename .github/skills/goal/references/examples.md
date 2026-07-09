# Worked examples — `/goal` in a2a-crews

Four worked contracts spanning the common use cases: migration, coverage push, prototype,
and an eval/optimization loop. Every example targets this repository's stack — TypeScript on
Bun — so the validation loops are `bun test`, `bun x tsc --noEmit`, and `bun build`.

Timestamps in these examples are produced by the portable, machine-local command
(**never `date -u`**):

```bash
python -c "import datetime; print(datetime.datetime.now().strftime('%Y-%m-%d %H:%M'))"
```

---

## Example 1: Dependency migration (A2A SDK bump)

**Trigger:** "migrate `src/a2a` off the deprecated v0.3 client surface to v0.4"

**Agent's batched question** (one ask):

```
Locking down the goal contract:

1. Stopping condition — proposed: "git grep -n \"@a2a-js/sdk/v0.3\" src/ returns no
   matches AND bun test tests/interop.test.ts passes AND bun x tsc --noEmit is clean."
   Sound right? (Y / specify alternative)

2. Validation loop — proposed: `bun test && bun x tsc --noEmit`. Add anything else?

3. Inputs I should read first — I'll auto-detect by grepping for the v0.3 imports.
   Anything else mandatory? (e.g., a migration note in docs/)

4. Forbidden moves — proposed: "don't change agent-card shapes; don't add new
   dependencies beyond the v0.4 SDK; don't open a PR — leave on the local branch."
   OK?
```

**Resulting `audits/goals/<id>/contract.md`:**

```markdown
# Goal: Migrate src/a2a to @a2a-js/sdk v0.4

**State:** active
**Goal id:** 2026-07-09-a2a-sdk-v04
**Branch:** goal/a2a-sdk-v04
**Started:** 2026-07-09 21:00

## Contract

- **Objective:** Move src/a2a to the @a2a-js/sdk v0.4 client while preserving every
  agent-to-agent message shape.
- **Stopping condition:** `git grep -n "@a2a-js/sdk/v0.3" src/` returns no matches AND
  `bun test` passes AND `bun x tsc --noEmit` is clean.
- **Validation loop:** `bun test && bun x tsc --noEmit`
- **Inputs to read first:**
  - `src/a2a/client.ts` — current client wiring
  - `src/a2a/bridge.ts` — message translation to port
  - `tests/interop.test.ts` — behavior contract to preserve
- **Constraints:**
  - No agent-card or message shape changes
  - No new dependencies except the v0.4 SDK
  - All tests must pass at every checkpoint
- **Forbidden moves:**
  - Don't change message shapes to make tests pass
  - Don't open a PR
  - Don't commit to master
- **Checkpoint cadence:** every file fully migrated + tests green
```

**Run loop highlights:**

- Checkpoint 1: ported `client.ts` to the v0.4 factory; tests green; commit `a1b2c3`.
- Checkpoint 2: ported `bridge.ts` translation; tests green; commit `d4e5f6`.
- Checkpoint 3: removed the discovery shim; **validation FAILED** — interop test expects
  a `contextId` the v0.4 client drops.
  - Attempt 1 (`attempts: 1`): re-map `contextId` in the bridge → still failing.
  - Attempt 2 (`attempts: 2`): trace the SDK task envelope → **auto-pause** on the second
    same-slice failure; report: "v0.4 nests `contextId` under `task.metadata`".
  - User confirms approach → `/goal resume` (clears `consecutive_failures`).
- Checkpoint 4: applied the mapping fix; tests green; commit `g7h8i9`.
- Checkpoint 5: last v0.3 import removed; final validation green → **STOPPING CONDITION MET**.
- Retrospective written; agent asks "open a PR?".

---

## Example 2: Coverage push

**Trigger:** "raise the crew package test coverage to 80%"

**Contract:**

```markdown
# Goal: Raise src/crew coverage to >= 80%

- **Objective:** Push statement coverage for src/crew to at least 80%.
- **Stopping condition:** `bun test --coverage` reports the src/crew line coverage at
  >= 80.0%.
- **Validation loop:** `bun test --coverage tests/crew`
- **Inputs to read first:**
  - Existing `tests/crew.test.ts` and `tests/checkpoint-wal.test.ts` (follow their patterns)
  - `src/crew/checkpoint.ts` and `src/crew/task.ts` (largest uncovered surfaces)
- **Constraints:**
  - No production-code changes except deleting strictly-unreachable dead code
  - No new dependencies
  - All existing tests must keep passing
- **Forbidden moves:**
  - Don't game coverage with no-op test functions
  - Don't comment out failing tests; fix them
  - Don't open PRs against master; commit to branch goal/crew-coverage
- **Checkpoint cadence:** every test file added + full suite green
```

**Run loop highlights:**

- Checkpoint 1: baseline runs clean at 61.2%.
- Checkpoint 2: deleted 3 unreachable branches (verified by grep) → 64.0%.
- Checkpoint 3: added `tests/crew-task.test.ts` covering the task state machine → 71.8%.
- Checkpoint 4: added WAL-replay edge cases → 76.4%.
- Checkpoint 5: covered the retry/backoff path with a fake transport → 80.7% →
  **STOPPING CONDITION MET**.

---

## Example 3: Prototype creation

**Trigger:** "build a `crews summary` subcommand that prints a crew run report"

**Agent's batched question:**

```
Before I start:

1. Stopping condition — what proves "done"?
   Proposed: "`bun run src/cli/index.ts summary --help` works AND a sample run against a
   fixture crew writes ./crew-summary.md with at least one task listed AND bun test passes."

2. Validation loop — `bun test && bun x tsc --noEmit`. Anything else?

3. Should I write a short design note in docs/ first, or jump straight in?

4. Forbidden moves — don't add a network dependency; don't store credentials; don't touch
   the a2a transport. Anything to add?
```

**Run loop highlights:**

- Checkpoint 1: scaffolded `src/cli/commands/summary.ts` + wired the flag; `--help` works.
- Checkpoint 2: read the checkpoint log and rendered a task table.
- Checkpoint 3: added markdown output; a sample run produces `crew-summary.md`.
- Checkpoint 4: added a `--since` filter with tests for the date parsing.
- Checkpoint 5: integration test against a fixture crew → green → **STOPPING CONDITION MET**.
- Retrospective lists deferred ideas (JSON output, multi-crew rollups) as follow-up issues.

---

## Example 4: Prompt / eval optimization loop

**Trigger:** "optimize the planner prompt in `src/planner` until the eval suite scores >= 0.85"

**Contract:**

```markdown
- **Objective:** Iteratively improve the planner prompt until the eval suite scores >= 0.85.
- **Stopping condition:** `bun run eval/run.ts --suite all` reports `overall_score >= 0.85`
  OR 5 consecutive iterations show no improvement.
- **Validation loop:** `bun run eval/run.ts --suite all --json > eval/last.json` then read
  `overall_score` from `eval/last.json`.
- **Inputs to read first:**
  - `src/planner/ai-planner.ts` (current prompt assembly)
  - `eval/cases/*.json` (failing cases guide the edits)
  - `eval/run.ts` (how scoring works)
- **Constraints:**
  - Prompt must stay under 500 tokens
  - Planner output must remain valid against src/planner/plan.ts types
- **Forbidden moves:**
  - Don't change `eval/run.ts` (that's the judge, not the contestant)
  - Don't cherry-pick eval cases
- **Checkpoint cadence:** every prompt edit + eval rerun
```

**Run loop highlights:**

- Checkpoint 1: baseline 0.62; categorized 8 failing cases.
- Checkpoint 2: added an explicit "decompose before assigning" rule → 0.71.
- Checkpoint 3: added a structured-output template → 0.78.
- Checkpoint 4: tightened role-assignment examples → 0.83.
- Checkpoint 5: added a "prefer existing crew templates" rule → 0.86 →
  **STOPPING CONDITION MET**.

---

## Common patterns across examples

1. **Branch first.** Every example checks out `goal/<slug>` before starting.
2. **Validation loop is fast (< 60s).** Slow validation → rare checkpoints → bad UX.
3. **The stopping condition is a command, not a vibe.** Always transcript-verifiable.
4. **Forbidden moves are specific.** Not "be careful" — "don't open a PR".
5. **Checkpoints are commits when possible,** and the durable `audits/goals/<id>/` files are
   staged (`git add`) as part of every checkpoint so nothing is lost.
6. **Auto-pause on the second same-slice failure.** The agent never burns tokens compounding
   bad work; the attempt counter starts at 0 and increments by one per attempt.
