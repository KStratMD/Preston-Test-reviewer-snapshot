import {
  ROUTE_MANIFEST,
  classifyRoute,
  getTenantRequiredPaths,
  findManifestEntry,
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

    it('logs once per path at WARN for unmatched paths and dedups subsequent calls', () => {
      // B8: this path is usually reached by 404 traffic, so ERROR was the wrong
      // level. It is NOT debug either: nothing enforces mount coverage yet, so
      // this stays the only runtime signal that an undeclared surface is being
      // served and must remain visible. An error-level spy is asserted silent
      // so a revert to logger.error fails here rather than quietly restoring
      // production error noise.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Logger = require('../../../src/utils/Logger');
      const warnSpy = jest.spyOn(Logger.logger, 'warn').mockImplementation(() => {});
      const errorSpy = jest.spyOn(Logger.logger, 'error').mockImplementation(() => {});
      __resetUnknownPathSeenForTests();
      classifyRoute('/api/unknown-dedup-test-pr4b');
      classifyRoute('/api/unknown-dedup-test-pr4b');
      classifyRoute('/api/unknown-dedup-test-pr4b');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[routeManifest] unmatched /api path — no manifest entry, treating as system',
        expect.objectContaining({ path: '/api/unknown-dedup-test-pr4b' })
      );
      expect(errorSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('caps _unknownPathSeen to bound memory/log volume under attacker path enumeration (R5 DoS fix)', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Logger = require('../../../src/utils/Logger');
      const spy = jest.spyOn(Logger.logger, 'warn').mockImplementation(() => {});
      __resetUnknownPathSeenForTests();

      // Hit 1100 distinct unknown paths. Cap is 1024 — expect at most 1024
      // logger.warn fires matching the unmatched-path message, never more.
      for (let i = 0; i < 1100; i++) {
        const result = classifyRoute(`/api/unknown-cap-test-pr4b/${i}`);
        // Safe-by-default: even after cap, classification stays 'system'.
        expect(result).toBe('system');
      }
      const unclassifiedFires = spy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('unmatched /api path')
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

  describe('demo leaf exact semantics', () => {
    it('does not let an exact demo leaf capture descendants', () => {
      expect(findManifestEntry('/api/dlq/messages')).toEqual(
        expect.objectContaining({ matchMode: 'exact' }),
      );
      expect(classifyRoute('/api/dlq/messages')).toBe('demo');
      expect(classifyRoute('/api/dlq/messages/123/retry')).toBe('system');
      expect(classifyRoute('/api/system/status/details')).toBe('system');
    });

    it('does NOT let a demo leaf capture a sibling under the same family', () => {
      // The reason leaves were chosen over '/api/dlq' or '/api/system'.
      expect(classifyRoute('/api/dlq/other-real-surface')).not.toBe('demo');
      expect(classifyRoute('/api/system/other-real-surface')).not.toBe('demo');
    });
  });


  describe('non-/api paths are out of scope and stay silent', () => {
    it('returns system for an unmatched non-/api path WITHOUT logging', () => {
      // The warning says "unmatched /api path". Emitting it for a non-/api
      // input would make the message false, and would grow the dedup set
      // against paths RouteSetup never routes here in the first place.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Logger = require('../../../src/utils/Logger');
      const warnSpy = jest.spyOn(Logger.logger, 'warn').mockImplementation(() => {});
      __resetUnknownPathSeenForTests();

      expect(classifyRoute('/totally-unknown-non-api-path')).toBe('system');
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('still classifies non-/api MANIFEST entries normally', () => {
      // /health and friends are manifest entries above the scope guard.
      expect(classifyRoute('/health')).toBe('public');
      expect(classifyRoute('/docs')).toBe('public');
    });
  });

});
