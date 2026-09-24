import type { Request } from 'express';
import {
  GOVERNANCE_OVERRIDE_ROLE,
  OVERRIDE_REASON_HEADER,
  extractOperatorOverride,
} from '../../../../src/services/governance/operatorOverride';

/**
 * Build a minimal Express Request stub for the helper. Only req.user and
 * req.header() are read, so the rest of the surface is left undefined.
 */
function makeReq(opts: { roles?: string[]; reasonHeader?: string }): Request {
  const headers: Record<string, string | undefined> = {};
  if (opts.reasonHeader !== undefined) {
    headers[OVERRIDE_REASON_HEADER] = opts.reasonHeader;
  }
  return {
    user: opts.roles
      ? { id: 'u', username: 'u', roles: opts.roles, permissions: [] }
      : undefined,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

describe('extractOperatorOverride', () => {
  it('returns the override when role + non-empty reason are present', () => {
    const result = extractOperatorOverride(
      makeReq({ roles: [GOVERNANCE_OVERRIDE_ROLE], reasonHeader: 'fixing typo' }),
    );
    expect(result).toEqual({ permitted: true, reason: 'fixing typo' });
  });

  it('trims whitespace from the reason', () => {
    const result = extractOperatorOverride(
      makeReq({ roles: [GOVERNANCE_OVERRIDE_ROLE], reasonHeader: '  ticket 12345  ' }),
    );
    expect(result).toEqual({ permitted: true, reason: 'ticket 12345' });
  });

  it('returns undefined when req.user is missing entirely', () => {
    const result = extractOperatorOverride(makeReq({ reasonHeader: 'r' }));
    expect(result).toBeUndefined();
  });

  it('returns undefined when role is not granted (silent drop)', () => {
    const result = extractOperatorOverride(
      makeReq({ roles: ['admin'], reasonHeader: 'r' }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when role is present but reason header is missing', () => {
    const result = extractOperatorOverride(
      makeReq({ roles: [GOVERNANCE_OVERRIDE_ROLE] }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when reason header is empty string', () => {
    const result = extractOperatorOverride(
      makeReq({ roles: [GOVERNANCE_OVERRIDE_ROLE], reasonHeader: '' }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when reason is only whitespace (trims to empty)', () => {
    const result = extractOperatorOverride(
      makeReq({ roles: [GOVERNANCE_OVERRIDE_ROLE], reasonHeader: '     ' }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when reason exceeds 500 chars', () => {
    const longReason = 'x'.repeat(501);
    const result = extractOperatorOverride(
      makeReq({ roles: [GOVERNANCE_OVERRIDE_ROLE], reasonHeader: longReason }),
    );
    expect(result).toBeUndefined();
  });

  it('accepts a reason of exactly 500 chars', () => {
    const reason = 'x'.repeat(500);
    const result = extractOperatorOverride(
      makeReq({ roles: [GOVERNANCE_OVERRIDE_ROLE], reasonHeader: reason }),
    );
    expect(result).toEqual({ permitted: true, reason });
  });

  it('accepts the role even when other roles are present', () => {
    const result = extractOperatorOverride(
      makeReq({
        roles: ['admin', GOVERNANCE_OVERRIDE_ROLE, 'user'],
        reasonHeader: 'multi-role caller',
      }),
    );
    expect(result).toEqual({ permitted: true, reason: 'multi-role caller' });
  });
});
