import type { TemplateView } from './domain';

/**
 * Code-owned, immutable SuiteCentral integration templates.
 *
 * These are the two defaults the legacy in-memory config service seeded on
 * boot, promoted to stable-IDed, deep-frozen constants. They are NEVER inserted
 * into `suitecentral_templates` and never updated; the service layer merges
 * them into tenant list results (built-ins first) at read time. `tenantId` is
 * null and `builtIn` is true so callers can tell them apart from tenant rows.
 */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const TEMPLATES: readonly TemplateView[] = [
  {
    id: 'builtin:squire-customers',
    tenantId: null,
    name: 'Squire to SuiteCentral Customers',
    description: 'Sync customer data from Squire POS to SuiteCentral',
    sourceSystem: 'Squire',
    targetEntities: ['customers'],
    fieldMappings: {
      customer_id: { targetField: 'customerId', isRequired: true },
      business_name: { targetField: 'companyName', isRequired: true },
      contact_name: { targetField: 'contactName', isRequired: false },
      email: { targetField: 'email', isRequired: false },
      phone: { targetField: 'phone', isRequired: false },
      address: { targetField: 'address', isRequired: false },
      status: { targetField: 'status', isRequired: true },
    },
    businessRules: [
      { id: '1', name: 'Active Customer Filter', condition: 'status === "active"', action: 'sync', priority: 1 },
      { id: '2', name: 'Email Validation', condition: 'email && email.includes("@")', action: 'validate', priority: 2 },
    ],
    syncSettings: { direction: 'outbound', frequency: 'realtime', batchSize: 100, errorHandling: 'retry' },
    version: 1,
    builtIn: true,
  },
  {
    id: 'builtin:netsuite-orders',
    tenantId: null,
    name: 'NetSuite to SuiteCentral Orders',
    description: 'Sync sales orders from NetSuite to SuiteCentral',
    sourceSystem: 'NetSuite',
    targetEntities: ['orders'],
    fieldMappings: {
      tranid: { targetField: 'orderId', isRequired: true },
      entity: { targetField: 'customerId', isRequired: true },
      trandate: { targetField: 'orderDate', isRequired: true },
      total: { targetField: 'totalAmount', isRequired: true },
      status: { targetField: 'status', isRequired: true },
      item: { targetField: 'items', transformation: 'arrayToObject', isRequired: false },
    },
    businessRules: [
      { id: '1', name: 'Completed Orders Only', condition: 'status === "Billed" || status === "Fulfilled"', action: 'sync', priority: 1 },
    ],
    syncSettings: { direction: 'outbound', frequency: 'hourly', batchSize: 50, errorHandling: 'skip' },
    version: 1,
    builtIn: true,
  },
];

export const BUILT_IN_SUITECENTRAL_TEMPLATES: readonly TemplateView[] = deepFreeze(TEMPLATES);
