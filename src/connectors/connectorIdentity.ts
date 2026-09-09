/**
 * connectorIdentity — Prerequisite PR A (2026-07-27 NetSuite serialized-asset
 * sync plan). Single shared home for the two system-identity projections that
 * guardedWrite, ConnectorManager, and OwnershipResumeHandler each need and
 * previously computed with divergent (and in one case incorrect) logic:
 *
 *   - getSystemType(system)      — narrows the `string | { type: string }`
 *     SystemConfig union (IntegrationConfig.sourceSystem / .targetSystem)
 *     down to a plain string. Consolidates ConnectorManager's former
 *     module-local helper of the same name and signature.
 *   - connectorKeyForSystem(system) — resolves the CONNECTOR_REGISTRY key
 *     (e.g. 'businesscentral') for a system-type value that may be spelled
 *     either as a connector-registry key already, or as a SourceOfTruth
 *     `SourceSystem` (snake_case manifest vocabulary, e.g. 'business_central').
 *
 * connectorKeyForSystem was added to repair a real contradiction in
 * OwnershipResumeHandler: an IntegrationConfig can store `targetSystem:
 * 'Salesforce'` (arbitrary human/config spelling) while the queued
 * WriteDescriptor.targetSystemId always carries the lowercase connector-
 * registry key ('salesforce') per guardedWrite's contract. Comparing those
 * two forms RAW rejects a perfectly valid pair. This helper normalizes both
 * sides through the same projection so the comparison is meaningful.
 *
 * Fail-closed by design: trims + lowercases the input, then accepts ONLY
 * (a) an exact CONNECTOR_REGISTRY key, or (b) an exact SourceOfTruth
 * `SourceSystem` key (mapped through `SOURCE_SYSTEM_TO_CONNECTOR_KEY`). No
 * punctuation stripping, no fuzzy matching — an unrecognized alias throws
 * rather than silently resolving to something plausible-looking.
 */
import { getConnectorRegistration } from './connectorRegistry';
import {
  SOURCE_SYSTEM_TO_CONNECTOR_KEY,
  isSourceSystem,
  type CallerSystem,
} from '../governance/sourceOfTruth/SourceOfTruthManifest';

/**
 * Narrows the `string | { type: string }` SystemConfig union used by
 * `IntegrationConfig.sourceSystem` / `.targetSystem` down to a plain string.
 * Matches ConnectorManager's former local helper exactly — callers relying
 * on its (deliberately non-null-safe) behavior see no change.
 */
export function getSystemType(system: string | { type: string }): string {
  return typeof system === 'string' ? system : system.type;
}

/**
 * Registry-key aliases for spellings that are neither an exact CONNECTOR_REGISTRY
 * key nor an exact SourceOfTruth `SourceSystem`, but which stored
 * configurations legitimately carry.
 *
 * `dynamics365` is the only member, and it is here for a specific reason. Before
 * PR A2 (deployment-readiness Tranche A), `IntegrationService` projected system
 * types through its OWN private PascalCase map, whose one entry that disagreed
 * with `${raw}.trim().toLowerCase()` was `Dynamics365 -> 'dynamics'` (the
 * registry key is 'dynamics'; the class is `DynamicsConnector`). A2 routed that
 * service's standard execution paths through `ConnectorManager`, which projects
 * through THIS function — so without the alias every Dynamics365 configuration,
 * including a shipped sample (Dynamics365 -> Salesforce), would begin failing
 * closed on a spelling that worked before. That is a regression A2 has no
 * mandate to introduce.
 *
 * The manifest is deliberately NOT the place for it: Dynamics365 is not a
 * `SourceSystem` and has no ownership policy, which is exactly what
 * `IntegrationService.canonicalGating.test.ts` pins.
 *
 * Deliberately a CLOSED table rather than a normalization rule — still no fuzzy
 * matching, still fail-closed for anything unlisted — and consulted LAST, so an
 * alias can never shadow a real registry key or manifest system.
 */
const CONNECTOR_KEY_ALIASES: Record<string, string> = {
  dynamics365: 'dynamics',
};

/**
 * Resolves the CONNECTOR_REGISTRY key for a system-type value that may be
 * spelled as either the registry key itself, the SourceOfTruth manifest's
 * `SourceSystem` vocabulary, or one of the explicit `CONNECTOR_KEY_ALIASES`.
 * Trims + lowercases, then requires an EXACT match against one of those three
 * closed vocabularies — fails closed (throws) on anything else.
 *
 * Precedence: the manifest (`SOURCE_SYSTEM_TO_CONNECTOR_KEY`) is consulted
 * FIRST, the registry SECOND. This matters whenever a value is simultaneously
 * a valid `SourceSystem` AND happens to collide with an unrelated registry
 * key spelled identically but mapping to something else — checking the
 * registry first would silently stamp the wrong connector key and defeat
 * guardedWrite's fail-closed `resume.targetSystemId` check. Every current
 * `SourceSystem` happens to agree between the two orderings (see
 * `connectorIdentity.test.ts`), but the manifest is the authoritative
 * projection guardedWrite/OwnershipResumeHandler need, so it must win.
 */
export function connectorKeyForSystem(system: string | { type: string }): string {
  const raw = getSystemType(system).trim().toLowerCase();
  const candidate = raw as CallerSystem;
  if (isSourceSystem(candidate)) {
    return SOURCE_SYSTEM_TO_CONNECTOR_KEY[candidate];
  }
  if (getConnectorRegistration(raw)) {
    return raw;
  }
  const alias = CONNECTOR_KEY_ALIASES[raw];
  if (alias && getConnectorRegistration(alias)) {
    return alias;
  }
  throw new Error(
    `connectorKeyForSystem: unrecognized system '${raw}' — not a connector-registry key, a SourceOfTruth SourceSystem, or a registered alias`,
  );
}
