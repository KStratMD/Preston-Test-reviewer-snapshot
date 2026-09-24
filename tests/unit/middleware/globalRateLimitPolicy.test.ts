// A6 — the global rate-limit exclusion matcher.
//
// This exists because the global limiter was a universal no-op: its default
// skipPaths contained '/' and matching was `req.path.startsWith(skipPath)`,
// so every request matched and nothing was ever limited — in hosted mode too,
// since '/' sat in the base defaults regardless of HOSTED_DEMO.
//
// Two classes of defect are pinned here, not just the one:
//   1. the root exemption that caused the no-op, and
//   2. unbounded prefix matching, where '/public' also exempts '/publicity'.
//
// The matcher is a pure function of (exact, prefix, path) with no Express or
// env coupling, so these are cheap and exhaustive.

import { describe, it, expect } from '@jest/globals';
import {
  createGlobalRateLimitPolicy,
  DEFAULT_GLOBAL_RATE_LIMIT_POLICY,
  NON_HOSTED_API_EXEMPT_PREFIXES,
  requiresStrictRateLimitPolicy,
  resolveGlobalRateLimitPolicy,
  shouldEnableGlobalRateLimit,
} from '../../../src/middleware/setup/globalRateLimitPolicy';

describe('createGlobalRateLimitPolicy — construction validation', () => {
  it('rejects an empty string in the exact set', () => {
    expect(() => createGlobalRateLimitPolicy({ exactPaths: [''], prefixPaths: [] }))
      .toThrow(/empty/i);
  });

  it('rejects an empty string in the prefix set', () => {
    expect(() => createGlobalRateLimitPolicy({ exactPaths: [], prefixPaths: [''] }))
      .toThrow(/empty/i);
  });

  it("rejects '/' in the PREFIX set — this is the exact defect that made the limiter a no-op", () => {
    expect(() => createGlobalRateLimitPolicy({ exactPaths: [], prefixPaths: ['/'] }))
      .toThrow(/root/i);
  });

  it('rejects a path that does not start with a slash', () => {
    expect(() => createGlobalRateLimitPolicy({ exactPaths: ['health'], prefixPaths: [] }))
      .toThrow(/slash/i);
  });

  it("allows '/' in the EXACT set at construction time, so the type cannot express the no-op but a deliberate exact-root choice stays possible", () => {
    // Exact '/' matches only '/', which is bounded and therefore not the
    // pathological case. The default policy still must not use it — asserted
    // separately below — but the constructor is not the place to forbid it.
    expect(() => createGlobalRateLimitPolicy({ exactPaths: ['/'], prefixPaths: [] }))
      .not.toThrow();
  });
});

describe('isExempt — exact matching', () => {
  const policy = createGlobalRateLimitPolicy({
    exactPaths: ['/index.html', '/health'],
    prefixPaths: [],
  });

  it('exempts the exact path', () => {
    expect(policy.isExempt('/index.html')).toBe(true);
    expect(policy.isExempt('/health')).toBe(true);
  });

  it('does NOT exempt a child of an exact path', () => {
    expect(policy.isExempt('/index.html/child')).toBe(false);
  });

  it('does NOT exempt a sibling that merely shares a prefix', () => {
    expect(policy.isExempt('/index.htmlx')).toBe(false);
    expect(policy.isExempt('/healthz')).toBe(false);
  });
});

describe('isExempt — prefix matching is boundary-aware', () => {
  const policy = createGlobalRateLimitPolicy({
    exactPaths: [],
    prefixPaths: ['/public', '/vendor'],
  });

  it('exempts the prefix itself and anything beneath it', () => {
    expect(policy.isExempt('/public')).toBe(true);
    expect(policy.isExempt('/vendor/app.js')).toBe(true);
    expect(policy.isExempt('/vendor/nested/deep/asset.css')).toBe(true);
  });

  it("does NOT exempt '/publicity' — the unbounded-startsWith defect", () => {
    expect(policy.isExempt('/publicity')).toBe(false);
    expect(policy.isExempt('/public-relations')).toBe(false);
    expect(policy.isExempt('/vendors')).toBe(false);
  });
});

