/**
 * Tenant Isolation Middleware Unit Tests
 * Tests for multi-tenant data isolation with JWT and header-based context
 */

import { Request, Response, NextFunction } from 'express';
import {
  tenantIsolation,
  requireTenant,
  restrictToTenants,
  requireTenantPermissions,
  scopeQueryByTenant,
  validateTenantOwnership,
  tenantFilter,
  generateTenantScopedId,
  TenantContext,
} from '../../../src/middleware/tenantIsolation';

// Mock jsonwebtoken
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

import jwt from 'jsonwebtoken';

// Helper to create mock request
function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/api/test',
    method: 'GET',
    ip: '127.0.0.1',
    ...overrides,
  } as Request;
}

// Helper to create mock response
function createMockResponse(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

// Helper to create next function
function createMockNext(): NextFunction {
  return jest.fn();
}

describe('tenantIsolation middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  describe('excluded paths', () => {
    it('should skip isolation for health check paths', async () => {
      const middleware = tenantIsolation();
      const req = createMockRequest({ path: '/health' });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should skip isolation for metrics paths', async () => {
      const middleware = tenantIsolation();
      const req = createMockRequest({ path: '/metrics' });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip isolation for custom excluded paths', async () => {
      const middleware = tenantIsolation({ excludePaths: ['/public', '/docs'] });
      const req = createMockRequest({ path: '/public/assets' });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('JWT-based tenant extraction', () => {
    it('should extract tenant from valid JWT', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        tenant_id: 'tenant-123',
        org_id: 'org-456',
        permissions: ['read', 'write'],
        environment: 'production',
        iat: 1234567890,
        exp: 1234567899,
        sub: 'user-789',
      });

      const middleware = tenantIsolation({ jwtSecret: 'test-secret' });
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tenantContext).toBeDefined();
      expect(req.tenantContext?.tenantId).toBe('tenant-123');
      expect(req.tenantContext?.organizationId).toBe('org-456');
      expect(req.tenantContext?.permissions).toEqual(['read', 'write']);
      expect(req.tenantContext?.metadata?.source).toBe('jwt');
    });

    it('should use custom JWT tenant claim', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        custom_tenant: 'custom-tenant-id',
      });

      const middleware = tenantIsolation({
        jwtSecret: 'test-secret',
        jwtTenantClaim: 'custom_tenant',
      });
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(req.tenantContext?.tenantId).toBe('custom-tenant-id');
    });

    it('should use custom JWT org claim', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        tenant_id: 'tenant-123',
        custom_org: 'custom-org-id',
      });

      const middleware = tenantIsolation({
        jwtSecret: 'test-secret',
        jwtOrgClaim: 'custom_org',
      });
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(req.tenantContext?.organizationId).toBe('custom-org-id');
    });

    it('should fall back to headers when JWT verification fails', async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const middleware = tenantIsolation({ jwtSecret: 'test-secret' });
      const req = createMockRequest({
        headers: {
          authorization: 'Bearer invalid-token',
          'x-tenant-id': 'header-tenant',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(req.tenantContext?.tenantId).toBe('header-tenant');
      expect(req.tenantContext?.metadata?.source).toBe('header');
    });

    it('should return null for JWT with invalid tenant ID format', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        tenant_id: 'invalid tenant id with spaces!@#$',
      });

      const middleware = tenantIsolation({
        jwtSecret: 'test-secret',
        allowAnonymous: true,
      });
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      // Falls through to anonymous since JWT extraction returns null
      expect(req.tenantContext?.tenantId).toBe('anonymous');
    });
  });

  describe('header-based tenant extraction', () => {
    it('should extract tenant from x-tenant-id header', async () => {
      const middleware = tenantIsolation();
      const req = createMockRequest({
        headers: {
          'x-tenant-id': 'header-tenant-123',
          'x-organization-id': 'header-org-456',
          'x-environment': 'sandbox',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tenantContext?.tenantId).toBe('header-tenant-123');
      expect(req.tenantContext?.organizationId).toBe('header-org-456');
      expect(req.tenantContext?.environment).toBe('sandbox');
      expect(req.tenantContext?.metadata?.source).toBe('header');
    });

    it('should use custom tenant header name', async () => {
      const middleware = tenantIsolation({ tenantHeader: 'X-Custom-Tenant' });
      const req = createMockRequest({
        headers: { 'x-custom-tenant': 'custom-header-tenant' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(req.tenantContext?.tenantId).toBe('custom-header-tenant');
    });

    it('should reject invalid tenant ID format in header', async () => {
      const middleware = tenantIsolation();
      const req = createMockRequest({
        headers: { 'x-tenant-id': 'invalid tenant!@#$%' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Bad Request',
          code: 'INVALID_TENANT_ID',
        }),
      );
    });
  });

  describe('trusted tenants', () => {
    it('should accept trusted tenant IDs without validation', async () => {
      const middleware = tenantIsolation({
        trustedTenants: ['system-service', 'internal-admin'],
      });
      const req = createMockRequest({
        headers: { 'x-tenant-id': 'system-service' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tenantContext?.tenantId).toBe('system-service');
      expect(req.tenantContext?.metadata?.source).toBe('trusted');
      expect(req.tenantContext?.metadata?.isTrusted).toBe(true);
    });
  });

  describe('custom tenant resolver', () => {
    it('should use custom resolver when provided', async () => {
      const customResolver = jest.fn().mockResolvedValue({
        tenantId: 'resolved-tenant',
        organizationId: 'resolved-org',
        metadata: { source: 'custom' },
      });

      const middleware = tenantIsolation({ resolveTenant: customResolver });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(customResolver).toHaveBeenCalledWith(req);
      expect(req.tenantContext?.tenantId).toBe('resolved-tenant');
    });

    it('should fall back to other methods when custom resolver returns null', async () => {
      const customResolver = jest.fn().mockResolvedValue(null);

      const middleware = tenantIsolation({ resolveTenant: customResolver });
      const req = createMockRequest({
        headers: { 'x-tenant-id': 'fallback-tenant' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(req.tenantContext?.tenantId).toBe('fallback-tenant');
    });
  });

  describe('anonymous access', () => {
    it('should allow anonymous access when configured', async () => {
      const middleware = tenantIsolation({ allowAnonymous: true });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tenantContext?.tenantId).toBe('anonymous');
      expect(req.tenantContext?.metadata?.isAnonymous).toBe(true);
    });

    it('should reject requests without tenant in strict mode (default)', async () => {
      const middleware = tenantIsolation();
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Forbidden',
          code: 'TENANT_REQUIRED',
        }),
      );
    });

    it('should pass through without tenant in non-strict mode', async () => {
      const middleware = tenantIsolation({ strictMode: false });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tenantContext).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should return 500 on error in strict mode', async () => {
      const customResolver = jest.fn().mockRejectedValue(new Error('Resolver error'));

      const middleware = tenantIsolation({
        resolveTenant: customResolver,
        strictMode: true,
      });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal Server Error',
          code: 'TENANT_ISOLATION_ERROR',
        }),
      );
    });

    it('should call next on error in non-strict mode', async () => {
      const customResolver = jest.fn().mockRejectedValue(new Error('Resolver error'));

      const middleware = tenantIsolation({
        resolveTenant: customResolver,
        strictMode: false,
      });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

describe('requireTenant middleware', () => {
  it('should pass when tenant context exists', () => {
    const middleware = requireTenant();
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'valid-tenant' };
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should reject when no tenant context', () => {
    const middleware = requireTenant();
    const req = createMockRequest();
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'TENANT_AUTHENTICATION_REQUIRED',
      }),
    );
  });

  it('should reject anonymous tenant', () => {
    const middleware = requireTenant();
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'anonymous' };
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('restrictToTenants middleware', () => {
  it('should allow access for allowed tenants', () => {
    const middleware = restrictToTenants(['tenant-a', 'tenant-b']);
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-a' };
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should deny access for non-allowed tenants', () => {
    const middleware = restrictToTenants(['tenant-a', 'tenant-b']);
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-c' };
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'TENANT_ACCESS_DENIED',
      }),
    );
  });

  it('should deny access when no tenant context', () => {
    const middleware = restrictToTenants(['tenant-a']);
    const req = createMockRequest();
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireTenantPermissions middleware', () => {
  it('should allow access with all required permissions', () => {
    const middleware = requireTenantPermissions(['read', 'write']);
    const req = createMockRequest();
    req.tenantContext = {
      tenantId: 'tenant-1',
      permissions: ['read', 'write', 'delete'],
    };
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should deny access with missing permissions', () => {
    const middleware = requireTenantPermissions(['read', 'write', 'admin']);
    const req = createMockRequest();
    req.tenantContext = {
      tenantId: 'tenant-1',
      permissions: ['read', 'write'],
    };
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INSUFFICIENT_PERMISSIONS',
        required: ['read', 'write', 'admin'],
        current: ['read', 'write'],
      }),
    );
  });

  it('should deny access when no permissions defined', () => {
    const middleware = requireTenantPermissions(['read']);
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-1' };
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('scopeQueryByTenant', () => {
  it('should add tenant_id to query object', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-123' };

    const query = { status: 'active', limit: 10 };
    const scopedQuery = scopeQueryByTenant(query, req);

    expect(scopedQuery).toEqual({
      status: 'active',
      limit: 10,
      tenant_id: 'tenant-123',
    });
  });

  it('should use custom tenant field name', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-123' };

    const query = { name: 'test' };
    const scopedQuery = scopeQueryByTenant(query, req, 'tenantId');

    expect(scopedQuery).toEqual({
      name: 'test',
      tenantId: 'tenant-123',
    });
  });

  it('should throw error when no tenant context', () => {
    const req = createMockRequest();
    const query = { name: 'test' };

    expect(() => scopeQueryByTenant(query, req)).toThrow(
      'Tenant context required for scoped query',
    );
  });

  it('should throw error for anonymous tenant', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'anonymous' };
    const query = { name: 'test' };

    expect(() => scopeQueryByTenant(query, req)).toThrow(
      'Tenant context required for scoped query',
    );
  });
});

describe('validateTenantOwnership', () => {
  it('should return true when record belongs to tenant', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-123' };

    const record = { id: 1, name: 'test', tenant_id: 'tenant-123' };
    const result = validateTenantOwnership(record, req);

    expect(result).toBe(true);
  });

  it('should return false when record belongs to different tenant', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-123' };

    const record = { id: 1, name: 'test', tenant_id: 'tenant-456' };
    const result = validateTenantOwnership(record, req);

    expect(result).toBe(false);
  });

  it('should return false when no tenant context', () => {
    const req = createMockRequest();

    const record = { id: 1, tenant_id: 'tenant-123' };
    const result = validateTenantOwnership(record, req);

    expect(result).toBe(false);
  });

  it('should use custom tenant field', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-123' };

    const record = { id: 1, customTenantField: 'tenant-123' };
    const result = validateTenantOwnership(record, req, 'customTenantField');

    expect(result).toBe(true);
  });
});

