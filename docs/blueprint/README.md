# Blueprint Factory

These are internal implementation artifacts in this tranche; nothing here is customer-facing.
Blueprints are versioned JSON discovery and integration specifications. They describe systems,
mapping and ownership rules, approval policy, evidence, golden test cases and proposal inputs.
The [design contract](../superpowers/specs/2026-09-02-governed-assurance-control-plane-design.md)
and [Workstream B plan](../superpowers/plans/2026-09-02-tranche-2-mapping-contract-blueprint-retry-fixtures.md)
define this tranche. Platform names in fixtures illustrate the schema; they do not select a first platform.

## Local commands

Run from a trusted checkout with Node 22 and installed dependencies:

```bash
npm run blueprint:questionnaire
npm run blueprint:questionnaire -- --out /tmp/questionnaire.md
npm run blueprint:validate -- /path/to/blueprint.json
npm run blueprint:export -- /path/to/blueprint.json --out /tmp/blueprint-package
```

Local validation and export never return `executable: true`. They have no GitHub-derived attestations.
Validation exits 0 for a structurally valid draft, 1 for invalid content, and 2 for usage errors.
Export produces five artifacts: `blueprint.export.json`, `proposal.md`, `backlog.md`,
`control-matrix.md`, and `test-plan.md`. Local exports carry `source: null` and
`reviewStateHash: null`. Do not commit export envelopes or approval records.

Blueprint documents intended for PR approval belong under `docs/blueprints/**/*.json` (plural).
This documentation and the trusted registry live under `docs/blueprint/` (singular).
The terminology gate scans both subtrees. Do not put credentials or customer payloads in examples.

## Approval and validation

The JSON document carries approval policy only. Attestations are never stored in the repository;
they are derived from GitHub reviews in memory. The trusted registry is
[approvers.json](approvers.json), protected through branch protection and code review.
Fixture principals live only under `tests/fixtures/blueprints/`.

Only active registered reviewers holding a requested role count. Each review must approve the
current PR head, and a reviewer counts once. The PR author cannot attest, regardless of
`metadata.author`. A later decisive review can withdraw an approval. The existing registry has
one approver, so a PR authored by that account needs a separately registered eligible reviewer
before it can be executable. Local flags and edited JSON cannot supply an attestation.

Executability requires structurally valid canonical mappings, an ownership rule for each target,
resolved system references, golden cases matching the engine's exact output or literal error
substring, every system at evidence rung 2 or higher, non-discovery document evidence,
no unresolved blockers, and enough distinct verified approvers of the current content hash.
Fixture-level executability establishes neither live-system readiness nor permission to perform a write.
A governed write requested by a host-asserted principal is blocked at runtime until a Squire-verified requester re-submits it; executability of this document does not admit such a request.

## Trusted verifier

The workflow resolves the PR once in a read-only job, checks out trusted code at the recorded
`base.sha`, installs its dependencies, and checks out the PR head under `pr/` as data only.
Separating resolution into its own job gives that step only `pull-requests: read`; GitHub Actions
does not offer per-step permission scopes. The verifier command is:

```bash
npm run blueprint:verify-and-validate -- --pull 123 --head <full-commit-sha>
```

It requires `GITHUB_TOKEN` and `GITHUB_REPOSITORY`. It verifies the `pr/` checkout's head,
reads only Blueprint blobs changed by that PR, derives reviews at the same head, and checks
the live head again before publishing the `blueprint-verify` status on that SHA.
The command prints envelopes to stdout and informational `executable: true/false` summaries
to stderr and the Actions summary. A green check means **structurally valid draft**, including
drafts without enough approvals. Fork PRs touching Blueprints receive a failure status;
PRs touching no Blueprints receive success. Deleted Blueprints produce no executable envelope.

## Freshness at consumption

Consumers call `assertFresh(envelope, { owner, repo, pullNumber, specPath, api })` before using
an envelope as proposal/SOW input or acting on executability. Coordinates come from trusted
consumer configuration; production binds `githubApi` with those same coordinates. There is
no stored-envelope consumer CLI in this tranche and no stale-result override.

