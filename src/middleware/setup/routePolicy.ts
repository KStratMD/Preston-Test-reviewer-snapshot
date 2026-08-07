/**
 * Route Policy Manifest (PR-F0).
 *
 * Design: docs/superpowers/specs/2026-07-17-tenant-auth-strictmode-migration-design.md §D2/§D5-F0.
 *
 * DECLARATIVE in F0; runtime consumption arrives per family PR. F2's
 * `/api/ai/proxy` and F5's demo families are runtime-dispatched through
 * `resolveRoutePolicy` by `createDemoFamilyPolicyGate` (with the
 * `createAiProxyPolicyGate` compatibility wrapper). `/api/ai-demo` and
 * `/api/data-migration` remain declarative and ungated until their owning
 * follow-up.
 * The blocking audit gate is `npm run audit-route-policy`
 * (`scripts/check-route-policy.mjs`), which vm-loads THIS module — so this
 * file must stay import-free (pure data + pure functions).
 *
 * `rateProfile` is a CLOSED registry key (Codex condition, 2026-07-18
 * review): adding a profile means adding a RATE_PROFILES entry with a
 * description and an honest `enforcedBy` note. Most profiles are
 * declarative-only until their family PR wires a limiter — the global
 * limiter is a documented no-op (see docs/guides/SECURITY-AND-RATE-LIMITING.md).
 */

export const RATE_PROFILES = Object.freeze({
  anonymous_read: Object.freeze({
    description: 'Unauthenticated read-only surface (probes, docs, catalogs, redirect shims)',
    enforcedBy: 'declarative_only',
  }),
  anonymous_demo: Object.freeze({
    description: 'Hosted-demo anonymous surface — demo/fixture data only, never tenant data, ZERO provider spend',
    enforcedBy:
      'createAiDemoRateLimit (30/15min/IP) + 64KiB parsed-body cap via createDemoFamilyPolicyGate (and createAiProxyPolicyGate compatibility wrapper) for F2 /api/ai/proxy and F5 /api/context + /api/actions + /api/help (chat/audiences/status); /api/ai-demo and /api/data-migration remain declarative/ungated pending owning follow-ups',
  }),
  tenant_api: Object.freeze({
    description: 'Standard authenticated tenant API traffic',
    enforcedBy: 'declarative_only',
  }),
  erp_write: Object.freeze({
    description: 'Mutating ERP write families (duplicate-write blast radius)',
    enforcedBy:
      'createErpWriteRateLimit via limitMutatingMethods on /api/integrations + the seven F4 mounts (hubspot/shipstation/SuiteCentral-syncs/full-pipeline-demo behind requirePlatformAdmin, nl-action-gate behind the tenant kill switch; limiter after auth/authz) plus PR3\'s /api/sync-orchestrator (mountSyncOrchestratorRoutes, also behind requirePlatformAdmin) and /api/credentials (mountSecureCredentialRoutes)',
  }),
  ai_paid_inference: Object.freeze({
    description: 'Paid AI inference (per-request provider spend) — authenticated only as of F2',
    enforcedBy:
      'authMiddleware + tenantStatusGate at mountAiProxyRoutes + family aiRateLimit (100/15min/IP) in aiProxy.ts (F2); anonymous demo requests never reach a provider (zero-spend invariant)',
  }),
  ai_read: Object.freeze({
    description: 'AI-family reads (status, catalogs, telemetry, dashboards, rule-based compute) — no provider spend',
    enforcedBy: 'family aiRateLimit (100/15min/IP) in aiProxy.ts; auth via mountAiProxyRoutes (F2)',
  }),
  ai_provider_config: Object.freeze({
    description: 'Process-global AI provider configuration + connectivity testing — platform-admin surface',
    enforcedBy: 'requirePlatformAdmin via createAiProxyPolicyGate + family aiRateLimit (F2)',
  }),
  testing_run: Object.freeze({
    description: 'Test-runner execution (spawns a child process)',
    enforcedBy: 'createTestingRunRateLimit (10/15min) inside the testing router',
  }),
  mcp_schema: Object.freeze({
    description: 'Anonymous MCP schema reads for ai-config-dashboard',
    enforcedBy: 'createMcpSchemaRateLimit inside the testing router',
  }),
  admin_ops: Object.freeze({
    description: 'Platform-admin / ops operations',
    enforcedBy: 'declarative_only',
  }),
  serialized_asset_readiness: Object.freeze({
    description:
      'Serialized-asset activation readiness + activation — each request costs a secret-manager read, a connector initialization, and two live Salesforce describe round-trips',
    enforcedBy:
      'createSerializedAssetReadinessRateLimit (20/15min per (IP, user)) on POST /:id/serialized-asset-readiness and POST /:id/activate inside the configuration router; one shared instance so the two routes share a budget; runs after authMiddleware + tenantStatusGate (mountConfigurationRoutes)',
  }),
  serialized_asset_forced_retry: Object.freeze({
    description:
      'Serialized-asset forced deferred-unit retry (decision 11) — a full sync that bypasses next_attempt_at and MAX_DEFERRAL_ATTEMPTS, re-sweeping the source and re-running live Salesforce readiness before any write',
    enforcedBy:
      'createSerializedAssetForcedRetryRateLimit (10/15min per (IP, user)) on POST /:id/serialized-assets/retry-deferred inside the integration router; runs after authMiddleware + tenantStatusGate (mountIntegrationRoutes) AND requireIntegrationTenantAdmin in-router, so guard-rejected traffic never consumes this budget',
  }),
} as const);

