// A6 — the global rate-limit exclusion matcher.
//
// Extracted from MiddlewareSetup so the exemption rule is a pure, testable
// function rather than an inline array plus a `startsWith` call. It exists
// because that inline form produced a universal no-op: the default skip list
// contained '/' and matching was `req.path.startsWith(skipPath)`, so every
// request was exempt — in hosted mode as well, since '/' sat in the base
// defaults regardless of HOSTED_DEMO. The limiter was decorative.
//
// The policy is validated at CONSTRUCTION time so that defect cannot be
// reintroduced by editing a list: '/' in the prefix set throws. See
// docs/guides/SECURITY-AND-RATE-LIMITING.md → "Global limiter exclusion
// policy (A6)" for the signed-off table this file implements. That table is
// the source of truth; do not add an exemption here without adding the row.

export interface GlobalRateLimitPolicyInput {
  readonly exactPaths: readonly string[];
  readonly prefixPaths: readonly string[];
}

export interface GlobalRateLimitPolicy {
  readonly exactPaths: readonly string[];
  readonly prefixPaths: readonly string[];
  /** True when the path is exempt from the global limiter. */
  isExempt(path: string): boolean;
}

function validate(paths: readonly string[], setName: 'exact' | 'prefix'): void {
  for (const p of paths) {
    // Order matters: check emptiness before the slash rule, so '' reports the
    // specific problem rather than the generic one.
    if (p.length === 0) {
      throw new Error(`globalRateLimitPolicy: empty string is not a valid ${setName} path`);
    }
    if (!p.startsWith('/')) {
      throw new Error(`globalRateLimitPolicy: ${setName} path ${JSON.stringify(p)} must start with a slash`);
    }
    if (setName === 'prefix' && p === '/') {
      // The original defect, made unrepresentable. A root PREFIX matches every
      // path, which silently disables the limiter everywhere.
      throw new Error(
        'globalRateLimitPolicy: the root path is not a valid prefix exemption — ' +
        'it matches every request and disables the global limiter entirely',
      );
    }
  }
}

export function createGlobalRateLimitPolicy(input: GlobalRateLimitPolicyInput): GlobalRateLimitPolicy {
  validate(input.exactPaths, 'exact');
  validate(input.prefixPaths, 'prefix');

  const exact = new Set(input.exactPaths);
  const prefixes = [...input.prefixPaths];
  const exactPaths = Object.freeze([...input.exactPaths]);
  const prefixPaths = Object.freeze([...prefixes]);

  return Object.freeze({
    exactPaths,
    prefixPaths,
    isExempt(path: string): boolean {
      if (exact.has(path)) return true;
      // Boundary-aware: '/public' must not exempt '/publicity'. Matching the
      // prefix itself is intentional so '/public' is exempt as well as
      // '/vendor/app.js'.
      return prefixes.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
    },
  });
}

/**
 * The exemptions that apply in EVERY environment, hosted included.
 *
 * Deliberately contains no `/api/*` entry and no root entry. Hosted carries no
 * broad API exclusions, and '/' is metered: it renders the full dashboard, so
 * it is a real request that should count against the budget.
 */
export const DEFAULT_GLOBAL_RATE_LIMIT_POLICY: GlobalRateLimitPolicy = createGlobalRateLimitPolicy({
  exactPaths: [
    // Probes. All four exist (src/routes/health.ts) and all four are polled on
    // a fixed schedule by the platform; throttling any of them turns load into
    // a false outage. The original A6 table listed only '/health' and missed
    // the other three — caught in review.
    '/health',
    '/health/ready',
    '/health/live',
    '/ready',
    // Scrape endpoints, fixed interval. '/api/metrics' is the mounted
    // Prometheus route (routeManifest.ts:55) and is token-gated in production
    // by METRICS_SCRAPE_TOKEN, so exempting it does not widen exposure.
    '/metrics',
    '/api/metrics',
    '/favicon.ico',                   // browser-automatic, one per page load
    '/index.html',                    // named HTML entry points below
    '/executive/executive-hub.html',
    '/metrics.html',
    '/system-status.html',
  ],
  prefixPaths: [
    '/vendor',
    '/webfonts',
    '/docs',
    '/postman',
    '/public',
  ],
});