describe('isExempt — ordinary routes are limited', () => {
  it('does not exempt an ordinary API route under the default policy', () => {
    expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.isExempt('/api/configurations')).toBe(false);
    expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.isExempt('/api/anything/else')).toBe(false);
  });

  it("does not exempt the root path '/' under the default policy", () => {
    // The whole point of A6. '/' renders the full dashboard and is the
    // busiest path in the app; it is a real request and must count.
    expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.isExempt('/')).toBe(false);
  });
});

describe('DEFAULT_GLOBAL_RATE_LIMIT_POLICY — the shipped policy cannot re-express the defect', () => {
  it('contains no empty string in either set', () => {
    expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.exactPaths).not.toContain('');
    expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.prefixPaths).not.toContain('');
  });

  it("contains no root exemption in either set — not as a prefix, and not as an exact match either", () => {
    expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.prefixPaths).not.toContain('/');
    expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.exactPaths).not.toContain('/');
  });

  it('exempts the signed-off health, metrics, favicon and named HTML entry points', () => {
    for (const p of [
      '/health',
      '/metrics',
      '/favicon.ico',
      '/index.html',
      '/executive/executive-hub.html',
      '/metrics.html',
      '/system-status.html',
    ]) {
      expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.isExempt(p)).toBe(true);
    }
  });

  it('exempts the signed-off static prefixes', () => {
    for (const p of ['/vendor/x.js', '/webfonts/f.woff2', '/postman/c.json', '/public', '/docs']) {
      expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.isExempt(p)).toBe(true);
    }
  });

  it('does NOT exempt any /api/* prefix — hosted carries no broad API exclusions', () => {
    for (const p of [
      '/api/integrations',
      '/api/ai',
      '/api/dashboard',
      '/api/suitecentral',
      '/api/ai-demo',
    ]) {
      expect(DEFAULT_GLOBAL_RATE_LIMIT_POLICY.isExempt(p)).toBe(false);
    }
  });
});

describe('requiresStrictRateLimitPolicy — "hosted OR production", not "hosted"', () => {
  it('is strict for hosted demo', () => {
    expect(requiresStrictRateLimitPolicy({ hostedDemo: true, nodeEnv: 'development' })).toBe(true);
  });

  it('is strict for ordinary production even when HOSTED_DEMO is false', () => {
    // The defect this pins: keying off HOSTED_DEMO alone handed the broad
    // non-hosted /api/* exemptions to a real production deployment — the
    // environment the policy most needs to protect.
    expect(requiresStrictRateLimitPolicy({ hostedDemo: false, nodeEnv: 'production' })).toBe(true);
  });

  it('is permissive for local development and test', () => {
    expect(requiresStrictRateLimitPolicy({ hostedDemo: false, nodeEnv: 'development' })).toBe(false);
    expect(requiresStrictRateLimitPolicy({ hostedDemo: false, nodeEnv: 'test' })).toBe(false);
  });

  it('handles undefined defensively, though env.ts guarantees it cannot occur', () => {
    // env.ts:16-18 canonicalizes an unset/empty NODE_ENV to 'production'
    // BEFORE the zod parse, and the schema admits only
    // development|production|test — so env.NODE_ENV is never undefined at
    // runtime and a deployment that forgets to set it gets the STRICT policy.
    // This case is covered because the function is pure and other callers may
    // pass undefined, NOT because the running system can reach it.
    expect(requiresStrictRateLimitPolicy({ hostedDemo: false, nodeEnv: undefined })).toBe(false);
    expect(requiresStrictRateLimitPolicy({ hostedDemo: true, nodeEnv: undefined })).toBe(true);
  });
});

describe('resolveGlobalRateLimitPolicy', () => {
  it('strict mode exempts no /api/* prefix', () => {
    const p = resolveGlobalRateLimitPolicy({ strict: true });
    expect(p.isExempt('/api/integrations')).toBe(false);
    expect(p.isExempt('/api/ai')).toBe(false);
  });

  it('permissive mode exempts the preserved non-hosted /api/* prefixes', () => {
    const p = resolveGlobalRateLimitPolicy({ strict: false });
    expect(p.isExempt('/api/integrations')).toBe(true);
    expect(p.isExempt('/api/integrations/42/sync')).toBe(true);
    expect(p.isExempt('/api/configurations')).toBe(false);
  });

  it('exempts every probe and scrape endpoint in BOTH modes', () => {
    // All four probes exist in src/routes/health.ts and all are polled on a
    // schedule; an earlier revision of the table listed only '/health'.
    for (const strict of [true, false]) {
      const p = resolveGlobalRateLimitPolicy({ strict });
      for (const probe of ['/health', '/health/ready', '/health/live', '/ready', '/metrics', '/api/metrics']) {
        expect(p.isExempt(probe)).toBe(true);
      }
      // Exact, so a child path is still metered.
      expect(p.isExempt('/health/ready/extra')).toBe(false);
    }
  });
});

