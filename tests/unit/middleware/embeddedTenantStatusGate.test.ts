import type { Request, Response, NextFunction } from 'express';

const mockRequireActive = jest.fn();
jest.mock('../../../src/inversify/inversify.config', () => ({
  container: { getAsync: jest.fn(async () => ({ requireActive: mockRequireActive })) },
}));

import { requireActiveEmbeddedTenant } from '../../../src/middleware/embeddedTenantStatusGate';
import { TenantBlockedError } from '../../../src/services/tenants/TenantLifecycleService';
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';

function makeRes(session: unknown): Response & { statusCode?: number; jsonBody?: unknown } {
  const res: Record<string, unknown> = { locals: { embeddedSession: session } };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: unknown) => { res.jsonBody = body; return res; });
  return res as unknown as Response & { statusCode?: number; jsonBody?: unknown };
}

function run(session: unknown): Promise<{ res: ReturnType<typeof makeRes>; next: jest.Mock }> {
  const res = makeRes(session);
  const next = jest.fn();
  requireActiveEmbeddedTenant({} as Request, res, next as unknown as NextFunction);
  // middleware resolves async — flush the container promise chain
  return new Promise((resolve) => setImmediate(() => resolve({ res, next })));
}

describe('requireActiveEmbeddedTenant', () => {
  beforeEach(() => jest.clearAllMocks());

  it('500s session_not_populated when validateGuestContext did not run', async () => {
    const { res, next } = await run(undefined);
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toMatchObject({ ok: false, code: 'session_not_populated' });
    expect(next).not.toHaveBeenCalled();
    expect(mockRequireActive).not.toHaveBeenCalled();
  });

  it('500s when the session lacks a non-empty tenant_id', async () => {
    const { res } = await run({ tenant_id: '' });
    expect(res.statusCode).toBe(500);
  });

  it('calls next() for an active tenant', async () => {
    mockRequireActive.mockResolvedValueOnce(undefined);
    const { res, next } = await run({ tenant_id: 'tenant-a' });
    expect(mockRequireActive).toHaveBeenCalledWith('tenant-a');
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeUndefined();
  });

  it('403s tenant_blocked with reason+status for a blocked tenant', async () => {
    mockRequireActive.mockRejectedValueOnce(new TenantBlockedError('tenant-s', 'suspended', 'tenant_suspended'));
    const { res, next } = await run({ tenant_id: 'tenant-s' });
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({ error: 'tenant_blocked', reason: 'tenant_suspended', status: 'suspended' });
    expect(next).not.toHaveBeenCalled();
  });

  // Codex R3: the session store persists tenant_id verbatim at provisioning,
  // and requireActive auto-registers whatever it is handed — a non-canonical
  // id ('tenant-a ' with trailing space, overlong, Unicode, delimiters) would
  // mint an active SHADOW tenant distinct from the canonical row, bypassing
  // its suspension. The gate must reject non-canonical ids BEFORE the
  // lifecycle lookup, using the same validator as the JWT path.
  it.each([
    ['tenant-a ', 'trailing space'],
    [' tenant-a', 'leading space'],
    ['ten ant', 'interior space'],
    ['tenant/α', 'delimiter + unicode'],
    ['a'.repeat(256), 'overlong'],
    ['tenant​-a', 'zero-width space'],
  ])('fails closed on non-canonical tenant_id %j (%s) WITHOUT touching the lifecycle service', async (tenantId) => {
    const { res, next } = await run({ tenant_id: tenantId });
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toMatchObject({ error: 'tenant_id_missing' });
    expect(mockRequireActive).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed on a __system__ session WITHOUT touching the lifecycle service (no auto-register row, no handler)', async () => {
    // requireActive auto-registers unknown tenants as active — a session
    // carrying the system marker must never reach it, or '__system__'
    // becomes a real active tenant row and the request proceeds.
    const { res, next } = await run({ tenant_id: SYSTEM_IDENTITY.tenantId });
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toMatchObject({ error: 'tenant_id_missing' });
    expect(mockRequireActive).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards non-TenantBlockedError rejections to next(err) — never fail-open', async () => {
    const boom = new Error('db down');
    mockRequireActive.mockRejectedValueOnce(boom);
    const { res, next } = await run({ tenant_id: 'tenant-a' });
    expect(next).toHaveBeenCalledWith(boom);
    expect(res.statusCode).toBeUndefined();
  });
});
