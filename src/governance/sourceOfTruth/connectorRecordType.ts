import type { CanonicalEntity, SourceSystem } from './SourceOfTruthManifest';

/**
 * Maps (canonical entity, target system) → connector recordType — the
 * lineage form the connector emits. Per PR 13's Copilot R3 finding,
 * detectLoop queries lineage with the connector recordType, not the
 * canonical entity. Default: snake_case canonical → CamelCase recordType.
 * Override per (entity, system) when a connector uses a non-standard name.
 */
const OVERRIDES: Readonly<Record<string, string>> = {
  // Add 'entity:target_system' → 'CamelCaseRecordType' entries here as needed.
};

export function connectorRecordTypeFor(entity: CanonicalEntity, target: SourceSystem): string {
  const key = `${entity}:${target}`;
  if (OVERRIDES[key]) return OVERRIDES[key];
  return entity.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}
