/**
 * NetSuite MCP Schema Adapter Tests - Phase 2
 *
 * Tests for NetSuiteMCPSchemaAdapter and NetSuiteMCPClient
 * Covers caching, fallback, health monitoring, and error handling
 */

import { NetSuiteMCPSchemaAdapter } from '../../../../../../src/services/netsuite/mcp/NetSuiteMCPSchemaAdapter';
import { NetSuiteMCPClient } from '../../../../../../src/services/netsuite/mcp/NetSuiteMCPClient';
import type { OAuth1Credentials } from '../../../../../../src/types';
import type { Logger } from '../../../../../../src/utils/Logger';

// Mock credentials
const mockCredentials: OAuth1Credentials = {
  accountId: 'TSTDRV2698307',
  consumerKey: 'test-consumer-key',
  consumerSecret: 'test-consumer-secret',
  tokenId: 'test-token-id',
  tokenSecret: 'test-token-secret'
};

// Mock logger
const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
} as unknown as Logger;

describe('NetSuiteMCPClient', () => {
  let client: NetSuiteMCPClient;

  beforeEach(() => {
    client = new NetSuiteMCPClient(mockCredentials, mockLogger);
    jest.clearAllMocks();
  });

  describe('Connection Management', () => {
    it('should initialize in disconnected state', () => {
      expect(client.isConnected()).toBe(false);
    });

    it('should connect successfully (prototype mode)', async () => {
      await client.connect();

      expect(client.isConnected()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Connecting to NetSuite MCP server',
        expect.objectContaining({
          accountId: mockCredentials.accountId
        })
      );
    });

    it('should handle duplicate connection attempts', async () => {
      await client.connect();
      await client.connect(); // Should warn

      expect(mockLogger.warn).toHaveBeenCalledWith('MCP client already connected');
    });

    it('should disconnect successfully', async () => {
      await client.connect();
      await client.disconnect();

      expect(client.isConnected()).toBe(false);
    });
  });

  describe('Tool Listing', () => {
    beforeEach(async () => {
      await client.connect();
    });

    it('should list expected MCP tools', async () => {
      const tools = await client.listTools();

      expect(tools).toHaveLength(6);
      expect(tools.map(t => t.name)).toEqual([
        'netsuite_get_tables',
        'netsuite_get_columns',
        'netsuite_run_query',
        'netsuite_run_saved_search',
        'netsuite_create_record',
        'netsuite_update_record'
      ]);
    });

    it('should include schema discovery tool', async () => {
      const tools = await client.listTools();
      const schemaTool = tools.find(t => t.name === 'netsuite_get_columns');

      expect(schemaTool).toBeDefined();
      expect(schemaTool?.description).toContain('field metadata');
      expect(schemaTool?.inputSchema.required).toContain('recordType');
    });
  });

  describe('Schema Discovery', () => {
    beforeEach(async () => {
      await client.connect();
    });

    it('should return customer schema (prototype mode)', async () => {
      const schema = await client.getEntitySchema('customer');

      expect(schema.entityType).toBe('customer');
      expect(schema.fields.length).toBeGreaterThan(0);
      expect(schema.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'companyName', type: 'string', required: true }),
          expect.objectContaining({ name: 'email', type: 'string' })
        ])
      );
    });

    it('should return vendor schema', async () => {
      const schema = await client.getEntitySchema('vendor');

      expect(schema.entityType).toBe('vendor');
      expect(schema.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'companyName' }),
          expect.objectContaining({ name: 'legalName' }),
          expect.objectContaining({ name: 'taxId' })
        ])
      );
    });

    it('should return item schema', async () => {
      const schema = await client.getEntitySchema('item');

      expect(schema.entityType).toBe('item');
      expect(schema.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'itemId' }),
          expect.objectContaining({ name: 'displayName' }),
          expect.objectContaining({ name: 'basePrice' })
        ])
      );
    });

    it('should return default schema for unknown entities', async () => {
      const schema = await client.getEntitySchema('unknownType');

      expect(schema.entityType).toBe('unknownType');
      expect(schema.fields.length).toBeGreaterThan(0); // Should have at least common fields
    });
  });

  describe('Error Handling', () => {
    it('should throw error when calling methods before connection', async () => {
      await expect(client.listTools()).rejects.toThrow('not connected');
      await expect(client.getEntitySchema('customer')).rejects.toThrow('not connected');
    });

    it('should throw error for SuiteQL execution (not yet implemented)', async () => {
      await client.connect();

      await expect(client.executeSuiteQL('SELECT * FROM customer')).rejects.toThrow(
        'not yet implemented'
      );
    });
  });
});

