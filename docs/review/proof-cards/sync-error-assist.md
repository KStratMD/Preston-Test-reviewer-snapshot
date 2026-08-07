# Proof Card: Sync Error AI Assist

**Status:** beta
**Last verified:** 2026-05-12 · git sha `cbad5ec6` (watermark-race recovery follow-up)

## Claim

A NetSuite-side User Event SuiteScript POSTs sync-error records to `/api/sync-error-assist/ingest` with HMAC-signed payload; the server returns `202 Accepted` after the synchronous claim row insert, then runs the AI suggestion pipeline in a `setImmediate` fire-and-forget worker. The 30-minute polling reconcile continues to run alongside (PR 17a path) as a back-stop for missed webhooks. Per-tenant opt-in via `tenant_configurations.sync_error_assist.enabled='true'` AND `sync_error_assist.webhook_enabled='true'`. PR 17a shipped data + service core; PR 17b shipped operator review UI; PR 17c wires the real-time webhook ingest.

## Source

- Implementation: `src/services/syncErrorAssist/SyncErrorAssistService.ts:1-900`
- HMAC verifier: `src/middleware/syncErrorAssistWebhook.ts`
- Wire-payload schema: `src/routes/syncErrorAssistWebhookSchema.ts` (Zod, depth ≤ 6, ≤ 32KB sourcePayload)
- Webhook ingest route: `src/routes/syncErrorAssistRoutes.ts:ingest`
- Middleware mount (IP limiter + express.raw): `src/middleware/setup/MiddlewareSetup.ts`
- Entry point (polling reconcile): `src/services/syncErrorAssist/SyncErrorAssistDailyJob.ts:17` (`start()`)
- Dependencies: `ProviderRegistry.getAvailableProvider`, `ConnectorManager.getConnector('netsuite', ...)`, `ReasoningTraceEngine`, `CostTrackingService.recordCost`, `AuditLogRepository.create`, `DLPService.scanText`
- Operator runbook: `docs/operations/SYNC-ERROR-ASSIST-WEBHOOK-SUITESCRIPT.md`

## Tests

