# `/goal` E2E fixtures

Offline, replayable fixtures for validating the end-to-end `/goal` lifecycle.
They run with the standard library only — no network, no shell, no `date`
call — so they behave identically on Windows PowerShell and Unix shells.

Run all fixtures:

```bash
python .github/skills/goal/scripts/validate_goal_e2e.py
```

Run one scenario:

```bash
python .github/skills/goal/scripts/validate_goal_e2e.py --scenario happy-path
```

Scenarios:

- `happy-path.json` — set, checkpoint, evaluator completes the goal.
- `auto-pause-resume.json` — two same-slice failures auto-pause; resume then complete.
- `goal-replacement.json` — a new goal replaces the active one and resets counters.
- `clear-aliases.json` — `cancel`/`off`/etc. behave like `/goal clear`.
- `resume-after-restart.json` — the durable contract survives a session restart.
- `attempt-counter.json` — the attempt counter defaults to 0 and never double-counts.
- `idempotent-durable-export.json` — durable checkpoint export stages files and is idempotent.
