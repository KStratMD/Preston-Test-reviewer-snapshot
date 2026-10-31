import type { Request, Response, NextFunction } from 'express';

/**
 * Test helper that mounts a fake authentication middleware populating
 * `req.user` for route-unit tests. Mirrors the shape of `req.user`
 * augmented by `src/types/express.d.ts:7-15`.
 *
 * Defaults to `tenantId: 'test-tenant'`. Pass `{ tenantId: undefined }`
 * explicitly to test missing-tenantId code paths (e.g. PR 13c-4's
 * authMiddleware narrowing-tests).
 */
export interface FakeUserOverrides {
  id?: string;
  username?: string;
  email?: string;
  tenantId?: string;
  roles?: string[];
  permissions?: string[];
}

export function fakeAuthMiddleware(overrides: FakeUserOverrides = {}) {
  const hasExplicitTenantId = Object.prototype.hasOwnProperty.call(overrides, 'tenantId');
  return (req: Request, _res: Response, next: NextFunction) => {
    const user: NonNullable<Request['user']> = {
      id: overrides.id ?? 'test-user',
      username: overrides.username ?? 'test-user',
      roles: overrides.roles ?? [],
      permissions: overrides.permissions ?? [],
    };
    if (overrides.email !== undefined) user.email = overrides.email;
    if (hasExplicitTenantId) {
      if (overrides.tenantId !== undefined) user.tenantId = overrides.tenantId;
      // if explicit undefined: omit tenantId entirely
    } else {
      user.tenantId = 'test-tenant';
    }
    req.user = user;
    next();
  };
}
