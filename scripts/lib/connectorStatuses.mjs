/**
 * Connector readiness vocabulary, shared by every status-sensitive gate.
 *
 * Mirrored by src/connectors/connectorStatuses.ts for the registry's type. If
 * you add a value here, add it there, and the test at
 * tests/unit/connectors/connectorStatuses.agreement.test.ts asserts the two agree
 * (lists as text, helpers by executing this file).
 *
 * Why this file exists: `production_ready` was introduced as a RELABEL of the
 * five connectors that are readiness-complete but have no live evidence on
 * record. A relabel must not loosen enforcement. Before this module, three
 * gates each carried their own literal list of "statuses that must be gated"
 * (`['production', 'beta']`, `=== 'production'`, ...), and a new value would
 * silently fall outside all of them -- exactly how a relabel escapes DLP
 * gating, the factory requirement and the proof-card requirement at once.
 * Every gate now imports READINESS_GATED_STATUSES instead of restating it.
 */

/** Every value `productionStatus` may take. Order is the reporting order. */
export const CONNECTOR_STATUSES = Object.freeze([
  'production',
  'production_ready',
  'beta',
  'demo_only',
  'stub',
]);

/**
 * Statuses that are readiness-complete and therefore carry every production
 * obligation: outbound DLP gating on write paths, a registered factory, and a
 * proof card. `production` additionally has live evidence on record;
 * `production_ready` explicitly does not (its card's Known Gaps says so).
 */
export const PRODUCTION_TIER_STATUSES = Object.freeze(['production', 'production_ready']);

/**
 * Statuses the outbound-governance (DLP) gate applies to. Beta is gated too:
 * it can reach a real system, so it must not be able to send unscanned data.
 */
export const READINESS_GATED_STATUSES = Object.freeze([...PRODUCTION_TIER_STATUSES, 'beta']);

export function isProductionTier(status) {
  return PRODUCTION_TIER_STATUSES.includes(status);
}

export function isReadinessGated(status) {
  return READINESS_GATED_STATUSES.includes(status);
}
