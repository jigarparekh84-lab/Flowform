# CI gates and branch protection (CR-001)

> Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) · plan: [COMMERCIAL_READINESS_PLAN.md §5](COMMERCIAL_READINESS_PLAN.md#a-platform-reliability-and-security) (CR-001)

The workflow enforces the gates; **GitHub enforces that the gates ran**. This
file is the repository half of CR-001: the exact check names, the settings that
make them blocking, and the one plan limitation that can block the whole thing.

Nothing here is stored in git — a ruleset is repository configuration. That is
why the steps live in a document instead of in a config file.

---

## 1. The five jobs

A required status check is matched by the job's **displayed `name:`**, not its
job id. Renaming a job therefore detaches the gate without any error: the check
simply never reports and the PR waits (or merges if the rule was removed).

| Check name (must match exactly) | Job | What it proves | Timeout |
|---|---|---|---|
| `Web (data tests, lint, type-check, build)` | `web` | strict `tsc -b`, test typecheck, oxlint, `npm run test:data` (10 suites), production build | 10 min |
| `API (mypy, lint, pytest)` | `api` | mypy over `app/`, ruff E9/F63/F7/F82, `alembic upgrade head` + drift check, full pytest against PostGIS + Redis | 10 min |
| `E2E (Playwright critical path)` | `e2e` | identity → project → async run → compare → brief export → share, in both themes | 20 min |
| `Prometheus rules (promtool check + unit tests)` | `prometheus` | `promtool check rules` and the firing/quiet unit tests for the 10 SLO alerts | 5 min |
| `Benchmark (stress-200 budget)` | `benchmark` | stress-120/200 solver benchmark within `vars.STRESS_TIMEOUT_S` | 10 min |

The benchmark name is deliberately **static**. It used to interpolate
`vars.STRESS_TIMEOUT_S`, which meant changing that variable silently renamed the
check and detached it from the ruleset.

### What to require

Require the first four. Treat `Benchmark (stress-200 budget)` as advisory until
you have timings you trust on shared runners — a solver benchmark on a noisy
2-core runner is the one gate likely to flake, and a flaky gate gets bypassed,
which costs more than it buys.

---

## 2. Plan prerequisite

Classic branch protection **and** rulesets are unavailable on private
repositories under GitHub Free: both APIs answer
`403 "Upgrade to GitHub Pro or make this repository public"`.

This repository is private, so the gate requires **GitHub Pro** (personal) or
**GitHub Team** (organisation). Publishing the repository also lifts the
restriction, but that is a product decision, not a CI one.

---

## 3. Make the checks blocking

Do this **after** the workflow has run once on the repository, otherwise the
check names are not yet offered in the picker.

1. **Settings → Rules → Rulesets → New branch ruleset.**
   Target `master` (add `main` if the default branch is ever renamed),
   enforcement **Active**.
2. **Require a pull request before merging** — 1 approval, *Dismiss stale pull
   request approvals when new commits are pushed*, *Require conversation
   resolution before merging*.
3. **Require status checks to pass** — add the four names from §1 verbatim, then
   tick **Require branches to be up to date before merging**. Without that tick a
   PR can pass on a base that has since broken.
4. **Block force pushes** and **Restrict deletions**.
5. **Leave the bypass list empty.** On a one-person repository an admin bypass
   means the gate never blocks anything, and the first failed check becomes a
   habit rather than a signal.

Repository-side settings that back the workflow: Actions enabled with the
default read-only `GITHUB_TOKEN` (the workflow needs no secrets), and optionally
the `STRESS_TIMEOUT_S` variable as the benchmark budget.

---

## 4. Not gates yet

These have no workflow, so they cannot be required — adding a required check
before it exists blocks every PR:

| Missing | Needs |
|---|---|
| Code scanning | a CodeQL workflow |
| Dependency alerts | Dependabot config / GitHub security settings |
| Container scanning | an image-build job |
| Secret scanning | GitHub security settings (push protection) |

They are the "security baseline" line in [COMMERCIAL_READINESS_PLAN.md §6](COMMERCIAL_READINESS_PLAN.md#week-3--make-it-observable-and-testable).

The E2E job runs with `AUTH_MODE=dev` because WorkOS cannot be signed into
unattended. Everything after identity is the same tenant-scoped API a real
session uses, but **WorkOS sign-in itself stays a staging or manual check** and
is not covered by any gate above.
