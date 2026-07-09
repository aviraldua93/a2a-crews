---
name: goal
description: >
  Canonical `/goal` front door for durable, autonomous work. Collects one objective,
  stopping condition, validation loop, inputs, constraints, forbidden moves, and
  checkpoint cadence, then runs a checkpoint loop with compact progress reports and
  pause/resume/clear semantics. Use for long-running coherent work that has a clear,
  transcript-verifiable success condition. Triggers include "/goal", "/goal pause",
  "/goal resume", "/goal clear", "/goal status", "/goal checkpoint", "/goal show",
  "set a goal", "drive to completion", and "run autonomously".
---

# goal — durable, verifiable autonomous work

> **TL;DR:** A goal is a contract. Once set, the agent works in checkpoints toward a
> verifiable stopping condition without per-turn human steering. Pause when blocked.
> Clear when done.
>
> **Pattern origin:** durable goal-execution loops in modern coding agents (a single
> objective, a runnable success condition, and a separate evaluator that grades each turn).
> **Contract template:** [`references/goal-template.md`](references/goal-template.md)
> **Worked examples:** [`references/examples.md`](references/examples.md)
> **Offline lifecycle validator:** [`scripts/validate_goal_e2e.py`](scripts/validate_goal_e2e.py)

This skill is self-contained: everything it needs lives under `.github/skills/goal/`.

---

## Core semantics (required)

- `/goal` has **exactly one active goal per session**.
- Setting a new `/goal <objective>` while one is active **replaces** the prior goal and
  resets the working-tier counters (turns, tokens, attempts, failures).
- Post-turn grading uses a **separate evaluator** pass; the worker never grades its own
  output. The worker surfaces evidence; the evaluator reads only that surfaced evidence
  and returns `met` / `not met` with a reason.
- The stopping condition must be **transcript-verifiable**: the evaluator can judge it from
  a runnable command result or an observable artifact that appears in the transcript.
- Clear aliases accepted: `clear`, `stop`, `off`, `reset`, `none`, `cancel`.

## When to use

- Long-running coding work with a clear success condition and a fast validation loop
- Migrations where the target stack, parity checks, and constraints are known up front
- Large refactors where a test suite proves correctness after each checkpoint
- Prototypes / spikes where "done" = "builds + passes reference behavior"
- Prompt or eval optimization loops (inspect failures → tweak → rerun → iterate)
- About to leave the agent unsupervised (autopilot mode)

## When NOT to use

- A loose backlog of unrelated work
- An exploratory spike where the goal itself is still unclear
- A single ad-hoc edit
- Work that needs human approval at every step
- A goal that cannot be verified by a runnable command or observable artifact

---

## Anatomy of a goal — the 7-field contract

A goal is a **7-field contract**. Every field is required before the goal can activate.
Missing any one = refuse to start and ask the user.

| # | Field | What it answers |
|---|---|---|
| 1 | **Objective** | One sentence: what is the agent trying to achieve? |
| 2 | **Stopping condition** | Exactly when to stop. Must be runnable or observable (transcript-verifiable). |
| 3 | **Validation loop** | Command(s) that prove progress at every checkpoint. |
| 4 | **Inputs to read first** | Files, docs, issues, or logs the agent must read before acting. |
| 5 | **Constraints** | Hard rules: what must NOT change; what must hold throughout. |
| 6 | **Forbidden moves** | Specific actions the agent must not take. |
| 7 | **Checkpoint cadence** | How often to write a progress entry, and what proves a checkpoint complete. |

**Execution context** is strongly recommended (optional 8th block): `cwd`, shell, per-run
timeout, required services, network/secrets policy, and side-effect boundaries.

### Who provides each field

- **Required from the user (4):** `Objective`, `Stopping condition`, `Constraints`, `Forbidden moves`.
- **Inferable-and-announced (3):** `Inputs to read first`, `Validation loop`, `Checkpoint cadence`.
  The agent may infer these when the user gives only a one-liner, but must **state the inferred
  values back** and get confirmation. Never silently infer a required field.

**Activation requires the user to confirm the full assembled contract.**

---

## Slash commands

| Trigger | Action |
|---|---|
| `/goal` | Show current goal status. If none is set, prompt the user to define one. Include condition, run time, turns, token spend, attempts, and the latest evaluator reason when available. |
| `/goal <objective>` | Begin the draft phase: gather missing fields via **one batched question**, then activate. If a goal is already active, replace it and reset the working-tier counters. |
| `/goal pause` | Stop the checkpoint loop; preserve all state; surface a compact progress report. |
| `/goal resume` | Re-read the durable contract, re-read the last checkpoint, run the validation loop once, then continue. |
| `/goal clear` | Mark the goal cleared and **write a retrospective**. Never delete history. |
| `/goal stop` \| `off` \| `reset` \| `none` \| `cancel` | Aliases for `/goal clear`; identical behavior. |
| `/goal status` | Same as `/goal`. |
| `/goal checkpoint` | Force-write a checkpoint right now (durable export + stage; idempotent). |
| `/goal show` | Print the full contract to the terminal. |

If the user says "follow this goal", "drive to completion", or "run autonomously", route to
`/goal <inferred objective>` and confirm the assembled contract before activating.

---

## Condition quality gate

Before activation, reject weak conditions and request a measurable rewrite. A valid stopping
condition must include:

1. a single measurable end state,
2. a stated verification command or artifact,
3. any hard constraints that must remain true, and
4. optional stop bounds (turn/time cap) for long runs.

