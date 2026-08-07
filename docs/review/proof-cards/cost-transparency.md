# Proof Card: Cost Transparency

**Status:** production
**Last verified:** 2026-05-22 · PR #839

## Claim

`CostTransparencyService` (`src/services/cost/CostTransparencyService.ts`) reads tenant-attributed AI usage rows from `ai_usage_logs` and writes daily rollups into `cost_rollup_daily` (per-tenant/provider/day) and `cost_rollup_per_flow` (per-tenant/flow/day). Every rollup carries explicit `measured` / `estimated` counts captured at write time in `ai_usage_logs.cost_source`. The dashboard at `/cost-transparency-dashboard.html` renders per-cell source labels (`measured` / `estimated` / `mixed (M measured, E estimated)` / `no data`) — silent fallback to estimated is prohibited (see ADR-022).

## Source

- Implementation: `src/services/cost/CostTransparencyService.ts`
- Entry point: `src/routes/costTransparencyRoutes.ts` (`GET /api/cost-transparency/dashboard`)
- Daily rollup job: `src/services/cost/CostTransparencyDailyJob.ts`
- Schema migration: `src/database/migrations/047-create-cost-rollup-tables.ts`
- Per-model pricing: `src/services/cost/modelPricing.ts`
- Dependencies: `src/services/cost/CostTransparencyRepository.ts`, `src/services/ai/CostTrackingService.ts` (write-path that populates `tenant_id` + `cost_source`)

## Tests

- Unit (in `tests/unit/services/cost/`): `CostTransparencyService.test.ts` (17 tests), `CostTransparencyRepository.test.ts` (6 tests), `CostTransparencyDailyJob.test.ts` (4 tests), `modelPricing.test.ts` (6 tests)
- Integration: `tests/integration/costTransparency.fixture.test.ts` (6 scenarios)
- Route: `tests/unit/routes/costTransparencyRoutes.test.ts` (3 tests)
- Migration: `tests/unit/database/migrations/047-create-cost-rollup-tables.test.ts` (5 tests)
- Coverage: see `.core-coverage-budget.json` (re-stamped in Task 15)

## Live vs Fixture

- Real HTTP wired? **N/A** — this is a server-side aggregation service; no outbound HTTP. Cost data is sourced from `ai_usage_logs` rows that other services (OpenAIProvider, ClaudeProvider, etc.) populate when they call the real provider APIs.
- Demo-mode toggle? **No** — service is unconditional; if `ai_usage_logs` is empty (fresh tenant), `getDashboard()` returns `{ history: [], todayLabel: 'no data' }`. There's no fake-data path.
- Production credential test on file? **N/A** — does not authenticate against an external system.

## Known Gaps

- Per-model pricing table (`modelPricing.ts`) is in place with throws-on-unknown contract, but is NOT currently called by the rollup pipeline. The dashboard reads pre-computed `estimated_cost` values populated by each AI provider's own `getCostPerToken()`. Wiring `pricingForModel` into the rollup/reconciliation path is a deferred enhancement (ADR-022 § Per-model pricing). The table must be kept current with upstream provider rate sheets when that wiring lands; there's no scheduled drift detector yet.
- Tenant isolation is enforced at the query layer (`WHERE tenant_id = ?` on every read). There is no row-level security at the DB layer. The route's identity check (`extractIdentityContext(req)`) is the only barrier to a tenant requesting another tenant's data.
- `cost_source = 'estimated'` rows from LMStudio always carry cost = 0; the rollup's `estimated_count` increments but `total_cost_usd` doesn't. This is by design (local model, no provider cost) but means the count and cost can diverge in expected ways.
- Anomaly detection requires ≥8 days of history for a tenant (today + 7 prior); freshly-onboarded tenants will have `anomalyDetected: false` for their first 7 days regardless of cost spikes.
- `CostTrackingService.recordCost` now requires `tenantId` + `costSource` arguments and writes both columns explicitly. Legacy rows persisted before this PR carry the migration defaults (`__legacy_unattributed__` and `estimated`); they are visible in rollups only if they fall in the dashboard's 7-day window AND the tenant filter excludes `__legacy_unattributed__` and `__system__`.

## Verification (60-second AI-reviewer recipe)

```bash
npx jest tests/unit/services/cost/ --config=jest.fast.config.cjs
npx jest tests/integration/costTransparency.fixture.test.ts --config=jest.slow.config.cjs
grep -n "cost_source" src/database/migrations/047-create-cost-rollup-tables.ts   # confirm column was added
grep -n "pricingForModel" src/services/cost/modelPricing.ts                       # confirm throws-on-unknown contract
# curl -H "Authorization: Bearer <jwt>" http://localhost:3003/api/cost-transparency/dashboard
```
