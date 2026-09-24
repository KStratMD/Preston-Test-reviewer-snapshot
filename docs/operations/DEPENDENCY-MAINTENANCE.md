# Dependency maintenance runbook

Use this runbook for recurring dependency triage and for implementing an approved
dependency update in Preston-Test. It does not authorize a package change, PR
closure, merge, main promotion, auto-merge rule, branch-protection change, or
schedule. A green inventory is evidence, never execution approval.

## Start with a verified snapshot

Run the shared-handoff resolver. Continue only when it reports `verified`; a
`degraded` result is an unavailable-current-state failure, not a cached success.

```powershell
node scripts/resolve-shared-handoff.mjs
npm run deps:inventory
```

Use `npm run deps:inventory -- --format markdown` for a readable snapshot and
repeat `--pr <number>` for a bounded review of selected open PRs. Its output is
timestamped evidence: it lists source errors and incomplete inputs rather than
claiming that they are empty or clean.

The inventory compares a dependency PR's merge base and head with the verified
Working-Branch authority. It does not decide compatibility, required checks,
mergeability, supersession, or whether a security alert applies to the candidate.
Read release notes and affected application code before deciding any of those.

## Classify before editing

Classify every candidate, with its evidence, as one of these:

| Classification | Handling |
| --- | --- |
| Routine candidate | A compatible patch/minor update with bounded affected code. Batch only with its package family. |
| Separate migration | A major change, runtime/build/install change, or an update with uncertain behavior. Give it a dedicated plan and PR. |
| Security-sensitive | Triage promptly. A security label does not override Node, CommonJS, authentication, data, or production-compatibility constraints. |
| Already represented | The integration lock/manifest evidence overlaps the PR. Re-check integrity, resolved URL and changed paths before proposing disposition. |
| Deferred | Record owner, evidence, and concrete revisit criterion. Do not silently convert a deferral into an ignore rule. |

Treat changes involving authentication, authorization, rate limiting, database,
Redis, cryptography, installation/build hooks, deployment, or release permissions
as separate migrations unless their evidence supports a narrower classification.
OpenTelemetry groups coordinate version trains; grouping is not a risk classification
or automatic approval, and does not make a 0.x minor safe. Evaluate 0.x minor and
every major change explicitly, using release notes, affected-consumer tests, and
`npm run audit-otel-graph`.

Playwright updates arrive as one grouped minor/patch PR, but Dependabot does not
move the `e2e-smoke` container image pinned in `.github/workflows/ci-minimal.yml`.
`tests/scripts/e2e-smoke-environment.test.sh` therefore fails that PR by design
until the image moves to the matching `mcr.microsoft.com/playwright:v<version>-noble`
digest. Resolve the digest from MCR, and confirm the same query reproduces the
current pin, before pushing the image change to the PR. A Playwright major is a
separate migration.

## Choose effort and reviewers

Use scripts before models for mechanical facts. The shared task-effort protocol
always applies; explicit owner settings and actual tool availability win.

| Phase | Default |
| --- | --- |
| Inventory, duplicate checks, factual summaries | OpenAI GPT-5.6 Luna, Low, when a model is needed |
| Routine implementation and focused tests | OpenAI GPT-5.6 Terra, Medium; Low only after behavior is fully settled |
| Routine independent review | Anthropic Claude Sonnet 5, Medium |
| Design, security-sensitive migration, consequential review | OpenAI GPT-6 Astra or Anthropic Claude Opus 5, High |
| Unresolved hard problem | An explicitly owner-selected available Claude Fable version, High |

Use different providers for executor and independent reviewer. The reviewer must
reproduce findings and choose its own sources for status claims. If the requested
model or effort cannot be selected, state the requested setting and the effective
or unknown setting; do not imply a model switch occurred.

## Implement a selected update

1. Add the task to the canonical handoff's In-flight work with provenance.
2. Inspect actual consumers, package release notes, changed lock entries and
   lifecycle scripts. Write a failing regression when behavior changes.
3. Keep related packages in a coherent batch. Do not include unrelated upgrades to
   make a PR look more complete.
4. Run focused local tests, typecheck, lint, package-family audits and relevant
   integration tests. Preserve evidence by command, exact tested SHA, environment,
   pass/fail count and known limits.
5. Get independent design review before non-trivial implementation and independent
   diff/adversarial review afterward. Copilot is the standard automatic reviewer.
6. Follow the shared final-head CI rule: review intermediate heads locally, then
   run hosted CI once on the cleared final tree. An identical-tree CI trigger does
   not require a duplicate review.
7. Present the PR, exact head, review evidence and green required checks for owner
   merge approval. Do not merge without it.

## Dependabot cutover

Routine version updates are configured to target `Working-Branch` only after that
configuration reaches the repository default branch. Security updates remain on
the default branch and are triaged separately. Do not assume routine-entry ignores
protect security PRs: an incompatible major security update, including an ESM-only
CommonJS conflict, needs an explicit assessment.

At the future cutover, snapshot all still-open old-target PRs and propose a
disposition for each. Preserve security fixes and intentional deferrals. Obtain
owner approval before closing or replacing any PR. Observe the first Dependabot run
and the available PR-limit headroom; do not assume how old-target PRs count toward
that limit. This runbook does not create the cutover, schedule a job, or close PRs.

## Completion record

Record the executor/reviewer, provider/model/effort, base and tested SHAs, checks,
review outcomes, observed CI result, PR URL, and remaining limits in the review
record and canonical handoff. Use `unknown` rather than invented values. Close the
In-flight assignment after the approved merge. Main promotion and external
publication remain separate decisions.
