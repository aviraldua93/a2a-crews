# Goal: Implement a durable goal-loop feature in a2a-crews

**State:** completed
**Id:** goal-loop-feature
**Branch:** feat/goal-loop
**Started:** 2026-07-09T13:03:12-07:00
**Achieved:** 2026-07-09T13:58-07:00 — branch pushed (`9a2e0de`), PR #28 updated, `bun test` 231 pass / `bun x tsc --noEmit` exit 0
**Autopilot:** yes

> Dogfooding note: this contract was adopted **before** writing the deeper
> integration code. The loop below (see `checkpoints.md`) was then run for real —
> each unit of work is a checkpoint followed by a **separate** evaluator pass that
> records the exact command run and its result. The worker (implementation) and
> the evaluator (grading) are distinct steps, never merged.

## Contract

- **Objective:** Implement a durable goal-loop feature in a2a-crews — a 7-field
  `GoalContract` type, a `GoalRunner` that drives a worker to a verifiable
  stopping condition, a **separate** evaluator (the worker never self-grades),
  and two-tier memory (in-memory working state vs durable `audits/goals/<id>/`) —
  then flesh out `Crew.kickoff()` as the durable loop controller and open a PR on
  `aviraldua93/a2a-crews`.

- **Stopping condition:** Branch `feat/goal-loop` is pushed **and** the PR is open
  (`https://github.com/aviraldua93/a2a-crews/pull/28`) **and** both `bun test`
  (exit 0, 0 failures) and `bun x tsc --noEmit` (exit 0) pass locally with their
  passing output pasted into `checkpoints.md`. State-verifiable from the git
  transcript and the pasted command exit codes/output.

- **Validation loop:** After each checkpoint, run `bun x tsc --noEmit`, then
  `bun test`; fix every failure before continuing. Record the command and its
  result as evidence in the evaluator pass.

- **Inputs to read first:**
  - the recursive repo tree, `README.md`, `package.json`
  - `src/crew/crew.ts` (stub `kickoff` — the durable loop controller to flesh out)
  - `src/crew/checkpoint.ts` (crew checkpoint shape to extend into goal checkpoints)
  - `src/crew/process.ts` (`computeWaves` scheduler to adapt into checkpoint/evaluator cycles)
  - `src/cli/index.ts` (command dispatch, ~lines 132-153; `handleGoal` ~952)
  - `src/spawner/prompt.ts`, `.github/workflows/ci.yml`
  - the shipped goal module: `src/goal/{contract,evaluator,store,runner,index}.ts`

- **Constraints:**
  - Bun runtime; use the repo's existing test framework (`bun test`, `bun:test`).
  - Idiomatic TypeScript (ESM, strict); follow existing repo conventions/lint.
  - Own only `src/**`, tests, `package.json`/build config (only if genuinely
    needed), and root `README.md`, plus these `audits/goals/goal-loop-feature/**`
    dogfooding artifacts.
  - Keep changes surgical; do not regress the existing 222 tests.
  - Cross-platform (Windows + Unix): timestamps from the JS runtime; never shell
    out to `date -u`; staging via argv, no Unix-only shell assumptions.

- **Forbidden moves:**
  - Do not touch `.github/skills/goal/**` (owned by a second agent).
  - Clean-room port of the design only: no source-specific project or person
    names/identifiers anywhere in code, tests, docs, or history — use generic
    names (`goal`, `goal-loop`, `GoalContract`, `GoalRunner`).
  - Do not fall back to the alternate/work account for push; push only as the
    personal account that owns the target repo.
  - The worker must not grade itself — grading is a separate evaluator step.

- **Checkpoint cadence:** Write a checkpoint after each meaningful unit
  (contract adopted, checkpoint bridge, kickoff loop, CLI confirmation, full
  validation, README, ship). Each checkpoint is followed by a separate evaluator
  pass that records the exact command + result; a checkpoint is complete only
  when `bun x tsc --noEmit` and `bun test` are green for that slice.

- **Execution context:**
  - cwd: `C:\Users\aviraldua\a2a-crews-work`
  - shell: `pwsh` (Windows PowerShell)
  - side-effect boundaries: writes limited to owned paths; durable goal state
    under `audits/goals/<id>/`; git operations on branch `feat/goal-loop` only.
