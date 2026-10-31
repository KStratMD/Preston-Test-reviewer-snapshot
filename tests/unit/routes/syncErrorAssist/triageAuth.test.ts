/**
 * Unit tests for the Sync Error Assist triage authorization dispatcher.
 *
 * The integration suites cover the matrix against a real database; these pin
 * the composition itself: which stack a request takes, that an async gate
 * which denies late (or rejects) still stops the stack before the handler,
 * and that a handler without an actor fails closed.
 */
import 'reflect-metadata';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { container } from '../../../../src/inversify/inversify.config';
import { TYPES } from '../../../../src/inversify/types';
import jwt from 'jsonwebtoken';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';
import type { EmbeddedRoleGrant, EmbeddedSession } from '../../../../src/database/types';
import {
  authorizeTriageCaller,
  classifyAuthorization,
  getTriageActor,
  requireTriageJwtClaims,
  setEmbeddedActor,
  setJwtActor,
  type TriageActor,
} from '../../../../src/routes/syncErrorAssist/triageAuth';

const HOST = '127.0.0.1';
const GRANT_ID = 'erg_unit_1';

function session(overrides: Partial<EmbeddedSession> = {}): EmbeddedSession {
  return {
    session_id: 'es_unit',
    tenant_id: 'tenant-u',
    user_id: 'user-u',
    platform: 'netsuite',
    platform_account_id: 'acct-u',
    csrf_token: 'csrf',
    expected_host_origin: 'https://12345.app.netsuite.com',
    expires_at: '2099-01-01T00:00:00.000Z',
    last_rotation_at: null,
    erp_record_type: null,
    erp_record_id: null,
    erp_record_url: null,
    user_roles: null,
    user_identity: 'squire_verified',
    verified_grant_id: GRANT_ID,
    created_at: '2026-09-23T00:00:00.000Z',
    ...overrides,
  } as EmbeddedSession;
}

function grant(role: string): EmbeddedRoleGrant {
  return {
    id: GRANT_ID,
    tenant_id: 'tenant-u',
    platform: 'netsuite',
    platform_account_id: 'acct-u',
    user_id: 'user-u',
    role,
    source: 'squire_operator',
    granted_by: 'op',
    granted_at: '2026-09-23T00:00:00.000Z',
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    secret_enc: 'x',
  } as EmbeddedRoleGrant;
}

// The unit environment mocks AuthService (tests/fastMocks.ts) with a
// verifyJWT that returns no subject, so bind one real HS256 verifier. The same
// object is bound in every test because authMiddleware caches the first
// AuthService it resolves.
const JWT_SECRET = 'triage-auth-unit-secret';
const authServiceStub = {
  generateJWT: (payload: Record<string, unknown>) => jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' }),
  verifyJWT: (token: string) => {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string') throw new Error('Invalid JWT payload format');
    return decoded as Record<string, unknown>;
  },
};

function token(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

let handler: jest.Mock;
let findSession: jest.Mock;
let getActiveGrant: jest.Mock;
let requireActive: jest.Mock;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/t', authorizeTriageCaller, (req: Request, res: Response) => {
    handler();
    const actor = getTriageActor(res);
    if (actor === null) return;
    res.status(200).json({ actor });
  });
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ ok: false, code: 'internal_error' });
  });
  return app;
}

function embeddedGet(app: express.Express): request.Test {
  return request(app).get('/t').set('Origin', `http://${HOST}`).set('X-Embedded-Session-Id', 'es_unit');
}

beforeEach(() => {
  container.snapshot();
  handler = jest.fn();
  findSession = jest.fn(async () => session());
  getActiveGrant = jest.fn(async () => grant('approver'));
  requireActive = jest.fn(async () => undefined);
  container.rebind(TYPES.EmbeddedSessionRepository).toConstantValue({ findSession });
  container.rebind(TYPES.EmbeddedRoleGrantRepository).toConstantValue({ getActiveGrant });
  container.rebind(TYPES.TenantLifecycleService).toConstantValue({ requireActive });
  container.rebind(TYPES.AuthService).toConstantValue(authServiceStub);
});

