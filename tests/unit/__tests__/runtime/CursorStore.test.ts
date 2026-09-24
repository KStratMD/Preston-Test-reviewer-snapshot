/**
 * Tests for Delta Sync Cursor Store (Database-Backed Implementation)
 */

import { CursorStore } from '../../../../src/runtime/delta/CursorStore';
import { logger } from '../../../../src/utils/Logger';

// In-memory storage to simulate database
interface MockCursorRow {
  id: string;
  flow_id: string;
  source_system: string;
  target_system: string;
  entity_type: string;
  last_sync_timestamp: number;
  last_record_id: string | null;
  checksum: string | null;
  records_processed: number;
  status: 'active' | 'paused' | 'error';
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

let mockStorage: MockCursorRow[] = [];

// Track query calls for debugging
let lastQuerySql = '';

// Create mock that intercepts all database queries
const createMockDatabase = () => {
  return {
    query: jest.fn().mockImplementation(async (sqlObj: any) => {
      // Extract the SQL string from the template literal for debugging
      // Kysely's sql tagged template creates an object with a toOperationNode method
      if (sqlObj && sqlObj.toOperationNode) {
        const node = sqlObj.toOperationNode();
        if (node && node.sql) {
          lastQuerySql = node.sql;
        }
      }

      // For this test, we just return empty results
      // The CursorStore uses an internal cache, so most operations work from cache after create
      return { rows: [] };
    }),
    getDatabase: jest.fn(),
    executeRaw: jest.fn().mockResolvedValue(undefined)
  };
};

// Since the new CursorStore uses cache + database, we need a more comprehensive mock
// that actually simulates the database storage. Let's create a simplified version
// that tests the key behaviors.

describe('CursorStore', () => {
  let cursorStore: CursorStore;
  let mockDatabase: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage = [];
    mockDatabase = createMockDatabase();

    // Override the query method to properly simulate database
    mockDatabase.query = jest.fn().mockImplementation(async () => {
      // Return empty by default, individual tests can override
      return { rows: [] };
    });

    cursorStore = new CursorStore(mockDatabase as any, logger);
  });

