// JWT auth middleware — tenantId-claim propagation tests.
//
// Codex-caught BLOCKS-MERGE during PR #794 R7: authMiddleware previously
// dropped the tenantId claim from the JWT, so a JWT-authenticated request
// would reach tenantStatusGate with req.user populated but no tenantId,
// triggering the SYSTEM_IDENTITY short-circuit and silently bypassing the
// kill switch. This file pins the fix: both authMiddleware (required) and
// optionalAuthMiddleware (optional) now copy decoded.tenantId/tid/tenant_id
// into req.user.tenantId.
//
// We mock the DI container's AuthService.verifyJWT so the tests do not need
// a real signing key — they exercise only the claim-copying contract.

import 'reflect-metadata';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Stub AuthService.verifyJWT so the tests exercise only the claim-copying
// contract. The mock dispatches on EXACT symbol identity (not substring),
// and any unrecognized symbol throws loudly so missing mocks surface
// immediately instead of silently routing to the auth stub by accident.
const verifyJWT = jest.fn();
const authStub = { verifyJWT };
const loggerStub = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// Mocked TYPES — symbol identities are the dispatch key for container.get.
// Tests reference these directly so the mock cannot drift from production TYPES
// names (it doesn't have to — we control the mocked side completely).
const MOCK_TYPES = {
  AuthService: Symbol('AuthService'),
  Logger: Symbol('Logger'),
};

jest.mock('../../../src/inversify/types', () => ({
  TYPES: MOCK_TYPES,
}));
jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: (sym: symbol) => {
      if (sym === MOCK_TYPES.AuthService) return authStub;
      if (sym === MOCK_TYPES.Logger) return loggerStub;
      // Loud failure: a future container.get(TYPES.X) for an unknown symbol
      // surfaces as a thrown error rather than silently returning a stub
      // that happens to satisfy duck-typing checks.
      throw new Error(`Unmocked container.get(${sym.toString()}) — add to authJwtTenantId.test.ts mock`);
    },
  },
}));

import { authMiddleware, optionalAuthMiddleware } from '../../../src/middleware/auth';

function mintJwt(_claims: Record<string, unknown>): string {
  // Bypass real signing/verification — verifyJWT is stubbed to return whatever
  // claims the test sets. The token string itself is opaque to the middleware.
  return 'opaque.test.token';
}

function mkReq(token?: string): Partial<Request> {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as any;
}

function mkRes(): Partial<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as any;
}

