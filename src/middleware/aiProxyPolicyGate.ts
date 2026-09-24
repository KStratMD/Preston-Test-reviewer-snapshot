/**
 * F2 + F5 (design D5-F2 + resolved questions 1–2): policy-driven front gate
 * generalized from /api/ai/proxy to demo route families — the FIRST runtime
 * consumer of the F0 Route Policy Manifest (routePolicy.ts).
 *
 * Dispatch per request, from resolveRoutePolicy(baseUrl + path, method):
 *   - auth 'public' passes through immediately regardless of presented
 *     credentials, bypassing auth, tenant lifecycle, demo-runtime, demo
 *     allowlist, payload cap, and limiter handling.
 *   - auth 'hosted_demo_public' AND deps.isDemoRuntime() AND the request
 *     presents NO identity → anonymous demo branch: header-independent
 *     64KiB parsed-body cap, then the strict anonymous demo limiter
 *     (30/15min/IP). The tenant kill switch does not run — anonymous demo
 *     traffic has no tenant (design resolved question 2). Downstream
 *     routers additionally guarantee the anonymous branch is
 *     zero-provider-spend and fixture-isolated (F2 rulings) via
 *     isAnonymousRequest — exported from here so gate and routers share
 *     one definition of anonymity.
 *   - auth 'platform_admin' → authMiddleware + requirePlatformAdmin (both
 *     respond directly on failure). Platform-global surface; no tenant gate.
 *   - everything else — including hosted_demo_public outside a demo runtime
 *     OR with a presented credential — → authMiddleware (anonymous → 401),
 *     then the tenant-lifecycle kill-switch gate (fail-closed: tenant-less
 *     token → 403 tenant_id_missing; suspended tenant → 403 tenant_blocked).
 *
 * The credential check means a suspended tenant's JWT on a demo path still
 * hits the kill switch, and a malformed token on a demo path is 401 rather
 * than silently anonymous. Demo pages send no tokens.
 *
 * The demo runtime condition is injected (deps.isDemoRuntime); production
 * wiring in RouteSetup.mountAiProxyRoutes passes
 *   env.HOSTED_DEMO || (env.NODE_ENV !== 'production' && isDemoMode())
 * so in production ONLY the explicit HOSTED_DEMO deployment flag opens the
 * demo branch — the admin demo-mode runtime toggle cannot.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { resolveRoutePolicy, type HttpMethod } from './setup/routePolicy';
import { authMiddleware, type AuthenticatedRequest } from './auth';
import { requirePlatformAdmin } from './verifiedAdmin';
import { createAiDemoRateLimit } from './rateLimit';

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/**
 * Anonymous demo payload cap (bytes), measured on the PARSED body — the
 * Content-Length header is untrusted (chunked/lying transports) and the
 * global express.json limit is 10MB, far above demo scale.
 */
export const DEMO_MAX_PAYLOAD_BYTES = 64 * 1024;

function asHttpMethod(method: string): HttpMethod | null {
  const upper = method.toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(upper) ? (upper as HttpMethod) : null;
}

/**
 * True iff the request carries no verified identity at all. Post-gate this
 * is exactly the anonymous demo branch — routers use it to select their
 * zero-spend/fixture paths (F2 rulings).
 */
export function isAnonymousRequest(req: Request): boolean {
  return (
    !req.auth &&
    !(req as AuthenticatedRequest).user &&
    !(req as Request & { tenantContext?: unknown }).tenantContext
  );
}

/**
 * Request-local marker the gate sets when — and only when — it admits a
 * request through the anonymous demo branch. Handlers must consult this
 * rather than re-deriving anonymity from the absence of credentials:
 * credential-free is not the same as demo-admitted (a bare router with no
 * gate is also credential-free), and the demo posture is a property of the
 * MOUNT, which only the gate can attest to.
 */
export const DEMO_ANONYMOUS_ATTESTATION = 'centralDemoAnonymous';

export function isDemoAnonymousAdmitted(req: Request): boolean {
  return (req as Request & Record<string, unknown>)[DEMO_ANONYMOUS_ATTESTATION] === true;
}

/** Any presented credential or verified identity must force the strict auth path. */
export function hasPresentedIdentity(req: Request): boolean {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];
  const hasApiKeyHeader = Array.isArray(apiKeyHeader)
    ? apiKeyHeader.some((value) => value.trim().length > 0)
    : typeof apiKeyHeader === 'string' && apiKeyHeader.trim().length > 0;
  const hasApiKeyQuery = Object.prototype.hasOwnProperty.call(req.query, 'api_key');
  return (
    (typeof authHeader === 'string' && authHeader.trim().length > 0) ||
    hasApiKeyHeader ||
    hasApiKeyQuery ||
    !isAnonymousRequest(req)
  );
}

/**
 * The EXACT anonymous demo surface (v4, Codex v3 finding 3): full-path
 * anchored regexes against the mount-relative req.path; `[^/]+` = a single
 * required param segment. The ROUTE_POLICY_MANIFEST's hosted_demo_public
 * entries declare the coarse posture for the audit; THIS table is the
 * fail-closed exact matcher — a request must satisfy BOTH to go anonymous.
 * Keep in lockstep with the verified demo-page caller list (plan Global
 * Constraints); the unit suite cross-checks every entry against the manifest.
 */
