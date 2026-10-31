# Maintenance Task 3: secret SDK compatibility

Executor Codex | provider OpenAI | host MSI | absolute worktree
`C:\tmp\preston-maintenance-secret-sdks` | branch `codex/maintenance-secret-sdks`
| base `7d23327343c178791bd27acc9bdf496d1e8a1eb2` | Linux gate locator
MSI / Ubuntu /home/kstratmd/tmp/maintenance-secret-sdks | tested source SHA
`a8dab7974f5c29c75c465f8fda9f3dc2e8d1f55e`, Node v22.22.2 |
reviewer owner-selected Claude Opus, requested High,
effective effort unreported. No unattended executor is claimed.

Scope is the Azure #1222 and AWS #1221 row of
[maintenance Task 3](../superpowers/plans/2026-09-10-maintenance-and-documentation-plan.md#task-3-disposition-the-remaining-ten-dependency-prs).
Both originals remain open, targeting main, verified 2026-09-12 with GitHub PR
queries. The intended replacement targets Working-Branch; main promotion and
original-PR supersession require separate concrete approval.

This is a dated implementation and review record. Claude cleared the final script
revision `7ed5f04050`; the round records and coverage limits are below. Read
[PR #1291](https://github.com/KStratMD/Preston-Test/pull/1291) for subsequent review
events, the final CI head/results and owner decision. The two optional dependency floors
and their resolved lockfile closure are accompanied by an advisory SDK contract
check and documentation corrections; application source is unchanged. Baseline setup
and bounded characterization preceded package mutation. Do not claim the
existing private-provider-method mocks exercise SDK imports or default chains.
Use synthetic credentials and stubbed provider/network boundaries; no live secret
read/write/rotation, credential logging or application-wide SDK redesign.

Implementation contract: [bounded SDK plan](../superpowers/plans/2026-09-12-secret-sdk-compatibility.md).
Windows baseline Node v22.23.1 / npm 10.9.8: isolated npm ci, build, lint,
typecheck and selected profile (85 tests/three suites) passed. Both lockfile audits
report zero advisories. CommonJS and native ESM SDK entry-point checks passed.
Logs: `C:\tmp\secret-sdk-baseline-*.log` and audit JSON files. These are baseline
results, not candidate/hosted CI or Linux verification.

## Independent plan review and reproduced corrections

Claude Opus (`claude-opus-5`, requested High, effective effort unknown) returned
NOT CLEAR at documentation head `fdec7f12100a8fc76f8c8da65e5a66ff4e3ef8e1`.
Artifact: `C:\tmp\secret-sdk-plan-opus.json`; session
`edb816be-4bdb-4a26-be2f-d23cde6f8e3f`. Its independent source-selection pass found
no refuted CSV closeout/status claim. The following corrections require re-review:

| Finding | Executor reproduction and correction |
| --- | --- |
| F1: dependency type and target drift | Both SDKs are optional in the actual manifest. A scratch copy using save-prod moved them to mandatory dependencies and selected AWS 3.1131.0 despite an explicit 3.1127.0 request. Save-optional preserves placement and selects exactly 4.13.2/3.1127.0. Plan command and mandatory manifest/version assertions corrected; no product manifest was changed. |
| F2: AWS send stub bypasses changes | Moved the stub to NodeHttpHandler.handle. The baseline now exercises real credential selection, regional endpoint, middleware/signature-header generation, serialized request body and real success/error deserialization. Actual handler/socket/TLS behavior, other credential sources and server acceptance remain untested; stubbing handle cannot validate that method's implementation. |
| F3: process-option claim | Inspected core-process 1.0.0. The original dated scratch probe records full API options and asserts shell is undefined and allowWindowsBatchFiles is true; its expected adapter is a required argument. These historical assertions do not describe the later committed advisory check. Plan separates this wiring evidence from shell:false source evidence below the stub. |
| F4: typecheck limit | Confirmed ambient SDK declarations and handwritten import interfaces. Plan explicitly treats typecheck as a repository gate, not SDK declaration/contract validation. |
| F5: process artifact | Independently packed/extracted core-process 1.0.0 under the upstream scratch directory and read the process-options rejection/Node invocation code. Its release heading is still Unreleased in the identity tag's changelog; the npm artifact identifies the published version. |
| F6: network guards | Added TLS, HTTP2 and DNS callback/promise guards. The tested paths still record zero real network/process calls. |
| F7: bookkeeping | Recorded completed baseline lint/types/audits and first documentation commit. Baseline has zero advisories; no advisory-remediation claim is made. |
| F8: duplicate module hook | Consolidated interception into one hook before SDK loading; the compiled baseline probe still passes. |

Revised probe: `C:\tmp\secret-sdk-probe.cjs`, SHA-256
`ce930e3f0070bca61f8f80681f2af2db5e256e07c03d96e21e58bbc249ddaddd`.
`node C:/tmp/secret-sdk-probe.cjs exec` passes on the baseline. Five scratch
mutants fail at their intended assertions (AWS response value, credential
constructor, logger value, I/O counter, region); logs are
`C:\tmp\secret-sdk-baseline-mutations-v2.log` and `secret-sdk-probe-v2-mut-*.cjs.log`.
Missing optional SDK imports are also simulated through the real service import
boundary to check strict failure and ordinary environment fallback.

During review, the executor independently identified the upstream passive-refresh
rejection fix and reproduced it through the actual defaultProvider with an
expiring, stubbed credential leaf. Driver `C:\tmp\secret-sdk-passive-refresh.cjs`,
SHA-256 `8e3dbdbbf45a1eabfc6cdc327957fcb05d8709fdc43a3d7a803849720becc032`.
Baseline provider 3.972.81 emits one synthetic unhandled rejection; retry recovers
sequence 2, real-I/O count is zero, and the desired-behavior assertion exits 1.
This is the expected baseline reproduction, not a new app-test failure. Candidate
and Linux runs must pass with zero unhandled rejections. Evidence:
`C:\tmp\secret-sdk-baseline-refresh.log` and the fix linked in the plan.

The review's check-runs query sees 14 successes and one skipped publish job on the
CSV head; the separately reported successful blueprint-verify commit status makes
15 successful applicable checks overall. Its comment that the documentation head
was unpushed is superseded by the verified push to codex/maintenance-secret-sdks.
The closing pass is still on that feature branch, not yet integrated into the live
Working-Branch handoff stream. No review of the new candidate closure is claimed.

## Plan clearance and candidate setup

Claude's follow-up cleared head `69a4f7945bd6cb08e6f12d43bb60aed9dde8be59` to
proceed: all F1–F8 fixed, and the passive-refresh criterion valid. Artifact
`C:\tmp\secret-sdk-plan-opus-r2.json`, same reviewer/session/model and requested
effort as above. It independently ran the baseline, five mutations, I/O guards,
adapter-negative checks and the passive-refresh driver in both the baseline and
its own candidate sandbox. Sandbox results are not this candidate's verification.

Non-blocking follow-up disposition: strengthened the counter mutant to invoke the
guarded spawn API and require its named failure; the runner now requires the
adapter argument for baseline/candidate use. Added the resolved-provider version
check and clarified the Azure getToken call is made separately by the probe,
not by the stubbed vault read. The passive-refresh driver retains its reviewed
bounded event-loop drains and module-denial guard for this dated version-specific
observation; a future provider scheduling/loading refactor can require adapting
it. It is not promoted to a permanent gate. The asserted recovery value is 2;
the current log prints that constant after the assertion, not an independent
measurement. Module-load denial shares its guard counter with forbidden I/O;
zero was observed, so neither happened in the baseline. These limitations do not
weaken the required candidate zero-unhandled-rejection assertion.

The executor reproduced the separate save-optional scratch install with
`npm ci --omit=optional --ignore-scripts --no-audit --no-fund`: all three SDK entry
packages were absent after 1,039 packages installed. The explicit ignore-scripts
flag disables lifecycle scripts only in that isolated scratch copy. The candidate
uses normal hooks-enabled installation. Reproduction log:
`C:\tmp\secret-sdk-omit-optional-rerun.log`. Earlier logs:
`C:\tmp\secret-sdk-omit-optional-preview.log` and `secret-sdk-candidate-*.log`.
The exact-lock guard passed after applying the reviewed command: target versions
4.13.2/3.1127.0, unchanged Key Vault 4.11.2, all three optional flags true, and
credential-provider-node 3.972.83. All manifest fields except the two optional
floors are unchanged. Security/tooling/PapaParse nodes are preserved.

The candidate matches the inspected scratch lockfile: 18 non-root entries (17
changed plus new core-process), with no removals; the root mirror is a separate
19th changed entry. This corrects the review report's ambiguous 19-package count.
Npm adds exact SDK entries to the root lockfile dependency map while retaining
the optional map/flags; the actual manifest remains optional and the omit-optional
install above empirically confirms omission. No mandatory manifest dependency
was added. Hosted CI remains pending; Windows and Linux results follow.

## Windows candidate verification

Own npm ci installed 1,100 packages on Node v22.23.1 / npm 10.9.8. Build, lint,
typecheck, 85 selected tests/three suites, core 2,696 tests/114 suites and all
87 floors passed. Both audits report zero advisories; any/strict-null/core type
budgets, handoff/notes/inbound links, metrics verification and diff whitespace
checks passed. No TypeScript LOC, application source or permanent test changed;
metrics were not regenerated. The older broad-coverage totals are not represented
as a new run here.

The same pinned main probe passed with the required execFile adapter. The same
passive-refresh driver passed against resolved credential-provider-node 3.972.83:
zero unhandled rejections, asserted recovery sequence 2, zero forbidden calls.
The distributed provider's passive-lock chain contains the catch before its final
lock release. Five candidate mutants were killed at their expected assertions;
the counter mutant now invokes the actual guarded spawn API. Native ESM entry
points passed for Identity/Key Vault and the AWS client/all five used commands;
the compiled-service probe exercises CommonJS loading. Logs are
`C:\tmp\secret-sdk-candidate-{probe,refresh,mutations,esm,tests,core,core-budget}.log`.

The exact-lock guard `C:\tmp\secret-sdk-lock-guard.cjs` confirmed that all 18
changed/new non-root entries are reachable from the two SDK roots and match the
preview. It also checked the unchanged manifest fields, preserved dependency
nodes, optional flags and exact resolved versions; output is in
`C:\tmp\secret-sdk-candidate-lock-guard.log`.

## Transitive change review

Maintainer changelogs were read at AWS commit
`33f2cc70baa1614578a0bf8bf5f7529a1ae43e96` (v3.1131.0) and Smithy commit
`596456b8cbdad74494a83f57e937b2491434b80b`, selecting only each resolved version
range. Saved sources: `C:\tmp\secret-notes-*.md`; exact node/field crosswalk:
`C:\tmp\secret-sdk-preview-lock-diff.json` (candidate matches it).

- [AWS core](https://github.com/aws/aws-sdk-js-v3/blob/33f2cc70baa1614578a0bf8bf5f7529a1ae43e96/packages-internal/core/CHANGELOG.md)
  3.977.9 to 3.978.0 adds a dynamic-client facility. The app uses the generated
  Secrets Manager client; the runtime probe exercises its middleware path.
- [Credential-provider-node](https://github.com/aws/aws-sdk-js-v3/blob/33f2cc70baa1614578a0bf8bf5f7529a1ae43e96/packages-internal/credential-provider-node/CHANGELOG.md)
  3.972.81 to 3.972.83 includes the reproduced passive-refresh fix and dependency
  refresh. The other seven changed credential-provider nodes and nested-clients
  record dependency updates; token-providers 3.1116.0 to 3.1129.0 records version
  bumps for each crossed release. Other credential-source modes are not live-tested.
- [Smithy core](https://github.com/smithy-lang/smithy-typescript/blob/596456b8cbdad74494a83f57e937b2491434b80b/packages/core/CHANGELOG.md)
  3.33.3 to 3.34.1 changes runtime error classification, terminal abort handling
  and chunked-stream handling. The fixture verifies the ordinary JSON request and
  provider-denial path, not every new error/stream feature.
- [Node HTTP handler](https://github.com/smithy-lang/smithy-typescript/blob/596456b8cbdad74494a83f57e937b2491434b80b/packages/node-http-handler/CHANGELOG.md)
  4.11.3 to 4.12.1 changes HTTP/2 session cleanup; the app's selected default
  handler path in the probe is HTTP/1. [Fetch handler](https://github.com/smithy-lang/smithy-typescript/blob/596456b8cbdad74494a83f57e937b2491434b80b/packages/fetch-http-handler/CHANGELOG.md)
  5.7.2 to 5.8.0 and types 4.17.2 to 4.18.0 add a custom-fetch option. The Node
  app does not select that browser/fetch handler in the tested path.
- Azure Identity 4.13.1 to 4.13.2 adds core-process 1.0.0 and raises the MSAL
  minimum, already satisfied by the preserved 5.1.5 node. Source and selected
  adapter evidence are described above; no current-advisory remediation is claimed.

These are scoped source-review observations plus the named runtime evidence,
not vendor acceptance or complete coverage of every SDK path.

## Linux verification and independent implementation clearance

Exact source SHA `a8dab7974f5c29c75c465f8fda9f3dc2e8d1f55e` was transferred
through Git to the Linux locator above. Node v22.22.2 was printed and checked
before npm 10.9.7 installed its own 1,101 packages. Build/lint/typecheck, both
unchanged-hash runtime probes, native ESM entry points, 85 selected tests/three
suites, core 2,696/114 and all 87 floors passed. Both audits returned zero
advisories; type budgets, handoff/notes/inbound links and metrics verification
passed. Driver `C:\tmp\secret-sdk-linux.sh` uses set -euo pipefail, verifies the
exact SHA and both probe digests, and asserts tracked-tree cleanliness before
printing LINUX_SDK_GATES_PASS in `C:\tmp\secret-sdk-linux.log`. No tracked file
changed. The five-mutation battery ran on Windows, not Linux.

An initial setup attempt stopped at cd before the Git worktree creation finished;
its log is preserved as `C:\tmp\secret-sdk-linux-setup-attempt.log`. The completed
run above started after that creation and is the only Linux pass claimed.

Claude Opus independently cleared this source SHA in
`C:\tmp\secret-sdk-implementation-opus.json` (same session, actual claude-opus-5,
requested High, effective effort unknown). It independently compared every
manifest/lock field, proved optional omission from the lock graph, reran the lock
guard, candidate probes/negative adapter/mutations/entry points, selected 85-test
profile, audits, lint/types and budget/documentation/metrics gates. It verified
the completed Linux log, driver, digests and clean-tree assertion; it did not
claim a second execution of the Linux or Windows core profile. Its extra synthetic
key-change probe showed the generated SigV4 signature changes with the key, while
server-side acceptance remains untested.

The review returned no blocking findings and cleared proceeding after three
mechanical documentation follow-ups: completed plan checkboxes, Linux provenance,
and replacement of pending Linux wording. Those are applied here; no source,
lockfile, or probe bytes changed after clearance. Copilot and hosted CI still
require their own final-head evidence. Merge and #1222/#1221 supersession remain
separate owner approvals.

## Copilot round 1 corrections

[Review 5187784464](https://github.com/KStratMD/Preston-Test/pull/1291#pullrequestreview-5187784464)
reviewed `bcef30d552` with one inline finding and two suppressed documentation
findings. All three reproduced. Claude independently reviewed their disposition
in `C:\tmp\secret-sdk-copilot-plan-opus.json` (actual claude-opus-5, requested High).

- **Contract coverage:** existing Jest mocks do not exercise real SDK imports.
  The committed `scripts/check-secret-sdk-contract.cjs` now makes the selected
  runtime paths reproducible with `npm run build && npm run check:secret-sdk-contract`.
  It runs in its own process, skips absent optional SDKs, names a missing build,
  and guards network/process calls. It reports the CLI mechanism/options and rejects shell:true
  at the core-process stub boundary without pinning the current adapter. Stub
  targets still depend on vendor internals; blocked unexpected I/O identifies
  possible harness drift. This is an advisory command, not a blocking CI step.
  It is excluded from the reviewer mirror because that snapshot has no compile
  step or dist tree. The passive-refresh timing experiment remains scratch-only.
- **Handoff date:** the September 12 handoff carries current state and the AGENTS
  pointer. The September 7 record retains the pre-batch historical contents and
  a supersession link; the promotion record now says then-canonical. No historical
  evidence link is removed. Structural gates pass with the new pointer.
- **Omission evidence:** the exact ignore-scripts command above was rerun in
  isolated scratch, installing 1,039 packages with all three entry packages
  absent. Candidate Windows and Linux installations kept normal hooks enabled.

The committed advisory check passes on Windows, and all five targeted mutants
fail at their intended assertions (runner `C:\tmp\secret-sdk-committed-mutations.cjs`).
These five mutants exercise the revised committed source; the source-root binding
is preserved explicitly when the mutated copies run from scratch. Linux parity
and revised independent review are recorded below.

Claude cleared the revised approach at `c008e09587296c10066f296996fed23e5af18e05`
in `C:\tmp\secret-sdk-copilot-fix-opus.json`, with minor follow-ups bundled here.
The transitive HTTP-handler import now reports a harness-drift error on resolution
failure instead of a raw loader stack. The committed-script mutation runner now
uses distinct `secret-sdk-committed-mut-*` scratch names. Earlier
`secret-sdk-probe-v2-mut-*` files were overwritten by a later run and must not be
treated as preserved original per-mutant evidence; the separate dated baseline
and candidate battery summary logs remain the original run records.

The advisory script is outside `npm run lint` (which scans src); direct
`npx eslint scripts/check-secret-sdk-contract.cjs` passed on both operating systems.
It has no standing CI execution or lint guarantee. The package-lock is unchanged
from `a8dab7974f`; the focused Linux run at `c008e09587` therefore reused that
installation and did not repeat npm ci or Jest profiles. Driver
`C:\tmp\secret-sdk-linux-copilot.sh` and log `C:\tmp\secret-sdk-linux-copilot.log`
show Node v22.22.2, build/types/lint, advisory/direct lint, docs/metrics and the
clean-tree assertion followed by LINUX_COPILOT_FIX_PASS. Claude verified that log.
Until this PR merges, the live resolver correctly continues to name September 7
from origin/Working-Branch; the new pointer is currently on the feature branch.

Final follow-up source `8bad0b995c8c718d98faa02c81b41d0c1d30bf02` passed the
positive and five distinct-name mutation checks on Windows, direct script lint,
and a missing-handler mutation that exited 1 with the expected harness-drift
diagnostic. The exact-SHA Linux rerun is recorded in
`C:\tmp\secret-sdk-linux-copilot-final.sh` and its `.log` sibling: Node v22.22.2,
the same focused gate list, clean tracked tree and LINUX_COPILOT_FIX_PASS.
This satisfies Claude's requested follow-up verification before dedicated Copilot
re-review. No dependency or application-source bytes changed during this round.

## Later Copilot review dispositions

Round 2's two mirror-failure claims did not reproduce: both handoff and mirror
commands pass. The changed AGENTS pointer is above Part 1; the mirror guard
compares only the Part 1 slice. The scope whitelist and original scratch-probe
labels were clarified in `817f29f6cf`. The advisory command intentionally does
not pin the original scratch probe's vendor-option assertions.

Round 3 returned zero new inline comments but identified the stale round label
above, now corrected, and a valid coverage limitation: this is a joint AWS/Azure
contract check. If any of its three optional packages is absent, it skips the
whole check; it does not independently validate a partially installed provider.
The verified installations had all three SDKs and exercised both providers.
Per-provider partial-install coverage is a follow-up for a broader harness design,
not claimed by this batch's advisory command. This preserves Claude's reviewed
optional-install behavior without turning an absent optional package into failure.

The review summary also mentioned Node 20 deployment compatibility without a
file/line finding. Node 20 is outside this repository's declared engine range
(`^22.13.0 || >=24`, engine-strict=true); both tracked Dockerfiles and required
CI use Node 22. Azure's new Node 22 minimum is therefore compatible with the
declared runtime. This source/config check is not a fresh live-deployment probe;
main promotion and deployment remain separate.

Copilot round 4 returned zero new inline comments and one suppressed finding:
the log fixture list omitted the synthetic AWS access-key identifier. Injecting
that value into the captured application logger passed before the fix. Adding
it to the forbidden fixture list makes the same mutation fail; this strengthens
the advisory check and does not change application behavior.

Copilot round 5 returned zero new inline comments and three suppressed findings.
The guard description now names network/process calls; filesystem access is not
blocked. A wrong Azure CLI verb previously passed because only the vault resource
was checked. The execFile path now asserts the leading six arguments for
`account get-access-token --output json --resource https://vault.azure.net`.
The wrong-verb mutation fails after this change while the normal check passes.

Final script verification at `7ed5f040508f4a05521a86fd840c2f0db49ff525` passed
Windows normal/five-mutant checks, separate access-key and wrong-verb regression
controls, and the focused exact-SHA Linux run. Driver/log:
`C:\tmp\secret-sdk-linux-cli-args.sh` / `C:\tmp\secret-sdk-linux-cli-args.log`,
Node v22.22.2, LINUX_COPILOT_FIX_PASS after build/types/lint/advisory/direct-script
lint/docs/metrics and tracked-tree cleanliness. Claude independently reproduced
the last delta and cleared it with no findings in
`C:\tmp\secret-sdk-cli-args-opus.json` (actual claude-opus-5, requested High,
effective effort unreported). Later changes are documentation only.

- [Round 6](https://github.com/KStratMD/Preston-Test/pull/1291#pullrequestreview-5188046868)
  returned zero new inline comments and one suppressed handoff-status finding.
  `9cb43b69cb` updated the handoff with the completed final-script verification
  and a live PR-status link, distinguishing it from the original SDK-source run.
- [Round 7](https://github.com/KStratMD/Preston-Test/pull/1291#pullrequestreview-5188068067)
  alleged a child_process.promises bypass. That API is undefined on Windows
  v22.23.1 and Linux v22.22.2; both alleged calls throw TypeError before launching
  a process. The real util.promisify(execFile) path was exercised inside the
  guarded harness and rejected through the guard with forbiddenCalls=1
  (`C:\tmp\secret-sdk-promisify-control.cjs` / `.log`). The
  [inline reply](https://github.com/KStratMD/Preston-Test/pull/1291#discussion_r3997574258)
  carries the reproduction and Node documentation. The summary's repeated
  optional-lock concern did not produce a new reproduction: the guard updated
  solely for the reviewed advisory npm script again matched the independent
  preview, optional flags and all 18 reachable changed nodes
  (`C:\tmp\secret-sdk-current-lock-guard.cjs`). The old pre-advisory manifest
  guard rejects the added npm command; that is not dependency drift.
- [Round 8](https://github.com/KStratMD/Preston-Test/pull/1291#pullrequestreview-5188094252)
  returned zero new inline comments, requested a final human review, and identified
  two documentation nits: a phase label and missing later-round records. This
  update replaces the phase label with dated evidence plus a live PR link and
  records rounds 6–8 here. Subsequent review/CI events belong to the linked PR;
  this historical record does not assert that those future gates have completed.

## Merge closeout (2026-09-12, UTC)

The owner explicitly approved merging #1291 and closing #1222/#1221 as
superseded, then continuing maintenance. [PR #1291](https://github.com/KStratMD/Preston-Test/pull/1291)
merged at `2026-09-12T22:14:19Z` as
`966c77cacf797883cb7f5a127a927f9a684b7896`. Both original PRs are closed with
supersession comments. Git tree comparison confirmed merge, final CI head
`796259c6011d8ecc389c56fa9843adaad473d073`, and reviewed documentation parent
`26bc006dd96d8a72daaf35f38b8340f0d157d01a` share tree
`cf85d45971ed346d5fbad11f7a18cd4380c4a6ec`.

The [final handoff](https://github.com/KStratMD/Preston-Test/pull/1291#issuecomment-5649003403)
records all 14 successful checks, including the three required checks. Hosted
[CI run 34720649555](https://github.com/KStratMD/Preston-Test/actions/runs/34720649555)
passed 15,594 tests / 731 suites (10 tests and one suite skipped, one snapshot),
2,696 core tests / 114 suites with all 87 floors, 932 integration tests / 89
suites (16 tests and four suites skipped), and 57 PostgreSQL tests / 11 suites.
The broad test report recorded zero failed tests and suites. Profiles overlap;
these counts are not additive. They are PR-head results, not a separate
merge-SHA or deployment run.

Claude Opus independently cleared the final implementation. Copilot's last
round returned zero new inline comments but repeated its lock-root optional-SDK
metadata concern. The npm-generated metadata, retained optional declarations
and flags, and empirical omit-optional installation supported the documented
pushback. The owner approved with this disagreement explicitly disclosed;
this is not an assertion of unconditional Copilot clearance or a separate
human code review.

The completed SDK assignment is removed from the canonical handoff. Four
original dependency PRs and documentation Tasks 4–7 remain, verified using
GitHub's open-PR inventory after these closures. Main promotion and deployment
were not performed by this merge.
