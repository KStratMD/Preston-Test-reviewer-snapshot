/**
 * Delta Sync Cursor Types
 */

export interface SyncCursor {
  id: string;
  flowId: string;
  sourceSystem: string;
  targetSystem: string;
  entityType: string;
  lastSyncTimestamp: number;
  lastRecordId?: string;
  checksum?: string;
  recordsProcessed: number;
  status: 'active' | 'paused' | 'error';
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CursorUpdate {
  lastSyncTimestamp?: number;
  lastRecordId?: string;
  checksum?: string;
  recordsProcessed?: number;
  status?: 'active' | 'paused' | 'error';
  metadata?: Record<string, unknown>;
}

export interface IncrementalSyncOptions {
  cursor?: SyncCursor;
  limit?: number;
  orderBy?: string;
  includeDeleted?: boolean;
}

export interface IncrementalSyncResult {
  records: unknown[];
  newCursor: SyncCursor;
  hasMore: boolean;
  stats: {
    fetched: number;
    processed: number;
    skipped: number;
    errors: number;
  };
}
