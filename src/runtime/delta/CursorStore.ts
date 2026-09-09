/**
 * Cursor Store for Delta/Incremental Sync Tracking
 * Manages sync cursors for tracking incremental changes
 *
 * Phase 2 Implementation: Database-backed persistence for reliable sync state
 */

import { injectable, inject } from 'inversify';
import { sql } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { DatabaseService } from '../../database/DatabaseService';
import type { DataRecord } from '../../types';
import type {
  SyncCursor,
  CursorUpdate
} from './types';
import * as crypto from 'crypto';
import { uuidv4 } from '../../utils/uuid';

interface SyncCursorRow {
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

@injectable()
export class CursorStore {
  // In-memory cache for performance (backed by database)
  private cursorCache = new Map<string, SyncCursor>();
  private initialized = false;

  constructor(
    @inject(TYPES.DatabaseService) private database: DatabaseService,
    @inject(TYPES.Logger) private logger: Logger
  ) {
    this.logger.info('Cursor store initialized (database-backed mode)');
  }

  /**
   * Convert database row to SyncCursor object
   */
  private rowToCursor(row: SyncCursorRow): SyncCursor {
    return {
      id: row.id,
      flowId: row.flow_id,
      sourceSystem: row.source_system,
      targetSystem: row.target_system,
      entityType: row.entity_type,
      lastSyncTimestamp: row.last_sync_timestamp,
      lastRecordId: row.last_record_id ?? undefined,
      checksum: row.checksum ?? undefined,
      recordsProcessed: row.records_processed,
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * Get cursor for a flow and entity type
   */
  async getCursor(flowId: string, entityType: string): Promise<SyncCursor | null> {
    try {
      const key = `${flowId}:${entityType}`;

      // Check cache first
      const cached = this.cursorCache.get(key);
      if (cached) {
        return cached;
      }

      // Query database
      const result = await this.database.query<SyncCursorRow>(
        sql`SELECT * FROM sync_cursors WHERE flow_id = ${flowId} AND entity_type = ${entityType}`
      );

      if (result.rows.length === 0) {
        this.logger.debug('Cursor not found', { flowId, entityType });
        return null;
      }

      const cursor = this.rowToCursor(result.rows[0]);
      this.cursorCache.set(key, cursor);
      return cursor;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to get cursor', {
        flowId,
        entityType,
        error: err.message
      });
      throw error;
    }
  }

