# ADR-022 — Cost Transparency: measured-vs-estimated as a contract

**Status:** Accepted
**Date:** 2026-05-22
**Supersedes:** None

## Context

Squire's Reuben Cook allocates AI spend via spreadsheet. The honest question is "what did this AI feature cost us last month?". The repo has captured per-request cost via `CostTrackingService.recordCost()` since Week 2, but the field is named `estimated_cost` and the provenance of that number — provider-reported vs. locally-computed — is not surfaced. Without that distinction, a dashboard cell is asserting precision it doesn't have.

## Decision

Every cost cell in the Cost Transparency Dashboard carries an explicit `source: 'measured' | 'estimated'` label that surfaces in the UI.

- `measured`: the provider's HTTP response included a `usage` block (token counts) AND the recorded cost was derived from that token count using the provider's own per-token rate (currently each provider's `getCostPerToken()`). A future enhancement (see `## Per-model pricing` below) would replace this with the canonical `modelPricing.ts` rate; today the `measured` label asserts only that the cost was tied to a real provider-reported token count, not that the rate is canonical.
- `estimated`: cost was computed locally from a token estimator (e.g., LMStudio responses, providers that omit usage, or fallback paths).

The label is captured at write time in `ai_usage_logs.cost_source`, NEVER inferred at read time. Rollups produced by `CostTransparencyService` propagate the label per-cell — when a rollup window contains a mix of measured and estimated rows, the rollup is labeled `mixed (M measured, E estimated)`. Silent fallback to estimated is prohibited.

## Per-tenant attribution

`ai_usage_logs` gains a `tenant_id TEXT NOT NULL` column. Backfill default is `__legacy_unattributed__` (mirrors `audit_logs` at migration 031). `CostTrackingService.recordCost()` extracts tenant from identity context and refuses to write rows with a null/empty tenant.

## Anomaly threshold

A daily rollup is flagged as anomalous when BOTH:
1. `daily_cost_usd > 3 × trailing_7d_average_cost_usd`, AND
2. `daily_cost_usd > 1.00` USD-equivalent.

The `1.00` floor avoids false positives on tiny test traffic. The threshold is a constant in `CostTransparencyService`, not a tenant-tunable setting (Tier-3 future).

## Per-model pricing

Per-model rates live in `src/services/cost/modelPricing.ts`. The table is `Object.freeze`d. `pricingForModel(model)` throws on unknown models (no silent fallback). This table is the canonical source for upstream-published rates and is intended for future cost-recomputation features (e.g., reconciliation against provider invoices).

The Cost Transparency Dashboard's rollups currently read pre-computed `estimated_cost` values from `ai_usage_logs` that each provider populates via its own per-token rate. Wiring `pricingForModel` into the rollup pipeline is a deferred enhancement; the table is in place so that wiring is a future single-file edit rather than a new design.

## Daily rollup cadence

`CostTransparencyDailyJob` is a `setInterval`-based scheduler (mirrors `EmbeddedRetentionJob` / `SyncErrorAssistDailyJob`); it runs once per 24-hour interval from process start, not cron-anchored to a specific wall-clock time. The interval is a constant (`DEFAULT_INTERVAL_MS = 24 * 60 * 60_000`) on the service; not tenant-tunable. A cron-anchored variant would require introducing a scheduler abstraction that does not yet exist in the codebase, and is deferred until multiple jobs need that capability.

## Consequences

- New columns on `ai_usage_logs` require a new migration (the next available slot at time of writing is 047).
- New rollup tables `cost_rollup_daily` and `cost_rollup_per_flow`.
- `CostTrackingService.recordCost()` callers (currently 4: `SyncErrorAssistService`, `MappingRouter`, `MCPRouter`, `SessionBudgetEnforcer`) must pass `costSource` explicitly. Today all four pass `'measured'` (when a provider `usage` block was present) or `'estimated'` (synthetic/heuristic paths). Future provider-level wiring could set this on `lastTokenUsage` directly instead of requiring caller propagation.
- LMStudio always reports `'estimated'`; this is documented as a known characteristic, not a bug.
- The dashboard cell rendering layer must NEVER round-trip a cell through a code path that loses the `source` label.

## Alternatives considered

- **Compute `cost_source` at read time** by inspecting the row's `prompt_tokens` and `model_version` against the pricing table. Rejected: a mismatch at read time silently degrades to estimated, defeating the contract.
- **Single `cost` column with a sibling `cost_provenance` enum stored as JSON**. Rejected: harder to index for rollup queries.
- **Skip the gap; populate tenant_id by joining `ai_sessions → workflow_central_instances → tenant_id`**. Rejected: brittle (ai_sessions doesn't always exist for every cost row), and adds 3 joins to every rollup query.
