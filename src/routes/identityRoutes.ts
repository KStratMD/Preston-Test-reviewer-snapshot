// src/routes/identityRoutes.ts
import express from 'express';
import { extractIdentityContext, isSystemIdentity } from '../services/governance/identityContext';

const router = express.Router();

/**
 * Whoami endpoint for the top-rail Admin menu. Returns the current identity for
 * display only (no secrets, no permissions). Sits behind the global `/api`
 * optionalAuthMiddleware, which populates `req.user` from a verified Bearer JWT.
 *
 * Identity resolution follows the repo's CANONICAL model rather than ad-hoc
 * checks: `extractIdentityContext(req)` (whole-source-first across req.auth →
 * req.user → req.tenantContext) + `isSystemIdentity()` (never the hardcoded
 * sentinel, which is blocked outside identityContext.ts). A caller is shown their
 * real identity only when that resolves to a NON-system identity. Note that a
 * verified JWT whose `tenantId` claim is missing/invalid normalizes to
 * SYSTEM_IDENTITY (identityContext.ts:89-104), so — like every other identity
 * consumer in the repo — such tokens, and unauthenticated callers, get the
 * friendly demo fallback. Keeping this route on the canonical helper avoids
 * authz-model drift even though it is display-only.
 *
 * Display fields (displayName/role) come from `req.user` — `extractIdentityContext`
 * intentionally exposes only `{tenantId, userId}`.
 */
router.get('/', (req, res) => {
  // Per-caller response — never cache. Without this a shared browser/proxy/CDN
  // cache could store one caller's identity and replay it to another on shared
  // infrastructure.
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');

  const ctx = extractIdentityContext(req);

  if (!isSystemIdentity(ctx) && req.user) {
    res.json({
      authenticated: true,
      displayName: req.user.username,
      tenantId: ctx.tenantId,
      role: req.user.roles?.[0] ?? 'User',
    });
    return;
  }

  res.json({
    authenticated: false,
    displayName: 'Demo User',
    tenantId: 'Demo Tenant',
    role: 'Platform Admin (Demo)',
  });
});

export default router;