describe('authMiddleware tenantId-claim propagation', () => {
  let next: jest.Mock;
  beforeEach(() => {
    next = jest.fn();
    verifyJWT.mockReset();
  });

  it('copies decoded.tenantId into req.user.tenantId', () => {
    verifyJWT.mockReturnValue({ sub: 'u1', username: 'u1', tenantId: 'acme-co', roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBe('acme-co');
    expect(next).toHaveBeenCalledWith();
  });

  it('also accepts the "tid" claim form (OIDC convention)', () => {
    verifyJWT.mockReturnValue({ sub: 'u1', tid: 'acme-tid', roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBe('acme-tid');
  });

  it('also accepts the "tenant_id" claim form (snake_case)', () => {
    verifyJWT.mockReturnValue({ sub: 'u1', tenant_id: 'acme-snake', roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBe('acme-snake');
  });

  it('leaves req.user.tenantId undefined when NO tenant claim is present', () => {
    // This is the case the gate must fail closed on (tenant_id_missing 403).
    verifyJWT.mockReturnValue({ sub: 'u1', username: 'u1', roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBeUndefined();
    expect((req as Request & { user?: { id: string } }).user?.id).toBe('u1');
  });

  it('coerces non-string tenantId claim values to strings', () => {
    // JWT libs may produce numeric tenantIds; we want a string at the boundary.
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: 42, roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBe('42');
  });

  it('normalizes empty-string tenantId claim to undefined (P2/R7-5)', () => {
    // Without normalization, '' would land on req.user.tenantId and downstream
    // identity extraction would treat the falsy string as missing — correct
    // behavior, but the field shape on req.user is misleading and the gate's
    // auto-register seam could later be hit by an attacker-supplied '' that
    // bypasses some other check. Normalize at the boundary.
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: '', roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBeUndefined();
  });

  it('normalizes whitespace-only tenantId claim to undefined (P2)', () => {
    // Codex P2 specifically called out whitespace like " " auto-registering.
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: '   ', roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBeUndefined();
  });

  it('trims surrounding whitespace from a valid tenantId claim', () => {
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: '  acme  ', roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBe('acme');
  });

  it('rejects an oversized tenantId claim (> 255 chars) by normalizing to undefined', () => {
    const oversized = 'a'.repeat(300);
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: oversized, roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBeUndefined();
  });

  it('accepts a tenantId exactly at the length boundary', () => {
    const boundary = 'a'.repeat(255);
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: boundary, roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBe(boundary);
  });

  // R10 (Codex): allowlist must reject characters that survive String.trim().
  // Invisible / bidi / control / non-ASCII chars all need an explicit reject —
  // otherwise an attacker can mint a tenantId that renders identically to an
  // existing tenant but is byte-distinct, auto-registering through the gate.
  it.each([
    ['zero-width space (U+200B)',           'acme​co'],
    ['zero-width non-joiner (U+200C)',      'acme‌co'],
    ['right-to-left override (U+202E)',     'acme‮co'],
    ['left-to-right mark (U+200E)',         'acme‎co'],
    ['BOM (U+FEFF)',                        'acme﻿co'],
    ['ASCII NUL (\\x00)',                   'acme\x00co'],
    ['tab (\\x09)',                          'acme\x09co'],
    ['newline (\\x0A)',                      'acme\x0Aco'],
    ['DEL (\\x7F)',                          'acme\x7Fco'],
    ['non-ASCII letter (é)',                 'acmé'],
    ['CJK character',                        'acme中'],
    ['leading-only zero-width space',        '​acme'],
    ['whole value is zero-width space',      '​'],
    ['slash',                                'acme/co'],
    ['backslash',                            'acme\\co'],
    ['colon',                                'acme:co'],
    ['period (hierarchical IDs not allowed)', 'acme.co'],
    ['semicolon',                            'acme;co'],
    ['quote',                                "acme'co"],
    ['angle bracket',                        'acme<co'],
    ['plus',                                 'acme+co'],
    ['percent (URL-encoded sneak)',          'acme%20co'],
    ['internal space',                       'acme co'],
  ])('rejects tenantId containing %s by normalizing to undefined', (_label, value) => {
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: value, roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBeUndefined();
  });

  it.each([
    ['plain alphanumeric',         'acme'],
    ['hyphen-separated',           'acme-co'],
    ['underscore-separated',       'acme_co'],
    ['UUID v4',                    '123e4567-e89b-12d3-a456-426614174000'],
    ['ULID',                       '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['mixed-case alphanumeric',    'AcmeCo123'],
    ['digits-only',                '12345'],
    ['single character',           'a'],
    ['underscore + hyphen mix',    't_e-n_a-n_t'],
  ])('accepts a tenantId matching the allowlist: %s', (_label, value) => {
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: value, roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    authMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBe(value);
  });
});

describe('optionalAuthMiddleware tenantId-claim propagation', () => {
  let next: jest.Mock;
  beforeEach(() => {
    next = jest.fn();
  });

  it('copies decoded.tenantId into req.user.tenantId when a JWT is present', () => {
    verifyJWT.mockReturnValue({ sub: 'u1', tenantId: 'acme-opt', roles: ['user'] });
    const req = mkReq(mintJwt({})) as Request;
    optionalAuthMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: { tenantId?: string } }).user?.tenantId).toBe('acme-opt');
    expect(next).toHaveBeenCalledWith();
  });

  it('leaves req.user undefined when no Authorization header is present (demo path)', () => {
    const req = mkReq() as Request;
    optionalAuthMiddleware(req, mkRes() as Response, next as unknown as NextFunction);
    expect((req as Request & { user?: unknown }).user).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });
});
