# Full Working-Branch promotion: preparation and preservation record

Status: source promotion and Railway/Cloudflare demo deployment complete.
The closing documentation branch also carries the preserved main history back
to Working-Branch; its PR is the authority for that integration's landing.

## Scope and provenance

The owner requested promotion of all work awaiting `main`, including work before
the recently completed GACP workstreams. The source is
`a225334a7f5be527fc1b25d5b44c1698fea2e9d5`; the recorded main base is
`12cba4aea84fead76279a3aaf32d6e51f3f74836`. Their direct endpoint diff contains
334 paths. Ahead/behind counts include selectively promoted and squash-merged
history and are not a count of missing features.

Executor: Codex | OpenAI | MSI | `C:\tmp\gacp-wsb2` |
`codex/promote-all-working-branch` | base
`a225334a7f5be527fc1b25d5b44c1698fea2e9d5` | Linux gate locator
`/tmp/preston-full-promotion-linux` (Ubuntu, invoked from Windows) | tested SHA
`0e59234cc79bb32e58b15d0686d2cf4a00084894` | independent reviewer Claude CLI,
explicitly selected Fable (`claude-fable-5`).
No unattended executor is claimed.

The [deployment procedure](../superpowers/plans/2026-08-10-deployment-plan.md),
[demo validation runbook](../runbooks/demo-release-validation.md), and
[completed prior promotion record](../SESSION-HANDOFF-2026-09-01.md) inform this
candidate. Historical completed steps and prior PR-specific waivers do not
establish fresh provider state or permission for a new provider mutation.

## Main-only preservation inventory

Git comparisons on 2026-09-09 UTC established:

- The earlier selective V8 metrics, health predicate and hosted image fixes are
  byte-identical at the two endpoints in their source/test/Dockerfile paths.
- Main commit `5966607b3c` has the same tree as Working-Branch ancestor
  `752f0dad70`; it introduces ancestry differences without additional tree content.
- Comparing main to the pre-promotion Working-Branch documentation commit
  `4b5a72e2a1` isolates 13 paths introduced or adjusted by the prior promotion.
  Six are source or tests; three contain promotion recipe/prose corrections;
  the remainder are historical handoff and metrics artifacts.

| Paths / behavior | Required disposition in the new candidate |
| --- | --- |
| `src/database/DatabaseService.ts`, `src/database/transfer/targetIdentity.ts` | Preserve main's shared forbidden PostgreSQL session-option keys, including timeout and application-name keys in read-only verification. |
| `src/database/transfer/preflight.ts`, corresponding unit test | Preserve structured schema-drift findings when a manifest table or required column is absent, without attempting an invalid row query. |
| `src/database/transfer/manifest.ts` | Preserve distinct primary-key, sort-column and sequence-column validation diagnostics. |
| `tests/unit/database/transfer/targetIdentity.test.ts` | Preserve the expanded rejected session-key cases. |
| Demo validation runbook and August 24 promotion plan | Preserve normalized log checks, local-only PostgreSQL TLS setting, negative boot, value-free configuration identity, cleanup, and exact-head/base merge safeguards. |
| August 10 deployment plan | Preserve the correction that a planned autodeploy change is not evidence of an actual provider setting. Reconcile with the later restored-autodeploy decision. |
| Metrics, evaluation/reviewer guide and historical handoff | Retain current truthful evidence and current handoff pointer; do not restore prior counts or present prior provider probes as live. |

The four source files are restored byte-for-byte from recorded main. The
main-only preflight and target-identity tests are restored, and additional tests
cover DatabaseService's complete rejected key set and manifest diagnostic
categories. The newer 54-table manifest, migration 065 and their count tests
remain intact. No blanket
conflict-side selection is justified merely by branch recency.

## Full release scope

The direct diff includes route-registration enforcement, static HTML/payment
portal hardening, tenant kill-switch authorization, embedded identity and role
grants, separation-of-duties changes, connector evidence/status corrections,
canonical mapping, Blueprint validation/approval verification, HTTP retry/auth
changes, fixture generation/provenance, dependency maintenance, and supporting
gates/documentation. The detailed contracts remain the plans and specs linked
by the [canonical handoff](../SESSION-HANDOFF-2026-09-07.md) and its prior record.
Open Dependabot PRs are not part of this promotion unless their changes are
already present in the frozen source; they are not implicitly approved upgrades.

