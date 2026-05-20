import type { Application, Request, Response, NextFunction } from 'express';
import { promises as fs } from 'fs';
import { join } from 'path';
import { isDemo } from '../../utils/features';
import { env } from '../../config';
import type { IntegrationService } from '../../services/IntegrationService';
import type { ConfigurationService } from '../../services/ConfigurationService';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from '../../middleware/auth';
import { logger, type Logger } from '../../utils/Logger';
import { resolvePublicDir } from './publicDir';
import type { DocumentationKnowledgeBase } from '../../services/help/DocumentationKnowledgeBase';
import { tenantIsolation } from '../tenantIsolation';
import { classifyRoute } from './routeManifest';

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
 * front of all routers. Consults `ROUTE_MANIFEST` via `classifyRoute()` and
 * dispatches to the real `tenantIsolation` middleware only for
 * `tenant_required` paths. Other classifications short-circuit to `next()`.
 *
 * Mode: PERMISSIVE + header-extraction-DISABLED.
 *   - `strictMode: false`: missing tenant context does NOT 403 (falls
 *     through to handler). Strict-mode flip is a follow-up PR — it requires
 *     migrating ~30 handlers off the `extractIdentityContext`
 *     SYSTEM_IDENTITY fallback first.
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
 * **What CAN populate `req.tenantContext`**: a valid `Authorization: Bearer
 * <jwt>` against `JWT_SECRET` (via `tenantIsolation`'s built-in JWT
 * extraction), a configured `resolveTenant` callback (none today), or
 * `trustedTenants` fast-path (none today). PR 2C-Auth activated the JWT
 * path by mounting `optionalAuthMiddleware` globally and adding the
 * `req.tenantContext` source to `extractIdentityContext`.
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
export function mountCentralTenantGate(app: Application): void {
  const isolation = tenantIsolation({
    strictMode: false,
    allowAnonymous: false,
    disableHeaderExtraction: true,  // PR 4B R4 security fix: pre-PR-2C-Auth,
                                    // x-tenant-id headers are NOT authenticated.
                                    // Populating req.tenantContext from them
                                    // would activate header impersonation vectors
                                    // in direct consumers like mcpPolicies.ts.
    // No excludePaths override needed — /health, /ready, /metrics and other
    // non-tenant routes are classified 'public'/'system'/'demo' in the
    // manifest and never reach isolation() because the dispatcher below
    // short-circuits to next() for anything that isn't 'tenant_required'.
  });

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
      return isolation(req, res, next);
    }
    return next();
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
  enableSuiteCentralProd?: boolean;
  enableFullPipelineDemo?: boolean;
  enableOperationalDashboard?: boolean;
  enableAIServices?: boolean;
  enableDisasterRecovery?: boolean;
  enableFeatureFlags?: boolean;
  enableEnterpriseFeatures?: boolean;
  enableSettings?: boolean;
}

/**
 * Default route configuration
 */
