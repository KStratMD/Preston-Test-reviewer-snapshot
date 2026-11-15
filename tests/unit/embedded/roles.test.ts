/**
 * The host asserts roles in the bootstrap request body. Those roles are
 * persisted to `embedded_sessions.user_roles`, and
 * `src/routes/governance/_governanceAuth.ts` reads that column in
 * `hasApproverRole` / `hasAdminRole` to gate the approval and operations
 * endpoints. A host asserting `admin` therefore granted itself approval
 * authority — measured 2026-09-03 against the unfixed bootstrap: HTTP 200,
 * `user_roles` persisted as `["admin","approver"]`, both predicates true.
 *
 * This module is the split: a host may assert only what identifies a user to
 * the UI, never what authorizes one. Privileged roles come from a grant.
 */
import { splitAssertedRoles, HOST_ASSERTABLE_ROLES, PRIVILEGED_ROLES } from '../../../src/embedded/roles';

describe('splitAssertedRoles', () => {
  it('accepts only viewer and requester', () => {
    expect([...HOST_ASSERTABLE_ROLES]).toEqual(['viewer', 'requester']);
    expect(splitAssertedRoles(['viewer', 'requester'])).toEqual({
      accepted: ['viewer', 'requester'],
      stripped: [],
    });
  });

  it('strips approver and admin and reports them', () => {
    expect(splitAssertedRoles(['requester', 'approver', 'admin'])).toEqual({
      accepted: ['requester'],
      stripped: ['approver', 'admin'],
    });
    expect(PRIVILEGED_ROLES.has('approver')).toBe(true);
    expect(PRIVILEGED_ROLES.has('admin')).toBe(true);
  });

  it('drops unknown or non-string entries without throwing', () => {
    expect(splitAssertedRoles(['viewer', 42, 'superuser', null])).toEqual({
      accepted: ['viewer'],
      stripped: ['superuser'],
    });
    expect(splitAssertedRoles(undefined)).toEqual({ accepted: [], stripped: [] });
    expect(splitAssertedRoles(null)).toEqual({ accepted: [], stripped: [] });
    expect(splitAssertedRoles('approver')).toEqual({ accepted: [], stripped: [] });
    expect(splitAssertedRoles({ roles: ['admin'] })).toEqual({ accepted: [], stripped: [] });
  });

  it('reports every privileged role the host asserted, so the audit is complete', () => {
    // Duplicates are preserved rather than deduped: the audit records what the
    // host actually sent, not a normalised view of it.
    expect(splitAssertedRoles(['admin', 'admin'])).toEqual({
      accepted: [],
      stripped: ['admin', 'admin'],
    });
  });

  it('dedupes accepted roles, because they are a set and they get persisted', () => {
    // A host can send thousands of 'viewer' entries inside a 10 MB body. Every
    // duplicate would otherwise be written to embedded_sessions.user_roles and
    // echoed back on every context fetch.
    const many = Array.from({ length: 5000 }, () => 'viewer');
    expect(splitAssertedRoles(many).accepted).toEqual(['viewer']);
    expect(splitAssertedRoles(['viewer', 'requester', 'viewer'])).toEqual({
      accepted: ['viewer', 'requester'],
      stripped: [],
    });
  });

  it('every privileged role is rejected by the accept set, with no overlap', () => {
    for (const role of PRIVILEGED_ROLES) {
      expect(HOST_ASSERTABLE_ROLES.has(role)).toBe(false);
      expect(splitAssertedRoles([role]).accepted).toEqual([]);
    }
  });
});
