import type { NetSuiteSchema } from './AIFieldMappingService';

export const suiteCentralCustomerSchema: NetSuiteSchema = {
  systemType: 'SuiteCentral',
  recordType: 'customer',
  fields: [
    { name: 'firstName', type: 'string', required: true },
    { name: 'lastName', type: 'string', required: true },
    { name: 'email', type: 'email', required: true },
    { name: 'phone', type: 'phone' },
    { name: 'amount', type: 'currency' },
  ],
  customFields: [
    { id: 'custentity_loyalty_level', label: 'Loyalty Level', type: 'string', recordType: 'customer' },
  ],
  relationships: [],
};

