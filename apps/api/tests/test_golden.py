"""Golden regression harness (FF-102). See tests/golden/README.md."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from .golden.cases import CASES

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
ABS_TOL = 1.5e-4  # one reported $M digit (4 dp)


def _diff(actual: Any, golden: Any, path: str, out: list[str]) -> None:
    if isinstance(golden, dict):
        if not isinstance(actual, dict) or set(actual) != set(golden):
            out.append(f"{path}: keys {sorted(actual) if isinstance(actual, dict) else actual!r} != {sorted(golden)}")
            return
        for k in golden:
            _diff(actual[k], golden[k], f"{path}.{k}", out)
    elif isinstance(golden, list):
        if not isinstance(actual, list) or len(actual) != len(golden):
            out.append(f"{path}: {actual!r} != {golden!r}")
            return
        for i, (a, g) in enumerate(zip(actual, golden)):
            _diff(a, g, f"{path}[{i}]", out)
    elif isinstance(golden, bool) or golden is None or isinstance(golden, str):
        if actual != golden:
            out.append(f"{path}: {actual!r} != {golden!r}")
    elif isinstance(golden, (int, float)):
        if not isinstance(actual, (int, float)) or isinstance(actual, bool):
            out.append(f"{path}: {actual!r} != {golden!r}")
            return
        if abs(actual - golden) > ABS_TOL:
            out.append(f"{path}: {actual} != {golden} (|Δ|={abs(actual - golden):.3g})")
    else:
        if actual != golden:
            out.append(f"{path}: {actual!r} != {golden!r}")


def compare(actual: Any, golden: Any) -> list[str]:
    out: list[str] = []
    _diff(json.loads(json.dumps(actual)), golden, "$", out)
    return out


@pytest.mark.parametrize("name", sorted(CASES))
def test_golden(name: str) -> None:
    golden = json.loads((GOLDEN_DIR / f"{name}.json").read_text())
    problems = compare(CASES[name](), golden)
    assert not problems, f"{name} drifted from golden:\n" + "\n".join(problems[:40])


def test_compare_detects_drift() -> None:
    assert compare({"totalM": 176.8118}, {"totalM": 176.8118}) == []
    assert compare({"totalM": 176.8119}, {"totalM": 176.8118}) == []
    assert compare({"totalM": 176.8121}, {"totalM": 176.8118})
    assert compare({"openIds": ["a"]}, {"openIds": ["b"]})
    assert compare({"h": "x"}, {"h": "y"})
