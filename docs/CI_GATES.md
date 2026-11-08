# CI gates and branch protection (CR-001)

> Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) · plan: [COMMERCIAL_READINESS_PLAN.md §5](COMMERCIAL_READINESS_PLAN.md#a-platform-reliability-and-security) (CR-001)

The workflow enforces the gates; **GitHub enforces that the gates ran**. This
file is the repository half of CR-001: the exact check names, the settings that
make them blocking, and the one plan limitation that can block the whole thing.

Nothing here is stored in git — a ruleset is repository configuration. That is
why the steps live in a document instead of in a config file.

---

## 1. The gate jobs

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
| `Analyze (python)` | `analyze` (`python`) | CodeQL security queries over `apps/api` and `apps/engine`, `build-mode: none` | 20 min |
| `Analyze (javascript-typescript)` | `analyze` (`javascript-typescript`) | CodeQL security queries over `apps/web` | 20 min |
| `Dependency review` | `review` | a pull request that introduces a high or critical advisory fails | 10 min |

The last three come from their own workflows — [`codeql.yml`](../.github/workflows/codeql.yml)
and [`dependency-review.yml`](../.github/workflows/dependency-review.yml) — rather
than from `ci.yml`, because they need different permissions and triggers.

`github-advanced-security` also publishes a `CodeQL` summary check alongside the
two `Analyze (…)` jobs. Do not require it: the per-language jobs are strictly
finer-grained, so requiring the summary only adds a way for the gate to detach
if a language is ever removed from the matrix.

The benchmark name is deliberately **static**. It used to interpolate
`vars.STRESS_TIMEOUT_S`, which meant changing that variable silently renamed the
check and detached it from the ruleset.

### What to require

All eight are currently required (see §3). `Benchmark (stress-200 budget)` was
meant to stay advisory until its timings on shared runners were trusted, and it
is the one gate likely to flake — a solver benchmark on a noisy 2-core runner
can miss its budget for reasons unrelated to the change. If it starts flaking,
demote it to advisory rather than bypassing it: a flaky gate gets bypassed
routinely, which costs more than it buys.

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
3. **Require status checks to pass** — add the names from §1 verbatim, then
   tick **Require branches to be up to date before merging**. Without that tick a
   PR can pass on a base that has since broken.
4. **Block force pushes** and **Restrict deletions**.
5. **Leave the bypass list empty.** On a one-person repository an admin bypass
   means the gate never blocks anything, and the first failed check becomes a
   habit rather than a signal.

Repository-side settings that back the workflow: Actions enabled with the
default read-only `GITHUB_TOKEN` (the workflow needs no secrets), and optionally
the `STRESS_TIMEOUT_S` variable as the benchmark budget.

### Automated equivalent

Once the plan allows rulesets, the same policy can be applied without the UI.
It takes **two calls**, because the API rejects any `parameters` object on the
`pull_request` rule at creation time — even an empty `{}` returns
`422 Invalid property /rules/N: data matches no possible input`. Create the rule
bare, then `PUT` the full rules array to set its options.

**Step 1 — create.** The pull-request rule is deliberately parameterless here;
`required_status_checks` does take parameters at create.

```bash
gh api --method POST repos/:owner/:repo/rulesets --input - <<'JSON'
{
  "name": "master-gates",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/master"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request" },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Web (data tests, lint, type-check, build)" },
          { "context": "API (mypy, lint, pytest)" },
          { "context": "E2E (Playwright critical path)" },
          { "context": "Prometheus rules (promtool check + unit tests)" },
          { "context": "Benchmark (stress-200 budget)" }
        ] } }
  ]
}
JSON
```

A bare `pull_request` rule resolves to `required_approving_review_count: 0` with
`dismiss_stale_reviews_on_push` and `required_review_thread_resolution` both
`false`, so step 2 is what turns those on.

**Step 2 — configure the pull-request rule.** Re-send every rule unchanged;
this endpoint replaces the whole array.

```bash
gh api --method PUT repos/:owner/:repo/rulesets/$RULESET_ID --input - <<'JSON'
{
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Web (data tests, lint, type-check, build)" },
          { "context": "API (mypy, lint, pytest)" },
          { "context": "E2E (Playwright critical path)" },
          { "context": "Prometheus rules (promtool check + unit tests)" },
          { "context": "Benchmark (stress-200 budget)" }
        ] } }
  ]
}
JSON
```

On a single-maintainer repository keep `required_approving_review_count` at `0`.
GitHub never counts an author's approval of their own pull request, so `1` locks
the owner out of their own branch; the only ways past it are an admin bypass
(which defeats the gate) or a second maintainer. Drop the `Benchmark` entry if
you decide to keep it advisory.

### Applied to this repository

The repository was made public to lift the Free-plan restriction, then the
ruleset was created and exercised.

| Setting | Value |
|---|---|
| Ruleset | `master-gates`, id `26768673`, enforcement `active` |
| Target | `refs/heads/master` |
| Bypass list | **empty** — no admin escape hatch |
| Required checks | all eight from §1, `strict` (branch must be up to date) |
| Pull-request rule | required, 0 approvals, stale reviews dismissed, threads resolved |

Verified on 2026-11-07 with a throwaway PR carrying one unparseable Prometheus
expression: `promtool` failed with `unclosed left parenthesis` (exit 1), GitHub
reported `mergeStateStatus: BLOCKED`, and an attempted merge was refused with
*"the base branch policy prohibits the merge"*. The PR and its branch were then
deleted; `master` was never touched.

### Verifying that it actually blocks

Push a branch with one deliberately failing assertion, open a pull request and
confirm the failing job appears as a **required** check and the merge button
stays disabled. Then close the pull request and delete the branch.

A ruleset that was never tried against a red build is indistinguishable from no
ruleset: a check name can be misspelled, the rule can target the wrong branch,
or the job can be renamed later — all of which fail *open*. This is also the
reason the benchmark job has a static name.

### Adding a required check later

A required check only ever attaches to a pull request that starts the workflow.
A pull request opened *before* that workflow reached the default branch will
never report the new context, so — the context being required — it can never
merge. The gate fails closed against exactly the pull requests it was not
applied to.

Any new push fixes it. For an open Dependabot PR the fix is to comment
`@dependabot rebase`, which is also what clears the `BEHIND` state that
`strict_required_status_checks_policy` produces whenever `master` moves. Worth
knowing when the security workflows are added: the dependency PRs already open
at that moment are the ones that need it.

---

## 4. Not gates yet

These have no workflow, so they cannot be required — adding a required check
before it exists blocks every PR:

| Missing | Needs |
|---|---|
| Container scanning | an image-build job — the Dockerfiles are built outside CI today |
| Secret scanning | GitHub security settings (push protection); free on public repositories |

Code scanning and dependency review are now gates (§1). Dependabot itself keeps
two separate roles that are easy to confuse:

- **Version updates** — [`.github/dependabot.yml`](../.github/dependabot.yml),
  npm + pip + the action pins, weekly and grouped. The pip entry relies on
  Dependabot recognising `requirements.in` and re-running pip-compile, so the
  hashed lock stays generated rather than hand-edited. `pulp` and `highspy` are
  ignored: they are exact pins for solver reproducibility, not lag.
- **Alerts and security updates** — repository settings, not files. Enabled for
  this repository via `PUT /repos/{owner}/{repo}/vulnerability-alerts` and
  `PUT /repos/{owner}/{repo}/automated-security-fixes`. Alerts produce **no
  check run**, so they can never be a required status check; that is exactly why
  `Dependency review` exists.

They are the "security baseline" line in [COMMERCIAL_READINESS_PLAN.md §6](COMMERCIAL_READINESS_PLAN.md#week-3--make-it-observable-and-testable).

The E2E job runs two suites. The critical path uses `AUTH_MODE=dev` because a
real WorkOS tenant cannot be signed into unattended; everything after identity is
the same tenant-scoped API a real session uses. The identity round trip
(`npm run test:e2e:auth`) covers the provider leg that bypass skips — signed
state, redirect, `/auth/callback`, code exchange, RS256/JWKS verification, the
`client_id` claim check and switching the active organization (the new token's
`org_id` and role, RBAC following it, plus both failure paths: a stale listing
entry that is verified away before it can be offered, and a switch revoked
mid-flight that leaves the visitor in their own workspace with the reason shown)
— against a loopback WorkOS stand-in
(`apps/api/scripts/stub_workos.py`), with no mock inside the API or the web
session layer.

What still stays a staging or manual check is the real tenant: AuthKit's own UI,
the redirect allowlist in the WorkOS dashboard, and a live JWKS endpoint.
