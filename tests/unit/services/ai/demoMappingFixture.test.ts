import { buildRuleBasedDemoMappings } from '../../../../src/services/ai/demoMappingFixture';

describe('buildRuleBasedDemoMappings', () => {
  it('matches normalized names without learned state or services', () => {
    const mappings = buildRuleBasedDemoMappings(
      [{ name: 'company_name' }, { name: 'phone' }],
      [{ name: 'companyname' }, { name: 'phone' }],
    );

    expect(mappings).toEqual([
      expect.objectContaining({ sourceField: 'company_name', targetField: 'companyname', confidence: 0.6 }),
      expect.objectContaining({ sourceField: 'phone', targetField: 'phone', confidence: 0.6 }),
    ]);
  });

  it('does not match blank normalized names', () => {
    expect(buildRuleBasedDemoMappings([{ name: '---' }], [{ name: '___' }])).toEqual([]);
  });
});
