# Maintenance Task 3: PapaParse compatibility batch

## Merge closeout (2026-09-12 UTC)

Owner-approved [PR #1290](https://github.com/KStratMD/Preston-Test/pull/1290)
merged into Working-Branch at `2026-09-12T18:41:10Z` as
`7d23327343c178791bd27acc9bdf496d1e8a1eb2`. Its tree
`621cb14935dff87857b328ebcb94489df6a19a72` exactly matches final CI head
`a7774d2cb981099e226e21fbd3816b4c9edfa970` and reviewed parent
`ac04178b2dc864cedf1c6d3b8a0437904fb0b670`. Original #1225 is closed as
superseded with owner approval. Main promotion remains separate.

The [final verification handoff](https://github.com/KStratMD/Preston-Test/pull/1290#issuecomment-5647550488)
records all 15 applicable checks passing, including the three required checks;
public-mirror publication was conditionally skipped. Hosted broad coverage passed
15,594 tests/731 suites (10 tests/one suite skipped; one snapshot); core passed
2,696/114 with all 87 floors; full integration passed 932/89 (16 tests/four suites
skipped). Profiles overlap. These are PR-head results, not a separate merge-SHA
test or deployment claim. Claude Opus cleared implementation and final metrics/status.
Copilot review 5187301563 returned zero comments on 8/9 files at Lite effort and
requested final human review; the owner subsequently explicitly approved merging.
No separate human review is inferred from that approval.

This closes only the PapaParse row of maintenance Task 3. Six original dependency
PRs and documentation Tasks 4–7 remain. The dated plan and pre-merge evidence below
are retained as history; their pending review/CI/closure statements are superseded
by this closeout (verified 2026-09-12 by GitHub merge/closure queries and Git tree
comparison).

## Assignment and boundaries

Executor Codex | provider OpenAI | host MSI | worktree
`C:\tmp\preston-maintenance-csv` | branch `codex/maintenance-papaparse` | base
`3012abfb1690049c4dfc8e660dbfb59316f30334` | independent reviewer Claude Opus
(owner's latest model choice overrides the maintenance plan's older Fable default),
requested High, effective effort unreported. Linux locator:
`MSI / Ubuntu /home/kstratmd/tmp/maintenance-csv`; tested source SHA
`8ae65a2a936f024854743ec776b86ac089c60841`, Node v22.22.2.
No unattended executor is claimed. Source: [maintenance Task 3](../superpowers/plans/2026-09-10-maintenance-and-documentation-plan.md#task-3-disposition-the-remaining-ten-dependency-prs).

Target `papaparse` 5.5.4 to 5.7.0, matching original PR #1225, reconciled against
Working-Branch. The only application PapaParse call is **CSV export**:
`FileUploadService.exportFieldMappingsToCSV` calls `Papa.unparse`. Upload parsing
uses the separate `csv-parser` package. This batch must verify both surfaces without
misrepresenting PapaParse as the import parser. Current production route callers
pass a hardcoded empty mapping list or one literal template mapping; arbitrary
mapping/escaping tests cover the service API, not a live user-data export path.
No parser replacement, new upload
policy, live data use, main promotion or deployment. PR #1225 remains open until
the owner approves a concrete replacement merge and supersession.

## Plan for independent review

1. Resolve live handoff with `node scripts/resolve-shared-handoff.mjs`, require
   `verified`, and confirm the fetched Working-Branch head before mutation and
   final review. Rebase/reconcile and repeat affected evidence if the base advances.
   Target the replacement PR to Working-Branch.
2. Install baseline with `npm ci --no-audit --no-fund` in this worktree's own
   Windows dependency directory; never share mutable installs. Read the maintainer
   changelog for every crossed release (5.5.5, 5.6.0, 5.6.1, 5.7.0) and inspect the
   distributed package/source changes affecting `unparse`, not just release titles.
   Record absence of any use of jQuery integration, download/stream parsing and
   Date-valued fields in the typed exporter before assessing their relevance.
3. Before changing the dependency, run the existing FileUploadService and route
   suites, lint, typecheck and build. Add only missing, focused compatibility tests
   against the real service/PapaParse export surface. Export cases:
   exact header/order/CRLF framing, comma/quote/newline escaping and Unicode,
   empty mappings/cells, the string rendering of `isRequired` and transformation expressions/conditions,
   plus a bounded large mapping set. Assert semantic content and exact escaping,
   not just a success code or roundtrip through the same serializer.
4. Use bounded scratch characterization for the plan's upload cases against the unchanged csv-parser path:
   quoted delimiters, BOM/CRLF, empty/duplicate headers, missing/extra columns,
   malformed quoting. These probes describe unchanged import behavior and are not
   evidence about the PapaParse bump; repeat them on the candidate, but do not add
   persistent tests that imply the existing permissiveness is a desired policy.
   For size, exercise real router multipart handling mounted at the current
   `/api/upload/api/file-upload/field-mappings/import` path, with a stubbed adapter
   to isolate the route's manual 5 MiB check. This is a scratch probe repeated on
   the candidate, not a committed test: at the boundary succeeds, one byte
   above returns 400 `FILE_TOO_LARGE`. The router uses memory multer with no limits;
   `getMulterMiddleware()` has no production caller. Its separate configured
   `LIMIT_FILE_SIZE` behavior is not a production size guarantee. Other import
   routes have no equivalent check. Do not repair these existing route/policy
   differences here. Use synthetic in-memory multipart payloads and disposable paths.
   Test additions precede mutation. For an actual behavior fix, reproduce a failing
   assertion before the minimal fix; existing-behavior compatibility tests may pass
   on both versions and must demonstrate non-vacuous assertions by a bounded mutation.
5. After plan clearance and baseline evidence, run only
   `npm install --package-lock-only --save-prod --save-prefix=^ papaparse@5.7.0 --no-audit --no-fund`.
   Raise the manifest floor to `^5.7.0`; restore existing four-space lockfile
   indentation if npm rewrites it. No bare install, broad update or audit fix.
   Inspect every parsed lockfile change: require only the PapaParse node/manifest
   change unless additional dependency changes are independently justified.
   Preserve all overrides, the tooling batch, the three Task 1 lockfile updates
   (smol-toml 1.7.2, nested js-yaml 3.15.2, root js-yaml 5.2.3) and the already
   patched nested js-yaml 4.3.2 retained by the
   [Task 1 record](2026-09-10-security-dependency-patches.md).
6. Reinstall candidate with independent `npm ci`; rerun the focused suites,
   lint/typecheck/build, both full and runtime-only `npm audit --package-lock-only
   --json` variants (zero advisories), type budgets, core coverage and its ratchet.
   If tests add LOC, regenerate only the necessary deterministic metrics in Linux
   using the repository authoring workflow and preserve explicitly dated test totals.
7. Commit coherent work with hooks active and transfer the exact SHA through Git
   to a Linux-native worktree with its own Node 22 dependencies. Run relevant
   Linux-only and parity gates, preserving SHA, Node, commands/counts and a separate
   post-run cleanliness probe. Obtain Claude's independent implementation and
   open-scope status review, then Copilot; address findings with reproduction.
8. Intermediate pushed subjects suppress CI; final cleared tree gets one
   unsuppressed CI head. Present final evidence for owner merge/supersession approval.
   Keep the already approved tooling closeout and lane-plan docs in a separate
   first commit, before dependency/test edits, so they can be reviewed or carried
   independently if this bump is deferred. Other dependency groups and documentation
   Tasks 4–7 remain open; no global Task 3 completion claim.

## Maintainer sources and observations

- [5.5.4 to 5.7.0 source comparison](https://github.com/mholt/PapaParse/compare/5.5.4...5.7.0)
  includes Date serialization via `toISOString`, delimiter guessing, header
  transformation/de-duplication, jQuery integration removal and download timeout.
- [5.6.0 release](https://github.com/mholt/PapaParse/releases/tag/5.6.0) and
  [5.7.0 release](https://github.com/mholt/PapaParse/releases/tag/5.7.0) describe
  jQuery integration removal and the configurable remote-download timeout.
  GitHub's releases API has no 5.5.5 release entry; use the tagged changelog and
  distributed source for patch-release details. The npm registry lists 5.6.1 too.
- [Tagged changelog](https://github.com/mholt/PapaParse/blob/5.7.0/CHANGELOG.md)
  covers all four crossed releases. Comparing installed 5.5.4 and npm-packed 5.7.0
  shows one `JsonToCsv` hunk: Date serialization via `toISOString`, including invalid
  and expanded-year Dates. All other changes are parse/stream/browser paths.
  Every exported field is typed as a string; `isRequired` is rendered to a string.
  The Date branch is not used by the typed service exporter or its literal route
  callers. Synthetic string probes were byte-identical; this is a compatibility
  update, not a claim of repaired CSV-import behavior.

## Evidence

Initial plan review returned NOT CLEAR. F1 production size-boundary attribution and
F2 import-evidence scope are corrected above; F3 distinguishes the three Task 1
updates from the additional preserved node; F4 records route reachability;
F5 records the sole unparse delta; F6 specifies boolean-to-string rendering;
F7 separates documentation into the first commit. The follow-up verified all seven
closed and conditionally cleared execution after removing one surviving step-3
reference to persistent parser/multer tests and labeling the size probe scratch-only.
Those exact edits are applied above; persistent additions cover service exports only.
Artifact: `C:\tmp\csv-plan-opus.json`, session `d27e9890-cafa-4e71-bd4c-a35089f67a43`.
Follow-up: `C:\tmp\csv-plan-opus-r2.json`.

Baseline install completed with
Node v22.23.1 and npm 10.9.8, 1,099 packages. Live resolver verified the base above.
Existing focused suites passed 44 tests in two suites; lint/typecheck/build exited
0. Logs: `C:\tmp\csv-baseline-*.log`. Candidate evidence follows; hosted CI is pending.

## Windows candidate evidence

Only the `papaparse` manifest floor (`^5.7.0`) and the package-lock PapaParse
version/resolved/integrity fields change. All 1,131 other non-root package entries,
the package set and every override are identical to base. No application source
changed. The lockfile's existing four-space indentation is preserved.

Three existing service export tests now assert exact CSV rather than substrings;
one new test verifies all 1,000 rows of a bounded large export through the separate
csv-parser reader. They cover field order, CRLF record framing, empty templates and
optional cells, required-flag strings, Unicode, commas, quotes, LF/CRLF inside
cells, expressions and conditions. The 45-test service/route selection passed on
both 5.5.4 and 5.7.0. A scratch-only Jest setup replaced unparse with empty output:
all four export tests failed on their output/row assertions (21 other tests were
filtered out, not newly skipped in source). This proves the assertions detect a
broken serializer; it is not a claim of an app defect fixed by the upgrade.

Windows candidate: Node v22.23.1 / npm 10.9.8, independent npm ci (1,099 packages).
Lint, typecheck, build and the focused suites pass. Core passes 2,696 tests/114
suites and all 87 floors. Both full and runtime-only lockfile audits report zero
advisories. Any, strict-null (58), core type safety (0), handoff, agent mirror and
inbound-link gates pass. Test types are checked by the ts-jest run, not by the
application-only `npm run typecheck` command.

Seven scratch csv-parser import probes are byte-identical before/after: quoted
delimiters, BOM/CRLF, duplicate headers, empty headers, short rows, extra columns
and unterminated quoting. Retained baseline limitations: the BOM stays in the
header, duplicate keys overwrite earlier values, and malformed/uneven rows can
parse permissively. These are unchanged importer observations, not PapaParse
benefits or newly adopted policies. The separately mounted real-router multipart
probe uses a stub adapter solely to isolate the manual size check: 5 MiB returns
200 and calls it once; 5 MiB + 1 returns 400 `FILE_TOO_LARGE` and never calls it.
This is not evidence of a global streaming upload limit; the router's multer has
no size limit and other upload endpoints do not share that manual check.

Machine-local evidence: `C:\tmp\csv-candidate-*.log`, audit JSON files,
`C:\tmp\csv-lock-assert.cjs`, `C:\tmp\csv-mutation.log`, and
`C:\tmp\csv-characterization.log`. The scratch drivers are
`C:\tmp\csv-characterize.cjs` and `C:\tmp\csv-route-limit-probe.cjs`.

## Linux verification and independent implementation review

Exact source SHA `8ae65a2a936f024854743ec776b86ac089c60841` was transferred through
Git to the Linux worktree above and independently installed with Node v22.22.2 /
npm 10.9.7. Lint/typecheck/build, 45 focused tests/two suites, core 2,696 tests/114
suites and all 87 floors passed. Broad coverage passed 15,594 tests/731 suites
(10 tests/one suite skipped, one snapshot passed). These overlapping profiles
are reported separately. Both audits returned zero advisories. Type budgets,
handoff/notes/inbound links, API-docs build, terminology and its shell harness
passed. The explicit post-gate tracked-tree cleanliness assertion passed before
metrics generation. `C:\tmp\csv-linux.sh` is the driver and
`C:\tmp\csv-linux.log` contains its source SHA, commands, results and sentinel.

The authoring metrics workflow used that full coverage run and pinned cloc to
regenerate `metrics.json`; `metrics:sync-tokens` changed only EVALUATION.md's total
TypeScript LOC token. Total LOC is 426,940 (up 27), production LOC stays 219,101;
the one added test raises passing/total counts to 15,594/15,604. Coverage is the
fresh measured aggregate, while all 87 core floors remain unchanged.
`verify-metrics --include-test-coverage` passed. The generated diff was transferred
back with Git patch/apply. The metrics `git_sha` deliberately names the tested
source commit, before the subsequent metrics/evidence-only commit.

Claude Opus cleared the implementation at the source SHA above
(`C:\tmp\csv-implementation-opus.json`), independently parsing both lockfiles,
verifying the package integrity hash against its own npm pack, deriving expected
CSV bytes from both distributed versions, and re-running the 45 focused tests,
audits and type/skip budgets. Its non-blocking note correctly limits the large
test to plain values and ordering; exact escaping is exercised by the separate
literal assertion. It did not re-run core or the Linux full profile; those remain
executor evidence. Final metrics/status review, Copilot and hosted CI are pending.
