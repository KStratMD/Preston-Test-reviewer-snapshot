/**
 * Schema Validation Types - Phase 5 AI Accuracy Improvements
 * Type definitions for real-time schema validation against target systems
 */

export interface SchemaField {
  name: string;
  type: string; // 'string', 'number', 'boolean', 'date', 'object', 'array'
  required: boolean;
  maxLength?: number;
  minLength?: number;
  format?: string; // 'email', 'phone', 'date', 'datetime', 'url', 'uuid'
  pattern?: string; // Regex pattern
  allowedValues?: string[]; // For picklists/enums
  description?: string;
  defaultValue?: unknown;
  nullable?: boolean;
}

export interface SchemaRelationship {
  sourceField: string;
  targetEntity: string;
  targetField: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
}

export interface SystemSchema {
  system: string; // 'NetSuite', 'Salesforce', 'BusinessCentral'
  entity: string; // 'Customer', 'Account', 'Contact', etc.
  fields: SchemaField[];
  relationships: SchemaRelationship[];
  metadata?: {
    version?: string;
    lastUpdated?: Date;
    source?: 'api' | 'cache' | 'manual';
  };
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
  confidenceBoost?: number; // +10 to +20 for valid mappings
  confidencePenalty?: number; // -10 to -30 for invalid mappings
  alternativeSuggestions?: SchemaField[];
  metadata?: {
    fieldExists: boolean;
    typeCompatible: boolean;
    formatValid: boolean;
    lengthValid: boolean;
  };
}

export interface SchemaCacheEntry {
  schema: SystemSchema;
  timestamp: Date;
  ttl: number; // Time to live in milliseconds
}

export type SystemType = 'NetSuite' | 'Salesforce' | 'BusinessCentral';
export type EntityType = 'Customer' | 'Contact' | 'Account' | 'Order' | 'Product' | 'Invoice';
