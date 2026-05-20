# Proof Card: FinanceCentral Operator Service

**Status:** beta
**Last verified:** 2026-05-13 · git sha `88c21442`

## Claim

`FinanceCentralOperatorService` promotes the FinanceCentral approval workflow from in-memory Map demo to a durable, audited state machine. Operators approve or reject `finance_central_approvals` rows via `POST /api/finance-central/approvals/:id/{approve,reject}`. The approve path is a two-stage durable lease (`pending → applying → accepted`) that wraps the NetSuite `update` write between `beginAccept` and `completeAccept`; every failure mode (no `netsuite_id`, connector throw, connector returns null, completion lost-race) reverts the lease back to `pending` and stamps an `audit_logs` row keyed `finance_central.approve` with `result='failure'`. Reject is an atomic single-stage transition with no external write. Status is `beta` because all 5 production connectors plus credentials would need to be exercised against a live Squire NetSuite sandbox before promotion to `production`.

## Source

- Operator service: `src/services/financeCentral/FinanceCentralOperatorService.ts:1-346`
- Repository: `src/services/financeCentral/FinanceCentralRepository.ts:1-322`
- Types (per-method discriminated unions `ApproveResult` + `RejectResult`): `src/services/financeCentral/types.ts:1-58`
- Routes: `src/routes/financeCentral.ts:145-217` (approve + reject handlers)
- Result-code → HTTP-status mapping: `src/routes/financeCentral.ts:27-39` (includes 500 `state_drift`)
- Schema migration: `src/database/migrations/039-create-finance-central-approvals-table.ts`
- DI wiring (both bindings `toDynamicValue(async)` end-to-end): `src/inversify/inversify.config.ts:1226-1255`
- Demo seed: `src/services/financeCentral/demoSeed.ts` (NODE_ENV-gated; no-op under `test` / `production`)
- Dependencies: `ConnectorManager.getConnector('netsuite', ...)`, `AuditLogRepository.create`, `extractIdentityContext` (`src/services/governance/identityContext.ts`)

## Tests

- Unit (repo, atomic transitions): `tests/unit/services/financeCentral/FinanceCentralRepository.test.ts` (21 tests)
- Unit (operator service, flow + revert + audit + state_drift): `tests/unit/services/financeCentral/FinanceCentralOperatorService.test.ts` (23 tests, including 3 dedicated state_drift assertions)
- NLAG dispatch (PR 6 T6): `tests/unit/services/ai/NLActionGateService.test.ts` (60 tests, of which 7 cover the FC operator dispatch surface)
- Integration (route-level, in-memory SQLite + mocked `ConnectorManager.getConnector`): `tests/integration/financeCentral-approveItem.test.ts` (19 tests covering happy path + 400/404/409/503/502/500 with revert; the 500 test pins the `state_drift` retry-amplification fix from Codex R1; 5 input-validation tests (number/object/whitespace) pin the R7 input-type hardening)
- E2E (UI surface, stubbed `window.fetch`): `tests/e2e/finance-central-approve.spec.ts` (2 Playwright tests asserting outgoing request URL + body)
- Coverage: measured against `.core-coverage-budget.json` — `FinanceCentralOperatorService.ts` at 100% lines / 85.45% branches / 100% functions; `FinanceCentralRepository.ts` at 100% lines / 82.5% branches / 100% functions. Budget gates regressions on either floor.

## Live vs Fixture

- Real HTTP wired? **Yes** — the route handlers call `getConnector('netsuite', \`netsuite_${tenantId}\`)` and invoke `connector.update(documentType, netsuite_id, {fields: {...}})` against the real `NetSuiteConnector`. Unit and integration tests stub at the `ConnectorManager.prototype.getConnector` seam (mirrors the SyncErrorAssist operator pattern).
- DB persistence wired? **Yes** — migration 039 creates `finance_central_approvals` on first `DatabaseService.initialize()`; all reads/writes go through `FinanceCentralRepository` with atomic UPDATE-WHERE for state transitions (no Map state in production code).
- Demo-mode toggle? **N/A** at the operator surface — `demoSeed.ts` is gated on `NODE_ENV` (returns no-op under `test`/`production`) so demo rows only appear in dev. There is no fixture/demo branch inside the operator service itself.
- Production credential test on file? **No** · Status remains `beta`. Promotion to `production` requires (a) a live Squire NetSuite sandbox approve cycle against real credentials, and (b) the per-tenant PR 2C-Auth identity propagation so `extractIdentityContext` returns a real tenant instead of falling back to `SYSTEM_IDENTITY`.

