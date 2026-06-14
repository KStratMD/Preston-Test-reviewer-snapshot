# Proof Card: WorkflowCentral Operator Service

**Status:** beta
**Last verified:** 2026-05-17 · main baseline `b8a438ae` (PR-OP-3 merge); PR-OP-3-followup (PR #805) on top adds the deferred T13.2-T13.6 integration tests + the `?status=active` multi-status filter + the `WorkflowInstanceMissingError` invariant-breach WARN. Stamp re-bumps when the followup PR merges.

## Claim

`WorkflowCentralOperatorService` promotes the WorkflowCentral task-completion workflow from in-memory `Map.set` mutation to a durable, audited, atomic state machine. Operators complete `workflow_central_tasks` rows via `POST /api/workflow-central/tasks/:id/complete`. completeTask is a **single-stage atomic transition** (`pending → completed`) — no two-stage lease, since `advanceWorkflow` (the cascade planner) has zero external writes. A six-step sequence enforces ordering: (1) pre-tx read for `not_found` / `already_dispositioned` / `invalid_action` disambiguation, (2) pure `engine.planCascade` returning a `CascadePlan`, (3) atomic `db.transaction(tx)` that UPDATEs parent `status='completed'` AND INSERTs all cascade child rows (rollback on any child failure → `cascade_failed`), (4) post-commit best-effort `engine.applyVolatileState` updating in-memory `instance.currentStepId` + `stepHistory` (try/catch surfaces `volatile_state_applied: false` without rolling back the DB), (5) `safeAudit` outside the transaction, (6) discriminated `CompleteTaskResult` return. Sibling operator actions `cancelInstance`, `delegateTask`, `startInstance` live on `WorkflowCentralService` (D9 split) and use the same `safeAudit` + DB-canonical-first ordering. Status is `beta` because production credentials + a Squire-side workflow load test are still pending.

## Source

- Operator service: `src/services/workflowCentral/WorkflowCentralOperatorService.ts:1-265`
- Engine service (definitions + instances + pure cascade planner): `src/services/workflowCentral/WorkflowEngineService.ts:1-728`
- Repository (11 methods, SELECT-then-UPDATE delegate, atomic cascade): `src/services/workflowCentral/WorkflowCentralRepository.ts:1-456`
- Shared types (CompleteTaskResult discriminated union, CascadePlan, PersistedTask, NewTaskRow, DelegateTaskResult): `src/services/workflowCentral/types.ts:1-81`
- Sibling writes (`startInstance` + `cancelInstance` + `delegateTask`): `src/services/WorkflowCentralService.ts:1-784`
- Routes: `src/routes/workflowCentral.ts` (HTTP status mapping for `/tasks/:id/complete`, tenant extraction across handlers)
- Schema migration: `src/database/migrations/041-create-workflow-central-tasks-table.ts` (table + 4 indexes, idempotent)
- DI wiring (all three new bindings + async WCS): `src/inversify/inversify.config.ts:1258-1295`
- Demo seed: `src/services/workflowCentral/demoSeed.ts` (NODE_ENV-gated; no-op under `test` / `production`)
- Composition root: `src/index.ts` (engine.seedDemoData + seedWorkflowCentralDemoTasks after DatabaseService init)
- Dependencies: `AuditLogRepository.create`, `DatabaseService.transaction`, `extractIdentityContext` (`src/services/governance/identityContext.ts`)

## Tests

- Unit (repo, atomic cascade + SELECT-then-UPDATE delegate + JSON boundary): `tests/unit/services/workflowCentral/WorkflowCentralRepository.test.ts` (37 tests; pins the R4 F-01 lock — `previousAssigneeId` is captured from the pre-update SELECT, NOT from `UPDATE ... RETURNING`)
- Unit (engine, pure planner + applyVolatileState + buildInitialTaskRow + deleteInstance Map.delete semantics): `tests/unit/services/workflowCentral/WorkflowEngineService.test.ts` (27 tests; pins R3 F-02 deleteInstance boolean, R3 F-05 priority CASE order, "planCascade is PURE" mutation guard)
- Unit (operator service, 6-step ordering + 4 failure modes + DLP key absence + race + identity propagation): `tests/unit/services/workflowCentral/WorkflowCentralOperatorService.test.ts` (41 tests; uses `mock.invocationCallOrder` to prove tx fires before audit)
- Unit (WCS, engine+repo composition + cancelInstance + delegateTask + startInstance + getMetrics aggregations): `tests/unit/services/__tests__/WorkflowCentralService.test.ts` (50 tests)
- Migration: `tests/unit/database/migrations/041-create-workflow-central-tasks-table.test.ts` (3 tests — schema columns, 4 indexes, idempotency)
- Integration (route-level, in-memory SQLite, full DI graph):
  - `tests/integration/workflowCentral-completeTask.test.ts` (12 tests)
  - `tests/integration/workflowCentral-cancelInstance.test.ts` (3 tests)
  - `tests/integration/workflowCentral-cancelInstance-engineFailure.test.ts` (1 test)
  - `tests/integration/workflowCentral-delegateTask.test.ts` (4 tests)
  - `tests/integration/workflowCentral-startInstance.test.ts` (5 tests)
  - `tests/integration/workflow-central-restart-recovery.test.ts` (7 tests — T-4 happy path + simulated restart + state recovery + completeTask post-restart + workflowDefinitionMissing post-restart + T-11 scale smoke + T-15 orphan-task defense)
  - `tests/integration/workflow-central-readiness-gate.test.ts` (existing T6 readiness-gate suite)
  - `tests/integration/workflow-central-backfill.test.ts` (16 tests — T-2/T-3 backfill source-of-truth + idempotency + T-13/T-13b/T-13c `unknown_recovered` lifecycle including the Codex-#3 most-recent-pending-task regression net + T-13c-guard array/integer/empty-string query-param rejection nets for the `?status=active` synthetic bucket route)
  - `tests/integration/workflow-central-cancellation-reason-dlp.test.ts` (4 tests — T-7 DLP carve-out: response redaction + audit-row absence + cache-side redaction + post-restart `null`)
  - `tests/integration/workflow-central-audit-key-backcompat.test.ts` (3 tests — T-8 `workflow_definition_missing` rename + repo-level legacy-row reader fallback)
  - `tests/integration/workflowCentral-pauseResume.test.ts` (9 tests — T-16..T-23 + T-19b D23 `waiting→paused→resume→waiting` regression net)
  - `tests/integration/postgres/workflow-central-concurrency.test.ts` (4 tests, Postgres-gated — T-5 AB-BA deadlock + T-6 sibling-task concurrency + SELECT FOR UPDATE serialization + pg_locks snapshot)
  - `tests/integration/workflow-central-hydration-scale.test.ts` (1 test, env-gated by `WORKFLOW_CENTRAL_RUN_SCALE_TEST=1` — T-24 100k-row hydration RSS budget)

  Pins HTTP status mapping per spec D5; R3 F-11 / F-03 DB-canonical-first when engine throws; R6 F-01 cross-tenant 404 on delegate; F-05 cascade cancel propagation; trust-internal-data row (comment + data on task row, NOT in audit details); T-15 invariant-breach `logger.warn` ↔ structured failure audit row pair.

## Live vs Fixture

- Real HTTP wired? **No external connector** — completeTask is local-only (advanceWorkflow is in-memory). The cascade INSERTs happen entirely in `workflow_central_tasks`; no ERP write boundary, hence no `connector_unavailable` or `write_failed` codes in `CompleteTaskResult` (unlike FCO).
- DB persistence wired? **Yes** — migration 041 creates `workflow_central_tasks` + 4 indexes on first `DatabaseService.initialize()`; all reads/writes go through `WorkflowCentralRepository`. Atomic `UPDATE WHERE status='pending'` + cascade INSERTs in a single `db.transaction(tx)`. No Map state remains for tasks in production code (engine still owns volatile definitions + instances per D2 lock).
- Demo-mode toggle? **N/A** at the operator surface — `demoSeed.ts` is gated on `NODE_ENV` (returns no-op under `test`/`production`). There is no demo branch inside the operator service itself.
- Production credential test on file? **No** · Status remains `beta`. Promotion to `production` requires (a) a Squire-side workflow load test exercising rapid concurrent completes against `workflow_central_tasks`, and (b) the per-tenant PR 2C-Auth identity propagation so `extractIdentityContext` returns a real tenant instead of falling back to `SYSTEM_IDENTITY`.

## Known Gaps

- **(CLOSED in PR-OP-3) Volatile instance state — D2 wedge**: previously `WorkflowEngineService.instances` was a Map that reset on restart. PR-OP-3 makes instance rows durable in `workflow_central_instances` with eager `engine.hydrate(repo)` on boot. The `workflow_context_missing` audit flag was renamed to `workflow_definition_missing` (D7 + spec §3.2) and now indicates only that a workflow DEFINITION isn't registered (definitions remain volatile until a future PR — see "Updates in PR-OP-3" / Known Gaps below).
- **Comment + data NOT in audit log (D8 / R1 F-14)**: `completion.comment` and `completion.data` are persisted on the task row (`completion_comment` / `data` columns — trust-internal-data policy) but are **omitted** from `audit_logs.details`. The audit row contains only structural keys. Inherited from FCO precedent — DLP-sensitive operator input doesn't appear in long-retention audit records but IS readable through the task-row read path with normal tenant scoping.
- **`Date.now()` task ID collision risk (Q7)**: `engine.buildTaskRowForStep` uses `TASK-${Date.now()}-${idSeq}` for task IDs. The `idSeq` counter bounds in-process collisions, but cross-restart collisions remain theoretically possible if two engine instances generate IDs within the same millisecond AND `idSeq` resets. UUIDv7 migration deferred to a future spec — Squire-side workflow load tests will determine whether the gap matters in practice.
- **`cancelled_task_ids[]` capped at 100 (D7 / R4 F-08)**: Audit details for `cancel_instance` cap the cancelled-IDs array at 100 entries to bound audit-row size. The `cancelled_task_count` field reports the FULL count (forensics + dashboard metric). Practical fan-out limit observed in existing demo workflows is well under 100, but a future workflow with 100+ pending tasks per instance would lose tail IDs from the audit. Ordering is `created_at ASC, id ASC` for deterministic truncation across DBs (R5 F-05 lock).
- **No-task instances are valid runtime state (R4 F-03)**: `engine.buildInitialTaskRow` returns `null` when the first step is missing OR not type `'task'` / `'approval'`. `startInstance` continues without inserting a task row; the audit records `initial_task_id: null` + `task_insert_succeeded: true`. The instance exists in the engine but has no DB-backed task — valid for workflows that begin with `'notification'` / `'condition'` / `'integration'` steps. Dashboards rendering "my tasks" should not assume every instance has at least one task row.
- **OperatorRepository<T> base extraction deferred (D9 / R1 F-09)**: `WorkflowCentralRepository` duplicates the SyncErrorAssist + FC operator-slice shape rather than extending a generic `OperatorRepository<T>` base. PR-OP-2b extracts the base AFTER all three concrete implementations stabilize. Today's duplication is the explicit cost of keeping this PR's review surface manageable.
- **Role/group assignee mis-keying (Copilot R7 SHOULD-FIX — TODO'd in source)**: `WorkflowEngineService.buildTaskRowForStep` writes `step.config.assigneeValue` into both `assignee_id` and `assignee_name`, but `assigneeType` may be `'role'` or `'group'` (e.g. `assigneeValue='manager'`, `'finance-team'`). For role/group-targeted tasks the row's `assignee_id` is a role/group label, NOT a user id; `listByAssignee(tenantId, userId)` (used by the dashboard "myTasks" path) will miss every such row unless `userId === <role-name>` literally. The previous in-memory implementation had the same shape; persisting it durably mis-keys role-targeted tasks. **PR-OP-5 follow-up**: introduce a role/group resolver (governance-side, per-tenant) that expands `assigneeType='role'/'group'` into one-or-many user IDs before insert. Tracked inline as a TODO comment in `WorkflowEngineService.buildTaskRowForStep` (lines 735-744) so future readers see the gap at the code site.
- **Body-actor pre-auth pass-through (Kimi R1 / Codex BLOCKS-MERGE — mitigated)**: all four operator routes (`startInstance`, `cancelInstance`, `completeTask`, `delegateTask`) now apply the FinanceCentral PR #787 R4/R5 override pattern (BM-1 R-fix). When `extractIdentityContext(req)` returns non-`SYSTEM_IDENTITY` (i.e., post-PR 2C-Auth), the authenticated `ctxUserId` is recorded as the audit actor and any body-supplied actor field is silently ignored. The body actor is honored ONLY in the documented pre-auth demo path (the current state, since `extractIdentityContext` falls back to `SYSTEM_IDENTITY` on every unauthenticated WC route today). After PR 2C-Auth mounts verified auth on `/api/workflow-central/**`, the audit-spoof vector closes automatically — no further route changes needed. PR-OP-5 (HITL operator UI) builds on this hardening but isn't a prerequisite for the spoof guard.

## Reference-Based Payload (Phase 1, ADR-019)

**Status:** `beta` (alongside the existing completeTask claim — promotion to `production` requires the Phase 1 §Rollout dual-write window to close + backfill verified in production for ≥2 weeks).

### Claim

`WorkflowCentralOperatorService.getTaskForOperator(tenantId, taskId)` returns a discriminated `TaskRenderModel` over three payload modes — `resolved` (refs into client ERP fetched live via `ConnectorManager.getConnector` + `BaseConnector.read(entityType, id)` with a 30s `WorkflowPayloadCache`), `ephemeral` (gated `expiresAt`-bounded inline data), `legacy` (pre-backfill fallback exposing `task.data`). Per-ref connector failures NEVER bubble to whole-render HTTP status — they're carried inside the 200-response `resolution[i].error` per the partial-success contract (load-bearing for cross-system compose). Whole-render conditions map at route-level: 404 NotFound, 410 EphemeralPayloadExpired, 403 EphemeralPayloadNotAllowed, 400 invalid `:id` shape. Audit emits via `redactWorkflowPayloadForAudit` — `references` and `evaluationHints` pass through; `ephemeral.data` is ALWAYS dropped before serialization.

### Source

- Contract + validators + audit redaction: `src/services/workflowCentral/payload/WorkflowPayload.ts`
- Typed errors (7 classes): `src/services/workflowCentral/payload/errors.ts`
- Resolver + partial-success outcome shape: `src/services/workflowCentral/payload/WorkflowPayloadResolver.ts`
- Short-TTL cache: `src/services/workflowCentral/payload/WorkflowPayloadCache.ts`
- Repository round-trip (rowToPersistedTask/Instance + insertTask/Instance): `src/services/workflowCentral/WorkflowCentralRepository.ts:151,193,393,653`
- Operator render method + audit emit: `src/services/workflowCentral/WorkflowCentralOperatorService.ts` (`getTaskForOperator` + `baseRenderAudit`)
- Route: `src/routes/workflowCentral.ts` (`GET /api/workflow-central/tasks/:id/render` + extended error mapper)
- DI bindings: `src/inversify/inversify.config.ts` (`WorkflowPayloadCache` + `WorkflowPayloadResolver` singletons)
- Migration 043: `src/database/migrations/043-add-workflow-central-payload-column.ts` (adds `payload TEXT` to both tables; dialect-branched; idempotent on replay)
- Demo seeds (refs + displayHints): `src/services/workflowCentral/demoSeed.ts` (3 tasks) + `src/services/workflowCentral/WorkflowEngineService.ts` (3 instances)

### Tests

- Unit (contract validators + redaction): `tests/unit/services/workflowCentral/payload/WorkflowPayload.test.ts` (38 tests)
- Unit (typed errors): `tests/unit/services/workflowCentral/payload/errors.test.ts` (10 tests)
- Unit (resolver — happy + error paths + DLP fail-closed + partial-success + cache integration): `tests/unit/services/workflowCentral/payload/WorkflowPayloadResolver.test.ts` (23 tests)
- Unit (cache — TTL + key isolation + env overrides + FIFO eviction): `tests/unit/services/workflowCentral/payload/WorkflowPayloadCache.test.ts` (14 tests)
- Unit (migration 043 — both tables, idempotency, legacy preserved): `tests/unit/database/migrations/043-add-workflow-central-payload-column.test.ts` (6 tests)
- Unit (repo payload round-trip — refs / ephemeral / legacy fallback / malformed / wrong-shape): `tests/unit/services/workflowCentral/WorkflowCentralRepository.test.ts` (T8 block, 7 tests)
- Unit (operator getTaskForOperator + audit redaction): `tests/unit/services/workflowCentral/WorkflowCentralOperatorService.test.ts` (T9 + T12 blocks, 11 tests)

Total: ~109 Phase-1 tests + 209 pre-existing workflowCentral suites all passing.

### Live vs Fixture

- **Render path is live**: production reads call the real `ConnectorManager.getConnector` → `BaseConnector.read`. The resolver's `DLPService.scanForPII` is the existing production DLP service (not a mock). Cache is in-process (no Redis).
- **Demo path** stays NODE_ENV-gated via the existing `demoSeed.ts` env check; the demo refs use `displayHint` so the demo UI renders even when the resolver mock returns null.
- **Integration tests for the route path** deferred to a future PR (Phase 1 follow-up T17) — the unit tests in WorkflowCentralOperatorService.test.ts cover the operator's getTaskForOperator method end-to-end via mocked resolver + repo.

### Known Gaps (Phase 1)

- **Cross-workflow search on payload content** is no longer possible from Squire's DB alone — the reference-based model means business content lives in the ERP, not Squire. Open Question Q3 in the plan tracks this; documented architectural trade-off. Future options: search-index sidecar or denormalized "search hints" column (out of Phase 1 scope).
- **Operator render latency** now includes one ERP API round-trip per uncached ref (mitigated by 30s `WorkflowPayloadCache`). Open Question Q1 sets a strawman 500ms p99 steady-state / 2s p99 cold-cache latency budget.
- **NetSuite per-tenant governance API quotas** could be exhausted by render bursts. Mitigated by cache + the existing Governance Pacer (CLAUDE.md "Production-Ready Features"). Open Question Q5.
- **Phase 1 follow-up (migration 044, Task 19) drops `data` + `variables` columns** after Phase 1 runs in production ≥2 weeks with backfill verified. Until then, the repository's transitional legacy-fallback path reads `data` / `variables` when `payload` is null (covers pre-backfill rows).
- **DLP-block policy (451 + `PAYLOAD_REF_DLP_BLOCKED`)** is a Tier-2 follow-up — Phase 1 is redact-and-continue (matches MCPAggregatorService outbound pattern). The resolver's `PAYLOAD_REF_DLP_SCAN_FAILED` outcome (500) is a fail-closed branch for internal DLP errors, NOT a blocking-policy violation.
- **Backfill script not yet shipped** — production rollout (per plan §Rollout sequencing) needs the resumable backfill script (Task 13). Demo + new-instance paths use the new model from the start; pre-existing rows continue via legacy fallback until Task 13 + 19 sequence completes.

### 60-second verification

```bash
# Validators + audit redaction
npm test -- --testPathPatterns="payload/WorkflowPayload.test.ts$"

# Resolver + cache
npm test -- --testPathPatterns="payload/(WorkflowPayloadResolver|WorkflowPayloadCache).test.ts$"

# Migration 043 + repo round-trip
npm test -- --testPathPatterns="(043-add-workflow|WorkflowCentralRepository)"

# Operator render + audit redaction
npm test -- --testPathPatterns="WorkflowCentralOperatorService"

# Confirm audit details NEVER carry resolved field values or ephemeral data
grep -nE "redactWorkflowPayloadForAudit" src/services/workflowCentral/WorkflowCentralOperatorService.ts
# Expect every audit-emit site that touches task.payload to invoke this helper
```

The fourth grep should show the helper called in every audit-emit branch of `getTaskForOperator` — the load-bearing invariant that no payload values reach the audit row.

Plan: [`docs/plans/2026-05-17-governance-without-hosting-data-plan.md`](../../plans/2026-05-17-governance-without-hosting-data-plan.md)
ADR: [`docs/adr/ADR-019-workflow-governance-without-hosted-data.md`](../../adr/ADR-019-workflow-governance-without-hosted-data.md)

## Updates in PR-OP-3 (instance durability)

- `workflow_central_instances` table added (migration 042). Hybrid DB-canonical state + Map cache; `cancellationReason` is the one Map-only carve-out (D8 / DLP).
- `workflowContextMissing` → `workflowDefinitionMissing` rename across types, audit-write keys, and CascadePlan field. Audit query callers handle both keys for backward-compat (D7) during transition.
- Backfill on migration synthesizes instance rows from existing tasks with `status='unknown_recovered'`. Source-of-truth rule: most-recent-pending task wins per `(tenant_id, instance_id)` group (D19). `started_at` = `MIN(created_at)` of the group; `current_step_id`/`step_name` from the most-recent-pending task. Race-safe via `INSERT OR IGNORE` (SQLite) / `ON CONFLICT (id) DO NOTHING` (Postgres, targets the PK — D20). PR-OP-3-followup added the route-side `?status=active` synthetic bucket (`running | waiting | unknown_recovered`) so the operator UI's active filter actually surfaces backfilled rows.
- `pauseInstance` + `resumeInstance` migrated to TX-backed durability with the `paused_from_status` column preserving pre-pause state (D23). Resume restores the prior status, not a hardcoded `'running'`.
- `cancelInstance` runs single TX (selectInstanceForUpdate → updateInstanceForTenant → cancelPendingForInstance) + DLP-redacted `cancellationReason` echoed in the response. Reason intentionally omitted from audit details (D8 DLP carve-out). DLP failure is fail-closed: a placeholder string substitutes for the reason if `DLPService.scanText` throws or yields findings without `redactedData`.
- `completeTask` adopts instance-first lock order (selectTaskInstanceId → selectInstanceForUpdate) per D21 + spec §3.2 to prevent AB-BA deadlocks. Paused instances reject with `InstancePausedError` → 409 (D21). `CascadePlan → InstancePatch` translation runs inline in the operator service (no `engine.applyToInstance`, D11). `RaceLostError` from the task-CAS path is translated to `AlreadyDispositionedError` at the operator boundary (D25); `WorkflowInstanceMissingError` is reserved for instance-row defenses after a held lock (invariant breach → 500 + WARN).
- Audit delivery is best-effort; failures surfaced via `workflow_central_audit_delivery_failures_total{action,outcome}` counter (D15).
- Engine-cache writes now go through `refreshCacheFromCommit` (D9) after every TX commit. Age-gated to the hydration window — terminal rows that age out are evicted on next write. `getInstanceFromAnywhere` (D24) provides non-locking DB fallback for cache-miss reads outside mutating transactions.
- Boot order (`src/index.ts` `Server.start`): `repo.catchUpBackfill()` then `engine.hydrate(repo)` after demo seed and before serving requests. T6 readiness gate (`workflowCentralReadyGate`) returns 503 on workflow-central routes until `engine.hydrationReady` flips true.
- `getInstances`, `getMetrics`, `getDashboard.recentInstances` re-pointed at DB-canonical reads via `repo.listInstances` / `repo.computeMetrics`. `getMetrics` merges three sources: instance fields from `repo.computeMetrics(WorkflowInstanceMetrics)`, definition counts from the still-volatile `engine.getDefinitions`, task counts from existing PR-OP-2 repo methods.

### Known gaps (carried + new)

(Pre-existing PR-OP-2 gaps unchanged; new in PR-OP-3:)

- **`unknown_recovered` instances have best-effort `currentStepId`**: backfilled from the most-recent-pending task per (tenant, instance). If a workflow definition's step ordering changed between the original task creation and the backfill, the recovered `currentStepId` may not align with the live definition — `completeTask` will then return `workflowDefinitionMissing` until the workflow is re-registered.
- **Activity logs durability** shipped in PR-OP-3b (migration 044 + tee'd inserts off the six audit-emitting verbs + tenant-scoped read API). The dashboard `recentActivity` field and the `GET /activity` route now return DB-canonical rows scoped to the caller's tenant. Rich operator-side filters (per-user, per-action, time-range, pagination cursors) deferred to PR-OP-3b-followup.
- **Workflow definitions remain in-memory** until a separate future PR. The Map is rebuilt by `engine.seedDemoDefinitions()` on every boot in non-production environments. `getMetrics.totalWorkflows` / `activeWorkflows` reflect this volatile state.
- **`paused_from_status` not surfaced on `WorkflowInstance`**: the public `WorkflowInstance` shape (the cache value) intentionally omits `pausedFromStatus`. Resume reads the prior status via `repo.selectInstanceForUpdate` inside the TX, not from the cache. This is per D23 (durable-only field).
- **T-23 paused_duration_ms NOT emitted**: `resumeInstance`'s audit row carries `previous_status` + `resumed_to_status`, but not `paused_duration_ms` — migration 042 has no `paused_at` column, so duration is not derivable today. Adding it requires a schema migration + service-layer timestamp capture, deferred to a future PR. The T-23 integration test asserts the fields the service actually emits.
- **`paused_at` column missing**: see above. The hint-of-duration on the engine-cache side is also absent (`WorkflowInstance` intentionally omits `pausedFromStatus` per D23 — durable-only field).

## Verification (60-second AI-reviewer recipe)

```bash
# Unit tests for all three new services + migration. Codex R2 SHOULD-FIX:
# uses `npm test` so the project's jest config + TypeScript transform are
# loaded (raw `npx jest --runTestsByPath` fails on `import type` because
# no transform config is picked up). Jest 30 uses `--testPathPatterns`
# (plural) at the CLI.
npm test -- --testPathPatterns="workflowCentral|041-create-workflow-central"

# Route-level integration (in-memory SQLite + full DI graph)
npm run test:integration -- --testPathPatterns="workflowCentral-"

# Confirm SELECT-then-UPDATE (NOT UPDATE...RETURNING) on delegate path (R4 F-01 lock)
grep -nE "\.returning\(\[.*assignee" src/services/workflowCentral/WorkflowCentralRepository.ts \
  && echo "REGRESSION — RETURNING clause present, post-update value bug reintroduced" \
  || echo "OK — no UPDATE...RETURNING on assignee_id"

# Confirm 6-step ordering + audit OUTSIDE tx
grep -nE "db\.transaction|safeAudit|applyVolatileState" \
  src/services/workflowCentral/WorkflowCentralOperatorService.ts | head -15

# Confirm DLP key absence in audit details (no comment / data / completion_comment keys)
grep -nE "'comment'|'data'|completion_comment" src/services/workflowCentral/WorkflowCentralOperatorService.ts \
  | grep -v '// ' || echo "OK — no DLP-sensitive keys in audit-details builder"
```

The first grep proves `delegatePendingTask` does NOT use `UPDATE ... RETURNING assignee_id` — Codex experimentally verified that pattern returns the POST-update value on Kysely 0.28.17 + better-sqlite3. The implementation uses SELECT-then-UPDATE inside the same tx, capturing `previousAssigneeId` from the pre-update SELECT row.

The second grep should show `db.transaction(...)` opening BEFORE `applyVolatileState` calls AND BEFORE every `safeAudit` call site — the audit ALWAYS fires after the tx settles (whether commit or rollback) per spec R1 F-01.

The third grep should produce zero matches outside of comments — the audit-details builder only includes structural fields (`task_id`, `instance_id`, `workflow_id`, etc.) per spec R1 F-14 / R2 F-08. Sensitive content lives on the task row's `completion_comment` / `data` columns only.