export type RateProfileKey = keyof typeof RATE_PROFILES;

/**
 * OPTIONS is included for completeness of method-scoped policies even though
 * preflight requests are answered by the CORS layer before routing — a policy
 * vocabulary that cannot express OPTIONS would force casts the moment a
 * family PR needs it (Copilot R2 on PR #1036).
 */
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/** Authentication posture (design §D2). */
export type RouteAuthPosture = 'required' | 'platform_admin' | 'hosted_demo_public' | 'public';

/** Tenant lifecycle (kill-switch) posture (design §D2 + resolved question 2). */
export type RouteLifecyclePosture = 'enforce' | 'platform_remediation' | 'not_applicable';

export interface RoutePolicyMatch {
  /** Must equal a ROUTE_MANIFEST entry path (audit-enforced set equality). */
  pathPrefix: string;
  /** Absent = all methods. */
  methods?: readonly HttpMethod[];
  /**
   * Tested against the prefix-relative remainder of the request path
   * ('' normalizes to '/'). Prefer the statically-analyzable anchored
   * literal form /^\/segment(\/|$)/ or /^\/seg\/sub(\/|$)/ — the audit
   * proves two such literals disjoint when neither is a segment-prefix
   * of the other; any other form stays AMBIGUOUS_OVERLAP.
   */
  subpath?: RegExp;
}

export interface RoutePolicy {
  match: RoutePolicyMatch;
  auth: RouteAuthPosture;
  lifecycle: RouteLifecyclePosture;
  rateProfile: RateProfileKey;
  /** Explicit allowance for background/system identity — absent means forbidden. */
  systemIdentityAllowed?: 'background_job_only';
  /** Reviewer-facing rationale, same convention as RouteEntry.notes. */
  notes?: string;
}

/** Same path-component boundary semantics as classifyRoute's prefix match. */
export function routePrefixMatches(reqPath: string, prefix: string): boolean {
  return reqPath === prefix || reqPath.startsWith(prefix + '/');
}

export class AmbiguousRoutePolicyError extends Error {
  readonly candidates: readonly RoutePolicy[];
  constructor(reqPath: string, method: HttpMethod, candidates: readonly RoutePolicy[]) {
    super(
      `Ambiguous route policy for ${method} ${reqPath}: ${candidates.length} equal-specificity candidates ` +
        `(pathPrefix ${candidates.map((c) => `'${c.match.pathPrefix}'`).join(', ')}). ` +
        'Fix ROUTE_POLICY_MANIFEST — the audit gate should have rejected this.',
    );
    this.name = 'AmbiguousRoutePolicyError';
    this.candidates = candidates;
  }
}

/**
 * Specificity vector, compared lexicographically:
 *   1. pathPrefix length (longer wins)
 *   2. subpath present (path scoping is finer than verb scoping)
 *   3. methods present
 */
function specificity(p: RoutePolicy): [number, number, number] {
  return [p.match.pathPrefix.length, p.match.subpath ? 1 : 0, p.match.methods ? 1 : 0];
}

function compareSpecificity(a: RoutePolicy, b: RoutePolicy): number {
  const sa = specificity(a);
  const sb = specificity(b);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return sb[i] - sa[i];
  }
  return 0;
}

