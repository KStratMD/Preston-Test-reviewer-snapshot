# Express-rate-limit compatibility evidence

## Assignment and scope

Codex / OpenAI / MSI executes the approved maintenance Task3 rate-limit row in `C:/tmp/preston-maintenance-sqlite-precision`, branch `codex/maintenance-rate-limit-8`, base `40cf1ea47ff45267d9d5b0f145fe47494dc16b52`. Independent reviewer: owner-selected Claude Opus, requested High, effective effort unreported. The [bounded plan](../superpowers/plans/2026-09-13-rate-limit-compatibility.md) defines the scope and gates. Baseline and implementation checkpoints are recorded separately below.

The live resolver returned verified origin/Working-Branch at the base above, handoff `docs/SESSION-HANDOFF-2026-09-12.md` (`C:/tmp/rate-limit-handoff-resolver.json`). Original #1139 is open, targets main, title8.7.0 while its branch name still says8.6.2. Its old lock diff is not a source for the current replacement. Chalk #1224 remains deliberately deferred. Main promotion and any future merge remain separate decisions.

## Baseline (2026-09-13 UTC)

Windows Node22.23.1, npm10.9.8, installed express-rate-limit7.5.1. Source/dependency inputs are unchanged from base40cf1ea47f; only closeout/plan documentation is pending.

| Invocation | Result | Evidence |
| --- | --- | --- |
| `npx jest --config jest.fast.config.cjs --runInBand --runTestsByPath tests/unit/middleware/rateLimit.test.ts tests/unit/middleware/rateLimitHeaders.test.ts tests/unit/middleware/globalRateLimitPolicy.test.ts tests/unit/middleware/erpWriteRateLimit.test.ts tests/unit/middleware/enhancedRateLimit.test.ts tests/unit/middleware/hostedClientIp.test.ts` | Exit0,135tests/6suites,8.589seconds | `C:/tmp/rate-limit-baseline-unit.log` |
| `npx jest --config jest.slow.config.cjs --runInBand --runTestsByPath tests/integration/globalRateLimit.integration.test.ts` | Exit0,18tests/1suite,29.028seconds | `C:/tmp/rate-limit-baseline-integration.log` |
| `npx jest --config jest.fast.config.cjs --runInBand --runTestsByPath tests/unit/routes/syncErrorAssistIngestRoute.test.ts tests/unit/routes/helpRoutes.test.ts tests/unit/ai/routes/aiProxyRoutes.test.ts tests/unit/middleware/validation.test.ts` | Exit 0, 107 tests / 4 suites, 8.49 seconds | `C:/tmp/rate-limit-baseline-route-unit.log` |
| `npx jest --config jest.slow.config.cjs --runInBand --runTestsByPath tests/integration/syncErrorAssistMiddleware.integration.test.ts tests/integration/syncErrorAssistWebhook.integration.test.ts` | Exit 0, 20 tests / 2 suites, 3.53 seconds | `C:/tmp/rate-limit-baseline-webhook.log` |

The slow profile deliberately force-exits; this is enforcement/identity evidence, not proof of natural lifecycle shutdown. Its expected fail-closed initialization test emits an error log. No unexpected baseline failures are claimed.

## Consumer inventory

Direct package consumers found by source import/require search:

- `src/middleware/rateLimit.ts`: shared custom prefix/IP/user keys, dedicated IP-only MCP key, default-key anonymous AI limiter; real handler/header/skip behavior.
- `src/middleware/setup/MiddlewareSetup.ts`: default-key pre-auth ingress limiter and custom hosted global resolver. The hosted resolver in `hostedClientIp.ts` already groups /64 and ignores client XFF in hosted mode; preserve that contract.
- `src/middleware/validation.ts`: CommonJS require and default-key exported middleware, including test-specific bypass/window behavior; distinguish this from the independent implementation in `enhancedRateLimit.ts`.
- `src/routes/aiProxy.ts`, `secureAI.ts`, `help.ts`: default-key route limiters with existing windows, response messages and authentication-related skip behavior.
- `src/routes/syncErrorAssistRoutes.ts`: tenant-only key, shared cached limiter and audit/error response contract.
- `tests/integration/helpers/syncErrorAssistTestHelpers.ts`: test-only pre-auth default limiter; it is not proof that the production pre-auth mounting path ran.

At the baseline checkpoint, coverage/wiring and missing tests were under independent plan review. No all-consumer compatibility claim is made from the baseline.

The expanded baseline totals 242 unit/route tests across 10 suites and 38 integration tests across 3 suites. `syncErrorAssistMiddleware.integration.test.ts` constructs the real `setupMiddleware` chain; the webhook helper deliberately builds a parallel chain with an adjustable pre-auth budget. Those two coverage sources are distinct.

The webhook baseline also logs four `ERR_ERL_CREATED_IN_REQUEST_HANDLER` diagnostics on v7.5.1, although all tests pass. This predates the migration and reflects cached lazy limiter construction; record it separately from any new v8 custom-IP warnings. No general diagnostic-free baseline is claimed, and this lane does not silently disable those checks.