  describe('createCursor', () => {
    it('should create a new cursor and store in cache', async () => {
      const cursor = await cursorStore.createCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      expect(cursor).toBeDefined();
      expect(cursor.flowId).toBe('flow-123');
      expect(cursor.sourceSystem).toBe('salesforce');
      expect(cursor.targetSystem).toBe('netsuite');
      expect(cursor.entityType).toBe('customers');
      expect(cursor.lastSyncTimestamp).toBeGreaterThan(0);
      expect(cursor.recordsProcessed).toBe(0);
      expect(cursor.status).toBe('active');
      expect(cursor.id).toBeDefined();

      // Verify database was called
      expect(mockDatabase.query).toHaveBeenCalled();
    });

    it('should create cursor with initial timestamp', async () => {
      const initialTimestamp = 1633024800000;
      const cursor = await cursorStore.createCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers',
        initialTimestamp
      );

      expect(cursor.lastSyncTimestamp).toBe(initialTimestamp);
    });
  });

  describe('getCursor', () => {
    it('should return null if cursor does not exist', async () => {
      const cursor = await cursorStore.getCursor('flow-123', 'customers');
      expect(cursor).toBeNull();
    });

    it('should return cursor from cache after creation', async () => {
      // Create cursor first (stored in cache)
      const created = await cursorStore.createCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      // Get cursor (should come from cache)
      const cursor = await cursorStore.getCursor('flow-123', 'customers');

      expect(cursor).toBeDefined();
      expect(cursor?.id).toBe(created.id);
      expect(cursor?.flowId).toBe('flow-123');
      expect(cursor?.entityType).toBe('customers');
    });
  });

  describe('updateCursor', () => {
    it('should update cursor with new values', async () => {
      // Create cursor first
      const created = await cursorStore.createCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      // Mock the SELECT query for the update to return the cursor
      mockDatabase.query = jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // UPDATE query
        .mockResolvedValueOnce({ rows: [{
          id: created.id,
          flow_id: 'flow-123',
          source_system: 'salesforce',
          target_system: 'netsuite',
          entity_type: 'customers',
          last_sync_timestamp: 1633111200000,
          last_record_id: 'rec-1000',
          checksum: 'xyz789',
          records_processed: 150,
          status: 'active',
          metadata: null,
          created_at: created.createdAt,
          updated_at: Date.now()
        }]}); // SELECT query after update

      const updated = await cursorStore.updateCursor(created.id, {
        lastSyncTimestamp: 1633111200000,
        lastRecordId: 'rec-1000',
        checksum: 'xyz789',
        recordsProcessed: 150
      });

      expect(updated).toBeDefined();
      expect(updated.lastSyncTimestamp).toBe(1633111200000);
      expect(updated.lastRecordId).toBe('rec-1000');
      expect(updated.checksum).toBe('xyz789');
      expect(updated.recordsProcessed).toBe(150);
    });

    it('should throw error if cursor not found after update', async () => {
      // Mock empty result for the SELECT after UPDATE
      mockDatabase.query = jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce({ rows: [] }); // SELECT returns nothing

      await expect(
        cursorStore.updateCursor('nonexistent-cursor', {
          lastSyncTimestamp: Date.now()
        })
      ).rejects.toThrow('Cursor not found');
    });
  });

  describe('computeChecksum', () => {
    it('should compute consistent checksum for records', async () => {
      const records = [
        { id: '1', fields: {}, metadata: { lastModified: new Date() } },
        { id: '2', fields: {}, metadata: { lastModified: new Date() } },
        { id: '3', fields: {}, metadata: { lastModified: new Date() } }
      ];

      const checksum1 = await cursorStore.computeChecksum(records);
      const checksum2 = await cursorStore.computeChecksum(records);

      expect(checksum1).toBe(checksum2);
      expect(checksum1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('should produce different checksums for different record sets', async () => {
      const records1 = [
        { id: '1', fields: {}, metadata: { lastModified: new Date() } }
      ];

      const records2 = [
        { id: '2', fields: {}, metadata: { lastModified: new Date() } }
      ];

      const checksum1 = await cursorStore.computeChecksum(records1);
      const checksum2 = await cursorStore.computeChecksum(records2);

      expect(checksum1).not.toBe(checksum2);
    });

    it('should produce same checksum regardless of input order', async () => {
      const records1 = [
        { id: '3', fields: {}, metadata: { lastModified: new Date(1000) } },
        { id: '1', fields: {}, metadata: { lastModified: new Date(1000) } },
        { id: '2', fields: {}, metadata: { lastModified: new Date(1000) } }
      ];

      const records2 = [
        { id: '1', fields: {}, metadata: { lastModified: new Date(1000) } },
        { id: '2', fields: {}, metadata: { lastModified: new Date(1000) } },
        { id: '3', fields: {}, metadata: { lastModified: new Date(1000) } }
      ];

      const checksum1 = await cursorStore.computeChecksum(records1);
      const checksum2 = await cursorStore.computeChecksum(records2);

      expect(checksum1).toBe(checksum2);
    });
  });

  describe('pauseCursor and resumeCursor', () => {
    it('should pause cursor', async () => {
      const created = await cursorStore.createCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      // Mock the queries for pause
      mockDatabase.query = jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce({ rows: [{
          ...created,
          id: created.id,
          flow_id: created.flowId,
          source_system: created.sourceSystem,
          target_system: created.targetSystem,
          entity_type: created.entityType,
          last_sync_timestamp: created.lastSyncTimestamp,
          last_record_id: null,
          checksum: null,
          records_processed: created.recordsProcessed,
          status: 'paused',
          metadata: null,
          created_at: created.createdAt,
          updated_at: Date.now()
        }]}); // SELECT after update

      await cursorStore.pauseCursor(created.id);

      const cursor = await cursorStore.getCursor('flow-123', 'customers');
      expect(cursor?.status).toBe('paused');
    });

    it('should resume cursor', async () => {
      const created = await cursorStore.createCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      // Mock queries for pause then resume
      const pausedRow = {
        id: created.id,
        flow_id: created.flowId,
        source_system: created.sourceSystem,
        target_system: created.targetSystem,
        entity_type: created.entityType,
        last_sync_timestamp: created.lastSyncTimestamp,
        last_record_id: null,
        checksum: null,
        records_processed: created.recordsProcessed,
        status: 'paused' as const,
        metadata: null,
        created_at: created.createdAt,
        updated_at: Date.now()
      };

      const resumedRow = { ...pausedRow, status: 'active' as const };

      mockDatabase.query = jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // UPDATE for pause
        .mockResolvedValueOnce({ rows: [pausedRow] }) // SELECT after pause
        .mockResolvedValueOnce({ rows: [] }) // UPDATE for resume
        .mockResolvedValueOnce({ rows: [resumedRow] }); // SELECT after resume

      await cursorStore.pauseCursor(created.id);
      await cursorStore.resumeCursor(created.id);

      const cursor = await cursorStore.getCursor('flow-123', 'customers');
      expect(cursor?.status).toBe('active');
    });
  });

  describe('deleteCursor', () => {
    it('should delete cursor from database', async () => {
      const created = await cursorStore.createCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      // Mock the queries for delete
      mockDatabase.query = jest.fn()
        .mockResolvedValueOnce({ rows: [{
          flow_id: 'flow-123',
          entity_type: 'customers'
        }]}) // SELECT to get flow_id/entity_type
        .mockResolvedValueOnce({ rows: [] }); // DELETE

      await cursorStore.deleteCursor(created.id);

      // Database query was called for deletion
      expect(mockDatabase.query).toHaveBeenCalled();
    });

    it('should throw error if cursor not found', async () => {
      // Mock empty result for SELECT
      mockDatabase.query = jest.fn().mockResolvedValueOnce({ rows: [] });

      await expect(
        cursorStore.deleteCursor('nonexistent-cursor')
      ).rejects.toThrow('Cursor not found');
    });
  });

  describe('getCursorsForFlow', () => {
    it('should return all cursors for a flow from database', async () => {
      // Create cursors
      await cursorStore.createCursor('flow-123', 'salesforce', 'netsuite', 'customers');
      await cursorStore.createCursor('flow-123', 'salesforce', 'netsuite', 'orders');

      // Mock the database query for getCursorsForFlow
      mockDatabase.query = jest.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'id-1',
            flow_id: 'flow-123',
            source_system: 'salesforce',
            target_system: 'netsuite',
            entity_type: 'customers',
            last_sync_timestamp: Date.now(),
            last_record_id: null,
            checksum: null,
            records_processed: 0,
            status: 'active',
            metadata: null,
            created_at: Date.now(),
            updated_at: Date.now()
          },
          {
            id: 'id-2',
            flow_id: 'flow-123',
            source_system: 'salesforce',
            target_system: 'netsuite',
            entity_type: 'orders',
            last_sync_timestamp: Date.now(),
            last_record_id: null,
            checksum: null,
            records_processed: 0,
            status: 'active',
            metadata: null,
            created_at: Date.now(),
            updated_at: Date.now()
          }
        ]
      });

      const cursors = await cursorStore.getCursorsForFlow('flow-123');

      expect(cursors.length).toBe(2);
      expect(cursors.every(c => c.flowId === 'flow-123')).toBe(true);
    });

    it('should return empty array if no cursors for flow', async () => {
      mockDatabase.query = jest.fn().mockResolvedValueOnce({ rows: [] });

      const cursors = await cursorStore.getCursorsForFlow('flow-nonexistent');

      expect(cursors.length).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('should clear all cursors from database', async () => {
      await cursorStore.createCursor('flow-123', 'salesforce', 'netsuite', 'customers');

      mockDatabase.query = jest.fn().mockResolvedValueOnce({ rows: [] });

      await cursorStore.clearAll();

      expect(mockDatabase.query).toHaveBeenCalled();
    });
  });

  describe('getOrCreateCursor', () => {
    it('should create cursor if it does not exist', async () => {
      const cursor = await cursorStore.getOrCreateCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      expect(cursor).toBeDefined();
      expect(cursor.flowId).toBe('flow-123');
    });

    it('should return existing cursor from cache', async () => {
      // Create first
      const created = await cursorStore.createCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      // Get or create should return the cached one
      const cursor = await cursorStore.getOrCreateCursor(
        'flow-123',
        'salesforce',
        'netsuite',
        'customers'
      );

      expect(cursor.id).toBe(created.id);
    });
  });
});