describe('NetSuiteMCPSchemaAdapter', () => {
  let adapter: NetSuiteMCPSchemaAdapter;

  beforeEach(() => {
    adapter = new NetSuiteMCPSchemaAdapter(mockCredentials, mockLogger);
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize successfully in fallback mode', async () => {
      await adapter.initialize();

      const health = adapter.getHealthStatus();
      expect(health.connected).toBe(true); // Connected in prototype mode
      expect(mockLogger.info).toHaveBeenCalledWith(
        'MCP schema adapter initialized',
        expect.any(Object)
      );
    });

    it('should handle duplicate initialization', async () => {
      await adapter.initialize();
      await adapter.initialize(); // Should warn

      expect(mockLogger.warn).toHaveBeenCalledWith('MCP schema adapter already initialized');
    });

    it('should initialize with custom config', async () => {
      const customAdapter = new NetSuiteMCPSchemaAdapter(mockCredentials, mockLogger, {
        cacheEnabled: false,
        cacheTTL: 60000,
        enableFallback: false,
        maxRetries: 5
      });

      await expect(customAdapter.initialize()).resolves.not.toThrow();
    });
  });

  describe('Schema Discovery', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should fetch customer schema', async () => {
      const schema = await adapter.getSchema('customer');

      expect(schema.system).toBe('NetSuite');
      expect(schema.entity).toBe('customer');
      expect(schema.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'companyName', required: true })
        ])
      );
    });

    it('should fetch vendor schema', async () => {
      const schema = await adapter.getSchema('vendor');

      expect(schema.system).toBe('NetSuite');
      expect(schema.entity).toBe('vendor');
      expect(schema.fields.length).toBeGreaterThan(0);
    });

    it('should fetch item schema', async () => {
      const schema = await adapter.getSchema('item');

      expect(schema.system).toBe('NetSuite');
      expect(schema.entity).toBe('item');
    });

    it('should throw error when not initialized', async () => {
      const uninitializedAdapter = new NetSuiteMCPSchemaAdapter(mockCredentials, mockLogger);

      await expect(uninitializedAdapter.getSchema('customer')).rejects.toThrow('not initialized');
    });
  });

  describe('Caching', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should cache schema on first fetch', async () => {
      await adapter.getSchema('customer');

      const stats = adapter.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.entries[0].key).toBe('netsuite:customer');
    });

    it('should return cached schema on second fetch', async () => {
      // First fetch
      await adapter.getSchema('customer');

      // Second fetch (should use cache)
      const schema = await adapter.getSchema('customer');

      expect(schema).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Schema retrieved from cache',
        expect.any(Object)
      );
    });

    it('should cache multiple entities', async () => {
      await adapter.getSchema('customer');
      await adapter.getSchema('vendor');
      await adapter.getSchema('item');

      const stats = adapter.getCacheStats();
      expect(stats.size).toBe(3);
    });

    it('should clear specific entity cache', async () => {
      await adapter.getSchema('customer');
      await adapter.getSchema('vendor');

      adapter.clearCache('customer');

      const stats = adapter.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.entries[0].key).toBe('netsuite:vendor');
    });

    it('should clear all cache', async () => {
      await adapter.getSchema('customer');
      await adapter.getSchema('vendor');

      adapter.clearCache();

      const stats = adapter.getCacheStats();
      expect(stats.size).toBe(0);
    });

    it('should track cache source (mcp vs fallback)', async () => {
      await adapter.getSchema('customer');

      const stats = adapter.getCacheStats();
      expect(stats.entries[0].source).toMatch(/mcp|fallback/);
    });
  });

  describe('Health Monitoring', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should report health status', () => {
      const health = adapter.getHealthStatus();

      expect(health).toHaveProperty('connected');
      expect(health).toHaveProperty('consecutiveFailures');
      expect(health).toHaveProperty('uptime');
    });

    it('should track last successful query', async () => {
      await adapter.getSchema('customer');

      const health = adapter.getHealthStatus();
      expect(health.lastSuccessfulQuery).toBeDefined();
      expect(health.lastSuccessfulQuery).toBeInstanceOf(Date);
    });

    it('should be connected after initialization', () => {
      const health = adapter.getHealthStatus();
      expect(health.connected).toBe(true);
    });
  });

  describe('Disconnect', () => {
    it('should disconnect successfully', async () => {
      await adapter.initialize();
      await adapter.disconnect();

      const health = adapter.getHealthStatus();
      expect(health.connected).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      await expect(adapter.disconnect()).resolves.not.toThrow();
    });
  });
});

describe('Schema Discovery Service Integration', () => {
  it('should integrate with SchemaDiscoveryService (architectural test)', async () => {
    const adapter = new NetSuiteMCPSchemaAdapter(mockCredentials, mockLogger);
    await adapter.initialize();

    // Simulate SchemaDiscoveryService usage
    const schema = await adapter.getSchema('customer');

    expect(schema.system).toBe('NetSuite');
    expect(schema.fields.length).toBeGreaterThan(0);
    expect(schema.metadata?.source).toMatch(/api|manual/);
  });
});