## Release effects and current preflight

Verified 2026-09-09 UTC using Railway's project/service UI: Squire Demo,
production environment, Preston-Test-main, connected to `main`, autodeploy
enabled. The active successful deployment is
`4f9a120e-c0fd-423c-9426-7af15b1da06c`, labeled with the prior SQLite demo and
PostgreSQL readiness promotion. Both public health endpoints returned HTTP 200
at `2026-09-09T01:13:39Z`. This is a preflight observation, not a future-state
claim; re-probe immediately before release.

Seven changed public paths match the hosted workflow's push filter: the four
changed executive-package documents, deleted customer payment portal, payment
dashboard and review hub. Therefore this candidate cannot be represented as a
source-only merge with no hosted release. Provider settings and Blueprint
required-check activation have not been changed.

Issues #1119 and #1190 are already closed, with the later source fixes recorded
in the prior handoff; the former historical residual-scope remedy is not pending
merely because the original promotion plan described it.

## Verification and review

The owner clarified that Railway and Cloudflare are demo deployments and do not
need a production infrastructure posture. Railway remains disposable SQLite;
no durable hosted PostgreSQL, Azure resources, HA or production rollout program
is part of this promotion. PostgreSQL checks below are local/CI compatibility
tests of shipped code, not a requirement to provision a production service.

Claude Fable's first plan pass requested three corrections. The preparation
plan now explicitly includes each:

1. The merge gate must resolve Railway's enabled autodeploy: obtain an explicit
   release decision accepting the automatic disposable-demo deployment, or
   separately authorize a controlled pause and read-back. No pause is implied
   by preparation. If releasing automatically, verify the deployed SHA/tree,
   health/readiness, boot logs and deployment identity after merge.
2. Hosted-site release approval is a named merge precondition because the seven
   public paths trigger Cloudflare deployment. GHCR and reviewer-mirror
   publication are also release effects to disclose with the exact candidate.
3. Verification must include Windows typecheck/lint/build; focused transfer,
   DatabaseService, migrations, cardinality and health regressions; exact-SHA
   Linux full tests and core coverage/ratchets; generated-fixture PostgreSQL
   migration/transfer/round-trip integration; hosted PostgreSQL boot/restart
   and missing-key proof; Docker smoke; reviewer-mirror validation; Linux audit
   harnesses and all applicable final PR CI. A failed or unavailable check is
   a remaining gap, not a pass or an implied waiver.

The historical main-only source fixes were restored before resolving the
ancestry merge. The merge into this candidate retains both recorded branch
histories; conflicts and automatically merged paths were compared
against the documented preservation inventory. The final promotion to main
will use a true two-parent merge with head/base checks and post-merge parent/tree
verification. Synthetic preview objects are local verification only, not the
commit intended for release.

Metrics were regenerated after real test/coverage results. The
package manifest, lockfile and mirror manifests were reconciled and verified
against both branches without unrelated upgrades merely because
Git reported a conflict. The existing verified dependency install matches the
source lockfile exactly. Tests requiring a fresh install use an isolated target.

The reviewer identified the same main-only row-scan guard and seven-key policy
gaps. Its statement that all preservation risk lies in conflicts is not treated
as proof: every automatic merge is also inspected. The assignment is committed
on this candidate and will travel with it; the live Working-Branch stream will
receive the resulting preservation and closeout through the integration process.

Claude Fable cleared the corrected plan for local execution, explicitly without
merge readiness. Local review artifacts are
`C:\tmp\promotion-fable-plan-review.json` and
`C:\tmp\promotion-fable-plan-clearance.json`; runtime reported `claude-fable-5`.

Preservation regression evidence (Windows Node v22.23.1): the restored main
missing-table test failed against Working-Branch with `no such table`; four
read-only key cases and two manifest diagnostic cases also failed as expected.
After restoring main's four source files, the focused transfer and read-only
suites passed 54 tests in 19 suites. The standalone generated-SQLite reproduction
also now returns the structured failure. This is focused working-tree evidence,
not final candidate CI.

## Resolved candidate evidence

