// src/routes/identityRoutes.ts
import express from 'express';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';
import { isPlatformAdminActor } from '../middleware/verifiedAdmin';

const router = express.Router();

/**
 * Whoami endpoint for the top-rail Admin menu. Returns the current identity for
 * display only (no secrets, no permissions). Sits behind the global `/api`
 * optionalAuthMiddleware, which populates `req.user` from a verified Bearer JWT.
 *
 * F6 sub-project B: identity is read from the VERIFIED `req.user` directly.
 * A caller is shown their real identity only when `req.user` carries BOTH a
 * non-empty id AND a non-empty tenantId, and NEITHER is the system sentinel.
 * That reproduces exactly what `isSystemIdentity(extractIdentityContext(req))`
 * decided before, without this route depending on the sentinel the F6 ratchet
 * is retiring — note `auth.ts` will happily mint a JWT claiming
 * `__system__` in either field, so both comparisons are load-bearing.
 *
 * Consequently a tenant-less JWT, a JWT claiming the system tenant or system
 * user, and an unauthenticated caller all get the friendly demo fallback —
 * which is what `public/index.html` and the help-chat widget render.
 *
 * Sentinel comparisons go through the imported `SYSTEM_IDENTITY`; the literal
 * is blocked outside identityContext.ts by a blocking CI gate.
 */
router.get('/', (req, res) => {
  // Per-caller response — never cache. Without this a shared browser/proxy/CDN
  // cache could store one caller's identity and replay it to another on shared
  // infrastructure.
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');

  const user = req.user;
  const userId = typeof user?.id === 'string' ? user.id.trim() : '';
  const tenantId = typeof user?.tenantId === 'string' ? user.tenantId.trim() : '';
  const isRealIdentity =
    userId.length > 0 &&
    tenantId.length > 0 &&
    userId !== SYSTEM_IDENTITY.userId &&
    tenantId !== SYSTEM_IDENTITY.tenantId;

  if (isRealIdentity && user) {
    res.json({
      authenticated: true,
      displayName: user.username,
      tenantId,
      role: user.roles?.[0] ?? 'User',
      capabilities: {
        helpReindex: isPlatformAdminActor(user),
      },
    });
    return;
  }

  res.json({
    authenticated: false,
    displayName: 'Demo User',
    tenantId: 'Demo Tenant',
    role: 'Platform Admin (Demo)',
    capabilities: {
      helpReindex: false,
    },
  });
});

export default router;
