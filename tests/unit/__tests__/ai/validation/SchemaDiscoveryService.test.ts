import 'reflect-metadata';
import { SchemaDiscoveryService, type SchemaDiscoveryConfig } from '../../../../../src/services/ai/validation/SchemaDiscoveryService';
import type { SystemType, EntityType, SystemSchema } from '../../../../../src/services/ai/validation/types';

describe('SchemaDiscoveryService', () => {
  let service: SchemaDiscoveryService;

  describe('with mock schemas (API disabled)', () => {
    beforeEach(() => {
      service = new SchemaDiscoveryService({
        enableNetSuite: false,
        enableSalesforce: false,
        enableBusinessCentral: false,
        cacheEnabled: true,
        cacheTTL: 3600000
      });
    });

    describe('getSchema', () => {
      it('should return NetSuite mock schema for Customer entity', async () => {
        const schema = await service.getSchema('NetSuite', 'Customer');

        expect(schema).toBeDefined();
        expect(schema.system).toBe('NetSuite');
        expect(schema.entity).toBe('Customer');
        expect(schema.fields).toBeDefined();
        expect(Array.isArray(schema.fields)).toBe(true);
        expect(schema.fields.length).toBeGreaterThan(0);
        expect(schema.metadata?.source).toBe('manual');
      });

      it('should return Salesforce mock schema for Account entity', async () => {
        const schema = await service.getSchema('Salesforce', 'Account');

        expect(schema).toBeDefined();
        expect(schema.system).toBe('Salesforce');
        expect(schema.entity).toBe('Account');
        expect(schema.fields).toBeDefined();
        expect(Array.isArray(schema.fields)).toBe(true);
        expect(schema.fields.length).toBeGreaterThan(0);
        expect(schema.metadata?.source).toBe('manual');
      });

      it('should return Business Central mock schema for Contact entity', async () => {
        const schema = await service.getSchema('BusinessCentral', 'Contact');

        expect(schema).toBeDefined();
        expect(schema.system).toBe('BusinessCentral');
        expect(schema.entity).toBe('Contact');
        expect(schema.fields).toBeDefined();
        expect(Array.isArray(schema.fields)).toBe(true);
        expect(schema.fields.length).toBeGreaterThan(0);
        expect(schema.metadata?.source).toBe('manual');
      });

      it('should include required fields in mock schemas', async () => {
        const schema = await service.getSchema('NetSuite', 'Customer');

        const requiredFields = schema.fields.filter(f => f.required);
        expect(requiredFields.length).toBeGreaterThan(0);

        // NetSuite customer should have entityId and companyName as required
        const entityId = schema.fields.find(f => f.name === 'entityId');
        const companyName = schema.fields.find(f => f.name === 'companyName');

        expect(entityId).toBeDefined();
        expect(entityId?.required).toBe(true);
        expect(companyName).toBeDefined();
        expect(companyName?.required).toBe(true);
      });

      it('should include format specifications in mock schemas', async () => {
        const schema = await service.getSchema('Salesforce', 'Contact');

        const emailField = schema.fields.find(f => f.format === 'email');
        const phoneField = schema.fields.find(f => f.format === 'phone');

        expect(emailField).toBeDefined();
        expect(phoneField).toBeDefined();
      });

      it('should include maxLength constraints in mock schemas', async () => {
        const schema = await service.getSchema('BusinessCentral', 'Customer');

        const fieldsWithMaxLength = schema.fields.filter(f => f.maxLength);
        expect(fieldsWithMaxLength.length).toBeGreaterThan(0);
      });
    });

    describe('schema caching', () => {
      it('should cache schemas after first retrieval', async () => {
        const schema1 = await service.getSchema('NetSuite', 'Customer');
        const schema2 = await service.getSchema('NetSuite', 'Customer');

        // Should be the same reference if cached
        expect(schema1).toBe(schema2);
      });

      it('should cache schemas per system-entity combination', async () => {
        const netsuiteCustomer = await service.getSchema('NetSuite', 'Customer');
        const netsuiteContact = await service.getSchema('NetSuite', 'Contact');
        const salesforceAccount = await service.getSchema('Salesforce', 'Account');

        expect(netsuiteCustomer).not.toBe(netsuiteContact);
        expect(netsuiteCustomer).not.toBe(salesforceAccount);
        expect(netsuiteContact).not.toBe(salesforceAccount);
      });

      it('should return cache statistics', async () => {
        await service.getSchema('NetSuite', 'Customer');
        await service.getSchema('Salesforce', 'Account');

        const stats = service.getCacheStats();

        expect(stats).toBeDefined();
        expect(stats.size).toBe(2);
        expect(stats.entries).toBeDefined();
        expect(Array.isArray(stats.entries)).toBe(true);
        expect(stats.entries.length).toBe(2);

        // Check entry structure
        const entry = stats.entries[0];
        expect(entry.key).toBeDefined();
        expect(entry.age).toBeDefined();
        expect(typeof entry.age).toBe('number');
      });

      it('should clear cache for specific system', async () => {
        await service.getSchema('NetSuite', 'Customer');
        await service.getSchema('NetSuite', 'Contact');
        await service.getSchema('Salesforce', 'Account');

        service.clearCache('NetSuite');

        const stats = service.getCacheStats();
        expect(stats.size).toBe(1); // Only Salesforce should remain

        // Verify Salesforce still cached
        const salesforceSchema = await service.getSchema('Salesforce', 'Account');
        expect(salesforceSchema).toBeDefined();
      });

      it('should clear all cache when no system specified', async () => {
        await service.getSchema('NetSuite', 'Customer');
        await service.getSchema('Salesforce', 'Account');
        await service.getSchema('BusinessCentral', 'Customer');

        service.clearCache();

        const stats = service.getCacheStats();
        expect(stats.size).toBe(0);
      });
    });

    describe('cache disabled configuration', () => {
      beforeEach(() => {
        service = new SchemaDiscoveryService({
          enableNetSuite: false,
          enableSalesforce: false,
          enableBusinessCentral: false,
          cacheEnabled: false
        });
      });

      it('should not cache schemas when cacheEnabled is false', async () => {
        const schema1 = await service.getSchema('NetSuite', 'Customer');
        const schema2 = await service.getSchema('NetSuite', 'Customer');

        // Should be different instances when cache is disabled
        expect(schema1).not.toBe(schema2);

        const stats = service.getCacheStats();
        expect(stats.size).toBe(0);
      });
    });

    describe('error handling', () => {
      it('should throw error for unsupported system', async () => {
        await expect(
          service.getSchema('UnsupportedSystem' as SystemType, 'Customer')
        ).rejects.toThrow('Unsupported system');
      });
    });
  });

  describe('mock schema content validation', () => {
    beforeEach(() => {
      service = new SchemaDiscoveryService({
        enableNetSuite: false,
        enableSalesforce: false,
        enableBusinessCentral: false
      });
    });

    it('should include common business fields in NetSuite schema', async () => {
      const schema = await service.getSchema('NetSuite', 'Customer');

      const fieldNames = schema.fields.map(f => f.name);

      expect(fieldNames).toContain('email');
      expect(fieldNames).toContain('phone');
      expect(fieldNames).toContain('companyName');
    });

    it('should include Salesforce-specific field naming conventions', async () => {
      const schema = await service.getSchema('Salesforce', 'Account');

      const idField = schema.fields.find(f => f.name === 'Id');
      expect(idField).toBeDefined();
      expect(idField?.type).toBe('string');
      expect(idField?.maxLength).toBe(18); // Salesforce ID length
    });

    it('should include Business Central field naming conventions', async () => {
      const schema = await service.getSchema('BusinessCentral', 'Customer');

      // BC uses underscores in field names
      const fieldNames = schema.fields.map(f => f.name);
      expect(fieldNames.some(name => name.includes('_'))).toBe(true);

      const noField = schema.fields.find(f => f.name === 'No_');
      expect(noField).toBeDefined();
    });

    it('should validate field structure completeness', async () => {
      const schema = await service.getSchema('NetSuite', 'Customer');

      schema.fields.forEach(field => {
        expect(field.name).toBeDefined();
        expect(typeof field.name).toBe('string');
        expect(field.type).toBeDefined();
        expect(typeof field.type).toBe('string');
        expect(field.required).toBeDefined();
        expect(typeof field.required).toBe('boolean');

        if (field.maxLength !== undefined) {
          expect(typeof field.maxLength).toBe('number');
        }

        if (field.format !== undefined) {
          expect(typeof field.format).toBe('string');
          expect(['email', 'phone', 'date', 'datetime', 'url', 'uuid']).toContain(field.format);
        }
      });
    });
  });

  describe('configuration options', () => {
    it('should accept custom cache TTL', () => {
      const customTTL = 1800000; // 30 minutes
      const service = new SchemaDiscoveryService({
        cacheTTL: customTTL
      });

      expect(service).toBeDefined();
    });

    it('should use default configuration when no config provided', () => {
      const service = new SchemaDiscoveryService();

      expect(service).toBeDefined();

      // Should work with defaults
      expect(async () => {
        await service.getSchema('NetSuite', 'Customer');
      }).not.toThrow();
    });

    it('should handle partial configuration', () => {
      const service = new SchemaDiscoveryService({
        enableNetSuite: true
        // Other options should use defaults
      });

      expect(service).toBeDefined();
    });
  });

  describe('entity type mapping', () => {
    beforeEach(() => {
      service = new SchemaDiscoveryService();
    });

    it('should support Customer entity across all systems', async () => {
      const netsuiteSchema = await service.getSchema('NetSuite', 'Customer');
      const salesforceSchema = await service.getSchema('Salesforce', 'Customer');
      const bcSchema = await service.getSchema('BusinessCentral', 'Customer');

      expect(netsuiteSchema.entity).toBe('Customer');
      expect(salesforceSchema.entity).toBe('Customer');
      expect(bcSchema.entity).toBe('Customer');
    });

    it('should support Contact entity across all systems', async () => {
      const netsuiteSchema = await service.getSchema('NetSuite', 'Contact');
      const salesforceSchema = await service.getSchema('Salesforce', 'Contact');
      const bcSchema = await service.getSchema('BusinessCentral', 'Contact');

      expect(netsuiteSchema.entity).toBe('Contact');
      expect(salesforceSchema.entity).toBe('Contact');
      expect(bcSchema.entity).toBe('Contact');
    });

    it('should support Account entity', async () => {
      const netsuiteSchema = await service.getSchema('NetSuite', 'Account');
      const salesforceSchema = await service.getSchema('Salesforce', 'Account');

      expect(netsuiteSchema.entity).toBe('Account');
      expect(salesforceSchema.entity).toBe('Account');
    });

    it('should support all standard entity types', async () => {
      const entityTypes: EntityType[] = ['Customer', 'Contact', 'Account', 'Order', 'Product', 'Invoice'];

      for (const entityType of entityTypes) {
        const schema = await service.getSchema('NetSuite', entityType);
        expect(schema.entity).toBe(entityType);
      }
    });
  });
});
