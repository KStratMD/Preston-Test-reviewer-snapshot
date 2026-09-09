import {
  resolveRoutePolicy,
  type HttpMethod,
  type RoutePolicy,
} from './routePolicy';

export type CentralTenantPreflightAction = 'defer' | 'isolate';

export interface CentralTenantPreflightInput {
  path: string;
  method: HttpMethod;
  isDemoRuntime: boolean;
  hasPresentedIdentity: boolean;
  policies?: readonly RoutePolicy[];
}

export interface CentralTenantPreflightDecision {
  action: CentralTenantPreflightAction;
  reason:
    | 'trusted-route-owned'
    | 'public-policy'
    | 'hosted-demo-policy'
    | 'health-subtree'
    | 'central-isolation'
    | 'no-policy';
}

const HTTP_METHODS: readonly HttpMethod[] = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export function toCentralHttpMethod(method: string): HttpMethod | null {
  return HTTP_METHODS.includes(method as HttpMethod) ? (method as HttpMethod) : null;
}

const EMBEDDED_ROUTE_PREFIXES = Object.freeze([
  // Host bootstrap, guest context, and session teardown validate service/session tokens.
  '/api/embedded/host-bootstrap',
  '/api/embedded/context',
  '/api/embedded/sessions',
  // These operator surfaces validate the embedded session in their routers.
  '/api/embedded/lineage',
  '/api/embedded/reconciliation',
]);

interface ExactTrustedRoute {
  readonly methods: readonly HttpMethod[];
  readonly pattern: RegExp;
  /** Downstream validator or identity boundary that owns this route. */
  readonly owner: string;
}

const EXACT_TRUSTED_ROUTES: readonly ExactTrustedRoute[] = Object.freeze(
  ([
    {
      methods: ['GET', 'HEAD'],
      pattern: /^\/api\/governance\/approvals\/?$/,
      owner: 'governance approvals embedded-session validator',
    },
    {
      methods: ['POST'],
      pattern: /^\/api\/governance\/approvals\/[^/]+\/(approve|reject|reset-claim)\/?$/,
      owner: 'governance approvals embedded-session and role validators',
    },
    {
      methods: ['GET'],
      pattern: /^\/api\/governance\/(ownership-rejections|loop-detections|dlp-pattern-metadata)\/?$/,
      owner: 'governance operator embedded-session and role validators',
    },
    {
      methods: ['POST'],
      pattern: /^\/api\/sync-error-assist\/ingest\/?$/,
      owner: 'sync-error-assist HMAC verification',
    },
    {
      methods: ['GET'],
      pattern: /^\/api\/sync-error-assist\/suggestions\/?$/,
      owner: 'sync-error-assist embedded-session validator',
    },
    {
      methods: ['POST'],
      pattern: /^\/api\/sync-error-assist\/suggestions\/[^/]+\/(accept|reject|escalate)\/?$/,
      owner: 'sync-error-assist embedded-session and role validators',
    },
  ] as ExactTrustedRoute[]).map((entry) =>
    Object.freeze({ ...entry, methods: Object.freeze([...entry.methods]) }),
  ),
);

function matchesEmbeddedPrefix(path: string): boolean {
  return EMBEDDED_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function matchesExactTrustedRoute(path: string, method: HttpMethod): boolean {
  return EXACT_TRUSTED_ROUTES.some(
    (entry) => entry.methods.includes(method) && entry.pattern.test(path),
  );
}

function isHealthSubtreePolicy(policy: RoutePolicy): boolean {
  return policy.auth === 'required' && policy.match.pathPrefix.endsWith('/health');
}

/**
 * Decide whether the central gate should refuse a request or let the
 * route-owned validator make the final decision. This is deliberately pure:
 * it does not inspect Express state, authenticate a request, or admit a
 * route merely because a broad prefix looks familiar.
 */
export function resolveCentralTenantPreflight(
  input: CentralTenantPreflightInput,
): CentralTenantPreflightDecision {
  if (matchesEmbeddedPrefix(input.path) || matchesExactTrustedRoute(input.path, input.method)) {
    return { action: 'defer', reason: 'trusted-route-owned' };
  }

  const policy = resolveRoutePolicy(input.path, input.method, input.policies);
  if (policy === null) {
    return { action: 'isolate', reason: 'no-policy' };
  }

  if (policy.auth === 'public') {
    return { action: 'defer', reason: 'public-policy' };
  }

  if (
    policy.auth === 'hosted_demo_public' &&
    (input.hasPresentedIdentity || input.isDemoRuntime)
  ) {
    return { action: 'defer', reason: 'hosted-demo-policy' };
  }

  if (isHealthSubtreePolicy(policy)) {
    return { action: 'defer', reason: 'health-subtree' };
  }

  return { action: 'isolate', reason: 'central-isolation' };
}
