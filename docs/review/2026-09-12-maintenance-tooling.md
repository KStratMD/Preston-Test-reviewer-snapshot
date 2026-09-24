# Maintenance Task 3: bounded tooling batch

## Merge closeout (2026-09-12 UTC)

Owner-approved [PR #1289](https://github.com/KStratMD/Preston-Test/pull/1289)
merged into Working-Branch at `2026-09-12T16:25:59Z` as
`3012abfb1690049c4dfc8e660dbfb59316f30334`. Its tree
`3a1e270073d9559578efd476a907a751f56b9496` matches approved CI head
`e3bfe3bf39f09774ccbc0c392dc2a498f9ac755d` and reviewed parent
`d1aeb464266f95bf6ea524a0acbdbd408d4e27ea`. All 14 checks and all three
required checks passed. Broad CI: 15,593 tests/731 suites passed, 10 tests/one
suite skipped, one snapshot passed; core: 2,696/114 and all 87 floors; integration:
932/89 with 16 tests/four suites skipped. Profiles overlap and are not summed.
These are PR-head results, not separate merge-SHA or deployment checks.

Claude cleared the final docs after independently confirming the separate post-run
Linux cleanliness probe. Copilot review 5186982762 returned zero inline comments
and no suppressed findings, covering 3/4 files at Lite effort; its disposition
requested final human review. The owner subsequently approved merge. Original PRs
[#1220](https://github.com/KStratMD/Preston-Test/pull/1220),
[#1223](https://github.com/KStratMD/Preston-Test/pull/1223), and
[#1226](https://github.com/KStratMD/Preston-Test/pull/1226) were closed as superseded
with the owner's explicit approval. The [final verification handoff](https://github.com/KStratMD/Preston-Test/pull/1289#issuecomment-5647052772)
preserves review and CI provenance. Verified 2026-09-12 through GitHub merge/closure
queries and Git tree comparison. Main promotion remains separate.

The plan and candidate notes below are historical execution evidence; their
pending-review/CI and open-original-PR statements describe those earlier stages,
superseded by this closeout. The tooling assignment is complete; Task 3 as a whole
is not complete.

## Assignment and scope

Executor Codex | provider OpenAI | host MSI | Windows worktree
`C:\tmp\preston-maintenance-tooling` | branch
`codex/maintenance-tooling-dependencies` | base
`aaa1505bc416fa42c1d2e991f378b04b2bf2b026` | independent reviewer Claude
Opus (the owner's latest Opus selection supersedes this plan's older Fable default),
requested High, effective effort unreported. Linux gate locator:
`MSI / Ubuntu /home/kstratmd/tmp/maintenance-tooling`; tested SHA
`1f04da13ca631890f2a7add0ac0381f3a376e142`. No unattended executor is claimed.

This executes only the tooling rows of [maintenance Task 3](../superpowers/plans/2026-09-10-maintenance-and-documentation-plan.md#task-3-disposition-the-remaining-ten-dependency-prs).
Targets are ESLint 10.10.0 (from 10.8.0; original PR #1220), Prettier 3.9.6
(from 3.9.5; #1223), and removal of obsolete `@types/commander` 2.12.0
(instead of the 2.12.5 bump in #1226) if bundled-type resolution and CLI
verification succeed. Commander itself stays at 15.0.0. Other runtime upgrades,
major migrations, general documentation repair, main promotion and deployment
are separate. Original PRs remain open pending a concrete disposition decision.

## Plan for independent review

0. Run `node scripts/resolve-shared-handoff.mjs`, require `verified`, and confirm
   the freshly fetched Working-Branch head. Re-resolve before mutation and before
   final review; if the base advanced, reconcile/rebase and repeat the affected
   baseline and verification. The replacement PR targets **Working-Branch**.
1. Install with `npm ci --no-audit --no-fund` into this worktree's own Windows `node_modules`.
   Record Node/npm versions and baseline lint, typecheck, build, formatter-check
   diagnostics and compiled CLI smoke results. Formatting debt is measured, not
   mass-reformatted. Never mutate another worktree's junctioned dependencies.
2. Verify Commander 15's package exports/types and TypeScript resolution for all
   four consumers: `src/cli.ts`, `src/cli/configValidator.ts`,
   `src/cli/credential-manager.ts` and `src/cli/db-transfer.ts`. Only help commands
   and local disposable configuration fixtures may run; no credential or database
   mutation commands. Module imports can validate environment before help prints:
   run each compiled CLI in a child process from a disposable directory, with
   `NODE_ENV=development`, `DEMO_MODE=1`, `DB_TYPE=sqlite`, `LOG_LEVEL=info`,
   `DATABASE_URL` removed. SQLite path isolation comes from the disposable cwd;
   `DATABASE_PATH` is not consumed by the application and provides no protection.
   Use the same environment for baseline/candidate and compare exit codes and
   semantic output, recording stderr. Development mode is deliberate: test mode
   forces the logger to error level and hides validation messages. Exercise config
   validation with valid, invalid and malformed JSON; use environment credential
   references in the valid fixture, without supplying or contacting real systems.
3. After independent plan clearance, update only the selected manifest entries
   and reconcile the current lockfile using npm. Inspect every added, removed or
   version-changed package and preserve Task 1's security patches and overrides.
   Raise manifest floors to `^10.10.0` and `^3.9.6`, rather than leaving the
   older floors and merely repinning. Exact mutation commands:
   `npm pkg delete devDependencies.@types/commander`, then
   `npm install --package-lock-only --save-dev --save-prefix=^ eslint@10.10.0 prettier@3.9.6 --no-audit --no-fund`.
   No bare `npm install`, `npm update`, or `npm audit fix`. Avoid unrelated package
   refreshes. Remove v2 types only if evidence supports it. Assert before and after:
   smol-toml 1.7.2, load-nyc-config's js-yaml 3.15.2, json-schema-ref-parser's
   js-yaml 4.3.2 and root js-yaml 5.2.3 stay at their baseline versions (or an
   explicitly reviewed safer version); preserve every existing override unchanged.
4. Reinstall the candidate lockfile independently. Run lint, typecheck, build,
   the same CLI smokes, existing db-transfer CLI tests, and compare formatter
   diagnostics with baseline. The existing db-transfer test exercises ts-node and
   complements compiled help checks. Inspect lint plugin peer compatibility and
   npm's resolved dependency tree. Run `npm audit --package-lock-only --json` and
   `npm audit --omit=dev --package-lock-only --json`, requiring zero advisories
   (including the two advisories named in the [Task 1 record](2026-09-10-security-dependency-patches.md)).
   Run the applicable repository gates;
   run core coverage and its budget check. A newly introduced failure requires
   reproduction and a bounded fix or separation from this batch.
5. Commit coherent changes with hooks active. Transfer that exact commit through
   Git into a Linux-native worktree with its own dependencies and Node 22 for
   Linux-only/CI-parity checks. Record tested SHA, commands, counts and limitations.
6. Obtain Claude Opus's independent implementation and open-scope status review,
   then dedicated Copilot review. Every intermediate pushed head suppresses CI
   through its subject only. Run hosted CI once on the final cleared, identical
   tree. Present the PR, exact head and original-PR disposition proposal for owner
   approval; do not merge, close originals or promote main on plan authority alone.

## Maintainer evidence

- [ESLint 10.8.1](https://github.com/eslint/eslint/releases/tag/v10.8.1),
  [10.9.0](https://github.com/eslint/eslint/releases/tag/v10.9.0),
  [10.9.1](https://github.com/eslint/eslint/releases/tag/v10.9.1) and
  [10.10.0](https://github.com/eslint/eslint/releases/tag/v10.10.0): rule corrections
  and expanded detection; 10.10.0 also changes file-entry-cache to v11. Existing
  flat configuration and TypeScript plugins must be exercised unchanged.
- [Prettier 3.9.6](https://github.com/prettier/prettier/releases/tag/3.9.6): quoted
  methods named `new`, TypeScript `import defer` support and an optional new
  plugin. No new plugin is needed by this batch.
- [Commander 15 package](https://github.com/tj/commander.js/blob/v15.0.0/package.json):
  confirm its installed bundled declarations and runtime/module contract locally
  before removing the old DefinitelyTyped package.

## Execution evidence

Baseline at `aaa1505bc416fa42c1d2e991f378b04b2bf2b026`, Windows Node v22.23.1,
npm 10.9.8: independent `npm ci` installed 1,092 packages; lint, typecheck and
build exited 0. All four imports resolve `node_modules/commander/typings/index.d.ts`;
installed `@types/commander` is a declaration-free stub. Compiled help for all
four consumers and valid/invalid/malformed config validation passed 7/7 assertions;
existing db-transfer CLI tests passed 3/3 in one suite. Initial smoke attempts used
test mode (suppressed info logs) and an incomplete fixture; the corrected fixture
uses managed environment references and the pinned environment above. No app
source was changed to obtain these results. `format:check` exited 1 with existing
issues in 730 files; that diagnostic set is the comparison baseline. Installed-tree
audit returned zero advisories. Required lock-only audit variants remain pending.
Machine-local baseline logs: `C:\tmp\tooling-baseline-*.log`; replay smoke driver:
`C:\tmp\tooling-smoke.cjs`, with outputs in `C:\tmp\tooling-smoke-baseline`.

Claude Opus (`claude-opus-5`, session `2678e444-4ad7-4400-8129-8505c50736fd`)
returned NOT CLEAR on the initial plan. F1 freshness/target, F2 security assertions,
F4 missing 10.8.1 notes and F5 exact commands are corrected above. F3 environment
coupling was reproduced; development mode is used with evidence instead of the
suggested test mode so messages are observable. F6 owner model override is now
explicit, without inventing a reassignment date. F7 unrelated handoff EOF change
is restored. Follow-up plan review returned CLEAR; its non-blocking correction
about the inert `DATABASE_PATH` variable is incorporated above. Review artifacts
are `C:\tmp\tooling-plan-opus.json` and `C:\tmp\tooling-plan-opus-r2.json`.
Both baseline lock-only audit variants subsequently exited 0 with zero advisories.

## Candidate verification

The manifest floors are raised and the redundant types stub removed. npm's
lockfile rewrite was normalized back to the existing four-space indentation;
package ordering follows npm. The parsed diff has nine added, two removed and
seven version-changed nodes, all development-only:

| Change | Packages |
| --- | --- |
| Updated | ESLint 10.8.0 to 10.10.0; Prettier 3.9.5 to 3.9.6; @eslint/plugin-kit 0.7.2 to 0.7.3; file-entry-cache 8.0.0 to 11.1.5; flat-cache 4.0.1 to 6.1.23; flatted 3.4.2 to 3.4.4; keyv 4.5.4 to 5.6.0 |
| Added | @cacheable/memory 2.2.0; @cacheable/utils 2.5.0; @keyv/bigmap 1.3.1; @keyv/serialize 1.1.1; cacheable 2.5.0; hashery 1.5.1; hookified 1.15.1; qified 0.10.1; qified's nested hookified 2.2.0 |
| Removed | @types/commander 2.12.0; json-buffer 3.0.1 |

The ESLint cache dependency requires the cacheable/keyv chain; plugin-kit meets
ESLint's new minimum. `npm ls eslint prettier commander typescript-eslint` exits
0, with TypeScript ESLint 8.68.0 supporting ESLint 10. No source, lint rule or
TypeScript configuration changed. Parsed assertions confirm all 465 existing
runtime package entries are identical, no new runtime entry appeared, all four
security-patched nodes are preserved and every manifest override is identical.
Both full and runtime-only lockfile audits return zero advisories.

Windows Node v22.23.1 / npm 10.9.8, independent candidate `npm ci` (1,099 packages):

| Verification | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck`, `npm run build` | Exit 0 each |
| Compiled CLI smoke replay | 7/7, same statuses and required semantic messages |
| Existing db-transfer CLI tests | 3 tests, 1 suite passed |
| `npm run test:coverage:core -- --runInBand` | 2,696 tests, 114 suites passed; no skips |
| `node scripts/check-core-coverage-budget.mjs` | All 87 floors matched |
| `npm run format:check` | Exit 1, identical 730-file warning set to baseline |
| Any / strict-null / core type safety | Passed; strict-null remains 58, core escapes 0 |
| Shared handoff / agent mirror / inbound links | Passed; zero broken links |

These are local candidate-tree results, not hosted CI or a merge claim.
Logs are `C:\tmp\tooling-candidate-*.log` and audit JSON files; parsed lock
assertions are in `C:\tmp\tooling-lock-assert.cjs` and `tooling-lock-diff.json`.
Linux verification tested source commit `1f04da13ca631890f2a7add0ac0381f3a376e142`
in the worktree above, with independent `npm ci`, Node v22.22.2 and npm 10.9.7.
Lint, typecheck, build, the 3-test CLI suite, 2,696-test/114-suite core profile and
all 87 coverage floors passed. Shared handoff, notes mirror, inbound links, any,
strict-null and core type safety, API-docs build, terminology gate and its shell
regression harness, Blueprint CLI shell harness, both lockfile audits and metrics
verification all passed. Tracked Linux working tree remained clean. The exact
driver is `C:\tmp\tooling-linux.sh`; output is `C:\tmp\tooling-linux.log`.
The later documentation-only evidence commit is not represented as separately
Linux-tested; dependency and application content are unchanged from this SHA.

Claude Opus independently returned CLEAR on `1f04da13ca631890f2a7add0ac0381f3a376e142`
(`C:\tmp\tooling-implementation-opus.json`). It re-derived the complete parsed
lockfile closure, zero unresolved required dependencies or orphans, runtime/security
preservation and peer compatibility. It re-ran lint, typecheck with the stub absent,
both audits, type budgets and documentation gates, and compared the formatter logs.
It inspected the smoke assertions and outputs but did not re-run the build, core
coverage or CLI suite; those remain executor evidence, including the Linux run.

Copilot and hosted final CI are pending. Proposed original-PR disposition after
owner-approved merge: supersede #1220, #1223 and #1226 with this replacement;
none is closed by this record. Other Task 3 groups and documentation Tasks 4–7
remain incomplete. Main promotion and deployments are separate.