function policyMatches(p: RoutePolicy, reqPath: string, method: HttpMethod): boolean {
  if (!routePrefixMatches(reqPath, p.match.pathPrefix)) return false;
  if (p.match.methods && !p.match.methods.includes(method)) return false;
  if (p.match.subpath) {
    const remainder = reqPath.slice(p.match.pathPrefix.length) || '/';
    if (!p.match.subpath.test(remainder)) return false;
  }
  return true;
}

/** All matching policies, most-specific first. */
export function matchRoutePolicies(
  reqPath: string,
  method: HttpMethod,
  policies: readonly RoutePolicy[] = ROUTE_POLICY_MANIFEST,
): RoutePolicy[] {
  return policies.filter((p) => policyMatches(p, reqPath, method)).sort(compareSpecificity);
}

/**
 * Single best policy or null. Throws AmbiguousRoutePolicyError when the two
 * most-specific matches tie — the audit gate statically rejects manifests
 * that can produce this; the throw is the runtime backstop.
 */
export function resolveRoutePolicy(
  reqPath: string,
  method: HttpMethod,
  policies: readonly RoutePolicy[] = ROUTE_POLICY_MANIFEST,
): RoutePolicy | null {
  const matched = matchRoutePolicies(reqPath, method, policies);
  if (matched.length === 0) return null;
  if (matched.length > 1 && compareSpecificity(matched[0], matched[1]) === 0) {
    throw new AmbiguousRoutePolicyError(
      reqPath,
      method,
      matched.filter((m) => compareSpecificity(m, matched[0]) === 0),
    );
  }
  return matched[0];
}

function deepFreezePolicy(p: RoutePolicy): RoutePolicy {
  Object.freeze(p.match);
  if (p.match.methods) Object.freeze(p.match.methods);
  return Object.freeze(p);
}

/**
 * One BASE policy (no methods/subpath) per ROUTE_MANIFEST prefix, plus
 * method/subpath-scoped refinements where today's posture genuinely differs
 * by subroute. F0 re-expresses the EXISTING classification vocabulary
 * (mapping rule below) — behavior decisions per family land in F1–F5.
 *
 *   public          → auth 'public',            lifecycle 'not_applicable'
 *   demo            → auth 'hosted_demo_public', lifecycle 'not_applicable'
 *   system          → auth 'platform_admin' | 'required',
 *                     lifecycle 'not_applicable' | 'platform_remediation'
 *   tenant_required → auth 'required',          lifecycle 'enforce'
 *
 * `lifecycle: 'enforce'` declares the TARGET kill-switch posture (resolved
 * question 2: suspended tenants are blocked from every tenant-scoped
 * surface); the tenantStatusGate mounts that make it real land per family.
 */
