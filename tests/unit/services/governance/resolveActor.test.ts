import type { Request } from 'express';
import { resolveActor } from '../../../../src/services/governance/resolveActor';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

// Minimal Request stubs — extractIdentityContext only reads req.auth/req.user/req.tenantContext.
const reqWith = (over: Partial<Request>): Request => over as Request;
const preAuthReq = (): Request => reqWith({});
const authedReq = (userId: string, tenantId = 'tenant-a'): Request =>
  reqWith({ user: { tenantId, id: userId } } as Partial<Request>);

describe('resolveActor', () => {
  it('returns the authenticated userId and IGNORES the body actor when authenticated', () => {
    expect(resolveActor(authedReq('alice'), 'ceo@evil.example')).toBe('alice');
    expect(resolveActor(authedReq('alice'), { spoof: true })).toBe('alice');
    expect(resolveActor(authedReq('alice'), 12345)).toBe('alice');
    expect(resolveActor(authedReq('alice'), undefined)).toBe('alice');
  });

  it('returns the real-tenant sentinel userId (NOT the body) when tenant is real but userId is the system sentinel', () => {
    // req.tenantContext bridge: tenant present, no user subject → userId = SYSTEM sentinel,
    // tenantId real. This is NOT pre-auth, so the body must still be ignored.
    const req = reqWith({ tenantContext: { tenantId: 'tenant-a' } } as Partial<Request>);
    expect(resolveActor(req, 'spoofed')).toBe(SYSTEM_IDENTITY.userId);
  });

  it('trusts a valid non-empty string body actor in pre-auth/demo mode', () => {
    expect(resolveActor(preAuthReq(), 'demo-user')).toBe('demo-user');
    expect(resolveActor(preAuthReq(), '  trimmed-ok  ')).toBe('trimmed-ok');
  });

  it('returns undefined in pre-auth/demo mode for missing or invalid body actors', () => {
    expect(resolveActor(preAuthReq(), undefined)).toBeUndefined();
    expect(resolveActor(preAuthReq(), '')).toBeUndefined();
    expect(resolveActor(preAuthReq(), '   ')).toBeUndefined();
    expect(resolveActor(preAuthReq(), 42)).toBeUndefined();
    expect(resolveActor(preAuthReq(), { x: 1 })).toBeUndefined();
    expect(resolveActor(preAuthReq(), null)).toBeUndefined();
  });
});
