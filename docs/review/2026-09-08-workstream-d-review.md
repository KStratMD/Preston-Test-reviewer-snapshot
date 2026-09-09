# Workstream D review record

Executor: Codex (OpenAI), MSI, `C:\tmp\gacp-wsb2`, branch
`codex/gacp-workstream-d`, base `2717aa11e904fab32563701f01ea9b0a17a2a644`.
Independent reviewer: Claude CLI, Opus 5. Scope is D1–D3 in the
[plan](../superpowers/plans/2026-09-02-tranche-2-mapping-contract-blueprint-retry-fixtures.md).
Merge, promotion and check activation are separately authorized.

## Independent plan review

Claude surveyed the plan, referenced appendix, spec and actual test/CI/mirror
tooling at the base. Initial verdict: NEEDS CHANGES. Its five findings were:
Jest cannot directly load the planned `.mjs` imports; missing mirror paths;
probabilistic missing-payout coverage; the old missing-document branch also
dropped its payout; metrics regeneration absent from the task's command list.

Codex reproduced the ESM/CJS wrapper failure, inspected the mirror and metrics
gates, and incorporated the corrected generator behavior and regression cases.
The plan's dated execution corrections supersede its old examples. Claude's
second verdict was CLEARED on those in-worktree corrections, before implementation
(2026-09-08; session `8190bdbd-31eb-4c1f-93e2-317a727f37fd`). Local records:
`C:\tmp\gacp-wsd-plan-review.json`, `C:\tmp\gacp-wsd-plan-clearance.json`.

Additional dispositions: separate balance-transaction/refund provenance;
measured source hashes and real capture dates; source pinning limits stated;
explicit types and amount-only oracle row; checker covers missing/unexpected
outputs; detector limits and rung-2 label documented.

The executor also identified the WooCommerce legacy-source mismatch and replaced
it with official 11.0.1 `wc/v3` source references. A proposed NetSuite Swagger URL
returned a soft 404 (HTTP 200, Page Not Found HTML); despite the second review's
suggestion that its versioned URL was stronger evidence, it is excluded, as are
the failed browser content chunks. HTTP status alone does not prove a source.

## Implementation verification

Claude independently reviewed base through `b36083da9467e778caf8f61561cac1b8d55c39f2`
and returned CLEARED, with four nonblocking findings (2026-09-08; session
`5a38a9f0-60c2-425a-8be8-6f21c13fafb8`). It ran the 69 new tests, recomputed the
dataset and source hashes, mutated copied outputs against the freshness checker,
and surveyed plan/spec/status claims independently.

- F1: Git Bash copies symlinks on this host, so its shell-harness run failed.
  The shared workflow requires Linux/WSL for shell gates. Keep all 14 Linux cases
  mandatory; clarify the supported executor in the fixture guide rather than
  weakening the symlink test with a skip.
- F2: Added measured references for eight Shopify nested types/enums after
  reproducing the missing field evidence in the primary object captures.
- F3: Clarified NetSuite supplemental sources as REST examples, not complete
  field schemas. Existing mutable-source and target-version limits remain.
- F4: Shape tests accept schema-formatted capture dates instead of one literal
  date, allowing a later documented recapture.

The first full Linux run at that candidate failed one existing AI dataset test:
15,446 passed, one failed, 10 skipped. It sent an anonymous request while relying
on an inherited demo-mode setting. Diagnostic probes on the unchanged base
`2717aa11e904fab32563701f01ea9b0a17a2a644` reproduced the 403 `TENANT_REQUIRED`
with demo mode off and two passing tests with it on. Merely unsetting the flag
did not resolve the dependency. The test now explicitly selects demo mode and
restores its environment in teardown; its response assertions remain intact.
No product authorization behavior changed. Local evidence:
`C:\tmp\gacp-wsd-baseline-repro.log`, `C:\tmp\gacp-wsd-diagnostic.log`,
`C:\tmp\gacp-wsd-fixups-green.log` (71 tests / five suites with incoming
`DEMO_MODE=0`). Claude's follow-up at
`7c355c59df0134017ce320da0a181936c79f9dbc` returned CLEARED and independently
reproduced the two test passes with incoming `DEMO_MODE=0`. Its single-file
coverage command still exited nonzero on the global coverage threshold; that
was not a full-profile gate pass. The subsequent full profile passed as recorded below.

