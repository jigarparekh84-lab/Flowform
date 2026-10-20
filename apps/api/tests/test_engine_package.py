"""FF-103: engine package boundary and solver adapter."""

from __future__ import annotations

import pulp

import app.solver
import flowform_engine
from flowform_engine import solvers


def test_app_modules_alias_engine():
    assert app.solver is flowform_engine.solver
    assert app.solver.solve_optimize is flowform_engine.solve_optimize


def test_default_adapter_is_highs_and_forwards_options():
    a = solvers.default_adapter()
    assert a.name == "pulp-highs"
    s = a.make(msg=False, gapRel=5e-4, timeLimit=7)
    assert isinstance(s, pulp.HiGHS)
    assert s.gapRel == 5e-4 and s.timeLimit == 7
    assert "pulp" in a.version()


def test_cbc_adapter_registered():
    assert isinstance(solvers.get_adapter("pulp-cbc").make(msg=False), pulp.PULP_CBC_CMD)
