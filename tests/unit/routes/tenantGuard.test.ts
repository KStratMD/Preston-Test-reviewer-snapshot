import 'reflect-metadata';
import type { Request, Response } from 'express';
import { requireTenantId, requireConfigurationCommandContext } from '../../../src/routes/tenantGuard';

function makeRes() {
  const res: Partial<Response> & { statusCode?: number; jsonBody?: unknown } = {};
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response['status'];
  res.json = jest.fn((body: unknown) => {
    res.jsonBody = body;
    return res as Response;
  }) as unknown as Response['json'];
  return res as Response & { statusCode?: number; jsonBody?: unknown };
}

describe('requireTenantId', () => {
  it('returns the tenantId and does not respond when present', () => {
    const req = { user: { tenantId: 'tenant-a' } } as unknown as Request;
    const res = makeRes();

    expect(requireTenantId(req, res)).toBe('tenant-a');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('sends 401 tenant_required and returns undefined when tenantId is missing', () => {
    const req = { user: {} } as unknown as Request;
    const res = makeRes();

    expect(requireTenantId(req, res)).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.jsonBody).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
  });

  it('sends 401 when req.user itself is absent', () => {
    const req = {} as unknown as Request;
    const res = makeRes();

    expect(requireTenantId(req, res)).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireConfigurationCommandContext', () => {
  it('builds a context with a concrete operation, tenant, actor, and the normalized req.correlationId', () => {
    const req = {
      user: { id: 'user-1', tenantId: 'tenant-a' },
      correlationId: 'req-correlation-1',
    } as unknown as Request;
    const res = makeRes();

    const context = requireConfigurationCommandContext(req, res, 'create', 'tenant-a');

    expect(context).toEqual({
      tenantId: 'tenant-a',
      actorUserId: 'user-1',
      correlationId: 'req-correlation-1',
      operation: 'create',
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls back to a fresh UUID correlation id when req.correlationId is absent', () => {
    const req = { user: { id: 'user-1', tenantId: 'tenant-a' } } as unknown as Request;
    const res = makeRes();

    const context = requireConfigurationCommandContext(req, res, 'update', 'tenant-a');

    expect(context?.correlationId).toEqual(expect.any(String));
    expect(context?.correlationId.length).toBeGreaterThan(0);
    expect(context?.correlationId).not.toBe('');
  });

  it('sends 401 operator_identity_required and returns undefined when req.user.id is missing', () => {
    const req = { user: { tenantId: 'tenant-a' } } as unknown as Request;
    const res = makeRes();

    expect(requireConfigurationCommandContext(req, res, 'create', 'tenant-a')).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.jsonBody).toEqual({ error: 'unauthorized', reason: 'operator_identity_required' });
  });

  it('sends 401 operator_identity_required when req.user.id is an empty string ("unknown" is never an actor)', () => {
    const req = { user: { id: '', tenantId: 'tenant-a' } } as unknown as Request;
    const res = makeRes();

    expect(requireConfigurationCommandContext(req, res, 'create', 'tenant-a')).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.jsonBody).toEqual({ error: 'unauthorized', reason: 'operator_identity_required' });
  });

  it('sends 401 when req.user itself is absent', () => {
    const req = {} as unknown as Request;
    const res = makeRes();

    expect(requireConfigurationCommandContext(req, res, 'create', 'tenant-a')).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.jsonBody).toEqual({ error: 'unauthorized', reason: 'operator_identity_required' });
  });

  it('sends 403 tenant_mismatch and returns undefined when req.user.tenantId does not match the resolved tenant', () => {
    const req = { user: { id: 'user-1', tenantId: 'tenant-b' } } as unknown as Request;
    const res = makeRes();

    expect(requireConfigurationCommandContext(req, res, 'update', 'tenant-a')).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.jsonBody).toEqual({ error: 'forbidden', reason: 'tenant_mismatch' });
  });
});
