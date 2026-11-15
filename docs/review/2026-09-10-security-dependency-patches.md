# Security dependency patch batch

## Scope and provenance

The owner approved [maintenance Task 1](../superpowers/plans/2026-09-10-maintenance-and-documentation-plan.md#task-1-refresh-inventory-and-land-the-two-security-patches) on 2026-09-10. [PR #1285](https://github.com/KStratMD/Preston-Test/pull/1285) targets Working-Branch. Codex executes; Claude Fable independently reviews before and after implementation, followed by Copilot and final CI. Merge and main promotion remain separate approvals. Authentication changes, remaining dependency migrations and broad documentation cleanup are outside this batch.

Executor: Codex | OpenAI | MSI | Windows worktree `C:\tmp\gacp-wsb2` | branch `codex/maintenance-security-patches` | execution base `f178e083d5710e70a91ded755dac16fff79609d3` | integration base `494a184e9cd0710071e9b05b77824ba50a164647`. The existing two documentation commits carry the independently cleared maintenance review/plan. The implementation-only commit is `3301dbbd4390adc6bab9ddc85c60b8cacb2a6a63`; it changes only `package-lock.json`.

The handoff resolver returned `verified` against `origin/Working-Branch` before execution. High effort was requested for security and independent review, Low for settled edits. Claude CLI received `--model fable --effort high`; the response identifies `claude-fable-5`, while effective reasoning effort is not separately reported. Codex's effective effort is unknown. Owner-restored Full Access is scoped to this batch; hooks remain active and no persistent permission configuration was changed. Return to workspace-write/on-request through the app after the batch.

## Changes and existing-PR crosswalk

All twelve dependency PR heads, checks and reviews were refreshed on 2026-09-10. The heads match the [maintenance inventory](2026-09-10-maintenance-review.md). All target main and have no submitted reviews; eleven have no failed reported checks, while #1224's Chalk major upgrade retains failures. This is existing-PR evidence, not CI clearance for this replacement.

| Existing PR and reviewed head | Package node | Update |
| --- | --- | --- |
| [#1279](https://github.com/KStratMD/Preston-Test/pull/1279), `a9538a8240e78c738627da58e15796df3419ef57` | `node_modules/smol-toml` | 1.7.0 → 1.7.2 |
| [#1269](https://github.com/KStratMD/Preston-Test/pull/1269), `e6f2d10f51b4fc4be747504d2dea34b0d0d880c9` | `node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml` | 3.15.1 → 3.15.2 |
| Same #1269 head | `node_modules/js-yaml` | 5.2.2 → 5.2.3 |

Both security PRs report `maintainerCanModify: false`. A replacement on the shared integration base avoids rewriting bot-owned, main-targeted branches and importing their large formatting/base diffs. The original PRs remain open until the replacement lands; this record does not claim they are closed or retargeted.

Exactly three lockfile entries change, each only in version, resolved URL and integrity hash. Package ranges, existing overrides, every other node, and the already-patched nested js-yaml 4.3.2 are preserved. Root js-yaml 5.2.3 is an additional non-advisory patch update from #1269, explicitly anticipated by Task 1. Its [upstream changelog](https://raw.githubusercontent.com/nodeca/js-yaml/5.2.3/CHANGELOG.md) records tag/mapping prototype lookup, timestamp, null mapping and AST presentation fixes. No application migration or new dependency node is introduced.

## Security boundary and verification

[GHSA-7w5x-hrqm-74c2](https://github.com/advisories/GHSA-7w5x-hrqm-74c2) affects smol-toml through 1.7.0: an unterminated comment inside an array or inline table can prevent parser termination. Here it is a development dependency of markdownlint-cli, used for configuration parsing. [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) affects nested js-yaml 3.15.1: repeated empty merge sources evade the total-merge budget. This copy is consumed by load-nyc-config in the Jest coverage dependency chain. Both vulnerable nodes are development-only; the baseline runtime-only audit already reported zero. This is not evidence of a remotely exploitable application endpoint.

The root js-yaml copy parses the repository's OpenAPI document in [RouteSetup](../../src/middleware/setup/RouteSetup.ts), plus scripts and workflow tests. Legitimate parsing, configuration loading, generated documentation and coverage behavior must remain intact.

Windows verification used a fresh `npm ci` in the execution worktree on Node v22.23.1. The former dependency junction was removed as a junction only; its target `C:\tmp\gacp-wsd-deps-verify\node_modules` was preserved for baseline comparison. No shared install was mutated, no lifecycle script was suppressed, and the prepare hook completed.

| Check at implementation commit `3301dbbd4390adc6bab9ddc85c60b8cacb2a6a63` | Result |
| --- | --- |
| `npm ci` | Exit 0, 1,092 packages installed, zero vulnerabilities |
| `npm audit --package-lock-only` | Exit 0, zero vulnerabilities; baseline had exactly two high advisories |
| `npm audit --omit=dev --package-lock-only` | Exit 0, zero vulnerabilities |
| `npm run typecheck` and `npm run lint` | Both exit 0 |
| `npm run build:api-docs` | Exit 0; generated `docs/api/API.md` unchanged |
| Focused YAML/OpenAPI Jest profile | 21 tests / 5 suites passed, including HTTP 200 and structural checks for `/openapi.json` |
| `npm run test:coverage:core -- --runInBand` | 2,565 tests / 110 suites passed |
| `node scripts/check-core-coverage-budget.mjs` | All 87 files matched; no restamp |
| Markdownlint CLI with ordinary TOML and YAML configurations | Both exit 0; targeted consumer smoke, not a claim that the entire documentation corpus passes lint |
| Parsed OpenAPI files and eleven workflow documents | All thirteen results deep-equal before/after |
| Bounded parser checks | Four adversarial cases rejected after patch; two ordinary controls unchanged |

Focused Jest command:

```sh
npm run test:fast -- --runInBand --runTestsByPath tests/unit/blueprint/workflows.test.ts tests/unit/scripts/run-ai-accuracy-benchmark.dataLeakage.test.ts tests/unit/__tests__/openapi.spec.validation.test.ts tests/unit/__tests__/openapi.drift.test.ts tests/unit/config/swagger.failOnErrors.test.ts
```

The bounded parser probe runs each input in a disposable Node child with a two-second timeout. Both `a=[1 #` and `a={b=1 #` time out with smol-toml 1.7.0 and promptly throw with 1.7.2. Ten empty YAML mappings merged ten times evade `maxTotalMergeKeys: 15` on 3.15.1 and raise the budget exception on 3.15.2. A sequence of 101 empty merge sources is accepted before and rejected after. Ordinary TOML arrays/booleans and YAML merges produce equal values in both versions. These deterministic checks demonstrate the repaired parser boundaries without running a large CPU-exhaustion workload.

The generated API Markdown SHA-256 is unchanged: `035d6c5893101875350e47a0989aea3ec2c749f28af7b3cea1d56c865c2fe00e`. Machine-local probe and logs: `C:\tmp\security-patches-parser-probe.cjs`, `security-patches-parser-{baseline,patched}.log`, `security-patches-{npm-ci,typecheck,lint,core,focused-tests,api-docs}.log`, and `security-patches-audit-{all,runtime}.json` under `C:\tmp`.

## Independent review and remaining gates

Claude Fable returned **PRE-PATCH CLEARED — no blockers**, independently checking registry integrity, ranges, dependency closure and consumer exposure. Machine-local response: `C:\tmp\security-patches-pre-review.json`. Its observation that the modified handoff was unrelated was rejected: the assignment record is required by AGENTS.md and was deliberately excluded from the implementation-only commit. Its request to inspect the root 5.2.3 changelog is addressed above. Its full-repository Markdown lint suggestion was narrowed to actual TOML/YAML configuration consumer checks because broad documentation repair is a separate planned lane; this does not claim corpus-wide lint clearance.

Linux verification: MSI | Ubuntu | `/tmp/preston-security-patches-3301dbbd` | tested SHA `3301dbbd4390adc6bab9ddc85c60b8cacb2a6a63` | Node v22.22.2. The exact commit was fetched from the Windows Git repository and checked out detached in a Linux-only gate worktree; a fresh Linux `npm ci` passed. All four YAML-consumer harnesses passed: `tests/scripts/audit-proof-cards.test.sh`, `tests/scripts/check-openapi-route-coverage.test.sh`, `tests/scripts/blueprint-cli.test.sh`, and `tests/scripts/e2e-smoke-environment.test.sh`. This is fixture/harness evidence, not a live browser or deployment claim. Machine-local script/log: `C:\tmp\security-patches-linux.sh` and `C:\tmp\security-patches-linux.log`.

Claude Fable independently reviewed candidate `bebf657e3070bc287cf2abc6d63a372fb361d0ca` against integration base `494a184e9cd0710071e9b05b77824ba50a164647` and returned **PATCH AND STATUS CLEARED — no blocking findings**. It verified diff closure, registry integrity and both audit modes; inspected parser evidence and Linux logs; and performed an open-scope status pass selecting its own sources, including fresh authentication characterization and dependency-PR checks. Machine-local response: `C:\tmp\security-patches-final-review.json`. It noted that PR #1285 should be linked explicitly (addressed above), that final CI still needs an unsuppressed commit, and that a native-ESM default-import limitation predates this patch and is outside the current CommonJS execution path. No source change was requested.

Copilot review `5169680923` at `d966f8987a4391e332d8c21307e9a2f164941638` recommended approval and raised one plan-header consistency comment. The executor compared the cited plan template and clarified both execution-skill options, retaining the owner's assigned roles and conditional delegation. No code change resulted. The subsequent review and merge evidence follows. No required-check policy, branch protection, main promotion or deployment configuration changed.

## Merge closeout — verified 2026-09-10 UTC

[PR #1285](https://github.com/KStratMD/Preston-Test/pull/1285) merged with owner approval at `2026-09-10T17:33:09Z` into Working-Branch as `a4c043135c4678277ec5c451335705138b6e1bc4`. The merge and approved final head `5152d490e188ea057533d45fc707426132cf5991` share tree `385cfbdcc05ec6e83d8fb04c7d54eb5c5eebe93d`. Superseded PRs [#1279](https://github.com/KStratMD/Preston-Test/pull/1279) (smol-toml) and [#1269](https://github.com/KStratMD/Preston-Test/pull/1269) (both js-yaml updates) were closed after merge with the owner's authorization and replacement crosswalks. Main promotion remains separate; closing those bot PRs does not patch main.

[Copilot's final review](https://github.com/KStratMD/Preston-Test/pull/1285#pullrequestreview-5169750624) at `c048f026b51e1e1a5e7963079439e6e0965c6d63` recommended approval with zero new comments. The one earlier thread was resolved. Copilot reported lite effort and four of five files reviewed; Claude's independent forced-text lockfile review supplies the additional parser-diff evidence. The final CI commit was empty and retained Copilot's reviewed tree.

All 14 reported checks passed on head `5152d490e188ea057533d45fc707426132cf5991`. [CI run 34502901494](https://github.com/KStratMD/Preston-Test/actions/runs/34502901494) reported 15,458 passed tests, 10 skipped tests, 727 passed suites, one skipped suite and one passed snapshot; its summary guard confirmed zero failed tests and suites. Core passed 2,565 tests in 110 suites with all 87 coverage-budget files matching. [The final verification handoff](https://github.com/KStratMD/Preston-Test/pull/1285#issuecomment-5622400079) links the remaining check runs. These are PR-head results, not a claim of a separate merge-SHA CI run.

Closeout provenance: Codex | OpenAI | MSI | `C:\tmp\gacp-wsb2` | branch `codex/maintenance-security-closeout` | base `a4c043135c4678277ec5c451335705138b6e1bc4` | Linux gate locator and tested SHA remain the implementation-only evidence above; no new Linux execution is claimed for these documentation edits | independent reviewer Claude Fable requested at High effort, followed by Copilot | foreground execution, no unattended service. The security-batch assignment is closed; the remaining maintenance plan is unapproved for execution. Saved Codex defaults were verified as workspace-write/on-request; the executor made no persistent configuration change. This does not assert that the active task's Full Access setting has been changed.
