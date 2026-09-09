# Blueprint fork status repair

## Scope and provenance

The owner approved merging [report PR #1273](https://github.com/KStratMD/Preston-Test/pull/1273)
and proceeding with its [reviewed repair](2026-09-09-blueprint-event-verification.md#live-fork-blocker).
That report merged as `d5fd33e2b3e4f73e364f4b05376f1d1f0e99a747` on
2026-09-09. Claude Fable independently endorsed the metadata-first design in
the [review record](https://github.com/KStratMD/Preston-Test/pull/1273#issuecomment-5605174333).

Executor: Codex / OpenAI / MSI / `C:\tmp\gacp-wsb2` /
`codex/blueprint-fork-status-fix`, base `d5fd33e2b3e4f73e364f4b05376f1d1f0e99a747`.
Reviewer: Claude Fable. Linux gate locator: MSI / Ubuntu /
`/tmp/preston-full-promotion-linux`. Latest tested repair SHA:
`051787fe09387666668f9db1795a72aedafc93f1`, Node v22.22.2.

## Bounded implementation plan

1. Reproduce the live failure locally: remove the temporary `pr/` checkout
   before fork Blueprint and fork no-Blueprint CLI cases. Assert exact status
   descriptions, no executable output, and no review/content reads. Add a
   workflow tripwire requiring the checkout condition to use the resolve job's
   API-derived repository, while preserving base/head pins and permissions.
2. In the CLI, list changed Blueprint files after the initial API head check.
   Classify forks and empty Blueprint diffs before requiring local Git data.
   Require the local HEAD match for same-repository Blueprint validation only.
   Keep the final API head recheck and publish only against the requested head.
   Skip the data checkout for forks in the workflow; do not enable unsafe checkout.
3. Verify absent-checkout success for same-repository non-Blueprint PRs, moving
   heads on both fork paths, and missing/mismatched checkout rejection for
   same-repository Blueprint data. Retain approval and freshness regressions.
4. Run focused tests and the actual Linux CLI harness at exact transferred SHAs,
   typecheck, lint, core coverage/ratchet and relevant documentation/workflow
   gates. Refresh deterministic metrics if production line counts change.
5. Obtain Claude Fable's independent diff/adversarial review, including an
   open-scope attempt to refute status claims. Follow dedicated Copilot review,
   fix/review loop, then one final CI run. Request repair PR merge approval.

The [B4 contract](../superpowers/plans/2026-09-02-tranche-2-mapping-contract-blueprint-retry-fixtures.md#task-b4-cli-validate-export-questionnaire-verify-and-validate-the-trusted-verification-workflow-docs-pr-b)
requires the two fork status outcomes. The local-checkout precondition is narrowed
to paths that consume local data; its SHA equality requirement remains intact.
No appendix, registry, attestation storage, provider configuration, required
context or branch protection changes belong to this repair.

## Rollout boundary

Local and PR-head tests do not prove repaired live fork event delivery. The
trusted verifier must first be available on the relevant base/default branches
through separately approved merge/promotion. Then repeat both disposable fork
PR cases and verify new head statuses. Required-check activation remains a
separate owner decision after that evidence passes.

## Verification evidence (2026-09-09)

- Red SHA `8aa3824830d230188b2bffdd2aebea4e97008c6c`: the workflow tripwire
  failed on the absent same-repository condition. The actual Ubuntu CLI harness
  failed its fork status assertion after removing `pr/`; no intended status
  had been published. Log: `C:\tmp\blueprint-fork-red.log`.
- Green implementation SHA `944461329e0d7625cf7f18b4e361c51d2764fe1d`:
  Windows focused tests passed 78 tests / eight suites / one snapshot;
  typecheck and full lint exited zero. Ubuntu Node v22.22.2 passed the CLI
  harness, the same focused tests, and core coverage (2,565 tests / 110 suites)
  with the unchanged 87-file ratchet. The initial broader sweep then caught a
  literal temporary fixture path in the link gate; that test-only spelling
  was corrected to the harness's existing path construction.
- Final local source SHA `418f54ad7e60d04ee0113fbf178e542fcd2981d6`:
  the Linux CLI harness passed again, including both metadata-only fork results,
  same-repository no-Blueprint success, moving-head rejection on both fork paths,
  and missing/mismatched local-checkout rejection for same-repository Blueprints.
  Workflow lint, handoff, inbound links (3,145 files, 5,689 references, zero broken),
  agent mirror, terminology, metrics, any-budget and strict-null gates passed.
  Logs: `C:\tmp\blueprint-fork-green.log`, `C:\tmp\blueprint-fork-final.log`,
  `C:\tmp\blueprint-fork-windows-tests.log`, `C:\tmp\blueprint-fork-typecheck.log`,
  and `C:\tmp\blueprint-fork-lint.log`.
- Assertion-strengthening SHA `051787fe09387666668f9db1795a72aedafc93f1`:
  requires exactly one new status in the current request window and confirms
  moving-head tests reach the final API head check. The complete CLI harness,
  workflow lint and the same documentation/metrics/type-budget gates passed
  again on Ubuntu Node v22.22.2 (`C:\tmp\blueprint-fork-final2.log`).

Metrics regeneration changes only its timestamp/source SHA, total TypeScript
line count and the matching evaluation token. Production TypeScript line count,
test/coverage metric blocks and coverage floors are unchanged.

Process deviation: a temporary Linux metrics snapshot commit used a command-local
hook override unnecessarily. Its patch was then committed in the Windows feature
branch with normal hooks active. No persistent hook configuration was changed;
subsequent commits and pushes use the normal hooks. This is recorded as a process
deviation, not a workflow exception for future work.

Claude Fable returned IMPLEMENTATION CLEARED for the production change at
`944461329e`, with no actionable findings ([review](https://github.com/KStratMD/Preston-Test/pull/1277#issuecomment-5606397924)).
Production CLI/workflow contents are unchanged since that source revision.
Its supplemental Node 20 harness run is not counted as Linux parity evidence;
the exact-SHA Node 22 runs above supply that evidence. Follow-up review covers
the final evidence/metrics and strengthened assertions. Copilot and final CI
are tracked in [repair PR #1277](https://github.com/KStratMD/Preston-Test/pull/1277).
No repaired live fork result or activation readiness is claimed.

## Merge closeout (2026-09-09 UTC)

[PR #1277](https://github.com/KStratMD/Preston-Test/pull/1277) merged into
Working-Branch at 21:38:57Z after owner approval, as
`8e998e03fafcd662eabe6c2765bcbdb8f7fe829b`. Its parents are
`d5fd33e2b3e4f73e364f4b05376f1d1f0e99a747` and final PR head
`eb5e9a1a54cd52491921f508c5a3898372de68a9`. The merge tree
`5b60d9af3a29045e139eddc45f9f51cee9464dc8` exactly matches the reviewed and
tested head. [Final review and CI evidence](https://github.com/KStratMD/Preston-Test/pull/1277#issuecomment-5606862345)
records Claude Fable's clearance, Copilot's zero-new-comment review and passing
PR-head CI: 15,458 tests / 727 suites, one snapshot; 10 tests and one suite
skipped; core 2,565 tests / 110 suites and the unchanged 87-file ratchet.
Both required checks passed. These are PR-head results, not merge-SHA CI results.
Promotion and repaired live fork verification remain separate rollout steps.
