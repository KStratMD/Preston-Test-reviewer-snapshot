/**
 * Fixture Data Loader
 *
 * Loads realistic sample data for connector testing without requiring real API credentials.
 * Used by MockConnectorAdapter to enable testing of "planned" connectors.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/Logger';

export type EntityType = 'customers' | 'products' | 'vendors' | 'orders' | 'invoices' | 'inventory';
export type SystemId = 'squire' | 'suiteCentral' | 'quickbooks' | 'shopify' | 'woocommerce' |
                        'square' | 'salesforce' | 'businesscentral' | 'netsuite' | 'stripe' | 'xero';

/**
 * Load fixture data for a specific system and entity type
 */
export async function loadFixture(entityType: EntityType, systemId: SystemId): Promise<unknown[]> {
  try {
    const fixturePath = path.join(__dirname, `${entityType}.json`);

    if (!fs.existsSync(fixturePath)) {
      logger.warn(`Fixture file not found: ${fixturePath}`);
      return [];
    }

    const rawData = fs.readFileSync(fixturePath, 'utf-8');
    const allFixtures = JSON.parse(rawData);

    const systemData = allFixtures[systemId];

    if (!systemData) {
      logger.warn(`No fixture data for system '${systemId}' in ${entityType}.json`);
      return [];
    }

    return Array.isArray(systemData) ? systemData : [systemData];
  } catch (error) {
    logger.error(`Error loading fixture ${entityType} for ${systemId}:`, error);
    return [];
  }
}

/**
 * Get all available entity types for a system
 */
export async function getAvailableFixtures(systemId: SystemId): Promise<EntityType[]> {
  const allEntityTypes: EntityType[] = ['customers', 'products', 'vendors', 'orders', 'invoices', 'inventory'];
  const available: EntityType[] = [];

  for (const entityType of allEntityTypes) {
    const data = await loadFixture(entityType, systemId);
    if (data && data.length > 0) {
      available.push(entityType);
    }
  }

  return available;
}

/**
 * Infer schema from sample data
 */
export function inferSchema(sample: unknown): Record<string, { type: string; required: boolean; example: unknown }> {
  if (!sample || typeof sample !== 'object') {
    return {};
  }

  const schema: Record<string, { type: string; required: boolean; example: unknown }> = {};

  for (const [key, value] of Object.entries(sample)) {
    schema[key] = {
      type: Array.isArray(value) ? 'array' : typeof value,
      required: value !== null && value !== undefined,
      example: value
    };
  }

  return schema;
}

/**
 * Extract field names from data
 */
export function extractFields(data: unknown): string[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const fields: string[] = [];

  function traverse(obj: Record<string, unknown>, prefix = '') {
    for (const [key, value] of Object.entries(obj)) {
      const fieldName = prefix ? `${prefix}.${key}` : key;

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Nested object - traverse
        traverse(value as Record<string, unknown>, fieldName);
      } else {
        fields.push(fieldName);
      }
    }
  }

  traverse(data as Record<string, unknown>);
  return fields;
}
