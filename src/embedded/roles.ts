/**
 * The trust split for roles an embedded host asserts about its user.
 *
 * The host-bootstrap request body carries `userRoles`, and those roles are
 * persisted to `embedded_sessions.user_roles`. `src/routes/governance/
 * _governanceAuth.ts` reads that column in `hasApproverRole` and
 * `hasAdminRole`, which gate the approval and operations endpoints. So a role
 * the host asserts is not a display hint — it is an authorization decision,
 * and before this module a host asserting `admin` granted itself approval
 * authority over its own tenant's queue.
 *
 * The split: a host may assert what *identifies* a user, never what
 * *authorizes* one. `viewer` and `requester` say who is looking; `approver`
 * and `admin` say who may act, and those come from an `embedded_role_grants`
 * row issued by a Squire operator, never from the request body.
 *
 * Stripped roles are returned rather than silently dropped so the caller can
 * audit them: a host repeatedly asserting `admin` is a signal worth keeping,
 * whether it is a misconfigured integration or an attempt.
 */

/** Roles a host may assert about its own user. Identity, not authority. */
export const HOST_ASSERTABLE_ROLES: ReadonlySet<string> = new Set(['viewer', 'requester']);

/** Roles that confer authority and must come from a grant, never the body. */
export const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(['approver', 'admin']);

/**
 * Partition host-asserted roles into those that may be honoured and those
 * that were refused.
 *
 * Non-array input yields two empty arrays rather than throwing: the field is
 * optional in the bootstrap contract and a malformed one must not fail a
 * handshake that is otherwise valid. Non-string entries are dropped entirely
 * — they are neither honoured nor reportable as a role name. Duplicates are
 * preserved in `stripped` so the audit records what the host actually sent.
 */
export function splitAssertedRoles(input: unknown): { accepted: string[]; stripped: string[] } {
  // Accepted roles are a SET and get persisted, so they are deduped: a host can
  // send thousands of "viewer" entries in a 10 MB body, and every duplicate
  // would otherwise be written to embedded_sessions.user_roles and echoed back
  // on every context fetch. Deduping also bounds the column, because the
  // accepted set has only two possible members.
  //
  // Stripped roles are NOT deduped. They are only ever counted and sampled for
  // a log line, never stored, and the audit should reflect what the host
  // actually sent — a host asserting 'admin' fifty times is a different signal
  // from one asserting it once.
  const acceptedSet = new Set<string>();
  const stripped: string[] = [];
  if (!Array.isArray(input)) return { accepted: [], stripped };
  for (const role of input) {
    if (typeof role !== 'string') continue;
    if (HOST_ASSERTABLE_ROLES.has(role)) acceptedSet.add(role);
    else stripped.push(role);
  }
  return { accepted: [...acceptedSet], stripped };
}