Follow-up precision: off/unset versus on proves the test's undeclared runtime
precondition, not which persisted setting caused an earlier passing run. The
test comment now describes an inherited setting without assigning its origin.

Initial task evidence: D1 17 tests, D2 15 tests, detector 20 tests, generator 17
tests. The expanded Windows set passed 147 tests in 14 suites plus typecheck,
lint and API-doc generation. Linux freshness red at
`6b6d78a5dfee75c84f7afcb8e9162ffe0f6bd450`: 13 expected failures; green at
`b36083da9467e778caf8f61561cac1b8d55c39f2`: 14 passes, Node v22.22.2.
Local evidence uses `C:\tmp\gacp-wsd-*.log`; no final CI claim is made yet.

## Completed local gate sweep

Linux `/tmp/gacp-wsb2-linux`, source
`7c355c59df0134017ce320da0a181936c79f9dbc`, Node v22.22.2:

- `npm run test:coverage:ci -- --json --outputFile=test-summary.json --runInBand`:
  15,447 passed, 10 existing skips, 726 passing suites and one skipped suite,
  one passing snapshot. Metrics count 727 total suites, including the skip.
- `npm run metrics:generate:authoring`, `npm run metrics:sync-tokens`, and
  `node scripts/verify-metrics.mjs --include-test-coverage`: passed. The generated
  artifacts (`metrics.json`, `EVALUATION.md`) were transferred through Git.
- `npm run test:coverage:core -- --runInBand` and
  `node scripts/check-core-coverage-budget.mjs`: 2,565 tests / 110 suites,
  87-file ratchet unchanged.
- Status, proof-card, route-policy, terminology, any-budget, strict-null,
  core-type-safety, inbound-link, handoff and agent-mirror guards passed.
- Fixture freshness: 14 shell scenarios passed; mirror dependency audit and
  `npm run reviewer:mirror:dry-run` passed.

Log: `C:\tmp\gacp-wsd-linux-gates-r2.log`, ending in the tested-SHA success marker.
The launch pins `NODE_ENV=test` and leaves `DEMO_MODE` unset for the suite.
Windows at the same source passed typecheck, lint and the expanded targeted set:
149 tests / 15 suites (`C:\tmp\gacp-wsd-targeted-final.log`). API-doc generation
passed earlier at `b36083da9467e778caf8f61561cac1b8d55c39f2`; subsequent changes
were test setup, source-evidence notes and metric/status artifacts.

These are local source-SHA results, not a merge-SHA or GitHub CI claim.

## Copilot round 1

Review 5147698367 on `f87638cb6a8042110e812a3fc604828079dd7a04`
returned two diagnostic-wording findings. Both were reproduced before correction:

- Comment 3962860084: absent roots already exited 2, but emitted `ENOENT` while
  file roots emitted `invalid root`. The checker now consistently reports
  `invalid root` for failed root stat or non-directory roots. The Linux harness
  asserts the diagnostic and exit 2 for both cases.
- Comment 3962860120: recording-name rejection said "rung 3 or higher", although
  the schema allows only 1, 2 and 3. The message now says "rung 3"; the schema
  remains unchanged. Strengthened existing assertions failed twice before the fix
  and passed afterward.

Both fixes landed at `293ea045699ffb2b171bcc1f014df446feb5532f`.
Windows passed all 69 new tests, typecheck and lint. Linux tested that exact SHA
with Node v22.22.2: 69 tests / four suites, fixture freshness, all 15 shell cases
and strict metrics verification passed. Metrics were regenerated for the two
additional TypeScript lines; full-profile test/coverage fields retain the actual
`7c355c59df0134017ce320da0a181936c79f9dbc` run recorded above. Evidence:
`C:\tmp\gacp-wsd-copilot-red.log`, `C:\tmp\gacp-wsd-copilot-green.log`,
`C:\tmp\gacp-wsd-copilot-linux.log`.

