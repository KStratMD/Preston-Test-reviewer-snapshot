import 'reflect-metadata';
import type { Request, Response } from 'express';
import { requireTenantId } from '../../../src/routes/tenantGuard';

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