/**
 * Additional prefixes exempt ONLY when not hosted (`HOSTED_DEMO` false).
 *
 * Preserved from the pre-A6 behavior by explicit decision: the approved policy
 * removes broad `/api/*` exclusions from hosted/production while keeping the
 * local-development and demo surface unchanged. These were never actually
 * exercised as exemptions before A6, because the limiter was a no-op for every
 * path anyway — so they take effect for the first time here.
 */
export const NON_HOSTED_API_EXEMPT_PREFIXES: readonly string[] = Object.freeze([
  '/api/dashboard',
  '/api/suitecentral',
  '/api/integrations',
  '/api/ai',
  '/api/ai-demo',
]);

/**
 * True when the environment must receive the strict policy — i.e. no broad
 * `/api/*` exemptions.
 *
 * The approved posture is "no broad `/api/*` exclusions in hosted **or
 * production**". An earlier revision keyed this off `HOSTED_DEMO` alone, which
 * silently handed the broad non-hosted API exemptions to any ordinary
 * production deployment running with `HOSTED_DEMO=false` — the exact
 * environment the policy most needs to protect. Caught in review.
 *
 * Deliberately a positive test for production rather than a negative test for
 * dev, but note that the fail-closed behavior actually comes from upstream:
 * `src/config/env.ts:16-18` canonicalizes an unset or empty NODE_ENV to
 * 'production' BEFORE the zod parse, and the schema then admits only
 * development | production | test. So `env.NODE_ENV` is never undefined at
 * runtime, and a deployment that simply forgets to set it gets the STRICT
 * policy rather than the permissive one.
 *
 * The `undefined` case below is therefore defensive only — it exists because
 * this is a pure function that callers other than the env-backed one may
 * exercise, not because an unset NODE_ENV can reach it in the running system.
 */
export function requiresStrictRateLimitPolicy(options: {
  hostedDemo: boolean;
  nodeEnv: string | undefined;
}): boolean {
  return options.hostedDemo || options.nodeEnv === 'production';
}

/**
 * Whether the global limiter should be MOUNTED AT ALL.
 *
 * Separate from `requiresStrictRateLimitPolicy`, which only chooses which
 * exemptions apply. This answers the prior question, and it is the one that
 * was wrong: `Dockerfile.hosted` sets DEMO_MODE=1 and DISABLE_REDIS=1, which
 * selects lightweight mode, which passed `enableRateLimit: false` and made
 * `setupRateLimit()` return before mounting anything. The hosted service ran
 * with no global limiter whatsoever, so fixing the exemption list alone would
 * have changed nothing in the deployment that matters.
 *
 * Lightweight mode exists to skip heavy optional dependencies. A rate limiter
 * is neither heavy nor optional, so hosted and production-strength runtimes
 * mount it regardless. Purely local lightweight/demo runs still bypass it at
 * request time via the `isDemo() && !HOSTED_DEMO` short-circuit.
 */
export function shouldEnableGlobalRateLimit(options: {
  lightweight: boolean;
  hostedDemo: boolean;
  nodeEnv: string | undefined;
}): boolean {
  if (!options.lightweight) return true;
  return requiresStrictRateLimitPolicy({
    hostedDemo: options.hostedDemo,
    nodeEnv: options.nodeEnv,
  });
}

/**
 * Resolve the policy for an environment.
 *
 * There is deliberately NO caller-supplied path override. An arbitrary
 * `skipPaths` escape hatch would let any caller widen the signed-off table
 * without the table changing, which defeats the point of having one — and it
 * was also a fail-open vector, since a rejected override threw inside the
 * limiter's optional-import try/catch and disabled the limiter entirely.
 * Exemptions change by editing the table and this file together.
 */
export function resolveGlobalRateLimitPolicy(options: { strict: boolean }): GlobalRateLimitPolicy {
  if (options.strict) return DEFAULT_GLOBAL_RATE_LIMIT_POLICY;
  return createGlobalRateLimitPolicy({
    exactPaths: DEFAULT_GLOBAL_RATE_LIMIT_POLICY.exactPaths,
    prefixPaths: [
      ...DEFAULT_GLOBAL_RATE_LIMIT_POLICY.prefixPaths,
      ...NON_HOSTED_API_EXEMPT_PREFIXES,
    ],
  });
}