- Unit: `tests/unit/services/syncErrorAssist/*.test.ts` + `tests/unit/middleware/syncErrorAssistWebhook.test.ts` + `tests/unit/routes/syncErrorAssistWebhookSchema.test.ts` + `tests/unit/routes/syncErrorAssistIngestRoute.test.ts` (~155 tests covering PR 17a + 17b + 17c surfaces)
- Integration: `tests/integration/syncErrorAssist.fixture.test.ts` (10 scenarios + 5 cross-cutting) + `tests/integration/syncErrorAssistMiddleware.integration.test.ts` (4 middleware-contract tests) + `tests/integration/syncErrorAssistWebhook.integration.test.ts` (15 end-to-end scenarios covering AC #1-9 + #17)
- Coverage: ≥85% lines / ≥80% branches per file (DailyJob ≥60/≥50% per cron-harness precedent); `syncErrorAssistWebhook.ts` and `syncErrorAssistWebhookSchema.ts` added to `.core-coverage-budget.json`

## Live vs Fixture

- Real HTTP wired? **Yes** — webhook ingest path is wired through `src/routes/syncErrorAssistRoutes.ts` + the `MiddlewareSetup` IP limiter + `express.raw({type:'application/json', limit:'256kb'})` mount; in production NetSuite SuiteScript signs and POSTs to the live endpoint. The fixture suite (`syncErrorAssist.fixture.test.ts`) still mocks `ConnectorManager.getConnector` and `provider.chat` for the polling path; the webhook integration suite uses the same stubbing strategy to keep CI hermetic.
- Webhook ingest wired (PR 17c)? **Yes** — HMAC-authenticated `POST /api/sync-error-assist/ingest` returns 202 + `setImmediate` worker dispatches `service.processClaimedRecord(...)`; replay/forged-tenant/disabled/oversize/rate-limit branches all return spec-mandated status codes verified end-to-end in `syncErrorAssistWebhook.integration.test.ts`.
- Demo-mode toggle? **N/A** · this service requires a real provider via `ProviderRegistry.getAvailableProvider()` to start any per-tenant work; if no provider is configured, `runAllEnabledTenants` returns `[]`.
- Production credential test on file? **No** · Status remains `beta` — pilot deployment with real NetSuite + Claude credentials + a real SuiteScript afterSubmit deployment is the next milestone.

## Known Gaps

- The 10-scenario fixture corpus is **Claude-drafted, not Squire-empirical**. The pilot's ≥50% accept-rate target measures the AI on real Squire data; the fixture is shape-correctness, not realism.
- `BaseConnector.validateOutboundWrite()` still uses `SYSTEM_IDENTITY` for connector audit (PR 2C-Auth gap). PR 17a compensates with a tenant-attributed local `audit_logs` entry adjacent to each NetSuite write.
- `tenant_configurations.is_encrypted=true` rows return null (no decryption path is wired in repo). Policy established by PR 17a.
- Single-secret rotation has a brief delivery gap (gotcha #29) — webhooks signed mid-rotation return 401 and are dropped; the 30-min polling reconcile catches them. Dual-secret rotation is a future hardening PR.
- IPv6 /64-prefix masking on the pre-auth IP limiter is **deferred** (R19-2): `express-rate-limit` 7.5.1 has no `ipKeyGenerator` export; the default `req.ip` key is what's wired today. Major bump to v8 owed by a follow-up PR.
- The atomic `tryAdvanceWatermark` UPSERT closes the prior two-statement race in SQLite (writes are fully serialized) and in Postgres at the conflict-resolution lock. The CONFLICT-WHERE clause additionally enforces **monotonicity** (`excluded.last_modified_at > sync_error_assist_runs.last_modified_at`) so a backward or equal candidate is held — the method's name and contract promise *advance*, never regress. A residual narrow race remains in Postgres READ COMMITTED for an uncommitted concurrent webhook insert during the INSERT-from-SELECT gate evaluation, **and that race is now backstopped** by the post-PR-17c watermark-recovery sweep: `reapStuckProcessing` (60-min `reserved_at` cutoff, `SyncErrorAssistService.REAPER_CUTOFF_MS = 60 * 60_000`) demotes the stalled `processing` row to `failed_retryable` AND then calls `recoverWatermarkAfterReap(tenantId)` which ratchets the run watermark back to `MIN(error_last_modified_at) − 1ms` across surviving `failed_retryable` rows (conditional UPDATE: only ratchets backward, never forward — the forward decision still belongs exclusively to `tryAdvanceWatermark`). On the next polling cycle the row is re-fetched via the `> watermark` filter and reprocessed via `claim()`'s `failed_retryable` retry branch. Schema migration `038-add-sync-error-assist-processed-error-last-modified.ts` adds the `error_last_modified_at` column populated at `claim()` time (snapshotted from the polling-record or webhook `lastModified`); a partial index `(tenant_id) WHERE status='failed_retryable' AND error_last_modified_at IS NOT NULL` keeps the MIN-aggregate query O(1) per tenant. Pre-migration legacy rows have `error_last_modified_at IS NULL` and don't contribute to the MIN; their recovery still depends on webhook re-delivery or a future operator-surface query that includes `failed_retryable`.

## Verification (60-second AI-reviewer recipe)

```bash
# Unit + integration tests (PR 17a + 17b + 17c)
npx jest tests/unit/services/syncErrorAssist tests/unit/middleware/syncErrorAssistWebhook.test.ts tests/unit/routes/syncErrorAssistWebhookSchema.test.ts tests/unit/routes/syncErrorAssistIngestRoute.test.ts tests/integration/syncErrorAssist.fixture.test.ts tests/integration/syncErrorAssistMiddleware.integration.test.ts tests/integration/syncErrorAssistWebhook.integration.test.ts

# Sanity check — confirm the per-record timeout is wired
grep -n "PER_RECORD_TIMEOUT_MS\|withTimeout" src/services/syncErrorAssist/SyncErrorAssistService.ts

# Confirm OCC guard on update methods
grep -n "where('status', '=', 'processing')" src/services/syncErrorAssist/SyncErrorAssistRepository.ts

# Confirm webhook HMAC verifier is constant-time
grep -n "timingSafeEqual" src/middleware/syncErrorAssistWebhook.ts

# Confirm atomic watermark gate (single-statement INSERT-with-NOT-EXISTS-and-CONFLICT-WHERE)
grep -n "tryAdvanceWatermark" src/services/syncErrorAssist/SyncErrorAssistRepository.ts
```
