import type { Application, Request, Response, NextFunction, RequestHandler } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { isDemo } from '../../utils/features';
import { env } from '../../config';
import type { IntegrationService } from '../../services/IntegrationService';
import type { ConfigurationService } from '../../services/ConfigurationService';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from '../../middleware/auth';
import { createErpWriteRateLimit, limitMutatingMethods } from '../../middleware/rateLimit';
import { logger, type Logger } from '../../utils/Logger';
import { resolvePublicDir } from './publicDir';
import type { DocumentationKnowledgeBase } from '../../services/help/DocumentationKnowledgeBase';
import { tenantIsolation } from '../tenantIsolation';
import { makeTenantStatusGate } from '../tenantStatusGate';
import { requirePlatformAdmin } from '../verifiedAdmin';
import {
  createAiProxyPolicyGate,
  createDemoFamilyPolicyGate,
  hasPresentedIdentity,
  type DemoAllowlistEntry,
} from '../aiProxyPolicyGate';
import { isDemoMode } from '../../config/runtimeFlags';
import type { TenantLifecycleService } from '../../services/tenants/TenantLifecycleService';
import type { CardinalityPreflight } from '../../types/cardinality';
import type { SerializedAssetReadinessEvaluator } from '../../services/serializedAsset/SerializedAssetReadinessService';
import { classifyRoute } from './routeManifest';
import type { HttpMethod } from './routePolicy';
import { resolveCentralTenantPreflight, toCentralHttpMethod } from './centralTenantPreflight';

// Shared ERP write-family limiter (repo-review A1). One instance so the
// /api/integrations and SuiteCentral sync mounts share a single mutating-write
// budget per (IP, user); reads pass through untouched (limitMutatingMethods).
const erpWriteRateLimit = limitMutatingMethods(createErpWriteRateLimit());

/** Shape of a dynamically imported module (handles both ESM default and CJS) */
type DynamicModule = { default?: unknown; [key: string]: unknown };
function getDefaultExport<T = import('express').Router>(mod: DynamicModule): T {
  return (mod.default || mod) as T;
}

export function getAIProxyRedirectUrl(originalUrl: string): string {
  const match = originalUrl.match(/^([^?#]*)([?#].*)?$/);
  let path = match?.[1] ?? originalUrl;
  const suffix = match?.[2] ?? '';

  if (path.startsWith('/api/ai/secure')) {
    path = path.replace(/^\/api\/ai\/secure/, '/api/ai/proxy');
  } else {
    path = path.replace(/^\/api\/ai/, '/api/ai/proxy');
  }

  if (path === '/api/ai/proxy/quality/analyze') {
    path = '/api/ai/proxy/data-quality/analyze';
  }
  // The legacy field-mapping router in the proxy has no /feedback endpoint;
  // feedback is served by the governed mapping router at /mapping/feedback.
  if (path === '/api/ai/proxy/field-mapping/feedback') {
    path = '/api/ai/proxy/mapping/feedback';
  }
  if (path === '/api/ai/proxy/providers/health') {
    path = '/api/ai/proxy/status';
  }
  if (/^\/api\/ai\/proxy\/provider(?:\/|$)/.test(path)) {
    path = path.replace(/^\/api\/ai\/proxy\/provider(\/|$)/, '/api/ai/proxy/provider-config$1');
  }

  return `${path}${suffix}`;
}

/**
 * PR 4B + PR 2C-Auth: Central tenant-isolation gate. Single mount point in
 * front of all routers. Non-tenant classifications short-circuit to `next()`.
 * Tenant-required requests are resolved against the shared route policy:
 * trusted session/HMAC surfaces and policy-owned demo-health paths run
 * populate-only isolation before their downstream validator; all other paths
 * use central isolation. Deferral is not public admission.
 *
 * Mode: strict production central isolation + header-extraction-DISABLED.
 *   - Production selects `strictMode: true` for the central isolation branch.
 *     Exact Stage 4 deferrals still run the populate-only instance before
 *     their route-owned validator.
 *   - `disableHeaderExtraction: true` (R4 security invariant): the
 *     un-verified `x-tenant-id` header does NOT populate
 *     `req.tenantContext`. This is the SECURITY INVARIANT of the central
 *     gate, NOT a phase flag. It must not flip unless an upstream gateway
 *     verifies the header — Preston-Test does not have such a gateway.
 *     The invariant is frozen by
 *     `audit-status-claims --check-tenant-isolation-invariant`. The gate
 *     fails CI on any `tenantIsolation(...)` callsite under `src/` that
 *     (a) omits or sets `disableHeaderExtraction: false`, (b) is
 *     parameterless (`tenantIsolation()` — library defaults read the
 *     header), (c) passes a non-inline options literal the scanner
 *     can't verify, OR uses a bypass prelude that would make the
 *     canonical-call scanner blind: (d) aliased named import, (e)
 *     namespace import, (f) reference assignment `const x = tenantIsolation`,
 *     or (g) CommonJS `require('.../tenantIsolation')` access.
 *
 * **What CAN populate `req.tenantContext`**: `tenantIsolation` tries four
 * sources, in this runtime precedence order:
 *   1. A configured `resolveTenant` callback. Not configured at this
 *      mount (see the options literals below), so it is a no-op here.
 *   2. The verified `req.user` tenant claim, normalized by
 *      `authMiddleware`/`optionalAuthMiddleware`. This is the source that
 *      WINS in production: `optionalAuthMiddleware` is mounted globally on
 *      `/api/*` ahead of this gate, and source 1 is unconfigured, so every
 *      authenticated request is resolved here and never reaches source 3.
 *   3. A valid `Authorization: Bearer <jwt>` against `JWT_SECRET`, via
 *      `tenantIsolation`'s built-in JWT extraction. Reachable only for a
 *      request that carries a verifiable token but no `req.user` — i.e. a
 *      `tenantIsolation` mount not preceded by the global optional auth.
 *   4. The `trustedTenants` fast-path, which matches an UN-authenticated
 *      `x-tenant-id` header against an allowlist. Not configured at this
 *      mount (see the options literal below), so it too is a no-op here;
 *      if it were ever configured, it would be the one source not backed
 *      by a verified JWT.
 * Sources 2 and 3 both terminate in a JWT verified against `JWT_SECRET`.
 * This mount leaves sources 1 and 4 unconfigured, so only the verified
 * sources 2 and 3 are reachable here in practice.
 *
 * **Why this matters.** PR 4B's first version had two header-impersonation
 * vectors: (a) a bridge in `extractIdentityContext` and (b) `mcpPolicies`
 * reading `req.tenantContext` directly. R2 reverted (a) until PR 2C-Auth
 * could land alongside the header-extraction-disabled invariant; R4 closed
 * (b) by disabling the header path in `tenantIsolation`. PR 2C-Auth then
 * re-added the bridge SAFELY because (b)'s invariant guards (a).
 *
 * Exported for unit testing (`tests/unit/middleware/centralTenantGate.test.ts`).
 */
export interface CentralTenantGateOptions {
  /** Explicit selector. Omission stays permissive for test compatibility; production must pass true. */
  strictMode?: boolean;
  /** Test seam for the existing hosted-demo runtime predicate. */
  isDemoRuntime?: () => boolean;
}

export function mountCentralTenantGate(
  app: Application,
  options: CentralTenantGateOptions = {},
): void {
  const populateOnlyIsolation = tenantIsolation({
    strictMode: false,
    allowAnonymous: false,
    disableHeaderExtraction: true,  // PR 4B R4 security fix: pre-PR-2C-Auth,
                                    // x-tenant-id headers are NOT authenticated.
                                    // Populating req.tenantContext from them
                                    // would activate header impersonation vectors
                                    // in direct consumers like mcpPolicies.ts.
    // No excludePaths override needed — /health, /ready, /metrics and other
    // non-tenant routes are classified 'public'/'system'/'demo' in the
    // manifest and short-circuit here; tenant-required route-owned deferrals
    // are handled by the dispatcher below.
  });
  const strictIsolation = tenantIsolation({
    strictMode: true,
    allowAnonymous: false,
    disableHeaderExtraction: true,
  });
  const selectedIsolation = options.strictMode === true ? strictIsolation : populateOnlyIsolation;
  const isDemoRuntime = options.isDemoRuntime ?? (() => Boolean(env.HOSTED_DEMO) || (env.NODE_ENV !== 'production' && isDemoMode()));

  app.use((req: Request, res: Response, next: NextFunction) => {
    // PR 4B scope: tenant gating applies to /api/* only. Root-mounted static
    // assets (/openapi.yaml, /docs, /api-docs, /index, /), one-off probes,
    // and other non-API paths are NOT classified — they short-circuit here
    // to avoid log noise + unbounded _unknownPathSeen growth on legitimate
    // non-API requests. The manifest's scope is the /api/* tenant surface.
    if (!req.path.startsWith('/api/')) {
      return next();
    }
    const classification = classifyRoute(req.path);
    if (classification === 'tenant_required') {
      const method = toCentralHttpMethod(req.method);
      if (method === null) {
        return selectedIsolation(req, res, next);
      }
      try {
        const decision = resolveCentralTenantPreflight({
          path: req.path,
          method,
          isDemoRuntime: isDemoRuntime(),
          hasPresentedIdentity: hasPresentedIdentity(req),
        });
        if (decision.action === 'defer') {
          return populateOnlyIsolation(req, res, next);
        }
        return selectedIsolation(req, res, next);
      } catch (error) {
        return next(error);
      }
    }
    return next();
  });
}

/**
 * PR3 (F6 sub-project B): /api/sync-central is the only genuinely
 * tenant-scoped family of the three — SyncCentralService is TenantSandbox-
 * backed. authMiddleware fronts the kill switch so an authenticated
 * tenant-less JWT hits the gate's fail-closed 403 tenant_id_missing branch
 * and anonymous callers get 401 before the router.
 *
 * Pinned by tests/integration/syncCentralTenantStatusGate.routes.test.ts.
 */
export function mountSyncCentralRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/sync-central', authMiddleware, gate, router);
}

/**
 * PR3: /api/sync-orchestrator is platform-GLOBAL, not tenant-scoped —
 * SyncOperation has no tenantId and the stores are process-global Maps
 * (SyncCentralOrchestrator.ts:212-214). Authenticating it cannot isolate it,
 * so it takes the F4 platform-global shape (see mountHubSpotRoutes) and its
 * manifest classification is `system`. The erp-write limiter belongs here
 * because POST /operations/:id/execute issues real connector writes.
 *
 * No kill switch: lifecycle 'not_applicable' — a platform admin is not a
 * tenant.
 */
export function mountSyncOrchestratorRoutes(
  app: Application,
  router: RequestHandler,
  limiter: RequestHandler = erpWriteRateLimit,
): void {
  app.use('/api/sync-orchestrator', authMiddleware, requirePlatformAdmin, limiter, router);
}

/**
 * PR3: /api/automation-libraries is platform-global for the same reason
 * (AutomationLibrariesService.ts:319-322 holds four process-global Maps).
 *
 * NO limiter, deliberately: its profile is admin_ops, whose enforcedBy is
 * 'declarative_only'. Attaching the erp-write limiter would make this mount
 * claim an enforcement shape the profile does not have, and its /execute
 * routes mutate in-memory demo state rather than issuing connector writes.
 */
export function mountAutomationLibrariesRoutes(
  app: Application,
  router: RequestHandler,
): void {
  app.use('/api/automation-libraries', authMiddleware, requirePlatformAdmin, router);
}

/**
 * F1 (design D5-F1): the /api/mcp policy-CRUD mount is strict — authMiddleware
 * fronts it (anonymous → 401) and the tenant-lifecycle kill switch runs before
 * the router (suspended tenant → 403 tenant_blocked; authenticated tenant-less
 * token → the gate's fail-closed 403 tenant_id_missing). Extracted like
 * mountSyncCentralRoutes so the exact production wiring is exercised by
 * tests/integration/mcpPoliciesTenantStatusGate.routes.test.ts — dropping the
 * gate or authMiddleware here fails that test.
 */
export function mountMcpPolicyRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const mcpGate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/mcp', authMiddleware, mcpGate, router);
}

/**
 * F2 (design D5-F2): the /api/ai/proxy family sits behind the policy-driven
 * gate — the demo allowlist is anonymous ONLY under a demo runtime AND for
 * credential-less requests (zero-spend + fixture-isolated inside the
 * routers); provider-config/model-select require the platform-admin claim;
 * everything else requires authMiddleware + the tenant-lifecycle kill switch
 * (this family's A6-class ledger row closes here). In production the demo
 * runtime requires the explicit HOSTED_DEMO=1 deployment flag — the admin
 * demo-mode runtime toggle deliberately cannot open anonymous access in
 * production. Extracted like mountMcpPolicyRoutes so the exact production
 * wiring is exercised by tests/integration/aiProxyPolicyGate.routes.test.ts.
 */
export function mountAiProxyRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
  opts?: { isDemoRuntime?: () => boolean },
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = createAiProxyPolicyGate({
    tenantStatusGate,
    isDemoRuntime:
      opts?.isDemoRuntime ??
      (() => env.HOSTED_DEMO || (env.NODE_ENV !== 'production' && isDemoMode())),
  });
  app.use('/api/ai/proxy', gate, router);
}

