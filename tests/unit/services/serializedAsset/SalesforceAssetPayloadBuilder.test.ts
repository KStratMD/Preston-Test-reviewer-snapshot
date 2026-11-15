import { SalesforceAssetPayloadBuilder } from '../../../../src/services/serializedAsset/SalesforceAssetPayloadBuilder';
import type { ReadySerializedAssetProfileConfig, SerializedUnit } from '../../../../src/types/serializedAsset';

/**
 * Task 4 (2026-07-27 NetSuite serialized-asset sync plan). Pure Asset
 * payload construction — no I/O, no mutation (`IConnector.upsert` issues the
 * write in Task 7).
 */
describe('SalesforceAssetPayloadBuilder', () => {
  const BASE_UNIT: SerializedUnit = {
    tenantId: 'tenant-1',
    configurationId: 'cfg-1',
    inventoryNumberId: 'INV-001',
    serialNumber: 'SN-SECRET-1',
    itemId: 'ITEM-1',
  };

  const BASE_PROFILE: ReadySerializedAssetProfileConfig = {
    executionProfile: 'netsuite_serialized_asset',
    productExternalIdField: 'NetSuite_Item_Id__c',
    assetExternalIdField: 'NetSuite_Inventory_Number_Id__c',
    serialNumberTargetField: 'SerialNumber',
    productReferenceTargetField: 'Product2Id',
  };

  it('builds the exact required Asset payload shape', () => {
    const payload = SalesforceAssetPayloadBuilder.build(BASE_UNIT, '01t000000000001AAA', BASE_PROFILE);

    expect(payload).toEqual({
      NetSuite_Inventory_Number_Id__c: 'INV-001',
      SerialNumber: 'SN-SECRET-1',
      Product2Id: '01t000000000001AAA',
    });
  });

  it('includes statusTargetField only when both configured and present on the unit', () => {
    const unitWithStatus: SerializedUnit = { ...BASE_UNIT, status: 'in_stock' };
    const profileWithStatus: ReadySerializedAssetProfileConfig = {
      ...BASE_PROFILE,
      statusTargetField: 'Status__c',
    };

    const payload = SalesforceAssetPayloadBuilder.build(unitWithStatus, 'P2ID', profileWithStatus);

    expect(payload).toEqual({
      NetSuite_Inventory_Number_Id__c: 'INV-001',
      SerialNumber: 'SN-SECRET-1',
      Product2Id: 'P2ID',
      Status__c: 'in_stock',
    });
  });

  it('omits statusTargetField when configured but absent on the unit', () => {
    const profileWithStatus: ReadySerializedAssetProfileConfig = {
      ...BASE_PROFILE,
      statusTargetField: 'Status__c',
    };

    const payload = SalesforceAssetPayloadBuilder.build(BASE_UNIT, 'P2ID', profileWithStatus);

    expect(payload).not.toHaveProperty('Status__c');
  });

  it('includes locationTargetField only when both configured and present on the unit', () => {
    const unitWithLocation: SerializedUnit = { ...BASE_UNIT, location: 'WH-1' };
    const profileWithLocation: ReadySerializedAssetProfileConfig = {
      ...BASE_PROFILE,
      locationTargetField: 'Location__c',
    };

    const payload = SalesforceAssetPayloadBuilder.build(unitWithLocation, 'P2ID', profileWithLocation);

    expect(payload).toEqual({
      NetSuite_Inventory_Number_Id__c: 'INV-001',
      SerialNumber: 'SN-SECRET-1',
      Product2Id: 'P2ID',
      Location__c: 'WH-1',
    });
  });

  it('omits locationTargetField when configured but absent on the unit', () => {
    const profileWithLocation: ReadySerializedAssetProfileConfig = {
      ...BASE_PROFILE,
      locationTargetField: 'Location__c',
    };

    const payload = SalesforceAssetPayloadBuilder.build(BASE_UNIT, 'P2ID', profileWithLocation);

    expect(payload).not.toHaveProperty('Location__c');
  });

  it('includes both optional fields together when both are configured and present', () => {
    const unit: SerializedUnit = { ...BASE_UNIT, status: 'in_stock', location: 'WH-1' };
    const profile: ReadySerializedAssetProfileConfig = {
      ...BASE_PROFILE,
      statusTargetField: 'Status__c',
      locationTargetField: 'Location__c',
    };

    const payload = SalesforceAssetPayloadBuilder.build(unit, 'P2ID', profile);

    expect(payload).toEqual({
      NetSuite_Inventory_Number_Id__c: 'INV-001',
      SerialNumber: 'SN-SECRET-1',
      Product2Id: 'P2ID',
      Status__c: 'in_stock',
      Location__c: 'WH-1',
    });
  });

  it('never embeds the serial number in a thrown error (pure function, does not throw)', () => {
    expect(() => SalesforceAssetPayloadBuilder.build(BASE_UNIT, 'P2ID', BASE_PROFILE)).not.toThrow();
  });
});