## Target metadata and migration considerations

Verified npm metadata for8.7.0: Node>=16; debug^4.4.3 and ip-address^10.2.0. [Maintainer changes](https://express-rate-limit.mintlify.app/reference/changelog) include IPv6 default grouping and custom-IP validation, plus subsequent mapped-address handling. [Configuration](https://express-rate-limit.mintlify.app/reference/configuration#keygenerator) and [error guidance](https://express-rate-limit.mintlify.app/reference/error-codes#err-erl-key-gen-ipv6) require an explicit IPv6 policy for custom IP fallbacks. The plan distinguishes existing hosted /64, proposed custom-key /64 repair, and upstream default-key /56 behavior. The implementation checkpoints below record verification of these policies.

## Plan review

Initial Claude review cleared the architecture with revisions. Adopted the explicit custom-key/MCP behavioral test targets, user-versus-IP-only distinction, callback-source heuristic caveat, and owner-visible /64-versus-/56 policy. Two factual review claims required correction: `validation.ts:232` constructs an exported limiter, and v8's validation wrapper logs internal errors instead of propagating them. A scratch package probe (`C:/tmp/rate-limit-validation-probe.cjs`, output `.log`) returns middleware without throwing for raw and aliased callbacks while logging `ERR_ERL_KEY_GEN_IPV6`; the named helper callback logs none. The scratch install is isolated from the repository; no production dependency changed. Construction success alone is therefore not a diagnostic canary. The subsequent review below verifies these corrections before implementation.

Claude cleared the revised plan for implementation in `C:/tmp/rate-limit-plan-opus-r2.json`, accepting the reproduced corrections. Its final cautions were adopted: capture the specific IPv6 diagnostic before constructing each fresh limiter; do not assert blanket logging silence. The initial review is historical in `C:/tmp/rate-limit-plan-opus.json`.

## Windows implementation checkpoint

The new real-middleware test file exercises the existing testing-run and MCP factories, plus default anonymous grouping and successful-authentication decrement. On v7 the nine-case file reports five expected failures and four passes (`C:/tmp/rate-limit-regression-red-v7.log`): custom IPv6 rotation, two mapped-IPv4 forms, MCP rotation and the new default /56 expectation fail. After the unadapted v8 bump, default grouping passes but the explicit construction-diagnostic assertion fails; four custom-key behavior failures remain (`C:/tmp/rate-limit-regression-red-v8.log`, five failed/four passed). These distinguish pre-existing key defects from the newly logged diagnostic and the upstream default-policy change.

The minimal repair calls the upstream named `ipKeyGenerator` with explicit64 in the shared custom callback and the MCP IP-only callback. No middleware mounts, limits, user/tenant dimensions, proxy trust or error/skip policies change. Relevant source/test comments now distinguish the retained hosted /64 policy from default /56. All nine new cases pass (`C:/tmp/rate-limit-regression-green.log`); this uses real middleware and synthetic identity/IP fixtures, not production authentication.

Semantic lock diff: root express-rate-limit range changes from^7.5.1 to^8.7.0; package resolves8.7.0; nested debug4.4.3 and ms2.1.3 are added. Existing ip-address10.4.0 satisfies the requested ^10.2.0 range; its lock entry is unchanged. No unrelated package entry changes. The lock retains four-space formatting and LF. Security overrides and Redis/BullMQ/OTel direct ranges are unchanged; the installed OTel graph still has80 packages with one version each. Install audit reports zero vulnerabilities (`C:/tmp/rate-limit-install.log`).

Windows verification on the candidate source: typecheck and build exit0 (`C:/tmp/rate-limit-typecheck.log`, `rate-limit-build.log`); source and new-test lint exit0 (`rate-limit-lint.log`, `rate-limit-test-lint.log`); focused units/route tests pass251/11 (`rate-limit-unit.log`); actual global/pre-auth/webhook integration passes38/3 (`rate-limit-integration.log`). Integration retains the four baseline created-in-handler diagnostics and produces no new custom-IP diagnostic. Core passes 2,696 tests / 114 suites with all 87 floors matched (`C:/tmp/rate-limit-core.log`, `rate-limit-core-budget.log`). Any/strict-null/core-type-safety, security audit, OTel graph, terminology, mirror, handoff and link gates pass. Exact-SHA Linux verification, metrics and independent implementation review remain pending at this checkpoint. No successor PR, hosted CI, new merge, deployment or original #1139 closure is claimed.

## Independent implementation review and added coverage

Claude Opus 5 cleared implementation65ab4cea3b with three nonblocking findings (`C:/tmp/rate-limit-implementation-opus.json`, requested High, effective effort unreported). It independently passed all nine new tests with the real Jest exit code, verified the narrow runtime/lock changes, and analytically corroborated the reported red-case composition. It did not independently rerun the baseline, broad or core suites.

The stale introductory status is corrected. Two added integration cases in `tests/integration/rateLimitCompatibility.integration.test.ts` directly exercise the production pre-auth mount's /56 grouping and validation.ts legacy/draft-6 header emission. Windows passes2/1 with test lint clean (`C:/tmp/rate-limit-review-gap-tests.log`, `rate-limit-review-gap-lint.log`). The pre-auth test uses a synthetic trusted loopback proxy and a terminal fixture after real middleware; it does not replace the existing HMAC/tenant suite or claim production proxy configuration acceptance. The reviewer called validation.ts the only dual-header limiter; that uniqueness claim is incorrect because the global limiter also enables both. Its direct-coverage gap was valid and is now addressed. Added tests change no production behavior. The Linux completion checkpoint below records the completed exact-SHA verification. Claude subsequently cleared this follow-up with no findings (`C:/tmp/rate-limit-followup-opus.json`), independently running the two new integration tests successfully and checking the Linux logs and unchanged broad-test inputs. The validation.ts case proves header emission only; it does not reach that limiter's rejection threshold. Default-key enforcement is covered separately by the unit suite.

## Linux completion checkpoint

On MSI/Ubuntu native `/home/kstratmd/tmp/maintenance-sqlite-precision`, Node22.22.2, Git-transferred `65ab4cea3b8f046e7cc32092db1367744c5a06be` passed fresh `npm ci` (zero vulnerabilities), the OTel graph/security gates, typecheck/build, integration38/3 and broad15,615tests/733passing suites. Broad had zero failures, existing10test/1suite skips and one passing snapshot; the JSON report explicitly records success and zero failed tests/suites. Commands are in `C:/tmp/rate-limit-linux.sh`; logs use the `C:/tmp/rate-limit-linux-` prefix (`install`, `typecheck`, `build`, `integration`, `ci`, `metrics`), with orchestration result `C:/tmp/rate-limit-linux.log`.

Follow-up `aaee866635a2dfeb2202794ed4fdbc90570de5ef`, transferred through Git, passed all40tests/4relevant integration suites in5.168seconds and regenerated cloc metrics/tokens with strict test/coverage verification. `C:/tmp/rate-limit-linux-followup.sh` checks that the intervening diff contains only docs and the new integration-only file, so the broad report is reused with unchanged broad inputs. Evidence: `C:/tmp/rate-limit-linux-followup.log`, `rate-limit-linux-final-integration.log`, `rate-limit-linux-final-metrics.log`. Both Linux runs completed; no unattended job or service is claimed.

Final metrics identify generation input aaee866635, with production TypeScript219,111 and total TypeScript427,580. That SHA is neither a later containing commit nor a deployment identity. Windows received only the generated `metrics.json` and `EVALUATION.md` artifacts after verifying those paths had no pending edits.

Claude cleared documentation/metrics artifacts at190d13d7cf (`C:/tmp/rate-limit-final-artifact-opus.json`). [PR #1296](https://github.com/KStratMD/Preston-Test/pull/1296) is open. Current remaining gates: Copilot clearance, final hosted CI and a concrete owner merge/supersession decision; the [live PR handoff](https://github.com/KStratMD/Preston-Test/pull/1296#issuecomment-5656843193) records subsequent outcomes. Original#1139 remains open; this lane has not merged or deployed.

## Copilot response checkpoint

Review5192113811 alleged that static imports disable later diagnostic capture. A temporary local alias preserved all eight behavioral cases but failed the unchanged diagnostic assertion with two captured ERR_ERL_KEY_GEN_IPV6 errors (`C:/tmp/rate-limit-copilot-diagnostic-local-alias.log`, exit1). Restoring exact source bytes returned9/9 (`C:/tmp/rate-limit-copilot-restored-green.log`). The upstream validation state is per limiter instance, not module-global. A named-import alias differs: TypeScript preserves the ipKeyGenerator property in its emitted callback, so that first probe correctly passed. Claude independently cleared this evidence-backed response (`C:/tmp/rate-limit-copilot-disposition-opus.json`), inspecting source/logs without rerunning the probe.

The metrics fallback finding is real, pre-existing and retained in [maintenance Task4](../superpowers/plans/2026-09-10-maintenance-and-documentation-plan.md#task-4-inventory-every-active-documentation-surface); restamping cannot repair the runtime route. Review5192648126 repeated it and identified stale checked-in review/PR statuses. Those statuses now reflect the completed artifact review and open PR, with later evidence linked above. The authentication test title now describes the observable contract: successful responses do not spend its failure budget. Assertions and runtime behavior are unchanged. Copilot clearance is not yet claimed.

Copilot review5192727606 found remaining migration-related active-doc drift. The security guide, sync-error proof card, evidence crosswalk and design reconciliation now distinguish retained hosted/custom /64 from default pre-auth /56 and link this migration. The crosswalk also reflects the existing full integration CI job rather than the obsolete smoke-only claim. Historical plans/handoffs retain their dated rationale; current-state and parent-plan wording now identify PR1296 as in review. No runtime or test change accompanies these documentation corrections.
