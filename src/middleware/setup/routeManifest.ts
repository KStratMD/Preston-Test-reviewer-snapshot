/**
 * Route Classification Manifest (PR 4B).
 *
 * Source of truth for which HTTP route prefixes require tenant isolation.
 * Consumed by:
 *   - `RouteSetup.setupAPIRoutes` — single central `tenantIsolation` mount
 *   - `scripts/audit-status-claims.mjs --check-tenant-coverage` — drift gate
 *   - `docs/review/route-tenant-coverage.md` — human-readable companion
 *
 * Classification semantics:
 *   - 'public': no identity required, no tenant filtering (health, docs, redirect shims)
 *   - 'system': elevated identity required (admin/ops); auth still enforced at handler level
 *   - 'tenant_required': must populate `req.tenantContext` via `tenantIsolation`
 *   - 'demo': demo-mode fallback; intentionally bypasses tenant gating
 *
 * Adding/removing a /api/* mount in `src/middleware/setup/RouteSetup.ts`
 * OR `src/index.ts` requires a matching entry here; the audit gate
 * (`npm run audit-tenant-coverage`) fails CI on drift in either direction.
 * Both files are scanned — see `MOUNT_SOURCE_FILES` in
 * `scripts/audit-status-claims.mjs`. Adding a new file that mounts /api/*
 * routes also requires appending it to `MOUNT_SOURCE_FILES`.
 */

export type RouteClassification = 'public' | 'system' | 'tenant_required' | 'demo';

export interface RouteEntry {
  /**
   * Request-path prefix used by `classifyRoute`'s longest-prefix match.
   * Most entries correspond 1:1 to an `app.use('<path>', ...)` mount string
   * in `RouteSetup.ts` or `src/index.ts`, but some entries cover sub-routes
   * defined inside routers mounted at a bare `/api` parent (e.g.
   * `/api/connector-credentials`, `/api/test-connection`) — the audit's
   * source-mount scan can't see these directly, so they appear in
   * `EXEMPT_FROM_SOURCE_REQUIREMENT` in the audit script. Other entries
   * cover pathless-mount routers like `/api/ai-config` and
   * `/api/sync-error-assist` whose routes are defined with absolute
   * `/api/...` paths inside the router itself.
   */
  path: string;
  classification: RouteClassification;
  /**
   * Free-form note explaining the classification choice. Keep short — this
   * is what reviewers read when they ask "why is this 'demo'?".
   */
  notes?: string;
}

