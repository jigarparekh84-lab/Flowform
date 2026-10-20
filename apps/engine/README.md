# flowform-engine

Optimization engine extracted from `apps/api` (FF-103, ADR-007). The API
imports it; `app.solver`, `app.explain`, ... remain as thin aliases so existing
imports keep working.

    pip install -e apps/engine

Solvers are obtained through `flowform_engine.solvers` adapters
(`PulpHighsAdapter` default, `PulpCbcAdapter` fallback). Golden fixtures in
`apps/api/tests/golden/` guarantee results are unchanged.