/** One entry of a fail-closed exact demo allowlist. */
export interface DemoAllowlistEntry {
  readonly methods: readonly HttpMethod[];
  readonly pattern: RegExp;
}

export const DEMO_EXACT_ALLOWLIST: readonly DemoAllowlistEntry[] = [
  { methods: ['GET', 'HEAD'], pattern: /^\/providers$/ },
  { methods: ['POST'], pattern: /^\/providers\/[^/]+\/test$/ },
  { methods: ['POST'], pattern: /^\/mapping\/suggestions$/ },
  { methods: ['POST'], pattern: /^\/mapping\/feedback$/ },
  { methods: ['GET', 'HEAD'], pattern: /^\/mapping\/schemas\/[^/]+$/ },
  { methods: ['POST'], pattern: /^\/mapping\/transformation\/(suggest|validate)$/ },
  { methods: ['POST'], pattern: /^\/mapping\/validation\/suggest$/ },
  { methods: ['POST'], pattern: /^\/mapping\/defaultvalue\/suggest$/ },
  { methods: ['POST'], pattern: /^\/suggestions\/[^/]+\/accept$/ },
  { methods: ['GET', 'HEAD'], pattern: /^\/mcp\/tools$/ },
  { methods: ['POST'], pattern: /^\/mcp$/ },
];

function matchesDemoExactAllowlist(
  allowlist: DemoFamilyPolicyGateDeps['demoAllowlist'],
  reqPath: string,
  method: HttpMethod,
): boolean {
  return allowlist.some(
    (e) => e.methods.includes(method) && new RegExp(e.pattern.source, e.pattern.flags).test(reqPath),
  );
}

function parsedBodyBytes(req: Request): number {
  const body = (req as Request & { body?: unknown }).body;
  if (body == null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.length;
  try {
    return Buffer.byteLength(JSON.stringify(body));
  } catch {
    return Number.POSITIVE_INFINITY; // unserializable → treat as oversized (fail closed)
  }
}

export interface AiProxyPolicyGateDeps {
  /** makeTenantStatusGate(tenantSvc) — async, fail-closed on missing tenantId. */
  tenantStatusGate: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  /** Production wiring: env.HOSTED_DEMO || (env.NODE_ENV !== 'production' && isDemoMode()). */
  isDemoRuntime: () => boolean;
  /** Injectable for tests; defaults to createAiDemoRateLimit(). */
  demoLimiter?: RequestHandler;
}

export interface DemoFamilyPolicyGateDeps {
  tenantStatusGate: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  isDemoRuntime: () => boolean;
  demoAllowlist: readonly DemoAllowlistEntry[];
  demoLimiter?: RequestHandler;
}

export function createDemoFamilyPolicyGate(deps: DemoFamilyPolicyGateDeps): RequestHandler {
  const demoLimiter = deps.demoLimiter ?? createAiDemoRateLimit();

  return (req: Request, res: Response, next: NextFunction): void => {
    let auth: 'required' | 'platform_admin' | 'hosted_demo_public' | 'public' = 'required';
    const method = asHttpMethod(req.method);
    if (method) {
      try {
        // req.baseUrl is '/api/ai/proxy' at this mount; req.path is the remainder.
        auth = resolveRoutePolicy(req.baseUrl + req.path, method)?.auth ?? 'required';
      } catch (err) {
        // AmbiguousRoutePolicyError — the audit gate statically prevents this;
        // fail toward the strict path and surface the error.
        next(err);
        return;
      }
    }

    if (auth === 'public') {
      next();
      return;
    }

    if (
      auth === 'hosted_demo_public' &&
      method !== null &&
      matchesDemoExactAllowlist(deps.demoAllowlist, req.path, method) &&
      deps.isDemoRuntime() &&
      !hasPresentedIdentity(req)
    ) {
      if (parsedBodyBytes(req) > DEMO_MAX_PAYLOAD_BYTES) {
        res.status(413).json({ error: 'demo_payload_too_large', maxBytes: DEMO_MAX_PAYLOAD_BYTES });
        return;
      }
      (req as Request & Record<string, unknown>)[DEMO_ANONYMOUS_ATTESTATION] = true;
      demoLimiter(req, res, next);
      return;
    }

    authMiddleware(req as AuthenticatedRequest, res, (err?: unknown) => {
      if (err) return next(err);
      if (auth === 'platform_admin') {
        // Platform-global surface (provider-config/model-select): admin claim
        // required, tenant kill switch not applicable.
        requirePlatformAdmin(req, res, next);
        return;
      }
      deps.tenantStatusGate(req, res, next).catch(next);
    });
  };
}

export function createAiProxyPolicyGate(deps: AiProxyPolicyGateDeps): RequestHandler {
  return createDemoFamilyPolicyGate({ ...deps, demoAllowlist: DEMO_EXACT_ALLOWLIST });
}
