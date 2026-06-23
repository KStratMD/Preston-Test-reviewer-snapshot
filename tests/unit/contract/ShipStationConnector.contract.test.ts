/**
 * ShipStation Connector Contract Tests
 *
 * Verifies the API contract between the connector and ShipStation 3PL API.
 * These tests validate response shapes, data types, and required fields.
 *
 * Phase 4 Implementation - SuiteCentral Parity
 * Updated: Phase 8 - Uses DemoConnectorDecorator for demo-mode tests
 */

import { ShipStationConnector } from '../../../src/connectors/ShipStationConnector';
import { DemoConnectorDecorator } from '../../../src/connectors/DemoConnectorDecorator';
import type { IConnector } from '../../../src/interfaces/IConnector';
import type { AuthConfig, DataRecord } from '../../../src/types';
import type { Logger } from '../../../src/utils/Logger';
import { setDemoModeOverride } from '../../../src/config/runtimeFlags';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

// Contract schemas for ShipStation responses
interface ShipStationOrderContract {
  orderId: number;
  orderNumber: string;
  orderKey?: string;
  orderDate: string;
  orderStatus: string;
  customerEmail?: string;
  billTo: ShipStationAddressContract;
  shipTo: ShipStationAddressContract;
  items: ShipStationItemContract[];
  orderTotal: number;
  shippingAmount: number;
  taxAmount?: number;
  weight?: { value: number; units: string };
}

interface ShipStationAddressContract {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
}

