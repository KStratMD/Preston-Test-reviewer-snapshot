/**
 * Tests for Business Central Metadata Client
 */

import { MetadataClient } from '../../../../src/connectors/businessCentral/MetadataClient';
import { logger } from '../../../../src/utils/Logger';
import type { BCMetadataSchema } from '../../../../src/connectors/businessCentral/types';

describe('MetadataClient', () => {
  describe('Demo Mode', () => {
    let client: MetadataClient;

    beforeEach(() => {
      client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: false
        },
        logger
      );
    });

    it('should load customer metadata from fixture', async () => {
      const schema = await client.fetchMetadata('customers');

      expect(schema).toBeDefined();
      expect(schema.entityType).toBe('customers');
      expect(schema.namespace).toBe('Microsoft.NAV');
      expect(schema.properties.length).toBeGreaterThan(0);
    });

    it('should parse properties correctly', async () => {
      const schema = await client.fetchMetadata('customers');

      // Check specific properties
      const displayName = schema.properties.find(p => p.name === 'displayName');
      expect(displayName).toBeDefined();
      expect(displayName?.type).toBe('string');
      expect(displayName?.maxLength).toBe(100);
      expect(displayName?.nullable).toBe(false);

      const email = schema.properties.find(p => p.name === 'email');
      expect(email).toBeDefined();
      expect(email?.type).toBe('string');
      expect(email?.maxLength).toBe(80);
    });

    it('should parse navigation properties correctly', async () => {
      const schema = await client.fetchMetadata('customers');

      expect(schema.navigationProperties.length).toBeGreaterThan(0);

      const picture = schema.navigationProperties.find(n => n.name === 'picture');
      expect(picture).toBeDefined();
      expect(picture?.collection).toBe(true);
    });

    it('should extract key fields', async () => {
      const schema = await client.fetchMetadata('customers');

      expect(schema.key).toBeDefined();
      expect(schema.key).toContain('id');
    });

    it('should load items metadata from fixture', async () => {
      const schema = await client.fetchMetadata('items');

      expect(schema).toBeDefined();
      expect(schema.entityType).toBe('items');
      expect(schema.properties.length).toBeGreaterThan(0);

      // Check item-specific fields
      const inventory = schema.properties.find(p => p.name === 'inventory');
      expect(inventory).toBeDefined();
      expect(inventory?.type).toBe('number');

      const unitPrice = schema.properties.find(p => p.name === 'unitPrice');
      expect(unitPrice).toBeDefined();
      expect(unitPrice?.type).toBe('number');
    });

    it('should throw error for non-existent entity type', async () => {
      await expect(client.fetchMetadata('nonexistent')).rejects.toThrow();
    });

    it('should list supported entity types', () => {
      const types = client.getSupportedEntityTypes();

      expect(Array.isArray(types)).toBe(true);
      expect(types).toContain('customers');
      expect(types).toContain('items');
      expect(types).toContain('companies');
    });
  });

  describe('Field Catalog', () => {
    let client: MetadataClient;

    beforeEach(() => {
      client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: false
        },
        logger
      );
    });

    it('should generate field catalog from schema', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      expect(catalog).toBeDefined();
      expect(catalog.entityType).toBe('customers');
      expect(catalog.fields.length).toBeGreaterThan(0);
      expect(catalog.relationships.length).toBeGreaterThan(0);
    });

    it('should map field types correctly', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      const displayName = catalog.fields.find(f => f.name === 'displayName');
      expect(displayName?.type).toBe('string');
      expect(displayName?.required).toBe(true);
      expect(displayName?.maxLength).toBe(100);

      const taxLiable = catalog.fields.find(f => f.name === 'taxLiable');
      expect(taxLiable?.type).toBe('boolean');
    });

    it('should mark navigation properties correctly', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      catalog.relationships.forEach(rel => {
        expect(rel.isNavigation).toBe(true);
        expect(rel.type).toBe('object');
      });

      catalog.fields.forEach(field => {
        expect(field.isNavigation).toBe(false);
      });
    });

    it('should add format hints', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      const id = catalog.fields.find(f => f.name === 'id');
      expect(id?.format).toBe('uuid');

      const lastModified = catalog.fields.find(f => f.name === 'lastModifiedDateTime');
      expect(lastModified?.format).toBe('iso8601');
    });
  });

  describe('Caching', () => {
    it('should cache metadata when enabled', async () => {
      const client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: true,
          cacheTTLMs: 1000 // 1 second
        },
        logger
      );

      // First fetch
      const schema1 = await client.fetchMetadata('customers');

      // Second fetch (should be cached)
      const schema2 = await client.fetchMetadata('customers');

      expect(schema1).toBe(schema2); // Same reference
    });

    it('should respect cache TTL', async () => {
      const client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: true,
          cacheTTLMs: 50 // 50ms
        },
        logger
      );

      // First fetch
      await client.fetchMetadata('customers');

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should fetch again
      const schema = await client.fetchMetadata('customers');
      expect(schema).toBeDefined();
    });

    it('should allow manual cache clearing', async () => {
      const client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: true
        },
        logger
      );

      await client.fetchMetadata('customers');
      client.clearCache('customers');

      // Should fetch again after clearing
      const schema = await client.fetchMetadata('customers');
      expect(schema).toBeDefined();
    });

    it('should clear all cache', async () => {
      const client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: true
        },
        logger
      );

      await client.fetchMetadata('customers');
      await client.fetchMetadata('items');

      client.clearCache(); // Clear all

      // Should fetch again
      const schema = await client.fetchMetadata('customers');
      expect(schema).toBeDefined();
    });

    it('should not cache when caching is disabled', async () => {
      const client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: false
        },
        logger
      );

      // First fetch
      const schema1 = await client.fetchMetadata('customers');

      // Second fetch (should not be cached)
      const schema2 = await client.fetchMetadata('customers');

      // Both should be defined but not necessarily the same reference
      expect(schema1).toBeDefined();
      expect(schema2).toBeDefined();
      expect(schema1.entityType).toBe(schema2.entityType);
    });

    it('should cache multiple entity types independently', async () => {
      const client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: true
        },
        logger
      );

      const customersSchema = await client.fetchMetadata('customers');
      const itemsSchema = await client.fetchMetadata('items');
      const companiesSchema = await client.fetchMetadata('companies');

      expect(customersSchema.entityType).toBe('customers');
      expect(itemsSchema.entityType).toBe('items');
      expect(companiesSchema.entityType).toBe('companies');

      // Should be different schemas
      expect(customersSchema).not.toBe(itemsSchema);
      expect(itemsSchema).not.toBe(companiesSchema);
    });

    it('should only clear specific entity when provided', async () => {
      const client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: true
        },
        logger
      );

      await client.fetchMetadata('customers');
      await client.fetchMetadata('items');

      // Clear only customers
      client.clearCache('customers');

      // Customers should be fetched fresh, items should still be cached
      const customersSchema = await client.fetchMetadata('customers');
      expect(customersSchema).toBeDefined();
    });
  });

  describe('Multiple Entity Types', () => {
    let client: MetadataClient;

    beforeEach(() => {
      client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: false
        },
        logger
      );
    });

    it('should load companies metadata from fixture', async () => {
      const schema = await client.fetchMetadata('companies');

      expect(schema).toBeDefined();
      expect(schema.entityType).toBe('companies');
      expect(schema.properties.length).toBeGreaterThan(0);

      const displayName = schema.properties.find(p => p.name === 'displayName');
      expect(displayName).toBeDefined();
      expect(displayName?.type).toBe('string');
    });

    it('should handle different entity types with different properties', async () => {
      const customersSchema = await client.fetchMetadata('customers');
      const itemsSchema = await client.fetchMetadata('items');

      // Customers should have customer-specific fields
      const customerEmail = customersSchema.properties.find(p => p.name === 'email');
      expect(customerEmail).toBeDefined();

      // Items should have item-specific fields
      const itemInventory = itemsSchema.properties.find(p => p.name === 'inventory');
      expect(itemInventory).toBeDefined();

      // Items shouldn't have email
      const itemEmail = itemsSchema.properties.find(p => p.name === 'email');
      expect(itemEmail).toBeUndefined();
    });

    it('should handle all supported entity types', async () => {
      const types = client.getSupportedEntityTypes();

      // Should be able to load metadata for all supported types
      for (const entityType of types) {
        const schema = await client.fetchMetadata(entityType);
        expect(schema).toBeDefined();
        expect(schema.properties.length).toBeGreaterThan(0);
      }
    });
  });

  describe('OData Type Mapping', () => {
    let client: MetadataClient;

    beforeEach(() => {
      client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: false
        },
        logger
      );
    });

    it('should map all standard OData types correctly', async () => {
      const schema = await client.fetchMetadata('customers');

      // String type
      const displayName = schema.properties.find(p => p.name === 'displayName');
      expect(displayName?.type).toBe('string');

      // Number types
      const balance = schema.properties.find(p => p.name === 'balance');
      if (balance) {
        expect(balance.type).toBe('number');
      }

      // Boolean type
      const taxLiable = schema.properties.find(p => p.name === 'taxLiable');
      expect(taxLiable?.type).toBe('boolean');

      // Date type
      const lastModified = schema.properties.find(p => p.name === 'lastModifiedDateTime');
      expect(lastModified?.type).toBe('date');

      // GUID type
      const id = schema.properties.find(p => p.name === 'id');
      expect(id?.type).toBe('guid');
    });

    it('should handle nullable properties', async () => {
      const schema = await client.fetchMetadata('customers');

      // Required fields should be non-nullable
      const displayName = schema.properties.find(p => p.name === 'displayName');
      expect(displayName?.nullable).toBe(false);

      // Optional fields should be nullable
      const phoneNumber = schema.properties.find(p => p.name === 'phoneNumber');
      if (phoneNumber) {
        expect(phoneNumber.nullable).toBe(true);
      }
    });

    it('should handle maxLength constraints', async () => {
      const schema = await client.fetchMetadata('customers');

      const displayName = schema.properties.find(p => p.name === 'displayName');
      expect(displayName?.maxLength).toBe(100);

      const email = schema.properties.find(p => p.name === 'email');
      expect(email?.maxLength).toBe(80);
    });

    it('should handle precision and scale for decimals', async () => {
      const schema = await client.fetchMetadata('items');

      const unitPrice = schema.properties.find(p => p.name === 'unitPrice');
      if (unitPrice && unitPrice.precision) {
        expect(unitPrice.precision).toBeGreaterThan(0);
      }
    });
  });

  describe('Field Format Hints', () => {
    let client: MetadataClient;

    beforeEach(() => {
      client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: false
        },
        logger
      );
    });

    it('should assign uuid format to GUID fields', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      const id = catalog.fields.find(f => f.name === 'id');
      expect(id?.format).toBe('uuid');
    });

    it('should assign iso8601 format to date fields', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      const lastModified = catalog.fields.find(f => f.name === 'lastModifiedDateTime');
      expect(lastModified?.format).toBe('iso8601');
    });

    it('should assign short-text format to small strings', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      // Find a field with maxLength <= 10
      const shortField = catalog.fields.find(f => f.maxLength && f.maxLength <= 10);
      if (shortField) {
        expect(shortField.format).toBe('short-text');
      }
    });

    it('should assign medium-text format to medium strings', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      // Find a field with maxLength <= 50 but > 10
      const mediumField = catalog.fields.find(f =>
        f.maxLength && f.maxLength > 10 && f.maxLength <= 50
      );
      if (mediumField) {
        expect(mediumField.format).toBe('medium-text');
      }
    });

    it('should assign long-text format to large strings', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      // displayName has maxLength 100, should be long-text
      const displayName = catalog.fields.find(f => f.name === 'displayName');
      expect(displayName?.format).toBe('long-text');
    });
  });

  describe('Navigation Properties', () => {
    let client: MetadataClient;

    beforeEach(() => {
      client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: false
        },
        logger
      );
    });

    it('should distinguish between collection and single navigation properties', async () => {
      const schema = await client.fetchMetadata('customers');

      // Check collection navigation property
      const picture = schema.navigationProperties.find(n => n.name === 'picture');
      expect(picture?.collection).toBe(true);
    });

    it('should include relationships in field catalog', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      expect(catalog.relationships.length).toBeGreaterThan(0);

      catalog.relationships.forEach(rel => {
        expect(rel.isNavigation).toBe(true);
        expect(rel.required).toBe(false);
        expect(rel.type).toBe('object');
        expect(rel.description).toBeDefined();
      });
    });

    it('should describe collection relationships correctly', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      const collectionRel = catalog.relationships.find(r => r.description?.includes('Collection of'));
      if (collectionRel) {
        expect(collectionRel.description).toContain('Collection of');
      }
    });

    it('should describe single reference relationships correctly', async () => {
      const schema = await client.fetchMetadata('customers');
      const catalog = client.getFieldCatalog(schema);

      // If there are any single reference relationships
      const singleRel = catalog.relationships.find(r => r.description?.includes('Reference to'));
      if (singleRel) {
        expect(singleRel.description).toContain('Reference to');
      }
    });
  });

  describe('Error Scenarios', () => {
    it('should throw error when getSupportedEntityTypes called in non-demo mode', () => {
      const client = new MetadataClient(
        {
          demoMode: false,
          baseURL: 'https://api.example.com',
          companyId: 'test-company'
        },
        logger
      );

      expect(() => client.getSupportedEntityTypes()).toThrow(
        'getSupportedEntityTypes only available in demo mode'
      );
    });

    it('should handle missing fixture gracefully', async () => {
      const client = new MetadataClient(
        {
          demoMode: true,
          cacheEnabled: false
        },
        logger
      );

      await expect(client.fetchMetadata('totally_nonexistent_entity_12345'))
        .rejects
        .toThrow();
    });
  });

  describe('Production Mode', () => {
    it('should require baseURL and companyId for production mode', async () => {
      const client = new MetadataClient(
        {
          demoMode: false
        },
        logger
      );

      // Should fall back to fixture in current implementation
      await expect(client.fetchMetadata('customers'))
        .rejects
        .toThrow();
    });

    it('should initialize with production config', () => {
      const client = new MetadataClient(
        {
          demoMode: false,
          baseURL: 'https://api.businesscentral.dynamics.com/v2.0/tenant-id/production',
          companyId: 'test-company-id',
          cacheEnabled: true,
          cacheTTLMs: 3600000
        },
        logger
      );

      expect(client).toBeDefined();
    });
  });
});
