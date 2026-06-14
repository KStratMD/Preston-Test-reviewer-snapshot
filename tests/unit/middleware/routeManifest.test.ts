import {
  ROUTE_MANIFEST,
  classifyRoute,
  getTenantRequiredPaths,
  __resetUnknownPathSeenForTests,
  type RouteClassification,
  type RouteEntry,
} from '../../../src/middleware/setup/routeManifest';

describe('routeManifest', () => {
  describe('ROUTE_MANIFEST', () => {
    it('declares no entries with classification "TBD"', () => {
      const valid: RouteClassification[] = ['public', 'system', 'tenant_required', 'demo'];
      for (const entry of ROUTE_MANIFEST) {
        expect(valid).toContain(entry.classification);
      }
    });

    it('lists every entry path as unique within its classification', () => {
      const byClass = new Map<RouteClassification, Set<string>>();
      for (const entry of ROUTE_MANIFEST) {
        const set = byClass.get(entry.classification) ?? new Set();
        expect(set.has(entry.path)).toBe(false);
        set.add(entry.path);
        byClass.set(entry.classification, set);
      }
    });

    it('has globally unique path entries (no path appears under two classifications)', () => {
      const seen = new Set<string>();
      for (const entry of ROUTE_MANIFEST) {
        expect(seen.has(entry.path)).toBe(false);
        seen.add(entry.path);
      }
    });

    it('each entry is individually frozen (deep-immutability per Copilot R7)', () => {
      // Defends against `(ROUTE_MANIFEST[0] as any).classification = 'public'`
      // silently changing security classification at runtime. Object.freeze on
      // the array alone is shallow — each entry must also be frozen.
      for (const entry of ROUTE_MANIFEST) {
        expect(Object.isFrozen(entry)).toBe(true);
      }
      // Spot-check: writing to a frozen entry throws in strict mode.
      expect(() => {
        (ROUTE_MANIFEST[0] as { classification: string }).classification = 'demo';
      }).toThrow(TypeError);
    });
  });

  describe('classifyRoute (longest-prefix match)', () => {
    it('returns tenant_required for /api/governance/approvals', () => {
      expect(classifyRoute('/api/governance/approvals/abc-123')).toBe('tenant_required');
    });

    it('returns demo for /api/ai-demo/*', () => {
      expect(classifyRoute('/api/ai-demo/quick')).toBe('demo');
    });

    it('returns public for /health', () => {
      expect(classifyRoute('/health')).toBe('public');
    });

    it('returns system for /api/admin/tenants/*', () => {
      expect(classifyRoute('/api/admin/tenants/xyz')).toBe('system');
    });

    it('prefers longer match: /api/ai-demo vs /api/ai/proxy', () => {
      expect(classifyRoute('/api/ai/proxy/completions')).toBe('tenant_required');
      expect(classifyRoute('/api/ai-demo/anything')).toBe('demo');
    });

    it('returns system (NOT public) for unknown paths — security-fail-safe default per Codex review', () => {
      expect(classifyRoute('/totally-unknown-pr4b-xyz')).toBe('system');
    });

    it('logs error.once-per-path for unknown paths and dedups subsequent calls', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Logger = require('../../../src/utils/Logger');
      const spy = jest.spyOn(Logger.logger, 'error').mockImplementation(() => {});
      __resetUnknownPathSeenForTests();
      classifyRoute('/unknown-dedup-test-pr4b');
      classifyRoute('/unknown-dedup-test-pr4b');
      classifyRoute('/unknown-dedup-test-pr4b');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        '[routeManifest] unclassified route — defaulting to system',
        undefined,
        expect.objectContaining({ path: '/unknown-dedup-test-pr4b' })
      );
      spy.mockRestore();
    });

    it('caps _unknownPathSeen to bound memory/log volume under attacker path enumeration (R5 DoS fix)', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Logger = require('../../../src/utils/Logger');
      const spy = jest.spyOn(Logger.logger, 'error').mockImplementation(() => {});
      __resetUnknownPathSeenForTests();

      // Hit 1100 distinct unknown paths. Cap is 1024 — expect at most 1024
      // logger.error fires matching the unclassified message, never more.
      for (let i = 0; i < 1100; i++) {
        const result = classifyRoute(`/unknown-cap-test-pr4b/${i}`);
        // Safe-by-default: even after cap, classification stays 'system'.
        expect(result).toBe('system');
      }
      const unclassifiedFires = spy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('unclassified route')
      );
      expect(unclassifiedFires.length).toBeLessThanOrEqual(1024);
      expect(unclassifiedFires.length).toBeGreaterThan(1000);  // sanity: at least most fired
      spy.mockRestore();
    });
  });

  describe('getTenantRequiredPaths', () => {
    it('returns a non-empty array', () => {
      expect(getTenantRequiredPaths().length).toBeGreaterThan(0);
    });

    it('every returned path is classified tenant_required in the manifest', () => {
      const tenantRequired = getTenantRequiredPaths();
      for (const p of tenantRequired) {
        const entry = ROUTE_MANIFEST.find((e: RouteEntry) => e.path === p);
        expect(entry).toBeDefined();
        expect(entry!.classification).toBe('tenant_required');
      }
    });

    it('contains no duplicates', () => {
      const paths = getTenantRequiredPaths();
      expect(new Set(paths).size).toBe(paths.length);
    });
  });
});