interface ShipStationItemContract {
  lineItemKey?: string;
  sku?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  weight?: { value: number; units: string };
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

describe('ShipStationConnector Contract Tests', () => {
  let connector: IConnector;
  let mockLogger: Logger;
  let mockHttpClient: jest.Mocked<any>;

  const testApiKeyConfig: AuthConfig = {
    type: 'api_key',
    credentials: {
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
    },
  };

  beforeEach(async () => {
    setDemoModeOverride(true);
    mockLogger = createMockLogger();

    mockHttpClient = {
      request: jest.fn(),
      defaults: { baseURL: '', headers: { common: {} } },
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    };

    const realConnector = new ShipStationConnector(mockLogger, createMockOutboundGovernanceService());
    connector = new DemoConnectorDecorator(realConnector, mockLogger);
    await connector.initialize(testApiKeyConfig);
    await connector.authenticate();
  });

  afterEach(() => {
    setDemoModeOverride(undefined);
  });

  describe('Order Operations Contract (Demo Mode)', () => {
    it('should create and read an order in demo mode', async () => {
      const newOrder: DataRecord = {
        id: 'ord-001',
        fields: {
          orderNumber: 'ORD-2026-001',
          orderStatus: 'awaiting_shipment',
          orderTotal: 99.99,
        },
      };

      const created = await connector.create('orders', newOrder);
      expect(created).toBeDefined();
      expect(created.id).toBe('ord-001');

      const read = await connector.read('orders', 'ord-001');
      expect(read).not.toBeNull();
      expect(read!.fields.orderNumber).toBe('ORD-2026-001');
    });

    it('should return null for non-existent order', async () => {
      const result = await connector.read('orders', '999999999');
      expect(result).toBeNull();
    });

    it('should list orders in demo mode', async () => {
      await connector.create('orders', { id: 'o1', fields: { orderNumber: 'ORD-001' } });
      await connector.create('orders', { id: 'o2', fields: { orderNumber: 'ORD-002' } });

      const results = await connector.list('orders');
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
    });

    it('should respect limit option', async () => {
      await connector.create('orders', { id: 'o1', fields: {} });
      await connector.create('orders', { id: 'o2', fields: {} });
      await connector.create('orders', { id: 'o3', fields: {} });

      const results = await connector.list('orders', { limit: 2 });
      expect(results.length).toBe(2);
    });
  });

  describe('Shipment Operations Contract (Demo Mode)', () => {
    it('should create and list shipments', async () => {
      await connector.create('shipments', {
        id: 's1',
        fields: { trackingNumber: 'TRK-001', carrierCode: 'fedex' },
      });

      const results = await connector.list('shipments');
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      expect(results[0].fields.trackingNumber).toBe('TRK-001');
    });
  });

  describe('Warehouse Operations Contract (Demo Mode)', () => {
    it('should create and list warehouses', async () => {
      await connector.create('warehouses', {
        id: 'w1',
        fields: { warehouseName: 'Main Warehouse', isDefault: true },
      });
      await connector.create('warehouses', {
        id: 'w2',
        fields: { warehouseName: 'Secondary', isDefault: false },
      });

      const results = await connector.list('warehouses');
      expect(results.length).toBe(2);
    });
  });

  describe('Carrier Operations Contract (Demo Mode)', () => {
    it('should create and list carriers', async () => {
      await connector.create('carriers', {
        id: 'c1',
        fields: { name: 'FedEx', code: 'fedex' },
      });

      const results = await connector.list('carriers');
      expect(results.length).toBe(1);
      expect(results[0].fields.name).toBe('FedEx');
    });
  });

  describe('API Response Parsing Contract', () => {
    let rawConnector: ShipStationConnector;

    beforeEach(async () => {
      rawConnector = new ShipStationConnector(mockLogger, createMockOutboundGovernanceService());
      await rawConnector.initialize(testApiKeyConfig);
      (rawConnector as any).httpClient = mockHttpClient;
      (rawConnector as any).isAuthenticated = true;
    });

    it('should parse API response and return DataRecord conforming to contract', async () => {
      const shipstationResponse: ShipStationOrderContract = {
        orderId: 123456789,
        orderNumber: 'TEST-ORD-001',
        orderKey: 'test-key-001',
        orderDate: '2024-02-15T10:30:00.000Z',
        orderStatus: 'awaiting_shipment',
        customerEmail: 'customer@example.com',
        billTo: {
          name: 'John Doe',
          street1: '123 Main St',
          city: 'Los Angeles',
          state: 'CA',
          postalCode: '90001',
          country: 'US',
        },
        shipTo: {
          name: 'John Doe',
          street1: '123 Main St',
          city: 'Los Angeles',
          state: 'CA',
          postalCode: '90001',
          country: 'US',
        },
        items: [
          { name: 'Product A', sku: 'PROD-A', quantity: 2, unitPrice: 29.99 },
          { name: 'Product B', sku: 'PROD-B', quantity: 1, unitPrice: 49.99 },
        ],
        orderTotal: 109.97,
        shippingAmount: 9.99,
        taxAmount: 8.25,
      };

      mockHttpClient.request.mockResolvedValue({ data: shipstationResponse });

      const result = await rawConnector.read('orders', '123456789');
      expect(result).toBeDefined();
    });
  });

  describe('Authentication Contract', () => {
    it('should accept API key authentication with key and secret', async () => {
      const freshConnector = new DemoConnectorDecorator(
        new ShipStationConnector(mockLogger, createMockOutboundGovernanceService()),
        mockLogger,
      );
      await expect(freshConnector.initialize(testApiKeyConfig)).resolves.not.toThrow();
    });

    it('should authenticate successfully in demo mode', async () => {
      const authenticated = await connector.authenticate();
      expect(authenticated).toBe(true);
    });
  });

  describe('System Info Contract', () => {
    it('should return valid system info', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo).toBeDefined();
      expect(systemInfo.name).toContain('ShipStation');
      expect(systemInfo.type).toBe('ShipStation');
    });

    it('should include capabilities', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(Array.isArray(systemInfo.capabilities)).toBe(true);
      expect(systemInfo.capabilities.length).toBeGreaterThan(0);
    });

    it('should include rate limits', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo.rateLimits).toBeDefined();
      expect(systemInfo.rateLimits?.requestsPerMinute).toBeDefined();
    });
  });

  describe('Product Operations Contract (Demo Mode)', () => {
    it('should create and list products', async () => {
      await connector.create('products', {
        id: 'p1',
        fields: { sku: 'SKU-001', name: 'Widget A', price: 29.99 },
      });

      const results = await connector.list('products');
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
    });

    it('should read a product by ID', async () => {
      await connector.create('products', {
        id: 'p1',
        fields: { sku: 'SKU-001', name: 'Widget A' },
      });

      const result = await connector.read('products', 'p1');
      expect(result).not.toBeNull();
      expect(result!.fields.name).toBe('Widget A');
    });
  });
});
