import type { FieldMapping } from '../types';

export const squireToSuiteCentralCustomerMappings: FieldMapping[] = [
  { sourceField: 'id', targetField: 'externalId', transformationType: 'direct', isRequired: true },
  { sourceField: 'companyName', targetField: 'name', transformationType: 'direct', isRequired: true },
  { sourceField: 'contactEmail', targetField: 'email', transformationType: 'direct', isRequired: false },
  { sourceField: 'primaryPhone', targetField: 'phone', transformationType: 'direct', isRequired: false },
  { sourceField: 'mailingAddress', targetField: 'address', transformationType: 'direct', isRequired: false },
];

export const suiteCentralToNetSuiteCustomerMappings: FieldMapping[] = [
  { sourceField: 'name', targetField: 'name', transformationType: 'direct', isRequired: true },
  { sourceField: 'email', targetField: 'email', transformationType: 'direct', isRequired: false },
  { sourceField: 'phone', targetField: 'phone', transformationType: 'direct', isRequired: false },
];