Do not accept a condition the evaluator cannot judge from surfaced evidence.

## Availability guardrails

- If evaluator infrastructure is unavailable, fail loudly and tell the user why.
- If workspace trust is missing, do not silently continue as if goal mode were active.
- If availability checks fail, switch to explicit `/goal checkpoint` commands until goal
  mode is re-enabled.

---

## Two-tier memory

Goal state is split into a fast working tier and a durable, git-tracked tier so a goal
survives a lost session.

### Working tier (ephemeral, per session)

- `plan.md` — a scratchpad: the current slice, the running progress log, and the live
  counters (`turns`, `token_spend`, `attempts`, `consecutive_failures`).
- These counters are working memory; they are rebaselined on a session restart and are not
  the source of truth.

### Durable tier (git-tracked, the source of truth)

Everything under `audits/goals/<id>/`, where `<id>` is a short stable slug for the goal
(for example `2026-07-09-migrate-planner`). This directory is committed:

- `contract.md` — the frozen 7-field contract plus the current `State:` line.
- `checkpoints.md` — an **append-or-update** checkpoint log (one section per checkpoint).
- `retrospective.md` — written on `/goal clear`.

> **Durability rule:** a checkpoint is not complete until its durable files are **staged**.
> The checkpoint procedure below always runs `git add audits/goals/<id>/`.

An optional SQL mirror of the working tier is described in
[`references/goal-template.md`](references/goal-template.md); it is a convenience cache, not
the source of truth.

---

## Portable timestamp (cross-platform)

All timestamps use **machine-local time** (never UTC) and one portable command that behaves
identically in Windows PowerShell and Unix shells. **Do not use `date -u`** — it is not a
PowerShell builtin and will fail there.

```bash
python -c "import datetime; print(datetime.datetime.now().strftime('%Y-%m-%d %H:%M'))"
```

Use this command everywhere a `<YYYY-MM-DD HH:MM>` value is written.

---

## Setup loop

1. Identify the objective and stopping condition; run the condition quality gate.
2. If the user gave only a one-liner, ask **one batched question** for the missing required
   fields and announce the three inferable fields for confirmation.
3. Pick a stable `<id>` and write the confirmed contract to `audits/goals/<id>/contract.md`.
4. Initialize the working tier: create `plan.md` from `references/goal-template.md` with
   **`attempts` and `consecutive_failures` starting at 0** (see the counters rule below).
5. Bind the goal to a branch when the work is code-changing (`goal/<slug>`).
6. Run the baseline validation loop **once** before the first slice and record the result.
7. Stage and commit the durable files: `git add audits/goals/<id>/` then commit.

## Run loop

At each checkpoint:

1. Make one coherent slice of progress.
2. Run the validation loop; capture the exact command and its result as evaluator evidence.
3. Write the checkpoint durably (see the checkpoint procedure) and refresh `plan.md`.
4. Increment `attempts` by exactly one for the attempt just made.
5. Keep the progress report compact: **checkpoint, verified, remaining, blocked?**.
6. **Auto-pause after two consecutive failures on the same slice** — never burn tokens
   compounding bad work.

### Counters rule (attempt counter starts at 0)

- `attempts` (attempts on the current slice) and `consecutive_failures` both **default to 0**.
- Increment `attempts` by exactly one **per attempt**. Do **not** seed it to 1 — seeding to 1
  and then incrementing double-counts the first attempt.
- A passing checkpoint resets `attempts` to 0 (the slice is closed). A `resume` clears
  `consecutive_failures` but leaves `attempts` intact (the same slice remembers its cost).

### Checkpoint procedure (durable, idempotent, portable)

Run these steps for every checkpoint, including a forced `/goal checkpoint`:

1. Compute the timestamp with the portable command above.
2. Determine the checkpoint number `N` by **reading `audits/goals/<id>/checkpoints.md`** and
   counting existing `## Checkpoint N —` headers.
3. **Idempotency:** if an entry for this checkpoint (same `N` / same slice) already exists,
   **update it in place**. Never append a second header for the same checkpoint, and never
   create duplicate audit files on a re-run.
4. Write or refresh the checkpoint section in `checkpoints.md` and refresh the `State:` line
   in `contract.md`.
5. Update the working `plan.md` (counters + progress log).
6. **Durability — stage the durable files explicitly:**
   ```bash
   git add audits/goals/<id>/
   ```
   (The source design omitted this and silently lost checkpoints; always stage.)
7. When the slice changed code, commit the staged checkpoint.

## Resume / clear

- `/goal resume` re-primes from `audits/goals/<id>/contract.md` and the last checkpoint in
  `checkpoints.md`, runs the validation loop once, then continues.
- `/goal clear` (and its aliases) ends the goal, writes `audits/goals/<id>/retrospective.md`,
  stages `audits/goals/<id>/`, and commits — **without deleting history**.
- If session state is lost, recover from the durable tier first, then resume the loop.

---

## a2a-crews notes

This repository is a TypeScript, agent-to-agent crews CLI that runs on Bun. Prefer these as
validation-loop and stopping-condition commands:

- Tests: `bun test` (or a scoped path such as `bun test tests/crew`)
- Type check: `bun x tsc --noEmit`
- Build: `bun build src/cli/index.ts --compile --outfile=crews`

Keep the validation loop fast (well under a minute) so checkpoints stay frequent. See
[`references/examples.md`](references/examples.md) for full worked contracts in this stack.
