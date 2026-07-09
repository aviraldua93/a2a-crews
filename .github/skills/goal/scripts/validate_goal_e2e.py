#!/usr/bin/env python3
"""Offline replay validator for the ``/goal`` skill end-to-end fixtures.

The validator is intentionally dependency-free and cross-platform: it never
shells out, never calls ``date``/``Get-Date``, and never touches the network.
It replays deterministic JSON fixtures that model the ``/goal`` lifecycle and
asserts the expected state transitions:

    set -> checkpoint pass/fail -> auto-pause -> resume -> complete -> clear

It also encodes the durability, idempotency and attempt-counter guarantees that
the accompanying ``SKILL.md`` promises, so the contract and the runtime stay in
lock-step:

* ``attempts`` defaults to 0 and increments by exactly one per attempt (no
  off-by-one / double count).
* ``export_checkpoint`` is idempotent (re-running with the same checkpoint id
  never creates a duplicate durable entry) and marks the durable audit files as
  staged (``git add`` equivalent), so a checkpoint is never lost.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set


@dataclass
class GoalState:
    state: str = "idle"
    active_condition: Optional[str] = None
    achieved_condition: Optional[str] = None
    turns: int = 0
    token_spend: int = 0
    checkpoints: int = 0
    consecutive_failures: int = 0
    # Attempts on the current slice. Defaults to 0 (NOT 1) and increments by
    # exactly one per attempt so the counter never double-counts.
    attempts: int = 0
    # Distinct durable checkpoint exports written to audits/goals/<id>/.
    exports: int = 0
    # Whether the latest durable export was staged (git add) for commit.
    staged: bool = False
    last_reason: str = ""
    # Internal: ids already exported, so re-runs stay idempotent.
    _exported_ids: Set[str] = field(default_factory=set)


class ReplayError(RuntimeError):
    pass


CLEAR_ALIASES = {"clear", "stop", "off", "reset", "none", "cancel"}


def _assert_subset(actual: GoalState, expected: Dict[str, Any], where: str) -> None:
    row = {
        "state": actual.state,
        "active_condition": actual.active_condition,
        "achieved_condition": actual.achieved_condition,
        "turns": actual.turns,
        "token_spend": actual.token_spend,
        "checkpoints": actual.checkpoints,
        "consecutive_failures": actual.consecutive_failures,
        "attempts": actual.attempts,
        "exports": actual.exports,
        "staged": actual.staged,
        "last_reason": actual.last_reason,
    }
    for key, exp in expected.items():
        got = row.get(key)
        if got != exp:
            raise ReplayError(f"{where}: expected {key}={exp!r}, got {got!r}")


def _require_active(s: GoalState, action: str) -> None:
    if s.state != "active":
        raise ReplayError(f"{action}: requires active state, got {s.state!r}")
    if not s.active_condition:
        raise ReplayError(f"{action}: requires active_condition")


def replay_fixture(doc: Dict[str, Any]) -> GoalState:
    if not isinstance(doc, dict):
        raise ReplayError("fixture must be a JSON object")
    if not isinstance(doc.get("steps"), list) or not doc["steps"]:
        raise ReplayError("fixture.steps must be a non-empty array")

    s = GoalState()
    steps: List[Dict[str, Any]] = doc["steps"]
    for idx, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            raise ReplayError(f"step {idx}: must be an object")
        action = step.get("action")
        if not isinstance(action, str) or not action:
            raise ReplayError(f"step {idx}: missing action")

        if action == "set_goal":
            condition = step.get("condition")
            if not isinstance(condition, str) or not condition.strip():
                raise ReplayError(f"step {idx}: set_goal requires non-empty condition")
            # One active goal per session: a new goal replaces the prior one and
            # resets every working-tier counter.
            s.state = "active"
            s.active_condition = condition.strip()
            s.turns = 0
            s.token_spend = 0
            s.checkpoints = 0
            s.consecutive_failures = 0
            s.attempts = 0
            s.exports = 0
            s.staged = False
            s._exported_ids = set()
            s.last_reason = "goal set"

        elif action == "checkpoint_pass":
            _require_active(s, action)
            s.turns += 1
            s.checkpoints += 1
            s.token_spend += int(step.get("tokens", 1000))
            s.consecutive_failures = 0
            # Slice passed: clear the per-slice attempt counter for the next slice.
            s.attempts = 0
            s.last_reason = str(step.get("reason", "validation passed"))

        elif action == "checkpoint_fail":
            _require_active(s, action)
            s.turns += 1
            s.checkpoints += 1
            s.token_spend += int(step.get("tokens", 1000))
            same_slice = bool(step.get("same_slice", True))
            s.consecutive_failures = s.consecutive_failures + 1 if same_slice else 1
            # Attempt counter: +1 on the same slice, reset to 1 on a new slice.
            s.attempts = s.attempts + 1 if same_slice else 1
            s.last_reason = str(step.get("reason", "validation failed"))
            if s.consecutive_failures >= 2:
                s.state = "paused"

        elif action == "export_checkpoint":
            # Models the durable checkpoint write to audits/goals/<id>/:
            # idempotent (no duplicate entry on re-run) and staged for commit.
            _require_active(s, action)
            checkpoint_id = step.get("checkpoint_id")
            if not isinstance(checkpoint_id, str) or not checkpoint_id.strip():
                raise ReplayError(f"step {idx}: export_checkpoint requires checkpoint_id")
            checkpoint_id = checkpoint_id.strip()
            if checkpoint_id in s._exported_ids:
                # Idempotent replay: the entry already exists, so do not add a
                # duplicate. The durable files remain staged.
                s.staged = True
                s.last_reason = f"duplicate export skipped for {checkpoint_id}"
            else:
                s._exported_ids.add(checkpoint_id)
                s.exports += 1
                s.staged = True
                s.last_reason = f"checkpoint {checkpoint_id} exported and staged"

        elif action == "resume":
            if s.state != "paused":
                raise ReplayError(f"step {idx}: resume requires paused state, got {s.state!r}")
            s.state = "active"
            s.consecutive_failures = 0
            # attempts intentionally survive resume: the slice is still open and
            # remembers how many tries it has already cost.
            s.last_reason = str(step.get("reason", "resumed"))

        elif action == "restart_resume":
            # Session restart: the durable contract persists but the working-tier
            # counters (turns, tokens, attempts) are rebaselined.
            if s.state != "active" or not s.active_condition:
                raise ReplayError(f"step {idx}: restart_resume requires active goal")
            s.turns = 0
            s.token_spend = 0
            s.attempts = 0
            s.last_reason = str(step.get("reason", "resumed active goal"))

        elif action == "evaluator_not_met":
            _require_active(s, action)
            s.last_reason = str(step.get("reason", "condition not met"))

        elif action == "evaluator_met":
            _require_active(s, action)
            s.achieved_condition = s.active_condition
            s.active_condition = None
            s.state = "completed"
            s.consecutive_failures = 0
            s.last_reason = str(step.get("reason", "condition met"))

        elif action in CLEAR_ALIASES:
            s.state = "cleared"
            s.active_condition = None
            s.consecutive_failures = 0
            s.last_reason = f"goal {action}"

        elif action == "status_assert":
            expected = step.get("expected")
            if not isinstance(expected, dict):
                raise ReplayError(f"step {idx}: status_assert requires expected object")
            _assert_subset(s, expected, f"step {idx}")

        else:
            raise ReplayError(f"step {idx}: unknown action {action!r}")

        if "expected" in step and action != "status_assert":
            expected = step["expected"]
            if not isinstance(expected, dict):
                raise ReplayError(f"step {idx}: expected must be an object")
            _assert_subset(s, expected, f"step {idx}")

    final_expected = doc.get("expected_final")
    if final_expected is not None:
        if not isinstance(final_expected, dict):
            raise ReplayError("expected_final must be an object")
        _assert_subset(s, final_expected, "expected_final")
    return s


def run_fixtures(fixtures_dir: Path, scenario: Optional[str] = None) -> int:
    files = sorted(fixtures_dir.glob("*.json"))
    if scenario:
        files = [p for p in files if p.stem == scenario]
    if not files:
        raise ReplayError(f"no fixture files found in {fixtures_dir}")

    failures: List[str] = []
    for p in files:
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
            replay_fixture(doc)
            print(f"PASS {p.name}")
        except Exception as e:  # explicit surface for fixture failures
            failures.append(f"{p.name}: {e}")
            print(f"FAIL {p.name}: {e}")

    if failures:
        print("\nFixture failures:")
        for f in failures:
            print(f"- {f}")
        return 1
    return 0


def _selftest() -> int:
    fixture = {
        "steps": [
            {"action": "set_goal", "condition": "tests pass"},
            {"action": "checkpoint_fail", "reason": "test red", "expected": {"attempts": 1}},
            {"action": "checkpoint_fail", "reason": "still red", "expected": {"state": "paused", "attempts": 2}},
            {"action": "resume", "expected": {"consecutive_failures": 0, "attempts": 2}},
            {"action": "export_checkpoint", "checkpoint_id": "cp-1", "expected": {"exports": 1, "staged": True}},
            {"action": "export_checkpoint", "checkpoint_id": "cp-1", "expected": {"exports": 1}},
            {"action": "checkpoint_pass", "expected": {"attempts": 0}},
            {"action": "evaluator_met", "expected": {"state": "completed", "active_condition": None}},
        ],
        "expected_final": {"state": "completed", "achieved_condition": "tests pass"},
    }
    replay_fixture(fixture)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay offline goal E2E fixtures")
    parser.add_argument(
        "--fixtures-dir",
        default=str(Path(__file__).resolve().parents[1] / "references" / "e2e-fixtures"),
        help="Directory containing *.json fixtures",
    )
    parser.add_argument("--scenario", help="Run one fixture by filename stem")
    parser.add_argument("--selftest", action="store_true", help="Run internal self-test")
    args = parser.parse_args()

    if args.selftest:
        return _selftest()
    return run_fixtures(Path(args.fixtures_dir), args.scenario)


if __name__ == "__main__":
    raise SystemExit(main())
