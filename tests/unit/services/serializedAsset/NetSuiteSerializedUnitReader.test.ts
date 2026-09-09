import {
  isReaderResolvableSourceField,
  normalizeBatch,
  type SerializedAssetFailure,
} from '../../../../src/services/serializedAsset/NetSuiteSerializedUnitReader';
import type { DataRecord, FieldMapping, IntegrationConfig } from '../../../../src/types';
import type { SerializedAssetProfileDraftConfig } from '../../../../src/types/serializedAsset';

/**
 * Task 3 (2026-07-27 NetSuite serialized-asset sync plan). Covers the reader
 * contract from the task brief: valid string/numeric IDs, missing values,
 * structured values, hostile keys, optional status/location, context
 * mismatch, and the privacy assertions (decision 8 — a serial number may
 * only ever appear on a successful `SerializedUnit`, never in a failure, a
 * hash, or a thrown message).
 */

const BASE_CONTEXT = { tenantId: 'tenant-1', configurationId: 'cfg-1' };

function fieldMapping(sourceField: string, targetField: string): FieldMapping {
  return { sourceField, targetField, transformationType: 'direct', isRequired: true };
}

function makeConfig(
  overrides: Partial<IntegrationConfig> = {},
  profileOverrides: Partial<SerializedAssetProfileDraftConfig> = {},
): IntegrationConfig {
  const executionProfileConfig: SerializedAssetProfileDraftConfig = {
    executionProfile: 'netsuite_serialized_asset',
    productExternalIdField: 'NetSuite_Item_Id__c',
    assetExternalIdField: 'NetSuite_Inventory_Number_Id__c',
    serialNumberTargetField: 'SerialNumber',
    productReferenceTargetField: 'Product2Id',
    ...profileOverrides,
  };

  const fieldMappings: FieldMapping[] = [
    fieldMapping('id', executionProfileConfig.assetExternalIdField as string),
    fieldMapping('inventorynumber', executionProfileConfig.serialNumberTargetField as string),
    fieldMapping('item.id', executionProfileConfig.productReferenceTargetField as string),
  ];
  if (executionProfileConfig.statusTargetField !== undefined) {
    fieldMappings.push(fieldMapping('status', executionProfileConfig.statusTargetField));
  }
  if (executionProfileConfig.locationTargetField !== undefined) {
    fieldMappings.push(fieldMapping('location.id', executionProfileConfig.locationTargetField));
  }

  return {
    id: 'cfg-1',
    tenantId: 'tenant-1',
    name: 'NetSuite Serialized Asset Sync',
    sourceSystem: 'netsuite',
    targetSystem: 'salesforce',
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings,
    transformationRules: [],
    executionProfile: 'netsuite_serialized_asset',
    executionProfileConfig,
    ...overrides,
  };
}

function record(id: string, fields: Record<string, unknown>): DataRecord {
  return { id, externalId: '', fields, metadata: {} };
}

function findFailure(invalid: SerializedAssetFailure[], recordIndex: number): SerializedAssetFailure | undefined {
  return invalid.find((failure) => failure.recordIndex === recordIndex);
}

