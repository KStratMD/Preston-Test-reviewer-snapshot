/**
 * Route-layer alias for the strict verified-identity helpers.
 *
 * The implementation lives at src/services/governance/verifiedIdentity.ts —
 * beside the `extractIdentityContext` contract it deliberately opposes, and
 * outside routes/ so service-layer callers can import it without a
 * services -> routes dependency edge. This module exists so route handlers keep
 * importing identity narrowing from a route-local path; it adds no behavior.
 */
export type { VerifiedIdentity } from '../../services/governance/verifiedIdentity';
export {
  verifiedUserId,
  verifiedTenantId,
  verifiedIdentity,
} from '../../services/governance/verifiedIdentity';
