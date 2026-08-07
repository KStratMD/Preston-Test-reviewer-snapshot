# ADR-019 — Workflow Governance Without Hosted Data

**Status:** Accepted (2026-05-18, Phase 0 of `docs/plans/2026-05-17-governance-without-hosting-data-plan.md`)
**Decision drivers:** Preston's stated principle ("data lives in the external system and in the client's NetSuite instance — we're not holding it"); reducing Squire's data-custodian liability for WorkflowCentral; preserving the existing governance gates (DLP, OCC, tenant kill switch, audit) untouched; sequencing four architectural moves so each de-risks the next.

## Context

WorkflowCentral as currently implemented violates Preston's principle. The two persistence migrations land inline business payload in Squire's database:

- **`workflow_central_tasks.data`** (migration 041 — PR-OP-2, `d66b1da5`) — TEXT column carrying the operator-visible task payload (PO number, vendor, amount, employee details, etc.) plus optional completion data.
- **`workflow_central_instances.variables`** (migration 042 — PR-OP-3, `b8a438ae`) — TEXT column carrying the per-instance variable bag (the workflow's runtime business context).

Today, a Squire breach would expose these columns to whoever read them — Squire is, in fact, holding the business data Preston said it would not.

The strategic question on the table is whether Squire can run a governance product (workflow state machine, audit trail, approval gates, kill switch, DLP/PII enforcement) without becoming a custodian of the underlying business payload. The 2026-05-17 strategic memo answered "yes, in four sequenced architectural moves." The plan at `docs/plans/2026-05-17-governance-without-hosting-data-plan.md` decomposes Phase 1 into 18 TDD tasks plus a Phase 2-4 roadmap.

This ADR locks the strategic decision in writing AND inventories every source-side site that touches business payload, before any code changes land.

## Decision

We adopt a **reference-based default for WorkflowCentral business payload, with a gated ephemeral-hosted exception**, sequenced as four optional phases:

1. **Strategic default — Phase 1 (reference-based).** New non-demo WorkflowCentral instances persist `WorkflowPayloadReference` (a `{system, recordType, recordId, fieldsOfInterest}` pointer to the client's ERP), NOT inline business payload. Operator render fetches live data through the existing `ConnectorManager.getConnector` → `BaseConnector.read(entityType, id)` seam, with a short-TTL in-process cache. DLP scanning shifts from write-time on inline payload to egress-time on resolved payload. The audit log records refs + governance decisions + timestamps only — never resolved field values, never ephemeral `data`.

2. **Exception path — ephemeral hosted payload.** Workflows that legitimately cannot be reference-based (transient variables not present in any source ERP, AI-generated workflows pre-creation in the ERP, cross-system composition with derived state) may persist `EphemeralWorkflowPayload` with a REQUIRED `expiresAt` ISO timestamp and human-readable `reason`. **Acceptance is gated by EITHER the global env flag `WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD`** (checked via `isEphemeralWorkflowPayloadAllowed()` in `src/config/runtimeFlags.ts`) **OR the per-tenant setting `workflow.allow_ephemeral_payload = 'true'`** (read via the plaintext-only `TenantConfigurationRepository.getBooleanStrict` inside `WorkflowCentralOperatorService.getTaskForOperator` — the strict path rejects encrypted rows so SecretManager outages cannot collapse into silent 403 policy denials; env short-circuits the DB lookup so the global override skips per-tenant cost). New non-demo tenants get rejection-by-default at the render path → `EphemeralPayloadNotAllowedError` → **403 with `code: 'EPHEMERAL_PAYLOAD_NOT_ALLOWED'`**.

3. **Tagged-union contract from day one.** The `WorkflowPayload = WorkflowPayloadReference | EphemeralWorkflowPayload` discriminated union ships in Phase 1 with both modes, so Phases 2-4 operationalize the existing shape rather than reshaping the contract.

4. **Sequencing (each phase optional, demand-gated).**
   - **Phase 1 (next 60-90 days)** — reference-based pivot for WorkflowCentral. Smallest engineering delta; largest per-dollar liability reduction.
   - **Phase 2 (~120-180 days)** — hybrid ephemeral hosting with `EmbeddedRetentionJob`-shape cleanup scheduler (per `AGENTS.md:136-159`). Bounds how long Squire holds residual payload.
   - **Phase 3 (~12-18 months, enterprise tier)** — BYOK encryption. Reuses the `TenantConfigurationRepository.is_encrypted` + `SecretManager` scaffolding from PR #808 (`92c2045c`).
   - **Phase 4 (multi-quarter, strategic)** — federated runtime. The engine ships as SuiteApp / Docker image; workflow state lives in the client's environment; Squire holds only the policy server, audit-log digest, and kill switch.

5. **Off-ramps are explicit.** After Phase 1 ships and the executive conversation lands, each of Phases 2-4 is a separate go/no-go gated on customer demand — not a sunk-cost trajectory. The plan's "Decision points / off-ramps" table enumerates the triggers.

6. **Cross-cutting invariants unchanged across all four phases.** DLP at egress, OCC-safe state machine (`applyVolatileState` + instance-first lock order + `RaceLostError` retry), tenant kill switch (`makeTenantStatusGate` at `src/middleware/tenantStatusGate.ts`), audit-grade lifecycle (`safeAudit` + `redactWorkflowPayloadForAudit`), embedded surface contract (`PostMessageProtocol.ts`). Phase 1 shifts WHEN/WHERE these patterns apply; the patterns themselves are constant.

## Consequences

**Easier:**

- The executive conversation with Reuben becomes "we run the governance, you keep the data" instead of "trust us with everything."
- Squire's breach surface for WorkflowCentral business payload approaches zero post-Phase 1 (modulo the gated ephemeral escape hatch and the pre-backfill legacy fallback).
- SOC 2 control work can scope around "Squire holds refs + governance metadata, not business records."
- Each subsequent phase becomes cheaper because it builds on the reference shape (Phase 2 retention scheduler purges ephemeral rows; Phase 3 BYOK encrypts whatever ephemeral payload remains; Phase 4 federation moves the whole engine).

**Harder:**

- Operator render adds one ERP API round-trip per task render. Mitigated by short-TTL `WorkflowPayloadCache` (default 30s, configurable). Open Question Q1 sets a strawman 500ms p99 steady-state / 2s p99 cold-cache latency budget.
- Cross-workflow search on payload content ("find all approvals over $50K") becomes impossible from Squire's DB alone. Documented in the Phase 1 proof card as a Known Gap; future options include a search-index sidecar or a denormalized "search hints" column (out of Phase 1 scope — Open Question Q3).
- NetSuite per-tenant governance API quotas could be exhausted by render bursts. Mitigated by cache + the existing Governance Pacer (CLAUDE.md "Production-Ready Features"). Open Question Q5 covers per-tenant pacing.
- Degradation behavior when source ERP is unreachable becomes a UX decision (hard-fail vs cached-with-stale-badge vs refs-only-with-inline-error). Open Question Q2 frames the three options; strawman is hard-fail for governance-sensitive workflows, best-effort for read-only audit views.
- Cross-system compose workflows (NetSuite + Business Central + Salesforce in one task) require the operator UI to render multi-ref payload. The resolver returns a partial-success `ResolutionOutcome[]` (per-ref status + fields/error), so one connector being down does not blank out the whole render — but the UI composition logic moves up a layer.

**Trade-offs explicitly accepted:**

- One extra network hop per task render in exchange for not being a data custodian for the underlying payload.
- Loss of cross-workflow DB-side search in exchange for the same.
- A documented ephemeral escape hatch (with `expiresAt` + audit-redaction + Phase 2 retention scheduler) in exchange for not blocking legitimate cross-system composition.

## Related decisions

- **ADR-015** (canonical connector registry) — the `ConnectorManager.getConnector` seam this plan reads through. The Phase 1 starter system union (`netsuite | businesscentral | salesforce | hubspot | shipstation | oracle`) is intentionally a subset of the registry; extending requires per-connector readiness review, not silent registry sync.
- **ADR-018** (embedded ERP surface contract) — names `netsuite | business_central | standalone` as deployment platforms. Phase 4's federated runtime makes `standalone` first-class; the contract is already abstracted enough to support it. Note: the embedded-surface vocabulary uses `business_central` (with underscore) while the connector registry uses `businesscentral` (no separator); the Phase 1 `WorkflowExternalRecordReference.system` literal union uses the connector-registry form. An explicit mapping layer is added if/when the two vocabularies need to compose.
- **PR #808** (`92c2045c`, KMS Tier-C wiring) — the `TenantConfigurationRepository.is_encrypted` column + `SecretManager` abstraction this plan reuses for Phase 3 BYOK.
- **PR #794** (tenant kill switch foundation) — the `makeTenantStatusGate` middleware at `src/middleware/tenantStatusGate.ts` that already gates every WorkflowCentral request. Phase 4 federation checks license validity against Squire's policy server periodically — same semantic, different transport.
- **AGENTS.md L136-159** — mandates `EmbeddedRetentionJob` (`src/services/embedded/EmbeddedRetentionJob.ts`) as the canonical Tier-B scheduler pattern Phase 2's `WorkflowPayloadRetentionJob` MUST mirror verbatim.
- **CLAUDE.md "Strategic Vision (Squire Partnership)"** — Design Principle #1 ("ERP-Native, embedded sidecar not separate app") aligns with the reference-based model: business data lives in the ERP, not in Squire.

## Open executive questions (resolved at plan level, listed here for traceability)

Six questions are open for executive review in the plan (§"Open questions for executive review"): operator render latency budget; degradation behavior when source ERP is down; cross-workflow search trade-off; cross-system compose semantics; NetSuite API quota; sequencing commitment (Phase-by-Phase go/no-go vs full sequencing commitment). The strawman answer for each is in the plan; this ADR does not pre-empt them.

---

## Custody inventory (Phase 0 §Step 2 + §Step 3)

Run on `main` at `d826501f` (`2026-05-18`):

```bash
rg -n "workflow_central_tasks\.data|workflow_central_instances\.variables|\.data|\.variables" \
   src/services/workflowCentral \
   src/services/WorkflowCentralService.ts \
   src/routes/workflowCentral.ts \
   tests -S | tee /tmp/workflow-payload-custody-inventory.txt
```

Raw count: **588 lines** — 23 from the target source surface, 565 from tests. The test-side bulk is dominated by `DatabaseService` injections and unrelated `.data*` property accesses (`data_quality_score`, `dataSet.data`, etc.) that the broad regex picks up but are not in scope for this ADR. Per the plan's §Step 3 categories, the **23 source-side hits classify as follows**:

### `metadata` — 6 hits, no business payload

DI injection lines and the log-message strings that NAME the columns (the strings themselves carry no payload).

- `src/services/WorkflowCentralService.ts:248` — `DatabaseService` `@inject`
- `src/services/workflowCentral/WorkflowCentralRepository.ts:47` — `logger.warn('workflow_central_tasks.data JSON parse failed; …')`
- `src/services/workflowCentral/WorkflowCentralRepository.ts:69` — `logger.warn('workflow_central_instances.variables JSON parse failed; …')`
- `src/services/workflowCentral/WorkflowCentralRepository.ts:185` — `DatabaseService` `@inject`
- `src/services/workflowCentral/WorkflowCentralOperatorService.ts:76` — `DatabaseService` `@inject`
- (`WorkflowEngineService.ts:78,211,241` — workflow-DEFINITION `variables` array; these are step variable DECLARATIONS on the workflow template, not runtime customer data. Classified under metadata to keep them visibly out of scope for the Phase 1 rewrite — Phase 1 targets `WorkflowInstance.variables` and `task.data`, not `WorkflowDefinition.variables`.)

### `business-payload` — 11 hits (the surface Phase 1 moves)

Direct writes and reads of operator-visible business content into/out of `workflow_central_tasks.data` and `workflow_central_instances.variables`.

- `src/services/WorkflowCentralService.ts:485` — `args.variables ?? {}` (startInstance ingest)
- `src/services/WorkflowCentralService.ts:965` — `variables: instance.variables` (instance read path)
- `src/routes/workflowCentral.ts:146` — `if (req.body.variables !== undefined) updates.variables = req.body.variables;` (instance update route)
- `src/services/workflowCentral/WorkflowEngineService.ts:935` — `data: instance.variables` (engine writes instance variables onto the new task row at step transition)
- `src/services/workflowCentral/WorkflowCentralRepository.ts:105` — `variables: parseVariablesOrFallback(row.variables, logger)` (`rowToPersistedInstance`)
- `src/services/workflowCentral/WorkflowCentralRepository.ts:141` — `variables: parseVariablesOrFallback(row.variables, logger)` (`rowToWorkflowInstance`)
- `src/services/workflowCentral/WorkflowCentralRepository.ts:167` — `data: parseDataOrFallback(row.data, logger)` (`rowToPersistedTask`)
- `src/services/workflowCentral/WorkflowCentralRepository.ts:411` — `data: JSON.stringify(row.data ?? {})` (`insertTask` serialize)
- `src/services/workflowCentral/WorkflowCentralRepository.ts:462,471,472` — completion-data merge on UPDATE path (T9 `getTaskForOperator` ephemeral fallback continues to read this for legacy rows)
- `src/services/workflowCentral/WorkflowCentralRepository.ts:669` — `variables: JSON.stringify(row.variables)` (`insertInstance` serialize)
- `src/services/workflowCentral/WorkflowCentralOperatorService.ts:187,213` — `data: args.completion.data` (operator-supplied completion data flows onto the task row)

Phase 1 changes: each of these sites either (a) becomes a `payload` field round-trip via the new tagged-union contract (repository converters + `insertTask`/`insertInstance` paths — Task 8), or (b) goes through the resolver at render-time instead of being persisted (operator/route paths — Tasks 9 + 11). The transitional legacy-fallback shape is preserved via the `// LEGACY-COMPAT: payload-custody-gate` whitelist (Task 14b drift gate) until the Phase 1 follow-up PR (Task 19) drops the `data` and `variables` columns.

### `audit-detail` — 0 hits in current source

Cross-verified by `rg "safeAudit\(" src/services/workflowCentral/WorkflowCentralOperatorService.ts src/services/WorkflowCentralService.ts`: the audit-emit sites' `details` blocks today contain only structural keys (`completion_result`, `task_id`, `instance_id`, `workflow_id`, …) — see the existing proof card §"Comment + data NOT in audit log (D8 / R1 F-14)". This is good news: Phase 1's audit changes (Task 12) are about wrapping the new `task.payload` field with `redactWorkflowPayloadForAudit` if/when audit-emit sites start touching it, NOT about removing existing leaks.

### `demo-fixture` — undercount in the broad regex (caught by separate scan)

The original grep's `\.data` / `\.variables` regex matches property *access*, not object-literal *property declarations* — so the demo seeds with `variables: { … }` and `data: { … }` shape were undercounted. A targeted `rg -n "variables\s*:\s*\{|data\s*:\s*\{"` against `src/services/workflowCentral/WorkflowEngineService.ts` + `src/services/workflowCentral/demoSeed.ts` surfaces:

- `WorkflowEngineService.ts:807` — `variables: { poNumber: 'PO-2024-001', amount: 25000, vendor: 'Acme Supplies' }`
- `WorkflowEngineService.ts:833` — `variables: { employeeName: 'Bob Johnson', department: 'Engineering', startDate: '2025-02-01' }`
- `WorkflowEngineService.ts:851` — `variables: { invoiceNumber: 'INV-2024-500', amount: 15750, vendorId: 'VEND-001' }`
- `src/services/workflowCentral/demoSeed.ts` — three demo task rows seeded with `data: { poNumber, amount, vendor }` / `data: { employeeName, department, startDate }` / `data: { … invoice details … }` shape (lines ~91, ~110, ~125 — current head).

Phase 1 Task 13b migrates each of these to a `payload: { mode: 'external_reference', references: [{ system: 'netsuite', recordType, recordId, displayHint }] }` shape so the demo path stops looking like inline business payload on inspection.

### `test-setup` — 565 hits, the vast majority noise

Test files reference `DatabaseService.getDatabase()`, `dataSet.data.forEach`, `data_quality_score`, etc. — the broad regex matches all `.data*` properties, not just the workflow-central ones. The genuinely relevant test-side updates land alongside the source-side changes in Tasks 7-13 (each task's test file is updated in lockstep with the implementation). Test fixtures that today seed `data: { … }` or `variables: { … }` literally on task/instance rows get the same payload-shape migration as the demo seeds in Task 13b — captured as part of the task-by-task test updates, not enumerated separately here.

---

The inventory establishes the scope. None of the 11 business-payload sites are surprising; none required late-stage scope expansion in plan authoring; and the zero-hit audit-detail finding is what makes Task 12 cheap (wrap-on-write, no historical cleanup needed). Phase 1 can proceed against this inventory.
