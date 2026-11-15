import type { FixtureRow } from './types';

/**
 * 10 ERP-sync error archetypes (Claude-drafted, not Squire-empirical).
 * The pilot's >=50% accept-rate target measures the AI on real Squire data;
 * this fixture is shape-correctness, not realism. Rebalance after pilot.
 */
export const SCENARIOS: FixtureRow[] = [
  {
    id: 'S01',
    category: 'item-not-found',
    errorRecord: {
      id: 'err-S01',
      lastModified: '2026-05-01T10:00:00Z',
      error_message: 'Could not find item 1234 referenced from ShipStation order 5678',
      error_context: { item_id: '1234', source_system: 'shipstation', source_order: '5678' },
    },
    expectedConfidence: 'high',
    expectedShapeAssertions: { suggestionType: 'create_missing_record', referencesField: 'item_id', mentionsTerms: ['item', '1234'] },
  },
  {
    id: 'S02',
    category: 'customer-not-found',
    errorRecord: {
      id: 'err-S02',
      lastModified: '2026-05-01T10:01:00Z',
      error_message: 'Customer ID CUST-9821 not found in NetSuite during sales order import',
      error_context: { customer_id: 'CUST-9821', operation: 'sales_order_import' },
    },
    expectedConfidence: 'high',
    expectedShapeAssertions: { suggestionType: 'create_missing_record', referencesField: 'customer_id', mentionsTerms: ['customer', 'CUST-9821'] },
  },
  {
    id: 'S03',
    category: 'vendor-not-found',
    errorRecord: {
      id: 'err-S03',
      lastModified: '2026-05-01T10:02:00Z',
      error_message: 'Vendor ID V-447 referenced in PO PO-12 not found',
      error_context: { vendor_id: 'V-447', po: 'PO-12' },
    },
    expectedConfidence: 'high',
    expectedShapeAssertions: { suggestionType: 'create_missing_record', referencesField: 'vendor_id', mentionsTerms: ['vendor', 'V-447'] },
  },
  {
    id: 'S04',
    category: 'currency-mismatch',
    errorRecord: {
      id: 'err-S04',
      lastModified: '2026-05-01T10:03:00Z',
      error_message: 'Transaction currency USD does not match account base currency CAD',
      error_context: { tx_currency: 'USD', account_currency: 'CAD' },
    },
    expectedConfidence: 'mid',
    expectedShapeAssertions: { suggestionType: 'fix_field_value', referencesField: 'currency', mentionsTerms: ['currency', 'CAD'] },
  },
  {
    id: 'S05',
    category: 'tax-rate-mismatch',
    errorRecord: {
      id: 'err-S05',
      lastModified: '2026-05-01T10:04:00Z',
      error_message: 'Tax rate 8.25% from ShipStation order does not exist in tax table; closest match: 8.5%',
      error_context: { source_rate: '8.25', closest_rate: '8.5' },
    },
    expectedConfidence: 'mid',
    expectedShapeAssertions: { suggestionType: 'fix_field_value', referencesField: 'tax_rate', mentionsTerms: ['tax', '8.5'] },
  },
  {
    id: 'S06',
    category: 'missing-required-field',
    errorRecord: {
      id: 'err-S06',
      lastModified: '2026-05-01T10:05:00Z',
      error_message: "Required field 'memo' missing on transaction TXN-99",
      error_context: { field: 'memo', tx: 'TXN-99' },
    },
    expectedConfidence: 'mid',
    expectedShapeAssertions: { suggestionType: 'fix_field_value', referencesField: 'memo', mentionsTerms: ['memo'] },
  },
  {
    id: 'S07',
    category: 'locked-record',
    errorRecord: {
      id: 'err-S07',
      lastModified: '2026-05-01T10:06:00Z',
      error_message: "Record customer/8821 is currently locked by user 'jane.smith'",
      error_context: { record: 'customer/8821', locker: 'jane.smith' },
    },
    expectedConfidence: 'low',
    expectedShapeAssertions: { suggestionType: 'manual_review', mentionsTerms: ['lock'] },
  },
  {
    id: 'S08',
    category: 'duplicate-external-id',
    errorRecord: {
      id: 'err-S08',
      lastModified: '2026-05-01T10:07:00Z',
      error_message: "External ID 'ORDER-77432' already exists on transaction internalid 99201",
      error_context: { external_id: 'ORDER-77432', existing_internalid: '99201' },
    },
    expectedConfidence: 'mid',
    expectedShapeAssertions: { suggestionType: 'manual_review', mentionsTerms: ['duplicate', '99201'] },
  },
  {
    id: 'S09',
    category: 'schema-drift',
    errorRecord: {
      id: 'err-S09',
      lastModified: '2026-05-01T10:08:00Z',
      error_message: "Field 'customField_xyz' does not exist on record type 'salesorder'",
      error_context: { field: 'customField_xyz', record_type: 'salesorder' },
    },
    expectedConfidence: 'low',
    expectedShapeAssertions: { suggestionType: 'manual_review', mentionsTerms: ['schema', 'customField_xyz'] },
  },
  {
    id: 'S10',
    category: 'unauthorized-write',
    errorRecord: {
      id: 'err-S10',
      lastModified: '2026-05-01T10:09:00Z',
      error_message: "Insufficient permissions: role 'integration_user' lacks transaction:write on subsidiary 5",
      error_context: { role: 'integration_user', missing_perm: 'transaction:write', subsidiary: '5' },
    },
    expectedConfidence: 'low',
    expectedShapeAssertions: { suggestionType: 'manual_review', mentionsTerms: ['permission', 'role'] },
  },
];
