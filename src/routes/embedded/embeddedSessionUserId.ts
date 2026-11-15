import { SYSTEM_IDENTITY } from '../../services/governance/identityContext';

/**
 * Sentinel `user_id` persisted to an embedded session when the host-bootstrap
 * caller does not supply a real operator userId (see `hostBootstrapRouter.ts`:
 * `userId = typeof body.userId === 'string' ? body.userId : EMBEDDED_ANONYMOUS_USER_ID`).
 *
 * Defined in its own dependency-light module so both `hostBootstrapRouter` (the
 * producer) and the embedded operator routers (the consumers) share one source
 * of truth without importing each other's heavier dependency graphs.
 */
export const EMBEDDED_ANONYMOUS_USER_ID = '__embedded_anonymous__';

/**
 * Synthetic / non-real operator user_ids that an embedded write path which
 * attributes an action to the session user (e.g. reconciliation resolve writing
 * `resolved_by`) MUST reject (fail closed) so the audit trail never records a
 * placeholder as a real operator. `hostBootstrapRouter` persists ANY string
 * `body.userId` verbatim (including the empty string), so a misconfigured host
 * can land any of these in the session — not just the embedded-anonymous
 * default. Full parity with the Bearer route's `SYNTHETIC_OPERATOR_USER_IDS`
 * (`SYSTEM_IDENTITY.userId` + `'unknown'`), plus the embedded host-bootstrap sentinel.
 */
export const SYNTHETIC_EMBEDDED_OPERATOR_USER_IDS: ReadonlySet<string> = new Set([
  EMBEDDED_ANONYMOUS_USER_ID,
  SYSTEM_IDENTITY.userId,
  'unknown',
]);