export const CONTEXT_DEMO_ALLOWLIST: readonly { methods: readonly HttpMethod[]; pattern: RegExp }[] = [
  { methods: ['GET', 'HEAD'], pattern: /^\/[^/]+\/[^/]+\/[^/]+$/ },
];

export function mountContextRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
  opts?: { isDemoRuntime?: () => boolean; demoLimiter?: RequestHandler },
): void {
  const gate = createDemoFamilyPolicyGate({
    tenantStatusGate: makeTenantStatusGate(tenantSvc),
    demoAllowlist: CONTEXT_DEMO_ALLOWLIST,
    isDemoRuntime:
      opts?.isDemoRuntime ??
      (() => env.HOSTED_DEMO || (env.NODE_ENV !== 'production' && isDemoMode())),
    demoLimiter: opts?.demoLimiter,
  });
  app.use('/api/context', gate, router);
}

export const ACTIONS_DEMO_ALLOWLIST: readonly { methods: readonly HttpMethod[]; pattern: RegExp }[] = [
  {
    methods: ['POST'],
    pattern: /^\/(request-w9|pause-payments|send-reminder|escalate-csm|track-shipment|create-dispute)$/,
  },
];

export function mountActionIslandRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
  opts?: { isDemoRuntime?: () => boolean; demoLimiter?: RequestHandler },
): void {
  const gate = createDemoFamilyPolicyGate({
    tenantStatusGate: makeTenantStatusGate(tenantSvc),
    demoAllowlist: ACTIONS_DEMO_ALLOWLIST,
    isDemoRuntime:
      opts?.isDemoRuntime ??
      (() => env.HOSTED_DEMO || (env.NODE_ENV !== 'production' && isDemoMode())),
    demoLimiter: opts?.demoLimiter,
  });
  app.use('/api/actions', gate, router);
}

export const HELP_DEMO_ALLOWLIST: readonly { methods: readonly HttpMethod[]; pattern: RegExp }[] = [
  { methods: ['POST'], pattern: /^\/chat$/ },
  { methods: ['GET', 'HEAD'], pattern: /^\/(audiences|status)$/ },
];

export function mountHelpRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
  opts?: { isDemoRuntime?: () => boolean; demoLimiter?: RequestHandler },
): void {
  const gate = createDemoFamilyPolicyGate({
    tenantStatusGate: makeTenantStatusGate(tenantSvc),
    demoAllowlist: HELP_DEMO_ALLOWLIST,
    isDemoRuntime:
      opts?.isDemoRuntime ??
      (() => env.HOSTED_DEMO || (env.NODE_ENV !== 'production' && isDemoMode())),
    demoLimiter: opts?.demoLimiter,
  });
  app.use('/api/help', gate, router);
}

/**
 * F5 (design D5-F5): cost-transparency is an operator dashboard and has no
 * anonymous demo allowlist. The shared family gate therefore requires a
 * verified tenant JWT for dashboard/anomaly routes while retaining the exact
 * public /health probe declared in the route policy manifest.
 */
export function mountCostTransparencyRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
  opts?: { isDemoRuntime?: () => boolean; demoLimiter?: RequestHandler },
): void {
  const gate = createDemoFamilyPolicyGate({
    tenantStatusGate: makeTenantStatusGate(tenantSvc),
    demoAllowlist: [],
    isDemoRuntime:
      opts?.isDemoRuntime ??
      (() => env.HOSTED_DEMO || (env.NODE_ENV !== 'production' && isDemoMode())),
    demoLimiter: opts?.demoLimiter,
  });
  app.use('/api/cost-transparency', gate, router);
}

/**
 * F5b: per-family anonymous demo READ allowlists for the twelve *-central
 * dashboard families. Every entry is GET/HEAD only — no write endpoint on any
 * central family is anonymously reachable, even where a shipped demo page
 * calls one today (plan "Intentional demo breakage"). Entries are justified
 * one-for-one by the verified anonymous caller inventory in
 * docs/superpowers/plans/2026-07-27-f5b-central-families-strict.md; the
 * manifest declares the coarse posture and THIS table is the fail-closed
 * exact matcher — a request must satisfy both.
 *
 * `demoReads` is the only entry constructor, so the reads-only rule is
 * structural: there is no way to spell a mutating method in this table.
 */
const SAFE_METHODS: readonly HttpMethod[] = Object.freeze(['GET', 'HEAD']);

const demoReads = (...patterns: readonly RegExp[]): readonly DemoAllowlistEntry[] =>
  Object.freeze(patterns.map((pattern) => Object.freeze({ methods: SAFE_METHODS, pattern })));

export const CENTRAL_FAMILY_DEMO_ALLOWLISTS: Readonly<
  Record<string, readonly DemoAllowlistEntry[]>
> = Object.freeze({
  '/api/payment-central': demoReads(
    /^\/dashboard$/,
    /^\/analytics$/,
    /^\/processors$/,
    /^\/transactions$/,
    /^\/invoices$/,
    /^\/invoices\/statistics$/,
    /^\/disputes$/,
    /^\/credit-memos$/,
  ),
  '/api/supplier-central': demoReads(
    /^\/dashboard$/,
    /^\/vendors$/,
    /^\/vendors\/[^/]+$/,
    /^\/vendors\/[^/]+\/purchase-orders$/,
  ),
  '/api/customer-central': demoReads(/^\/dashboard$/),
  '/api/quality-central': demoReads(/^\/dashboard$/),
  '/api/payout-central': demoReads(/^\/dashboard$/),
  '/api/installer-central': demoReads(/^\/dashboard$/),
  '/api/service-central': demoReads(/^\/dashboard$/),
  '/api/inventory-central': demoReads(/^\/dashboard$/),
  '/api/finance-central': demoReads(/^\/dashboard$/),
  '/api/contract-central': demoReads(/^\/dashboard$/),
  // No shipped page calls /api/portal-central. Empty allowlist = fully strict,
  // the /api/cost-transparency precedent.
  '/api/portal-central': demoReads(),
  '/api/workflow-central': demoReads(/^\/dashboard$/),
});

/**
 * F5b: mount one *-central family behind the shared F5 demo-family policy
 * gate. Table-driven rather than one exported function per family because the
 * twelve mounts differ only in prefix + allowlist; the production-wiring test
 * asserts per-prefix behavior, so a dropped mount is still caught.
 */
export function mountCentralFamilyRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  prefix: string,
  router: RequestHandler,
  demoAllowlist: readonly DemoAllowlistEntry[],
  opts?: { isDemoRuntime?: () => boolean; demoLimiter?: RequestHandler },
): void {
  const gate = createDemoFamilyPolicyGate({
    tenantStatusGate: makeTenantStatusGate(tenantSvc),
    demoAllowlist,
    isDemoRuntime:
      opts?.isDemoRuntime ??
      (() => env.HOSTED_DEMO || (env.NODE_ENV !== 'production' && isDemoMode())),
    demoLimiter: opts?.demoLimiter,
  });
  app.use(prefix, gate, router);
}

/**
 * F3 (design D5-F3): /api/reconciliation-center and /api/lineage are strict
 * operator surfaces — authMiddleware fronts them unconditionally (anonymous
 * → 401; the REQUIRE_CENTRAL_AUTH=false demo relaxation of
 * centralAuthMiddleware no longer applies) and the tenant-lifecycle kill
 * switch runs before the router (suspended tenant → 403 tenant_blocked;
 * tenant-less token → fail-closed 403 tenant_id_missing). Extracted like
 * mountMcpPolicyRoutes so the exact production wiring is exercised by
 * tests/integration/reconciliationLineageTenantStatusGate.routes.test.ts —
 * dropping the gate or authMiddleware here fails that test.
 */
export function mountReconciliationCenterRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/reconciliation-center', authMiddleware, gate, router);
}

/** See mountReconciliationCenterRoutes — same F3 posture for /api/lineage. */
export function mountLineageRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/lineage', authMiddleware, gate, router);
}

/**
 * Tenant-scoped mount for the fixture-connector family (F6 sub-project B).
 *
 * `routePolicy.ts` has always declared this prefix `auth: 'required'` /
 * `lifecycle: 'enforce'`, but before F6 sub-project B the family was mounted
 * BARE and the central gate was permissive when tenant context was absent.
 * So an anonymous POST reached `guardedWrite` and
 * wrote a durable audit_logs row under the retired system sentinel. This
 * makes the runtime match the declaration.
 *
 * No shipped page calls /api/fixtures — its only caller was the credentials
 * endpoint deleted in PR #1084.
 */
export function mountFixtureConnectorRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/fixtures', authMiddleware, gate, router);
}

/**
 * F4 (design D5-F4): ERP write-family mounts.
 *
 * Platform-global shape (hubspot, shipstation, SuiteCentral syncs): these
 * routes operate deployment-global connector/integration state (singleton
 * env-configured connectors; the global IntegrationService), so they are
 * platform-admin surfaces — a tenant JWT must not operate shared ERP state.
 * Tenant-scoped ERP writes go through /api/integrations. No tenant kill
 * switch: non-admin JWTs 403 regardless of tenant status, and admin tokens
 * keep remediation access (same posture as /api/admin/tenants).
 *
 * Tenant shape (nl-action-gate): authMiddleware + tenant-lifecycle kill
 * switch; the action store is tenant-scoped in NLActionGateService.
 *
 * In BOTH shapes the shared erp-write limiter runs AFTER auth/authz so
 * rejected traffic never consumes write budget. `limiter` is injectable
 * ONLY for the ordering assertions in
 * tests/integration/erpWriteFamiliesTenantStatusGate.routes.test.ts;
 * production call sites pass nothing and share ONE erpWriteRateLimit
 * instance (single mutating-write budget per (IP, user)).
 */
export function mountHubSpotRoutes(
  app: Application,
  router: RequestHandler,
  limiter: RequestHandler = erpWriteRateLimit,
): void {
  app.use('/api/hubspot', authMiddleware, requirePlatformAdmin, limiter, router);
}

/** See mountHubSpotRoutes — same platform-global F4 shape. */
export function mountShipStationRoutes(
  app: Application,
  router: RequestHandler,
  limiter: RequestHandler = erpWriteRateLimit,
): void {
  app.use('/api/shipstation', authMiddleware, requirePlatformAdmin, limiter, router);
}

