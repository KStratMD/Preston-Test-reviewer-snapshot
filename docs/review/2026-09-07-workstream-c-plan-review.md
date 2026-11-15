# Workstream C review record

Owner assignment: Codex executes [Tasks C1–C3](../superpowers/plans/2026-09-02-tranche-2-mapping-contract-blueprint-retry-fixtures.md), Claude independently reviews before and after implementation, followed by Copilot and final CI. The owner selected Claude Opus after the default model exhausted its credits. Opus cleared C1, then independently cleared the corrected C2/C3 plan and acceptance tests. Implementation and its final verification/review are separate from this plan clearance.

Provenance: Codex | OpenAI | MSI | C:\tmp\gacp-wsb2 | codex/gacp-workstream-c | original base bc7ae71b4318df1646684f0e7da936c045067cea, integration base 4ac68fceb2641053e3d275698213e2018b01b01d | Linux gate locator MSI / Ubuntu /tmp/gacp-wsb2-linux | full Linux profile tested SHA 9501dc7bc7cf972f9f824f4ebe00b67dfa668a18, Node v22.22.2 | reviewer Claude CLI (Opus 5). No unattended process is claimed by this record.

Claude's first verdict was **NEEDS CHANGES**. Source inspection reproduced:

- [Stripe authentication](../../src/connectors/StripeConnector.ts) calls `/account` through `makeRequest` and can return false after its mapped error; it is missing from the six-connector inventory.
- [Shopify authentication](../../src/connectors/ShopifyConnector.ts) reaches `makeRequest` indirectly through `getSystemInfo`, so the prescribed direct-call AST query cannot reproduce the claimed inventory.
- The executor's corrected transitive inventory additionally found [BusinessCentral](../../src/connectors/BusinessCentralConnector.ts): without a configured company ID, authentication calls `fetchCompanyId`, which requests `/companies`. This source-confirmed eighth active case must be included with a mocked successful OAuth token response. The transitive output also lists Adyen and ShipStation, whose guards are classified separately below; ten syntactically reachable classes does not mean ten active base-initiated authentication probes.
- [SuiteCentralProduction initialization](../../src/connectors/SuiteCentralProductionConnector.ts) requires a healthy health response before retaining production mode; the illustrative mock omits that property.
- [Sensitive transport](../../src/core/BaseConnector.ts) needs explicit retry/authentication and error-redaction acceptance tests.
- [ShipStation](../../src/connectors/ShipStationConnector.ts) does not have the `ensureAuthenticated` cycle cited as the rationale for retaining its guard. Its guard remains unchanged with the known probe-bypass defect deferred; [Adyen's guard](../../src/connectors/AdyenConnector.ts) does protect that cycle.
- [RetryService](../../src/resilience/RetryService.ts) must clamp HTTP Retry-After waits to the configured maximum, and the bypass gate needs both mirror allowlist and manifest wiring.

The plan's **Execution corrections proposed 2026-09-07** section supplies the bounded resolutions. The initial follow-ups hit a credit limit without a verdict. On the owner-selected Opus model, the first review cleared C1 and identified three remaining corrections: explicit sensitive 401 cause/class/state handling, complete mirror file lists, and durable eight-case inventory wording. Those corrections and failing class/state assertions were supplied; the bounded follow-up verdict was **CLEARED — C2 and C3 may proceed** (verified 2026-09-07 from the review outputs below). No failed or absent review is counted as clearance.

Machine-local evidence:

- `C:\tmp\gacp-wsc-plan-review.json`: original independent findings.
- `C:\tmp\gacp-wsc-plan-corrections-review.json`: usage limit response.
- `C:\tmp\gacp-wsc-plan-retry-review.json` and `C:\tmp\gacp-wsc-plan-retry2-review.json`: owner-requested retries also returned exhausted usage credits, with no review verdict (verified 2026-09-07).
- `C:\tmp\gacp-wsc-plan-opus-review.json`: Opus cleared C1 and identified the three remaining C2/C3 corrections.
- `C:\tmp\gacp-wsc-opus-b1-followup.json`: Opus independently cleared the C2/C3 corrections and acceptance tests. It inspected the working-tree deltas; this is not a completed-implementation review.
- `C:\tmp\gacp-wsc-baseline.log`: RetryService, 45 tests passed.
- `C:\tmp\gacp-wsc-connector-baseline.log`: BaseConnector and SAP, 35 tests passed across two suites.
- `C:\tmp\gacp-wsc-c1-red.log`: prepared classifier tests failed because the new module does not exist, as expected for the red phase.
- `C:\tmp\gacp-wsc-transitive-inventory.cjs` and `.log`: class-local TypeScript call-graph query and output, including the newly identified BusinessCentral route; this is static reachability evidence, not a runtime termination test.
- `C:\tmp\gacp-wsc-c1-green.log`: C1 passed 35 tests after the module was implemented in commit `07def32a76`.
- `C:\tmp\gacp-wsc-c2-state-red.log` and `C:\tmp\gacp-wsc-matrix-red.log`: transport class/state failures and actual auth-probe/call-count failures reproduced before C2 implementation.
- `C:\tmp\gacp-wsc-c3-gate-red.log`: Linux Node v22.22.2 at `5fc0ef11f6cb44b5cdbb6daae08eb1bc9d35e5ee` reproduced the missing gate in the red phase.

## Implementation review and disposition

[PR #1263](https://github.com/KStratMD/Preston-Test/pull/1263) carries the final-head review, Copilot, CI and merge dispositions. This record preserves the earlier rounds and their evidence; it does not assert clearance of a later head. The shared-workflow correction landed separately in [PR #1262](https://github.com/KStratMD/Preston-Test/pull/1262).

Opus independently reviewed implementation head b4f96e727f2d5e6d349ff5183e66cafaa98a748a and returned **NEEDS CHANGES**. Its open-scope source and claims pass found no retry/reauthentication/redaction correctness defect, but required explicit policy tests/disclosures and Linux evidence on the final candidate. The initially named candidate moved during that review; the verdict identifies the actual reviewed head, pinned before and after the reviewer's full Windows run. Machine-local verdict: C:\tmp\gacp-wsc-opus-implementation-review.json.

The executor reproduced the findings against the tree before applying these resolutions in 9501dc7bc7cf972f9f824f4ebe00b67dfa668a18:

| Finding | Resolution |
| --- | --- |
| F1: unkeyed write replay after 401 | Preserve the plan's deliberate one-time reauthentication replay exception; document it and test POST/PATCH through both ordinary and sensitive transports. Transient-failure replay restrictions still apply. |
| F2: unclassified BaseConnector errors now terminal | Disclose this HTTP-layer behavior in C2 and on retry; generic RetryService non-HTTP behavior remains unchanged. Earlier legacy fixtures were corrected to represent HTTP/network failures, with an explicit unclassified-error terminal test. |
| F3: HTTP presets do not establish replay safety | Preserve the unsafe default, document the caller's explicit safe-replay opt-in and test both presets' unsafe/safe paths. |
| F4: two delay caps | Clarify that BaseConnector's 30-second constant caps backoff; its parsed Retry-After cap is 60 seconds. RetryService additionally honors its configured maximum. |
| F5: targeted suite omitted legacy core tests | Expand the plan's command to include tests/unit/core; the expanded run (a superset also covering SAP and resilience) passed 1,066 tests in 42 suites. |
| F6: gate directory scope | Document that the pattern gate scans top-level connector files only. |
| F7: redaction assertion could be vacuous | Add a positive control for the fixed authentication-failure message. |

F8 was informational: no production connector currently opts into keyed/explicitly idempotent writes; those branches have unit coverage. No broader replay permission was inferred. P2 requires a Linux gate sweep at the final candidate, whose exact SHA and output are recorded in the PR after the sweep; it is not satisfied by treating generated-artifact changes as implicitly tested.

Verification records (verified 2026-09-07):

- C:\tmp\gacp-wsc-expanded-targeted.log: 1,066 tests / 42 suites passed after the review fixes.
- C:\tmp\gacp-wsc-linux-ci-parity-r3.log: exact SHA 9501dc7bc7cf972f9f824f4ebe00b67dfa668a18, Ubuntu native worktree, Node v22.22.2; 15,378 tests and 722 suites passed, 10 existing tests and one suite skipped, one snapshot passed. Metrics generation, token sync and strict metrics verification passed; generated artifacts landed in 9450831097.
- The reviewer's separate Windows run at b4f96e727f passed 15,372 tests before the six added review regressions; its core run passed 2,565 tests and reproduced the improvement-only Salesforce budget update. These are earlier-head records, not final-candidate Linux evidence.

The full Linux profile initially exposed four obsolete plain-error retry fixtures in two legacy core suites. They were reproduced and corrected in 816c621ff2 and f3103c7cc9; the initial failed run is retained as C:\tmp\gacp-wsc-linux-ci-parity.log. No failed run or missing reviewer verdict is counted as clearance.

## Final clearance and merge

Claude Opus independently **CLEARED** candidate `34610dcad6553c07e354247cb4cdb59284cd8984` after checking the reproduced fixes, exact-candidate Linux sweep and changed status claims. Copilot's follow-up at that head generated zero new comments. Claude subsequently **ACCEPTED DEFERRAL** of the pre-existing direct-entry duplicate-auth-probe finding and confirmed its exact-tree clearance; the proposed shared guard was reproduced as a ShipStation probe-bypass regression. This is an accepted residual with the retained guard-ownership follow-up, not a code fix. [Independent clearance](https://github.com/KStratMD/Preston-Test/pull/1263#issuecomment-5576127673), [reproduction and disposition](https://github.com/KStratMD/Preston-Test/pull/1263#discussion_r3952989169).

Final PR head `664834c9c70f1e218cdd0060377182d3062444e2` is a tree-identical CI-trigger commit. [CI run 34167269162](https://github.com/KStratMD/Preston-Test/actions/runs/34167269162) passed the 15,378-test full profile and 2,565-test core profile, the coverage ratchet and both required checks. [PR #1263](https://github.com/KStratMD/Preston-Test/pull/1263) merged following owner approval at `2026-09-07T23:20:03Z` as `50718ee9ba74063ad71a6a302f1b0c425064db3b`; its tree matches the tested PR head. Counts, skips, advisory bootstrap failure and provenance are in the [final closeout](https://github.com/KStratMD/Preston-Test/pull/1263#issuecomment-5576466866) (verified 2026-09-07 from GitHub state, logs and Git tree IDs). No separate merge-SHA CI result is claimed.