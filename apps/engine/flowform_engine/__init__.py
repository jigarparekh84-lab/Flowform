"""Flowform optimization engine (FF-103): network-design MIP, explain,
multi-period roadmap and robust/stochastic solves. Pure Python, no web deps."""

from .limits import PayloadTooLarge, guard_payload
from .multi_period import solve_multi_period
from .solver import solve_optimize
from .solvers import SolverAdapter, default_adapter, get_adapter
from .stochastic import solve_stochastic
from .validation import validate_optimize

__version__ = "0.1.0"

__all__ = [
    "PayloadTooLarge",
    "SolverAdapter",
    "__version__",
    "default_adapter",
    "get_adapter",
    "guard_payload",
    "solve_multi_period",
    "solve_optimize",
    "solve_stochastic",
    "validate_optimize",
]
