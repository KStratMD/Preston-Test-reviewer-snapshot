# Proof Card: Record-Level Lineage

**Status:** production
**Last verified:** 2026-05-24

## Claim

PR 12 ships the lineage schema, recorder, query service, and opt-in `FlowExecutor` instrumentation for **all four** event types — `source_read`, `transform`, `governance_decision`, and `target_write` — under a single `chain_id`. `source_read` emission was deferred in the original PR 12 and landed in the PR 12 follow-up via a new optional `ctx.sourceRecord` field on `FlowContext`; when present alongside `ctx.lineageRecorder`, the executor emits `source_read` as the first chain row before the transform step. Callers without upstream source-record context omit the field and retain the pre-emitter behaviour (transform → governance → target_write only).

The `LineageQueryService.chainForRecord(...)` API resolves the most recent chain for a `(source_system, source_entity_type, source_entity_id)` triple and returns its full event list in sequence order. The HTTP surface `GET /api/lineage/records/:system/:entityType/:entityId` exposes this lookup behind operator identity (Bearer JWT).

A static drift gate enforces that the four instrumented call sites (`sourceRead`, `transform`, `governanceDecision`, `targetWrite`) plus the `startChain` handle plus the `hashLineagePayload` import remain present in `FlowExecutor.ts`.

## Scope

- **Shipped:** schema (migration 049 — `lineage_events` with three lookup indexes including the record-lookup index for chain-by-record queries), `LineageRepository` (append + listChain + findLatestChainForRecord), `LineageRecorder` (chain builder with all four event-type methods), `LineageQueryService.chainForRecord(...)`, opt-in `FlowExecutor` instrumentation for **all four event types** (`source_read` emitted when `ctx.sourceRecord` is plumbed), drift gate, **two HTTP surfaces** — operator API at `/api/lineage/records/...` (Bearer JWT) and embedded API at `/api/embedded/lineage/records/...` (validateGuestContext / embedded session). The embedded operator UI ships at `public/embedded/lineage.{html,js}` and is served at `/embedded/lineage.html` with `embeddedCspMiddleware`.

## Source

- Schema: `src/database/migrations/049-create-lineage-events-table.ts`
- Types: `src/services/lineage/LineageTypes.ts`
- Repository: `src/services/lineage/LineageRepository.ts`
- Recorder: `src/services/lineage/LineageRecorder.ts`
- Query service: `src/services/lineage/LineageQueryService.ts`
- Flow instrumentation: `src/flows/templates/FlowExecutor.ts`, `src/flows/templates/FlowTemplate.ts`
- HTTP route (operator API, Bearer JWT): `src/routes/lineageRoutes.ts`
- HTTP route (embedded API, session): `src/routes/embedded/embeddedLineageRouter.ts`
- Embedded UI: `public/embedded/lineage.html`, `public/embedded/lineage.js` (served via `embeddedHtmlHandler.ts` allowlist)
- Inversify wiring: `src/inversify/inversify.config.ts` (3 `toDynamicValue(async)` singleton bindings — required because `LineageRepository` transitively depends on async-bound `DatabaseService`)
- Drift gate: `scripts/check-lineage-instrumentation.mjs`

## Tests

- Migration: `tests/unit/database/migrations/049-create-lineage-events-table.test.ts`
- Repository: `tests/unit/services/lineage/LineageRepository.test.ts`
- Recorder: `tests/unit/services/lineage/LineageRecorder.test.ts`
- Query: `tests/unit/services/lineage/LineageQueryService.test.ts`
- Route (operator API): `tests/unit/routes/lineageRoutes.test.ts`
- Route (embedded API): `tests/unit/routes/embedded/embeddedLineageRouter.test.ts`
- Embedded HTML allowlist: `tests/unit/middleware/embeddedHtmlHandler.test.ts`
- Flow instrumentation: `tests/unit/flows/templates/FlowExecutor.test.ts` (`-t lineage`)
- Drift gate regression: `tests/scripts/check-lineage-instrumentation.test.sh`

## Live vs Fixture

- Real HTTP wired? N/A — internal lineage persistence, not an outbound integration.
- Demo-mode toggle? No — `lineageRecorder` is plumbed through DI; absent in `ctx` means "no recording", present means "record".
- Production credential test on file? N/A.

## Known Gaps

- PR 13 source-of-truth manifest validation is a separate gate and is NOT implied by this card. The schema declares `source_system` / `target_system` columns on every row, but the recorder only populates them on the event types where they apply (`source_*` on `source_read`, `target_*` on `target_write`); the other event-type rows leave them NULL. The `idx_lineage_events_record_lookup` index covers `source_*` populated rows, which is sufficient for chain-by-record lookup. A future PR 13 cross-validation consumes the per-event-typed populated values directly — no executor re-instrumentation needed.
- `ctx.sourceRecord` is OPTIONAL on `FlowContext` — callers that have not plumbed an upstream ingest adapter still execute (without `source_read` emission). Adding `sourceRecord` plumbing at every executor entry point is a per-caller follow-up; the contract is in place and tests cover both the plumbed and the un-plumbed path.
- Lineage events are append-only; no retention sweep ships in this PR. Disk growth is bounded by `tenant_id` indexes for future scoped pruning.

## Verification (60-second)

```bash
# Migration + service + route unit tests (both auth modes)
npm test -- tests/unit/database/migrations/049-create-lineage-events-table.test.ts \
            tests/unit/services/lineage/LineageRepository.test.ts \
            tests/unit/services/lineage/LineageRecorder.test.ts \
            tests/unit/services/lineage/LineageQueryService.test.ts \
            tests/unit/routes/lineageRoutes.test.ts \
            tests/unit/routes/embedded/embeddedLineageRouter.test.ts \
            tests/unit/middleware/embeddedHtmlHandler.test.ts

# Flow instrumentation
npm test -- tests/unit/flows/templates/FlowExecutor.test.ts -t lineage

# Drift gate (script + regression net)
npm run audit-lineage-instrumentation
bash tests/scripts/check-lineage-instrumentation.test.sh
```
