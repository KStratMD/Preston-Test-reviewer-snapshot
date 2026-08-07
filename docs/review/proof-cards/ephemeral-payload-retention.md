# Proof Card: Ephemeral-Payload Retention Reaper

**Status:** production
**Last verified:** 2026-05-20 against the PR #829 review head at the time of stamping. The card describes the implementation contract; specific commit SHAs are re-stamped on merge by the `update-docs` workflow rather than per R-round to avoid churn on intermediate review heads (matches the `flow-templates.md` convention).

## Claim

A scheduled job (`WorkflowPayloadRetentionJob`) sweeps the `workflow_central_tasks` and `workflow_central_instances` tables every hour, NULLing the `payload` column on rows whose `payload.mode === 'ephemeral_hosted'` AND `payload.expiresAt < now`. Pairs with the lazy-expiry path in `WorkflowCentralOperatorService` (which returns 410 on read when an ephemeral payload is past its expiresAt): the lazy path stops serving stale data; this proactive sweep stops it sitting on disk indefinitely after the last read. Closes the "lazy-expiry → bounded sweep" follow-up named in CLAUDE.md ("**WorkflowCentral governance without hosting data**" section) and addresses Kerry's May-2026 Engineering ToDo item C1.

## Source

- Scheduled job: `src/services/workflowCentral/WorkflowPayloadRetentionJob.ts` (mirrors `EmbeddedRetentionJob` shape — canonical Tier-B scheduled-service pattern)
- Repository method: `src/services/workflowCentral/WorkflowCentralRepository.ts:clearExpiredEphemeralPayloads` + private helper `clearExpiredEphemeralOnTable` + free function `isExpiredEphemeralPayload`
- DI wiring: `src/inversify/types.ts:TYPES.WorkflowPayloadRetentionJob` + `src/inversify/inversify.config.ts` (toDynamicValue async since `WorkflowCentralRepository` is async-bound)
- Server start/stop: `src/index.ts` — start in `Server.start()` after `SyncErrorAssistDailyJob`; stop in `Server.stop()` before HTTP close so an in-flight sweep is not cut mid-UPDATE
- ADR: `docs/adr/ADR-019-workflow-governance-without-hosted-data.md` (governance-without-hosting-data Phase 1 — establishes the `ephemeral_hosted` tag and the lazy-expiry contract this job complements)

## Tests

- Unit (job): `tests/unit/services/workflowCentral/WorkflowPayloadRetentionJob.test.ts` (14 tests — covers start/stop idempotency including observable double-start protection, inflight overlap-skip, error isolation, 3-arg Logger.error shape for both Error and non-Error rejections, interval-driven tick(), in-flight stop draining, isRunning state)
- Unit (repository): `tests/unit/services/workflowCentral/WorkflowCentralRepository.test.ts` `describe('clearExpiredEphemeralPayloads')` (21 tests — covers: empty DB, null payload, external_reference preserved (canonical `WorkflowExternalRecordReference` shape), future-expiresAt preserved, past-expiresAt cleared on tasks AND instances, mixed-row count accuracy, malformed JSON / missing-mode / missing-reason / missing-expiresAt / non-parseable-expiresAt defensive-preserve, boundary-equal-to-now strict-less-than, per-table error isolation (both Error and non-Error throws), UPDATE chunking (550-row sweep iterates twice), WHERE-payload-IS-NOT-NULL race guard, Codex P1 legacy-data leak regression on both tables, Codex P2 LIKE pre-filter correctness including a false-positive substring-collision case)
- Integration: `none — sqlite in-memory in the unit suite exercises the full SQL contract end-to-end (insert → sweep → assert column state). A postgres-gated integration would only re-prove the same SQL on a different dialect.`
- Coverage: see `.core-coverage-budget.json` — `WorkflowPayloadRetentionJob.ts` and the new repository method are both in scope of the core profile.

## Live vs Fixture

- Real DB wired? **Yes** · evidence: `src/services/workflowCentral/WorkflowCentralRepository.ts:clearExpiredEphemeralPayloads` issues Kysely `selectFrom` + `updateTable` against the live `DatabaseService` connection (no mock layer)
- Demo-mode toggle? **No** · the reaper runs the same way regardless of `isDemoMode()` — there is no environment branching. Demo-mode tenants either have no ephemeral rows (in which case the sweep is a no-op) or they do (in which case the sweep correctly clears them).
- Production credential test on file? **N/A** · component is internal (no outbound credentials). Production assurance comes from the same-process unit tests against a real SQLite DB.

## Known Gaps

