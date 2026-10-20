# Golden results (FF-102)

Checked-in summaries of engine results; `tests/test_golden.py` re-runs every
case in `cases.py` and compares. Any engine refactor (e.g. FF-103) must keep
these identical.

| File | Case |
|---|---|
| G-S | Built-in sample "NA Footprint 2027" Run ($98.2706M, Reno closed) |
| G-M120 / G-M200 | stress-120 / stress-200 Run |
| G-INF | Sample without l9 / l9 capacity 1000 — infeasibility diagnostics |
| G-RMP | Sample roadmap, choose_timing and force_timeline (NPV) |
| G-ROB | Sample robust (expected / minimax / cvar_lite) with built-in shocks |
| G-EXP-S / G-EXP-M200 | Explain cards + counterfactuals (sample, stress-200) |

## Tolerance

The engine reports money in **$M rounded to 4 decimals** (i.e. $100), so
"to the cent" is bounded by what the API reports. Rules:

- Strings, ids, statuses, decisions (open/closed sets, event years): **exact**.
- Numbers: `|actual - golden| <= 1.5e-4` absolute — one reported digit, so a
  last-digit rounding flip passes. For any total ≥ $1.5M this is tighter than
  the plan §10.3 rule (drift > 0.01 % fails).

- Objective-indeterminate fields are not locked: stress-pack `transportCo2Kt`
  (carbon price 0) differs between equally-optimal solutions across platforms.

## Regenerating

Only when a result change is intended and reviewed:

    cd apps/api && .venv/bin/python -m tests.golden.regenerate
    git diff tests/golden/
