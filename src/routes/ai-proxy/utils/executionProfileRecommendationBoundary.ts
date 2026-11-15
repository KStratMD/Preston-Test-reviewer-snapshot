/**
 * Shared route-boundary helpers for the `netsuite_serialized_asset` ADVISORY
 * recommendation (Task 10, 2026-07-27 NetSuite serialized-asset sync plan,
 * decision 10). Both production entry points for `POST /mapping/suggestions`
 * — `MappingRouter.ts` (the ONLY handler authenticated traffic actually
 * reaches, since it fully answers the request itself and never calls
 * `next()`) and `aiMapping.ts` (reached only via `MappingRouter`'s anonymous
 * `next()` delegation, and only ever serves the anonymous demo-fixture path
 * from that point) — import from here so the hint-building and
 * sanitization rule can never drift between the two mount points.
 */
import { matchesSerializedAssetAdvisoryPair } from '../../../services/serializedAsset/SerializedAssetProfileValidator';
import type { ExecutionProfileHint, ExecutionProfileRecommendation } from '../../../services/ai/orchestrator/interfaces';

/** Closed vocabularies `sanitizeExecutionProfileRecommendation`'s role arrays must match EXACTLY (as a set — no fewer, no more, no substitutions). */
const REQUIRED_MAPPING_ROLE_VALUES: ReadonlySet<string> = new Set([
  'inventory_number_id',
  'serial_number',
  'parent_item_id',
]);
const OPTIONAL_MAPPING_ROLE_VALUES: ReadonlySet<string> = new Set(['status', 'location']);

/** True only when `candidateRoles` is a string array whose de-duplicated contents are EXACTLY `allowed` — not a subset, not a superset. */
function isExactRoleSet(candidateRoles: unknown, allowed: ReadonlySet<string>): boolean {
  if (!Array.isArray(candidateRoles) || !candidateRoles.every((role): role is string => typeof role === 'string')) {
    return false;
  }
  const uniqueRoles = new Set(candidateRoles);
  if (uniqueRoles.size !== allowed.size) {
    return false;
  }
  for (const role of uniqueRoles) {
    if (!allowed.has(role)) {
      return false;
    }
  }
  return true;
}

/**
 * Builds the deterministic, model-independent hint for the
 * netsuite_serialized_asset ADVISORY recommendation from caller-declared
 * (never AI-derived) system/entity strings. Returns undefined unless all
 * four are non-empty strings, so an older caller whose request body never
 * carries entity/recordType information (both routes' schemas keep those
 * fields optional for backward compatibility) simply gets no
 * recommendation — never a validation error.
 */
export function buildExecutionProfileHint(
  sourceSystem: string | undefined,
  targetSystem: string | undefined,
  sourceEntity: string | undefined,
  targetEntity: string | undefined,
): ExecutionProfileHint | undefined {
  if (
    typeof sourceSystem !== 'string' || sourceSystem.trim().length === 0 ||
    typeof targetSystem !== 'string' || targetSystem.trim().length === 0 ||
    typeof sourceEntity !== 'string' || sourceEntity.trim().length === 0 ||
    typeof targetEntity !== 'string' || targetEntity.trim().length === 0
  ) {
    return undefined;
  }
  return { sourceSystem, targetSystem, sourceEntity, targetEntity };
}

/**
 * Whitelist reconstruction, never a pass-through (Task 10, decision 10;
 * hardened after review — see `feedback` on the original implementation).
 * `agentResult.data` is loosely typed (`AgentResult<T = any>`), so a route
 * must never forward whatever shape happens to be sitting in
 * `executionProfileRecommendation`. This function discards the WHOLE
 * candidate value — never a partially-sanitized version of it — unless
 * ALL of the following hold:
 *
 *   - `hint` is defined AND independently satisfies
 *     `matchesSerializedAssetAdvisoryPair` — the SAME rule
 *     `FieldMappingAgent` uses, re-checked here so a route can never simply
 *     trust that an agent result asserting a recommendation actually came
 *     from a request for the supported pair. Shape validity alone is not
 *     enough: an agent result can assert a well-formed-looking
 *     recommendation for ANY source/target pair, and only this check stops
 *     that from being relayed.
 *   - the four literal fields (`profile`, `advisoryOnly`, `sourceEntity`,
 *     `targetEntity`) match exactly.
 *   - both role arrays are an EXACT set match against their closed
 *     vocabulary — an empty array, a subset, or a superset (e.g. a
 *     smuggled extra role) is rejected outright, never silently
 *     truncated to whatever overlapped.
 *
 * On success, returns the CANONICAL fixed-shape object (never the
 * candidate's own array ordering/instance), so the two routes' responses
 * are byte-identical for the same hint regardless of what the agent
 * returned.
 */
export function sanitizeExecutionProfileRecommendation(
  value: unknown,
  hint: ExecutionProfileHint | undefined,
): ExecutionProfileRecommendation | undefined {
  if (!hint || !matchesSerializedAssetAdvisoryPair(hint)) {
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.profile !== 'netsuite_serialized_asset') return undefined;
  if (candidate.advisoryOnly !== true) return undefined;
  if (candidate.sourceEntity !== 'inventorynumber') return undefined;
  if (candidate.targetEntity !== 'Asset') return undefined;
  if (!isExactRoleSet(candidate.requiredMappingRoles, REQUIRED_MAPPING_ROLE_VALUES)) return undefined;
  if (!isExactRoleSet(candidate.optionalMappingRoles, OPTIONAL_MAPPING_ROLE_VALUES)) return undefined;

  return {
    profile: 'netsuite_serialized_asset',
    advisoryOnly: true,
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    requiredMappingRoles: ['inventory_number_id', 'serial_number', 'parent_item_id'],
    optionalMappingRoles: ['status', 'location'],
  };
}
