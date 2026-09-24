import 'reflect-metadata';
import { SchemaDiscoveryService, type SchemaDiscoveryConfig, type SalesforceRelationshipDiscoveryConfig } from '../../../../../src/services/ai/validation/SchemaDiscoveryService';
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

    it('should use default configuration when no config provided', async () => {
      const service = new SchemaDiscoveryService();

      expect(service).toBeDefined();

      // Should work with defaults
      await expect(service.getSchema('NetSuite', 'Customer')).resolves.not.toThrow();
    });

    it('should handle partial configuration', () => {
      const service = new SchemaDiscoveryService({
        enableNetSuite: true
        // Other options should use defaults
      });

      expect(service).toBeDefined();
    });
  });

  describe('discoverSalesforceRelationshipSchema (relationship-evidence path)', () => {
    // Unlike getSchema()/getSalesforceSchema(), which intentionally degrade to
    // a mock schema on any failure for suggestion-time callers, this method
    // distinguishes "discovery not configured" (returns null) from "discovery
    // attempted and the transport failed" (throws) — see
    // docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
    // "Error contract". RelationshipEvidenceProvider depends on this
    // distinction to know when to surface a trustworthy unavailable result
    // versus an inability-to-decide failure.
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    // B3.5: this path is controlled ONLY by salesforceRelationshipDiscovery,
    // never by enableSalesforce (that flag governs the unrelated
    // suggestion-time getSchema()/getSalesforceSchema() mock-vs-real
    // behavior) and never by process.env directly.
    it('returns null and makes zero fetch calls when Salesforce discovery is not configured (explicit disabled)', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
      const service = new SchemaDiscoveryService({ salesforceRelationshipDiscovery: { mode: 'disabled' } });

      const result = await service.discoverSalesforceRelationshipSchema('Account');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null and makes zero fetch calls when Salesforce discovery is not configured (default)', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
      const service = new SchemaDiscoveryService();

      const result = await service.discoverSalesforceRelationshipSchema('Account');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('stays disabled (zero fetch calls) even when the unrelated enableSalesforce flag is true', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch as unknown as typeof fetch;
      const service = new SchemaDiscoveryService({ enableSalesforce: true });

      const result = await service.discoverSalesforceRelationshipSchema('Account');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns a parsed API schema (source: api) on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          fields: [],
          childRelationships: [
            { field: 'AccountId', childSObject: 'Contact', relationshipName: 'Contacts' },
          ],
        }),
      }) as unknown as typeof fetch;

      const service = new SchemaDiscoveryService({
        salesforceRelationshipDiscovery: {
          mode: 'live',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'test-token',
        },
      });
      const result = await service.discoverSalesforceRelationshipSchema('Account');

      expect(result?.metadata?.source).toBe('api');
      expect(result?.relationships).toEqual([
        { sourceField: 'AccountId', targetEntity: 'Contact', targetField: 'Contacts', type: 'one-to-many' },
      ]);
    });

    it('fetches against the configured instanceUrl and token, never process.env', async () => {
      const originalInstanceUrl = process.env.SALESFORCE_INSTANCE_URL;
      const originalAccessToken = process.env.SALESFORCE_ACCESS_TOKEN;
      process.env.SALESFORCE_INSTANCE_URL = 'https://process-env-decoy.my.salesforce.com';
      process.env.SALESFORCE_ACCESS_TOKEN = 'process-env-decoy-token';

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ fields: [], childRelationships: [] }),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      try {
        const service = new SchemaDiscoveryService({
          salesforceRelationshipDiscovery: {
            mode: 'live',
            instanceUrl: 'https://configured.my.salesforce.com',
            accessToken: 'configured-token',
          },
        });

        await service.discoverSalesforceRelationshipSchema('Account');

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('https://configured.my.salesforce.com/'),
          expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer configured-token' }),
          }),
        );
      } finally {
        // Delete rather than assign `undefined`: env vars are always
        // strings, so `process.env.X = undefined` leaves the literal string
        // "undefined" behind and contaminates later tests when the key was
        // genuinely absent beforehand (Bumble review, B3.5).
        if (originalInstanceUrl === undefined) {
          delete process.env.SALESFORCE_INSTANCE_URL;
        } else {
          process.env.SALESFORCE_INSTANCE_URL = originalInstanceUrl;
        }
        if (originalAccessToken === undefined) {
          delete process.env.SALESFORCE_ACCESS_TOKEN;
        } else {
          process.env.SALESFORCE_ACCESS_TOKEN = originalAccessToken;
        }
      }
    });

    it('throws a fixed message (does not fall back to a mock schema, does not echo the raw transport error) when the transport rejects', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:443')) as unknown as typeof fetch;

      const service = new SchemaDiscoveryService({
        salesforceRelationshipDiscovery: {
          mode: 'live',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'test-token',
        },
      });

      await expect(service.discoverSalesforceRelationshipSchema('Account')).rejects.toThrow(
        'Salesforce relationship discovery failed: transport error',
      );
      await expect(service.discoverSalesforceRelationshipSchema('Account')).rejects.not.toThrow(
        /ECONNREFUSED|10\.0\.0\.5/,
      );
    });

    it('throws a fixed message with only the numeric status (does not fall back to a mock schema, never the remote statusText) on a non-ok response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error: db-primary-07.internal unreachable',
      }) as unknown as typeof fetch;

      const service = new SchemaDiscoveryService({
        salesforceRelationshipDiscovery: {
          mode: 'live',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'test-token',
        },
      });

      await expect(service.discoverSalesforceRelationshipSchema('Account')).rejects.toThrow(
        'Salesforce relationship discovery failed with status 500',
      );
      await expect(service.discoverSalesforceRelationshipSchema('Account')).rejects.not.toThrow(
        /db-primary-07/,
      );
    });

    it('throws a fixed message when the response body is unparseable, never echoing the raw body or parse error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0: <html>leaked-body-marker</html>');
        },
      }) as unknown as typeof fetch;

      const service = new SchemaDiscoveryService({
        salesforceRelationshipDiscovery: {
          mode: 'live',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'test-token',
        },
      });

      await expect(service.discoverSalesforceRelationshipSchema('Account')).rejects.toThrow(
        'Salesforce relationship discovery failed: unparseable response',
      );
      await expect(service.discoverSalesforceRelationshipSchema('Account')).rejects.not.toThrow(
        /leaked-body-marker/,
      );
    });

    it('never leaks the access token, instance URL, response body, entity payload, remote statusText, or transport exception text through the thrown error', async () => {
      // Distinct sentinels per B3.5 review: one plant per surface, so a
      // failure to redact any single one is individually attributable.
      const secretToken = 'sf-secret-access-token-should-not-leak';
      const secretInstanceUrl = 'https://leaked-instance-marker.my.salesforce.com';
      const bodyMarker = 'leaked-response-body-marker';
      const entityMarker = 'LeakedEntityPayloadMarker';
      const statusTextMarker = 'leaked-statustext-marker';

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: statusTextMarker,
        json: async () => ({ error: 'INVALID_SESSION_ID', body: bodyMarker, accessToken: secretToken }),
      }) as unknown as typeof fetch;

      const service = new SchemaDiscoveryService({
        salesforceRelationshipDiscovery: {
          mode: 'live',
          instanceUrl: secretInstanceUrl,
          accessToken: secretToken,
        },
      });

      let caught: unknown;
      try {
        await service.discoverSalesforceRelationshipSchema(entityMarker as unknown as EntityType);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).not.toContain(secretToken);
      expect(message).not.toContain(secretInstanceUrl);
      expect(message).not.toContain(bodyMarker);
      expect(message).not.toContain(entityMarker);
      expect(message).not.toContain(statusTextMarker);
    });

    it('never leaks remote field/relationship metadata through the malformed-record warning logs on an otherwise successful 200 response (Bumble review)', async () => {
      const fieldTypeMarker = 'leaked-field-type-marker';
      const fieldLabelMarker = 'leaked-field-label-marker';
      const sourceFieldMarker = 'leaked-source-field-marker';
      const targetEntityMarker = 'leaked-target-entity-marker';
      const targetFieldMarker = 'leaked-target-field-marker';

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          // Missing `name` — hits the malformed-field branch.
          fields: [{ type: fieldTypeMarker, label: fieldLabelMarker }],
          // Missing `field` — hits the malformed-relationship branch.
          childRelationships: [
            { childSObject: targetEntityMarker, relationshipName: targetFieldMarker, field: undefined },
            { field: sourceFieldMarker }, // missing childSObject/relationshipName
          ],
        }),
      }) as unknown as typeof fetch;

      const service = new SchemaDiscoveryService({
        salesforceRelationshipDiscovery: {
          mode: 'live',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'test-token',
        },
      });
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      const result = await service.discoverSalesforceRelationshipSchema('Account');

      expect(result?.fields).toEqual([]);
      expect(result?.relationships).toEqual([]);
      const loggedText = JSON.stringify(warnSpy.mock.calls);
      expect(loggedText).not.toContain(fieldTypeMarker);
      expect(loggedText).not.toContain(fieldLabelMarker);
      expect(loggedText).not.toContain(sourceFieldMarker);
      expect(loggedText).not.toContain(targetEntityMarker);
      expect(loggedText).not.toContain(targetFieldMarker);
    });

    it('treats a malformed response SHAPE (valid JSON, non-array fields) as the same bounded unparseable-response class, never letting the raw parser exception escape', async () => {
      const shapeMarker = 'leaked-malformed-shape-marker';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        // `fields` is a string, not an array — parseSalesforceDescribe's
        // `.flatMap` would throw a raw TypeError if this escaped unwrapped.
        json: async () => ({ fields: shapeMarker, childRelationships: [] }),
      }) as unknown as typeof fetch;

      const service = new SchemaDiscoveryService({
        salesforceRelationshipDiscovery: {
          mode: 'live',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'test-token',
        },
      });

      let caught: unknown;
      try {
        await service.discoverSalesforceRelationshipSchema('Account');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toBe('Salesforce relationship discovery failed: unparseable response');
      expect(message).not.toContain(shapeMarker);
    });
  });

  describe('SalesforceRelationshipDiscoveryConfig (type-level, B3.5)', () => {
    it('cannot construct a live mode without both credentials (compile-time)', () => {
      // @ts-expect-error — instanceUrl and accessToken are required when mode is 'live'.
      const missingBoth: SalesforceRelationshipDiscoveryConfig = { mode: 'live' };
      // @ts-expect-error — accessToken is required when mode is 'live'.
      const missingToken: SalesforceRelationshipDiscoveryConfig = {
        mode: 'live',
        instanceUrl: 'https://example.my.salesforce.com',
      };
      expect(missingBoth).toBeDefined();
      expect(missingToken).toBeDefined();
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