/** See mountHubSpotRoutes — same platform-global F4 shape, three sync paths. */
export function mountSuiteCentralSyncRoutes(
  app: Application,
  routers: { sync: RequestHandler; netsuiteSync: RequestHandler; squireNetsuiteSync: RequestHandler },
  limiter: RequestHandler = erpWriteRateLimit,
): void {
  app.use('/api/suitecentral/sync', authMiddleware, requirePlatformAdmin, limiter, routers.sync);
  app.use('/api/suitecentral/netsuite/sync', authMiddleware, requirePlatformAdmin, limiter, routers.netsuiteSync);
  app.use('/api/squire/suitecentral/netsuite/sync', authMiddleware, requirePlatformAdmin, limiter, routers.squireNetsuiteSync);
}

/**
 * F4-shaped mount for the full-pipeline demo family.
 *
 * Platform-global, not tenant-scoped: the pipeline drives deployment-global,
 * environment-configured connector instances, so a tenant JWT must not reach
 * it. The ENTIRE prefix is operator-only — the three GET endpoints included,
 * because `/metrics` returns deployment-global SuiteCentral aggregates and no
 * caller anywhere in `public/**` depends on anonymous access to any of them.
 *
 * `erpWriteRateLimit` is already wrapped by `limitMutatingMethods`, so those
 * GETs reach the router without consuming write budget.
 *
 * NOTE on budget accounting: this chain guarantees that rejected AUTH and
 * AUTHZ attempts never consume budget. It does not extend to the handler's
 * own `identity_required` refusal, which is raised after the limiter — see
 * the design's section 1. That case is accepted: the caller has already
 * cleared requirePlatformAdmin, so it is a misconfigured operator rather than
 * untrusted traffic.
 *
 * `limiter` is a test seam ONLY; production passes nothing and shares the one
 * module-level `erpWriteRateLimit` instance, so this family draws on the same
 * (IP, user) budget as every other ERP write family.
 */
export function mountFullPipelineDemoRoutes(
  app: Application,
  router: RequestHandler,
  limiter: RequestHandler = erpWriteRateLimit,
): void {
  app.use('/api/full-pipeline-demo', authMiddleware, requirePlatformAdmin, limiter, router);
}

/** See the F4 block comment — tenant shape: auth + kill switch + limiter. */
export function mountNlActionGateRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
  limiter: RequestHandler = erpWriteRateLimit,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/nl-action-gate', authMiddleware, gate, limiter, router);
}

/**
 * Tenant-scoped ERP write mount (PR 13c-4 auth posture; hardened by review
 * on PR #1055). Chain matches the nl-action-gate tenant shape AND the
 * routePolicy row (`auth: 'required'`, `lifecycle: 'enforce'`):
 * authMiddleware → tenant-lifecycle kill switch → shared erp-write limiter.
 * Auth runs BEFORE the limiter so the (IP, user) key sees the verified user
 * — previously the limiter ran first and keyed every caller as `anonymous`,
 * fragmenting the cross-family budget and letting rejected anonymous
 * traffic consume it (Codex R1). The kill switch was previously absent
 * entirely — a suspended tenant's valid JWT could still run integrations
 * (Codex R2). Production mounts through THIS helper from src/index.ts (the
 * late async-DI mount is the sole production entry point; RouteSetup's own
 * integration block only runs when integrationService is injected early,
 * i.e. tests) so both paths share the module-level limiter instance.
 * Handlers additionally narrow on req.user?.tenantId so a malformed JWT or
 * upstream regression fails closed. Pinned by
 * tests/integration/erpWriteFamiliesTenantStatusGate.routes.test.ts.
 */
export function mountIntegrationRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
  limiter: RequestHandler = erpWriteRateLimit,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/integrations', authMiddleware, gate, limiter, router);
}

/**
 * Configuration family mount (cardinality-preflight design, Task 9). Chain
 * matches the routePolicy row (`auth: 'required'`, `lifecycle: 'enforce'`):
 * authMiddleware → tenant-lifecycle kill switch → router. The kill switch was
 * previously absent, so a suspended tenant's valid JWT could still create,
 * update, import, or ACTIVATE a configuration. Extracted like
 * mountIntegrationRoutes so the exact production wiring is exercised by
 * tests/integration/configurationTenantStatusGate.routes.test.ts — dropping
 * the gate or authMiddleware here fails that test.
 */
export function mountConfigurationRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/configurations', authMiddleware, gate, router);
}

/**
 * Tenant-scoped mount for the SecureCredentialManager reference store.
 * Credential writes and deletes must observe the same tenant lifecycle
 * kill switch as the other tenant-required write families.
 */
export function mountSecureCredentialRoutes(
  app: Application,
  tenantSvc: TenantLifecycleService,
  router: RequestHandler,
): void {
  const tenantStatusGate = makeTenantStatusGate(tenantSvc);
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    tenantStatusGate(req, res, next).catch(next);
  };
  app.use('/api/credentials', authMiddleware, gate, erpWriteRateLimit, router);
}

/**
 * The minimal structural view of the DI container the configuration-router
 * composition root needs. Declared here (rather than importing Inversify's
 * `Container`) so the wiring can be exercised with a stub in a unit test.
 */
export interface ConfigurationRouterContainer {
  get<T>(serviceIdentifier: symbol): T;
}

/**
 * The SINGLE composition root for `/api/configurations`.
 *
 * Every dependency the router needs is resolved here and passed as a REQUIRED
 * argument to `createConfigurationRouter`. That is deliberate: a route added to
 * the router without also being wired here compiles, passes any test that
 * hand-constructs the router, and is DEAD IN PRODUCTION (or worse, fails closed
 * at runtime for every real caller). Routing production through one typed
 * builder makes that class of drift a compile error instead of a silent gap.
 *
 * Kept as a dynamic import so RouteSetup's lazy route-loading behavior is
 * unchanged.
 */
export async function createProductionConfigurationRouter(
  container: ConfigurationRouterContainer,
  configurationService: ConfigurationService,
): Promise<RequestHandler> {
  const { createConfigurationRouter } = await import('../../routes/configuration');
  const { TYPES } = await import('../../inversify/types');
  return createConfigurationRouter({
    configurationService,
    // The trusted preflight coordinator backs POST /cardinality-preflight.
    // Resolved (not constructed) so the route and the activation gate share
    // one coordinator instance.
    cardinalityPreflight: container.get<CardinalityPreflight>(TYPES.CardinalityPreflightService),
    // Task 6: the live activation-readiness evaluator backing
    // POST /:id/serialized-asset-readiness. The same evaluator instance sits
    // behind the specialized ConfigurationActivationGuard, so the report the
    // operator reads and the gate that refuses activation cannot disagree.
    serializedAssetReadiness: container.get<SerializedAssetReadinessEvaluator>(
      TYPES.SerializedAssetReadinessService,
    ),
  });
}

/**
 * Configuration for route setup
 */
export interface RouteConfig {
  /** @deprecated PR 1B: absorbed into /api/ai/proxy. Kept for interface compat; unused at runtime. */
  enableAIProvider?: boolean;
  enableMappings?: boolean;
  enableMappingTemplates?: boolean;
  enableDocs?: boolean;
  enableMetrics?: boolean;
  enableSwagger?: boolean;
  enableSuiteCentralSync?: boolean;
  enableConfiguration?: boolean;
  enableIntegration?: boolean;
  enableFileUpload?: boolean;
  enableTesting?: boolean;
  enableDownloadMaterials?: boolean;
  enableAIDemo?: boolean;
  enableAIMapping?: boolean;
  enableDataMigration?: boolean;
  enableROIDashboard?: boolean;
  enableFullPipelineDemo?: boolean;
  enableOperationalDashboard?: boolean;
  enableAIServices?: boolean;
  enableDisasterRecovery?: boolean;
  enableFeatureFlags?: boolean;
  enableEnterpriseFeatures?: boolean;
  enableSettings?: boolean;
}

/**
 * Default route configuration.
 *
 * Frozen so a caller cannot mutate a security-relevant default in place before
 * a `RouteSetup` is constructed. Per-instance overrides go through the
 * constructor's `config` argument, which is spread into a fresh object.
 */
export const DEFAULT_ROUTE_CONFIG: Required<RouteConfig> = Object.freeze({
  enableAIProvider: true, // deprecated (PR 1B) — no longer consumed
  enableMappings: true,
  enableMappingTemplates: true,
  enableDocs: true,
  enableMetrics: true,
  enableSwagger: true,
  enableSuiteCentralSync: true,
  enableConfiguration: true,
  enableIntegration: true,
  enableFileUpload: true,
  enableTesting: true,
  enableDownloadMaterials: true,
  enableAIDemo: true,
  enableAIMapping: true,
  enableDataMigration: true,
  enableROIDashboard: true,
  enableFullPipelineDemo: true,
  enableOperationalDashboard: true,
  enableAIServices: true,
  enableDisasterRecovery: true,
  enableFeatureFlags: true,
  enableEnterpriseFeatures: true,
  enableSettings: true,
});

/**
 * Route setup class for organizing route mounting
 */
export class RouteSetup {
  private app: Application;
  private config: Required<RouteConfig>;
  private integrationService?: IntegrationService;
  private configurationService?: ConfigurationService;
  private knowledgeBase?: DocumentationKnowledgeBase; // Phase 2: Help Chat RAG integration
  private fileExistsCache = new Map<string, boolean>();

  constructor(
    app: Application,
    config: RouteConfig = {},
    services?: {
      integrationService?: IntegrationService;
      configurationService?: ConfigurationService;
      knowledgeBase?: DocumentationKnowledgeBase; // Phase 2: DocumentationKnowledgeBase for AI service enhancement
    }
  ) {
    this.app = app;
    this.config = { ...DEFAULT_ROUTE_CONFIG, ...config };
    this.integrationService = services?.integrationService;
    this.configurationService = services?.configurationService;
    this.knowledgeBase = services?.knowledgeBase; // Phase 2: Store for AI router
  }

  /**
   * Setup all routes
   */
  async setupAll(): Promise<void> {
    await this.setupAPIRoutes();
    await this.setupSuiteCentralRoutes();
    await this.setupDashboardRoutes();
    await this.setupDemoRoutes();
    await this.setupDocumentationRoutes();
    await this.setupFallbackRoutes();
  }

