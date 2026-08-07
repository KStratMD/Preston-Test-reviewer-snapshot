/**
 * Direct unit tests for the role-helper functions in `_governanceAuth.ts`.
 *
 * Background: PR 13c-3 added `ADMIN_ROLES`, `hasAdminRole`, `requireAdminRole`
 * to support the new admin reset-claim endpoint. The functional coverage of
 * the new helpers is exercised end-to-end via `approvalsRouter.resetClaim`
 * and `governanceApprovalsRouter` integration tests, but those go through
 * `validateGuestContext` mocks that short-circuit the actual helpers — so
 * direct function-level coverage on this module dropped from ~80% lines to
 * ~51% at the Phase-5b core-coverage ratchet. This file restores the floor
 * by exercising each helper directly.
 */
import type { EmbeddedSession } from '../../../../src/database/types';
import type { NextFunction, Request, Response } from 'express';
import {
  ADMIN_ROLES,
  APPROVER_ROLES,
  hasAdminRole,
  hasApproverRole,
  readEmbeddedSession,
  requireAdminRole,
  requireApproverRole,
} from '../../../../src/routes/governance/_governanceAuth';

function makeRes(session: EmbeddedSession | null | undefined): Response {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return {
    status,
    json,
    locals: { embeddedSession: session ?? undefined },
  } as unknown as Response;
}

function makeSession(roles: string | null | undefined): EmbeddedSession {
  return {
    session_id: 'session-1',
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    platform: 'test',
    platform_account_id: null,
    csrf_token: 'csrf-1',
    expected_host_origin: 'https://test.local',
    expires_at: '2026-05-28T00:00:00.000Z',
    last_rotation_at: null,
    erp_record_type: null,
    erp_record_id: null,
    erp_record_url: null,
    user_roles: roles as string | null,
    created_at: '2026-05-27T00:00:00.000Z',
  };
}

describe('_governanceAuth role sets', () => {
  it('APPROVER_ROLES includes approver + admin', () => {
    expect(APPROVER_ROLES.has('approver')).toBe(true);
    expect(APPROVER_ROLES.has('admin')).toBe(true);
    expect(APPROVER_ROLES.has('viewer')).toBe(false);
  });

  it('ADMIN_ROLES is admin-only', () => {
    expect(ADMIN_ROLES.has('admin')).toBe(true);
    expect(ADMIN_ROLES.has('approver')).toBe(false);
  });
});

describe('readEmbeddedSession', () => {
  it('returns the session when populated', () => {
    const session = makeSession(JSON.stringify(['admin']));
    const res = makeRes(session);
    expect(readEmbeddedSession(res)).toEqual(session);
  });

  it('returns null when missing', () => {
    expect(readEmbeddedSession(makeRes(undefined))).toBeNull();
  });

  it('returns null when not an object', () => {
    const res = { locals: { embeddedSession: 'not-an-object' } } as unknown as Response;
    expect(readEmbeddedSession(res)).toBeNull();
  });
});

describe('hasApproverRole', () => {
  it('true for approver role', () => {
    expect(hasApproverRole(makeSession(JSON.stringify(['approver'])))).toBe(true);
  });
  it('true for admin role (admin implies approver-grade access)', () => {
    expect(hasApproverRole(makeSession(JSON.stringify(['admin'])))).toBe(true);
  });
  it('false for non-approver role', () => {
    expect(hasApproverRole(makeSession(JSON.stringify(['viewer'])))).toBe(false);
  });
  it('false for null user_roles', () => {
    expect(hasApproverRole(makeSession(null))).toBe(false);
  });
  it('false for empty string user_roles', () => {
    expect(hasApproverRole(makeSession(''))).toBe(false);
  });
  it('false for invalid JSON', () => {
    expect(hasApproverRole(makeSession('not-json'))).toBe(false);
  });
  it('false when parsed value is not an array', () => {
    expect(hasApproverRole(makeSession(JSON.stringify({ admin: true })))).toBe(false);
  });
  it('false when array contains non-string entries only', () => {
    expect(hasApproverRole(makeSession(JSON.stringify([1, true, null])))).toBe(false);
  });
});

describe('hasAdminRole', () => {
  it('true for admin role', () => {
    expect(hasAdminRole(makeSession(JSON.stringify(['admin'])))).toBe(true);
  });
  it('false for approver-only role (admin is stricter)', () => {
    expect(hasAdminRole(makeSession(JSON.stringify(['approver'])))).toBe(false);
  });
  it('false for null user_roles', () => {
    expect(hasAdminRole(makeSession(null))).toBe(false);
  });
  it('false for empty string user_roles', () => {
    expect(hasAdminRole(makeSession(''))).toBe(false);
  });
  it('false for invalid JSON', () => {
    expect(hasAdminRole(makeSession('not-json'))).toBe(false);
  });
  it('false when parsed value is not an array', () => {
    expect(hasAdminRole(makeSession(JSON.stringify('admin')))).toBe(false);
  });
});

describe('requireApproverRole middleware', () => {
  const req = {} as Request;

  it('calls next() when session has approver role', () => {
    const next = jest.fn() as NextFunction;
    const res = makeRes(makeSession(JSON.stringify(['approver'])));
    requireApproverRole(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('500s when session is missing (defensive)', () => {
    const next = jest.fn() as NextFunction;
    const res = makeRes(undefined);
    requireApproverRole(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when session lacks approver role', () => {
    const next = jest.fn() as NextFunction;
    const res = makeRes(makeSession(JSON.stringify(['viewer'])));
    requireApproverRole(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireAdminRole middleware', () => {
  const req = {} as Request;

  it('calls next() when session has admin role', () => {
    const next = jest.fn() as NextFunction;
    const res = makeRes(makeSession(JSON.stringify(['admin'])));
    requireAdminRole(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('500s when session is missing (defensive)', () => {
    const next = jest.fn() as NextFunction;
    const res = makeRes(undefined);
    requireAdminRole(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when session has approver but NOT admin', () => {
    const next = jest.fn() as NextFunction;
    const res = makeRes(makeSession(JSON.stringify(['approver'])));
    requireAdminRole(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when session has no roles', () => {
    const next = jest.fn() as NextFunction;
    const res = makeRes(makeSession(null));
    requireAdminRole(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
