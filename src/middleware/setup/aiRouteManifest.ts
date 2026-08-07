/**
 * AI Route Governance Manifest
 * PR 1A: Initial inventory (May 2026)
 * PR 1B: Consolidated — all direct-family routes retired or redirected (May 2026)
 *
 * Post-PR-1B state:
 *   - 1 governed proxy mount: /api/ai/proxy (canonical AI path)
 *   - 1 deprecated redirect shim: /api/ai (301/308 backwards compat)
 *   - 1 demo_only: /api/ai-demo (no auth/governance required)
 */

export type RouteGovernancePosture = 'governed' | 'ungoverned' | 'demo_only' | 'deprecated';

export interface AIRouteEntry {
  path: string;
  family: 'proxy' | 'direct';
  posture: RouteGovernancePosture;
  mountedBy: string;
  notes?: string;
}

// All /api/ai* and /api/ai-demo route mounts in RouteSetup.ts.
// Governance posture declared here must match the effective middleware chain at each mount point.
// Update this manifest whenever RouteSetup.ts gains or removes an AI route.
export const AI_ROUTE_MANIFEST: AIRouteEntry[] = [
  // --- Proxy family: GovernanceService + governanceMiddleware enforced (canonical) ---
  {
    path: '/api/ai/proxy',
    family: 'proxy',
    posture: 'governed',
    mountedBy: 'createAIProxyRouter()',
    notes: 'ADR-014 canonical AI path; governanceMiddleware + per-router governance (defence-in-depth)',
  },

  // --- 301 redirect shim: backwards compat for retired direct-family paths ---
  {
    path: '/api/ai',
    family: 'direct',
    posture: 'deprecated',
    mountedBy: '301 redirect shim',
    notes: 'PR 1B: redirects /api/ai/* → /api/ai/proxy/*; stays until future removal PR',
  },

  // --- Demo only: no auth required ---
  {
    path: '/api/ai-demo',
    family: 'direct',
    posture: 'demo_only',
    mountedBy: 'createAIDemoRouter()',
    notes: 'demo-mode fallback; no production credential required',
  },
];

export const GOVERNED_PATHS = AI_ROUTE_MANIFEST
  .filter((e) => e.posture === 'governed')
  .map((e) => e.path);

// Deduplicated: multiple routers may mount at the same path.
export const UNGOVERNED_AI_PATHS = [...new Set(
  AI_ROUTE_MANIFEST
    .filter((e) => e.posture === 'ungoverned')
    .map((e) => e.path),
)];