- **Sweep is best-effort, not transactional.** The two per-table UPDATEs run sequentially inside independent try/catch blocks (Copilot R1 finding). A failure between them leaves a partial sweep, which the next hourly tick simply finishes. The per-table catch ensures one-table failures do not block the other table from running. Both UPDATEs are idempotent (NULLing an already-NULL column is a no-op via the `WHERE payload IS NOT NULL` race guard).
- **UPDATE statements are chunked at 500 ids per batch** to stay below SQLite's default 999-parameter limit (Postgres tolerates ~64k). A tenant with >500 expired ephemeral rows per tick will see multiple UPDATEs back-to-back; if volume grows enough that this becomes visible in tail latency, future work is a paged SELECT + cursor-based deletion.
- **SELECT pre-filter is `payload LIKE '%"ephemeral_hosted"%'`** to avoid JSON-parsing every non-null payload row in the application. This is a portable cross-DB filter (SQLite + Postgres both support LIKE). It is an **application-side** optimization (network round-trip + Node-side JSON.parse); without an index on `payload LIKE ...` the DB still evaluates the predicate across all non-null payload rows at the storage layer. False positives (e.g., an `external_reference` payload whose `evaluationHints.note` text contains the substring) are correctly rejected by `isEphemeralWorkflowPayload` in Node. Future enhancement: a partial index on `payload LIKE '%ephemeral_hosted%'` (Postgres) or a generated column would let storage-layer skip kick in on tables with millions of rows.
- **Legacy `data` / `variables` columns are also reset to `{}` when sweeping** (Codex P1 finding on R1). The `WorkflowCentralOperatorService` legacy-fallback branch reads `task.data` when payload is NULL — without this reset, an expired ephemeral row whose mirrored legacy data was still populated would be renderable as `kind='legacy'` AFTER the sweep, undercutting the entire data-liability contract. Two regression tests pin this contract (tasks AND instances).
- **No tenant-level rate limit.** Ephemeral rows are gated behind the `WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD` env flag + tenant opt-in (currently Phase-1-incomplete per CLAUDE.md), so the population is small. If volume becomes a concern, batched/paged SELECTs are a future enhancement.
- **No metrics emitted.** The job logs `tick complete` with cleared counts to the application logger but does not increment a Prometheus/OpenTelemetry counter. A future PR can route through `WorkflowCentralMetrics` once the ephemeral population justifies a dashboard.
- **No multi-replica leader election.** Mirrors `EmbeddedRetentionJob` — `setInterval` on each replica is fine because the UPDATE-by-id query is idempotent. Two replicas racing on the same row collapse to a single net effect (the row's `payload` is NULL after both runs). Wasteful but correct.
- **Boundary is strict less-than (`expiresAt < now`).** A row whose `expiresAt` equals the current sweep timestamp to the millisecond is NOT cleared on that tick. It will be cleared on the next tick. Acceptable for an hourly cadence.
- **Read-time semantics change across the sweep boundary.** Pre-sweep, an expired ephemeral row returns HTTP 410 (`EphemeralPayloadExpiredError`). Post-sweep, the same row's payload is NULL and the operator's read falls through to the legacy-fallback branch — returning HTTP 200 with `kind: 'legacy'` and an empty `{}` resolution. The data-liability contract is satisfied either way (the data is gated/absent in both states), but callers that depended on the 410 signal to distinguish "expired" from "no payload" lose that distinction after the sweep. A future enhancement could persist a non-sensitive tombstone marker to preserve 410 semantics across the sweep — out of scope for C1.

## Verification (60-second AI-reviewer recipe)

```bash
# Unit suite for the scheduled job (covers start/stop/tick/overlap-skip/error isolation):
npx jest --config=jest.fast.config.cjs tests/unit/services/workflowCentral/WorkflowPayloadRetentionJob.test.ts
# Expected: "Tests: 14 passed, 14 total"

# Unit suite for the repository method (covers the SQL contract end-to-end via in-memory SQLite):
npx jest --config=jest.fast.config.cjs tests/unit/services/workflowCentral/WorkflowCentralRepository.test.ts -t "clearExpiredEphemeralPayloads"
# Expected: "Tests: 21 passed" (plus skipped from unrelated describe blocks)

# Confirm the job is registered in DI and started by the server:
grep -n "WorkflowPayloadRetentionJob" src/inversify/types.ts src/inversify/inversify.config.ts src/index.ts
# Expected: TYPES symbol + binding + start call in Server.start + stop call in Server.stop

# Confirm the canonical Tier-B pattern is mirrored (start/stop/tick/inflight guard/unref):
grep -nE "intervalHandle|inflight|unref" src/services/workflowCentral/WorkflowPayloadRetentionJob.ts
# Expected: matches in start(), stop(), and tick() functions — same shape as EmbeddedRetentionJob
```

---

<!--
Authoring notes:

The "production" status reflects that the reaper IS wired into Server.start +
Server.stop and runs every hour on every replica. Demote to beta only if a
follow-up PR adds the leader-election / batched-update / metrics work above.

Status: production is consistent with the audit-proof-cards rule because this
is a service-level card (no connector counterpart). The audit script only
enforces productionStatus-match for connector-tagged cards.
-->
