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
  { path: '/api/identity', classification: 'public', notes: 'display-only whoami for the top-rail Admin menu; optional auth, resolves via canonical isSystemIdentity(extractIdentityContext) — echoes the user only for a non-system identity, demo fallback for system (tenant-less JWT) or unauthenticated callers; no tenant-scoped data' },
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

  // --- Demo (intentionally unisolated) ---
  { path: '/api/ai-demo', classification: 'demo' },
  { path: '/api/full-pipeline-demo', classification: 'demo' },
  { path: '/api/data-migration', classification: 'demo', notes: 'demo migration playground' },

  // --- Tenant-required (the gated set) ---
  { path: '/api/ai/proxy', classification: 'tenant_required', notes: 'AI provider proxy; governance + tenant scoping' },
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
  { path: '/api/context', classification: 'tenant_required' },
  { path: '/api/embedded/host-bootstrap', classification: 'tenant_required' },
  { path: '/api/embedded/context', classification: 'tenant_required' },
  { path: '/api/embedded/sessions', classification: 'tenant_required' },
  { path: '/api/embedded/lineage', classification: 'tenant_required', notes: 'PR 12 follow-up: record-level lineage operator UI; auths via validateGuestContext (embedded session) — tenant_id scopes the lookup, no Bearer JWT path' },
  { path: '/api/embedded/reconciliation', classification: 'tenant_required', notes: '#862 follow-up (c): reconciliation operator UI; auths via validateGuestContext (embedded session) — tenant_id scopes the lookup, no Bearer JWT path' },
  { path: '/api/governance/approvals', classification: 'tenant_required', notes: 'HITL queue; Codex-5.4 401 gate inside router' },
  { path: '/api/governance', classification: 'tenant_required', notes: 'PR 13b: operationsRouter (ownership-rejections, loop-detections) — embedded-session auth via validateGuestContext + requireApproverRole inside router' },
  { path: '/api/actions', classification: 'tenant_required' },
  { path: '/api/documents', classification: 'tenant_required' },
  { path: '/api/feature-flags', classification: 'tenant_required' },
  { path: '/api/roi-dashboard', classification: 'tenant_required' },
  { path: '/api/suitecentral/sync', classification: 'tenant_required' },
  { path: '/api/suitecentral/netsuite/sync', classification: 'tenant_required' },
  { path: '/api/squire/suitecentral/netsuite/sync', classification: 'tenant_required' },
  { path: '/api/suitecentral/prod', classification: 'tenant_required', notes: 'PR-A6: tenant-admin SuiteCentral control plane; authMiddleware + requireSuiteCentralTenantAdmin. The router sources the target tenant from the verified JWT claim only.' },
  { path: '/api/payment-central', classification: 'tenant_required', notes: 'centralAuthMiddleware + tenantStatusGate already in place' },
  { path: '/api/supplier-central', classification: 'tenant_required' },
  { path: '/api/customer-central', classification: 'tenant_required' },
  { path: '/api/quality-central', classification: 'tenant_required' },
  { path: '/api/payout-central', classification: 'tenant_required' },
  { path: '/api/installer-central', classification: 'tenant_required' },
  { path: '/api/service-central', classification: 'tenant_required' },
  { path: '/api/inventory-central', classification: 'tenant_required' },
  { path: '/api/finance-central', classification: 'tenant_required' },
  { path: '/api/contract-central', classification: 'tenant_required' },
  { path: '/api/portal-central', classification: 'tenant_required' },
  { path: '/api/workflow-central', classification: 'tenant_required' },
  { path: '/api/shipstation', classification: 'tenant_required' },
  { path: '/api/hubspot', classification: 'tenant_required' },
  { path: '/api/sync-central', classification: 'tenant_required' },
  { path: '/api/sync-orchestrator', classification: 'tenant_required' },
  { path: '/api/automation-libraries', classification: 'tenant_required' },
  { path: '/api/nl-action-gate', classification: 'tenant_required' },
  { path: '/api/mdm', classification: 'tenant_required' },
  { path: '/api/compliance', classification: 'tenant_required' },
  { path: '/api/sync-error-assist', classification: 'tenant_required', notes: 'pathless mount via syncErrorAssistRoutes; routes defined as absolute /api/sync-error-assist/* inside the router' },
  { path: '/api/cost-transparency', classification: 'tenant_required', notes: 'cost dashboard + anomaly; /api/cost-transparency/health is a static unauthenticated probe' },
  { path: '/api/reconciliation-center', classification: 'tenant_required', notes: 'PR 11: durable exception queue + resolve; identity_required 401 when extractIdentityContext returns SYSTEM_IDENTITY' },
  { path: '/api/lineage', classification: 'tenant_required', notes: 'PR 12: record-level lineage; requires Bearer JWT via centralAuthMiddleware + route-internal extractIdentityContext gate that 401s when tenantId resolves to SYSTEM_IDENTITY OR userId is missing OR userId is a synthetic sentinel (SYSTEM_IDENTITY.userId, "unknown" from auth.ts) — mirrors reconciliation resolve route' },
  { path: '/api/help', classification: 'tenant_required', notes: 'mounted in src/index.ts; help.ts reads identity via extractIdentityContext' },
  { path: '/api/connector-credentials', classification: 'tenant_required', notes: 'sub-route of bare /api mount (connectorCredentialRouter); per-tenant credentials, requireAuth' },
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
