/**
 * Codex on PR #1253 (finding 3): the active configuration validator kept its
 * own, looser FieldMappingSchema (type optional, no per-type rules), so a
 * configuration could validate with a lookup mapping the engine refuses at run
 * time. There is one schema now. This pins both the identity and the behaviour.
 */
import { FieldMappingSchema as ConfigFieldMappingSchema, validateIntegrationConfig } from '../../../src/schemas/configurationSchemas';
import { FieldMappingSchema as CanonicalFieldMappingSchema } from '../../../src/domain/mapping/MappingContract';

const baseConfig = {
  id: 'cfg-1',
  name: 'Canonical mapping check',
  sourceSystem: { type: 'salesforce', connectionId: 'sf-1' },
  targetSystem: { type: 'netsuite', connectionId: 'ns-1' },
  sourceEntity: 'Account',
  targetEntity: 'Customer',
  fieldMappings: [] as unknown[],
  transformationRules: [],
  validationRules: [],
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('configurationSchemas uses the canonical FieldMappingSchema', () => {
  it('is the same object, not a copy', () => {
    expect(ConfigFieldMappingSchema).toBe(CanonicalFieldMappingSchema);
  });

  it('rejects a lookup mapping the engine could not execute (no lookupTable)', () => {
    const result = validateIntegrationConfig({
      ...baseConfig,
      fieldMappings: [{ sourceField: 'code', targetField: 'Code', transformationType: 'lookup', isRequired: false, transformationConfig: { mappings: { A: 'Alpha' } } }],
    });
    expect(result.isValid).toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/lookupTable|type/);
  });

  it('accepts the same mapping once it carries what the engine reads', () => {
    const result = validateIntegrationConfig({
      ...baseConfig,
      fieldMappings: [{ sourceField: 'code', targetField: 'Code', transformationType: 'lookup', isRequired: false, transformationConfig: { type: 'lookup', lookupTable: 'codes', mappings: { A: 'Alpha' } } }],
    });
    expect(JSON.stringify(result.errors)).not.toMatch(/fieldMappings/);
  });
});
