import type { CanonicalEntity } from './SourceOfTruthManifest';

/**
 * Normalize a connector-side record type to a `CanonicalEntity` from
 * `SOURCE_OF_TRUTH_MANIFEST`. Returns the canonical key when a known
 * connector-record-type spelling matches; returns the input verbatim
 * otherwise (which `OwnershipResolver` treats as `no_policy_declared` —
 * the same graceful-degradation behavior Stage A2 chose for unmapped
 * entities).
 *
 * Background — Copilot R10 on PR #851:
 *   Stage A2 migrated direct connector writes through `guardedWrite` and
 *   passed the connector record type (e.g. `'customers'`, `'Customer'`)
 *   as the `entity` context. The intent was "either canonical or connector
 *   form works because `OwnershipResolver.lookupOptional` returns null for
 *   unknown entities and the resolver falls through to no_policy_declared".
 *   The practical effect was that the customer ownership policy NEVER
 *   fired for any guardedWrite caller that supplied a non-canonical
 *   spelling — i.e. nearly all integration/sync paths. Each affected
 *   site silently bypassed the manifest's `reject_with_alert`/
 *   `source_wins`/etc. policies.
 *
 * This normalizer maps every common connector-record-type spelling
 * (singular, plural, lowercase, PascalCase) to the canonical 11-entity
 * vocabulary. It is intentionally explicit (no plural-stripping heuristic)
 * so adding a new canonical entity requires updating this table, which
 * the source-of-truth-coverage CI gate will flag if forgotten.
 *
 * Unknown record types pass through unchanged so the `no_policy_declared`
 * graceful-degradation contract is preserved for genuinely unmapped
 * entities (e.g. `customrecord_suitecentral_fix_suggestion`).
 */
const CONNECTOR_RECORD_TYPE_TO_CANONICAL: Readonly<Record<string, CanonicalEntity>> = {
  // customer
  customer: 'customer',
  customers: 'customer',
  Customer: 'customer',
  Customers: 'customer',
  // contact
  contact: 'contact',
  contacts: 'contact',
  Contact: 'contact',
  Contacts: 'contact',
  // vendor
  vendor: 'vendor',
  vendors: 'vendor',
  Vendor: 'vendor',
  Vendors: 'vendor',
  // invoice
  invoice: 'invoice',
  invoices: 'invoice',
  Invoice: 'invoice',
  Invoices: 'invoice',
  // payment
  payment: 'payment',
  payments: 'payment',
  Payment: 'payment',
  Payments: 'payment',
  // payout_batch
  payout_batch: 'payout_batch',
  payout_batches: 'payout_batch',
  PayoutBatch: 'payout_batch',
  // product
  product: 'product',
  products: 'product',
  Product: 'product',
  Products: 'product',
  // inventory_level
  inventory_level: 'inventory_level',
  inventory_levels: 'inventory_level',
  InventoryLevel: 'inventory_level',
  // sales_order
  sales_order: 'sales_order',
  sales_orders: 'sales_order',
  SalesOrder: 'sales_order',
  // deal
  deal: 'deal',
  deals: 'deal',
  Deal: 'deal',
  Deals: 'deal',
  // ticket
  ticket: 'ticket',
  tickets: 'ticket',
  Ticket: 'ticket',
  Tickets: 'ticket',
};

/**
 * Normalize a connector-side record type or canonical-entity string to a
 * `CanonicalEntity` from the manifest. Returns the canonical form when the
 * input matches a known spelling; returns the input verbatim otherwise.
 */
export function canonicalEntityFor(entityType: string): CanonicalEntity | string {
  return CONNECTOR_RECORD_TYPE_TO_CANONICAL[entityType] ?? entityType;
}