Claude independently reproduced both corrections and passed the 69 fixture
tests. Its follow-up found the guide still said 14 mandatory Linux scenarios;
that present-tense count was corrected to 15. Historical 14-case records retain
their original tested SHAs. Claude's Windows shell run reproduced the known
symlink-copy limitation (14 passed / one failed); the 15/15 Linux result above
is the supported harness evidence. Copilot re-review and final GitHub CI remain
pending.

## Copilot round 2

Claude cleared `e98f6fe72c97754d43ff0589dd5db88b927f76c2` after the README
count correction. Copilot review 5147805023 on that head recommended approval
but generated comment 3962958547: removing a harness scenario could still exit
0. A temporary copy with the unknown-flag scenario removed reproduced 14 passes,
zero failures and exit 0 on Linux at `a437f79f8` (the metrics-only child of
tested source `293ea045699ffb2b171bcc1f014df446feb5532f`). The harness now
requires exactly 15 passes as well as zero failures.

The review also carried a suppressed test-title comment. Tax and refund
injections intentionally produce an amount discrepancy too, so the title now
describes ten-type coverage and the two separately asserted missing-data cases
instead of calling every prefix injection isolated. Assertions and generation
behavior are unchanged. Evidence: `C:\tmp\gacp-wsd-count-red.log`.

The supported Linux run at `38481704ee1ea938ba2ba2d53ad01a6d8248ad24`
passed all 15 cases; the same removed-scenario copy exited 1. Strict metrics,
links and handoff guards passed (`C:\tmp\gacp-wsd-round2-linux.log`). Claude
cleared the follow-up. Copilot review 5147856392 on that head generated zero new
comments and recommended approval at 2026-09-08T22:56:58Z.

## CI-discovered dependency repair