describe('tenantFilter', () => {
  it('should filter array by tenant ID', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-a' };

    const items = [
      { id: 1, tenant_id: 'tenant-a' },
      { id: 2, tenant_id: 'tenant-b' },
      { id: 3, tenant_id: 'tenant-a' },
      { id: 4, tenant_id: 'tenant-c' },
    ];

    const filtered = items.filter(tenantFilter(req));

    expect(filtered).toEqual([
      { id: 1, tenant_id: 'tenant-a' },
      { id: 3, tenant_id: 'tenant-a' },
    ]);
  });

  it('should use custom tenant field', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'org-1' };

    const items = [
      { id: 1, organization_id: 'org-1' },
      { id: 2, organization_id: 'org-2' },
    ];

    const filtered = items.filter(tenantFilter(req, 'organization_id'));

    expect(filtered).toEqual([{ id: 1, organization_id: 'org-1' }]);
  });

  it('should return empty array when no tenant context', () => {
    const req = createMockRequest();

    const items = [
      { id: 1, tenant_id: 'tenant-a' },
      { id: 2, tenant_id: 'tenant-b' },
    ];

    const filtered = items.filter(tenantFilter(req));

    expect(filtered).toEqual([]);
  });
});

describe('generateTenantScopedId', () => {
  it('should generate ID with tenant prefix', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-123' };

    const id = generateTenantScopedId(req);

    expect(id).toContain('tenant-123_');
    expect(id.split('_').length).toBe(3); // tenantId_timestamp_random
  });

  it('should include custom prefix', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-123' };

    const id = generateTenantScopedId(req, 'order_');

    expect(id.startsWith('order_tenant-123_')).toBe(true);
  });

  it('should use default tenant when no context', () => {
    const req = createMockRequest();

    const id = generateTenantScopedId(req);

    expect(id).toContain('default_');
  });

  it('should generate unique IDs', () => {
    const req = createMockRequest();
    req.tenantContext = { tenantId: 'tenant-123' };

    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTenantScopedId(req));
    }

    expect(ids.size).toBe(100);
  });
});

