import type { Request } from 'express';
import { resolveActor } from '../../../../src/services/governance/resolveActor';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

// Minimal Request stubs — verifiedUserId only reads req.user.id.
const reqWith = (over: Partial<Request>): Request => over as Request;
const preAuthReq = (): Request => reqWith({});
const authedReq = (userId: string, tenantId = 'tenant-a'): Request =>
  reqWith({ user: { tenantId, id: userId } } as Partial<Request>);

describe('resolveActor', () => {
  it('returns the trimmed verified user id', () => {
    expect(resolveActor(authedReq(' alice '))).toBe('alice');
  });

  it('returns undefined when the request has no verified user', () => {
    expect(resolveActor(preAuthReq())).toBeUndefined();
  });

  it('returns undefined for the sentinel user even when a real tenant is present', () => {
    const req = reqWith({
      user: { tenantId: 'tenant-a', id: SYSTEM_IDENTITY.userId },
    } as Partial<Request>);
    expect(resolveActor(req)).toBeUndefined();
  });
});
