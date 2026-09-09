import type { ReadySerializedAssetProfileConfig, SerializedUnit } from '../../types/serializedAsset';

/**
 * Pure Asset payload construction (Task 4, 2026-07-27 NetSuite
 * serialized-asset sync plan). No I/O, no persistence, no logging, and no
 * mutation — `IConnector.upsert` issues the write in Task 7, which calls
 * this builder's output directly as the write's `data` argument. Optional
 * `statusTargetField`/`locationTargetField` are included only when BOTH the
 * profile configures the target field AND the unit carries a defined value
 * for it — matching Task 1's "exactly-one-mapping-when-configured" rule, so
 * this builder never introduces a field the activation-readiness gate did
 * not already validate.
 */
export class SalesforceAssetPayloadBuilder {
  static build(
    unit: SerializedUnit,
    product2Id: string,
    profile: ReadySerializedAssetProfileConfig,
  ): Record<string, unknown> {
    return {
      [profile.assetExternalIdField]: unit.inventoryNumberId,
      SerialNumber: unit.serialNumber,
      Product2Id: product2Id,
      ...(profile.statusTargetField && unit.status !== undefined
        ? { [profile.statusTargetField]: unit.status }
        : {}),
      ...(profile.locationTargetField && unit.location !== undefined
        ? { [profile.locationTargetField]: unit.location }
        : {}),
    };
  }
}
