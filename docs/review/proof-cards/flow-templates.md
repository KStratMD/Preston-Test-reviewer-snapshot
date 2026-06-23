# Proof Card: Governed Flow Templates (FlowExecutor + DSL)

**Status:** production
**Last verified:** 2026-05-20 against the PR #825 review head at the time of stamping. The card describes the implementation contract; specific commit SHAs are re-stamped on merge by the `update-docs` workflow rather than per R-round to avoid churn on intermediate review heads.

## Claim

`FlowExecutor` (`src/flows/templates/FlowExecutor.ts`) is the single runtime that walks every governed flow template through `transform → validate → governance scan → dispatch`. When a template's payload contains high-risk PII or other policy violations, the executor short-circuits BEFORE the connector write — `OutboundGovernanceService.validateConnectorWrite` either approves the write (executor proceeds with the redacted payload), enqueues an `ApprovalQueueService` row and returns `{status: 'pending_approval', approvalId, pollUrl}`, or returns `{status: 'blocked', reason: 'governance'}` with the findings. This is the flow-layer counterpart to the route-layer catch helper (`src/middleware/governance/approvalQueueErrorHandler.ts`) and the connector-layer catch (`BaseConnector.validateOutboundWrite`); all three paths converge on the same `ApprovalQueueService.enqueue` contract that PR 3C's operator UI consumes. PR 14 narrowed ships single-row operations (`create | update | delete`) and one sample template; the merged remediation plan's bulk dispatch ships in PR 14b. LineageRecorder (PR 12) and OwnershipResolver (PR 13 / 13b) integration have since **landed** — `FlowExecutor` now emits lineage events and enforces ownership via `guardedWrite()`.

## Source

- Implementation: `src/flows/templates/FlowExecutor.ts` (the `FlowExecutor` class around line 52, with `execute` + private `dispatch` declared inside)
- DSL: `src/flows/templates/FlowTemplate.ts` (interface), `src/flows/templates/FlowResult.ts` (result union)
- Entry point: `src/flows/templates/FlowExecutor.ts` — `FlowExecutor.execute()` (single public method on the class)
- Registry: `src/flows/templates/registry.ts` (canonical `FLOW_TEMPLATE_REGISTRY` list)
- Sample template: `src/flows/templates/samples/SampleHubSpotToNetSuiteContact.ts`
- Dependencies: `src/services/governance/OutboundGovernanceService.ts:195` (DLP scan), `src/services/governance/ApprovalQueueService.ts:125` (enqueue). The dispatch step uses the `IConnector` instance passed in via `FlowContext.connector` — the caller (route handler / orchestrator) resolves + initializes that connector through `ConnectorManager.getConnector` BEFORE invoking `execute()`. The executor itself does NOT depend on `ConnectorManager` (Codex 5.5 HIGH restructure).
- DI binding: `src/inversify/inversify.config.ts` (last block — `container.bind<FlowExecutor>(TYPES.FlowExecutor)`)

## Tests

