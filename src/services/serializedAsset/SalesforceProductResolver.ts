/**
 * Thin adapter (Task 4, 2026-07-27 NetSuite serialized-asset sync plan)
 * classifying a Salesforce Product2 External-ID lookup into exactly one of
 * three outcomes. No mutation, no logging, no persistence — the read itself
 * happens on the connector via `findProduct2ByExternalId` (SOQL, exact
 * match only); this adapter only interprets the row shape/count.
 *
 * Deviation from the design spec's status-based (200/404/300) alternative:
 * `findProduct2ByExternalId` classifies by SOQL row count instead (see the
 * "Deviations" section of the plan). `300` is unreachable in a correctly
 * configured org anyway — Task 6 readiness refuses activation unless the
 * configured Product2 field is both External ID and unique — so ambiguity
 * here is purely a misconfiguration signal, caught the same way either
 * design would catch it.
 */

export type ProductResolution =
  | { status: 'resolved'; product2Id: string }
  | { status: 'missing' }
  | { status: 'ambiguous' };

/**
 * The single method this adapter depends on — deliberately narrower than
 * `SalesforceSerializedAssetReadCapabilities` (from `../../types/serializedAsset`)
 * so this file has no compile-time dependency on the describe half of that
 * interface. Any real connector implementing `findProduct2ByExternalId`
 * (structurally) satisfies this.
 */
export interface Product2LookupConnector {
  findProduct2ByExternalId(field: string, value: string): Promise<readonly { Id: string }[]>;
}

export class SalesforceProductResolver {
  constructor(private readonly connector: Product2LookupConnector) {}

  /**
   * Classifies the lookup rows: zero rows -> `missing`; exactly one row with
   * a well-formed (non-empty string) `Id` -> `resolved`; more than one
   * well-formed row, OR any row that is missing/malformed, -> `ambiguous`.
   * A malformed row makes the WHOLE result ambiguous rather than being
   * silently dropped — this adapter cannot tell how many distinct real
   * products a malformed row might represent, so treating it as
   * "unresolvable" is the fail-closed choice.
   */
  async resolve(itemId: string, field: string): Promise<ProductResolution> {
    const rows = await this.connector.findProduct2ByExternalId(field, itemId);

    const validIds: string[] = [];
    let malformed = false;

    for (const row of rows) {
      if (row && typeof row.Id === 'string' && row.Id.trim().length > 0) {
        validIds.push(row.Id);
      } else {
        malformed = true;
      }
    }

    if (malformed || validIds.length > 1) {
      return { status: 'ambiguous' };
    }
    if (validIds.length === 0) {
      return { status: 'missing' };
    }
    return { status: 'resolved', product2Id: validIds[0] };
  }
}