describe('NetSuiteSerializedUnitReader.normalizeBatch', () => {
  describe('valid values', () => {
    it('normalizes string-valued required fields into a SerializedUnit', () => {
      const config = makeConfig();
      const records = [record('inv-1', { inventorynumber: 'SN-100', item: { id: '456', refName: 'Widget' } })];

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([]);
      expect(units).toEqual([
        {
          tenantId: 'tenant-1',
          configurationId: 'cfg-1',
          inventoryNumberId: 'inv-1',
          serialNumber: 'SN-100',
          itemId: '456',
        },
      ]);
    });

    it('converts finite numeric source values to strings via String(value)', () => {
      const config = makeConfig();
      const records = [record('inv-2', { inventorynumber: 100200, item: { id: 456 } })];

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([]);
      expect(units[0].serialNumber).toBe('100200');
      expect(units[0].itemId).toBe('456');
    });
  });

  describe('missing values', () => {
    it('reports a record missing a required source field as missing_required_field, producing no unit', () => {
      const config = makeConfig();
      const records = [record('inv-3', { item: { id: '456' } })]; // no inventorynumber field

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(units).toEqual([]);
      expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'missing_required_field' }]);
    });

    it('reports an empty-string required source value as missing_required_field', () => {
      const config = makeConfig();
      const records = [record('inv-3b', { inventorynumber: '', item: { id: '456' } })];

      const { invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'missing_required_field' }]);
    });

    describe('whitespace-only scalars (never coerced to "valid")', () => {
      it('rejects a spaces-only inventoryNumberId (assetExternalIdField source) as missing_required_field', () => {
        const config = makeConfig();
        const records = [record('   ', { inventorynumber: 'SN-WS-1', item: { id: '456' } })];

        const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

        expect(units).toEqual([]);
        expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'missing_required_field' }]);
      });

      it('rejects a whitespace-only (spaces) serialNumber as missing_required_field', () => {
        const config = makeConfig();
        const records = [record('inv-ws-2', { inventorynumber: '   ', item: { id: '456' } })];

        const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

        expect(units).toEqual([]);
        expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'missing_required_field' }]);
      });

      it('rejects a tab-only itemId as missing_required_field', () => {
        const config = makeConfig();
        const records = [record('inv-ws-3', { inventorynumber: 'SN-WS-3', item: { id: '\t' } })];

        const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

        expect(units).toEqual([]);
        expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'missing_required_field' }]);
      });

      it('rejects a mixed-whitespace (spaces + tabs + newline) required value as missing_required_field, never producing a garbage unit', () => {
        // Reviewer probe: a record where every required source resolves to a
        // whitespace-only value must never yield a "valid" unit — inventoryNumberId
        // in particular becomes both the Salesforce upsert external-ID key
        // (decision 4) and the deferred-work uniqueness key (decision 9), so a
        // blank-ish value must never look valid.
        const records = [
          record(' \t \n ', { inventorynumber: '  \t  ', item: { id: '\t \n' } }),
        ];
        const config = makeConfig();

        const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

        expect(units).toEqual([]);
        expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'missing_required_field' }]);
      });

      it('trims an accepted string value rather than storing incidental leading/trailing whitespace', () => {
        const config = makeConfig();
        const records = [record('  inv-trim  ', { inventorynumber: '  SN-TRIM  ', item: { id: '  456  ' } })];

        const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

        expect(invalid).toEqual([]);
        expect(units).toEqual([
          {
            tenantId: 'tenant-1',
            configurationId: 'cfg-1',
            inventoryNumberId: 'inv-trim',
            serialNumber: 'SN-TRIM',
            itemId: '456',
          },
        ]);
      });
    });
  });

  describe('structured values', () => {
    it('reports an object-valued required field as invalid_scalar_value', () => {
      const config = makeConfig();
      const records = [record('inv-4', { inventorynumber: { nested: true }, item: { id: '456' } })];

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(units).toEqual([]);
      expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'invalid_scalar_value' }]);
    });

    it('reports an array-valued required field as invalid_scalar_value', () => {
      const config = makeConfig();
      const records = [record('inv-4b', { inventorynumber: ['SN-1', 'SN-2'], item: { id: '456' } })];

      const { invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'invalid_scalar_value' }]);
    });

    it('reports a non-finite numeric required value as invalid_scalar_value', () => {
      const config = makeConfig();
      const records = [record('inv-4c', { inventorynumber: Number.NaN, item: { id: '456' } })];

      const { invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'invalid_scalar_value' }]);
    });

    it('reports a boolean-valued required field as invalid_scalar_value', () => {
      const config = makeConfig();
      const records = [record('inv-4d', { inventorynumber: true, item: { id: '456' } })];

      const { invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'invalid_scalar_value' }]);
    });
  });

  describe('hostile keys', () => {
    // A dangerous segment can no longer even REACH `resolveSourceValue`: the
    // profile gate (`requireReadySerializedAssetProfile`, which normalizeBatch
    // runs first) now applies `isReaderResolvableSourceField`, so such a
    // config is refused outright rather than degrading to per-record
    // `missing_required_field`. That is the stronger guarantee — nothing is
    // attempted at all — and it is what these cases now assert. The
    // segment-level guard inside `ownProperty` remains as defense-in-depth
    // and is covered directly by the `isReaderResolvableSourceField` block
    // below.
    it.each(['__proto__', 'constructor', 'prototype'])(
      'refuses the whole batch when a sourceField names the dangerous segment %s',
      (dangerousKey) => {
        const hostileFields = JSON.parse(`{"${dangerousKey}": "999", "inventorynumber": "SN-5", "item": {"id": "456"}}`) as Record<
          string,
          unknown
        >;
        const config = makeConfig({
          fieldMappings: [
            fieldMapping(dangerousKey, 'NetSuite_Inventory_Number_Id__c'),
            fieldMapping('inventorynumber', 'SerialNumber'),
            fieldMapping('item.id', 'Product2Id'),
          ],
        });
        const records = [record('inv-6b', hostileFields)];

        expect(() => normalizeBatch(records, config, BASE_CONTEXT)).toThrow(
          /sourceField for assetExternalIdField must be a non-empty scalar path the reader can resolve/,
        );
      },
    );

    it('never resolves an inherited (prototype-chain) property, only own properties', () => {
      // 'toString' is never an own property of a plain object literal — it is
      // only reachable via Object.prototype, so a sourceField naming it must
      // resolve to "missing", never to Object.prototype.toString.
      const config = makeConfig({
        fieldMappings: [
          fieldMapping('id', 'NetSuite_Inventory_Number_Id__c'),
          fieldMapping('inventorynumber', 'SerialNumber'),
          fieldMapping('item.toString', 'Product2Id'),
        ],
      });
      const records = [record('inv-6c', { inventorynumber: 'SN-6', item: {} })];

      const { invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([{ recordIndex: 0, recordHash: expect.any(String), category: 'missing_required_field' }]);
    });
  });

  describe('padded mapping sourceField (configured, not record data)', () => {
    it('trims a whitespace-padded sourceField at resolution time so records still resolve correctly', () => {
      // Task 1's validator only checks sourceField.trim().length > 0 and never
      // rewrites the stored value, so a configured path of ' id ' passes
      // activation as-is. Left untrimmed, this would miss on every record's
      // `fields` lookup and — because failures carry no field name (decision
      // 8) — be silent and effectively undiagnosable in production.
      const config = makeConfig({
        fieldMappings: [
          fieldMapping(' id ', 'NetSuite_Inventory_Number_Id__c'),
          fieldMapping('  inventorynumber  ', 'SerialNumber'),
          fieldMapping('\titem.id\t', 'Product2Id'),
        ],
      });
      const records = [record('inv-padded', { inventorynumber: 'SN-PADDED', item: { id: '456' } })];

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([]);
      expect(units).toEqual([
        {
          tenantId: 'tenant-1',
          configurationId: 'cfg-1',
          inventoryNumberId: 'inv-padded',
          serialNumber: 'SN-PADDED',
          itemId: '456',
        },
      ]);
    });
  });

  describe('optional status/location', () => {
    it('includes status and location when the profile configures those targets and the record provides values', () => {
      const config = makeConfig({}, { statusTargetField: 'Status__c', locationTargetField: 'Location__c' });
      const records = [
        record('inv-7', {
          inventorynumber: 'SN-7',
          item: { id: '456' },
          status: 'On Hand',
          location: { id: '99', refName: 'Warehouse A' },
        }),
      ];

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([]);
      expect(units[0].status).toBe('On Hand');
      expect(units[0].location).toBe('99');
    });

    it('omits status and location entirely when the profile does not configure them, even if the record carries such fields', () => {
      const config = makeConfig();
      const records = [
        record('inv-8', {
          inventorynumber: 'SN-8',
          item: { id: '456' },
          status: 'On Hand',
          location: { id: '99' },
        }),
      ];

      const { units } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(units[0].status).toBeUndefined();
      expect(units[0].location).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(units[0], 'status')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(units[0], 'location')).toBe(false);
    });

    it('leaves an optional field undefined (without failing the record) when configured but absent on the record', () => {
      const config = makeConfig({}, { statusTargetField: 'Status__c' });
      const records = [record('inv-9', { inventorynumber: 'SN-9', item: { id: '456' } })];

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([]);
      expect(units[0].status).toBeUndefined();
    });
  });

  describe('batch grain and multiple records', () => {
    it('produces exactly one unit or one failure per record, preserving record index', () => {
      const config = makeConfig();
      const records = [
        record('inv-ok', { inventorynumber: 'SN-OK', item: { id: '456' } }),
        record('inv-bad', { item: { id: '456' } }), // missing inventorynumber
        record('inv-ok-2', { inventorynumber: 'SN-OK-2', item: { id: '789' } }),
      ];

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(units).toHaveLength(2);
      expect(invalid).toHaveLength(1);
      expect(findFailure(invalid, 1)).toEqual({
        recordIndex: 1,
        recordHash: expect.any(String),
        category: 'missing_required_field',
      });
    });
  });

  describe('context mismatch', () => {
    it('throws when context.tenantId disagrees with the configuration tenantId', () => {
      const config = makeConfig();

      expect(() => normalizeBatch([], config, { tenantId: 'other-tenant', configurationId: 'cfg-1' })).toThrow();
    });

    it('throws when context.configurationId disagrees with the configuration id', () => {
      const config = makeConfig();

      expect(() => normalizeBatch([], config, { tenantId: 'tenant-1', configurationId: 'other-cfg' })).toThrow();
    });
  });

  describe('privacy (decision 8 — serial numbers never leak outside SerializedUnit)', () => {
    it('never includes a serial number in a failure entry, even when the record fails on a different field', () => {
      const sensitive = 'SECRET-SERIAL-DO-NOT-LEAK';
      const config = makeConfig();
      // serialNumber resolves fine; itemId is missing, so the record still fails.
      const records = [record('inv-10', { inventorynumber: sensitive })];

      const { invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toHaveLength(1);
      expect(JSON.stringify(invalid)).not.toContain(sensitive);
    });

    it('produces a deterministic opaque SHA-256 hash that never contains the raw field values', () => {
      const sensitive = 'SECRET-SERIAL-VALUE';
      const config = makeConfig();
      const records = [record('inv-11', { inventorynumber: sensitive })];

      const { invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid[0].recordHash).not.toContain(sensitive);
      expect(invalid[0].recordHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('hashes identical records identically and different records differently', () => {
      const config = makeConfig();
      const recordA = record('inv-12', { inventorynumber: 'DUP' });
      const recordB = record('inv-12', { inventorynumber: 'DUP' });
      const recordC = record('inv-13', { inventorynumber: 'OTHER' });

      const first = normalizeBatch([recordA], config, BASE_CONTEXT);
      const second = normalizeBatch([recordB], config, BASE_CONTEXT);
      const third = normalizeBatch([recordC], config, BASE_CONTEXT);

      expect(first.invalid[0].recordHash).toBe(second.invalid[0].recordHash);
      expect(first.invalid[0].recordHash).not.toBe(third.invalid[0].recordHash);
    });

    it('carries the serial number only on the successful SerializedUnit, never restated elsewhere in the result', () => {
      const config = makeConfig();
      const records = [record('inv-14', { inventorynumber: 'SN-VISIBLE', item: { id: '456' } })];

      const { units, invalid } = normalizeBatch(records, config, BASE_CONTEXT);

      expect(invalid).toEqual([]);
      expect(units[0].serialNumber).toBe('SN-VISIBLE');
    });
  });

  /**
   * Task 10 (advisory AI profile recommendations). This predicate is the
   * constraint the recommendation projector (`FieldMappingAgent`) uses to
   * decide which AI-suggested source fields are safe to recommend for the
   * netsuite_serialized_asset profile — see its own doc comment for why
   * dotted reference-piercing paths (`item.id`, `location.id`) are NOT
   * rejected outright even though a divergent AI-side dotted-path
   * convention exists.
   */
  describe('isReaderResolvableSourceField', () => {
    it('accepts single-segment field names', () => {
      expect(isReaderResolvableSourceField('inventorynumber')).toBe(true);
      expect(isReaderResolvableSourceField('id')).toBe(true);
      expect(isReaderResolvableSourceField('externalId')).toBe(true);
    });

    it('accepts legitimate reference-piercing dotted paths', () => {
      expect(isReaderResolvableSourceField('item.id')).toBe(true);
      expect(isReaderResolvableSourceField('location.id')).toBe(true);
    });

    it('rejects non-string, empty, and whitespace-only values', () => {
      expect(isReaderResolvableSourceField(undefined)).toBe(false);
      expect(isReaderResolvableSourceField(null)).toBe(false);
      expect(isReaderResolvableSourceField(42)).toBe(false);
      expect(isReaderResolvableSourceField('')).toBe(false);
      expect(isReaderResolvableSourceField('   ')).toBe(false);
    });

    it('rejects paths with an empty segment (leading/trailing/doubled dot)', () => {
      expect(isReaderResolvableSourceField('.id')).toBe(false);
      expect(isReaderResolvableSourceField('item.')).toBe(false);
      expect(isReaderResolvableSourceField('item..id')).toBe(false);
    });

    it('rejects prototype-pollution segments anywhere in the path (hostile AI output)', () => {
      expect(isReaderResolvableSourceField('__proto__')).toBe(false);
      expect(isReaderResolvableSourceField('prototype')).toBe(false);
      expect(isReaderResolvableSourceField('constructor')).toBe(false);
      expect(isReaderResolvableSourceField('item.__proto__')).toBe(false);
      expect(isReaderResolvableSourceField('__proto__.polluted')).toBe(false);
    });

    it('rejects a path whose first segment is the literal "fields" (AI-layer root-walk convention that always fails this reader)', () => {
      expect(isReaderResolvableSourceField('fields')).toBe(false);
      expect(isReaderResolvableSourceField('fields.inventorynumber')).toBe(false);
      expect(isReaderResolvableSourceField('fields.item.id')).toBe(false);
    });

    it('allows "fields" as a non-first segment (a real nested property happening to be named fields)', () => {
      expect(isReaderResolvableSourceField('item.fields')).toBe(true);
    });

    it('rejects a segment with inner leading/trailing whitespace (exact-key-match lookup can never hit a padded name)', () => {
      expect(isReaderResolvableSourceField('item . id')).toBe(false);
      expect(isReaderResolvableSourceField(' item.id')).toBe(true); // outer whitespace is trimmed on the whole string first
      expect(isReaderResolvableSourceField('item.id ')).toBe(true);
      expect(isReaderResolvableSourceField('item. id')).toBe(false);
    });
  });
});
