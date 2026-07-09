# Goal: Add a portable /goal skill plugin to a2a-crews and open a PR

**State:** completed
**Goal id:** goal-skill
**Branch:** feat/goal-skill
**Started:** 2026-07-09 12:38
**Last checkpoint:** 2026-07-09 12:56

> Dogfooding note: this contract was adopted to build the very `/goal` skill it conforms
> to. It is a live instance of the 7-field contract defined in
> `.github/skills/goal/SKILL.md` and the template in
> `.github/skills/goal/references/goal-template.md`.

## Contract

- **Objective:** Add a portable `/goal` skill plugin folder (`.github/skills/goal/`) to
  a2a-crews and open a PR on `aviraldua93/a2a-crews`.
- **Stopping condition:** branch `feat/goal-skill` is pushed AND a PR is opened on
  `aviraldua93/a2a-crews` AND the ported e2e validator + tests pass (with the passing
  output recorded in the checkpoint log). Verified by:
  - `python .github/skills/goal/scripts/validate_goal_e2e.py` exits 0 (7/7 fixtures PASS)
  - `python -m pytest .github/skills/goal/tests -q` exits 0 (all tests pass)
  - `git ls-remote --heads origin feat/goal-skill` returns the branch
  - `gh pr view <n> --json state` reports an open PR
- **Validation loop:** after drafting `SKILL.md` / `plugin.json` / references, run the
  ported validator + tests; fix and re-run until green:
  `python .github/skills/goal/scripts/validate_goal_e2e.py && python -m pytest .github/skills/goal/tests -q`
- **Inputs to read first:**
  - Reference `/goal` `SKILL.md` (design source, read via `gh api` raw) — contract + slash-command semantics
  - Reference goal-template + examples (read via `gh api` raw) — plan/template shape and worked examples
  - Reference validator + tests + fixtures (read via `gh api` raw) — the state machine to port
  - `package.json`, `tsconfig.json`, `src/`, `tests/` in this repo — stack + commands to adapt examples to
- **Constraints:**
  - Own ONLY `.github/skills/goal/**` plus this durable `audits/goals/goal-skill/` log; a
    second agent owns `src/**`, `package.json`, and the root `README.md` — do not touch those.
  - Ported validator/tests must actually pass; the contract they validate must match `SKILL.md`.
  - Every commit carries the required `Co-authored-by` and `Copilot-Session` trailers.
- **Forbidden moves:**
  - No `jaypete`, `jp-`, `gbrain`, `worksmart`, or any interviewer's personal name anywhere
    (clean-room port of the design only).
  - No fallback to the work EMU account for pushes/PRs; operate as `aviraldua93`.
  - No `date -u` (fails in PowerShell); use the portable machine-local timestamp command.
- **Checkpoint cadence:** write a checkpoint after `SKILL.md`, after `plugin.json` +
  references, and after the validator + tests pass; a final checkpoint on ship
  (branch pushed + PR opened).
- **Execution context:**
  - cwd: `C:\Users\aviraldua\a2a-crews-goalskill` (isolated clone, avoids the second agent)
  - shell: `pwsh` (Windows PowerShell); instructions kept cross-platform
  - timeout per validation run: 60s (validator + tests complete in < 1s)
  - required services: none (validator is offline, stdlib-only)
  - network/secrets policy: GitHub API via `gh` for reads and push/PR; no secrets committed
  - side-effect boundaries: writes limited to `.github/skills/goal/**` and
    `audits/goals/goal-skill/**`; durable files staged with `git add` each checkpoint
