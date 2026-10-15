import type { Request } from 'express';
import { extractIdentityContext, SYSTEM_IDENTITY } from 'src/services/governance/identityContext';

function reqWith(fields: Partial<Request>): Request {
  return fields as Request;
}

describe('identityContext', () => {
  it('uses OAuth tenant and OIDC subject before req.user fields', () => {
    const req = reqWith({
      auth: {
        type: 'oauth',
        tenantId: 'tenant-oauth',
        user: {
          iss: 'issuer',
          sub: 'oidc-user',
          aud: 'client',
          exp: 1,
          iat: 1,
        },
      },
      user: {
        id: 'jwt-user',
        username: 'jwt',
        tenantId: 'tenant-jwt',
        roles: [],
        permissions: [],
      },
    });

    expect(extractIdentityContext(req)).toEqual({
      tenantId: 'tenant-oauth',
      userId: 'oidc-user',
    });
  });

  it('falls back to JWT-style req.user identity', () => {
    const req = reqWith({
      user: {
        id: 'jwt-user',
        username: 'jwt',
        tenantId: 'tenant-jwt',
        roles: [],
        permissions: [],
      },
    });

    expect(extractIdentityContext(req)).toEqual({
      tenantId: 'tenant-jwt',
      userId: 'jwt-user',
    });
  });

  it('normalizes legacy numeric req.user.id values to strings', () => {
    const req = reqWith({
      user: {
        id: 42,
        username: 'legacy',
        tenantId: 'tenant-legacy',
        roles: [],
        permissions: [],
      } as unknown as Request['user'],
    });

    expect(extractIdentityContext(req)).toEqual({
      tenantId: 'tenant-legacy',
      userId: '42',
    });
  });

  it('uses API-key creator identity when AuthenticationMiddleware supplies it', () => {
    const req = reqWith({
      auth: {
        type: 'api_key',
        tenantId: 'tenant-api',
        apiKey: {
          id: 'key-1',
          tenantId: 'tenant-api',
          keyName: 'Automation key',
          keyHash: 'hash',
          keyPrefix: 'prefix',
          permissions: ['read'],
          isActive: true,
          createdBy: 'api-owner',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
        permissions: ['read'],
      },
    });

    expect(extractIdentityContext(req)).toEqual({
      tenantId: 'tenant-api',
      userId: 'api-owner',
    });
  });

  it('preserves verified tenant context when only the actor is missing', () => {
    expect(extractIdentityContext(reqWith({
      auth: { type: 'api_key', tenantId: 'tenant-only', permissions: [] },
    }))).toEqual({
      tenantId: 'tenant-only',
      userId: SYSTEM_IDENTITY.userId,
    });
  });

  it('does not splice tenant and user fields across auth sources', () => {
    const req = reqWith({
      auth: {
        type: 'api_key',
        tenantId: 'tenant-auth',
        permissions: [],
      },
      user: {
        id: 'jwt-user',
        username: 'jwt',
        tenantId: 'tenant-jwt',
        roles: [],
        permissions: [],
      },
    });

    expect(extractIdentityContext(req)).toEqual({
      tenantId: 'tenant-auth',
      userId: SYSTEM_IDENTITY.userId,
    });
  });

  it('does not fall back to req.user when req.auth is present without a tenant', () => {
    const req = reqWith({
      auth: {
        type: 'api_key',
        apiKey: {
          id: 'key-1',
          keyName: 'Automation key',
          keyHash: 'hash',
          keyPrefix: 'prefix',
          permissions: ['read'],
          isActive: true,
          createdBy: 'api-owner',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
        permissions: ['read'],
      },
      user: {
        id: 'jwt-user',
        username: 'jwt',
        tenantId: 'tenant-jwt',
        roles: [],
        permissions: [],
      },
    });

    expect(extractIdentityContext(req)).toBe(SYSTEM_IDENTITY);
  });

  it.each([
    [{ user: { id: 'user-only', username: 'jwt', roles: [], permissions: [] } }, 'missing tenant id'],
    [{}, 'missing all identity'],
  ])('returns SYSTEM_IDENTITY for partial identity: %s', (fields) => {
    expect(extractIdentityContext(reqWith(fields as Partial<Request>))).toBe(SYSTEM_IDENTITY);
  });

  it('does not read spoofable identity headers', () => {
    const req = reqWith({
      headers: {
        'x-tenant-id': 'spoofed-tenant',
        'x-user-id': 'spoofed-user',
      },
    });

    expect(extractIdentityContext(req)).toBe(SYSTEM_IDENTITY);
  });

  it('exposes one frozen system identity singleton', () => {
    expect(extractIdentityContext(reqWith({}))).toBe(SYSTEM_IDENTITY);
    expect(Object.isFrozen(SYSTEM_IDENTITY)).toBe(true);
    expect(() => {
      (SYSTEM_IDENTITY as { tenantId: string }).tenantId = 'mutated';
    }).toThrow(TypeError);
  });

  describe('req.tenantContext bridge (PR 2C-Auth — third identity source)', () => {
    // The bridge is safe ONLY because mountCentralTenantGate keeps
    // disableHeaderExtraction: true, frozen by the
    // audit-status-claims --check-tenant-isolation-invariant CI gate.
    // These specs prove the bridge fires when expected and stays subordinate
    // to req.auth / req.user (existing source ordering).

    it('uses req.tenantContext.tenantId when neither req.auth nor req.user is set', () => {
      const req = reqWith({
        tenantContext: { tenantId: 'tenant-from-context' },
      });
      expect(extractIdentityContext(req)).toEqual({
        tenantId: 'tenant-from-context',
        userId: SYSTEM_IDENTITY.userId,
      });
    });

    it('still prefers req.auth.tenantId over req.tenantContext.tenantId', () => {
      const req = reqWith({
        auth: {
          type: 'oauth',
          tenantId: 'tenant-from-auth',
          user: { iss: 'i', sub: 'oidc-user', aud: 'c', exp: 1, iat: 1 },
        },
        tenantContext: { tenantId: 'tenant-from-context' },
      });
      expect(extractIdentityContext(req).tenantId).toBe('tenant-from-auth');
    });

    it('still prefers req.user.tenantId over req.tenantContext.tenantId', () => {
      const req = reqWith({
        user: {
          id: 'jwt-user',
          username: 'jwt',
          tenantId: 'tenant-from-user',
          roles: [],
          permissions: [],
        },
        tenantContext: { tenantId: 'tenant-from-context' },
      });
      expect(extractIdentityContext(req).tenantId).toBe('tenant-from-user');
    });

    it('does NOT bridge when req.tenantContext.tenantId is missing or empty', () => {
      const reqEmpty = reqWith({
        tenantContext: { tenantId: '' },
      });
      expect(extractIdentityContext(reqEmpty)).toBe(SYSTEM_IDENTITY);
    });

    it('does NOT splice tenantContext with req.user identity (whole-source-first contract)', () => {
      // req.auth present without tenantId → still SYSTEM_IDENTITY (fail
      // closed on partial req.auth); the bridge MUST NOT step in to repair
      // req.auth's missing tenant from req.tenantContext.
      const req = reqWith({
        auth: { type: 'api_key', permissions: [] },
        tenantContext: { tenantId: 'tenant-from-context' },
      });
      expect(extractIdentityContext(req)).toBe(SYSTEM_IDENTITY);
    });
  });

});
