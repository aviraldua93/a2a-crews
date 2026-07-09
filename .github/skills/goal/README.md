# goal — skill README

`goal` is the canonical front door for durable, autonomous work in this repository.

Use it when you want the agent to keep working toward one objective across many turns
instead of stopping after a single response. It collects a 7-field contract once, enforces a
transcript-verifiable stopping condition, and runs a checkpointed validation loop with
`pause` / `resume` / `clear` semantics.

## Quick start

```bash
/goal Migrate src/a2a to @a2a-js/sdk v0.4
/goal
/goal pause
/goal resume
/goal clear
/goal stop    # alias of clear
```

## What it does

- collects the goal contract once (4 fields required from you, 3 inferred-and-announced);
- enforces transcript-verifiable completion conditions graded by a **separate** evaluator;
- persists state in **two tiers** — a working `plan.md` and a durable, git-tracked
  `audits/goals/<id>/` log;
- runs checkpointed validation loops and auto-pauses on a second same-slice failure;
- supports `pause` / `resume` / `clear` (aliases: `stop`, `off`, `reset`, `none`, `cancel`).

## Layout

```
.github/skills/goal/
├── SKILL.md                     # runtime behavior and slash-command contract
├── README.md                    # this file
├── .claude-plugin/plugin.json   # plugin manifest
├── references/
│   ├── goal-template.md         # plan.md + durable-tier + optional SQL mirror
│   ├── examples.md              # four worked contracts (TypeScript / Bun)
│   └── e2e-fixtures/            # offline lifecycle fixtures (*.json)
├── scripts/
│   └── validate_goal_e2e.py     # dependency-free, cross-platform replay validator
└── tests/
    └── test_validate_goal_e2e.py
```

## Offline validation

The lifecycle validator has no dependencies beyond the Python standard library and makes no
network or shell calls, so it runs identically on Windows PowerShell and Unix shells:

```bash
# replay every fixture
python .github/skills/goal/scripts/validate_goal_e2e.py

# replay one scenario
python .github/skills/goal/scripts/validate_goal_e2e.py --scenario happy-path

# unit tests
python -m pytest .github/skills/goal/tests
```

## Design guarantees

- **Durability:** each checkpoint stages its durable files (`git add audits/goals/<id>/`) so
  a checkpoint is never silently lost.
- **Idempotency:** checkpoint/export steps update in place — re-running never creates a
  duplicate entry or file.
- **Portability:** all instructions are cross-platform and use a portable, machine-local
  timestamp command (never `date -u`).
- **Correct counters:** the attempt counter defaults to `0` and increments by exactly one per
  attempt (no off-by-one double count).