export const ROUTE_POLICY_MANIFEST: readonly RoutePolicy[] = Object.freeze(
  ([
    // --- public ---
    { match: { pathPrefix: '/health' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },
    { match: { pathPrefix: '/ready' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },
    { match: { pathPrefix: '/api/metrics' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'METRICS_SCRAPE_TOKEN-gated when set; 403 in production when unset' },
    { match: { pathPrefix: '/api/ai' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'PR 1B 301 redirect shim' },
    { match: { pathPrefix: '/api/download' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },
    { match: { pathPrefix: '/api/identity' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'display-only whoami; no tenant-scoped data' },
    { match: { pathPrefix: '/docs' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },
    { match: { pathPrefix: '/api-docs' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },
    { match: { pathPrefix: '/api/connector-metadata' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'global connector catalog' },

    // --- system (admin/ops) ---
    { match: { pathPrefix: '/api/admin/tenants' }, auth: 'platform_admin', lifecycle: 'platform_remediation', rateProfile: 'admin_ops', notes: 'THE remediation surface — must stay reachable for suspended tenants' },
    { match: { pathPrefix: '/api/admin/settings' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'admin_ops' },
    { match: { pathPrefix: '/api/admin/tenants/:tenantId/suitecentral' }, auth: 'platform_admin', lifecycle: 'platform_remediation', rateProfile: 'admin_ops', notes: 'PR-A6 platform control plane; tenant from path' },
    { match: { pathPrefix: '/api/admin/suitecentral/allowed-hosts' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'admin_ops', notes: 'platform-global egress allowlist; not tenant-scoped' },
    { match: { pathPrefix: '/metrics' }, auth: 'required', lifecycle: 'not_applicable', rateProfile: 'admin_ops', notes: 'ENABLE_METRICS + authMiddleware' },
    { match: { pathPrefix: '/api/disaster-recovery' }, auth: 'required', lifecycle: 'not_applicable', rateProfile: 'admin_ops', notes: 'ops-only; handler-level auth today — candidate for platform_admin in a family PR' },
    { match: { pathPrefix: '/api/disaster-recovery/dashboard' }, auth: 'required', lifecycle: 'not_applicable', rateProfile: 'admin_ops', notes: 'ops-only' },
    { match: { pathPrefix: '/api/statistics' }, auth: 'required', lifecycle: 'not_applicable', rateProfile: 'admin_ops', notes: 'authMiddleware since #951; global config state, not tenant-scoped' },

    // --- demo (intentionally unisolated; demo/fixture data only) ---
    { match: { pathPrefix: '/api/ai-demo' }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo' },
    { match: { pathPrefix: '/api/data-migration' }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'demo migration playground' },

    // --- tenant_required: AI (F2 — method-scoped postures; design resolved question 1) ---
    // Base = fail-safe: any subroute not refined below is treated as paid
    // inference requiring auth. Every paid-INFERENCE endpoint in the family
    // is a POST (2026-07-21 inventory). GET/HEAD never performs inference,
    // but GET /providers can spend through live connectivity probes; its
    // dedicated demo refinement and Task 8's anonymous fixture close that path.
    { match: { pathPrefix: '/api/ai/proxy' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'ai_paid_inference', notes: 'F2: runtime-enforced at mountAiProxyRoutes via createAiProxyPolicyGate — the first runtime consumer of this manifest' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['GET', 'HEAD'] }, auth: 'required', lifecycle: 'enforce', rateProfile: 'ai_read', notes: 'no GET/HEAD in the family performs paid INFERENCE; GET /providers live-probes providers (testConnection can spend) — its demo refinement + Task-8 anonymous fixture handle that; subpath refinements below outrank this (subpath > methods in the specificity vector)' },
    // Process-global provider configuration: platform-admin only (a tenant
    // JWT must not mutate every tenant's provider/model state, and the stored
    // config can embed cloud API-key material — GET included).
    { match: { pathPrefix: '/api/ai/proxy', subpath: /^\/provider-config(\/|$)/ }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'ai_provider_config', notes: 'GET/PUT config + POST /test — writes a shared file (AIProviderConfigService)' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['POST'], subpath: /^\/models(\/|$)/ }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'ai_provider_config', notes: 'POST /models/:provider/select mutates singleton ModelCatalog state; GET /models* falls to the ai_read refinement' },
    // Hosted-demo allowlist: EXACTLY the method+path surface the shipped demo
    // pages call anonymously (verified 2026-07-21). Anonymous ONLY when a
    // demo runtime is active AND the request presents no credentials (see
    // createAiProxyPolicyGate); in production the demo runtime requires the
    // explicit HOSTED_DEMO=1 deployment flag. Anonymous handling is
    // ZERO-SPEND and fixture-isolated inside the routers (Codex rulings,
    // 2026-07-21 review). lifecycle not_applicable describes the anonymous
    // demo posture (no tenant); credentialed traffic on these paths takes
    // the auth path and still runs the kill-switch gate.
    { match: { pathPrefix: '/api/ai/proxy', methods: ['GET', 'HEAD', 'POST'], subpath: /^\/providers(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'GET provider status + POST /:id/test; anonymous → unprobed/fixture status (testConnection can issue paid completions — Task 8); authenticated → live probes' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['POST'], subpath: /^\/mapping\/suggestions(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'anonymous → pure demo mapper (zero spend, no learned state); authenticated → real providers' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['POST'], subpath: /^\/mapping\/feedback(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'anonymous → no-op fixture (no training/telemetry write); authenticated → real feedback persistence' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['GET', 'HEAD'], subpath: /^\/mapping\/schemas(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'hardcoded mock schemas' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['POST'], subpath: /^\/mapping\/transformation(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: '/suggest + /validate — anonymous → rule-based (zero spend)' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['POST'], subpath: /^\/mapping\/validation(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'rule-based' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['POST'], subpath: /^\/mapping\/defaultvalue(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'rule-based' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['POST'], subpath: /^\/suggestions(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'POST /suggestions/:id/accept; anonymous → no-op fixture, authenticated → telemetry write' },
    { match: { pathPrefix: '/api/ai/proxy', methods: ['GET', 'HEAD', 'POST'], subpath: /^\/mcp(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'GET/HEAD /tools + JSON-RPC POST; anonymous sessions are fixture-isolated and tool-restricted in-router (decision 6 ruling): field_mapping_suggest=rule-based, integration_status/mcp_discover=fixtures, mcp_call=refused' },

    // --- tenant_required: ERP write families ---
    { match: { pathPrefix: '/api/integrations' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'erp_write' },
    // Refinement (Task 9, review MINOR 2): the forced-retry route bypasses
    // next_attempt_at / MAX_DEFERRAL_ATTEMPTS and carries its own budget,
    // same precedent as the configurations readiness/activate refinement
    // above. The `:id` segment again makes an anchored-literal subpath
    // impossible; this is the only subpath-bearing policy on this prefix, so
    // the subpath dimension strictly orders it above the base policy.
    //
    // NOTE (on record before F6): `RouteAuthPosture` has no `tenant_admin`
    // value (only 'required' | 'platform_admin' | 'hosted_demo_public' |
    // 'public'), so a tenant-admin-only posture is currently inexpressible in
    // this manifest — this row is declared `auth: 'required'` even though the
    // REAL in-router guard (`requireIntegrationTenantAdmin`) is narrower
    // (verified `tenant_admin` role only, not merely any authenticated
    // tenant caller). F0 is declarative-only for this family (runtime
    // dispatch is still `classifyRoute`), so this gap has no live effect
    // today, but it must be resolved (a `tenant_admin` posture value added)
    // before F6 flips runtime dispatch onto this manifest, or this route
    // would silently under-authorize relative to its real guard.
    {
      match: {
        pathPrefix: '/api/integrations',
        methods: ['POST'],
        subpath: /^\/[^/]+\/serialized-assets\/retry-deferred(\/|$)/,
      },
      auth: 'required',
      lifecycle: 'enforce',
      rateProfile: 'serialized_asset_forced_retry',
      notes: 'requireIntegrationTenantAdmin gates in-router (tenant_admin role only); bypasses MAX_DEFERRAL_ATTEMPTS — see NOTE above on the missing tenant_admin RouteAuthPosture value',
    },
    { match: { pathPrefix: '/api/suitecentral/sync' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'erp_write', notes: 'F4 runtime-enforced at mountSuiteCentralSyncRoutes (authMiddleware + requirePlatformAdmin + shared erp-write limiter); deployment-global IntegrationService — not tenant-scoped' },
    { match: { pathPrefix: '/api/suitecentral/netsuite/sync' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'erp_write', notes: 'F4 runtime-enforced at mountSuiteCentralSyncRoutes; deployment-global IntegrationService — not tenant-scoped' },
    { match: { pathPrefix: '/api/squire/suitecentral/netsuite/sync' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'erp_write', notes: 'F4 runtime-enforced at mountSuiteCentralSyncRoutes; deployment-global IntegrationService — not tenant-scoped' },
    { match: { pathPrefix: '/api/hubspot' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'erp_write', notes: 'F4 runtime-enforced at mountHubSpotRoutes (authMiddleware + requirePlatformAdmin + shared erp-write limiter); singleton env-configured connector — writes additionally need a tenantId claim for guardedWrite attribution' },
    { match: { pathPrefix: '/api/shipstation' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'erp_write', notes: 'F4 runtime-enforced at mountShipStationRoutes (authMiddleware + requirePlatformAdmin + shared erp-write limiter); singleton env-configured connector' },
    { match: { pathPrefix: '/api/full-pipeline-demo' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'erp_write', notes: 'F-track follow-up runtime-enforced at mountFullPipelineDemoRoutes (authMiddleware + requirePlatformAdmin + shared erp-write limiter); deployment-global connectors, so lifecycle is not_applicable. POST /execute additionally requires tenantId + user.id claims for guardedWrite attribution (401 identity_required); that refusal is raised in the handler and therefore AFTER the limiter.' },

    // --- tenant_required: subroute-refined families ---
    { match: { pathPrefix: '/api/testing' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/testing', methods: ['POST'], subpath: /^\/run(\/|$)/ }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'testing_run', notes: 'PR-C #1017: platform-admin-gated inside the router' },
    { match: { pathPrefix: '/api/testing', methods: ['POST'], subpath: /^\/mcp-schema(\/|$)/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'mcp_schema', notes: 'PR-C #1017: stays anonymous for ai-config-dashboard; the router registers POST /mcp-schema' },
    { match: { pathPrefix: '/api/cost-transparency' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/cost-transparency', methods: ['GET', 'HEAD'], subpath: /^\/health\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'static unauthenticated probe enforced by mountCostTransparencyRoutes/shared demo-family gate; Express serves HEAD via the GET handler' },

    // --- tenant_required: default posture (auth required, kill-switch enforce, tenant_api) ---
    { match: { pathPrefix: '/api/settings' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/mcp' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F1: authMiddleware + tenantStatusGate live on the mount (mountMcpPolicyRoutes); strict tenant resolution inside the router' },
    { match: { pathPrefix: '/api/mappings' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/mappings/templates' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/templates' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/dashboard' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/dashboard/api/mappings' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/dashboard/mappings' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/dashboard/mappings/templates' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/dashboard/templates' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/upload' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/fixtures' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/baselines' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/persistence' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/predictive-analytics' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/executive' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/ai-config' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/agents' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/context' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5 runtime-enforced at mountContextRoutes (demo-family policy gate)' },
    { match: { pathPrefix: '/api/context', methods: ['GET', 'HEAD'] }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5: sidecar reads — anonymous branch is buildFallbackContext ONLY (no container/service calls, Codex R1 finding 2); exact allowlist CONTEXT_DEMO_ALLOWLIST; anonymous only under a demo runtime' },
    { match: { pathPrefix: '/api/embedded/host-bootstrap' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/embedded/context' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/embedded/sessions' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/embedded/lineage' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'embedded-session auth (validateGuestContext), no Bearer JWT path. F3: lifecycle runtime-enforced via requireActiveEmbeddedTenant in-router' },
    { match: { pathPrefix: '/api/embedded/reconciliation' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'embedded-session auth (validateGuestContext). F3: lifecycle runtime-enforced via requireActiveEmbeddedTenant in-router' },
    { match: { pathPrefix: '/api/governance/approvals' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F3 runtime-enforced: GET /:id = authMiddleware + JWT kill switch; operator endpoints = validateGuestContext + requireActiveEmbeddedTenant + role gate in-router' },
    { match: { pathPrefix: '/api/governance' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F3 runtime-enforced: all three operationsRouter endpoints carry validateGuestContext + requireActiveEmbeddedTenant + requireApproverRole' },
    { match: { pathPrefix: '/api/actions' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5 runtime-enforced at mountActionIslandRoutes (demo-family policy gate)' },
    { match: { pathPrefix: '/api/actions', methods: ['POST'], subpath: /^\/(request-w9|pause-payments|send-reminder|escalate-csm|track-shipment|create-dispute)(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5: six fixture/simulation writes only; exact allowlist ACTIONS_DEMO_ALLOWLIST; anonymous only under a demo runtime; pure local simulation may be non-deterministic (no provider/store/live-service calls)' },
    { match: { pathPrefix: '/api/actions', methods: ['GET', 'HEAD'], subpath: /^\/health\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'static probe (gate public branch, Task 1)' },
    { match: { pathPrefix: '/api/documents' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/feature-flags' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/roi-dashboard' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/suitecentral/prod' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'tenant-admin control plane; target tenant from verified JWT claim only' },
    { match: { pathPrefix: '/api/payment-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/payment-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: payment-central-dashboard.html + BC Integration hub' },
    { match: { pathPrefix: '/api/payment-central', methods: ['GET', 'HEAD'], subpath: /^\/analytics(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: payment-portal/index.html' },
    { match: { pathPrefix: '/api/payment-central', methods: ['GET', 'HEAD'], subpath: /^\/processors(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: payment-portal/index.html' },
    { match: { pathPrefix: '/api/payment-central', methods: ['GET', 'HEAD'], subpath: /^\/transactions(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: payment-portal/index.html; POST /transactions/:id/sync and /transactions/bulk-sync fall to the strict base (reads-only rule)' },
    { match: { pathPrefix: '/api/payment-central', methods: ['GET', 'HEAD'], subpath: /^\/invoices(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: payment-portal/invoices.html; exact allowlist admits only /invoices and /invoices/statistics' },
    { match: { pathPrefix: '/api/payment-central', methods: ['GET', 'HEAD'], subpath: /^\/disputes(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: payment-portal/invoices.html' },
    { match: { pathPrefix: '/api/payment-central', methods: ['GET', 'HEAD'], subpath: /^\/credit-memos(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: payment-portal/invoices.html' },
    { match: { pathPrefix: '/api/payment-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY base; /health descendants land here' },
    { match: { pathPrefix: '/api/payment-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe' },
    { match: { pathPrefix: '/api/supplier-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/supplier-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: supplier-central-dashboard.html + BC Integration hub' },
    { match: { pathPrefix: '/api/supplier-central', methods: ['GET', 'HEAD'], subpath: /^\/vendors(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: vendor-portal/index.html; exact allowlist admits /vendors, /vendors/:id, /vendors/:id/purchase-orders' },
    { match: { pathPrefix: '/api/supplier-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY base; /health descendants land here' },
    { match: { pathPrefix: '/api/supplier-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe' },
    // --- F5b: *-central dashboard families (runtime-enforced via
    // mountCentralFamilyRoutes + CENTRAL_FAMILY_DEMO_ALLOWLISTS).
    //
    // Each family keeps its strict base policy and adds a GET/HEAD
    // hosted_demo_public read refinement per verified anonymous demo-page
    // caller. Read refinements use the flagless anchored-literal
    // /^\/x(\/|$)/ form — check-route-policy.mjs proves disjointness only for
    // that form.
    //
    // /health lives on its OWN longer prefix (base + exact ^\/?$ public
    // refinement) rather than as a same-prefix refinement. A same-prefix
    // health entry would tie with the read refinement on [prefix, subpath,
    // methods] and the exact ^\/health\/?$ form is not statically provable,
    // so it would have to be widened to ^\/health(\/|$) — which makes
    // /health/<anything> public. The longer prefix keeps the probe exact and
    // leaves descendants on the strict base (Codex review, 2026-07-27).
    { match: { pathPrefix: '/api/customer-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/customer-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: customer-central.html; exact matcher is CENTRAL_FAMILY_DEMO_ALLOWLISTS' },
    { match: { pathPrefix: '/api/customer-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY requires one unscoped policy per prefix; descendants of /health land here' },
    { match: { pathPrefix: '/api/customer-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe, reachable outside a demo runtime' },
    { match: { pathPrefix: '/api/quality-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/quality-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: SuiteCentral-BusinessCentral-Integration-hub.html; exact matcher is CENTRAL_FAMILY_DEMO_ALLOWLISTS' },
    { match: { pathPrefix: '/api/quality-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY requires one unscoped policy per prefix; descendants of /health land here' },
    { match: { pathPrefix: '/api/quality-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe, reachable outside a demo runtime' },
    { match: { pathPrefix: '/api/payout-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/payout-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: payout-central-dashboard.html + BC Integration hub; exact matcher is CENTRAL_FAMILY_DEMO_ALLOWLISTS' },
    { match: { pathPrefix: '/api/payout-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY requires one unscoped policy per prefix; descendants of /health land here' },
    { match: { pathPrefix: '/api/payout-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe, reachable outside a demo runtime' },
    { match: { pathPrefix: '/api/installer-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/installer-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: installer-central-dashboard.html + BC Integration hub; exact matcher is CENTRAL_FAMILY_DEMO_ALLOWLISTS' },
    { match: { pathPrefix: '/api/installer-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY requires one unscoped policy per prefix; descendants of /health land here' },
    { match: { pathPrefix: '/api/installer-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe, reachable outside a demo runtime' },
    { match: { pathPrefix: '/api/service-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/service-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: service-central-dashboard.html + BC Integration hub; exact matcher is CENTRAL_FAMILY_DEMO_ALLOWLISTS' },
    { match: { pathPrefix: '/api/service-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY requires one unscoped policy per prefix; descendants of /health land here' },
    { match: { pathPrefix: '/api/service-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe, reachable outside a demo runtime' },
    { match: { pathPrefix: '/api/inventory-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/inventory-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: inventory-central-dashboard.html + BC Integration hub; exact matcher is CENTRAL_FAMILY_DEMO_ALLOWLISTS' },
    { match: { pathPrefix: '/api/inventory-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY requires one unscoped policy per prefix; descendants of /health land here' },
    { match: { pathPrefix: '/api/inventory-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe, reachable outside a demo runtime' },
    { match: { pathPrefix: '/api/finance-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/finance-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: finance-central-dashboard.html + BC Integration hub; POST /approvals/:id/(approve|reject) fall to the strict base (reads-only rule)' },
    { match: { pathPrefix: '/api/finance-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY base; /health descendants land here' },
    { match: { pathPrefix: '/api/finance-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe' },
    { match: { pathPrefix: '/api/contract-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/contract-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: contract-central-dashboard.html + BC Integration hub; exact matcher is CENTRAL_FAMILY_DEMO_ALLOWLISTS' },
    { match: { pathPrefix: '/api/contract-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY requires one unscoped policy per prefix; descendants of /health land here' },
    { match: { pathPrefix: '/api/contract-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe, reachable outside a demo runtime' },
    { match: { pathPrefix: '/api/portal-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes; empty demo allowlist — no shipped page calls this family' },
    { match: { pathPrefix: '/api/portal-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY base; /health descendants land here' },
    { match: { pathPrefix: '/api/portal-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe' },
    { match: { pathPrefix: '/api/workflow-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b runtime-enforced at mountCentralFamilyRoutes' },
    { match: { pathPrefix: '/api/workflow-central', methods: ['GET', 'HEAD'], subpath: /^\/dashboard(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5b: workflow-central-dashboard.html' },
    { match: { pathPrefix: '/api/workflow-central/health' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5b: BASE_POLICY base; /health descendants land here' },
    { match: { pathPrefix: '/api/workflow-central/health', methods: ['GET', 'HEAD'], subpath: /^\/?$/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read', notes: 'F5b: EXACT monitoring probe' },
    { match: { pathPrefix: '/api/sync-central' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/sync-orchestrator' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'erp_write', notes: 'PR3 runtime-enforced at mountSyncOrchestratorRoutes (authMiddleware + requirePlatformAdmin + shared erp-write limiter); process-global operation store — not tenant-scoped' },
    { match: { pathPrefix: '/api/automation-libraries' }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'admin_ops', notes: 'PR3 runtime-enforced at mountAutomationLibrariesRoutes (authMiddleware + requirePlatformAdmin); process-global demo stores; admin_ops is declarative_only, so no limiter is attached' },
    { match: { pathPrefix: '/api/nl-action-gate' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'erp_write', notes: 'F4 runtime-enforced at mountNlActionGateRoutes (auth + kill switch + limiter); tenant-scoped action store; reclassified erp_write (execute dispatches connector writes)' },
    { match: { pathPrefix: '/api/mdm' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/compliance' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/sync-error-assist' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/reconciliation-center' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F3 runtime-enforced at mountReconciliationCenterRoutes (authMiddleware + kill switch, unconditional)' },
    { match: { pathPrefix: '/api/lineage' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F3 runtime-enforced at mountLineageRoutes (authMiddleware + kill switch, unconditional)' },
    { match: { pathPrefix: '/api/help' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api', notes: 'F5 runtime-enforced at mountHelpRoutes; production mount is late in src/index.ts and the JSON error handler is re-registered after it' },
    { match: { pathPrefix: '/api/help', methods: ['POST'], subpath: /^\/chat(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5: anonymous local-retrieval only; no ProviderRegistry, session store, telemetry, governance, embedding, or live service calls; internal audience remains forbidden; helpChatRateLimit remains' },
    { match: { pathPrefix: '/api/help', methods: ['GET', 'HEAD'], subpath: /^\/(audiences|status)(\/|$)/ }, auth: 'hosted_demo_public', lifecycle: 'not_applicable', rateProfile: 'anonymous_demo', notes: 'F5: static help metadata available to an anonymous hosted demo' },
    { match: { pathPrefix: '/api/help', methods: ['POST'], subpath: /^\/reindex(\/|$)/ }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'tenant_api', notes: 'F5: shared documentation index operator-only' },
    { match: { pathPrefix: '/api/connector-credentials' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/credentials' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'erp_write', notes: 'SecureCredentialManager-backed secret write surface; mutating methods use the shared ERP write limiter; responses contain references/metadata only' },
    { match: { pathPrefix: '/api/test-connection' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    { match: { pathPrefix: '/api/configurations' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
    // Refinement (Task 6): the two POSTs that can trigger live Salesforce
    // discovery carry their own budget. The `:id` segment makes an
    // anchored-literal subpath impossible, which is fine here — this is the
    // ONLY subpath-bearing policy on the prefix, and the subpath dimension
    // strictly orders it above the base policy.
    {
      match: {
        pathPrefix: '/api/configurations',
        methods: ['POST'],
        subpath: /^\/[^/]+\/(serialized-asset-readiness|activate)(\/|$)/,
      },
      auth: 'required',
      lifecycle: 'enforce',
      rateProfile: 'serialized_asset_readiness',
      notes: 'secret-manager read + connector init + two live Salesforce describes per request',
    },
    { match: { pathPrefix: '/api/enterprise' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
  ] as RoutePolicy[]).map(deepFreezePolicy),
);