describe('shouldEnableGlobalRateLimit — the limiter must MOUNT, not merely be configured', () => {
  it('mounts whenever the app is not lightweight', () => {
    expect(shouldEnableGlobalRateLimit({ lightweight: false, hostedDemo: false, nodeEnv: 'development' })).toBe(true);
  });

  it('mounts under lightweight mode when hosted', () => {
    expect(shouldEnableGlobalRateLimit({ lightweight: true, hostedDemo: true, nodeEnv: 'production' })).toBe(true);
  });

  it('mounts under lightweight mode in ordinary production', () => {
    expect(shouldEnableGlobalRateLimit({ lightweight: true, hostedDemo: false, nodeEnv: 'production' })).toBe(true);
  });

  it('does NOT mount for a purely local lightweight/demo run', () => {
    expect(shouldEnableGlobalRateLimit({ lightweight: true, hostedDemo: false, nodeEnv: 'development' })).toBe(false);
  });

  // The regression that matters. Read the REAL Dockerfile rather than
  // restating its values, so that editing the image cannot silently drift away
  // from this guarantee.
  it("the actual Dockerfile.hosted environment mounts the limiter despite selecting lightweight mode", () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../../../Dockerfile.hosted'), 'utf8');

    const dockerEnv: Record<string, string> = {};
    for (const line of dockerfile.split('\n')) {
      const m = /^\s*ENV\s+([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) dockerEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }

    // Sanity-check the parse itself, so a Dockerfile reformat surfaces here
    // rather than making the assertions below vacuously true.
    expect(Object.keys(dockerEnv).length).toBeGreaterThan(0);
    expect(dockerEnv.HOSTED_DEMO).toBeDefined();

    // index.ts: preferLightweight = isDemo() || isRedisDisabled()
    const lightweight = dockerEnv.DEMO_MODE === '1' || dockerEnv.DISABLE_REDIS === '1';
    const hostedDemo = dockerEnv.HOSTED_DEMO === '1' || dockerEnv.HOSTED_DEMO === 'true';

    // Pin the premise: this image really does select lightweight mode. If that
    // ever stops being true the test below stops proving anything, so assert it.
    expect(lightweight).toBe(true);
    expect(hostedDemo).toBe(true);

    expect(shouldEnableGlobalRateLimit({
      lightweight,
      hostedDemo,
      nodeEnv: dockerEnv.NODE_ENV ?? 'production',
    })).toBe(true);
  });
});

describe('NON_HOSTED_API_EXEMPT_PREFIXES — the preserved non-hosted set', () => {
  it('is exactly the five prefixes the approved table preserves', () => {
    expect([...NON_HOSTED_API_EXEMPT_PREFIXES].sort()).toEqual([
      '/api/ai',
      '/api/ai-demo',
      '/api/dashboard',
      '/api/integrations',
      '/api/suitecentral',
    ]);
  });

  it('composes into a policy that exempts them with boundary-aware matching', () => {
    const nonHosted = createGlobalRateLimitPolicy({
      exactPaths: DEFAULT_GLOBAL_RATE_LIMIT_POLICY.exactPaths,
      prefixPaths: [...DEFAULT_GLOBAL_RATE_LIMIT_POLICY.prefixPaths, ...NON_HOSTED_API_EXEMPT_PREFIXES],
    });
    expect(nonHosted.isExempt('/api/integrations')).toBe(true);
    expect(nonHosted.isExempt('/api/integrations/42/sync')).toBe(true);
    // Still bounded: a sibling family is not swept in.
    expect(nonHosted.isExempt('/api/integrations-admin')).toBe(false);
    // And an unrelated API family is still metered even non-hosted.
    expect(nonHosted.isExempt('/api/configurations')).toBe(false);
  });
});