describe('tenant ID validation', () => {
  const middleware = tenantIsolation();

  const validTenantIds = [
    'tenant123',
    'tenant-123',
    'tenant_123',
    'TENANT-ABC',
    'a',
    'a'.repeat(64),
  ];

  const invalidTenantIds = [
    'tenant 123', // space
    'tenant@123', // special char
    'tenant!123', // special char
    'a'.repeat(65), // too long
  ];

  it.each(validTenantIds)('should accept valid tenant ID: %s', async (tenantId) => {
    const req = createMockRequest({
      headers: { 'x-tenant-id': tenantId },
    });
    const res = createMockResponse();
    const next = createMockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.tenantContext?.tenantId).toBe(tenantId);
  });

  it.each(invalidTenantIds)('should reject invalid tenant ID: %s', async (tenantId) => {
    const req = createMockRequest({
      headers: { 'x-tenant-id': tenantId },
    });
    const res = createMockResponse();
    const next = createMockNext();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_TENANT_ID' }),
    );
  });

  it('should reject empty tenant ID as missing tenant', async () => {
    const req = createMockRequest({
      headers: { 'x-tenant-id': '' },
    });
    const res = createMockResponse();
    const next = createMockNext();

    await middleware(req, res, next);

    // Empty string means no tenant provided, should return 403 in strict mode
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
