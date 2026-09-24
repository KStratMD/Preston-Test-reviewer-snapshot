# Blueprint B4 event/status verification

## Scope and provenance

The owner authorized the remaining event verification after promotion closeout
[PR #1271](https://github.com/KStratMD/Preston-Test/pull/1271).
The [B4 contract](../superpowers/plans/2026-09-02-tranche-2-mapping-contract-blueprint-retry-fixtures.md)
and [consumer guide](../blueprint/README.md#rollout-and-verification) define the matrix.
Required-check activation, branch protection and provider settings are excluded.
Test PRs are disposable, explicitly marked not for merge, and contain synthetic
data only. No attestation, token or export envelope is committed.

Executor: Codex / OpenAI / MSI / `C:\tmp\gacp-wsb2` /
`codex/blueprint-event-verification`, base
`b28a0973b2c784055d332ff3c17de90123825ec8`.
Independent reviewer: Claude Fable; plan cleared at `715783ee9d`, partial
outcome record cleared at `b44586c9fb`; updated record cleared at `e7fb5a9e32`.
[Updated independent review and limits](https://github.com/KStratMD/Preston-Test/pull/1273#issuecomment-5605174333).
Linux locator: MSI / Ubuntu / `/tmp/preston-full-promotion-linux`.
Linux baseline tested SHA: `715783ee9dc79ced016114d8466669bf438061fb`, Node v22.22.2.
No unattended process is claimed.

## Execution plan

1. Record the live branch heads, workflow definitions, required contexts and
   available GitHub identity. Keep protection unchanged throughout.
2. Obtain independent plan review, then run the existing Blueprint unit tests
   and Linux CLI harness at the exact transferred commit. Fixture tests are
   supporting evidence, never a substitute for live event delivery.
3. Open a disposable draft same-repository test PR against Working-Branch with a
   generic synthetic Blueprint and no workflow/code changes. Observe the
   `opened` run, then push an invalid schema and a restored valid draft on
   separate heads, waiting for each head's result. Expect success for a valid
   draft with `executable: false` and failure for an invalid draft.
4. Remove the Blueprint from that PR's diff, leaving only a test note, and
   observe success with `no blueprint changes`. Submit a clearly labelled
   COMMENTED test review through the REST API to check review-event dispatch. This does not count
   as approval or dismissal evidence.
5. With a second account, exercise a same-repository PR authored by someone
   other than the registered approver. Observe approval of the current head,
   then dismissal, and a push invalidating an earlier approval. Use a
   synthetic validated fixture with accurate synthetic-evidence wording;
   no customer integration or execution is authorized by the test.
6. With a second account's fork, observe Blueprint rejection with the exact
   `blueprints from forks are not verified` description; also verify a fork
   PR without Blueprint changes succeeds. Record any GitHub workflow
   permission/approval limitations rather than changing settings.
7. Record event, actor, PR, base/head SHAs, run URL, context state, description,
   executability and limits per case. Close completed disposable test PRs
   without merging. Independently review the evidence and remaining gaps,
   then follow the Copilot and final-CI process for the report PR.

Intermediate test/report heads intentionally suppress the ordinary CI matrix
through a subject-only marker. The trusted `pull_request_target` verifier is
observed separately; its event delivery must be demonstrated, not assumed.
No attestation registry changes or synthetic GitHub identities are allowed.

## Initial identity constraint

At the initial 05:xx UTC pass on 2026-09-09, the CLI's active account and sole
registered approver were `KStratMD`, and the repository fork list was empty.
The owner subsequently supplied `Fivrik`, an existing write collaborator, and
signed the browser into that account. Browser-authored test PRs now establish
the distinct PR author; CLI reviews remain attributable to `KStratMD`.
The identity prerequisite is resolved without an approver-registry change.

## Evidence

The local baseline passed 78 tests in eight suites with one snapshot, every
scenario in `tests/scripts/blueprint-cli.test.sh`, the terminology gate, the
shared-handoff gate and `git diff --check`. Machine-local log:
`C:\tmp\blueprint-event-gates.log`.

Claude Fable returned PLAN CLEARED after independently probing GitHub and
surveying source/plan evidence. It confirmed that the second account must be
a write collaborator for the same-repository case, and have repository access
for the fork case. Fork review dispatch can fail with a read-only token;
that must be recorded rather than resolved by widening permissions. Review:
`C:\tmp\blueprint-event-plan-review.json`.

## Live observations (verified 2026-09-09 UTC)

Disposable draft [PR #1272](https://github.com/KStratMD/Preston-Test/pull/1272)
was authored by `KStratMD`, from `codex/blueprint-event-probe`, against
Working-Branch base `b28a0973b2c784055d332ff3c17de90123825ec8`.
It changed only synthetic documentation, never verifier code or workflows.
The logs confirm the trusted checkout at that base SHA and a separate data
checkout at each PR head. The first and restored valid documents used synthetic
rung-2 fixtures, with no customer integration or system-access claim.

| Case | PR head | Live run | Result |
| --- | --- | --- | --- |
| Open valid draft | `4024409bba177cd0bf6554d3eb6f9d126b8f8785` | [34315738869](https://github.com/KStratMD/Preston-Test/actions/runs/34315738869) | Success; `structurally valid blueprint drafts`; `executable: false`, empty derived attestations, one required approval missing. |
| Push invalid schema | `3395f80dbf63e65da2feacd29e998e64f8bf7748` | [34315883992](https://github.com/KStratMD/Preston-Test/actions/runs/34315883992) | Expected failure; `invalid blueprint draft`; CLI reports invalid schema and exits 1. |
| Push restored valid draft | `60f26e4ac831d78641c568c5b6ab6af9de85d8ef` | [34316009945](https://github.com/KStratMD/Preston-Test/actions/runs/34316009945) | Success; `structurally valid blueprint drafts`; `executable: false`. |
| Push with no Blueprint in diff | `9ce5a8dc03ee89f23ef03c6f0c70db81bfd664e1` | [34316156586](https://github.com/KStratMD/Preston-Test/actions/runs/34316156586) | Success; exactly `no blueprint changes`; diff contains only a test note. |
| COMMENTED review by PR author | `9ce5a8dc03ee89f23ef03c6f0c70db81bfd664e1` | [dispatcher 34316281011](https://github.com/KStratMD/Preston-Test/actions/runs/34316281011), [verifier 34316288171](https://github.com/KStratMD/Preston-Test/actions/runs/34316288171) | Both succeeded; a new `no blueprint changes` status was published on the same PR head. This is comment-event delivery only. |

The [test review](https://github.com/KStratMD/Preston-Test/pull/1272#pullrequestreview-5150231211)
is explicitly COMMENTED, not APPROVED. Status IDs distinguish the original
non-Blueprint run (`53795540107`, 05:46:11Z) from the review-triggered run
(`53795617335`, 05:48:15Z). The latter workflow-dispatch run records the base
SHA as its run head, but publishes the status on the PR head; both were checked.
Earlier status IDs are `53795308401` (valid opened), `53795386827` (invalid)
and `53795462147` (restored). These are actual head statuses from GitHub's
commits status API, not inferred check-run conclusions.

PR #1272 is CLOSED with `mergedAt: null`; its branch was retained as evidence.
No test artifact was merged. Working-Branch protection was compared with the
pre-test JSON and is unchanged, requiring only the existing image-smoke and
build/lint/test contexts. Main remains unprotected at the promoted SHA.
No required-check activation occurred.

Machine-local evidence under `C:\tmp`: `blueprint-event-opened.log`,
`blueprint-event-invalid.log`, `blueprint-event-restored.log`,
`blueprint-event-nonblueprint.log`, matching status JSON files,
`blueprint-event-review-dispatch.log`,
`blueprint-event-review-verifier.log`, `blueprint-event-review-statuses.json`
and `blueprint-event-baseline.json`, all under `C:\tmp`.

## Second-account observations (verified 2026-09-09 UTC)

`Fivrik` authored same-repository draft [PR #1274](https://github.com/KStratMD/Preston-Test/pull/1274)
from `codex/blueprint-approval-probe`, against the same `b28a0973b2c784055d332ff3c17de90123825ec8`
base. Its initial head was `4024409bba177cd0bf6554d3eb6f9d126b8f8785`.
All approvals below are explicitly test-only approvals of synthetic content.
They authorize neither merging the test PR nor business execution.

| Case at initial head | Dispatcher | Verifier | Observed result |
| --- | --- | --- | --- |
| Opened, unapproved | Not applicable | [34374393441](https://github.com/KStratMD/Preston-Test/actions/runs/34374393441) | Success; `executable: false`; status `53834980190` at 16:05:31Z. |
| KStratMD APPROVED [review 5156872793](https://github.com/KStratMD/Preston-Test/pull/1274#pullrequestreview-5156872793) | [34374583813](https://github.com/KStratMD/Preston-Test/actions/runs/34374583813) | [34374599875](https://github.com/KStratMD/Preston-Test/actions/runs/34374599875) | Success; `executable: true`; status `53835133681` at 16:07:22Z. |
| Same review DISMISSED | [34375008038](https://github.com/KStratMD/Preston-Test/actions/runs/34375008038) | [34375019480](https://github.com/KStratMD/Preston-Test/actions/runs/34375019480) | Success; `executable: false`, empty attestations; status `53835460960` at 16:11:24Z. |
| KStratMD re-approved [review 5156945499](https://github.com/KStratMD/Preston-Test/pull/1274#pullrequestreview-5156945499) | [34375209652](https://github.com/KStratMD/Preston-Test/actions/runs/34375209652) | [34375220321](https://github.com/KStratMD/Preston-Test/actions/runs/34375220321) | Success; `executable: true`; status `53835606434` at 16:13:12Z. |

All four statuses say `structurally valid blueprint drafts`. The approved
envelopes bind the initial content hash
`9b28a5181477bd87966e8964c702b2e0430a7d15f5bc6782894d904c259ffc14`.
This sequence demonstrates why a green structural check is not execution approval.

The subsequent version-only content change is head
`734a5416b7f527ab66cc46955f9a884056f5a92d`, content hash
`2be7abcea5035c9698056864bd0508b1d25bca79fb4bca6336b886b82cfa0650`.
Its [push run](https://github.com/KStratMD/Preston-Test/actions/runs/34375520593)
succeeded with `executable: false` and empty attestations. Status `53835845933`
at 16:16:08Z says `structurally valid blueprint drafts`. The re-approval remains
APPROVED on the old head and was ignored for the new head. PR #1274 is closed
with `mergedAt: null`; its branch is retained.

## Live fork blocker

`Fivrik` created private fork `Fivrik/Preston-Test-blueprint-probe` and authored
two draft PRs against the same Working-Branch base. Both ran the trusted
base verifier workflow; both failed before reaching the CLI:

| Fork case | PR/head | Run | Actual result |
| --- | --- | --- | --- |
| Blueprint present | [#1275](https://github.com/KStratMD/Preston-Test/pull/1275), `4024409bba177cd0bf6554d3eb6f9d126b8f8785` | [34375053440](https://github.com/KStratMD/Preston-Test/actions/runs/34375053440) | Checkout refused; intended `blueprints from forks are not verified` status was not published. |
| No Blueprint in diff | [#1276](https://github.com/KStratMD/Preston-Test/pull/1276), `9ce5a8dc03ee89f23ef03c6f0c70db81bfd664e1` | [34375144405](https://github.com/KStratMD/Preston-Test/actions/runs/34375144405) | Checkout refused; intended success with `no blueprint changes` was not published. |

The `Checkout PR head as data only` step uses `actions/checkout@v7`, which
rejects a fork checkout under `pull_request_target` by default. The two run
logs reproduce this at 16:11:22Z and 16:12:14Z respectively. Later CLI steps
are skipped, so neither fork case emitted an executable envelope or a new
`blueprint-verify` commit status. Existing statuses on these reused SHAs belong
to other test PR events and cannot establish a fork result.

The current CLI also checks `git -C pr rev-parse HEAD` before classifying
forks or an empty Blueprint diff. A conditional workflow checkout alone would
therefore be insufficient. Recommended follow-up: classify those cases from
trusted GitHub metadata before requiring a local PR checkout, preserve the
head recheck before status publication, and skip fork checkout altogether.
Add regressions for both paths with no `pr/` directory, then repeat both live
fork events. This is a proposed repair, not an implemented or tested fix.
No unsafe-checkout opt-in, permission widening or protection change was made.
Working-Branch protection was byte-compared against the resumed baseline;
the required contexts remain the existing image-smoke and build/lint/test checks.

PRs #1275 and #1276 are closed without merge; branches and the private fork
are retained as evidence. The fork review-dispatch permission path was not
exercised; these are `pull_request_target` checkout failures.

## Stopping boundary and evidence locations

Required-check activation remains blocked by the reproduced fork failures.
The identity prerequisite is resolved. The observation pass does not claim
that the entire B4 rollout contract passes. Draft [report PR #1273](https://github.com/KStratMD/Preston-Test/pull/1273)
records the results. Claude Fable independently returned RECORD CLEARED on
`e7fb5a9e32`, verifying live evidence and endorsing the repair proposal.
That clears the record only: the repair is unimplemented, and activation is
blocked. Copilot and final report CI remain pending at this documentation head;
their eventual results belong in the PR's review record.

Machine-local evidence under `C:\tmp`: `blueprint-event-fivrik-*.log`, review
and status JSON snapshots, `blueprint-event-fork-blueprint.log`,
`blueprint-event-fork-nonblueprint.log`, and `blueprint-event-final-protection.json`.
The linked GitHub runs and reviews are the externally inspectable evidence.
