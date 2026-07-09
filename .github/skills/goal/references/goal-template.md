# Goal contract template

A goal lives in **two tiers**. Write the working tier to `plan.md` and the durable,
git-tracked tier to `audits/goals/<id>/`.

- **Working tier (ephemeral):** `plan.md` — current slice, progress log, live counters.
- **Durable tier (source of truth, committed):** `audits/goals/<id>/contract.md`,
  `audits/goals/<id>/checkpoints.md`, `audits/goals/<id>/retrospective.md`.

Every `<YYYY-MM-DD HH:MM>` value is produced by one portable, machine-local command
(**never `date -u`**), which behaves the same in PowerShell and Unix shells:

```bash
python -c "import datetime; print(datetime.datetime.now().strftime('%Y-%m-%d %H:%M'))"
```

---

## `plan.md` (working tier)

```markdown
# Goal: <one-sentence objective>

**State:** active
**Goal id:** <id>            <!-- e.g. 2026-07-09-migrate-planner -->
**Branch:** goal/<short-slug>
**Started:** <YYYY-MM-DD HH:MM>
**Last checkpoint:** <YYYY-MM-DD HH:MM>
**Autopilot:** yes | no

## Counters (working memory — rebaselined on session restart)

- turns: 0
- token_spend: 0
- attempts (current slice): 0      <!-- defaults to 0; +1 per attempt; never seed to 1 -->
- consecutive_failures: 0          <!-- defaults to 0; auto-pause at 2 -->

## Contract (mirror of audits/goals/<id>/contract.md)

- **Objective:** <one sentence>
- **Stopping condition:** <runnable / observable; the command that says "done">
- **Validation loop:** `<command>` (run at every checkpoint)
- **Inputs to read first:**
  - `<path or URL>` — <why>
  - `<path or URL>` — <why>
- **Constraints:**
  - <hard constraint that must hold throughout>
- **Forbidden moves:**
  - <thing the agent must not do>
- **Checkpoint cadence:** <e.g., "every module fully migrated + tests still green">
- **Execution context:**
  - cwd: `<absolute path>`
  - shell: `<pwsh | bash | zsh>`
  - timeout per validation run: `<seconds>`
  - required services: `<none | list>`
  - network/secrets policy: `<e.g., "GitHub API only; no secrets needed">`
  - side-effect boundaries: `<e.g., "validation must be idempotent; no network writes">`

## Progress log

(short turn-by-turn notes)

- <YYYY-MM-DD HH:MM> turn 1: read contract; opened branch goal/<slug>
- <YYYY-MM-DD HH:MM> turn 4: completed first slice; validation passed
- <YYYY-MM-DD HH:MM> turn 7: validation failed; trying alternative approach
- <YYYY-MM-DD HH:MM> turn 8: validation passed; checkpoint 2 written
```

---

## `audits/goals/<id>/contract.md` (durable, committed)

```markdown
# Goal: <one-sentence objective>

**State:** active | paused | completed | cleared
**Goal id:** <id>
**Branch:** goal/<short-slug>
**Started:** <YYYY-MM-DD HH:MM>

## Contract

- **Objective:** <one sentence>
- **Stopping condition:** <runnable / observable>
- **Validation loop:** `<command>`
- **Inputs to read first:** ...
- **Constraints:** ...
- **Forbidden moves:** ...
- **Checkpoint cadence:** ...
- **Execution context:** ...
```

## `audits/goals/<id>/checkpoints.md` (durable, append-or-update)

Each checkpoint is one section keyed by its number. **On a re-run, update the matching
section in place — never append a duplicate header.**

```markdown
## Checkpoint 1 — <YYYY-MM-DD HH:MM> — <short slice title>

- **Verified:** <what passed; specifically>
- **Remains:** <one-line summary of what's still left>
- **Blocked?** <none | reason if blocked>
- **Validation:** ✅ pass (`<command>` exit 0) | ❌ fail (output: `<truncated>`)
- **Attempts this slice:** <n>
- **Commit:** `<sha>` <subject> | "no commit yet"

## Checkpoint 2 — ...
```

> After writing, **stage the durable files**: `git add audits/goals/<id>/`.

## `audits/goals/<id>/retrospective.md` (written on `/goal clear`)

```markdown
# Retrospective — <objective>

- **What shipped:** <commits, file paths>
- **Stopping condition verified:** <how>
- **Decisions made:**
  - <Q>: <chosen> — <rationale>
- **Follow-ups deferred:**
  - <thing>
```

---

## Optional SQL mirror (working-tier cache)

A convenience cache only — the committed markdown is the source of truth. The `UNIQUE`
constraint on `(goal_id, checkpoint_num)` makes checkpoint writes **idempotent**: a re-run
upserts the same row instead of creating a duplicate.

```sql
CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    stopping_condition TEXT NOT NULL,
    validation_command TEXT NOT NULL,
    inputs_to_read TEXT,
    constraints TEXT,
    forbidden_moves TEXT,
    checkpoint_cadence TEXT,
    execution_context TEXT,
    state TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    branch TEXT,
    autopilot INTEGER DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,             -- current slice; defaults to 0
    consecutive_failures INTEGER NOT NULL DEFAULT 0  -- defaults to 0; auto-pause at 2
);

CREATE TABLE IF NOT EXISTS goal_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id TEXT NOT NULL,
    checkpoint_num INTEGER NOT NULL,
    title TEXT NOT NULL,
    verified TEXT,
    remains TEXT,
    blocked_reason TEXT,
    validation_result TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    commit_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (goal_id, checkpoint_num),                -- idempotent checkpoint writes
    FOREIGN KEY (goal_id) REFERENCES goals(id)
);

CREATE INDEX IF NOT EXISTS idx_goal_checkpoints_goal ON goal_checkpoints(goal_id);
```

### Idempotent checkpoint upsert

```sql
-- Re-running this for the same (goal_id, checkpoint_num) updates the row in place.
INSERT INTO goal_checkpoints (goal_id, checkpoint_num, title, verified, remains,
                              blocked_reason, validation_result, attempts, commit_sha,
                              created_at, updated_at)
VALUES (:goal_id, :n, :title, :verified, :remains, :blocked, :result, :attempts, :sha,
        :now, :now)
ON CONFLICT (goal_id, checkpoint_num) DO UPDATE SET
    title = excluded.title,
    verified = excluded.verified,
    remains = excluded.remains,
    blocked_reason = excluded.blocked_reason,
    validation_result = excluded.validation_result,
    attempts = excluded.attempts,
    commit_sha = excluded.commit_sha,
    updated_at = excluded.updated_at;
```

### Useful queries

```sql
-- Current active goal
SELECT * FROM goals WHERE state = 'active';

-- Most recent checkpoint
SELECT * FROM goal_checkpoints
WHERE goal_id = (SELECT id FROM goals WHERE state = 'active')
ORDER BY checkpoint_num DESC LIMIT 1;
```