  /**
   * Setup API routes
   */
  private async setupAPIRoutes(): Promise<void> {
    // PR 2C-Auth: optional JWT auth on every /api/* request that hits a
    // router mounted by THIS method (`App.setupRoutes` → `setupAPIRoutes`).
    // When a Bearer JWT against JWT_SECRET is present, populates req.user
    // with a normalized tenantId/userId/roles set from the verified claims.
    // An absent JWT is tolerated here so exact public, demo, and embedded-session deferrals
    // can reach their route-owned gates. Other tenant-required requests are
    // refused by the strict central boundary before their handlers run.
    //
    // Scope exception: `GET /api/statistics` is registered in
    // `Server.mountRouters()` (src/index.ts) at construction time, BEFORE
    // `App.initializeServices()` awaits into `setupRoutes()`. Express
    // dispatches that handler before this middleware runs, so the global
    // optional auth does NOT execute for that endpoint — instead it carries
    // its OWN route-level `authMiddleware` (required auth; it returns
    // cross-tenant aggregate config metadata). It stays classified `system`
    // (admin/ops diagnostic, not tenant-scoped) in the route manifest and
    // short-circuits the central tenant gate.
    //
    // Order matters:
    //   1. optionalAuthMiddleware  ← here  (populates req.user)
    //   2. mountCentralTenantGate          (populates req.tenantContext for
    //                                       tenant_required paths via JWT
    //                                       extraction inside tenantIsolation)
    //   3. router handlers                 (read identity via
    //                                       extractIdentityContext, which
    //                                       reads req.auth → req.user →
    //                                       req.tenantContext in that order)
    //
    // Several routes below in this method mount `authMiddleware` explicitly
    // for strict auth (e.g. `/api/mcp`, `/api/dashboard`,
    // `/api/admin/tenants`, `/api/compliance`, and the conditional
    // `centralAuthMiddleware` on the *-central surfaces when
    // REQUIRE_CENTRAL_AUTH=true). The global optionalAuthMiddleware here is
    // idempotent with those strict mounts: it sets req.user when a valid
    // Bearer JWT is present and no-ops otherwise; the per-route
    // authMiddleware then re-verifies and either 401s (no Bearer) or sets
    // req.user (same result for valid Bearer). End-state behavior on
    // strict-auth routes is unchanged from pre-PR-2C-Auth. The newly-active
    // surface is the OTHER /api/* routes — they previously fell through to
    // SYSTEM_IDENTITY for every request; now a Bearer JWT propagates
    // identity through extractIdentityContext.
    //
    // Out of scope here: `/metrics` is mounted in `setupDashboardRoutes()`
    // with its own `authMiddleware`, and it's NOT under `/api/*` so this
    // global mount never reaches it. Same applies to any other non-/api
    // route in the app.
    this.app.use('/api', optionalAuthMiddleware);

    // PR 4B: Central tenant-isolation gate. Single mount point consults
    // ROUTE_MANIFEST and dispatches tenantIsolation for tenant_required
    // paths. `disableHeaderExtraction: true` (R4 security invariant, frozen
    // by `audit-status-claims --check-tenant-isolation-invariant`) means
    // req.tenantContext is only populated from verified sources: a Bearer
    // JWT against JWT_SECRET, a configured resolveTenant callback, or a
    // trustedTenants fast-path. The un-verified x-tenant-id header does NOT
    // populate req.tenantContext — direct consumers like
    // src/routes/mcpPolicies.ts are therefore safe to read it without
    // re-validating.
    //
    // PR 2C-Auth added the req.tenantContext → identity bridge inside
    // extractIdentityContext (third source after req.auth and req.user).
    // The bridge inherits this invariant: req.tenantContext can ONLY hold a
    // verified identity at the gate-mount layer.
    // Strict isolation owns missing-context refusals for non-deferred paths.
    // Deferrals still run the populate-only instance so verified tenant
    // context is available to route-owned auth, attribution, and DLP consumers.
    mountCentralTenantGate(this.app, { strictMode: true });

    // AI Proxy routes — F2: policy-gated mount (auth + kill switch; demo
    // allowlist anonymous only under a demo runtime). See mountAiProxyRoutes.
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { createAIProxyRouter } = await import('../../routes/aiProxy');
        const container = (await import('../../inversify/inversify.config')).container;
        const { TYPES } = await import('../../inversify/types');
        const tenantSvc = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
        mountAiProxyRoutes(this.app, tenantSvc, await createAIProxyRouter({
          knowledgeBase: this.knowledgeBase,
        }));
      }, 'AI Proxy routes');
    }

    // AI Provider routes — absorbed into proxy tree (PR 1B).
    // enableAIProvider config flag deprecated; provider-config
    // endpoints live under /api/ai/proxy and are gated by enableAIServices.

    // AI Configuration routes
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { createAIConfigRouter } = await import('../../routes/aiConfig');
        const aiConfigRouter = createAIConfigRouter();
        this.app.use(aiConfigRouter);
      }, 'AI Configuration routes');
    }

    // Settings routes
    if (this.config.enableSettings) {
      await this.safeRouteSetup(async () => {
        const { createSettingsRouter } = await import('../../routes/settings');
        this.app.use('/api/settings', await createSettingsRouter());
      }, 'Settings routes');
    }

    // MCP policy management routes (DB-backed tenant policy CRUD).
    // F1: behind the tenant-lifecycle kill switch via mountMcpPolicyRoutes.
    await this.safeRouteSetup(async () => {
      const { createMCPPolicyRouter } = await import('../../routes/mcpPolicies');
      const container = (await import('../../inversify/inversify.config')).container;
      const { TYPES } = await import('../../inversify/types');
      // getAsync — TenantLifecycleService depends on async-bound repositories.
      // Type-only use of the top-level `import type { TenantLifecycleService }`;
      // no runtime import needed (Copilot R3 on PR #1038).
      const tenantSvc = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
      mountMcpPolicyRoutes(this.app, tenantSvc, await createMCPPolicyRouter());
    }, 'MCP Policy routes');

    // Mappings routes
    if (this.config.enableMappings) {
      await this.safeRouteSetup(async () => {
        const { createMappingsRouter } = await import('../../routes/mappings');
        const mappingsRouter = createMappingsRouter();
        this.app.use('/api/mappings', mappingsRouter);
        this.app.use('/api/dashboard/api/mappings', mappingsRouter);
        this.app.use('/api/dashboard/mappings', mappingsRouter);
      }, 'Mappings routes');
    }

    // Mapping Templates routes (legacy - kept for backwards compatibility)
    if (this.config.enableMappingTemplates) {
      await this.safeRouteSetup(async () => {
        const { createMappingTemplatesRouter } = await import('../../routes/mappingTemplates');
        const templatesRouter = createMappingTemplatesRouter();
        this.app.use('/api/mappings/templates', templatesRouter);
        this.app.use('/api/dashboard/mappings/templates', templatesRouter);
      }, 'Mapping Templates routes');
    }

    // Unified Templates routes (new enhanced system)
    if (this.config.enableMappingTemplates) {
      await this.safeRouteSetup(async () => {
        const { createUnifiedTemplatesRouter } = await import('../../routes/unifiedTemplates');
        const unifiedRouter = createUnifiedTemplatesRouter();
        this.app.use('/api/templates', unifiedRouter);
        this.app.use('/api/dashboard/templates', unifiedRouter);
      }, 'Unified Templates routes');
    }

    // Configuration routes
    if (this.config.enableConfiguration && this.configurationService) {
      await this.safeRouteSetup(async () => {
        const container = (await import('../../inversify/inversify.config')).container;
        const TYPES = (await import('../../inversify/types')).TYPES;
        // getAsync — TenantLifecycleService depends on async-bound repositories.
        const tenantSvc = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
        // PR 13c-4 Task 7: router refactored to router-relative paths (base='',
        // publicBase='/api/configurations' for response URLs) so it can mount at
        // a real sub-path with authMiddleware. Anonymous callers now 401 at the
        // middleware; authenticated callers reach handlers with req.user.tenantId
        // populated. Handlers additionally narrow on req.user?.tenantId so a
        // malformed JWT or upstream regression fails closed. Task 9 adds the
        // tenant-lifecycle kill switch via mountConfigurationRoutes.
        mountConfigurationRoutes(
          this.app,
          tenantSvc,
          await createProductionConfigurationRouter(container, this.configurationService!),
        );
      }, 'Configuration routes');
    }

    // Connector Credentials routes (Encrypted credential storage for connectors)
    await this.safeRouteSetup(async () => {
      const { createConnectorCredentialRouter } = await import('../../routes/connectorCredential');
      this.app.use('/api', await createConnectorCredentialRouter());
    }, 'Connector Credentials routes');

    // SecureCredentialManager routes are the reference store consumed by the
    // A2 ConnectorCredentialResolver. Keep this surface separate from the
    // connector-credential database routes above so hosted references resolve
    // against the same manager that accepts the secret write.
    await this.safeRouteSetup(async () => {
      const { secureCredentialsRouter } = await import('../../routes/secureCredentials');
      const container = (await import('../../inversify/inversify.config')).container;
      const { TYPES } = await import('../../inversify/types');
      const tenantSvc = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
      mountSecureCredentialRoutes(this.app, tenantSvc, secureCredentialsRouter);
    }, 'Secure credential routes');

    // Identity whoami route (display-only; powers the top-rail Admin menu).
    // Sits behind the global /api optionalAuthMiddleware. F6 sub-project B:
    // resolves directly from the verified req.user — shows the real user only
    // when BOTH id and tenantId are non-empty and NEITHER is the system
    // sentinel. Tenant-less JWTs, JWTs claiming the sentinel, and
    // unauthenticated callers all get the demo fallback.
    await this.safeRouteSetup(async () => {
      const { default: identityRouter } = await import('../../routes/identityRoutes');
      this.app.use('/api/identity', identityRouter);
    }, 'Identity route');

    // Integration routes
    if (this.config.enableIntegration && this.integrationService) {
      await this.safeRouteSetup(async () => {
        const { createIntegrationRouter } = await import('../../routes/integration');
        const container = (await import('../../inversify/inversify.config')).container;
        const TYPES = (await import('../../inversify/types')).TYPES;
        const tenantSvc = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
        mountIntegrationRoutes(this.app, tenantSvc, createIntegrationRouter(this.integrationService!));
      }, 'Integration routes');
    }

    // File Upload routes
    if (this.config.enableFileUpload) {
      await this.safeRouteSetup(async () => {
        const { createFileUploadRouter } = await import('../../routes/fileUpload');
        this.app.use('/api/upload', createFileUploadRouter());
      }, 'File Upload routes');
    }

    // Testing routes
    if (this.config.enableTesting) {
      await this.safeRouteSetup(async () => {
        const { createTestingRouter } = await import('../../routes/testing');
        this.app.use('/api/testing', createTestingRouter());
      }, 'Testing routes');
    }

    // Connector Test routes (Connection testing for all connector types)
    await this.safeRouteSetup(async () => {
      const connectorTestModule = await import('../../routes/connectorTest');
      const connectorTestRouter = getDefaultExport(connectorTestModule as DynamicModule);
      this.app.use('/api', connectorTestRouter);
    }, 'Connector Test routes');

    // Fixture Connector routes (Mock connectors with realistic fixture data)
    await this.safeRouteSetup(async () => {
      const fixtureModule = await import('../../routes/fixtureConnectors');
      const fixtureRouter = getDefaultExport(fixtureModule as DynamicModule);
      const container = (await import('../../inversify/inversify.config')).container;
      const { TYPES } = await import('../../inversify/types');
      const tenantSvc = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
      mountFixtureConnectorRoutes(this.app, tenantSvc, fixtureRouter);
    }, 'Fixture Connector routes');

    // Week 0 Baseline Metrics routes (Gemini enhancement - measurement infrastructure)
    await this.safeRouteSetup(async () => {
      const baselineModule = await import('../../routes/baselineMetrics');
      const baselineRouter = getDefaultExport(baselineModule as DynamicModule);
      this.app.use('/api/baselines', baselineRouter);
    }, 'Week 0 Baseline Metrics routes');

    // [PR 1B] Direct-family AI routes removed — consolidated into /api/ai/proxy.
    // createAIRouter (field mapping, BI, NL, etc.) and createSecureAIRoutes
    // are now served by the proxy router. A 301 redirect shim below provides
    // backwards compatibility for clients still using the old paths.

    // Phase 1 Backend Persistence (replaces localStorage)
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { createMappingPersistenceRoutes } = await import('../../routes/mappingPersistence');
        const persistenceRouter = createMappingPersistenceRoutes(logger);
        this.app.use('/api/persistence', persistenceRouter); // Mount at /api/persistence for backend storage
      }, 'Phase 1 Backend Persistence routes');
    }

    // Week 7 Predictive Analytics routes (forecasting, issue detection, performance optimization)
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const predictiveAnalyticsModule = await import('../../routes/predictiveAnalyticsSimple');
        const predictiveAnalyticsRouter = getDefaultExport(predictiveAnalyticsModule as DynamicModule);
        this.app.use('/api/predictive-analytics', predictiveAnalyticsRouter);
      }, 'Week 7 Predictive Analytics routes');
    }

    // Week 8 Executive Reporting routes (business intelligence, strategic insights)
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const executiveReportingModule = await import('../../routes/executiveReporting');
        const executiveReportingRouter = getDefaultExport(executiveReportingModule as DynamicModule);
        this.app.use('/api/executive', executiveReportingRouter);
      }, 'Week 8 Executive Reporting routes');
    }

    // AI Agents Multi-Agent Orchestrator routes
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { createAgentsRouter } = await import('../../routes/agents');
        const agentsRouter = await createAgentsRouter();
        this.app.use('/api/agents', agentsRouter);
      }, 'AI Agents Multi-Agent Orchestrator routes');
    }

    // [PR 1B] CrossModuleMetrics and Phase2AI routers migrated to /api/ai/proxy.
    // Previously mounted at /api/ai — now served by MetricsNLQRouter and Phase2Router
    // sub-routers within the proxy aggregator.

    // [PR 1B] Redirect shim — backwards compatibility for direct-family paths.
    // All /api/ai/* requests (except /api/ai/proxy and /api/ai-demo) are redirected
    // to /api/ai/proxy/*. Uses 308 for non-GET methods to preserve request method/body.
    // This shim stays until explicitly removed in a future PR.
    if (this.config.enableAIServices) {
      this.app.use('/api/ai', (req, res, next) => {
        // Skip paths already handled by the proxy and demo routers
        if (
          req.originalUrl.startsWith('/api/ai/proxy') ||
          req.originalUrl.startsWith('/api/ai-demo')
        ) {
          return next();
        }
        const proxyUrl = getAIProxyRedirectUrl(req.originalUrl);
        // 308 for POST/PUT/PATCH/DELETE (method-preserving), 301 for GET/HEAD
        const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
        res.redirect(status, proxyUrl);
      });
    }

    // Context Sidecar API routes (Killer App feature - context-aware embedded intelligence)
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { contextRouter } = await import('../../routes/ContextRouter');
        const container = (await import('../../inversify/inversify.config')).container;
        const { TYPES } = await import('../../inversify/types');
        const tenantSvc = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
        mountContextRoutes(this.app, tenantSvc, contextRouter);
      }, 'Context Sidecar API routes');
    }

    // PR 10a: Embedded ERP Surface Contract — host bootstrap, guest context,
    // session teardown, and the session-expired interstitial. The static
    // session-expired.html MUST go through embeddedCspMiddleware (NOT
    // Express's default static), so it's mounted here alongside the dynamic
    // routes — locking the CSP header onto the response.
    await this.safeRouteSetup(async () => {
      const { hostBootstrapRouter } = await import('../../routes/embedded/hostBootstrapRouter');
      const { contextBootstrapRouter } = await import('../../routes/embedded/contextBootstrapRouter');
      const { sessionTeardownRouter } = await import('../../routes/embedded/sessionTeardownRouter');
      const { embeddedCspMiddleware, sessionExpiredHandler } = await import('../embeddedCspMiddleware');
      const { sendEmbeddedHtml } = await import('../embeddedHtmlHandler');
      this.app.use('/api/embedded/host-bootstrap', embeddedCspMiddleware, hostBootstrapRouter);
      this.app.use('/api/embedded/context', embeddedCspMiddleware, contextBootstrapRouter);
      this.app.use('/api/embedded/sessions', embeddedCspMiddleware, sessionTeardownRouter);
      this.app.get('/embedded/session-expired.html', embeddedCspMiddleware, sessionExpiredHandler);
      // PR 17b: sync-error-triage operator UI. Mounted on a dedicated route
      // INSIDE the embedded block so it inherits embeddedCspMiddleware (the
      // frame-ancestors gate). NOT in the htmlFiles whitelist — that path
      // emits cache headers but no CSP.
      this.app.get(
        '/embedded/sync-error-triage.html',
        embeddedCspMiddleware,
        sendEmbeddedHtml('sync-error-triage.html'),
      );
      // PR 3C: HITL governance-approvals operator UI. Same posture as
      // sync-error-triage — inside the embedded block so embeddedCspMiddleware
      // applies. The API behind it (`/api/governance/approvals/*`) is gated
      // separately by `validateGuestContext` + `requireApproverRole` (see
      // `src/routes/governance/approvalsRouter.ts`).
      this.app.get(
        '/embedded/approvals.html',
        embeddedCspMiddleware,
        sendEmbeddedHtml('approvals.html'),
      );
      // PR 12 follow-up: Record Lineage operator UI. Same posture as
      // approvals + sync-error-triage. The API mount below (`/api/embedded/
      // lineage`) auths via `validateGuestContext` inside the router — the
      // session tenant_id scopes the query. NOT served from the htmlFiles
      // whitelist (no CSP there) per `embeddedHtmlHandler.ts` doc.
      this.app.get(
        '/embedded/lineage.html',
        embeddedCspMiddleware,
        sendEmbeddedHtml('lineage.html'),
      );
      // #862 follow-up (c): Reconciliation Center operator UI. Mounted here so
      // embeddedCspMiddleware attaches the frame-ancestors header. The root
      // express.static handler is skip-wrapped (skipEmbeddedHtml) so it no longer
      // shadows this (or any) CSP-routed /embedded/*.html page — see
      // src/middleware/embeddedHtmlRoutes.ts.
      this.app.get(
        '/embedded/reconciliation.html',
        embeddedCspMiddleware,
        sendEmbeddedHtml('reconciliation.html'),
      );
      try {
        const { embeddedLineageRouter } = await import('../../routes/embedded/embeddedLineageRouter');
        const { LineageQueryService } = await import('../../services/lineage/LineageQueryService');
        const { container } = await import('../../inversify/inversify.config');
        const { TYPES } = await import('../../inversify/types');
        const lineageService = await container.getAsync<InstanceType<typeof LineageQueryService>>(
          TYPES.LineageQueryService,
        );
        this.app.use(
          '/api/embedded/lineage',
          embeddedCspMiddleware,
          embeddedLineageRouter(lineageService),
        );
      } catch (err) {
        logger.warn(
          'Failed to mount /api/embedded/lineage; embedded lineage operator surface unavailable on this replica.',
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
      try {
        const { embeddedReconciliationRouter } = await import('../../routes/embedded/embeddedReconciliationRouter');
        const { ReconciliationCenterService } = await import('../../services/reconciliationCenter/ReconciliationCenterService');
        const { container } = await import('../../inversify/inversify.config');
        const { TYPES } = await import('../../inversify/types');
        const reconciliationService = await container.getAsync<InstanceType<typeof ReconciliationCenterService>>(
          TYPES.ReconciliationCenterService,
        );
        this.app.use(
          '/api/embedded/reconciliation',
          embeddedCspMiddleware,
          embeddedReconciliationRouter(reconciliationService),
        );
      } catch (err) {
        logger.warn(
          'Failed to mount /api/embedded/reconciliation; embedded reconciliation operator surface unavailable on this replica.',
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }, 'Embedded ERP Surface routes (PR 10a)');

    // PR 17a: Sync Error AI Assist — ingestion stub (returns 503 until enabled)
    await this.safeRouteSetup(async () => {
      const { syncErrorAssistRoutes } = await import('../../routes/syncErrorAssistRoutes');
      this.app.use(syncErrorAssistRoutes);
    }, 'Sync Error AI Assist routes (PR 17a)');

    // PR 3B + PR 3C: HITL approval-queue operator API. PR 3B shipped the
    // read-only slice (`GET /:id` polling endpoint); PR 3C layered the full
    // operator surface (`GET /` list, `POST /:id/approve`, `POST /:id/reject`)
    // on top.
    //
    // **Authentication posture (dual, strict since F3)**. The mount itself
    // applies NO router-level auth middleware — the router's individual
    // route registrations carry the right gate per endpoint:
    //
    //   - `GET /:id` mounts `authMiddleware` (Bearer JWT required; anonymous
    //     → 401, superseding the PR #819 inline SYSTEM_IDENTITY check) +
    //     the tenant-lifecycle kill switch (suspended tenant → 403
    //     tenant_blocked; tenant-less token → 403 tenant_id_missing).
    //   - `GET /`, `POST /:id/approve`, `POST /:id/reject`,
    //     `POST /:id/reset-claim` apply `validateGuestContext` (embedded
    //     session + same-origin) + `requireActiveEmbeddedTenant` (F3
    //     embedded-session kill switch) + the role gate (`user_roles` JSON
    //     array). Tenant identity comes from the embedded session, NOT the
    //     JWT — the operator UI runs inside the iframe with a tenant-scoped
    //     session.
    //
    // See `src/routes/governance/approvalsRouter.ts` header for the
    // per-endpoint rationale. The two-tier posture exists because the polling
    // endpoint and the operator surface have different use cases (S2S poll
    // vs. embedded operator), so unifying them under one gate would either
    // break S2S polling (validateGuestContext rejects without Origin) or
    // weaken the operator surface (skip the embedded-session check).
    //
    // The WRITE/enqueue surface (route catches calling
    // `handleApprovalQueueError`) is identity-checked before the durable write
    // as of F6 PR4 Stage 2: an unattributable request is refused with a distinct
    // 500 rather than persisting a governance_approvals row under the retired
    // system sentinel. The broader route inventory in
    // [[project-pr-3b-route-audit-inventory]] remains the audit input for which
    // mounts should carry auth in the first place.
    await this.safeRouteSetup(async () => {
      const { approvalsRouter } = await import('../../routes/governance/approvalsRouter');
      this.app.use('/api/governance/approvals', approvalsRouter);
    }, 'Governance approvals router (PR 3B read-only + PR 3C operator surface)');

    // Governance operations dashboard (PR 13b Task 29) — read-only
    // ownership-rejections + loop-detections endpoints feeding the new
    // `public/governance-operations.html` operator UI. Mounted at
    // `/api/governance` (not `/api/governance/operations`) so the
    // router-relative paths resolve to `/api/governance/ownership-rejections`
    // and `/api/governance/loop-detections` per the URL contract.
    await this.safeRouteSetup(async () => {
      const { operationsRouter } = await import('../../routes/governance/operationsRouter');
      this.app.use('/api/governance', operationsRouter);
    }, 'Governance operations router (PR 13b ownership/loop dashboards)');

    // Action Island routes (Cross-system action execution)
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { actionIslandRouter } = await import('../../routes/ActionIslandRouter');
        const container = (await import('../../inversify/inversify.config')).container;
        const { TYPES } = await import('../../inversify/types');
        const tenantSvc = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
        mountActionIslandRoutes(this.app, tenantSvc, actionIslandRouter);
      }, 'Action Island routes');
    }

    // Document Aggregator routes (Universal Document Sidecar)
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { documentRouter } = await import('../../routes/DocumentRouter');
        this.app.use('/api/documents', documentRouter);
      }, 'Document Aggregator routes');
    }

    // Disaster Recovery routes
    if (this.config.enableDisasterRecovery) {
      await this.safeRouteSetup(async () => {
        const { createDisasterRecoveryRouter, createDisasterRecoveryDashboardRouter } = await import('../../routes/disasterRecovery');
        this.app.use('/api/disaster-recovery', createDisasterRecoveryRouter());
        this.app.use('/api/disaster-recovery/dashboard', createDisasterRecoveryDashboardRouter());
      }, 'Disaster Recovery routes');
    }

    if (this.config.enableFeatureFlags) {
      await this.safeRouteSetup(async () => {
        const { createFeatureFlagsRouter } = await import('../../routes/featureFlags');
        this.app.use('/api/feature-flags', createFeatureFlagsRouter());
      }, 'Feature Flags routes');
    }

    // Enterprise Features routes
    if (this.config.enableEnterpriseFeatures) {
      await this.safeRouteSetup(async () => {
        const { createEnterpriseFeaturesRouter } = await import('../../routes/enterpriseFeatures');
        this.app.use('/', createEnterpriseFeaturesRouter());
      }, 'Enterprise Features routes');
    }

    // Help Chat routes (Natural language documentation assistance)
    await this.safeRouteSetup(async () => {
      const { createHelpRouter } = await import('../../routes/help');
      // Help router initialization will be done in server.ts after services are ready
      // This is just a placeholder to indicate the route exists
      logger.debug('[RouteSetup] Help routes will be initialized after services startup');
    }, 'Help Chat routes (deferred initialization)');
  }

  /**
   * Setup dashboard routes
   */
  private async setupDashboardRoutes(): Promise<void> {
    // Metrics routes
    if (this.config.enableMetrics) {
      await this.safeRouteSetup(async () => {
        const { createMetricsRouter } = await import('../../routes/metrics');
        const metricsRouter = createMetricsRouter();
        // Always mount API metrics for internal use
        this.app.use('/api/metrics', metricsRouter);
        // If explicitly enabled, expose top-level /metrics protected by auth
        if (process.env.ENABLE_METRICS === 'true') {
          this.app.use('/metrics', authMiddleware, metricsRouter);
        }
      }, 'Metrics routes');
    }

    // ROI Dashboard routes
    if (this.config.enableROIDashboard) {
      await this.safeRouteSetup(async () => {
        logger.info('[RouteSetup] Loading ROI Dashboard router...');
        const { roiDashboardRouter } = await import('../../routes/roiDashboard');
        logger.info('[RouteSetup] Mounting ROI Dashboard router at /api/roi-dashboard');
        this.app.use('/api/roi-dashboard', roiDashboardRouter);
        logger.info('[RouteSetup] ROI Dashboard router mounted successfully');
      }, 'ROI Dashboard routes');
    }

    // Operational Dashboard routes
    if (this.config.enableOperationalDashboard) {
      await this.safeRouteSetup(async () => {
        const dashboardModule = await import('../../routes/dashboard');
        const dashboardInstance = new dashboardModule.OperationalDashboard();
        const dashboardRouter = dashboardInstance.getRouter();

        // If explicitly enabled, protect dashboard with auth
        if (process.env.ENABLE_DASHBOARD === 'true') {
          this.app.use('/api/dashboard', authMiddleware, dashboardRouter);
        } else {
          this.app.use('/api/dashboard', dashboardRouter);
        }
      }, 'Operational Dashboard routes');
    }
  }

  /**
   * Setup demo routes
   */
  private async setupDemoRoutes(): Promise<void> {
    // AI Demo routes
    if (this.config.enableAIDemo) {
      await this.safeRouteSetup(async () => {
        const { createAIDemoRouter } = await import('../../routes/aiDemo');
        this.app.use('/api/ai-demo', createAIDemoRouter());
      }, 'AI Demo routes');
    }

    // [PR 1B] AI Mapping and Quality Assessment routes removed.
    // Formerly at /api/ai/mapping and /api/ai/quality — now served by
    // MappingRouter and QualityRouter sub-routers within /api/ai/proxy.
    // The 301 redirect shim in setupAPIRoutes() handles backwards compat.

    // Data Migration routes
    if (this.config.enableDataMigration) {
      await this.safeRouteSetup(async () => {
        const dataMigrationModule = await import('../../routes/dataMigration');
        const dataMigrationRouter = getDefaultExport(dataMigrationModule as DynamicModule);
        this.app.use('/api/data-migration', dataMigrationRouter);
      }, 'Data Migration routes');
    }

    // Full Pipeline Demo routes
    if (this.config.enableFullPipelineDemo) {
      await this.safeRouteSetup(async () => {
        const { createFullPipelineDemoRouter } = await import('../../routes/fullPipelineDemo');
        mountFullPipelineDemoRoutes(this.app, createFullPipelineDemoRouter());
      }, 'Full Pipeline Demo routes');
    }

    // Download Materials routes
    if (this.config.enableDownloadMaterials && isDemo()) {
      await this.safeRouteSetup(async () => {
        const downloadModule = await import('../../routes/downloadMaterials');
        const downloadRouter = getDefaultExport(downloadModule as DynamicModule);
        this.app.use('/api/download', downloadRouter);
      }, 'Download Materials routes');
    }
  }

  /**
   * Setup documentation routes
   */
  private async setupDocumentationRoutes(): Promise<void> {
    // Documentation routes
    if (this.config.enableDocs) {
      await this.safeRouteSetup(async () => {
        const { createDocsRouter } = await import('../../routes/docs');
        this.app.use('/docs', createDocsRouter());
      }, 'Documentation routes');
    }

    // Admin: tenant kill switch — POST/GET /api/admin/tenants/:tenantId/status
    // Requires real authentication (authMiddleware) so req.user is populated for requireAdmin.
    // Mounted before the Central routes so the admin surface is clearly distinct.
    await this.safeRouteSetup(async () => {
      const { createAdminTenantStatusRouter } = await import('../../routes/adminTenantStatus');
      const adminTenantStatusRouter = await createAdminTenantStatusRouter();
      this.app.use('/api/admin/tenants', authMiddleware, adminTenantStatusRouter);
    }, 'Admin tenant status routes');

    // Admin: process-global runtime settings — POST /api/admin/settings/demo-mode
    // authMiddleware runs first so anonymous requests fail with 401 before
    // requirePlatformAdmin or body validation is reached.
    await this.safeRouteSetup(async () => {
      const { createAdminSettingsRouter } = await import('../../routes/adminSettings');
      this.app.use('/api/admin/settings', authMiddleware, await createAdminSettingsRouter());
    }, 'Admin settings routes');

    // Swagger routes
    if (this.config.enableSwagger) {
      await this.safeRouteSetup(async () => {
        const swaggerUi = await import('swagger-ui-express');
        const { swaggerSpec } = await import('../../config/swagger');
        this.app.use('/api-docs', swaggerUi.default.serve, swaggerUi.default.setup(swaggerSpec));
        // Serve bundled static openapi.yaml (manually authored) at project root if present
        try {
          const { readFile, access } = await import('fs/promises');
          const { join } = await import('path');
          // Prefer full spec if available
          const fullPath = join(process.cwd(), 'openapi.full.yaml');
          const basePath = join(process.cwd(), 'openapi.yaml');
          let specPath = basePath;
          try { await access(fullPath); specPath = fullPath; } catch { /* ignore */ }
          const yaml = await readFile(specPath, 'utf8');
          this.app.get('/openapi.yaml', (_req, res) => {
            res.setHeader('Content-Type', 'application/x-yaml');
            if (specPath.endsWith('openapi.full.yaml')) res.setHeader('X-OpenAPI-Variant', 'full');
            res.send(yaml);
          });
          // Also expose a JSON version for tooling: /openapi.json
          try {
            const jsYaml = (await import('js-yaml')).default;
            const parsed: unknown = jsYaml.load(yaml);
            this.app.get('/openapi.json', (_req, res) => {
              if (specPath.endsWith('openapi.full.yaml')) res.setHeader('X-OpenAPI-Variant', 'full');
              res.json(parsed);
            });
          } catch (e) {
            logger.warn('[swagger] Failed to parse openapi.yaml to JSON:', e instanceof Error ? e.message : e);
          }
          // Minimal Swagger UI referencing openapi.yaml (alternate to existing /api-docs UI)
          this.app.get('/swagger', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(`<!DOCTYPE html><html><head><title>Swagger UI</title><link rel=
              "stylesheet" href="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui.css" />
              <style>body{margin:0}</style></head><body><div id="swagger-ui"></div>
              <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-bundle.js"></script>
              <script>window.onload=()=>{window.ui=SwaggerUIBundle({url:'/openapi.yaml',dom_id:'#swagger-ui'});};</script>
              </body></html>`);
          });
          logger.info('[swagger] Mounted /openapi.yaml, /openapi.json and /swagger');
        } catch (err) {
          logger.warn('[swagger] openapi.yaml not found or could not be served:', err instanceof Error ? err.message : err);
        }
      }, 'Swagger routes');
    }
  }

  /**
   * Setup the SuiteCentral control plane, then the legacy sync routes.
   */
  async setupSuiteCentralRoutes(): Promise<void> {
    // SuiteCentral control plane (PR-A6). Three namespaces, one router factory:
    //
    //   /api/suitecentral/prod                    → tenant admins, own tenant only
    //   /api/admin/tenants/:tenantId/suitecentral → platform admins, any tenant
    //   /api/admin/suitecentral/allowed-hosts     → platform admins, global
    //
    // `authMiddleware` must precede each guard: both guards read only the
    // normalized `req.user` claims it installs, and an unauthenticated request
    // has to 401 there rather than reaching a guard that would report 403.
    //
    // This replaces the legacy `/api/suitecentral/prod` router, whose mount was
    // gated behind `enableSuiteCentralProd` (default false, PR-0) and which is
    // deleted in this PR. There is no feature flag here: the surface is
    // authenticated and tenant-scoped, so it does not need one to be safe.
    //
    // It is mounted BEFORE the `enableSuiteCentralSync` return below, and that
    // placement is the whole point: the flag gates the LEGACY sync routers,
    // which this surface has nothing to do with. Sitting after it meant a
    // deployment that turned off legacy sync silently lost the entire control
    // plane — including the platform-admin allowlist — while the paragraph above
    // claimed there was no flag. The flag defaults true, so nothing ever
    // observed the coupling.
    //
    // A mount failure leaves these routes absent, which is fail-closed — an
    // unmounted path 404s rather than serving unauthorized.
    await this.safeRouteSetup(async () => {
      const { createSuiteCentralControlPlaneRouter, createSuiteCentralAllowedHostsRouter } =
        await import('../../routes/suiteCentralControlPlane');
      const { requirePlatformAdmin, requireSuiteCentralTenantAdmin } =
        await import('../../middleware/verifiedAdmin');

      this.app.use(
        '/api/suitecentral/prod',
        authMiddleware,
        requireSuiteCentralTenantAdmin,
        await createSuiteCentralControlPlaneRouter({ accessMode: 'tenant_admin' }),
      );

      this.app.use(
        '/api/admin/tenants/:tenantId/suitecentral',
        authMiddleware,
        requirePlatformAdmin,
        await createSuiteCentralControlPlaneRouter({ accessMode: 'platform_admin' }),
      );

      this.app.use(
        '/api/admin/suitecentral/allowed-hosts',
        authMiddleware,
        requirePlatformAdmin,
        await createSuiteCentralAllowedHostsRouter(),
      );
    }, 'SuiteCentral Control Plane routes');

    if (!this.config.enableSuiteCentralSync) return;

    await this.safeRouteSetup(async () => {
      const container = (await import('../../inversify/inversify.config')).container;
      const TYPES = (await import('../../inversify/types')).TYPES;
      const { createSuiteCentralSyncRouter } = await import('../../routes/suitecentralSync');
      const { createSuiteCentralNetSuiteSyncRouter } = await import('../../routes/suitecentralNetSuiteSync');
      const { createSquireSuiteCentralNetSuiteSyncRouter } = await import('../../routes/squireSuiteCentralNetSuiteSync');

      const integrationService = await container.getAsync<IntegrationService>(TYPES.IntegrationService);
      // Create mock observability service for these routes
      const mockSpan = {
        recordException: () => { },
        setAttributes: () => { },
        setAttribute: () => { },
        end: () => { }
      };
      const mockObservabilityService = {
        tracing: { createSpan: () => mockSpan },
        logging: {},
        metrics: { recordCustomMetric: () => { } },
        initialize: async () => { },
        shutdown: async () => { },
        createScope: () => ({ logger: console, metrics: { recordCustomMetric: () => { } } })
      } as unknown as import('../../observability').ObservabilityService;

      mountSuiteCentralSyncRoutes(this.app, {
        sync: createSuiteCentralSyncRouter(integrationService, mockObservabilityService),
        netsuiteSync: createSuiteCentralNetSuiteSyncRouter(integrationService, mockObservabilityService),
        squireNetsuiteSync: createSquireSuiteCentralNetSuiteSyncRouter(integrationService, mockObservabilityService),
      });
    }, 'SuiteCentral Sync routes');

    // SuiteCentral Feature routes
    await this.safeRouteSetup(async () => {
      const { paymentCentralRouter } = await import('../../routes/paymentCentral');
      const { supplierCentralRouter } = await import('../../routes/supplierCentral');
      const { customerCentralRouter } = await import('../../routes/customerCentral');
      const { qualityCentralRouter } = await import('../../routes/qualityCentral');
      const { payoutCentralRouter } = await import('../../routes/payoutCentral');
      const { installerCentralRouter } = await import('../../routes/installerCentral');
      const { serviceCentralRouter } = await import('../../routes/serviceCentral');
      const { inventoryCentralRouter } = await import('../../routes/inventoryCentral');
      const { financeCentralRouter } = await import('../../routes/financeCentral');
      const { contractCentralRouter } = await import('../../routes/contractCentral');
      const { portalCentralRouter } = await import('../../routes/portalCentral');
      const { workflowCentralRouter } = await import('../../routes/workflowCentral');
      const costTransparencyRouter = (await import('../../routes/costTransparencyRoutes')).default;
      const { reconciliationCenterRouter } = await import('../../routes/reconciliationCenterRoutes');
      const { makeTenantStatusGate } = await import('../tenantStatusGate');
      const container = (await import('../../inversify/inversify.config')).container;
      const TYPES = (await import('../../inversify/types')).TYPES;
      const { TenantLifecycleService } = await import('../../services/tenants/TenantLifecycleService');
      // getAsync is required: TenantLifecycleService depends on TenantLifecycleRepository
      // which is bound via toDynamicValue(async) — sync get returns a Promise, not the service.
      const tenantSvc = await container.getAsync<InstanceType<typeof TenantLifecycleService>>(TYPES.TenantLifecycleService);
      const tenantStatusGate = makeTenantStatusGate(tenantSvc);

      // F5b Phase 2: centralAuthMiddleware and its REQUIRE_CENTRAL_AUTH
      // relaxation are DELETED — all 12 *-central families now mount through
      // mountCentralFamilyRoutes (policy gate + per-family reads-only demo
      // allowlist; /health lives on its own manifest prefix). The global
      // `/api` optionalAuthMiddleware mount still populates req.user for
      // Bearer callers before any family gate runs.

      // F5b Phase 1: the eight non-tenant-aware families are runtime-enforced.
      // Each reads a process-global singleton service, so the mount swap is the
      // entire behavior change — no handler edits and no baseline movement.
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/customer-central', customerCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/customer-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/quality-central', qualityCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/quality-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/payout-central', payoutCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/payout-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/installer-central', installerCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/installer-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/service-central', serviceCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/service-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/inventory-central', inventoryCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/inventory-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/contract-central', contractCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/contract-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/portal-central', portalCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/portal-central']);

      // F5b Phase 2: the four tenant-aware families. Their routers resolve
      // identity via resolveCentralTenantId/resolveCentralActor (gate-attested
      // anonymous demo reads only; every other unattributable request 401s).
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/payment-central', paymentCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/payment-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/supplier-central', supplierCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/supplier-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/finance-central', financeCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/finance-central']);
      mountCentralFamilyRoutes(this.app, tenantSvc, '/api/workflow-central', workflowCentralRouter, CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/workflow-central']);
      mountCostTransparencyRoutes(this.app, tenantSvc, costTransparencyRouter);

      // PR 11: Reconciliation Center API. F3 strict posture — mounted via
      // mountReconciliationCenterRoutes (authMiddleware + tenant-lifecycle
      // kill switch, unconditional; no REQUIRE_CENTRAL_AUTH relaxation) and
      // the router reads req.user directly. The repo chain depends on
      // async-bound DatabaseService → use `getAsync`.
      try {
        const { ReconciliationCenterService } = await import('../../services/reconciliationCenter/ReconciliationCenterService');
        const reconciliationService = await container.getAsync<InstanceType<typeof ReconciliationCenterService>>(
          TYPES.ReconciliationCenterService,
        );
        mountReconciliationCenterRoutes(this.app, tenantSvc, reconciliationCenterRouter(reconciliationService));
      } catch (err) {
        logger.warn(
          'Failed to mount /api/reconciliation-center; reconciliation operator surface unavailable on this replica.',
          { error: err instanceof Error ? err.message : String(err) },
        );
      }

      // PR 12: Record-Level Lineage API. LineageQueryService binds via
      // `toDynamicValue(async)` (transitive DatabaseService dep), so resolve
      // via `getAsync`. F3 strict posture — mounted via mountLineageRoutes
      // (authMiddleware + tenant-lifecycle kill switch, unconditional), and
      // the router reads req.user directly, 401ing operator_identity_required
      // when userId is missing or a synthetic sentinel (see lineageRoutes.ts
      // SYNTHETIC_OPERATOR_USER_IDS). The embedded UI is intentionally NOT
      // shipped this PR (Known Gap on the proof card).
      try {
        const { lineageRouter } = await import('../../routes/lineageRoutes');
        const { LineageQueryService } = await import('../../services/lineage/LineageQueryService');
        const lineageService = await container.getAsync<InstanceType<typeof LineageQueryService>>(
          TYPES.LineageQueryService,
        );
        mountLineageRoutes(this.app, tenantSvc, lineageRouter(lineageService));
      } catch (err) {
        logger.warn(
          'Failed to mount /api/lineage; record-level lineage operator surface unavailable on this replica.',
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }, 'SuiteCentral Feature routes');

    // ShipStation 3PL routes (Phase 2)
    await this.safeRouteSetup(async () => {
      const { shipStationRouter } = await import('../../routes/shipStation');
      mountShipStationRoutes(this.app, shipStationRouter);
    }, 'ShipStation 3PL routes');

    // HubSpot CRM routes (Phase 3)
    await this.safeRouteSetup(async () => {
      const { hubSpotRouter } = await import('../../routes/hubSpot');
      mountHubSpotRoutes(this.app, hubSpotRouter);
    }, 'HubSpot CRM routes');

    // SyncCentral and Automation routes
    await this.safeRouteSetup(async () => {
      const { syncCentralRouter } = await import('../../routes/syncCentral');
      const { syncOrchestratorRouter } = await import('../../routes/syncOrchestrator');
      const { automationLibrariesRouter } = await import('../../routes/automationLibraries');

      // PR3: only /api/sync-central is tenant-scoped (TenantSandbox-backed),
      // so only it sits behind the tenant-lifecycle kill switch. The other two
      // are platform-global (process-global Maps) and take the F4
      // authMiddleware + requirePlatformAdmin shape instead — see the helper
      // doc comments above. Wiring is pinned by
      // tests/integration/syncCentralTenantStatusGate.routes.test.ts.
      const container = (await import('../../inversify/inversify.config')).container;
      const TYPES = (await import('../../inversify/types')).TYPES;
      const { TenantLifecycleService } = await import('../../services/tenants/TenantLifecycleService');
      const tenantSvc = await container.getAsync<InstanceType<typeof TenantLifecycleService>>(TYPES.TenantLifecycleService);

      mountSyncCentralRoutes(this.app, tenantSvc, syncCentralRouter);
      mountSyncOrchestratorRoutes(this.app, syncOrchestratorRouter);
      mountAutomationLibrariesRoutes(this.app, automationLibrariesRouter);
    }, 'SyncCentral and Automation routes');

    // NL Action Gate routes (Phase 4: Grand Unified Strategy - Human-in-the-Loop AI actions)
    await this.safeRouteSetup(async () => {
      const nlActionGateModule = await import('../../routes/NLActionGateRouter');
      const nlActionGateRouter = getDefaultExport(nlActionGateModule as DynamicModule);
      const container = (await import('../../inversify/inversify.config')).container;
      const TYPES = (await import('../../inversify/types')).TYPES;
      const { TenantLifecycleService } = await import('../../services/tenants/TenantLifecycleService');
      // getAsync: the service's repository dependency is bound toDynamicValue(async).
      const tenantSvc = await container.getAsync<InstanceType<typeof TenantLifecycleService>>(TYPES.TenantLifecycleService);
      mountNlActionGateRoutes(this.app, tenantSvc, nlActionGateRouter);
    }, 'NL Action Gate routes');

    // MDM (Master Data Management) routes (Phase 6: Golden Record MDM)
    await this.safeRouteSetup(async () => {
      const mdmModule = await import('../../routes/MDMRouter');
      const mdmRouter = getDefaultExport(mdmModule as DynamicModule);
      this.app.use('/api/mdm', mdmRouter);
    }, 'Golden Record MDM routes');

    // Compliance routes (SOC 2 evidence export, reasoning traces API)
    await this.safeRouteSetup(async () => {
      const complianceModule = await import('../../routes/ComplianceRouter');
      const complianceRouter = getDefaultExport(complianceModule as DynamicModule);
      this.app.use('/api/compliance', authMiddleware, complianceRouter);
    }, 'Compliance routes');
  }

  /**
   * Setup fallback routes and error handlers
   */
  private async setupFallbackRoutes(): Promise<void> {
    // Add mock dashboard APIs for demo mode - mount after real routes as fallback
    if (isDemo()) {
      try {
        const { createMockDashboardAPIs } = require('../../routes/mockDashboardAPIs');
        const mockRouter = createMockDashboardAPIs(this.app);
        // Mount mock router at root but with lower priority by mounting it last
        this.app.use('/', mockRouter);
        logger.info('[routes] Mock dashboard APIs setup as fallback');
      } catch (error) {
        logger.warn('[routes] Failed to setup mock dashboard APIs:', error);
      }
    }

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // SECURITY: Debug endpoint only available in non-production environments
    if (process.env.NODE_ENV !== 'production' && !env.HOSTED_DEMO) {
      this.app.get('/debug/env', (req, res) => {
        res.json({
          DEMO_MODE: process.env.DEMO_MODE,
          NODE_ENV: process.env.NODE_ENV,
          isDemo: isDemo(),
          isDemoResult: isDemo()
        });
      });
    }

    // Root redirect - redirect to main dashboard (index.html)
    this.app.get('/', (req, res) => {
      res.redirect('/index.html');
    });

    this.app.get(['/index', '/index/'], (req, res) => {
      res.redirect('/index.html');
    });

    // Serve all HTML files from public directory with async I/O and caching
    await this.setupStaticHtmlRoutes();
  }

  /**
   * Setup static HTML routes with async I/O and caching for better performance
   */
  private async setupStaticHtmlRoutes(): Promise<void> {
    const htmlFiles = [
      'index.html',
      'admin-templates.html',
      'Integration-Command-Center.html',
      'ai-agents-dashboard.html',
      'ai-features-dashboard.html',
      'ai-configuration-dashboard.html',
      'ai-field-mapping-editor.html',
      'ai-usage-dashboard.html',  // Added 2025-10-28: UI HTML audit fix
      'enterprise-features.html',
      'advanced-field-mapping-editor.html',
      'ai-mapping-center.html',
      'api-docs.html',
      'connector-ecosystem.html',
      'data-migration.html',
      'debug-modal.html',
      'disaster-recovery.html',
      'dlq-management.html',
      // Legacy executive pages moved to _archive - removed from whitelist 2026-01-18
      'help-chat-widget.html',
      'integration-dashboard-enhanced.html',
      'integration-wizard-5step.html',
      'integration-wizard-enhanced.html',  // Added 2025-10-28: UI HTML audit fix
      // 'interactive-mindmap.html' - moved to _archive 2026-01-18
      'AI-Integrated-Mapping-Studio.html',
      'metrics.html',
      'offline.html',  // Added 2025-10-28: UI HTML audit fix (PWA offline page)
      'predictive-analytics-dashboard.html',
      'roi-calculator.html',
      'roi-dashboard.html',
      'suitecentral-integration-hub.html',  // Added 2025-10-28: UI HTML audit fix
      'suitecentral-production.html',
      'SuiteCentral-BusinessCentral-Integration-hub.html',
      'system-status.html',
      'vendor-portal/index.html',  // Added 2026-01-08: VendorCentral Portal (Phase 1)
      'payment-portal/index.html',  // Added 2026-01-08: PaymentCentral Portal (Phase 2)
      'portal-central-dashboard.html',  // Added 2026-02-21: Portal Central canonical alias -> payment-portal/index
      'payment-portal/invoices.html',  // Added 2026-01-09: Invoice Matching Dashboard (Phase 6)
      'customer-central-360.html',  // Added 2026-01-09: Customer 360 AI Dashboard
      'quality-central.html',  // Added 2026-01-10: QualityCentral (Quality Inspections)
      'payout-central.html',  // Added 2026-01-10: PayoutCentral (Affiliate Payouts)
      'installer-central.html',  // Added 2026-01-10: InstallerCentral (Installer Network)
      'service-central.html',  // Added 2026-01-10: ServiceCentral (Field Service)
      'inventory-central.html',  // Added 2026-01-10: InventoryCentral (Inventory Tracking)
      'finance-central.html',  // Added 2026-01-10: FinanceCentral (Financial Consolidation)
      // PR-J (B7): live sub-directory demo pages, added so the startup
      // existence warning covers them (the whitelist-sync gate audits only
      // top-level public/*.html; these were served solely via root static
      // with no inventory entry).
      'squire-v2-media-demo/for-leadership.html',
      'squire-v2-media-demo/read/business-case.html',
      'sync-error-assist.html',  // Added 2026-05-13: SyncErrorAssist operator queue (Wave 2)
      'governance-operations.html',  // Added 2026-05-25: PR 13b Direct-Write Ownership Enforcement operator dashboard
      'code-architecture-dashboard.html',  // Added 2026-06-12: Architecture Knowledge Assistant Dashboard
      'suitecentral-deployment-options-dashboard.html',  // Added 2026-06-13: Deployment Options Knowledge Dashboard
      'contract-central.html',  // Added 2026-01-10: ContractCentral (Contract Lifecycle)
      'components/document-sidecar.html',  // Added 2026-01-13: Universal Document Sidecar
      'components/context-sidecar.html',  // Added 2026-01-13: Context Sidecar Component
      'mdm-central.html',  // Added 2026-01-14: Golden Record MDM Dashboard
      'payout-central-dashboard.html',  // Added 2026-01-18: PayoutCentral Dashboard
      // Executive Hub pages (2026-01-18)
      'executive/executive-hub.html',
      'executive/financial-dashboard.html',
      'executive/demo-center.html',
      'executive/resources.html',
      'executive/strategic-position.html',
      'executive/technical-proof.html',
      // Squire Executive Package v2 (2026-01-18)
      'Squire-Executive-Package-v2/00-EXECUTIVE-OUTCOMES-STANDALONE.html',
      'Squire-Executive-Package-v2/01-EXECUTIVE-SUMMARY.html',
      'Squire-Executive-Package-v2/01-EXECUTIVE-SUMMARY-STANDALONE.html',
      'Squire-Executive-Package-v2/02-COMPLETE-FEATURES.html',
      'Squire-Executive-Package-v2/02-COMPLETE-FEATURES-STANDALONE.html',
      'Squire-Executive-Package-v2/03-ONE-PAGER-STANDALONE.html',
      'Squire-Executive-Package-v2/04-ROI-CALCULATOR-STANDALONE.html',
      'Squire-Executive-Package-v2/05-TECHNICAL-PROOF-STANDALONE.html',
      'Squire-Executive-Package-v2/06-INVESTMENT-PROPOSAL-STANDALONE.html',
      'Squire-Executive-Package-v2/07-BUSINESS-CASE-STANDALONE.html',
      'Squire-Executive-Package-v2/08-INFOGRAPHIC-COMPLETE.html',
      'Squire-Executive-Package-v2/09-CLAIM-PROOF-MATRIX-STANDALONE.html',
      'Squire-Executive-Package-v2/10-ROLE-BRIEF-CFO-STANDALONE.html',
      'Squire-Executive-Package-v2/11-ROLE-BRIEF-CTO-STANDALONE.html',
      'Squire-Executive-Package-v2/12-ROLE-BRIEF-COO-STANDALONE.html',
      'Squire-Executive-Package-v2/13-PILOT-30-60-90-STANDALONE.html',
      'Squire-Executive-Package-v2/14-DEMO-PREFLIGHT-STANDALONE.html',
      'Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html',
      'Squire-Executive-Package-v2/16-PILOT-DECISION-MEMO-STANDALONE.html',
      'Squire-Executive-Package-v2/17-PERSONAL-WALKTHROUGH-SCRIPT-STANDALONE.html',
      'Squire-Executive-Package-v2/18-LIVE-DEMO-SETUP-STANDALONE.html',
      'Squire-Executive-Package-v2/19-DECISION-PATH-STANDALONE.html',
      'Squire-Executive-Package-v2/20-NO-SERVER-MINI-PACK-STANDALONE.html',
      'Squire-Executive-Package-v2/21-OBJECTIONS-ANSWERS-STANDALONE.html',
      'Squire-Executive-Package-v2/22-MODULE-LIBRARY-STANDALONE.html',
      'Squire-Executive-Package-v2/23-ENGINEERING-SCALE-QUALITY-STANDALONE.html',
      'Squire-Executive-Package-v2/index.html',
      'Squire-Executive-Package-v2/MINDMAP-ARCHITECTURE-STANDALONE.html',
      'Squire-Executive-Package-v2/MINDMAP-BENEFITS-STANDALONE.html',
      // Squire v2 Media Demo (2026-02-11)
      'squire-v2-media-demo/index.html',
      'squire-v2-media-demo/oracle-comparison.html',
      'squire-v2-media-demo/watch/storyboard.html',
      'squire-v2-media-demo/watch/scenes/scene1-problem-visual.html',
      'squire-v2-media-demo/watch/scenes/scene6-nl-action-gate-visual.html',
      'squire-v2-media-demo/watch/scenes/scene7-opportunity-visual.html',
      'squire-v2-media-demo/watch/videos/index.html',
      'squire-v2-media-demo/watch/videos/player.html',
      'squire-v2-media-demo/watch/videos/transcripts.html',
      'squire-v2-media-demo/click/demo-guide.html',
      'squire-v2-media-demo/click/setup.html',
      'squire-v2-media-demo/read/executive-summary.html',
      'squire-v2-media-demo/read/competitive-diff.html',
      'squire-v2-media-demo/read/talking-points.html',
      'squire-v2-media-demo/read/risks-mitigations.html',
      'squire-v2-media-demo/read/elevator-pitch.html',
      'squire-v2-media-demo/read/roi-calculator.html',
      'squire-v2-media-demo/read/context-sidecar-proof.html',
      'squire-v2-media-demo/read/mcp-proof-console.html',
      'squire-v2-media-demo/read/mcp-positioning-diagram.html',
      'squire-v2-media-demo/read/suiteapp-badge-readiness.html',
      'squire-v2-media-demo/read/engineering-scale.html',
      'Squire-Executive-Package-v2/28-PACKAGE-GUIDE-STANDALONE.html',
      // SOC 2 Compliance Dashboard (2026-02-11)
      'compliance-dashboard.html',
      // PR 10a: Embedded ERP Surface — dev-only standalone reference host.
      // Production embedding flows through a NetSuite Suitelet or BC AL
      // Extension that calls /api/embedded/host-bootstrap server-side.
      'embedded/host-reference.html',
      'cost-transparency-dashboard.html',  // Added 2026-05-22: Cost Transparency Dashboard (PR 21)
      'squire-portfolio-evidence.html',  // Added 2026-05-22: SuiteCentral Portfolio Evidence View (PR 22)
      'review-hub.html',  // Added 2026-06-18: Review & Evidence hub (shell Review top-tab landing)
    ];

    // Use process.cwd() to verify we are serving from the project root (volume mount in Docker)
    const publicDir = resolvePublicDir();

    // Pre-cache file existence checks asynchronously for better startup performance
    const existenceChecks = await Promise.allSettled(
      htmlFiles.map(async (file) => {
        const filePath = join(publicDir, file);
        try {
          await fs.access(filePath);
          this.fileExistsCache.set(filePath, true);
          return { file, exists: true };
        } catch {
          this.fileExistsCache.set(filePath, false);
          return { file, exists: false };
        }
      })
    );

    // Log missing files during startup for visibility
    const missingFiles = existenceChecks
      .filter((result): result is PromiseFulfilledResult<{ file: string; exists: boolean }> =>
        result.status === 'fulfilled' && !result.value.exists
      )
      .map(result => result.value.file);

    if (missingFiles.length > 0) {
      logger.warn(`⚠️  Missing ${missingFiles.length} HTML files:`, { files: missingFiles.slice(0, 5).join(', ') + (missingFiles.length > 5 ? '...' : '') });
    }

    // Setup routes - delegates file existence checking to Express sendFile (returns 404 if missing)
    htmlFiles.forEach(htmlFile => {
      this.app.get(`/${htmlFile}`, (req, res) => {
        logger.debug(`[RouteSetup] Handling request for /${htmlFile}`);
        const filePath = join(publicDir, htmlFile);

        // Disable caching to ensure fresh content (especially for Docker volume mounts)
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        // Always attempt to serve - let sendFile handle 404 if file doesn't exist
        res.sendFile(filePath, {
          etag: false,
          lastModified: false,
          maxAge: 0
        }, (err) => {
          if (err) {
            logger.warn(`[RouteSetup] 404 for /${htmlFile}: ${(err as Error).message}`);
            res.status(404).send(`File ${htmlFile} not found.`);
          }
        });
      });
    });

    // Add route for universal navigation script
    this.app.get('/universal-navigation.js', (req, res) => {
      const scriptPath = join(publicDir, 'universal-navigation.js');
      res.sendFile(scriptPath, (err) => {
        if (err) {
          res.status(404).send('Navigation script not found');
        }
      });
    });
  }

  /**
   * Safely setup routes with error handling
   */
  private async safeRouteSetup(
    setupFn: () => Promise<void> | void,
    routeName: string
  ): Promise<void> {
    try {
      logger.info(`[routes] Setting up ${routeName}...`);
      await setupFn();
      logger.info(`[routes] ✓ ${routeName} setup completed successfully`);
    } catch (error) {
      const stack = error instanceof Error ? error.stack : String(error);
      const msg = `[routes] ❌ Failed to setup ${routeName} - STACK: ${stack}`;
      logger.error(msg, { routeName, stack });

      // Prevent silent failures in development/test
      if (process.env.NODE_ENV !== 'production') {
        throw error;
      }
    }
  }
}

/**
 * Convenience function to setup all routes
 */
export async function setupRoutes(
  app: Application,
  config: RouteConfig = {},
  services?: {
    integrationService?: IntegrationService;
    configurationService?: ConfigurationService;
    knowledgeBase?: DocumentationKnowledgeBase; // Phase 2: DocumentationKnowledgeBase for AI service enhancement
  }
): Promise<void> {
  const routeSetup = new RouteSetup(app, config, services);
  // `setupAll()` already calls `setupSuiteCentralRoutes()`. A second call here
  // mounted every SuiteCentral router twice, so each request ran its handler
  // chain twice — harmless for the old read-only demo routes, but the control
  // plane audits and performs outbound writes, and a duplicate mount would
  // double both.
  await routeSetup.setupAll();

  // Error handler must be last
  const { errorHandler } = await import('../errorHandler');
  const { container } = await import('../../inversify/inversify.config');
  const { TYPES } = await import('../../inversify/types');
  const logger = container.get<Logger>(TYPES.Logger);
  app.use(errorHandler(logger));
}

export default RouteSetup;