afterEach(() => {
  container.restore();
});

describe('classifyAuthorization', () => {
  it.each([
    [undefined, 'other'],
    ['Basic dXNlcjpwYXNz', 'other'],
    ['Token abc', 'other'],
    ['Bearerabc', 'other'],
    ['Bearer abc.def.ghi', 'canonical'],
    ['  Bearer abc  ', 'canonical'],
    ['bearer abc', 'malformed_bearer'],
    ['BEARER abc', 'malformed_bearer'],
    ['Bearer  abc', 'malformed_bearer'],
    ['Bearer\tabc', 'malformed_bearer'],
    ['Bearer', 'malformed_bearer'],
    ['Bearer abc def', 'malformed_bearer'],
  ])('%p → %s', (header, expected) => {
    expect(classifyAuthorization(header)).toBe(expected);
  });
});

describe('authorizeTriageCaller dispatch', () => {
  it('embedded path: a verified approver grant reaches the handler with the session tenant', async () => {
    const res = await embeddedGet(buildApp());
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ tenantId: 'tenant-u', userId: 'user-u', source: 'embedded_grant' });
    expect(requireActive).toHaveBeenCalledWith('tenant-u');
  });

  it('embedded path: a Basic header plus a session is treated as embedded', async () => {
    const res = await embeddedGet(buildApp()).set('Authorization', 'Basic c3RhZ2luZzpwcm94eQ==');
    expect(res.status).toBe(200);
    expect(res.body.actor.source).toBe('embedded_grant');
  });

  it('embedded path: a viewer grant is 403 insufficient_role with no handler call', async () => {
    getActiveGrant.mockResolvedValue(grant('viewer'));
    const res = await embeddedGet(buildApp());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('insufficient_role');
    expect(handler).not.toHaveBeenCalled();
  });

  it('embedded path: a grant lookup that denies only after a delay still stops the stack', async () => {
    getActiveGrant.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(null), 50)),
    );
    const res = await embeddedGet(buildApp());
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('embedded path: a grant lookup that throws reaches the error handler, not the route', async () => {
    getActiveGrant.mockRejectedValue(new Error('db down'));
    const res = await embeddedGet(buildApp());
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
    expect(handler).not.toHaveBeenCalled();
  });

  it('embedded path: a rejected findSession is a 500 with no handler call and no unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      findSession.mockRejectedValue(new Error('session store down'));
      const res = await embeddedGet(buildApp());
      expect(res.status).toBe(500);
      expect(handler).not.toHaveBeenCalled();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('embedded path: a suspended tenant never reaches the role gate', async () => {
    const { TenantBlockedError } = await import('../../../../src/services/tenants/TenantLifecycleService');
    requireActive.mockRejectedValue(new TenantBlockedError('tenant-u', 'suspended', 'test'));
    const res = await embeddedGet(buildApp());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_blocked');
    expect(getActiveGrant).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('JWT path: tenant_admin reaches the handler with the claim tenant and subject', async () => {
    const jwtToken = token({ sub: 'sub-1', tenantId: 'tenant-j', roles: ['tenant_admin'] });
    const res = await request(buildApp()).get('/t').set('Authorization', `Bearer ${jwtToken}`);
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ tenantId: 'tenant-j', userId: 'sub-1', source: 'api_jwt' });
    expect(requireActive).toHaveBeenCalledWith('tenant-j');
    expect(findSession).not.toHaveBeenCalled();
  });

  it('JWT path: an invalid token is 401 from authMiddleware, never the embedded path', async () => {
    const res = await request(buildApp()).get('/t').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(findSession).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('canonical Bearer plus a session header is 400 before any verification', async () => {
    const res = await embeddedGet(buildApp()).set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ambiguous_credentials');
    expect(findSession).not.toHaveBeenCalled();
  });

  it.each(['bearer x', 'BEARER x', 'Bearer  x', 'Bearer'])(
    'malformed %p is 401 invalid_authorization_scheme with or without a session, never the embedded stack',
    async (header) => {
      const app = buildApp();
      for (const res of [
        await embeddedGet(app).set('Authorization', header),
        await request(app).get('/t').set('Authorization', header),
      ]) {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('invalid_authorization_scheme');
      }
      expect(findSession).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );
});

describe('requireTriageJwtClaims', () => {
  function run(user: unknown): { status?: number; body?: { code?: string }; next: jest.Mock } {
    const out: { status?: number; body?: { code?: string }; next: jest.Mock } = { next: jest.fn() };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(body: { code?: string }) { out.body = body; return this; },
    } as unknown as Response;
    requireTriageJwtClaims({ user } as unknown as Request, res, out.next);
    return out;
  }

  it('admits tenant_admin with a subject and tenant', () => {
    expect(run({ id: 's', tenantId: 't', roles: ['tenant_admin'] }).next).toHaveBeenCalled();
  });

  it.each([
    ['no user', undefined],
    ['blank subject', { id: '  ', tenantId: 't', roles: ['tenant_admin'] }],
    ['no tenant', { id: 's', roles: ['tenant_admin'] }],
    ['blank tenant', { id: 's', tenantId: '   ', roles: ['tenant_admin'] }],
    ['system tenant', { id: 's', tenantId: SYSTEM_IDENTITY.tenantId, roles: ['tenant_admin'] }],
  ])('%s → 401 tenant_identity_required', (_label, user) => {
    const out = run(user);
    expect(out.status).toBe(401);
    expect(out.body?.code).toBe('tenant_identity_required');
    expect(out.next).not.toHaveBeenCalled();
  });

  it.each([
    ['platform admin', { id: 's', tenantId: 't', roles: ['admin'] }, 'insufficient_role'],
    ['wildcard permission', { id: 's', tenantId: 't', roles: ['user'], permissions: ['*'] }, 'insufficient_role'],
    ['plain user', { id: 's', tenantId: 't', roles: ['user'] }, 'insufficient_role'],
    ['service with tenant_admin', { id: 's', tenantId: 't', roles: ['tenant_admin', 'service'] }, 'service_role_refused'],
  ])('%s → 403 %s', (_label, user, code) => {
    const out = run(user);
    expect(out.status).toBe(403);
    expect(out.body?.code).toBe(code);
    expect(out.next).not.toHaveBeenCalled();
  });
});

describe('actor fail-closed', () => {
  function fakeRes(locals: Record<string, unknown> = {}) {
    const out: { status?: number; body?: { code?: string } } = {};
    const res = {
      locals,
      status(code: number) { out.status = code; return this; },
      json(body: { code?: string }) { out.body = body; return this; },
    } as unknown as Response;
    return { res, out };
  }

  it('getTriageActor answers 500 actor_not_populated when nothing set an actor', () => {
    const { res, out } = fakeRes();
    expect(getTriageActor(res)).toBeNull();
    expect(out.status).toBe(500);
    expect(out.body?.code).toBe('actor_not_populated');
  });

  it('getTriageActor returns the actor when present', () => {
    const actor: TriageActor = { tenantId: 't', userId: 'u', source: 'api_jwt' };
    const { res } = fakeRes({ triageActor: actor });
    expect(getTriageActor(res)).toEqual(actor);
  });

  it('setEmbeddedActor refuses without a resolved principal', () => {
    const { res, out } = fakeRes({ embeddedSession: session() });
    const next = jest.fn();
    setEmbeddedActor({} as Request, res, next);
    expect(out.status).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('setJwtActor refuses without verified claims', () => {
    const { res, out } = fakeRes();
    const next = jest.fn();
    setJwtActor({ user: undefined } as unknown as Request, res, next);
    expect(out.status).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });
});
