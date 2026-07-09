"""Offline tests for the ``/goal`` E2E fixture replay engine."""
import importlib.util
import json
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "validate_goal_e2e.py"
_spec = importlib.util.spec_from_file_location("validate_goal_e2e", SCRIPT)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)


def test_selftest_passes():
    assert mod._selftest() == 0


def test_all_fixtures_replay():
    fixtures = Path(__file__).resolve().parents[1] / "references" / "e2e-fixtures"
    found = sorted(fixtures.glob("*.json"))
    assert found, "no fixtures found"
    for f in found:
        doc = json.loads(f.read_text(encoding="utf-8"))
        final_state = mod.replay_fixture(doc)
        assert final_state.state in {"completed", "cleared"}


def test_replacement_resets_counters():
    fixture = {
        "steps": [
            {"action": "set_goal", "condition": "A"},
            {"action": "checkpoint_pass", "tokens": 2222},
            {"action": "set_goal", "condition": "B"},
            {"action": "status_assert", "expected": {"turns": 0, "token_spend": 0}},
        ],
        "expected_final": {"state": "active", "active_condition": "B"},
    }
    s = mod.replay_fixture(fixture)
    assert s.active_condition == "B"
    assert s.turns == 0
    assert s.token_spend == 0


def test_clear_aliases_are_supported():
    for alias in sorted(mod.CLEAR_ALIASES):
        fixture = {
            "steps": [
                {"action": "set_goal", "condition": "X"},
                {"action": alias},
            ],
            "expected_final": {"state": "cleared"},
        }
        s = mod.replay_fixture(fixture)
        assert s.state == "cleared"
        assert s.active_condition is None


def test_attempt_counter_defaults_to_zero_and_never_double_counts():
    # Guards the off-by-one defect: the counter starts at 0 (not 1) and the
    # first failed attempt reads 1, not 2.
    fixture = {
        "steps": [
            {"action": "set_goal", "condition": "retry loop is resilient"},
            {"action": "status_assert", "expected": {"attempts": 0}},
            {"action": "checkpoint_fail", "same_slice": True},
            {"action": "status_assert", "expected": {"attempts": 1}},
            {"action": "checkpoint_fail", "same_slice": True},
            {"action": "status_assert", "expected": {"attempts": 2, "state": "paused"}},
        ],
    }
    s = mod.replay_fixture(fixture)
    assert s.attempts == 2


def test_attempt_counter_resets_on_pass_but_survives_resume():
    fixture = {
        "steps": [
            {"action": "set_goal", "condition": "resilient"},
            {"action": "checkpoint_fail", "same_slice": True},
            {"action": "checkpoint_fail", "same_slice": True},
            {"action": "resume"},
            {"action": "status_assert", "expected": {"attempts": 2, "consecutive_failures": 0}},
            {"action": "checkpoint_pass"},
            {"action": "status_assert", "expected": {"attempts": 0}},
        ],
    }
    mod.replay_fixture(fixture)


def test_export_is_idempotent_and_staged():
    # Guards durability (files are staged) and idempotency (no duplicate entry).
    fixture = {
        "steps": [
            {"action": "set_goal", "condition": "docs build is green"},
            {"action": "export_checkpoint", "checkpoint_id": "cp-1"},
            {"action": "status_assert", "expected": {"exports": 1, "staged": True}},
            {"action": "export_checkpoint", "checkpoint_id": "cp-1"},
            {"action": "status_assert", "expected": {"exports": 1, "staged": True}},
            {"action": "export_checkpoint", "checkpoint_id": "cp-2"},
            {"action": "status_assert", "expected": {"exports": 2}},
        ],
    }
    s = mod.replay_fixture(fixture)
    assert s.exports == 2
    assert s.staged is True


def test_export_requires_checkpoint_id():
    fixture = {
        "steps": [
            {"action": "set_goal", "condition": "docs build is green"},
            {"action": "export_checkpoint"},
        ],
    }
    try:
        mod.replay_fixture(fixture)
    except mod.ReplayError:
        return
    raise AssertionError("export_checkpoint without checkpoint_id should fail")