  /**
   * Create a new cursor
   */
  async createCursor(
    flowId: string,
    sourceSystem: string,
    targetSystem: string,
    entityType: string,
    initialTimestamp?: number
  ): Promise<SyncCursor> {
    try {
      const now = Date.now();
      const cursor: SyncCursor = {
        id: uuidv4(),
        flowId,
        sourceSystem,
        targetSystem,
        entityType,
        lastSyncTimestamp: initialTimestamp || now,
        recordsProcessed: 0,
        status: 'active',
        createdAt: now,
        updatedAt: now
      };

      // Insert into database
      await this.database.query(
        sql`INSERT INTO sync_cursors (
          id, flow_id, source_system, target_system, entity_type,
          last_sync_timestamp, records_processed, status, created_at, updated_at
        ) VALUES (
          ${cursor.id}, ${cursor.flowId}, ${cursor.sourceSystem}, ${cursor.targetSystem}, ${cursor.entityType},
          ${cursor.lastSyncTimestamp}, ${cursor.recordsProcessed}, ${cursor.status}, ${cursor.createdAt}, ${cursor.updatedAt}
        )`
      );

      // Update cache
      const key = `${flowId}:${entityType}`;
      this.cursorCache.set(key, cursor);

      this.logger.info('Created new cursor', {
        cursorId: cursor.id,
        flowId,
        entityType
      });

      return cursor;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to create cursor', {
        flowId,
        entityType,
        error: err.message
      });
      throw error;
    }
  }

  /**
   * Update cursor with new sync position
   */
  async updateCursor(cursorId: string, update: CursorUpdate): Promise<SyncCursor> {
    try {
      const now = Date.now();

      // Execute update using parameterized query (safe from SQL injection)
      await this.database.query(
        sql`UPDATE sync_cursors SET
          last_sync_timestamp = COALESCE(${update.lastSyncTimestamp ?? null}, last_sync_timestamp),
          last_record_id = COALESCE(${update.lastRecordId ?? null}, last_record_id),
          checksum = COALESCE(${update.checksum ?? null}, checksum),
          records_processed = COALESCE(${update.recordsProcessed ?? null}, records_processed),
          status = COALESCE(${update.status ?? null}, status),
          metadata = COALESCE(${update.metadata ? JSON.stringify(update.metadata) : null}, metadata),
          updated_at = ${now}
        WHERE id = ${cursorId}`
      );

      // Fetch updated cursor
      const result = await this.database.query<SyncCursorRow>(
        sql`SELECT * FROM sync_cursors WHERE id = ${cursorId}`
      );

      if (result.rows.length === 0) {
        throw new Error(`Cursor not found: ${cursorId}`);
      }

      const updatedCursor = this.rowToCursor(result.rows[0]);

      // Update cache
      const key = `${updatedCursor.flowId}:${updatedCursor.entityType}`;
      this.cursorCache.set(key, updatedCursor);

      this.logger.debug('Updated cursor', {
        cursorId,
        updates: Object.keys(update)
      });

      return updatedCursor;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to update cursor', {
        cursorId,
        error: err.message
      });
      throw error;
    }
  }

  /**
   * Compute checksum for a set of records
   */
  async computeChecksum(records: DataRecord[]): Promise<string> {
    try {
      // Sort records by ID for deterministic hashing
      const sorted = records.slice().sort((a, b) => {
        const aId = a.id || a.externalId || '';
        const bId = b.id || b.externalId || '';
        return aId.toString().localeCompare(bId.toString());
      });

      // Create checksum data structure
      const data = sorted.map(r => ({
        id: r.id || r.externalId,
        lastModified: (r.metadata as any)?.lastModified?.getTime() || 0
      }));

      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex');

      this.logger.debug('Computed checksum', {
        recordCount: records.length,
        checksum: hash.substring(0, 8) + '...'
      });

      return hash;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to compute checksum', {
        error: err.message
      });
      throw error;
    }
  }

  /**
   * Pause cursor (stop sync for this flow/entity)
   */
  async pauseCursor(cursorId: string): Promise<void> {
    await this.updateCursor(cursorId, { status: 'paused' });
    this.logger.info('Cursor paused', { cursorId });
  }

  /**
   * Resume cursor (restart sync for this flow/entity)
   */
  async resumeCursor(cursorId: string): Promise<void> {
    await this.updateCursor(cursorId, { status: 'active' });
    this.logger.info('Cursor resumed', { cursorId });
  }

  /**
   * Delete cursor
   */
  async deleteCursor(cursorId: string): Promise<void> {
    try {
      // Get cursor to find cache key
      const result = await this.database.query<SyncCursorRow>(
        sql`SELECT flow_id, entity_type FROM sync_cursors WHERE id = ${cursorId}`
      );

      if (result.rows.length === 0) {
        throw new Error(`Cursor not found: ${cursorId}`);
      }

      const { flow_id, entity_type } = result.rows[0];

      // Delete from database
      await this.database.query(
        sql`DELETE FROM sync_cursors WHERE id = ${cursorId}`
      );

      // Remove from cache
      const key = `${flow_id}:${entity_type}`;
      this.cursorCache.delete(key);

      this.logger.info('Cursor deleted', { cursorId });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to delete cursor', {
        cursorId,
        error: err.message
      });
      throw error;
    }
  }

  /**
   * Get all cursors for a flow
   */
  async getCursorsForFlow(flowId: string): Promise<SyncCursor[]> {
    try {
      const result = await this.database.query<SyncCursorRow>(
        sql`SELECT * FROM sync_cursors WHERE flow_id = ${flowId}`
      );

      return result.rows.map(row => this.rowToCursor(row));
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to get cursors for flow', {
        flowId,
        error: err.message
      });
      throw error;
    }
  }

  /**
   * Clear all cursors (for testing)
   */
  async clearAll(): Promise<void> {
    await this.database.query(sql`DELETE FROM sync_cursors`);
    this.cursorCache.clear();
    this.logger.warn('All cursors cleared');
  }

  /**
   * Get or create cursor (upsert pattern)
   */
  async getOrCreateCursor(
    flowId: string,
    sourceSystem: string,
    targetSystem: string,
    entityType: string,
    initialTimestamp?: number
  ): Promise<SyncCursor> {
    const existing = await this.getCursor(flowId, entityType);
    if (existing) {
      return existing;
    }
    return this.createCursor(flowId, sourceSystem, targetSystem, entityType, initialTimestamp);
  }
}