## Known Gaps

- **Single-tenant assumption pre-PR-2C-Auth**: `extractIdentityContext(req)` falls through to `SYSTEM_IDENTITY` because none of the FC routes carry verified auth yet (PR 2C only mounted auth on AI-proxy routes). All seeded demo data therefore lives under `tenant_id = '__system__'`. If multi-tenant rollout precedes PR 2C-Auth, this section breaks — re-evaluate before promoting to `production`.
- **F-06 silent UI mock-success**: `public/finance-central-dashboard.html:451-456` (and the symmetric reject path at `:473-478`) catches every API error and locally removes the row "for demo continuity." Manual smoke therefore cannot detect a broken backend; the T9 integration test + the T10 Playwright test are the regression-prevention contract. Reverting this UI behavior (proper error toast + leaving the row visible) is a follow-up UX cleanup, not a correctness fix.
- **Concurrent-approve race coverage**: spec §6.3 lists "concurrent same-row approves → one gets 200, the other 409" but it's intentionally NOT covered at the integration layer (supertest race determinism is fragile). The race-safety contract — atomic `UPDATE … WHERE operator_disposition = 'pending'` in `beginAccept` — is covered at the repo unit-test layer instead.
- **No Business Central or Dynamics dispatch path**: today the operator service always asks `getConnector('netsuite', ...)`. PR-OP-3 (dual-ERP routing via `connectorTypeForApproval()`) is out of scope for v1.
- **HITL approval-queue UI**: there is no operator dashboard for bulk actions, escalation routing, or per-tenant approver assignment. The current UI is the same in-page button row that the original Map demo had — durable persistence underneath it is what's new. PR-OP-4 is the future HITL surface.
- **Stale TS warnings**: `FinanceCentralService.ts` has two pre-existing `noUnusedLocals` warnings (`totalAssets`, `paymentDate`) and `NLActionGateService.ts` constructor keeps an unused `financeService` parameter after T6's dispatch move. Pre-existing; surgical to keep this PR focused.

## Verification (60-second AI-reviewer recipe)

```bash
# Repo + operator-service unit tests
npx jest --runTestsByPath tests/unit/services/financeCentral/FinanceCentralRepository.test.ts tests/unit/services/financeCentral/FinanceCentralOperatorService.test.ts

# Route-level integration (in-memory SQLite, ConnectorManager.getConnector stubbed)
npx jest --config=jest.slow.config.cjs --runTestsByPath tests/integration/financeCentral-approveItem.test.ts

# UI-layer regression (Playwright, file:// + window.fetch stub)
npx playwright test --config=playwright.e2e.config.cjs tests/e2e/finance-central-approve.spec.ts

# Confirm the two-stage state machine is wired (NOT a single UPDATE)
grep -n "beginAccept\|completeAccept\|revertToPending" src/services/financeCentral/FinanceCentralOperatorService.ts | head -12

# Confirm the route maps each result code to the spec'd HTTP status
grep -n "RESULT_CODE_HTTP_STATUS\b" src/routes/financeCentral.ts
```

The first grep proves the approve path runs `beginAccept → connector.update → completeAccept` with revert on EVERY failure branch (no single-statement transition for approve). The second grep proves the route maps each `ApprovalResultCode` to its spec §2.D7 HTTP status: `not_found=404`, `already_dispositioned=409`, `connector_unavailable=503`, `write_failed=502`, `state_drift=500` (R2 addition — Codex R1 BM-1 fix for the post-connector-write lease-loss race).