The ancestry merge `0e59234cc79bb32e58b15d0686d2cf4a00084894` has preservation
commit `2a99510ab08b93e17f5226e65f862ff987779e1d` and recorded main as parents.
Its tree is byte-identical to the preservation commit. Fable independently
classified all 136 paths main changed since the merge base: 100 retained
byte-identically, 32 superseded by Working-Branch with no main-only delta,
three regenerated metric artifacts, and one superseded historical handoff.
It found no unintended main-content loss. Its F1 stale August 24 handoff
reference was reproduced and corrected to link the September 1 historical
record. This is a bounded preservation review, not a claim that the reviewer
re-read every line of the previously reviewed Working-Branch payload.

Verification of that exact source candidate:

- Ubuntu Node v22.22.2: build and full CI coverage profile passed **15,458 tests
  in 727 suites**, with 10 skipped tests, one skipped suite and one passing
  snapshot. Core coverage passed **2,565 tests in 110 suites**, with all 87
  ratcheted files matching. Metrics were regenerated from these real results
  and transferred through Git; no counts were inferred from added tests.
- Linux metrics-tools, pre-push and PostgreSQL environment regression harnesses
  passed. Mirror dependency scan, handoff gate and inbound-link gate passed.
  Actual staged-mirror reproduction remains part of the final validation.
- Windows Node v22.23.1: typecheck, lint and focused preservation tests passed.
  PostgreSQL 15.18 disposable compatibility profile passed **57 tests in 11
  suites**, and the transfer manifest check passed with **54 tables**.
- The hosted Docker image built successfully. With disposable PostgreSQL it
  rejected missing approval-key configuration, then passed health/readiness
  before and after restart with three inactive configurations preserved,
  unchanged key count/digest, and no credential leakage in captured logs.
  The exact proof containers and network were removed afterward.
- With the existing SQLite demo settings, the same image passed health and
  readiness before and after restart, preserved three inactive configurations,
  served the review hub and payment dashboard, and returned 404 for the removed
  payment portal and unlisted metrics HTML. Browser inspection supplements
  those HTTP checks; HTTP 200 alone is not a content claim.

Local evidence: `C:\tmp\promotion-linux.log`,
`C:\tmp\promotion-postgres-proof.json`,
`C:\tmp\promotion-sqlite-demo-proof.json` and
`C:\tmp\promotion-fable-diff-review.json`. The Ubuntu shell wrapper for Docker
smoke could not reach a Docker socket; it did **not** pass. The runtime proofs
above used Windows Docker to run Linux containers. Final CI's Linux Docker
smoke must pass before merge.

The owner's main-promotion request and subsequent demo clarification define
the release target as the existing Railway SQLite and Cloudflare demo path.
No provider setting change, permanent PostgreSQL service or Blueprint required
check activation is included. Existing automatic deployments are the intended
release path; verify the deployed revision and demo health after promotion.

## Demo claim correction and incremental validation

Browser verification found five connector tiles with the correct `ev-ready`
class but stale visible `prod` labels. The static ledger also counted them
among 20 production-verified components. Fable reproduced the defect and
cleared the bounded correction plan. Commit `8fcfb0e4f9` added regression cases
which failed for the expected stale-label and nested-markup reasons; commit
`8c822c5399fb6a994a6d13af292b1d3bf3aaf3a2` fixed the visible labels, split the
ledger into 15 production-verified and five production-ready components, and
extended the existing connector chip gate to validate plain visible labels.
The gate covers connector tiles only; the static summary counts remain manual.

On that exact fix SHA, Ubuntu Node v22.22.2 passed the chip regression harness
and actual staged-mirror reproduction: **1,230 tests in 58 suites**, plus all
manifest audit recipes. Evidence: `C:\tmp\promotion-final-local.log`. Metrics
were regenerated again for the changed script; the full application and core
test results above remain tied to their original tested SHA, not relabeled as
a new run. Final CI will verify the final candidate.

The rebuilt hosted image at the fix SHA passed the SQLite restart/health/page
proof again (`C:\tmp\promotion-reviewed-demo-proof.json`). Browser inspection
confirmed the five visible `ready` labels, the 15/5 ledger, and a loaded payment
dashboard without console errors. The image contains the same application
source as the full-suite candidate; subsequent changes are the bounded HTML,
gate/harness and documentation/metrics corrections described here.

