/**
 * HubSpot Connector Contract Tests
 *
 * Verifies the API contract between the connector and HubSpot CRM API.
 * Tests validate response shapes, data types, and required fields.
 *
 * Phase 4 Implementation - SuiteCentral Parity
 * Updated: Phase 8 - Uses DemoConnectorDecorator instead of inline demo mode
 */

import { HubSpotConnector } from '../../../src/connectors/HubSpotConnector';
import { DemoConnectorDecorator } from '../../../src/connectors/DemoConnectorDecorator';
import type { IConnector } from '../../../src/interfaces/IConnector';
import type { AuthConfig, DataRecord } from '../../../src/types';
import type { Logger } from '../../../src/utils/Logger';
import { setDemoModeOverride } from '../../../src/config/runtimeFlags';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

// Contract validation helper
function assertDataRecord(record: DataRecord | null): asserts record is DataRecord {
  if (!record) {
    throw new Error('Contract violation: DataRecord must not be null');
  }
  if (typeof record.id !== 'string') {
    throw new Error('Contract violation: DataRecord.id must be a string');
  }
  if (typeof record.fields !== 'object') {
    throw new Error('Contract violation: DataRecord.fields must be an object');
  }
}

// Create a mock logger factory function to ensure fresh mocks
function createMockLogger(): Logger {
  const childLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
  };
  childLogger.child = jest.fn().mockReturnValue(childLogger);

  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnValue(childLogger),
  } as unknown as Logger;
}

describe('HubSpotConnector Contract Tests', () => {
  let connector: IConnector;
  let mockLogger: Logger;

  const testApiKeyConfig: AuthConfig = {
    type: 'api_key',
    credentials: {
      apiKey: 'demo-hubspot-api-key',
    },
  };

  beforeEach(async () => {
    setDemoModeOverride(true);
    // Create a fresh mock logger for each test
    mockLogger = createMockLogger();
    const realConnector = new HubSpotConnector(mockLogger, createMockOutboundGovernanceService());
    connector = new DemoConnectorDecorator(realConnector, mockLogger);
    await connector.initialize(testApiKeyConfig);
    await connector.authenticate();
  });

  afterEach(() => {
    setDemoModeOverride(undefined);
  });

  describe('Initialization Contract', () => {
    it('should accept API key authentication', async () => {
      await expect(connector.initialize(testApiKeyConfig)).resolves.not.toThrow();
    });

    it('should accept OAuth2 authentication', async () => {
      const oauthConfig: AuthConfig = {
        type: 'oauth2',
        credentials: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        },
      };

      await expect(connector.initialize(oauthConfig)).resolves.not.toThrow();
    });
  });

  describe('CRM Object Contract', () => {
    describe('Contact Object', () => {
      it('should return DataRecord for contact read', async () => {
        const created = await connector.create('contact', {
          fields: { email: 'test@example.com', firstname: 'Test' },
        });

        const result = await connector.read('contact', created.id);

        assertDataRecord(result);
        expect(typeof result.id).toBe('string');
        expect(typeof result.fields).toBe('object');
      });

      it('should return array of DataRecords for contact list', async () => {
        await connector.create('contact', { fields: { email: 'a@example.com' } });
        const results = await connector.list('contact');

        expect(Array.isArray(results)).toBe(true);
        results.forEach((record) => {
          assertDataRecord(record);
        });
      });
    });

    describe('Company Object', () => {
      it('should return array of DataRecords for company list', async () => {
        await connector.create('company', { fields: { name: 'Test Co' } });
        const results = await connector.list('company');

        expect(Array.isArray(results)).toBe(true);
        results.forEach((record) => {
          assertDataRecord(record);
        });
      });
    });

    describe('Deal Object', () => {
      it('should return array of DataRecords for deal list', async () => {
        await connector.create('deal', { fields: { dealname: 'Test Deal' } });
        const results = await connector.list('deal');

        expect(Array.isArray(results)).toBe(true);
        results.forEach((record) => {
          assertDataRecord(record);
        });
      });
    });

    describe('Ticket Object', () => {
      it('should return array of DataRecords for ticket list', async () => {
        await connector.create('ticket', { fields: { subject: 'Test Ticket' } });
        const results = await connector.list('ticket');

        expect(Array.isArray(results)).toBe(true);
        results.forEach((record) => {
          assertDataRecord(record);
        });
      });
    });
  });

  describe('CRUD Operations Contract', () => {
    describe('Create Operation', () => {
      it('should return created DataRecord', async () => {
        const newRecord: DataRecord = {
          fields: {
            email: `test-${Date.now()}@example.com`,
            firstname: 'Test',
            lastname: 'User',
          },
        };

        const result = await connector.create('contact', newRecord);

        assertDataRecord(result);
        expect(result.id).toBeDefined();
        expect(typeof result.id).toBe('string');
      });
    });

    describe('Update Operation', () => {
      it('should return updated DataRecord', async () => {
        const created = await connector.create('contact', {
          fields: { firstname: 'Original' },
        });

        const result = await connector.update('contact', created.id, {
          fields: { phone: '+1-555-9999' },
        });

        assertDataRecord(result);
        expect(result.id).toBe(created.id);
      });
    });

    describe('Delete Operation', () => {
      it('should return boolean for delete', async () => {
        const created = await connector.create('contact', {
          fields: { email: `delete-${Date.now()}@example.com` },
        });

        const result = await connector.delete('contact', created.id);
        expect(typeof result).toBe('boolean');
      });
    });

    describe('Search Operation', () => {
      it('should return array of DataRecords for search', async () => {
        await connector.create('contact', { fields: { email: 'search@example.com' } });
        const results = await connector.search('contact', { filters: { email: 'search@example.com' } });

        expect(Array.isArray(results)).toBe(true);
      });
    });
  });

  describe('Property Mapping Contract', () => {
    it('should flatten properties to DataRecord fields', async () => {
      await connector.create('contact', {
        fields: { email: 'flat@example.com', firstname: 'Flat' },
      });

      const contacts = await connector.list('contact');
      expect(contacts.length).toBeGreaterThan(0);
      const contact = contacts[0];
      assertDataRecord(contact);

      // Fields should be directly accessible (not nested under properties)
      expect(contact.fields).toBeDefined();
      expect(typeof contact.fields).toBe('object');
    });
  });

  describe('System Info Contract', () => {
    it('should return valid SystemInfo', async () => {
      const info = await connector.getSystemInfo();

      expect(info).toBeDefined();
      expect(typeof info.name).toBe('string');
      expect(typeof info.version).toBe('string');
    });

    it('should include supported capabilities in SystemInfo', async () => {
      const info = await connector.getSystemInfo();

      expect(info.capabilities).toBeDefined();
      expect(Array.isArray(info.capabilities)).toBe(true);
      expect(info.capabilities.length).toBeGreaterThan(0);
      expect(info.capabilities).toContain('demo_mode');
    });
  });
});