- Unit: `tests/unit/flows/templates/FlowExecutor.test.ts` (36 tests, 100+ expects across 7 families: transform/validate; governance decisions (including update-without-id + update-with-whitespace-id pre-governance fail-fasts); dispatch + id resolution (incl. `readId` whitespace-trim, Codex 5.5 HIGH update-id leak guard, redacted-id-stripped edge case, belt-and-braces direct-dispatch guards for update + delete with null pre-captured ids, Copilot R3 on PR #827 log-line leak guard, Copilot R4 on PR #827 resourceId PII-fallback guard, Copilot R8 on PR #827 non-plain redactedPayload guard, Copilot R10 on PR #827 connector-echo guard); connector contract (systemType match assertion); delete pre-resolve (Codex 5.5 MEDIUM: resolver-throw fail-fast + empty-string rejection + enqueue-uses-pre-resolved-id); governance context plumbing; redactedPayload precedence)
- Integration: `tests/integration/FlowExecutor.test.ts` (3 scenarios: happy path, HITL queue with real `governance_approvals` row persisted, oversize hard-block)
- CI gate regression: `tests/scripts/check-flow-template-instrumentation.test.sh` (9 scenarios: happy + 8 reject cases — missing import, orphan, duplicate id, disallowed `bulk_upsert`, delete-without-resolver, delete-with-non-callable-resolver, delete-with-shorthand-resolver, retryPolicy-idempotencyKey-shorthand)
- Coverage: ratcheted into `.core-coverage-budget.json` (PR 14 adds `src/flows/templates/FlowExecutor.ts` to both `collectCoverageFrom` and `testMatch` in `jest.core.config.cjs`; the stamped per-file floor is enforced by `node scripts/check-core-coverage-budget.mjs` in CI).

## Live vs Fixture

- Real HTTP wired? **N/A** — the executor delegates HTTP to whichever connector the caller passed via `FlowContext.connector`. The PR 14 narrowed integration test injects a `jest.Mocked<IConnector>` directly through `FlowContext.connector` (no `ConnectorManager` rebinding), but exercises the REAL `OutboundGovernanceService` + REAL `ApprovalQueueService` + REAL `governance_approvals` table in an in-memory sqlite database — the governance pipeline is not stubbed, only the network egress.
- Demo-mode toggle? **No** — the executor has no demo branch. It either runs or it doesn't.
- Production credential test on file? **N/A** — the executor is connector-agnostic. Production connector tests live with each connector (NetSuite, HubSpot, etc.).

## Known Gaps

- **Bulk dispatch (`target.operation === 'bulk_upsert'`) is not yet implemented.** The CI gate rejects it. Ships in PR 14b once a connector exposes a non-`'unsupported'` `bulkRollbackStrategy` AND the `executeBulk` helper lands.
- **Lineage hops ARE recorded (PR 12 shipped).** `FlowContext` carries a `LineageRecorder` (`ctx.lineageRecorder`, with optional `ctx.sourceRecord`); `FlowExecutor` emits all four event types (`source_read` / `transform` / `governance_decision` / `target_write`) under one `chain_id`. See `record-lineage.md`.
- **Ownership IS enforced (PR 13 / 13b shipped).** `FlowExecutor` injects an `OwnershipResolver` and routes every write through `guardedWrite()`, returning a `FlowBlockedResult` with `reason: 'ownership'` (or `'loop'`) when the `SOURCE_OF_TRUTH_MANIFEST` rejects the write. See `guarded-write-ownership-enforcement.md`.
- **Single-validation contract not yet implemented.** Concrete connectors that call `BaseConnector.validateOutboundWrite` internally will re-scan the payload after the executor's own scan. Same payload + deterministic policy = same decision, so this is wasted work, not incorrect work. PR 14b's `precomputedDecision` plumbing closes the redundancy.
- **Only one sample template ships.** The merged plan's three production templates (Squire→NS OTC, HubSpot→NS PTP, Squire→NS Payouts) require Lineage + Ownership; they ship with PR 14b. The sample exists today so the executor + CI gate have a real consumer to walk end-to-end.
- **No retry loop.** `retryPolicy.maxAttempts` / `backoffMs` are persisted on every template but the executor itself does NOT yet read them. Today's executor performs a single dispatch and returns `failed` on any throw. PR 14b will add the retry wrapper.
- **No `idempotencyKey` enforcement.** The CI gate asserts the callable is present, but the executor does not yet read it. Same PR 14b follow-up.

## Verification (60-second AI-reviewer recipe)

```bash
# Unit suite — 36 tests, ~60s on a warm Jest cache:
npm test -- tests/unit/flows/templates/FlowExecutor.test.ts

# Integration — 3 scenarios against in-memory sqlite + real governance services:
npx jest --config=jest.slow.config.cjs --testPathPatterns=tests/integration/FlowExecutor.test.ts --runInBand

# CI gate (registry/source consistency):
npm run audit-flow-templates

# CI gate regression suite (9 scenarios — A happy + B–I reject paths):
bash tests/scripts/check-flow-template-instrumentation.test.sh

# Confirm DI binding shape:
grep -n "TYPES.FlowExecutor" src/inversify/inversify.config.ts src/flows/templates/FlowExecutor.ts
```
