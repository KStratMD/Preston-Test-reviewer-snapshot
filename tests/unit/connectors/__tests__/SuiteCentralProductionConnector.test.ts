// This test uses real timers because it tests connector operations with retry logic
jest.useRealTimers();

import { SuiteCentralProductionConnector } from '../../../../src/connectors/SuiteCentralProductionConnector';
import { Logger } from '../../../../src/utils/Logger';
import { AuthConfig } from '../../../../src/types';
import type { AuthService } from '../../../../src/services/AuthService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const mockAuthService = {
  validateCredentials: jest.fn().mockResolvedValue(true),
  refreshToken: jest.fn().mockResolvedValue('mock-token'),
} as unknown as AuthService;

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  SUITECENTRAL_BASE_URL: process.env.SUITECENTRAL_BASE_URL,
  SUITECENTRAL_PRODUCTION_MODE: process.env.SUITECENTRAL_PRODUCTION_MODE,
  SUITECENTRAL_API_KEY: process.env.SUITECENTRAL_API_KEY,
};

describe('SuiteCentralProductionConnector', () => {
  let connector: SuiteCentralProductionConnector;

  beforeEach(async () => {
    // Set demo mode environment
    process.env.NODE_ENV = 'test';
    process.env.SUITECENTRAL_BASE_URL = 'https://demo.suitecentral.integration-hub.local/api/v1';
    process.env.SUITECENTRAL_PRODUCTION_MODE = 'false';
    delete process.env.SUITECENTRAL_API_KEY; // Force demo mode

    connector = new SuiteCentralProductionConnector(
      'SuiteCentral',
      'suitecentral-test',
      mockLogger,
      mockAuthService
    );

    // Initialize connector in demo mode
    await connector.initialize({
      type: 'api_key',
      credentials: {
        apiKey: 'demo-key',
        productionMode: false,
      },
    });
  });

  afterEach(() => {
    // Restore environment
    Object.keys(originalEnv).forEach((key) => {
      const value = originalEnv[key as keyof typeof originalEnv];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });

    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize in demo mode when no production credentials', async () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        'SuiteCentral Production connector initialized',
        expect.objectContaining({
          productionMode: false,
          supportedModules: expect.arrayContaining(['SupplierCentral', 'InstallerCentral']),
        })
      );
    });

    it('should set correct base URL for demo mode', () => {
      const baseUrl = (connector as any).baseUrl || (connector as any).httpClient?.defaults?.baseURL;
      expect(baseUrl).toContain('suitecentral');
    });

    it('should configure supported modules', () => {
      const modules = (connector as any).supportedModules;
      expect(modules).toContain('SupplierCentral');
      expect(modules).toContain('InstallerCentral');
      expect(modules).toContain('PayoutCentral');
      expect(modules).toContain('CustomerCentral');
      expect(modules).toContain('ServiceCentral');
      expect(modules).toContain('InventoryCentral');
    });

    it('should seed demo data in non-production mode', async () => {
      // Verify data was seeded by attempting to list
      const suppliers = await connector.list('suppliers', { limit: 10 });
      expect(Array.isArray(suppliers)).toBe(true);
    });

    it('should throw error for non-API key authentication', async () => {
      const newConnector = new SuiteCentralProductionConnector(
        'SuiteCentral',
        'test',
        mockLogger,
        mockAuthService
      );

      await expect(
        newConnector.initialize({
          type: 'oauth2' as any,
          credentials: { clientId: 'test', clientSecret: 'test' },
        })
      ).rejects.toThrow('API key authentication');
    });
  });

  describe('getSystemInfo', () => {
    it('should return system information', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo).toBeDefined();
      expect(systemInfo.name).toContain('SuiteCentral');
      expect(systemInfo.type).toBe('SuiteCentral');
      expect(systemInfo.version).toBeDefined();
    });

    it('should return module information in capabilities', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo.capabilities).toBeDefined();
      expect(Array.isArray(systemInfo.capabilities)).toBe(true);
    });

    it('should return endpoint URLs', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo.endpoints).toBeDefined();
      expect(systemInfo.endpoints?.baseUrl).toBeDefined();
      expect(systemInfo.endpoints?.authUrl).toBeDefined();
      expect(systemInfo.endpoints?.webhookUrl).toBeDefined();
    });
  });

  describe('CRUD operations - SupplierCentral', () => {
    it('should create a supplier record', async () => {
      const supplierData = {
        name: 'Acme Supplies Inc',
        email: 'contact@acme.com',
        phone: '555-0100',
        address: '123 Main St',
      };

      const created = await connector.create('suppliers', supplierData);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).name).toBe('Acme Supplies Inc');
      expect((created as any)._suiteCentral).toBeDefined();
      expect((created as any)._suiteCentral.demo).toBe(true);
    });

    it('should read a supplier record', async () => {
      // First create a supplier
      const created = await connector.create('suppliers', {
        name: 'Test Supplier',
        email: 'test@supplier.com',
      });

      const supplierId = (created as any).id;

      // Now read it
      const supplier = await connector.read('suppliers', supplierId);

      expect(supplier).toBeDefined();
      expect((supplier as any).id).toBe(supplierId);
      expect((supplier as any).name).toBe('Test Supplier');
    });

    it('update() throws not-implemented for supplier (placeholder method — pins contract)', async () => {
      await expect(connector.update('suppliers', 'sup-1', { name: 'Renamed' })).rejects.toThrow(
        'Update method implementation needed',
      );
    });

    it('delete() throws not-implemented for supplier (placeholder method — pins contract)', async () => {
      await expect(connector.delete('suppliers', 'sup-1')).rejects.toThrow(
        'Delete method implementation needed',
      );
    });

    it('should list supplier records', async () => {
      // Create some suppliers
      await connector.create('suppliers', { name: 'Supplier 1', email: 's1@test.com' });
      await connector.create('suppliers', { name: 'Supplier 2', email: 's2@test.com' });

      const suppliers = await connector.list('suppliers', { limit: 10 });

      expect(Array.isArray(suppliers)).toBe(true);
      expect(suppliers.length).toBeGreaterThan(0);
    });

    it('should support pagination with limit', async () => {
      // Create multiple suppliers
      for (let i = 0; i < 5; i++) {
        await connector.create('suppliers', { name: `Supplier ${i}`, email: `s${i}@test.com` });
      }

      const page1 = await connector.list('suppliers', { limit: 2 });
      const page2 = await connector.list('suppliers', { limit: 3 });

      expect(page1.length).toBeLessThanOrEqual(2);
      expect(page2.length).toBeLessThanOrEqual(3);
    });

    it('search() throws not-implemented for supplier (placeholder method — pins contract)', async () => {
      await expect(connector.search('suppliers', { filters: { name: 'anything' } })).rejects.toThrow(
        'Search method implementation needed',
      );
    });
  });

  describe('CRUD operations - InstallerCentral', () => {
    it('should create an installer record', async () => {
      const installerData = {
        name: 'Pro Install Services',
        email: 'info@proinstall.com',
        certifications: ['HVAC', 'Electrical'],
      };

      const created = await connector.create('installers', installerData);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).name).toBe('Pro Install Services');
    });

    it('should list installer records', async () => {
      await connector.create('installers', { name: 'Installer 1', email: 'i1@test.com' });
      await connector.create('installers', { name: 'Installer 2', email: 'i2@test.com' });

      const installers = await connector.list('installers', { limit: 10 });

      expect(Array.isArray(installers)).toBe(true);
      expect(installers.length).toBeGreaterThan(0);
    });

    it('should read an installer record', async () => {
      const created = await connector.create('installers', {
        name: 'Test Installer',
        email: 'test@installer.com',
      });

      const installerId = (created as any).id;
      const installer = await connector.read('installers', installerId);

      expect(installer).toBeDefined();
      expect((installer as any).id).toBe(installerId);
    });
  });

  describe('CRUD operations - PayoutCentral', () => {
    it('should create a payout record', async () => {
      const payoutData = {
        amount: 5000.0,
        currency: 'USD',
        recipientId: 'recipient-123',
        status: 'pending',
      };

      const created = await connector.create('payouts', payoutData);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).amount).toBe(5000.0);
    });

    it('should list payout records', async () => {
      await connector.create('payouts', {
        amount: 1000,
        currency: 'USD',
        recipientId: 'r1',
        status: 'pending',
      });

      const payouts = await connector.list('payouts', { limit: 10 });

      expect(Array.isArray(payouts)).toBe(true);
      expect(payouts.length).toBeGreaterThan(0);
    });

    it('update() throws not-implemented for payouts (placeholder method — pins contract)', async () => {
      await expect(connector.update('payouts', 'pay-1', { status: 'completed' })).rejects.toThrow(
        'Update method implementation needed',
      );
    });
  });

  describe('CRUD operations - CustomerCentral', () => {
    it('should create a customer record', async () => {
      const customerData = {
        firstName: 'John',
        lastName: 'Customer',
        email: 'john@customer.com',
        phone: '555-0200',
      };

      const created = await connector.create('customers', customerData);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).firstName).toBe('John');
    });

    it('should list customer records', async () => {
      await connector.create('customers', {
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@customer.com',
      });

      const customers = await connector.list('customers', { limit: 10 });

      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    it('should handle reading non-existent record gracefully', async () => {
      const result = await connector.read('suppliers', 'non-existent-id-999');
      expect(result).toBeNull();
    });

    it('update() of non-existent record throws not-implemented before id check (placeholder)', async () => {
      await expect(connector.update('suppliers', 'missing-id', {})).rejects.toThrow(
        'Update method implementation needed',
      );
    });

    it('delete() of non-existent record throws not-implemented before id check (placeholder)', async () => {
      await expect(connector.delete('suppliers', 'missing-id')).rejects.toThrow(
        'Delete method implementation needed',
      );
    });

    it('should handle invalid entity type gracefully', async () => {
      const result = await connector.list('invalid-type' as any, {});
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('module routing', () => {
    it('should route supplier entities to SupplierCentral module', async () => {
      const created = await connector.create('suppliers', { name: 'Test' });
      expect((created as any)._suiteCentral?.module).toBe('SupplierCentral');
    });

    it('should route installer entities to InstallerCentral module', async () => {
      const created = await connector.create('installers', { name: 'Test' });
      expect((created as any)._suiteCentral?.module).toBe('InstallerCentral');
    });

    it('should route payout entities to PayoutCentral module', async () => {
      const created = await connector.create('payouts', { amount: 100, currency: 'USD' });
      expect((created as any)._suiteCentral?.module).toBe('PayoutCentral');
    });

    it('should route customer entities to CustomerCentral module', async () => {
      const created = await connector.create('customers', { firstName: 'Test' });
      expect((created as any)._suiteCentral?.module).toBe('CustomerCentral');
    });
  });

  describe('demo mode metadata', () => {
    it('should add SuiteCentral metadata to created records', async () => {
      const created = await connector.create('suppliers', {
        name: 'Metadata Test',
        email: 'metadata@test.com',
      });

      expect((created as any)._suiteCentral).toBeDefined();
      expect((created as any)._suiteCentral.demo).toBe(true);
      expect((created as any)._suiteCentral.tenantId).toBeDefined();
      expect((created as any)._suiteCentral.module).toBeDefined();
    });

    it('should add lastModified timestamp to records', async () => {
      const created = await connector.create('suppliers', { name: 'Timestamp Test' });

      expect((created as any).lastModified).toBeDefined();
      expect(typeof (created as any).lastModified).toBe('string');
    });
  });

  describe('formatDataFromSuiteCentral - ID coercion', () => {
    // Codex P1 (PR #667): numeric ids/externalIds in upstream payloads must be
    // coerced to strings, not silently dropped to '' — that broke record identity
    // for createProduction / readProduction / listProduction return paths.
    it('should coerce numeric id to string and preserve identity', () => {
      const payload = { id: 12345, name: 'Acme', lastModified: '2026-01-01T00:00:00Z' };
      const formatted = (connector as any).formatDataFromSuiteCentral(
        payload,
        'suppliers',
        'SupplierCentral',
      );
      expect(formatted.id).toBe('12345');
      expect(formatted.externalId).toBe('12345');
    });

    it('should coerce numeric externalId to string', () => {
      const payload = { externalId: 9876, name: 'Coerce', lastModified: '2026-01-01T00:00:00Z' };
      const formatted = (connector as any).formatDataFromSuiteCentral(
        payload,
        'suppliers',
        'SupplierCentral',
      );
      expect(formatted.id).toBe('9876');
      expect(formatted.externalId).toBe('9876');
    });

    it('should still pass through string ids unchanged', () => {
      const payload = { id: 'abc-123', externalId: 'ext-456' };
      const formatted = (connector as any).formatDataFromSuiteCentral(
        payload,
        'suppliers',
        'SupplierCentral',
      );
      expect(formatted.id).toBe('abc-123');
      expect(formatted.externalId).toBe('ext-456');
    });

    it('should fall back to empty string for non-string/non-number ids', () => {
      const payload = { id: { weird: 'shape' } };
      const formatted = (connector as any).formatDataFromSuiteCentral(
        payload,
        'suppliers',
        'SupplierCentral',
      );
      expect(formatted.id).toBe('');
      expect(formatted.externalId).toBe('');
    });
  });

  describe('change tracking', () => {
    it('should track create operations', async () => {
      const created = await connector.create('suppliers', {
        name: 'Track Create',
        email: 'track@create.com',
      });

      // Change tracking is internal, but verify the record exists
      const supplierId = (created as any).id;
      const read = await connector.read('suppliers', supplierId);
      expect(read).toBeDefined();
    });

    it('cannot track update operations because update() is a placeholder that throws', async () => {
      await expect(connector.update('suppliers', 'sup-1', { name: 'Renamed' })).rejects.toThrow(
        'Update method implementation needed',
      );
    });

    it('cannot track delete operations because delete() is a placeholder that throws', async () => {
      await expect(connector.delete('suppliers', 'sup-1')).rejects.toThrow(
        'Delete method implementation needed',
      );
    });
  });

  describe('search operations', () => {
    it('search() across multiple fields throws not-implemented (placeholder method)', async () => {
      await expect(
        connector.search('suppliers', { filters: { name: 'multi', email: 'field' } }),
      ).rejects.toThrow('Search method implementation needed');
    });

    it('search() with no matches throws not-implemented before result aggregation (placeholder)', async () => {
      await expect(
        connector.search('suppliers', { filters: { name: 'no-matches' } }),
      ).rejects.toThrow('Search method implementation needed');
    });
  });

  describe('pagination and limits', () => {
    it('should respect offset parameter', async () => {
      // Create multiple records
      for (let i = 0; i < 5; i++) {
        await connector.create('suppliers', {
          name: `Supplier ${i}`,
          email: `supplier${i}@test.com`,
        });
      }

      const page1 = await connector.list('suppliers', { limit: 2, offset: 0 });
      const page2 = await connector.list('suppliers', { limit: 2, offset: 2 });

      expect(page1.length).toBeGreaterThan(0);
      expect(page2.length).toBeGreaterThan(0);

      // Verify different results
      const id1 = (page1[0] as any).id;
      const id2 = (page2[0] as any).id;
      expect(id1).not.toBe(id2);
    });

    it('should handle large limit values', async () => {
      const results = await connector.list('suppliers', { limit: 1000 });

      expect(Array.isArray(results)).toBe(true);
    });
  });
});