The empty CI commit `fba3a72f8f22002d604d7bd8f179c3d253cf9764` had the same
Git tree as the reviewed source. [CI run 34288424148](https://github.com/KStratMD/Preston-Test/actions/runs/34288424148)
failed its security audit on Hono, nested js-yaml 4 and Multer advisories. The
baseline and D lockfiles shared blob `52bdb6c0bf97f955f2a22e849cfbb7e107f75478`.
A fresh audit of the baseline manifests reproduced all three entries; running
`node scripts/check-audit-allowed.mjs` locally also reproduced the CI failure.
Evidence: `C:\tmp\gacp-wsd-audit-baseline.json`,
`C:\tmp\gacp-wsd-audit-exact-repro.log`, `C:\tmp\gacp-wsd-ci-security.log`.
The superseded CI run was canceled after that confirmed failure.

Claude independently reviewed and cleared a minimum-scope lock-only repair.
The executor checked two disputed review premises: the existing js-yaml override
selectors do exist, and npm's dependency metadata includes dev counts even when
the vulnerability map is scoped with `--omit=dev`. Claude accepted both factual
corrections. Moderate Hono is blocking because the gate rejects every advisory
outside its empty allowlist, regardless of npm's exit-code severity threshold.

Commit `a77cbe799200b00ddf06cb0829c40d71d4d80523` changes exactly three
resolved nodes (version, registry URL and integrity): Hono 4.13.0 to 4.13.7,
nested js-yaml 4.3.1 to 4.3.2, and Multer 2.2.0 to 2.3.0. The existing compatible
manifest ranges, dev-only js-yaml 3, and audit allowlist are unchanged. The
lockfile's original four-space formatting is preserved. This repairs a baseline
dependency gate failure; it is separate from D's fixture behavior. Upstream
advisories: [Hono](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv),
[js-yaml](https://github.com/advisories/GHSA-2883-xcg3-v3hh),
[Multer](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm).

The dependency change requires fresh full-profile evidence; the earlier
`7c355c59df0134017ce320da0a181936c79f9dbc` result does not verify this new graph.
Verification uses isolated installs in Windows `C:\tmp\gacp-wsd-deps-verify`
and Linux `/tmp/gacp-wsd-deps-linux`, preserving the executor's existing junction
and the prior Linux dependency directory. Independent implementation review,
Copilot re-clearance and a new final CI run remain required.

Claude cleared the lock repair after independently comparing parsed and textual
diffs: nine changed leaves and nine replaced lines, limited to the three
version/URL/integrity triples. Its separate lock-only audit found zero entries.
The fresh Windows install at the repaired SHA passed the actual audit gate,
typecheck, API-doc generation and 50 tests / three suites. Separate real-library
smokes on both operating systems exercised upload acceptance and size rejection,
Hono request/query handling and the nested js-yaml merge parser. Those probes
complement the upload route suite, which mocks Multer; they are not comprehensive
exploit regressions. Logs: `C:\tmp\gacp-wsd-deps-windows.log`,
`C:\tmp\gacp-wsd-deps-smoke-windows.log`,
`C:\tmp\gacp-wsd-deps-smoke-linux.log`; review:
`C:\tmp\gacp-wsd-deps-review.json`.

Fresh full Linux verification at `a77cbe799200b00ddf06cb0829c40d71d4d80523`,
Node v22.22.2, completed successfully: 15,447 tests / 726 passing suites,
10 existing skipped tests, one skipped suite and one snapshot. Core passed
2,565 tests / 110 suites with the unchanged 87-file ratchet. The actual audit
gate, typecheck, lint, API-doc build, regenerated strict metrics, all 15 fixture
harness cases, mirror dependency audit, links and handoff guard passed.
`C:\tmp\gacp-wsd-deps-linux.log` ends in the tested-SHA success marker.
Metrics were regenerated from this fresh full run and transferred through Git;
their `git_sha` and test/coverage values now describe the repaired source.
This supersedes the earlier full-profile evidence for the new dependency graph.
At that checkpoint, Copilot re-clearance and a new final GitHub CI result were
still required. They subsequently completed as recorded below.

## Final review, CI and merge

Claude cleared the final artifacts after correcting the handoff's structured
provenance fields to the fresh dependency-repair run. Copilot then raised a
suppressed cross-file environment-capture concern. The executor's two-file
isolation probe and the actual dataset/smoke pair passed; Claude independently
checked Jest's per-file environment construction and reproduced the real pair
(six passes, three existing provider-dependent skips). The finding was rejected
with evidence, without a source change. [Recorded disposition](https://github.com/KStratMD/Preston-Test/pull/1265#issuecomment-5593355671).
Copilot review 5148099410 at `f54ed17827db81dcc34eac27fe3a64469aa82c49`
subsequently recommended approval with zero new comments.

The empty final CI commit `1eabebd79de0f78a4d76a93ff6584907367c4db0` shares
tree `03e790b35754628ebce22ad55a8140c34650cc80` with that reviewed head.
[CI run 34291518950](https://github.com/KStratMD/Preston-Test/actions/runs/34291518950)
passed 15,447 tests / 726 passing suites, 10 existing skipped tests, one skipped
suite and one snapshot. Core passed 2,565 tests / 110 suites and the unchanged
87-file ratchet. The 15-case fixture harness and strict metrics passed; all
12 applicable checks were green, with public mirror publication intentionally
skipped. Log: `C:\tmp\gacp-wsd-final-ci.log`.

After explicit owner approval, [PR #1265](https://github.com/KStratMD/Preston-Test/pull/1265)
merged into `Working-Branch` at `2026-09-09T00:14:36Z` as
`981d8226af98ba8dc42b4d0eaf63cbc9c70036f3`. Its tree matches the final tested
head. This is PR-head verification plus merge-tree equivalence, not a separate
merge-SHA CI claim. Main promotion, deployment and required-check activation
remain separate. [Review/CI closeout](https://github.com/KStratMD/Preston-Test/pull/1265#issuecomment-5593630322).
