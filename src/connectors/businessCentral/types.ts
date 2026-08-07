/**
 * Business Central Metadata Types
 */

export interface BCMetadataSchema {
  entityType: string;
  namespace: string;
  properties: BCProperty[];
  navigationProperties: BCNavProperty[];
  key: string[];
}

export interface BCProperty {
  name: string;
  type: string;
  nullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

export interface BCNavProperty {
  name: string;
  type: string;
  collection: boolean;
}

export interface BCFieldCatalog {
  entityType: string;
  fields: BCFieldDefinition[];
  relationships: BCFieldDefinition[];
}

export interface BCFieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'guid' | 'object';
  description?: string;
  required: boolean;
  maxLength?: number;
  format?: string;
  isNavigation?: boolean;
}

export interface MetadataClientConfig {
  demoMode: boolean;
  baseURL?: string;
  companyId?: string;
  cacheEnabled?: boolean;
  cacheTTLMs?: number;
}
