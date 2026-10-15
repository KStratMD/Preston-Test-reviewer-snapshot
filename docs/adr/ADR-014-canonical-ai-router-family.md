# ADR-014: Canonical AI Router Family

**Status:** Accepted  
**Date:** 2026-05-02  
**PR:** 1B (Grade-A Remediation)

## Context

The SuiteCentral integration hub evolved two parallel families of AI route handlers:

1. **Direct family** (`/api/ai/*`) — 7 routers mounted at `/api/ai`, `/api/ai/secure`, `/api/ai/mapping`, `/api/ai/quality`, and `/api/ai/provider`. These used a no-op `aiAuthMiddleware` and had **no governance policy gating**.

2. **Proxy family** (`/api/ai/proxy/*`) — 6 routers with dependency-injected `GovernanceService`, telemetry, cost tracking, and real AI agent orchestration.

The governance audit (PR 1A) quantified the gap: 7 of 9 AI route mounts were ungoverned, allowing PII-bearing payloads to reach LLM-backed endpoints without policy checks.

## Decision

**All production AI traffic routes through `/api/ai/proxy` as the single canonical AI path.**

Specifically:

- **Migrate** unique direct-family routers (CrossModuleMetrics, Dashboard, NaturalLanguage, Phase2AI, PredictiveConnector, WorkflowIntelligence) into `src/routes/ai-proxy/` and mount them under `/api/ai/proxy`.

- **Delete** overlapping direct-family routers (BusinessIntelligence, FieldMapping, DataQuality) that were simpler/demo versions of existing proxy counterparts.

- **Absorb** the `/api/ai/provider` config endpoints into the proxy tree at `/api/ai/proxy/provider-config`.

- **Apply** a centralized `createGovernanceMiddleware` at the proxy router boundary for defence-in-depth (the existing per-router inline governance checks are retained as a second layer).

- **Install** a 301 redirect shim at `/api/ai` that forwards all non-proxy, non-demo requests to `/api/ai/proxy/*`. This shim remains until explicitly removed in a future PR.

- **Retain** `/api/ai-demo` as a demo-only path (no auth/governance by design).

## Consequences

### Positive

- **Zero ungoverned AI paths**: the governance audit gap is closed.
- **Single routing tree**: all AI endpoints discoverable under one prefix.
- **Backwards compatible**: 301 redirects ensure no broken client integrations.
- **Defence-in-depth**: governance enforced at both middleware layer and within individual sub-routers.

### Negative

- **Larger proxy router file**: `aiProxy.ts` now mounts 12 sub-routers (up from 6). This is manageable and may be refactored into sub-files if it grows further.
- **Redirect latency**: clients on the old `/api/ai/*` paths incur a 301 redirect hop until they update their URLs.

### Neutral

- `/api/ai/secure` is redirect-shimmed (not migrated) — its functionality overlaps with the proxy provider router. A future PR will evaluate full removal.
- The `ai.ts` aggregator module is kept as a deprecation stub for stale import compatibility.

## References

- [PR 1A — AI Route Governance Inventory](../plans/2026-05-01-a-grade-remediation-plan-merged.md)
- [GovernanceService](../../src/services/ai/orchestrator/GovernanceService.ts)
- [governanceMiddleware](../../src/middleware/governanceMiddleware.ts)
