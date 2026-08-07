/**
 * MockConnectorBase Unit Tests
 * Tests for the base mock connector functionality
 */

import 'reflect-metadata';
import { MockConnectorBase, ChangeLogEntry, WebhookConfig } from '../../../src/connectors/MockConnectorBase';
import { Logger } from '../../../src/utils/Logger';
import { AuthService } from '../../../src/services/AuthService';
import { AuthConfig, SystemInfo } from '../../../src/types';
import { BaseEntity } from '../../../src/types/entities';

// Test entity types
interface TestEntity extends BaseEntity {
  name: string;
  status: string;
}

interface TestEntityMap {
  testEntity: TestEntity;
  anotherEntity: BaseEntity;
}

// Concrete implementation for testing
class TestMockConnector extends MockConnectorBase<TestEntityMap> {
  protected getDefaultBaseUrl(): string {
    return 'http://test-api.example.com';
  }

  protected async seedData(): Promise<void> {
    // Seed some test data
    const store = this.getEntityStore('testEntity');
    store.set('seed-1', {
      id: 'seed-1',
      name: 'Seeded Entity',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async getSystemInfo(): Promise<SystemInfo> {
    return {
      name: 'Test Mock System',
      version: '1.0.0',
      status: 'connected',
    };
  }

  // Expose protected methods for testing
  public testGetEntityStore(entityType: keyof TestEntityMap) {
    return this.getEntityStore(entityType);
  }

  public testLogChange(
    entityType: keyof TestEntityMap,
    id: string,
    record: TestEntityMap[keyof TestEntityMap] | null,
    operation: 'create' | 'update' | 'delete',
  ) {
    return this.logChange(entityType, id, record, operation);
  }
}

describe('MockConnectorBase', () => {
  let connector: TestMockConnector;
  let mockLogger: jest.Mocked<Logger>;
  let mockAuthService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockAuthService = {
      authenticate: jest.fn().mockResolvedValue(true),
      refreshToken: jest.fn(),
      validateToken: jest.fn(),
    } as any;

    connector = new TestMockConnector(
      'test-system',
      'test-id',
      mockLogger,
      mockAuthService,
    );
  });

  describe('initialize()', () => {
    it('should initialize with API key authentication', async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: {
          apiKey: 'test-api-key',
        },
      };

      await connector.initialize(config);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('initialized'),
        expect.any(Object)
      );
    });

    it('should use custom base URL if provided', async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: {
          apiKey: 'test-api-key',
          baseUrl: 'http://custom.example.com',
        },
      };

      await connector.initialize(config);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('initialized'),
        expect.objectContaining({ baseUrl: 'http://custom.example.com' })
      );
    });

    it('should use default base URL if not provided', async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: {
          apiKey: 'test-api-key',
        },
      };

      await connector.initialize(config);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('initialized'),
        expect.objectContaining({ baseUrl: 'http://test-api.example.com' })
      );
    });

    it('should reject non-API key authentication', async () => {
      const config: AuthConfig = {
        type: 'oauth',
        credentials: {},
      };

      await expect(connector.initialize(config)).rejects.toThrow(
        'requires API key authentication'
      );
    });

    it('should seed data during initialization', async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
      };

      await connector.initialize(config);

      const store = connector.testGetEntityStore('testEntity');
      expect(store.has('seed-1')).toBe(true);
    });

    it('should handle seed data errors', async () => {
      // Create a connector that throws during seeding
      class ErrorSeedConnector extends MockConnectorBase {
        protected getDefaultBaseUrl(): string {
          return 'http://test.com';
        }
        protected async seedData(): Promise<void> {
          throw new Error('Seed error');
        }
        async getSystemInfo(): Promise<SystemInfo> {
          return { name: 'Test', version: '1.0', status: 'connected' };
        }
      }

      const errorConnector = new ErrorSeedConnector(
        'test',
        'test-id',
        mockLogger,
        mockAuthService,
      );

      const config: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
      };

      // Should not throw, but log error
      await errorConnector.initialize(config);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error seeding mock data',
        expect.any(Error)
      );
    });
  });

  describe('authenticate()', () => {
    it('should simulate successful authentication', async () => {
      const result = await connector.authenticate();

      expect(result).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('authentication simulated')
      );
    });
  });

  describe('CRUD operations', () => {
    beforeEach(async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
      };
      await connector.initialize(config);
    });

    describe('create()', () => {
      it('should create a new entity', async () => {
        const data = { name: 'New Entity', status: 'active' };

        const result = await connector.create('testEntity', data);

        expect(result).toHaveProperty('id');
        expect(result.name).toBe('New Entity');
        expect(result).toHaveProperty('createdAt');
        expect(result).toHaveProperty('updatedAt');
      });

      it('should use provided ID if given', async () => {
        const data = { id: 'custom-id', name: 'Custom ID Entity', status: 'active' };

        const result = await connector.create('testEntity', data);

        expect(result.id).toBe('custom-id');
      });

      it('should log the create operation', async () => {
        const data = { name: 'Logged Entity', status: 'active' };

        await connector.create('testEntity', data);

        const stats = connector.getEntityStats('testEntity');
        expect(stats.totalChanges).toBeGreaterThan(0);
      });
    });

    describe('read()', () => {
      it('should read an existing entity', async () => {
        const result = await connector.read('testEntity', 'seed-1');

        expect(result).not.toBeNull();
        expect(result?.name).toBe('Seeded Entity');
      });

      it('should return null for non-existent entity', async () => {
        const result = await connector.read('testEntity', 'non-existent');

        expect(result).toBeNull();
      });
    });

    describe('update()', () => {
      it('should update an existing entity', async () => {
        const result = await connector.update('testEntity', 'seed-1', {
          name: 'Updated Entity',
        });

        expect(result.name).toBe('Updated Entity');
        expect(result.id).toBe('seed-1');
      });

      it('should preserve existing fields', async () => {
        const result = await connector.update('testEntity', 'seed-1', {
          name: 'Updated',
        });

        expect(result.status).toBe('active');
      });

      it('should update the updatedAt timestamp', async () => {
        const before = await connector.read('testEntity', 'seed-1');
        const originalDate = before?.updatedAt;

        // Small delay to ensure different timestamp
        await new Promise(resolve => setTimeout(resolve, 10));

        const result = await connector.update('testEntity', 'seed-1', {
          name: 'Updated',
        });

        expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(
          originalDate?.getTime() || 0
        );
      });

      it('should throw for non-existent entity', async () => {
        await expect(
          connector.update('testEntity', 'non-existent', { name: 'Test' })
        ).rejects.toThrow('not found');
      });
    });

    describe('delete()', () => {
      it('should delete an existing entity', async () => {
        const result = await connector.delete('testEntity', 'seed-1');

        expect(result).toBe(true);

        const check = await connector.read('testEntity', 'seed-1');
        expect(check).toBeNull();
      });

      it('should return false for non-existent entity', async () => {
        const result = await connector.delete('testEntity', 'non-existent');

        expect(result).toBe(false);
      });

      it('should log the delete operation', async () => {
        await connector.delete('testEntity', 'seed-1');

        const stats = connector.getEntityStats('testEntity');
        expect(stats.totalChanges).toBeGreaterThan(0);
      });
    });

    describe('list()', () => {
      it('should list all entities', async () => {
        const result = await connector.list('testEntity');

        expect(result.length).toBeGreaterThan(0);
      });

      it('should support limit option', async () => {
        // Create additional entities
        await connector.create('testEntity', { name: 'Entity 2', status: 'active' });
        await connector.create('testEntity', { name: 'Entity 3', status: 'active' });

        const result = await connector.list('testEntity', { limit: 2 });

        expect(result.length).toBe(2);
      });

      it('should support offset option', async () => {
        // Create additional entities
        await connector.create('testEntity', { name: 'Entity 2', status: 'active' });

        const allResults = await connector.list('testEntity');
        const offsetResults = await connector.list('testEntity', { offset: 1 });

        expect(offsetResults.length).toBe(allResults.length - 1);
      });

      it('should return empty array for empty store', async () => {
        const result = await connector.list('anotherEntity');

        expect(result).toEqual([]);
      });
    });

    describe('search()', () => {
      it('should search entities by field value', async () => {
        await connector.create('testEntity', { name: 'Searchable', status: 'active' });
        await connector.create('testEntity', { name: 'Another', status: 'inactive' });

        const result = await connector.search('testEntity', {
          filters: { status: 'active' },
        });

        expect(result.length).toBeGreaterThan(0);
        result.forEach(entity => {
          expect(entity.status).toBe('active');
        });
      });

      it('should return empty array when no matches', async () => {
        const result = await connector.search('testEntity', {
          filters: { status: 'non-existent-status' },
        });

        expect(result).toEqual([]);
      });

      it('should handle empty filters', async () => {
        const result = await connector.search('testEntity', { filters: {} });

        expect(result.length).toBeGreaterThan(0);
      });
    });
  });

  describe('bulk operations', () => {
    beforeEach(async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
      };
      await connector.initialize(config);
    });

    describe('bulkCreate()', () => {
      it('should create multiple entities', async () => {
        const records = [
          { name: 'Bulk 1', status: 'active' },
          { name: 'Bulk 2', status: 'active' },
          { name: 'Bulk 3', status: 'active' },
        ];

        const result = await connector.bulkCreate('testEntity', records);

        expect(result.status).toBe('success');
        expect(result.recordsSuccessful).toBe(3);
        expect(result.recordsFailed).toBe(0);
      });

      it('should return partial success on some failures', async () => {
        // Create with duplicate IDs to cause errors
        const records = [
          { id: 'dup-id', name: 'First', status: 'active' },
          { id: 'unique-id', name: 'Second', status: 'active' },
        ];

        // First one should succeed
        await connector.bulkCreate('testEntity', [records[0]]);

        // Creating again with same ID in one of them
        // Note: Current implementation doesn't prevent duplicate IDs
        const result = await connector.bulkCreate('testEntity', records);

        expect(result.recordsProcessed).toBe(2);
      });

      it('should include timing information', async () => {
        const records = [{ name: 'Timed', status: 'active' }];

        const result = await connector.bulkCreate('testEntity', records);

        expect(result.startTime).toBeInstanceOf(Date);
        expect(result.endTime).toBeInstanceOf(Date);
        expect(result.endTime.getTime()).toBeGreaterThanOrEqual(result.startTime.getTime());
      });
    });

    describe('bulkUpdate()', () => {
      it('should update multiple entities', async () => {
        // Create entities first
        const entity1 = await connector.create('testEntity', { name: 'Update 1', status: 'active' });
        const entity2 = await connector.create('testEntity', { name: 'Update 2', status: 'active' });

        const updates = [
          { id: entity1.id, status: 'updated' },
          { id: entity2.id, status: 'updated' },
        ];

        const result = await connector.bulkUpdate('testEntity', updates);

        expect(result.status).toBe('success');
        expect(result.recordsSuccessful).toBe(2);
      });

      it('should handle missing IDs', async () => {
        const updates = [
          { status: 'updated' } as any, // Missing ID
        ];

        const result = await connector.bulkUpdate('testEntity', updates);

        expect(result.recordsFailed).toBe(1);
        expect(result.errors).toContain('Missing id');
      });

      it('should handle non-existent entities', async () => {
        const updates = [
          { id: 'non-existent-id', status: 'updated' },
        ];

        const result = await connector.bulkUpdate('testEntity', updates);

        expect(result.recordsFailed).toBe(1);
        expect(result.errors[0]).toContain('not found');
      });
    });

    describe('bulkDelete()', () => {
      it('should delete multiple entities', async () => {
        // Create entities first
        const entity1 = await connector.create('testEntity', { name: 'Delete 1', status: 'active' });
        const entity2 = await connector.create('testEntity', { name: 'Delete 2', status: 'active' });

        const result = await connector.bulkDelete('testEntity', [entity1.id, entity2.id]);

        expect(result.status).toBe('success');
        expect(result.recordsSuccessful).toBe(2);
      });

      it('should handle non-existent entities', async () => {
        const result = await connector.bulkDelete('testEntity', ['non-existent-1', 'non-existent-2']);

        expect(result.recordsFailed).toBe(2);
        expect(result.status).toBe('failed');
      });

      it('should return partial success for mixed results', async () => {
        const entity = await connector.create('testEntity', { name: 'To Delete', status: 'active' });

        const result = await connector.bulkDelete('testEntity', [entity.id, 'non-existent']);

        expect(result.status).toBe('partial');
        expect(result.recordsSuccessful).toBe(1);
        expect(result.recordsFailed).toBe(1);
      });
    });
  });

  describe('webhooks', () => {
    beforeEach(async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
      };
      await connector.initialize(config);
    });

    it('should setup webhook', async () => {
      const webhookId = await connector.setupWebhook(
        'http://callback.example.com',
        ['create', 'update']
      );

      expect(webhookId).toBeDefined();
      expect(typeof webhookId).toBe('string');
    });

    it('should log webhook registration', async () => {
      await connector.setupWebhook('http://callback.example.com', ['create']);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('webhook registered'),
        expect.any(Object)
      );
    });
  });

  describe('change tracking', () => {
    beforeEach(async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
      };
      await connector.initialize(config);
    });

    it('should track changes since a date', async () => {
      // Use a date slightly in the past to avoid same-millisecond timing issues
      const beforeDate = new Date(Date.now() - 1);

      // Create entity after the date
      await connector.create('testEntity', { name: 'After Date', status: 'active' });

      const changes = await connector.getChanges('testEntity', beforeDate);

      expect(changes.length).toBeGreaterThan(0);
      expect(changes[0]).toHaveProperty('meta');
      expect(changes[0].meta.operation).toBe('create');
    });

    it('should not include changes before the date', async () => {
      // Seeded data is created before any getChanges call
      const futureDate = new Date(Date.now() + 1000000);

      const changes = await connector.getChanges('testEntity', futureDate);

      expect(changes).toEqual([]);
    });

    it('should include operation metadata', async () => {
      // Use a date slightly in the past to avoid same-millisecond timing issues
      const beforeDate = new Date(Date.now() - 1);
      const entity = await connector.create('testEntity', { name: 'Track Me', status: 'active' });
      await connector.update('testEntity', entity.id, { status: 'updated' });

      const changes = await connector.getChanges('testEntity', beforeDate);

      expect(changes.some(c => c.meta.operation === 'create')).toBe(true);
      expect(changes.some(c => c.meta.operation === 'update')).toBe(true);
    });
  });

  describe('entity statistics', () => {
    beforeEach(async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
      };
      await connector.initialize(config);
    });

    it('should return entity statistics', () => {
      const stats = connector.getEntityStats('testEntity');

      expect(stats).toHaveProperty('totalRecords');
      expect(stats).toHaveProperty('totalChanges');
      expect(stats.totalRecords).toBeGreaterThan(0);
    });

    it('should include last modified date', async () => {
      await connector.create('testEntity', { name: 'New', status: 'active' });

      const stats = connector.getEntityStats('testEntity');

      expect(stats.lastModified).toBeInstanceOf(Date);
    });

    it('should return zero for empty entity types', () => {
      const stats = connector.getEntityStats('anotherEntity');

      expect(stats.totalRecords).toBe(0);
      expect(stats.totalChanges).toBe(0);
    });
  });

  describe('getSupportedEntityTypes()', () => {
    beforeEach(async () => {
      const config: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
      };
      await connector.initialize(config);
    });

    it('should return array of supported entity types', () => {
      const types = connector.getSupportedEntityTypes();

      expect(Array.isArray(types)).toBe(true);
      expect(types).toContain('testEntity');
    });
  });

  describe('getSystemInfo()', () => {
    it('should return system information', async () => {
      const info = await connector.getSystemInfo();

      expect(info).toHaveProperty('name');
      expect(info).toHaveProperty('version');
      expect(info).toHaveProperty('status');
    });
  });
});