The function fetches the live PR, confirms the envelope's source and head, checks changed-file
membership, fetches Blueprint bytes from GitHub, verifies hashes, fetches the trusted registry,
re-derives approvals, and recomputes validation. It never reads `envelope.spec`,
`envelope.attestations` or `envelope.validation.executable`. A consumer acts only on the
returned `spec` when the returned result is executable.

- `verification_stale`: source, head, content or review state changed; an open-PR registry hash differs; or the PR closed without merge.
- `verification_unavailable`: GitHub or registry verification could not be completed. There is no cached fallback.
- `blueprint_not_in_pull`: the configured path is absent from the PR's changed files or was removed. A rename uses its new filename.
- `not_executable`: fresh verification completed, but approval, evidence, blockers or other validation requirements are unmet; the result includes reasons.

For **open PRs**, the prescribed authority is the PR's **recorded `base.sha`**, on both producer
and consumer. This SHA can lag the live base-branch tip. A registry revocation committed only
at the newer base tip is therefore not detected by this mode. The pre-merge guarantee is
relative to the recorded base registry, not automatic detection of every base-tip registry change.
This limitation was independently reviewed and retained to implement the owner's specified
working answer without changing the registry-authority policy.

For **merged PRs**, the Blueprint at the current `base.ref` branch head must hash-match the
approved PR content. The registry at that canonical head is applied directly: a revoked approver
stops counting, while the old envelope's registry hash is informational. Changed canonical content
requires consumer reconfiguration to the PR that approved it. Content hashes use sorted-key JSON;
registry hashes use raw bytes, and the repository pins JSON files to LF.

A failed review-event dispatcher can leave an old status and summary visible. Neither is authority:
the consumer's independent verification detects changed reviews, a changed head or unavailable
GitHub. No remote verify-and-act is atomic; the returned payload is the exact content approved
at the result's head, which was live at both bounds of the reviews read.

Both the producer and `assertFresh` reject blueprint verification for a PR whose head repository
differs from the configured repository, or is unavailable. The consumer reports `verification_stale`.

The workflow skips the PR-data checkout for forks. The CLI classifies fork and no-Blueprint
diffs from GitHub metadata, with no local checkout required for those outcomes. Only
same-repository Blueprint validation requires `pr/` at the requested head. Every published
status still requires API head equality before classification and immediately before posting.

## Current limits and follow-up work

GitHub review and file pagination is capped at 100 pages per collection. Repeated URLs are
detected after sorting query parameters and removing fragments. Exceeding the cap fails
verification without returning a partial collection; `assertFresh` reports `verification_unavailable`.

Golden cases exercise canonical field mappings. The v1 `transformations` array is retained from
the plan but is not interpreted or validated as executable business rules. Any future executor
must define and test that contract before consuming those entries. Blueprint executability is
not evidence that such rules were exercised.

For a PR with multiple blueprints, verifier stdout contains successive pretty-printed JSON
documents. It is an operator log, not a single JSON transport document; a machine consumer needs
a framing contract before consuming multiple results. The trusted consumer API remains `assertFresh`.

The Blueprint modules have dedicated tests but are outside the existing core type-safety and
per-file coverage ratchets. Adding this scope is follow-up work requiring its own baseline review.

## Rollout and verification

Both workflows land **non-required**. Promotion to `main` is separately owner-approved.
After promotion makes dispatch available, use a test PR to verify the head status for push,
approval, dismissal, fork and non-Blueprint events. Only then may the owner approve adding
`blueprint-verify` as a required context on the relevant branches. This PR changes no settings.

```bash
npx jest --config jest.fast.config.cjs tests/unit/blueprint tests/unit/cli/blueprint.test.ts
bash tests/scripts/blueprint-cli.test.sh
npm run audit-terminology
```

The shell harness uses a loopback-only fixture API and a temporary Git repository. It tests
local non-executability, the five exports, live derivation with a synthetic approval, withdrawn
and old-head approvals, a failed dispatcher, fork handling, non-Blueprint PRs and API failure.
