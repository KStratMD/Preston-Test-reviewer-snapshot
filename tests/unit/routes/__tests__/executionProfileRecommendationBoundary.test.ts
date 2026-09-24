import {
  buildExecutionProfileHint,
  sanitizeExecutionProfileRecommendation,
} from '../../../../src/routes/ai-proxy/utils/executionProfileRecommendationBoundary';

/**
 * Task 10 hardening (post-review). These are the two boundary functions BOTH
 * `MappingRouter.ts` and `aiMapping.ts` must use — a route must never trust
 * `agentResult.data.executionProfileRecommendation` on shape alone, and must
 * independently re-check the request's own pair against
 * `matchesSerializedAssetAdvisoryPair` before relaying anything.
 */
describe('buildExecutionProfileHint', () => {
  it('builds a hint when all four fields are non-empty strings', () => {
    expect(buildExecutionProfileHint('netsuite', 'salesforce', 'inventorynumber', 'Asset')).toEqual({
      sourceSystem: 'netsuite',
      targetSystem: 'salesforce',
      sourceEntity: 'inventorynumber',
      targetEntity: 'Asset',
    });
  });

  it('returns undefined when either entity is missing (backward-compatible caller)', () => {
    expect(buildExecutionProfileHint('netsuite', 'salesforce', undefined, undefined)).toBeUndefined();
    expect(buildExecutionProfileHint('netsuite', 'salesforce', 'inventorynumber', undefined)).toBeUndefined();
  });

  it('returns undefined for an empty/whitespace-only field', () => {
    expect(buildExecutionProfileHint('netsuite', 'salesforce', '   ', 'Asset')).toBeUndefined();
    expect(buildExecutionProfileHint('', 'salesforce', 'inventorynumber', 'Asset')).toBeUndefined();
  });
});

const VALID_RECOMMENDATION = {
  profile: 'netsuite_serialized_asset',
  advisoryOnly: true,
  sourceEntity: 'inventorynumber',
  targetEntity: 'Asset',
  requiredMappingRoles: ['inventory_number_id', 'serial_number', 'parent_item_id'],
  optionalMappingRoles: ['status', 'location'],
};

const MATCHING_HINT = {
  sourceSystem: 'netsuite',
  targetSystem: 'salesforce',
  sourceEntity: 'inventorynumber',
  targetEntity: 'Asset',
};

describe('sanitizeExecutionProfileRecommendation', () => {
  it('returns the canonical shape for a valid recommendation with a matching hint', () => {
    expect(sanitizeExecutionProfileRecommendation(VALID_RECOMMENDATION, MATCHING_HINT)).toEqual(
      VALID_RECOMMENDATION,
    );
  });

  it('rejects an otherwise-valid recommendation when the hint is undefined (no re-check possible)', () => {
    expect(sanitizeExecutionProfileRecommendation(VALID_RECOMMENDATION, undefined)).toBeUndefined();
  });

  it('rejects an otherwise-valid recommendation when the hint does not match the supported pair (IMPORTANT 1 regression)', () => {
    const unsupportedHint = { ...MATCHING_HINT, targetSystem: 'hubspot' };
    expect(sanitizeExecutionProfileRecommendation(VALID_RECOMMENDATION, unsupportedHint)).toBeUndefined();
  });

  it('rejects extra smuggled properties by rebuilding the canonical object rather than relaying them', () => {
    const polluted = { ...VALID_RECOMMENDATION, activate: true, assetExternalIdField: 'My_Custom__c' };
    const result = sanitizeExecutionProfileRecommendation(polluted, MATCHING_HINT);
    expect(result).toEqual(VALID_RECOMMENDATION);
    expect(result).not.toHaveProperty('activate');
    expect(result).not.toHaveProperty('assetExternalIdField');
  });

  it('rejects an empty requiredMappingRoles array (exact-set check, not subset)', () => {
    const emptyRequired = { ...VALID_RECOMMENDATION, requiredMappingRoles: [] };
    expect(sanitizeExecutionProfileRecommendation(emptyRequired, MATCHING_HINT)).toBeUndefined();
  });

  it('rejects a requiredMappingRoles array missing one of the three required entries', () => {
    const partialRequired = { ...VALID_RECOMMENDATION, requiredMappingRoles: ['inventory_number_id', 'serial_number'] };
    expect(sanitizeExecutionProfileRecommendation(partialRequired, MATCHING_HINT)).toBeUndefined();
  });

  it('rejects a role array containing an out-of-vocabulary entry', () => {
    const polluted = {
      ...VALID_RECOMMENDATION,
      requiredMappingRoles: ['inventory_number_id', 'serial_number', 'parent_item_id', 'custom_field__c'],
    };
    expect(sanitizeExecutionProfileRecommendation(polluted, MATCHING_HINT)).toBeUndefined();
  });

  it('rejects a non-object value', () => {
    expect(sanitizeExecutionProfileRecommendation(undefined, MATCHING_HINT)).toBeUndefined();
    expect(sanitizeExecutionProfileRecommendation('not an object', MATCHING_HINT)).toBeUndefined();
  });

  it('rejects a value with a wrong literal field', () => {
    expect(
      sanitizeExecutionProfileRecommendation({ ...VALID_RECOMMENDATION, advisoryOnly: false }, MATCHING_HINT),
    ).toBeUndefined();
  });
});
