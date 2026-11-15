import { matchesSerializedAssetAdvisoryPair } from '../../../../src/services/serializedAsset/SerializedAssetProfileValidator';

/**
 * Task 10 (advisory AI profile recommendations, 2026-07-27 NetSuite
 * serialized-asset sync plan). `matchesSerializedAssetAdvisoryPair` is the
 * single source of truth `FieldMappingAgent.buildExecutionProfileRecommendation`
 * uses to decide whether to surface the `netsuite_serialized_asset` ADVISORY
 * recommendation — it must exactly mirror `evaluateSerializedAssetProfile`'s
 * own system/entity contract so the advisory surface can never recommend a
 * pair the activation-time gate would itself refuse.
 */
describe('matchesSerializedAssetAdvisoryPair', () => {
  it('matches the exact supported pair', () => {
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'netsuite',
        targetSystem: 'salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
      }),
    ).toBe(true);
  });

  it('normalizes casing on both systems and both entities', () => {
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        sourceEntity: 'InventoryNumber',
        targetEntity: 'ASSET',
      }),
    ).toBe(true);
  });

  it('trims incidental whitespace on entity identifiers', () => {
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'netsuite',
        targetSystem: 'salesforce',
        sourceEntity: '  inventorynumber  ',
        targetEntity: ' Asset ',
      }),
    ).toBe(true);
  });

  it('rejects an unsupported source system', () => {
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'hubspot',
        targetSystem: 'salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
      }),
    ).toBe(false);
  });

  it('rejects an unsupported target system', () => {
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'netsuite',
        targetSystem: 'businesscentral',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
      }),
    ).toBe(false);
  });

  it('rejects a source entity other than inventorynumber', () => {
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'netsuite',
        targetSystem: 'salesforce',
        sourceEntity: 'salesorder',
        targetEntity: 'Asset',
      }),
    ).toBe(false);
  });

  it('rejects a target entity other than Asset', () => {
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'netsuite',
        targetSystem: 'salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Contact',
      }),
    ).toBe(false);
  });

  it('never throws on an unrecognized system alias and simply reports no match', () => {
    expect(() =>
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'totally-unknown-system',
        targetSystem: 'salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
      }),
    ).not.toThrow();
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'totally-unknown-system',
        targetSystem: 'salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
      }),
    ).toBe(false);
  });

  it('rejects non-string entity/system fields defensively even though the type declares string', () => {
    expect(
      matchesSerializedAssetAdvisoryPair({
        sourceSystem: 'netsuite',
        targetSystem: 'salesforce',
        sourceEntity: undefined as unknown as string,
        targetEntity: 'Asset',
      }),
    ).toBe(false);
  });
});