Claude Fable returned **CODE CLEARED**, with no findings, for the incremental
claim correction and metrics update. It independently ran the chip gate and
regression harness, verified the stale-link fix and ledger arithmetic, and
attempted to refute this record's status claims. Its review distinguishes those
checks from the executor's full-suite/container evidence and does not claim
CI or deployment clearance. Evidence: `C:\tmp\promotion-fable-final-review.json`.

## Promotion and demo release completion

[PR #1268](https://github.com/KStratMD/Preston-Test/pull/1268) merged at
`2026-09-09T02:28:25Z` as `f60267254714e3f92053e9a870941503f42a063b`.
Fresh pre-merge reads confirmed both recorded branch heads. The resulting
commit has exactly two parents: prior main `12cba4aea84fead76279a3aaf32d6e51f3f74836`
and final PR head `edba0026e3cdaca74e908456aa18e4906dbeda43`. Its tree
`2ecb0e1d22e31c2cfd5b7c6d38395f94ea89ac6f` is identical to the reviewed tree.
No squash, branch deletion or protection bypass was used.

Copilot review `5148964837` on `822784dc3347a2431fd3134fe33dd3e9cb16719e`
generated zero comments, with 188/328 files reviewed at Lite effort. Its generic
human-attention note about the broad security-related scope was not an
actionable finding. The final empty CI commit preserved that exact tree.
[Final PR CI](https://github.com/KStratMD/Preston-Test/actions/runs/34301666761)
passed 15,458 tests in 727 suites, 10 skipped tests, one skipped suite and one
snapshot; core passed 2,565 tests / 110 suites with the 87-file ratchet.
All applicable checks passed, including the Linux Docker smoke. Public mirror
publication was intentionally skipped on the PR and has a separate main run.
These are PR-head results; the [main CI run](https://github.com/KStratMD/Preston-Test/actions/runs/34303351409)
is separate evidence and is not assumed green merely from tree identity.

Railway deployment `a93e4378-bbd0-4c8f-8a2a-d13b43fdd99a` succeeded using
`Dockerfile.hosted`; its Details panel links directly to the promoted commit.
At `2026-09-09T02:30:18Z`, health/readiness were 200, and the three expected
sample configurations were persisted and inactive, matching the pre-release
baseline. Review hub/payment dashboard returned 200; removed payment portal
and unlisted metrics HTML returned 404. The displayed startup range showed the
server starting on port 8080 at `02:29:02Z` without an error. This is a bounded
startup-log observation, not a claim about all future requests or logs.

The [Cloudflare deployment and smoke run](https://github.com/KStratMD/Preston-Test/actions/runs/34303351385)
completed successfully for that same merge SHA. Browser verification at the
live demo confirmed the five `ready` badges and 15/5 ledger with no console
errors. The [GHCR publication run](https://github.com/KStratMD/Preston-Test/actions/runs/34303351386)
also succeeded. The [public reviewer mirror run](https://github.com/KStratMD/Preston-Test/actions/runs/34303351404)
records its own validation and publication outcome; it is separate from the
successful PR snapshot checks above.

Local release evidence: `C:\tmp\promotion-merge-record.json`,
`C:\tmp\promotion-final-ci.log`, `C:\tmp\promotion-live-baseline.json`,
`C:\tmp\promotion-railway-release.json` and
`C:\tmp\promotion-hosted-release.log`. Verified 2026-09-09 UTC.

Closeout provenance: Codex | OpenAI | MSI | `C:\tmp\gacp-wsb2` |
`codex/full-promotion-closeout` | base
`f60267254714e3f92053e9a870941503f42a063b` | reviewer Claude Fable, then Copilot.
Relative to promoted main, the closeout updates handoff/review documentation
and changes two test-fixture edits to the repository's `sed -i.bak` convention
with backup cleanup, following Copilot's portability finding (including its
suppressed duplicate). Both GNU-only forms were confirmed in the tree and the
portable convention was confirmed in existing harnesses. Linux regression
verification is recorded in the closeout PR; no BSD/macOS execution is claimed.
Application source remains unchanged relative to promoted main. Integrate
this descendant through a normal reviewed PR into Working-Branch with a merge
commit, preserving main ancestry and bringing its safeguards into the live
handoff stream. No further main deployment or Blueprint activation is implied
by that bookkeeping integration.
