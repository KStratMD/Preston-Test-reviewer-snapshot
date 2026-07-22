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

  setupWebhook?(webhookUrl: string, events: string[]): Promise<string>;

  removeWebhook?(webhookId: string): Promise<boolean>;

  getChanges?(entityType: string, since: Date): Promise<DataRecord[]>;

  validateSchema?(entityType: string, schema: Record<string, unknown>): Promise<boolean>;
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

