/**
 * Codex round 8 on PR #1253 (finding 3): IntegrationConfigSchema validated each
 * field mapping alone, so an ACTIVE configuration with a declared-only
 * transformation ('split') or two lodash spellings of one target validated.
 * The set is validated for an active configuration now. An inactive one is a
 * draft and keeps its draft freedom — duplicate targets and declared-only
 * types are allowed until activation, as configurationSchemas.cardinality.test.ts
 * has always pinned.
 */
import { IntegrationConfigSchema } from '../../../src/schemas/configurationSchemas';

type ConfigInput = Record<string, unknown>;
function baseConfig(overrides: ConfigInput = {}): ConfigInput {
  return {
    id: 'cfg-1',
    tenantId: 'tenant-a',
    name: 'Set validation',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Contact',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [],
    sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'k' } },
    ...overrides,
  };
}
const split = { sourceField: 'name', targetField: 'parts', transformationType: 'split', isRequired: false, transformationConfig: { type: 'split', separator: ' ' } };
const direct = (s: string, t: string) => ({ sourceField: s, targetField: t, transformationType: 'direct', isRequired: false });
const issuesOf = (input: ConfigInput) => {
  const r = IntegrationConfigSchema.safeParse(input);
  return r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
};

describe('IntegrationConfigSchema validates the mapping SET of an active configuration', () => {
  it('rejects an ACTIVE configuration carrying a declared-only transformation', () => {
    expect(issuesOf(baseConfig({ fieldMappings: [split] }))).toMatch(/fieldMappings: .*split.*declared but not executable/);
  });

  it('rejects two lodash spellings of one target slot when active', () => {
    expect(issuesOf(baseConfig({ fieldMappings: [direct('a', 'x.y'), direct('b', 'x[y]')] }))).toMatch(/fieldMappings: .*same slot/);
  });

  it('keeps draft freedom: the same sets validate while the configuration is INACTIVE', () => {
    expect(issuesOf(baseConfig({ isActive: false, fieldMappings: [split] }))).not.toMatch(/fieldMappings/);
    expect(issuesOf(baseConfig({ isActive: false, fieldMappings: [direct('a', 'x.y'), direct('b', 'x[y]')] }))).not.toMatch(/fieldMappings/);
  });

  it('accepts an executable, collision-free active set', () => {
    expect(issuesOf(baseConfig({ fieldMappings: [direct('a', 'x.y'), direct('b', 'x.z')] }))).toBe('');
  });
});
