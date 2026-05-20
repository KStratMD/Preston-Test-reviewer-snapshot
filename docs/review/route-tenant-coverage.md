# Route Tenant Coverage

> **Source of truth:** `src/middleware/setup/routeManifest.ts` (`ROUTE_MANIFEST`).
> This doc is a human-readable companion; the audit gate
> `npm run audit-tenant-coverage` enforces source ↔ manifest consistency.

## Classification semantics

| Classification | Behavior | Use when |
|---|---|---|
| `public` | No identity required, no tenant filtering | Health/probes, redirect shims, swagger UI |
| `system` | Elevated identity required (admin/ops); auth still enforced at handler level | Tenant lifecycle admin, ops metrics |
| `tenant_required` | Central `tenantIsolation` middleware populates `req.tenantContext` from verified sources only (Bearer JWT against `JWT_SECRET`, configured `resolveTenant` callback, or `trustedTenants` fast-path). The `x-tenant-id` header alone does NOT populate it — `disableHeaderExtraction: true` is a permanent security invariant frozen by `npm run audit-tenant-isolation-invariant`. | Any route that operates on tenant-scoped data |
| `demo` | Bypasses tenant isolation entirely | Demo-mode fallback routes |

## PR 4B + PR 2C-Auth contract

- **Permissive mode (today).** `tenantIsolation` is mounted with `strictMode: false, disableHeaderExtraction: true`. A `tenant_required` route called without verified tenant context falls through to the handler; handlers continue to read identity via `extractIdentityContext`, which falls back to `SYSTEM_IDENTITY`. Routes that want fail-closed behavior implement it themselves (e.g., the Codex-5.4 401 gate in `approvalsRouter.ts`).
- **`disableHeaderExtraction: true`** is a permanent security invariant. It means the un-verified `x-tenant-id` header does NOT populate `req.tenantContext`, closing the header-impersonation surface against direct `req.tenantContext` consumers (`mcpPolicies.ts`) AND against the `extractIdentityContext` `req.tenantContext` bridge added in PR 2C-Auth. The flag is frozen by `npm run audit-tenant-isolation-invariant`: any `tenantIsolation(...)` callsite under `src/` that omits or sets it `false` fails CI. The flag should not flip unless an upstream gateway verifies the header — Preston-Test does not have one.
- **PR 2C-Auth wired the JWT path.** `optionalAuthMiddleware` is mounted globally on `/api/*` ahead of the central gate, so a Bearer JWT against `JWT_SECRET` populates `req.user.tenantId`. Inside the gate, `tenantIsolation`'s built-in JWT extraction populates `req.tenantContext` from the same JWT. `extractIdentityContext` reads `req.auth → req.user → req.tenantContext` in that order; the bridge (third source) was added in PR 2C-Auth and inherits the verified-source-only invariant above.
- **Strict-mode flip (future PR).** Once production callers ship JWTs reliably, `strictMode` can flip to `true` so missing tenant context returns 403 at the central gate, retiring the per-handler SYSTEM_IDENTITY fail-closed pattern (e.g. the explicit 401 in `approvalsRouter`). That migration is out of scope for PR 2C-Auth — it requires updating ~30 handlers that currently treat SYSTEM_IDENTITY as a valid fallback.
- **Unknown-route safety default.** `classifyRoute()` returns `'system'` (NOT `'public'`) for unmatched paths and emits a one-time-per-path `logger.error`, capped at 1024 entries to bound memory/log volume under attacker-driven path enumeration. The CI audit gate is the primary safety net; the noisy runtime default is the backstop.

## Public

| Path | Notes |
|---|---|
| `/health` | liveness probe |
| `/ready` | readiness probe |
| `/api/metrics` | Prometheus scrape; no auth |
| `/api/ai` | PR 1B 301 redirect shim → /api/ai/proxy |
| `/api/download` | static downloads |
| `/docs` | docs router |
| `/api-docs` | swagger UI |
| `/api/connector-metadata` | sub-route of bare `/api` mount (connectorCredentialRouter); global connector catalog, no auth |

## System

| Path | Notes |
|---|---|
| `/api/admin/tenants` | tenant lifecycle admin |
| `/metrics` | gated by ENABLE_METRICS + authMiddleware |
| `/api/disaster-recovery` | ops-only |
| `/api/disaster-recovery/dashboard` | ops-only |
| `/api/statistics` | single-endpoint diagnostic mounted in `src/index.ts`; reads global configService state, not tenant-scoped |

## Demo

| Path | Notes |
|---|---|
| `/api/ai-demo` | |
| `/api/full-pipeline-demo` | |
| `/api/data-migration` | demo migration playground |

## Tenant-required

| Path | Notes |
|---|---|
| `/api/ai/proxy` | AI provider proxy; governance + tenant scoping |
| `/api/settings` | |
| `/api/mcp` | |
| `/api/mappings` | |
| `/api/mappings/templates` | |
| `/api/templates` | |
| `/api/dashboard` | |
| `/api/dashboard/api/mappings` | legacy double-/api/ prefix; mirrors RouteSetup.ts mount |
| `/api/dashboard/mappings` | |
| `/api/dashboard/mappings/templates` | |
| `/api/dashboard/templates` | |
| `/api/integrations` | |
| `/api/upload` | |
| `/api/testing` | |
| `/api/fixtures` | |
| `/api/baselines` | |
| `/api/persistence` | |
| `/api/predictive-analytics` | |
| `/api/executive` | |
| `/api/agents` | |
| `/api/context` | |
| `/api/embedded/host-bootstrap` | |
| `/api/embedded/context` | |
| `/api/embedded/sessions` | |
| `/api/governance/approvals` | HITL queue; Codex-5.4 401 gate inside router |
| `/api/actions` | |
| `/api/documents` | |
| `/api/feature-flags` | |
| `/api/roi-dashboard` | |
| `/api/suitecentral/sync` | |
| `/api/suitecentral/netsuite/sync` | |
| `/api/squire/suitecentral/netsuite/sync` | |
| `/api/suitecentral/prod` | |
| `/api/payment-central` | centralAuthMiddleware + tenantStatusGate already in place |
| `/api/supplier-central` | |
| `/api/customer-central` | |
| `/api/quality-central` | |
| `/api/payout-central` | |
| `/api/installer-central` | |
| `/api/service-central` | |
| `/api/inventory-central` | |
| `/api/finance-central` | |
| `/api/contract-central` | |
| `/api/portal-central` | |
| `/api/workflow-central` | |
| `/api/shipstation` | |
| `/api/hubspot` | |
| `/api/sync-central` | |
| `/api/sync-orchestrator` | |
| `/api/automation-libraries` | |
| `/api/nl-action-gate` | |
| `/api/mdm` | |
| `/api/compliance` | |
| `/api/sync-error-assist` | pathless mount via syncErrorAssistRoutes; routes defined as absolute /api/sync-error-assist/* inside the router |
| `/api/ai-config` | pathless mount via aiConfigRouter; routes defined as absolute /api/ai-config/* inside the router |
| `/api/help` | mounted in `src/index.ts`; help.ts reads identity via extractIdentityContext |
| `/api/connector-credentials` | sub-route of bare `/api` mount (connectorCredentialRouter); per-tenant credentials, requireAuth |
| `/api/test-connection` | sub-route of bare `/api` mount (connectorTestRouter); tests tenant connector credentials |
| `/api/configurations` | sub-route of root `/` mount (configurationRouter); integration configuration CRUD |
| `/api/enterprise` | sub-route of root `/` mount (enterpriseFeaturesRouter); /api/enterprise/* surface incl. activity, approvals, golden-set, governance |