// Each entry is individually frozen so accidental runtime mutation
// (`(ROUTE_MANIFEST[0] as any).classification = 'public'`) throws in strict
// mode. Object.freeze on the array alone is shallow — per Copilot R7.
export const ROUTE_MANIFEST: readonly RouteEntry[] = Object.freeze(([
  // --- Public ---
  { path: '/health', classification: 'public', notes: 'liveness probe' },
  { path: '/ready', classification: 'public', notes: 'readiness probe' },
  { path: '/api/metrics', classification: 'public', notes: 'Prometheus scrape; gated by METRICS_SCRAPE_TOKEN when set, 403 in production when unset (open in dev/test/HOSTED_DEMO)' },
  { path: '/api/ai', classification: 'public', notes: 'PR 1B 301 redirect shim → /api/ai/proxy' },
  { path: '/api/download', classification: 'public', notes: 'static downloads' },
  { path: '/api/identity', classification: 'public', notes: 'display-only whoami for the top-rail Admin menu; optional auth. F6 sub-project B: resolves directly from the verified req.user — echoes only when BOTH id and tenantId are non-empty and NEITHER is the system sentinel; tenant-less, system-sentinel, and unauthenticated callers get the demo fallback; no tenant-scoped data' },
  { path: '/docs', classification: 'public', notes: 'docs router' },
  { path: '/api-docs', classification: 'public', notes: 'swagger UI' },

  // --- System (admin/ops) ---
  { path: '/api/admin/tenants', classification: 'system', notes: 'tenant lifecycle admin' },
  { path: '/api/admin/settings', classification: 'system', notes: 'platform-admin runtime settings (process-global demo mode); authMiddleware + requirePlatformAdmin, not tenant-scoped' },
  { path: '/api/admin/tenants/:tenantId/suitecentral', classification: 'system', notes: 'PR-A6: platform-admin SuiteCentral control plane for a named tenant; authMiddleware + requirePlatformAdmin. Tenant comes from the path, not a claim, so it is deliberately NOT tenant_required — the central gate must not re-scope it to the admin own tenant. Requests are classified via the /api/admin/tenants prefix at runtime; this entry exists to satisfy the mount-drift audit and to document the boundary.' },
  { path: '/api/admin/suitecentral/allowed-hosts', classification: 'system', notes: 'PR-A6: platform-global SuiteCentral egress allowlist; authMiddleware + requirePlatformAdmin. Not tenant-scoped at all — no tenant is accepted or read.' },
  { path: '/metrics', classification: 'system', notes: 'gated by ENABLE_METRICS + authMiddleware' },
  { path: '/api/disaster-recovery', classification: 'system', notes: 'ops-only' },
  { path: '/api/disaster-recovery/dashboard', classification: 'system', notes: 'ops-only' },
  { path: '/api/statistics', classification: 'system', notes: 'single-endpoint diagnostic mounted in src/index.ts, gated by authMiddleware; reads global configService state, not tenant-scoped' },
  { path: '/api/full-pipeline-demo', classification: 'system', notes: 'F-track follow-up: platform-admin surface — deployment-global, environment-configured connector instances. mountFullPipelineDemoRoutes runs authMiddleware + requirePlatformAdmin + the shared erp-write limiter. The classification itself is documentary: mountCentralTenantGate short-circuits everything that is not tenant_required, so demo and system behave identically there.' },

  // --- Demo (intentionally unisolated) ---
  { path: '/api/ai-demo', classification: 'demo' },
  { path: '/api/data-migration', classification: 'demo', notes: 'demo migration playground' },

  // --- Tenant-required (the gated set) ---
  { path: '/api/ai/proxy', classification: 'tenant_required', notes: 'AI provider proxy; governance + tenant scoping. F2: mount enforces policy-gated auth + tenant kill switch via mountAiProxyRoutes; demo allowlist (zero-spend, fixture-isolated) + platform_admin refinements per ROUTE_POLICY_MANIFEST' },
  { path: '/api/settings', classification: 'tenant_required' },
  { path: '/api/mcp', classification: 'tenant_required' },
  { path: '/api/mappings', classification: 'tenant_required' },
  { path: '/api/mappings/templates', classification: 'tenant_required' },
  { path: '/api/templates', classification: 'tenant_required' },
  { path: '/api/dashboard', classification: 'tenant_required' },
  { path: '/api/dashboard/api/mappings', classification: 'tenant_required', notes: 'legacy double-/api/ prefix; mirrors RouteSetup.ts mount' },
  { path: '/api/dashboard/mappings', classification: 'tenant_required' },
  { path: '/api/dashboard/mappings/templates', classification: 'tenant_required' },
  { path: '/api/dashboard/templates', classification: 'tenant_required' },
  { path: '/api/integrations', classification: 'tenant_required' },
  { path: '/api/upload', classification: 'tenant_required' },
  { path: '/api/testing', classification: 'tenant_required', notes: 'PR-C: /run is platform-admin-gated inside the router; /mcp-schema stays anonymous (ai-config-dashboard). Details: PR #1017.' },
  { path: '/api/fixtures', classification: 'tenant_required' },
  { path: '/api/baselines', classification: 'tenant_required' },
  { path: '/api/persistence', classification: 'tenant_required' },
  { path: '/api/predictive-analytics', classification: 'tenant_required' },
  { path: '/api/executive', classification: 'tenant_required' },
  { path: '/api/ai-config', classification: 'tenant_required', notes: 'pathless mount via aiConfigRouter; routes defined as absolute /api/ai-config/* inside the router' },
  { path: '/api/agents', classification: 'tenant_required' },
  { path: '/api/context', classification: 'tenant_required', notes: 'F5: runtime-enforced via mountContextRoutes (shared demo-family gate — anonymous only in a demo runtime, fallback-only branch; tenant kill switch); router reads req.user' },
  { path: '/api/embedded/host-bootstrap', classification: 'tenant_required' },
  { path: '/api/embedded/context', classification: 'tenant_required' },
  { path: '/api/embedded/sessions', classification: 'tenant_required' },
  { path: '/api/embedded/lineage', classification: 'tenant_required', notes: 'PR 12 follow-up: record-level lineage operator UI; auths via validateGuestContext (embedded session) — tenant_id scopes the lookup, no Bearer JWT path. F3: requireActiveEmbeddedTenant kill switch in-router' },
  { path: '/api/embedded/reconciliation', classification: 'tenant_required', notes: '#862 follow-up (c): reconciliation operator UI; auths via validateGuestContext (embedded session) — tenant_id scopes the lookup, no Bearer JWT path. F3: requireActiveEmbeddedTenant kill switch in-router' },
  { path: '/api/governance/approvals', classification: 'tenant_required', notes: 'HITL queue. F3: GET /:id is authMiddleware + JWT kill switch (supersedes the Codex-5.4 inline 401 gate); operator endpoints are validateGuestContext + requireActiveEmbeddedTenant + role gate in-router' },
  { path: '/api/governance', classification: 'tenant_required', notes: 'PR 13b: operationsRouter (ownership-rejections, loop-detections, dlp-pattern-metadata) — embedded-session auth via validateGuestContext + requireActiveEmbeddedTenant (F3 kill switch) + requireApproverRole inside router' },
  { path: '/api/actions', classification: 'tenant_required', notes: 'F5: runtime-enforced via mountActionIslandRoutes (shared demo-family gate — six-action exact demo allowlist, anonymous only in a demo runtime; tenant kill switch); router attributes via req.user' },
  { path: '/api/documents', classification: 'tenant_required' },
  { path: '/api/feature-flags', classification: 'tenant_required' },
  { path: '/api/roi-dashboard', classification: 'tenant_required' },
  { path: '/api/suitecentral/sync', classification: 'system', notes: 'F4: platform-admin surface — deployment-global connector/integration state; tenant-scoped ERP writes via /api/integrations' },
  { path: '/api/suitecentral/netsuite/sync', classification: 'system', notes: 'F4: platform-admin surface — deployment-global connector/integration state; tenant-scoped ERP writes via /api/integrations' },
  { path: '/api/squire/suitecentral/netsuite/sync', classification: 'system', notes: 'F4: platform-admin surface — deployment-global connector/integration state; tenant-scoped ERP writes via /api/integrations' },
  { path: '/api/suitecentral/prod', classification: 'tenant_required', notes: 'PR-A6: tenant-admin SuiteCentral control plane; authMiddleware + requireSuiteCentralTenantAdmin. The router sources the target tenant from the verified JWT claim only.' },
  { path: '/api/payment-central', classification: 'tenant_required', notes: 'F5b Phase 2: runtime-enforced at mountCentralFamilyRoutes' },
  { path: '/api/payment-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/supplier-central', classification: 'tenant_required' },
  { path: '/api/supplier-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/customer-central', classification: 'tenant_required' },
  { path: '/api/customer-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/quality-central', classification: 'tenant_required' },
  { path: '/api/quality-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/payout-central', classification: 'tenant_required' },
  { path: '/api/payout-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/installer-central', classification: 'tenant_required' },
  { path: '/api/installer-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/service-central', classification: 'tenant_required' },
  { path: '/api/service-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/inventory-central', classification: 'tenant_required' },
  { path: '/api/inventory-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/finance-central', classification: 'tenant_required' },
  { path: '/api/finance-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/contract-central', classification: 'tenant_required' },
  { path: '/api/contract-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/portal-central', classification: 'tenant_required' },
  { path: '/api/portal-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/workflow-central', classification: 'tenant_required' },
  { path: '/api/workflow-central/health', classification: 'tenant_required', notes: 'F5b: own prefix so the public probe can be matched EXACTLY without exposing /health descendants' },
  { path: '/api/shipstation', classification: 'system', notes: 'F4: platform-admin surface — deployment-global connector/integration state; tenant-scoped ERP writes via /api/integrations' },
  { path: '/api/hubspot', classification: 'system', notes: 'F4: platform-admin surface — deployment-global connector/integration state; tenant-scoped ERP writes via /api/integrations' },
  { path: '/api/sync-central', classification: 'tenant_required' },
  { path: '/api/sync-orchestrator', classification: 'system', notes: 'PR3: process-global operation store (SyncOperation has no tenantId) — authMiddleware + requirePlatformAdmin at mountSyncOrchestratorRoutes' },
  { path: '/api/automation-libraries', classification: 'system', notes: 'PR3: process-global demo stores — authMiddleware + requirePlatformAdmin at mountAutomationLibrariesRoutes' },
  { path: '/api/nl-action-gate', classification: 'tenant_required' },
  { path: '/api/mdm', classification: 'tenant_required' },
  { path: '/api/compliance', classification: 'tenant_required' },
  { path: '/api/sync-error-assist', classification: 'tenant_required', notes: 'pathless mount via syncErrorAssistRoutes; routes defined as absolute /api/sync-error-assist/* inside the router' },
  { path: '/api/cost-transparency', classification: 'tenant_required', notes: 'cost dashboard + anomaly. F5: runtime-enforced via mountCostTransparencyRoutes (strict — empty demo allowlist; tenant kill switch); handlers read req.user; exact /health probe stays public' },
  { path: '/api/reconciliation-center', classification: 'tenant_required', notes: 'PR 11: durable exception queue + resolve. F3: runtime-enforced strict — authMiddleware + tenant kill switch at mountReconciliationCenterRoutes; handlers read req.user (no SYSTEM_IDENTITY fallback)' },
  { path: '/api/lineage', classification: 'tenant_required', notes: 'PR 12: record-level lineage. F3: runtime-enforced strict — authMiddleware + tenant kill switch at mountLineageRoutes; handler reads req.user, 401 operator_identity_required on missing/synthetic userId (SYSTEM_IDENTITY.userId, "unknown") — mirrors reconciliation resolve route' },
  { path: '/api/help', classification: 'tenant_required', notes: 'mounted in src/index.ts. F5: runtime-enforced via mountHelpRoutes (shared demo-family gate — zero-spend anonymous chat in a demo runtime; platform-admin reindex; tenant kill switch); router reads req.user' },
  { path: '/api/connector-credentials', classification: 'tenant_required', notes: 'sub-route of bare /api mount (connectorCredentialRouter); per-tenant credentials, requireAuth' },
  { path: '/api/credentials', classification: 'tenant_required', notes: 'SecureCredentialManager-backed credential write/read metadata surface; secret values accepted only on POST' },
  { path: '/api/test-connection', classification: 'tenant_required', notes: 'sub-route of bare /api mount (connectorTestRouter); tests tenant connector credentials' },
  { path: '/api/configurations', classification: 'tenant_required', notes: 'mounted at /api/configurations with authMiddleware (configurationRouter); integration configuration CRUD' },
  { path: '/api/enterprise', classification: 'tenant_required', notes: 'sub-route of root / mount (enterpriseFeaturesRouter); /api/enterprise/* surface incl. activity, approvals, golden-set, governance' },

  // --- Public (additional: connector catalog under bare /api mount) ---
  { path: '/api/connector-metadata', classification: 'public', notes: 'sub-route of bare /api mount (connectorCredentialRouter); global connector catalog, no auth' },
] as RouteEntry[]).map((e) => Object.freeze(e)));

