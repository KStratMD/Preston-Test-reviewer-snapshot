# PostgreSQL dependency maintenance evidence

Implements the pg row of [maintenance Task 3](../superpowers/plans/2026-09-10-maintenance-and-documentation-plan.md#task-3-disposition-the-remaining-ten-dependency-prs) using the [bounded compatibility plan](../superpowers/plans/2026-09-12-postgres-compatibility.md).

## Initial assignment snapshot (2026-09-12, before verification)

The unknown values below describe lane creation. Completed verification provenance
is in [the final local record](#independent-implementation-review-and-metrics-follow-up);
live review/CI state belongs to [PR #1292](https://github.com/KStratMD/Preston-Test/pull/1292).

Codex | provider OpenAI | host MSI | absolute Windows worktree `C:\tmp\preston-maintenance-pg` | branch `codex/maintenance-pg` | base `966c77cacf797883cb7f5a127a927f9a684b7896` | Linux gate locator unknown | tested candidate SHA unknown | reviewer owner-selected Claude Opus, requested High, effective effort unknown. No unattended executor is claimed.

The owner approved the SDK merge/supersession and continued maintenance on September 12. The [SDK closeout](2026-09-12-maintenance-secret-sdks.md#merge-closeout-2026-09-12-utc) records those completed actions. This lane's merge, #1270 closure and any main promotion remain separately approved actions.

## Initial observations (2026-09-12)

- Shared-handoff resolver returned verified at base `966c77cacf797883cb7f5a127a927f9a684b7896`, naming `docs/SESSION-HANDOFF-2026-09-12.md` (`C:\tmp\maintenance-after-sdk-resolver.json`).
- GitHub open-PR inventory contains four originals: #1270, #1224, #1144 and #1139. [#1270](https://github.com/KStratMD/Preston-Test/pull/1270) targets main at `042bebb0d782054f416be169d5ca82b5bbb38446`; its stale lockfile will not be copied (verified 2026-09-12 using GitHub API).
- Windows Node v22.23.1 / npm 10.9.8; independent baseline npm ci completed with 1,100 packages (`C:\tmp\pg-baseline-install.log`). Root-clone unrelated settings changes are preserved.
- Docker Desktop startup failed in its inference-manager socket initialization. No Docker configuration was changed. A disposable local PostgreSQL 15 substitute is being prepared; no database test has passed in this lane yet.
- Existing transfer fixture seeds an API-key permission array but no bigint beyond JavaScript's safe range. The plan adds a measured round-trip characterization before the driver upgrade.

No candidate dependency mutation, independent clearance, PR-head CI or merge is claimed by these initial observations. Later verified results belong below; the eventual PR carries live review/CI state.

## Plan review and baseline

Claude Opus 5 (`claude-opus-5`) reviewed `17a90f3dfb645fef5f76cfb3bb5249918a1a8bd3`,
requested High, effective effort unreported. Session `901c3f2d-db90-4494-a50b-dafe51656e5f`,
output `C:\tmp\pg-plan-opus.json`. Two blockers were reproduced: nonexistent
`jest.config.cjs` (corrected to `jest.fast.config.cjs`) and the source precision
loss below (replaced the proposed full-path large-integer fixture with direct
PostgreSQL reader/reconciliation coverage). Accepted the seven-OID coverage,
fourth Pool site, cluster prerequisites and exact-preview preservation suggestions.
Named statements are deliberate upstream coverage, not an application usage claim.
The environment suggestion was qualified: explicitly setting `NODE_ENV=test`
and `PGSSLMODE=disable` works; setting NODE_ENV to production with default prefer
would instead require TLS. No SSL policy change is needed.

The source-built disposable server is PostgreSQL 15.19 at
`/home/kstratmd/tmp/preston-pg15-disposable-20260912`, loopback port 55471,
synthetic postgres role/password and `preston_test` database. The role owns the
cluster and can create/drop the suite's temporary databases; maintenance database
`postgres` exists. Official source tarball SHA256 verification passed. Initial
baseline runs exposed missing pgcrypto and postgres_fdw extensions; both were
built into this isolated install. OpenSSL development files were extracted from
Ubuntu's package into the task directory, with no system package install.
Setup logs: `C:\tmp\pg15-disposable-build.log`, `C:\tmp\pg15-disposable-ssl.log`;
WSL task-directory `build-fdw.log`. Stop with
`/home/kstratmd/tmp/preston-pg15-disposable-20260912/install/bin/pg_ctl -D /home/kstratmd/tmp/preston-pg15-disposable-20260912/data -m fast -w stop`.

On the unchanged 8.22.0 dependency tree at `17a90f3dfb645fef5f76cfb3bb5249918a1a8bd3`,
Windows build passed, selected units passed 72 tests / 6 suites, and the complete
PostgreSQL profile passed 57 tests / 11 suites after the setup corrections.
Logs: `C:\tmp\pg-baseline-build.log`, `C:\tmp\pg-baseline-unit.log`,
`C:\tmp\pg-baseline-postgres-complete.log`. Database profile environment:
`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55471/preston_test`,
`DB_TYPE=postgres`, `NODE_ENV=test`, `PGSSLMODE=disable` (synthetic local credentials).
The actual-driver probe `C:\tmp\pg-ssl-contract.cjs` passed: disable connected
without TLS (pg_stat_ssl confirmed), require and verify-full refused this non-TLS
server. It does not test certificate validation or TLS negotiation.

The scratch preview at `C:\tmp\pg823-lock-preview` changes pg 8.22.0 to 8.23.0
and pg-protocol 1.15.0 to 1.16.0 only at package-node level. npm also removes two
redundant mandatory root SDK declarations, preserving their optional declarations
and all SDK nodes. `C:\tmp\pg-lock-guard.cjs` verifies this exact allowlist,
unchanged manifest/overrides and tarball integrity against independently packed
artifacts. The pg artifact confirms `Boolean(c.pipeline)` defaults off; pg-protocol
changes ParameterDescription OID parsing to unsigned. No production native-pg
selection or pipeline opt-in was found. A9's CLI is included among the four Pool
construction sites.

## Retained finding: SQLite source integer precision

**Closed for future SQLite signed-64-bit transfers through authenticated export
and PostgreSQL import/reconciliation by owner-approved PR #1293 at
`feccdd67f485deedd24d6310d5301f8f973631d5`.** See the
[precision merge closeout and retained limits](2026-09-12-maintenance-sqlite-precision.md#merge-closeout-2026-09-13-utc)
(verified 2026-09-12 America/Denver against the merged repair).

**Historical finding: open at the pg review; verified 2026-09-12 by executable reproduction at base `966c77cacf`.**
[`SqliteTransferSource.rows`](../../src/database/transfer/sqliteSource.ts) uses
better-sqlite3's default numeric reads. A stored SQLite integer `9007199254740993`
is returned as number `9007199254740992`; canonicalization accepts the rounded
value. This predates the pg update and can make bundle/reconciliation digests
agree on an already rounded export. Do not describe the full transfer as proven
lossless for such integers. Executor reproduction used the compiled real source
reader and canonicalizer, a temporary synthetic SQLite file, and cleanup;
`C:\tmp\pg-source-precision-repro.log` records stored text, returned value and
canonical result. Repair needs a separate reviewed change covering source bigint
reads, unsafe numeric canonicalization, affected adapters and end-to-end bundle
evidence. It is not hidden by changing the fixture's expected value to the rounded
number, and remained open after this dependency lane until the separate repair above.

## Characterization and candidate verification

Claude cleared amended plan `beb73adb7d` in `C:\tmp\pg-plan-corrected-opus.json`
(same session/model, requested High, effective effort unreported). The three
nonblocking wording corrections were incorporated; no further plan review was
requested by the reviewer. Tests were committed at `649dd23f7d` before dependency
mutation. On pg 8.22.0, the new three-test profile and complete 60-test / 12-suite
PostgreSQL profile passed. Removing the seven custom parser overrides failed
the exact-value test; omitting rollback failed with an aborted-transaction error.
Both scratch mutations were restored, with `git diff --exit-code` proving the
production parser file unchanged. The committed bigint test additionally changes
the stored value by one and requires a digest mismatch. SSL's scratch negative
control (disable instead of required TLS) failed with a missing expected refusal.
Logs: `C:\tmp\pg-contract-baseline.log`, `C:\tmp\pg-characterized-baseline.log`,
`C:\tmp\pg-parser-negative.log`, `C:\tmp\pg-rollback-negative.log`,
`C:\tmp\pg-baseline-ssl-negative.log`. Focused negative-control runs exclude the
other test names; no permanent skips were added.

Candidate source/dependency commit `6d6d90b6277a14a7896be54eb520ba5db9338287`
installs pg 8.23.0 and pg-protocol 1.16.0 from the reviewed exact preview.
Manifest changes only pg's range. All other dependency nodes and overrides are
unchanged; the two lock-root redundant SDK declarations are normalized as
reviewed. No production TypeScript file changed.

Windows v22.23.1 / npm 10.9.8 passed independent npm ci (1,100 packages),
build/typecheck/lint, 72 selected tests / 6 suites, 60 PostgreSQL tests / 12 suites,
the unchanged SSL probe, both audits (zero advisories), and 2,696 core tests /
114 suites with all 87 floors matched. Any, strict-null and core-type budgets,
handoff/mirror and inbound links passed. Logs use prefix `C:\tmp\pg-candidate-`;
the driver is `C:\tmp\pg-windows-verify.ps1` and combined log is
`C:\tmp\pg-candidate-windows.log`. This initial sweep stopped at the expected
deterministic metrics drift caused by the new test file; it was not an all-gates
pass at that point.

WSL gate: `/home/kstratmd/tmp/maintenance-pg` | tested SHA
`6d6d90b6277a14a7896be54eb520ba5db9338287` | Node v22.22.2 / npm 10.9.7 |
command `bash /mnt/c/tmp/pg-linux-verify.sh 6d6d90b6277a14a7896be54eb520ba5db9338287`.
Git transfer from the Windows clone and detached checkout were verified before
independent npm ci. The Linux run passed build/types/lint, the same 72-unit,
60-PostgreSQL and 2,696-core counts, unchanged SSL probe, both zero-advisory
audits, all 87 floors, type budgets and documentation gates, then stopped at the
same metrics drift. Log: `C:\tmp\pg-candidate-linux.log`. These counts overlap
with other profiles and must not be summed as unique tests.

Exact-SHA Linux generation (`C:\tmp\pg-metrics-generation.log`) measured only
`loc.total_ts` changing from 426,940 to 427,015 (+75 test-code lines), with
production LOC unchanged. That generated deterministic LOC block is copied to
metrics.json. Historical environment-specific tests/coverage blocks retain their
prior snapshot; they are not relabeled as this lane's results. Generation stamps are refreshed from the same run and EVALUATION.md
receives the corresponding total-LOC token update. The metrics correction receives a focused follow-up
gate at its own SHA; the earlier run is not retroactively described as passing.

The same SSL probe bytes were used on both platforms:
SHA256 `173bffeb6382811b9b2876fc1e9a7b5496ddb3f655468d769339223b21f0a8d1`.
TLS certificate acceptance, SQLite-source losslessness and pipeline opt-in are
outside the demonstrated compatibility contract. Existing core/PG suites emit
some expected error-path logs; passing test summaries do not assert log silence.

## Independent implementation review and metrics follow-up

Claude Opus 5 independently cleared `26eb584a430172452db42cbe1bc2c590a30daa83`
with no blockers, regressions or false claims found (`C:\tmp\pg-implementation-opus.json`,
same session/model, requested High, effective effort unreported). Claude reran
60 PostgreSQL tests / 12 suites and the 72 selected unit tests / 6 suites,
inspected the parsed lock diff and registry integrities, independently surveyed
status sources, and verified the focused Linux follow-up's completion.

WSL gate: `/home/kstratmd/tmp/maintenance-pg` | tested SHA
`26eb584a430172452db42cbe1bc2c590a30daa83` | Node v22.22.2 |
command `bash /mnt/c/tmp/pg-linux-docs-verify.sh 26eb584a430172452db42cbe1bc2c590a30daa83`
The command exited 0. Metrics/tokens, handoff, AGENTS mirror and inbound links passed, with a
clean tracked tree (`C:\tmp\pg-candidate-linux-final.log`). This closes the
earlier measured metrics gap; the core/source results remain tied to `6d6d90b627`.

The review's two informational notes require no code change: queued-query
deprecation is present in both pg versions and deliberately characterized for
8.x; the PR body carries the exact focused Linux SHA above. Subsequent Copilot,
hosted CI and owner decisions are separate gates, recorded in the replacement PR
when available. This ledger records completed local/independent evidence, not a
claim that later review or merge has already occurred.

## Copilot round 1 dispositions

[Review 5188457397](https://github.com/KStratMD/Preston-Test/pull/1292#pullrequestreview-5188457397)
reviewed 10/11 files at Lite effort and returned two provenance comments, with no
code findings. The initial assignment header is now explicitly historical and
links completed evidence and the live PR. The handoff identifies four *original*
dependency PRs separately from replacement #1292.

The metrics comment correctly reproduced the route's fallback when BUILD_SHA is
unset, but its requirement that git_sha name the future commit containing its own
generated bytes cannot be met by this generator. `generate-metrics.mjs` reads
`git rev-parse HEAD` during generation; recorded `6d6d90b627` is the exact input
of the measured Linux generation, not a claim to be the later documentation head.
Diffing src, manifest, lock and the new test between that input and reviewed
`22dad580a7` is empty. The field is retained as truthful generation provenance;
the review route falls back to that input when BUILD_SHA is absent. No claim of
deployed build identity is made by this dependency PR, and changing that runtime
fallback is outside its scope. The inline reply carries this evidence-based
pushback; it is not an assertion that Copilot accepted it. Subsequent review
disposition belongs to the PR.

## Merge closeout (2026-09-13 UTC)

Owner-approved [PR #1292](https://github.com/KStratMD/Preston-Test/pull/1292)
merged at `2026-09-13T00:36:49Z` as `743499fc79c1a22074a90f138785dc2117ca983c`.
Its tree `b45e131f7a2eff57500e0f300c73e9d47496320a` exactly matches approved
head `1dc36a084b87c94bd91d5b99be944a03adea0a2a` and reviewed parent
`5e62fd8bc616cddadb7e0e6282b3b257b76679d1`. Original #1270 was closed as
superseded at `2026-09-13T00:37:09Z`, under the same explicit approval.

Final [CI run 34724878224](https://github.com/KStratMD/Preston-Test/actions/runs/34724878224)
and companion workflows yielded 15 successful checks and one conditional public-mirror
publication skip. All three required checks passed. Broad CI passed 15,594 tests /
731 suites (10 tests and one suite skipped), with zero failed tests/suites in the
actual report guard; core passed 2,696 / 114 and all 87 floors; full integration
passed 932 / 89 (16 tests and four suites skipped); PostgreSQL passed 60 / 12 with
no skips. Profiles overlap. These are PR-head results, not merge-SHA or deployment
checks. The owned disposable PostgreSQL server was stopped after verification.

Claude's independent implementation clearance is recorded above. Final Copilot
[review 5188493288](https://github.com/KStratMD/Preston-Test/pull/1292#pullrequestreview-5188493288)
on the reviewed parent generated zero new inline comments and no suppressed
findings, covering 10/11 files at Lite effort. It retained a generic request for
final human review; the owner subsequently approved the disclosed candidate.
No separate human code-review result is claimed. The [final handoff](https://github.com/KStratMD/Preston-Test/pull/1292#issuecomment-5649453768)
records the exact head and verification limits.

At the PostgreSQL closeout, the source-precision finding remained open with a separate
[reviewed repair plan](../superpowers/plans/2026-09-12-sqlite-transfer-precision-repair.md).
It subsequently closed within that plan's scope in owner-approved #1293;
see the closure pointer at the original finding above.
Three original dependency PRs (#1224, #1144, #1139), documentation Tasks 4–7 and
main promotion remain separate (verified 2026-09-12 America/Denver, using GitHub
merge/closure/open-PR queries and local tree comparison; timestamps above UTC).
