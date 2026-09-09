/**
 * Connector readiness vocabulary -- the TypeScript mirror of
 * scripts/lib/connectorStatuses.mjs.
 *
 * The .mjs is the one the CI gates import (they run without a TS toolchain);
 * this file gives the registry its type. tests/unit/connectors/connectorStatuses.agreement.test.ts
 * asserts the two lists are identical and the helpers answer alike, so they cannot drift apart silently.
 *
 * `production_ready` is a relabel of connectors that are readiness-complete
 * (governance wiring, rate limiting, DLP, unit and contract suites, docs) but
 * have NO live evidence on record. It is in the production TIER: every gate
 * that applies to `production` applies to it. The only difference between the
 * two is whether a live-credential run is on file.
 */

export const CONNECTOR_STATUSES = ['production', 'production_ready', 'beta', 'demo_only', 'stub'] as const;

export type ProductionStatus = (typeof CONNECTOR_STATUSES)[number];

export const PRODUCTION_TIER_STATUSES = ['production', 'production_ready'] as const satisfies readonly ProductionStatus[];

export const READINESS_GATED_STATUSES = [...PRODUCTION_TIER_STATUSES, 'beta'] as const satisfies readonly ProductionStatus[];

export function isProductionTier(status: ProductionStatus): boolean {
  return (PRODUCTION_TIER_STATUSES as readonly string[]).includes(status);
}

export function isReadinessGated(status: ProductionStatus): boolean {
  return (READINESS_GATED_STATUSES as readonly string[]).includes(status);
}
