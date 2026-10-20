# ADR-007: Solver layer: PuLP + HiGHS behind an adapter

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Jigar Parekh

## Context

The engine (`solver.py` ~3,000 lines plus explain, multi-period, stochastic) builds MIPs with PuLP and solves with HiGHS. We want to extract an engine package (FF-103) and keep the option of adding commercial solvers (Gurobi, P3+) without rewriting models.

## Decision

Keep **PuLP** as the modelling layer and **HiGHS** as the default solver, accessed through a small **solver adapter** interface in the engine package (`SolverAdapter.solve(problem, options) -> status`, name/version reporting). The extraction must produce **no change to results**; golden fixtures (FF-102) enforce this.

## Consequences

- No model rewrite; results stay identical.
- PuLP overhead on very large models may become a bottleneck (to be measured by FF-113); the adapter allows moving hot models to highspy directly or to another layer later.
- Every result can record engine and solver version.

## Alternatives considered

- **Pyomo** (richer, slower model build, migration cost).
- **OR-Tools / CP-SAT** (different paradigm, rewrite).
- **Direct highspy** (fastest, but a rewrite now with regression risk).
