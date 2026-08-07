import {
  RATE_PROFILES,
  ROUTE_POLICY_MANIFEST,
  matchRoutePolicies,
  resolveRoutePolicy,
  routePrefixMatches,
  AmbiguousRoutePolicyError,
  type RoutePolicy,
} from '../../../src/middleware/setup/routePolicy';

describe('routePolicy — registry + resolver (PR-F0)', () => {
  it('RATE_PROFILES is frozen and every entry documents enforcement', () => {
    expect(Object.isFrozen(RATE_PROFILES)).toBe(true);
    for (const [key, profile] of Object.entries(RATE_PROFILES)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(profile.description.length).toBeGreaterThan(0);
      expect(profile.enforcedBy.length).toBeGreaterThan(0);
    }
  });

  it('documents the secure credential mount in the shared ERP write limiter inventory', () => {
    expect(RATE_PROFILES.erp_write.enforcedBy).toContain('/api/credentials');
  });

  it('routePrefixMatches uses path-component boundaries', () => {
    expect(routePrefixMatches('/api/testing', '/api/testing')).toBe(true);
    expect(routePrefixMatches('/api/testing/run', '/api/testing')).toBe(true);
    expect(routePrefixMatches('/api/testing-extra', '/api/testing')).toBe(false);
  });

  const base = (prefix: string, over: Partial<RoutePolicy> = {}): RoutePolicy => ({
    match: { pathPrefix: prefix },
    auth: 'required',
    lifecycle: 'enforce',
    rateProfile: 'tenant_api',
    ...over,
  });

  it('longer pathPrefix outranks shorter', () => {
    const policies = [base('/api/x'), base('/api/x/y', { rateProfile: 'erp_write' })];
    expect(resolveRoutePolicy('/api/x/y/z', 'GET', policies)?.rateProfile).toBe('erp_write');
    expect(resolveRoutePolicy('/api/x/other', 'GET', policies)?.rateProfile).toBe('tenant_api');
  });

  it('subpath refinement outranks the base policy; methods filter applies', () => {
    const policies: RoutePolicy[] = [
      base('/api/x'),
      {
        ...base('/api/x', {
          auth: 'platform_admin' as const,
          lifecycle: 'not_applicable' as const,
          rateProfile: 'testing_run' as const,
        }),
        match: { pathPrefix: '/api/x', methods: ['POST'] as const, subpath: /^\/run(\/|$)/ },
      },
    ];
    expect(resolveRoutePolicy('/api/x/run', 'POST', policies)?.rateProfile).toBe('testing_run');
    expect(resolveRoutePolicy('/api/x/run', 'GET', policies)?.rateProfile).toBe('tenant_api');
    expect(resolveRoutePolicy('/api/x/else', 'POST', policies)?.rateProfile).toBe('tenant_api');
  });

  it('subpath matches the prefix-relative remainder ("" normalizes to "/")', () => {
    const policies: RoutePolicy[] = [
      { ...base('/api/x'), match: { pathPrefix: '/api/x', subpath: /^\/$/ } },
      base('/api/x', { rateProfile: 'anonymous_read' }),
    ];
    expect(resolveRoutePolicy('/api/x', 'GET', policies)?.rateProfile).toBe('tenant_api');
  });

  it('throws AmbiguousRoutePolicyError on an equal-specificity tie with differing posture', () => {
    const policies: RoutePolicy[] = [
      { ...base('/api/x'), match: { pathPrefix: '/api/x', methods: ['GET'] as const } },
      {
        ...base('/api/x', { rateProfile: 'erp_write' }),
        match: { pathPrefix: '/api/x', methods: ['GET', 'POST'] as const },
      },
    ];
    // Both match GET; same prefix, no subpath, both have methods → equal specificity vector.
    expect(() => resolveRoutePolicy('/api/x/y', 'GET', policies)).toThrow(AmbiguousRoutePolicyError);
  });

  it('returns null for an unmatched path', () => {
    expect(resolveRoutePolicy('/not/mounted', 'GET', [base('/api/x')])).toBeNull();
  });

  it('matchRoutePolicies returns most-specific first', () => {
    const scoped: RoutePolicy = {
      ...base('/api/x', { rateProfile: 'mcp_schema' }),
      match: { pathPrefix: '/api/x', methods: ['GET'], subpath: /^\/schema(\/|$)/ },
    };
    const all = matchRoutePolicies('/api/x/schema', 'GET', [base('/api/x'), scoped]);
    expect(all).toHaveLength(2);
    expect(all[0].rateProfile).toBe('mcp_schema');
  });

  it('ROUTE_POLICY_MANIFEST entries are deep-frozen', () => {
    for (const p of ROUTE_POLICY_MANIFEST) {
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.match)).toBe(true);
    }
  });

  // ---- populated-manifest integrity (PR-F0 Task 2) ----
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ROUTE_MANIFEST } = require('../../../src/middleware/setup/routeManifest');

  it('policy prefixes are set-equal to ROUTE_MANIFEST paths', () => {
    const manifestPaths = new Set<string>(ROUTE_MANIFEST.map((e: { path: string }) => e.path));
    const policyPrefixes = new Set(ROUTE_POLICY_MANIFEST.map((p) => p.match.pathPrefix));
    expect([...policyPrefixes].filter((p) => !manifestPaths.has(p)).sort()).toEqual([]);
    expect([...manifestPaths].filter((p) => !policyPrefixes.has(p)).sort()).toEqual([]);
  });

  it('every prefix has exactly one base policy (no methods, no subpath)', () => {
    const basesPerPrefix = new Map<string, number>();
    for (const p of ROUTE_POLICY_MANIFEST) {
      if (!p.match.methods && !p.match.subpath) {
        basesPerPrefix.set(p.match.pathPrefix, (basesPerPrefix.get(p.match.pathPrefix) ?? 0) + 1);
      }
    }
    for (const p of ROUTE_POLICY_MANIFEST) {
      expect(basesPerPrefix.get(p.match.pathPrefix) ?? 0).toBe(1);
    }
  });

  it('no HTTP policy grants systemIdentityAllowed in F0', () => {
    expect(ROUTE_POLICY_MANIFEST.filter((p) => p.systemIdentityAllowed)).toEqual([]);
  });

  it('current-posture spot checks resolve through the real manifest', () => {
    expect(resolveRoutePolicy('/api/testing/run', 'POST')?.auth).toBe('platform_admin');
    expect(resolveRoutePolicy('/api/testing/run', 'POST')?.rateProfile).toBe('testing_run');
    // The router registers POST /mcp-schema (testing.ts) — a GET falls to the base policy.
    expect(resolveRoutePolicy('/api/testing/mcp-schema', 'POST')?.auth).toBe('public');
    expect(resolveRoutePolicy('/api/testing/mcp-schema', 'GET')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/testing/whatever', 'GET')?.auth).toBe('required');
    // centralAuthMiddleware exempts /health for every method; Express serves HEAD via GET.
    expect(resolveRoutePolicy('/api/cost-transparency/health', 'GET')?.auth).toBe('public');
    expect(resolveRoutePolicy('/api/cost-transparency/health', 'HEAD')?.auth).toBe('public');
    expect(resolveRoutePolicy('/api/cost-transparency/spend', 'GET')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/integrations/sync', 'POST')?.rateProfile).toBe('erp_write');
    expect(resolveRoutePolicy('/api/ai/proxy/map', 'POST')?.rateProfile).toBe('ai_paid_inference');
    expect(resolveRoutePolicy('/api/ai-demo/x', 'GET')?.auth).toBe('hosted_demo_public');
    expect(resolveRoutePolicy('/api/admin/tenants/t1', 'POST')?.lifecycle).toBe('platform_remediation');
    expect(resolveRoutePolicy('/health', 'GET')?.auth).toBe('public');
  });

  // ---- F2: /api/ai/proxy method-scoped postures ----
  it('F2: paid inference is the fail-safe base posture', () => {
    expect(resolveRoutePolicy('/api/ai/proxy/orchestrate', 'POST')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/ai/proxy/orchestrate', 'POST')?.rateProfile).toBe('ai_paid_inference');
    expect(resolveRoutePolicy('/api/ai/proxy/nlq', 'POST')?.rateProfile).toBe('ai_paid_inference');
    expect(resolveRoutePolicy('/api/ai/proxy/agents/field-mapping', 'POST')?.rateProfile).toBe('ai_paid_inference');
    // Uncited /mapping endpoints are NOT demo-anonymous:
    expect(resolveRoutePolicy('/api/ai/proxy/mapping/apply-suggestions', 'POST')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/ai/proxy/mapping/detect-unmappable-fields', 'POST')?.auth).toBe('required');
    // Method matters: PATCH on a demo-declared POST path falls to the base policy.
    expect(resolveRoutePolicy('/api/ai/proxy/mapping/suggestions', 'PATCH')?.auth).toBe('required');
    // Undeclared methods on demo subtrees fall through too:
    expect(resolveRoutePolicy('/api/ai/proxy/providers', 'DELETE')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/ai/proxy/mcp', 'PUT')?.auth).toBe('required');
  });

  it('F2: GET/HEAD anywhere in the family is ai_read (no GET performs paid inference)', () => {
    expect(resolveRoutePolicy('/api/ai/proxy/status', 'GET')?.rateProfile).toBe('ai_read');
    expect(resolveRoutePolicy('/api/ai/proxy/models/openai/capabilities', 'GET')?.rateProfile).toBe('ai_read');
    expect(resolveRoutePolicy('/api/ai/proxy/telemetry/statistics', 'HEAD')?.rateProfile).toBe('ai_read');
    expect(resolveRoutePolicy('/api/ai/proxy/mapping/stats', 'GET')?.rateProfile).toBe('ai_read');
    expect(resolveRoutePolicy('/api/ai/proxy/mapping/stats', 'GET')?.auth).toBe('required');
  });

  it('F2: global provider-config mutations are platform_admin', () => {
    for (const [path, method] of [
      ['/api/ai/proxy/provider-config', 'GET'],
      ['/api/ai/proxy/provider-config', 'PUT'],
      ['/api/ai/proxy/provider-config/test', 'POST'],
      ['/api/ai/proxy/models/openai/select', 'POST'],
    ] as const) {
      const p = resolveRoutePolicy(path, method);
      expect(p?.auth).toBe('platform_admin');
      expect(p?.rateProfile).toBe('ai_provider_config');
      expect(p?.lifecycle).toBe('not_applicable');
    }
  });

  it('F2: the exact demo allowlist is hosted_demo_public/anonymous_demo', () => {
    for (const [path, method] of [
      ['/api/ai/proxy/providers', 'GET'],
      ['/api/ai/proxy/providers/openai/test', 'POST'],
      ['/api/ai/proxy/mapping/suggestions', 'POST'],
      ['/api/ai/proxy/mapping/feedback', 'POST'],
      ['/api/ai/proxy/mapping/schemas/salesforce', 'GET'],
      ['/api/ai/proxy/mapping/transformation/suggest', 'POST'],
      ['/api/ai/proxy/mapping/validation/suggest', 'POST'],
      ['/api/ai/proxy/mapping/defaultvalue/suggest', 'POST'],
      ['/api/ai/proxy/suggestions/s-1/accept', 'POST'],
      ['/api/ai/proxy/mcp', 'POST'],
      ['/api/ai/proxy/mcp/tools', 'GET'],
    ] as const) {
      const p = resolveRoutePolicy(path, method);
      expect(p?.auth).toBe('hosted_demo_public');
      expect(p?.lifecycle).toBe('not_applicable');
      expect(p?.rateProfile).toBe('anonymous_demo');
    }
  });

  it('F2: demo carve-outs do NOT leak to undeclared paid endpoints', () => {
    expect(resolveRoutePolicy('/api/ai/proxy/orchestrate', 'POST')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/ai/proxy/business-intelligence/analyze', 'POST')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/ai/proxy/data-quality/analyze', 'POST')?.auth).toBe('required');
  });
});
