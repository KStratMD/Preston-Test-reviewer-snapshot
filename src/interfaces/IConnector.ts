import type { AuthConfig, DataRecord, SyncResult, ConnectionStatus, SystemInfo } from '../types';

export interface IConnector {
  readonly systemType: string;
  readonly systemId: string;

  initialize(config: AuthConfig): Promise<void>;

  testConnection(): Promise<ConnectionStatus>;

  getSystemInfo(): Promise<SystemInfo>;

  authenticate(): Promise<boolean>;

  refreshAuthentication?(): Promise<boolean>;

  create(entityType: string, data: DataRecord): Promise<DataRecord>;

  read(entityType: string, id: string): Promise<DataRecord | null>;

  update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord>;

  delete(entityType: string, id: string): Promise<boolean>;

  list(entityType: string, options?: ListOptions): Promise<DataRecord[]>;

  search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]>;

  bulkCreate(entityType: string, records: DataRecord[]): Promise<SyncResult>;

  bulkUpdate(entityType: string, records: Partial<DataRecord>[]): Promise<SyncResult>;

  bulkDelete(entityType: string, ids: string[]): Promise<SyncResult>;

  /**
   * Native upsert-by-external-id. Added for the NetSuite serialized-asset
   * sync (Prerequisite PR A) so a target connector that supports it (e.g.
   * Salesforce's External ID upsert) can be dispatched through the same
   * governed-write chokepoint as create/update/delete, with a plain
   * property-access call the write-descriptor-equivalence scanner can
   * statically analyze. `BaseConnector.upsert` is a concrete default that
   * throws `ValidationError` for connectors that don't support it —
   * concrete support lands per-connector in a later PR.
   */
  upsert(
    entityType: string,
    externalIdField: string,
    externalIdValue: string,
    data: Record<string, unknown>,
  ): Promise<ConnectorUpsertResult>;

  setupWebhook?(webhookUrl: string, events: string[]): Promise<string>;

  removeWebhook?(webhookId: string): Promise<boolean>;

  getChanges?(entityType: string, since: Date): Promise<DataRecord[]>;

  validateSchema?(entityType: string, schema: Record<string, unknown>): Promise<boolean>;
}

/** Result shape for `IConnector.upsert`. `id` is populated when the target
 * connector can report the resolved record id (created or matched); it is
 * optional because not every connector's upsert response surfaces one. */
export interface ConnectorUpsertResult {
  outcome: 'created' | 'updated' | 'unknown';
  id?: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  fields?: string[];
  filters?: Record<string, unknown>;
}

export interface SearchCriteria {
  filters: Record<string, unknown>;
  operator?: 'AND' | 'OR';
  limit?: number;
  offset?: number;
}

