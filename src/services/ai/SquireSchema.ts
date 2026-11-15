import type { SchemaDefinition } from './AIFieldMappingService';

export const squireCustomerSchema: SchemaDefinition = {
  systemType: 'Squire',
  recordType: 'customer',
  fields: [
    { name: 'firstName', type: 'string', description: 'Customer first name', required: true },
    { name: 'lastName', type: 'string', description: 'Customer last name', required: true },
    { name: 'email', type: 'email', description: 'Primary email address', required: true },
    { name: 'phone', type: 'phone', description: 'Primary phone number' },
    { name: 'amount', type: 'currency', description: 'Total purchase amount' },
  ],
};