const DEFAULT_ROUTE_CONFIG: Required<RouteConfig> = {
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
  enableSuiteCentralProd: true,
  enableFullPipelineDemo: true,
  enableOperationalDashboard: true,
  enableAIServices: true,
  enableDisasterRecovery: true,
  enableFeatureFlags: true,
  enableEnterpriseFeatures: true,
  enableSettings: true,
};

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
    // Absent JWT is fine — the central gate stays permissive and handlers
    // retain their SYSTEM_IDENTITY fallback via extractIdentityContext.
    //
    // Scope exception: `GET /api/statistics` is registered in
    // `Server.mountRouters()` (src/index.ts) at construction time, BEFORE
    // `App.initializeServices()` awaits into `setupRoutes()`. Express
    // dispatches that handler before this middleware runs, so optional
    // auth does NOT execute for that endpoint. Status quo is preserved:
    // /api/statistics is classified `system` (admin/ops diagnostic, not
    // tenant-scoped) in the route manifest and short-circuits the central
    // tenant gate, and it had no auth pre-PR-2C-Auth either.
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
    mountCentralTenantGate(this.app);

    // AI Proxy routes (NEW - secure server-side AI provider access)
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { createAIProxyRouter } = await import('../../routes/aiProxy');
        this.app.use('/api/ai/proxy', await createAIProxyRouter({
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

    // MCP policy management routes (DB-backed tenant policy CRUD)
    await this.safeRouteSetup(async () => {
      const { createMCPPolicyRouter } = await import('../../routes/mcpPolicies');
      this.app.use('/api/mcp', authMiddleware, await createMCPPolicyRouter());
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
        const { createConfigurationRouter } = await import('../../routes/configuration');
        // Mount at root since router already defines full paths like /api/configurations
        this.app.use('/', createConfigurationRouter(this.configurationService!));
      }, 'Configuration routes');
    }

    // Connector Credentials routes (Encrypted credential storage for connectors)
    await this.safeRouteSetup(async () => {
      const { createConnectorCredentialRouter } = await import('../../routes/connectorCredential');
      this.app.use('/api', await createConnectorCredentialRouter());
    }, 'Connector Credentials routes');

    // Integration routes
    if (this.config.enableIntegration && this.integrationService) {
      await this.safeRouteSetup(async () => {
        const { createIntegrationRouter } = await import('../../routes/integration');
        this.app.use('/api/integrations', createIntegrationRouter(this.integrationService!));
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
      this.app.use('/api/fixtures', fixtureRouter);
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
        this.app.use('/api/context', contextRouter);
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
    // **Authentication posture (dual)**. The mount itself applies NO
    // router-level auth middleware — the router's individual route handlers
    // pick the right gate per endpoint:
    //
    //   - `GET /:id` runs `extractIdentityContext(req)` inline and fails
    //     closed with `401 unauthenticated` when the resolved identity is
    //     `SYSTEM_IDENTITY` (Codex 5.4 HIGH fix from PR #819). After PR 4B's
    //     central tenant gate + PR 2C-Auth's JWT mount, real callers with a
    //     Bearer JWT pass the gate; legacy unauthenticated callers still 401.
    //   - `GET /`, `POST /:id/approve`, `POST /:id/reject` apply
    //     `validateGuestContext` (embedded session + same-origin) +
    //     `requireApproverRole` (user_roles JSON array contains 'approver' OR
    //     'admin'). Tenant identity comes from the embedded session, NOT the
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
    // `handleApprovalQueueError`) STILL records SYSTEM_IDENTITY for
    // 42-of-49 unauth-mounted routes — that's the broader audit gap
    // documented in [[project-pr-3b-route-audit-inventory]].
    await this.safeRouteSetup(async () => {
      const { approvalsRouter } = await import('../../routes/governance/approvalsRouter');
      this.app.use('/api/governance/approvals', approvalsRouter);
    }, 'Governance approvals router (PR 3B read-only + PR 3C operator surface)');

    // Action Island routes (Cross-system action execution)
    if (this.config.enableAIServices) {
      await this.safeRouteSetup(async () => {
        const { actionIslandRouter } = await import('../../routes/ActionIslandRouter');
        this.app.use('/api/actions', actionIslandRouter);
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
        this.app.use('/api/full-pipeline-demo', createFullPipelineDemoRouter());
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
   * Setup SuiteCentral sync routes
   */
  async setupSuiteCentralRoutes(): Promise<void> {
    if (!this.config.enableSuiteCentralSync) return;

    await this.safeRouteSetup(async () => {
      const container = (await import('../../inversify/inversify.config')).container;
      const TYPES = (await import('../../inversify/types')).TYPES;
      const { createSuiteCentralSyncRouter } = await import('../../routes/suitecentralSync');
      const { createSuiteCentralNetSuiteSyncRouter } = await import('../../routes/suitecentralNetSuiteSync');
      const { createSquireSuiteCentralNetSuiteSyncRouter } = await import('../../routes/squireSuiteCentralNetSuiteSync');

      const integrationService = container.get<IntegrationService>(TYPES.IntegrationService);
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

      this.app.use('/api/suitecentral/sync', createSuiteCentralSyncRouter(integrationService, mockObservabilityService));
      this.app.use('/api/suitecentral/netsuite/sync', createSuiteCentralNetSuiteSyncRouter(integrationService, mockObservabilityService));
      this.app.use('/api/squire/suitecentral/netsuite/sync', createSquireSuiteCentralNetSuiteSyncRouter(integrationService, mockObservabilityService));
    }, 'SuiteCentral Sync routes');

    // SuiteCentral Production routes
    if (this.config.enableSuiteCentralProd) {
      await this.safeRouteSetup(async () => {
        const { suiteCentralProdRouter } = await import('../../routes/suiteCentralProd');
        this.app.use('/api/suitecentral/prod', suiteCentralProdRouter);
      }, 'SuiteCentral Production routes');
    }

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
      const { makeTenantStatusGate } = await import('../tenantStatusGate');
      const container = (await import('../../inversify/inversify.config')).container;
      const TYPES = (await import('../../inversify/types')).TYPES;
      const { TenantLifecycleService } = await import('../../services/tenants/TenantLifecycleService');
      // getAsync is required: TenantLifecycleService depends on TenantLifecycleRepository
      // which is bound via toDynamicValue(async) — sync get returns a Promise, not the service.
      const tenantSvc = await container.getAsync<InstanceType<typeof TenantLifecycleService>>(TYPES.TenantLifecycleService);
      const tenantStatusGate = makeTenantStatusGate(tenantSvc);

      // Apply optional auth to Central routes - allows demo access but attaches user info if authenticated
      // To require auth: set REQUIRE_CENTRAL_AUTH=true in environment
      // Health endpoints are always accessible (exempt from auth) for monitoring
      const baseAuthMiddleware = process.env.REQUIRE_CENTRAL_AUTH === 'true' ? authMiddleware : optionalAuthMiddleware;
      const centralAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
        if (req.path === '/health') {
          return next(); // Skip auth for health endpoints
        }
        return baseAuthMiddleware(req as AuthenticatedRequest, res, (err?: unknown) => {
          // If auth middleware passed an error (e.g. a future change makes
          // optionalAuthMiddleware propagate JWT-verification failures), forward
          // it to Express WITHOUT running the gate. Running the gate after a
          // failed auth would silently bypass the failed auth step.
          if (err) return next(err);
          // Auth succeeded — now check tenant status.
          // The gate is async; chain .catch(next) so any rejection before the
          // gate's inner try/catch (e.g. extractIdentityContext throwing) is
          // forwarded to Express instead of becoming an unhandled rejection
          // that leaves the request hanging until the client times out.
          tenantStatusGate(req, res, next).catch(next);
        });
      };

      this.app.use('/api/payment-central', centralAuthMiddleware, paymentCentralRouter);
      this.app.use('/api/supplier-central', centralAuthMiddleware, supplierCentralRouter);
      this.app.use('/api/customer-central', centralAuthMiddleware, customerCentralRouter);
      this.app.use('/api/quality-central', centralAuthMiddleware, qualityCentralRouter);
      this.app.use('/api/payout-central', centralAuthMiddleware, payoutCentralRouter);
      this.app.use('/api/installer-central', centralAuthMiddleware, installerCentralRouter);
      this.app.use('/api/service-central', centralAuthMiddleware, serviceCentralRouter);
      this.app.use('/api/inventory-central', centralAuthMiddleware, inventoryCentralRouter);
      this.app.use('/api/finance-central', centralAuthMiddleware, financeCentralRouter);
      this.app.use('/api/contract-central', centralAuthMiddleware, contractCentralRouter);
      this.app.use('/api/portal-central', centralAuthMiddleware, portalCentralRouter);
      this.app.use('/api/workflow-central', centralAuthMiddleware, workflowCentralRouter);
    }, 'SuiteCentral Feature routes');

    // ShipStation 3PL routes (Phase 2)
    await this.safeRouteSetup(async () => {
      const { shipStationRouter } = await import('../../routes/shipStation');
      this.app.use('/api/shipstation', shipStationRouter);
    }, 'ShipStation 3PL routes');

    // HubSpot CRM routes (Phase 3)
    await this.safeRouteSetup(async () => {
      const { hubSpotRouter } = await import('../../routes/hubSpot');
      this.app.use('/api/hubspot', hubSpotRouter);
    }, 'HubSpot CRM routes');

    // SyncCentral and Automation routes
    await this.safeRouteSetup(async () => {
      const { syncCentralRouter } = await import('../../routes/syncCentral');
      const { syncOrchestratorRouter } = await import('../../routes/syncOrchestrator');
      const { automationLibrariesRouter } = await import('../../routes/automationLibraries');

      this.app.use('/api/sync-central', syncCentralRouter);
      this.app.use('/api/sync-orchestrator', syncOrchestratorRouter);
      this.app.use('/api/automation-libraries', automationLibrariesRouter);
    }, 'SyncCentral and Automation routes');

    // NL Action Gate routes (Phase 4: Grand Unified Strategy - Human-in-the-Loop AI actions)
    await this.safeRouteSetup(async () => {
      const nlActionGateModule = await import('../../routes/NLActionGateRouter');
      const nlActionGateRouter = getDefaultExport(nlActionGateModule as DynamicModule);
      this.app.use('/api/nl-action-gate', nlActionGateRouter);
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
      'chart-test.html',
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
      'roi-calculator-standalone.html',
      'roi-dashboard.html',
      'suitecentral-integration-hub.html',  // Added 2025-10-28: UI HTML audit fix
      'suitecentral-production.html',
      'SuiteCentral-BusinessCentral-Integration-hub.html',
      'test-debug.html',
      'system-status.html',
      'test.html',
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
      'sync-error-assist.html',  // Added 2026-05-13: SyncErrorAssist operator queue (Wave 2)
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
  await routeSetup.setupAll();
  await routeSetup.setupSuiteCentralRoutes();

  // Error handler must be last
  const { errorHandler } = await import('../errorHandler');
  const { container } = await import('../../inversify/inversify.config');
  const { TYPES } = await import('../../inversify/types');
  const logger = container.get<Logger>(TYPES.Logger);
  app.use(errorHandler(logger));
}

export default RouteSetup;