/**
 * Longest-prefix match against the manifest. **Unknown paths fall back to
 * 'system'** (the more restrictive default) and emit a one-time-per-path
 * error log. PR 4B's central gate short-circuits 'system' to `next()` (no
 * tenantIsolation), so production stays online — but the log surfaces the
 * drift even if the `--check-tenant-coverage` audit missed it.
 *
 * Rationale (Codex review of this plan): a security-classification layer
 * must NOT silently degrade to 'public' on a miss. The audit gate is the
 * primary safety net; the noisy-default is the runtime backstop.
 *
 * **DoS bound (Copilot R5).** `_unknownPathSeen` is capped at
 * `UNKNOWN_PATH_CAP` entries. After the cap is reached, new unknown
 * paths still classify as 'system' (safe-by-default) but stop emitting
 * logs and stop growing the Set. Without this, an attacker hitting many
 * distinct unclassified `/api/...` paths could cause unbounded memory
 * growth and one log per unique path.
 *
 * PR 2C-Auth follow-up will tighten further: unknown paths will reject
 * with 403 once verified `req.auth.tenantId` is the universal contract.
 */
const UNKNOWN_PATH_CAP = 1024;
const _unknownPathSeen = new Set<string>();

export function classifyRoute(reqPath: string): RouteClassification {
  let best: RouteEntry | null = null;
  for (const entry of ROUTE_MANIFEST) {
    const matches =
      reqPath === entry.path ||
      reqPath.startsWith(entry.path + '/');
    if (matches && (!best || entry.path.length > best.path.length)) {
      best = entry;
    }
  }
  if (best) return best.classification;

  // Already-seen path: don't re-log, don't re-add. Falls through to 'system'.
  if (_unknownPathSeen.has(reqPath)) return 'system';

  // Cap reached: skip logging + skip Set growth. Still safe-by-default
  // (classifies as 'system', central gate short-circuits to next()).
  if (_unknownPathSeen.size >= UNKNOWN_PATH_CAP) return 'system';

  _unknownPathSeen.add(reqPath);
  // Lazy require to avoid pulling logger into pure-module tests.
  try {
    const { logger } = require('../../utils/Logger');
    logger.error(
      '[routeManifest] unclassified route — defaulting to system',
      undefined,
      {
        path: reqPath,
        hint: 'add an entry to ROUTE_MANIFEST and re-run `npm run audit-tenant-coverage`',
      }
    );
  } catch (err: unknown) {
    // Only swallow module-resolution failures (unit tests that import this
    // module without the full Logger DI graph). Any other error (e.g. a
    // TypeError thrown by logger.error itself due to upstream regression)
    // must surface.
    if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
  }
  return 'system';
}

/**
 * Test-only helper. Resets the once-per-path log dedup set so tests can
 * assert the warn path fires deterministically.
 */
export function __resetUnknownPathSeenForTests(): void {
  _unknownPathSeen.clear();
}

/**
 * Returns the deduplicated list of `tenant_required` mount prefixes.
 * Used by the central tenantIsolation mount in RouteSetup.
 */
export function getTenantRequiredPaths(): readonly string[] {
  return ROUTE_MANIFEST
    .filter((e) => e.classification === 'tenant_required')
    .map((e) => e.path);
}
