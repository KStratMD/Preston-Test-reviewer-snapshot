# SQLite transfer precision repair evidence

## Initial assignment (2026-09-12 America/Denver)

Executor Codex | provider OpenAI | host MSI | absolute worktree
`C:\tmp\preston-maintenance-sqlite-precision` | branch
`codex/maintenance-sqlite-precision` | base
`743499fc79c1a22074a90f138785dc2117ca983c` | Linux gate locator unknown |
tested SHA unknown | live process/log evidence: no unattended executor claimed |
reviewer owner-selected Claude Opus, requested High, effective effort unreported.

The handoff resolver returned verified authority from origin/Working-Branch at
the base above. Its transfer source/tests tree is identical to the plan-review
input `1dc36a084b87c94bd91d5b99be944a03adea0a2a`. The
[adopted plan](../superpowers/plans/2026-09-12-sqlite-transfer-precision-repair.md)
records Claude Opus 5's independent design clearance and the two-file scope.
This is an implementation assignment, not a completed repair or merge approval.

The original finding is retained in the [PostgreSQL evidence](2026-09-12-maintenance-postgres.md#retained-finding-sqlite-source-integer-precision).
Old rounded bundles cannot recover lost integer precision from their digests;
re-export from an intact original source is required. REAL/decimal precision,
production databases and main promotion are outside this repair.

## Implementation and regression evidence

Source/test commit `6cf35c2a9fca2747a064c4af52d976e3b4277745` changes only
the two planned production files and four existing test files. Statement-local
exact integer reads retain unsafe integers as bigint; safely representable
integers stay numbers for existing scalar/boolean adapters. Integer canonicalization
refuses unsafe integer-valued Numbers. No dependencies, schema or bundle format changed.

Windows Node v22.23.1: the focused red run failed five regressions and passed six
tests (`C:/tmp/sqlite-precision-red.log`): four unsafe-Number acceptance cases
and one source-reader precision case. After the fix, all 53 transfer unit tests /
18 suites passed (`C:/tmp/sqlite-precision-green.log`). The earlier directory run
overlapped test authoring and is not used as a clean baseline claim.

The full PostgreSQL profile passed 60 tests / 12 suites on the owned loopback
PostgreSQL 15.19 server (`C:/tmp/sqlite-precision-postgres.log`). Exact source
bindings and independent decimal-string oracles cover both signs beyond the safe
range, signed-int64 extrema and the positive safe endpoint. Assertions match
authenticated frames and destination rows by tenant key, then reconcile the full
manifest including metadata. Removing only statement-local exact reads made the
round-trip test fail with preflight `INVALID_INTEGER`; the source bytes were
restored and all 60 PostgreSQL tests passed again (`C:/tmp/sqlite-precision-mutation.log`,
`C:/tmp/sqlite-precision-postgres-restored.log`). No mutation was committed.

Build/types/lint passed. Core passed 2,696 tests / 114 suites; all 87 floors and
type budgets matched. Status/proof-card/skipped-test, handoff/mirror, links and
terminology checks passed; package-lock audit found zero vulnerabilities. The
initial sweep used a nonexistent audit filename; the actual package command
`npm run audit-skipped-tests` and remaining gates were then run successfully.
That command error was an executor harness error, not a repository defect.

## Exact-SHA Linux verification and generated metrics

Linux gate locator MSI / Ubuntu `/home/kstratmd/tmp/maintenance-sqlite-precision`
| tested source SHA `6cf35c2a9fca2747a064c4af52d976e3b4277745` | Node v22.22.2 |
npm 10.9.7 | command `bash /mnt/c/tmp/sqlite-precision-linux-verify.sh` (CRLF
normalized at invocation). The commit was transferred through Git from the
Windows root clone, checked out detached and independently installed with npm ci.
Build/types/lint, 53 transfer units / 18 suites, 60 PostgreSQL tests / 12 suites,
2,696 core tests / 114 suites, all 87 floors and type budgets passed.
The same mistaken audit filename stopped the initial sweep; corrected remaining
gates passed via `sqlite-precision-linux-remaining.sh`. Logs:
`C:/tmp/sqlite-precision-linux.log`, `C:/tmp/sqlite-precision-linux-remaining.log`.
Profiles overlap and are not additive. These local results do not claim hosted CI.

Both platforms then correctly rejected stale deterministic metrics. Linux
generation at the source SHA measured production LOC 219,101 → 219,115 and total
LOC 427,015 → 427,104. The generated LOC block/stamps and two documents' metric
tokens were refreshed. Historical metrics tests/coverage blocks retain their
earlier snapshot; current test counts are the measured results above. Generation
input SHA is provenance, not the later containing commit or deployed build ID.
The metrics correction received the focused follow-up recorded below.

Independent implementation review, Copilot, hosted CI and owner merge decision
remain separate gates. Their completed evidence is appended when available.

## Independent implementation review and dispositions

Claude Opus 5 cleared the production code at `6cf35c2a9f`, independently rerunning
53 transfer tests / 18 suites and typecheck, and empirically checking Jest's
bigint/number discrimination. Requested High, effective effort unreported;
same design-review session, `C:/tmp/sqlite-precision-implementation-opus.json`.
The reviewer withheld lane closure for the following evidence issues:

1. The initial gate-script typo was reproduced and corrected as recorded above.
   Corrected remaining gates ran on both hosts. Unchanged Linux shell harnesses,
   route-policy and OpenAPI gates were not claimed in the focused local sweep;
   hosted CI remains a separate, pending gate.
2. During review, the reviewer saw metrics files before their commit. Generation
   was actually performed in Linux at `6cf35c2a9f`, with output
   the generated fields committed at `064440ac4b` and log
   `C:/tmp/sqlite-precision-metrics-generation.log`; only the resulting fields were
   copied on Windows. The claim that Linux never generated them is refuted by
   these artifacts. Commit `064440ac4b1193d0bfa538e9d6bc7a626f922e5a` contains the
   metrics/evidence follow-up; exact-SHA Linux verification passed metrics/tokens,
   handoff/mirror and links with a clean tracked tree. Command:
   `bash /mnt/c/tmp/sqlite-precision-linux-docs.sh 064440ac4b1193d0bfa538e9d6bc7a626f922e5a`;
   log `C:/tmp/sqlite-precision-linux-docs.log`, Node v22.22.2, exit 0.
3. The first mutant failed before the frame assertion. An additional scratch
   mutant removed both production fixes and omitted only the int64-extrema rows
   from the fixture, allowing rounded values within PostgreSQL BIGINT range to
   import. The actual authenticated-frame assertion then failed: expected
   `9007199254740993`, received `9007199254740992`. Log:
   `C:/tmp/sqlite-precision-oracle-mutant.log`. Original bytes were restored and
   `git diff --exit-code` was clean; the restored round-trip test passed
   (`C:/tmp/sqlite-precision-oracle-restored.log`). This directly demonstrates
   the literal oracle's ability to reject a silently rounded transfer.
4. Assignment-only status artifacts had advanced during the review and were
   committed at `064440ac4b`. This follow-up records the additional mutation and
   completed review dispositions. Pending review/CI/merge gates stay pending.
5. Duplicate unsafe-Number inputs document the rounded input representation;
   reviewer requested no change, and no extra tests were added.

No production change was required by review. Claude Opus 5 independently confirmed
all dispositions and closed local implementation review at
`edb7bdb5d277194a61816120f4c5596acf275eaa`, with no open findings
(`C:/tmp/sqlite-precision-final-opus.json`). It verified the Linux-generation
artifacts, withdrew the contrary inference, and reran current metrics, handoff,
links and terminology gates. Requested High, effective effort unreported.
The owned disposable PostgreSQL server was stopped after verification
(`C:/tmp/sqlite-precision-server-stop.log`).

**Historical pre-merge status:** following local implementation review, the
[repair PR #1293](https://github.com/KStratMD/Preston-Test/pull/1293) still awaited
Copilot, hosted CI and the owner decision, and the finding remained open.
The [merge closeout below](#merge-closeout-2026-09-13-utc) supersedes that status.

## Copilot metrics follow-up and retained build-identity defect

Copilot reviews [5188858117](https://github.com/KStratMD/Preston-Test/pull/1293#pullrequestreview-5188858117)
and [5188869266](https://github.com/KStratMD/Preston-Test/pull/1293#pullrequestreview-5188869266)
reported zero inline comments but retained suppressed metrics findings. Both
covered 15/15 files at Lite effort. The runtime consequence is accepted:
`src/routes/metrics.ts:227-229` labels the generation-input SHA as `build_sha`
when BUILD_SHA is absent. This is a **known stale build-identity defect**, not
merely a harmless provenance distinction. A truthful generation-input SHA does
not prove current runtime identity, and refreshing it cannot identify subsequent
commits. The earlier evidence-based pushback addresses only the impossible
self-referential containing-commit stamp; it does not dismiss this runtime defect.

Following the second review, metrics were regenerated in Linux Node v22.22.2 at
the latest reviewed head `4927004211a58005e441fff2beffcb146346f038`. LOC and
tokens were unchanged; generation timestamp and input SHA were refreshed.
Log: `C:/tmp/sqlite-precision-metrics-final-generation.log`; output:
`C:/tmp/sqlite-precision-metrics-final-generated.json`. Historical metrics
tests/coverage blocks remain unchanged. The refreshed artifact still makes no
claim to identify the later containing commit, final CI commit or deployment.

The build-identity defect is retained explicitly in the canonical handoff and
maintenance Task 4 for a separately reviewed runtime-identity correction and
no-BUILD_SHA regression. It predates this precision repair and is not fixed by
this stamp refresh (verified 2026-09-12 America/Denver against the route fallback,
generator implementation and exact Git comparison). Review and CI disposition
subsequently completed in the linked repair PR, as recorded in the merge closeout below.

## Merge closeout (2026-09-13 UTC)

Owner-approved [PR #1293](https://github.com/KStratMD/Preston-Test/pull/1293)
merged at `2026-09-13T01:58:02Z` as `feccdd67f485deedd24d6310d5301f8f973631d5`.
Its tree `4dc654e5056e603972f23a1ced6b55dfa888506e` exactly matches final CI
head `fda50042438e162f0649c7ca4d31ddc9594d2d0f` and Copilot-reviewed parent
`e1baaedf06cebda0f7cddd87517173185cffc90b`. GitHub merge state and local Git
tree comparison verified this on 2026-09-12 America/Denver (UTC timestamps above).

Final [CI run 34730240874](https://github.com/KStratMD/Preston-Test/actions/runs/34730240874)
and companion workflows passed 15 checks, including all three required checks;
public-mirror publication was conditionally skipped. The broad profile passed
15,601 tests / 731 suites, with 10 tests and one suite skipped. The actual report
guard recorded zero failed tests and zero failed suites. Core passed 2,696 / 114
with all 87 floors matched; full integration passed 932 / 89, with 16 tests and
four suites skipped; PostgreSQL passed 60 / 12, no skips. Strict metrics freshness
passed. Profiles overlap; these are PR-head results, not separate merge-SHA or
deployment checks.

Claude Opus 5 independently cleared design, code and evidence; its clearance
carried through `8480451482` after independently reproducing and accepting the
retained build-identity defect. Copilot
[review 5188882487](https://github.com/KStratMD/Preston-Test/pull/1293#pullrequestreview-5188882487)
then identified the UTC/local verification-date mismatch and ambiguous pending-gate
wording; both were corrected at `e1baaedf06`. Final Copilot
[review 5188892064](https://github.com/KStratMD/Preston-Test/pull/1293#pullrequestreview-5188892064)
on the reviewed parent generated zero new inline comments and no suppressed
findings, covering 15/15 files at Lite effort. It retained a generic request for
final human review. The owner then approved the disclosed candidate; no separate
human code-review result is claimed. The [final executor handoff](https://github.com/KStratMD/Preston-Test/pull/1293#issuecomment-5650032662)
preserves exact-SHA Linux evidence and verification limits. The owned test server
was stopped after verification.

The retained source-precision finding is closed for future SQLite signed-64-bit
transfers through authenticated export and PostgreSQL import/reconciliation.
Previously rounded bundles still require
re-export from an intact original source; REAL/decimal precision is outside the
repair. The no-BUILD_SHA runtime identity defect remains open under maintenance
Task 4. The three original dependency PRs (#1224, #1144, #1139), documentation
Tasks 4–7 and main promotion remain separate (verified 2026-09-12 America/Denver
using GitHub open-PR inventory and the merged repair scope).
