import { injectable } from 'inversify';
import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SyncResult, SystemInfo } from '../types';
import type { BaseEntity, EntityType, EntityTypeMap } from '../types/entities';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { CircuitBreakerOptions } from '../utils/CircuitBreaker';
import crypto from 'crypto';

/**
 * Change log entry for tracking entity modifications
 */
export interface ChangeLogEntry<TEntity extends BaseEntity = BaseEntity> {
  id: string;
  record: TEntity | null;
  operation: 'create' | 'update' | 'delete';
  timestamp: Date;
}

/**
 * Webhook configuration
 */
export interface WebhookConfig {
  url: string;
  events: string[];
}

/**
 * MockConnectorBase provides shared in-memory CRUD, search, webhook and
 * change-tracking behaviour for mock connectors using simple API-key
 * authentication. Now with full type safety for entities.
 */
@injectable()
export abstract class MockConnectorBase<
  TEntityMap extends Record<string, BaseEntity> = EntityTypeMap
> extends BaseConnector implements IConnector {
  protected apiKey = '';
  protected baseUrl = '';

  // Type-safe data store with entity-specific typing
  protected readonly dataStore = new Map<keyof TEntityMap, Map<string, TEntityMap[keyof TEntityMap]>>();

  // Type-safe change log with entity-specific typing
  protected readonly changeLog = new Map<
    keyof TEntityMap,
    ChangeLogEntry<TEntityMap[keyof TEntityMap]>[]
  >();

  protected readonly webhooks = new Map<string, WebhookConfig>();
  protected readonly authService: AuthService;

  constructor(
    systemType: string,
    systemId: string,
    logger: Logger,
    authService: AuthService,
    circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    super(systemType, systemId, logger, circuitBreakerOptions);
    this.authService = authService;
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;
    if (config.type !== 'api_key') {
      throw new Error(`${this.systemType} connector requires API key authentication`);
    }
    const credentials = config.credentials as { apiKey: string; baseUrl?: string };
    this.apiKey = credentials.apiKey;
    this.baseUrl = credentials.baseUrl || this.getDefaultBaseUrl();
    this.httpClient.defaults.baseURL = this.baseUrl;
    this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${this.apiKey}`;
    this.logger.info(`${this.systemType} connector initialized`, { baseUrl: this.baseUrl });

    try {
      await this.seedData();
    } catch (error) {
      this.logger.error('Error seeding mock data', error);
    }
  }

  protected abstract getDefaultBaseUrl(): string;
  protected abstract seedData(): Promise<void>;
  abstract override getSystemInfo(): Promise<SystemInfo>;

  async authenticate(): Promise<boolean> {
    this.isAuthenticated = true;
    this.logger.info(`${this.systemType} authentication simulated`);
    return true;
  }

  /**
   * Get type-safe entity store for a specific entity type
   */
  protected getEntityStore<K extends keyof TEntityMap>(
    entityType: K
  ): Map<string, TEntityMap[K]> {
    if (!this.dataStore.has(entityType)) {
      this.dataStore.set(entityType, new Map<string, TEntityMap[K]>());
    }
    return this.dataStore.get(entityType) as Map<string, TEntityMap[K]>;
  }

  /**
   * Log changes with type safety
   */
  protected logChange<K extends keyof TEntityMap>(
    entityType: K,
    id: string,
    record: TEntityMap[K] | null,
    operation: 'create' | 'update' | 'delete',
  ): void {
    if (!this.changeLog.has(entityType)) {
      this.changeLog.set(entityType, []);
    }
    const log = this.changeLog.get(entityType)!;
    log.push({
      id,
      record,
      operation,
      timestamp: new Date()
    } as ChangeLogEntry<TEntityMap[K]>);
  }

  /**
   * Type-safe create operation
   */
  async create(entityType: string, data: DataRecord): Promise<DataRecord>;
  async create<K extends keyof TEntityMap>(
    entityType: K,
    data: Omit<TEntityMap[K], 'id'> & { id?: string }
  ): Promise<TEntityMap[K]>;
  async create<K extends keyof TEntityMap>(
    entityType: K,
    data: unknown
  ): Promise<unknown> {
    await this.ensureAuthenticated();
    const store = this.getEntityStore(entityType);
    const record = data as Record<string, unknown>;
    const id = (record.id as string | undefined) || crypto.randomUUID();
    const newRecord: TEntityMap[K] = {
      ...record,
      id,
      createdAt: new Date(),
      updatedAt: new Date()
    } as TEntityMap[K];

    store.set(id, newRecord);
    this.logChange(entityType, id, newRecord, 'create');
    return newRecord;
  }

  /**
   * Type-safe read operation
   */
  async read(entityType: string, id: string): Promise<DataRecord | null>;
  async read<K extends keyof TEntityMap>(
    entityType: K,
    id: string
  ): Promise<TEntityMap[K] | null>;
  async read<K extends keyof TEntityMap>(
    entityType: K,
    id: string
  ): Promise<TEntityMap[K] | DataRecord | null> {
    await this.ensureAuthenticated();
    return this.getEntityStore(entityType).get(id) ?? null;
  }

  /**
   * Type-safe update operation
   */
  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord>;
  async update<K extends keyof TEntityMap>(
    entityType: K,
    id: string,
    data: Partial<Omit<TEntityMap[K], 'id' | 'createdAt'>>
  ): Promise<TEntityMap[K]>;
  async update<K extends keyof TEntityMap>(
    entityType: K,
    id: string,
    data: unknown
  ): Promise<TEntityMap[K] | DataRecord> {
    await this.ensureAuthenticated();
    const store = this.getEntityStore(entityType);
    const existing = store.get(id);
    if (!existing) {
      throw new Error(`${String(entityType)} ${id} not found`);
    }
    const updated: TEntityMap[K] = {
      ...existing,
      ...(data as Partial<TEntityMap[K]>),
      id,
      updatedAt: new Date()
    } as TEntityMap[K];

    store.set(id, updated);
    this.logChange(entityType, id, updated, 'update');
    return updated;
  }

  /**
   * Type-safe delete operation
   */
  async delete<K extends keyof TEntityMap>(
    entityType: K,
    id: string
  ): Promise<boolean> {
    await this.ensureAuthenticated();
    const store = this.getEntityStore(entityType);
    const record = store.get(id) ?? null;
    const deleted = store.delete(id);
    if (deleted) {
      this.logChange(entityType, id, record, 'delete');
    }
    return deleted;
  }

  /**
   * Type-safe list operation
   */
  async list(entityType: string, options?: ListOptions): Promise<DataRecord[]>;
  async list<K extends keyof TEntityMap>(
    entityType: K,
    options?: ListOptions
  ): Promise<TEntityMap[K][]>;
  async list<K extends keyof TEntityMap>(
    entityType: K,
    options: ListOptions = {}
  ): Promise<TEntityMap[K][] | DataRecord[]> {
    await this.ensureAuthenticated();
    const store = this.getEntityStore(entityType);
    let records = Array.from(store.values());
    if (options.offset) {
      records = records.slice(options.offset);
    }
    if (options.limit) {
      records = records.slice(0, options.limit);
    }
    return records;
  }

  /**
   * Type-safe search operation
   */
  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]>;
  async search<K extends keyof TEntityMap>(
    entityType: K,
    criteria: SearchCriteria
  ): Promise<TEntityMap[K][]>;
  async search<K extends keyof TEntityMap>(
    entityType: K,
    criteria: SearchCriteria
  ): Promise<TEntityMap[K][] | DataRecord[]> {
    await this.ensureAuthenticated();
    const store = this.getEntityStore(entityType);
    const filters = criteria.filters || {};
    return Array.from(store.values()).filter(record => {
      const recordObj = record as unknown as Record<string, unknown>;
      return Object.entries(filters).every(([field, value]) =>
        recordObj[field] === value ||
        (recordObj.fields as Record<string, unknown> | undefined)?.[field] === value
      );
    });
  }

  /**
   * Type-safe bulk create operation
   */
  override async bulkCreate<K extends keyof TEntityMap>(
    entityType: K,
    records: (Omit<TEntityMap[K], 'id'> & { id?: string })[]
  ): Promise<SyncResult> {
    await this.ensureAuthenticated();
    const startTime = new Date();
    const errors: string[] = [];
    let successCount = 0;

    for (const record of records) {
      try {
        await this.create(entityType, record);
        successCount++;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const status = errors.length === 0 ? 'success' : successCount > 0 ? 'partial' : 'failed';
    return {
      integrationId: this.systemId,
      syncId: `bulk_create_${Date.now()}`,
      status,
      success: status === 'success',
      recordsProcessed: records.length,
      recordsSuccessful: successCount,
      recordsFailed: errors.length,
      errors,
      startTime,
      endTime: new Date(),
    };
  }

  /**
   * Type-safe bulk update operation
   */
  override async bulkUpdate<K extends keyof TEntityMap>(
    entityType: K,
    records: (Partial<Omit<TEntityMap[K], 'createdAt'>> & { id: string })[]
  ): Promise<SyncResult> {
    await this.ensureAuthenticated();
    const startTime = new Date();
    const errors: string[] = [];
    let successCount = 0;

    for (const record of records) {
      const id = record.id;
      if (!id) {
        errors.push('Missing id');
        continue;
      }
      try {
        await this.update(
          entityType as string,
          id,
          record as Partial<DataRecord>
        );
        successCount++;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const status = errors.length === 0 ? 'success' : successCount > 0 ? 'partial' : 'failed';
    return {
      integrationId: this.systemId,
      syncId: `bulk_update_${Date.now()}`,
      status,
      success: status === 'success',
      recordsProcessed: records.length,
      recordsSuccessful: successCount,
      recordsFailed: errors.length,
      errors,
      startTime,
      endTime: new Date(),
    };
  }

  /**
   * Type-safe bulk delete operation
   */
  override async bulkDelete<K extends keyof TEntityMap>(
    entityType: K,
    ids: string[]
  ): Promise<SyncResult> {
    await this.ensureAuthenticated();
    const startTime = new Date();
    const errors: string[] = [];
    let successCount = 0;

    for (const id of ids) {
      try {
        const deleted = await this.delete(entityType, id);
        if (deleted) {
          successCount++;
        } else {
          errors.push(`Not found: ${id}`);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const status = errors.length === 0 ? 'success' : successCount > 0 ? 'partial' : 'failed';
    return {
      integrationId: this.systemId,
      syncId: `bulk_delete_${Date.now()}`,
      status,
      success: status === 'success',
      recordsProcessed: ids.length,
      recordsSuccessful: successCount,
      recordsFailed: errors.length,
      errors,
      startTime,
      endTime: new Date(),
    };
  }

  /**
   * Setup webhook for entity events
   */
  async setupWebhook(webhookUrl: string, events: string[]): Promise<string> {
    await this.ensureAuthenticated();
    const id = crypto.randomUUID();
    this.webhooks.set(id, { url: webhookUrl, events });
    this.logger.info(`${this.systemType} webhook registered`, { id, webhookUrl, events });
    return id;
  }

  /**
   * Get type-safe changes for an entity type since a specific date
   */
  async getChanges(entityType: string, since: Date): Promise<DataRecord[]>;
  async getChanges<K extends keyof TEntityMap>(
    entityType: K,
    since: Date
  ): Promise<(TEntityMap[K] & { meta: { operation: string; timestamp: string } })[]>;
  async getChanges<K extends keyof TEntityMap>(
    entityType: K,
    since: Date
  ): Promise<(TEntityMap[K] & { meta: { operation: string; timestamp: string } })[] | DataRecord[]> {
    await this.ensureAuthenticated();
    const changes = this.changeLog.get(entityType) || [];
    return changes
      .filter(change => change.timestamp > since)
      .map(change => ({
        ...(change.record || { id: change.id } as TEntityMap[K]),
        meta: { operation: change.operation, timestamp: change.timestamp.toISOString() },
      })) as (TEntityMap[K] & { meta: { operation: string; timestamp: string } })[];
  }

  /**
   * Get all entity types supported by this connector
   */
  getSupportedEntityTypes(): (keyof TEntityMap)[] {
    return Array.from(this.dataStore.keys());
  }

  /**
   * Get statistics for an entity type
   */
  getEntityStats<K extends keyof TEntityMap>(entityType: K): {
    totalRecords: number;
    totalChanges: number;
    lastModified?: Date;
  } {
    const store = this.getEntityStore(entityType);
    const changes = this.changeLog.get(entityType) || [];
    const lastChange = changes.length > 0 ? changes[changes.length - 1] : null;

    return {
      totalRecords: store.size,
      totalChanges: changes.length,
      lastModified: lastChange?.timestamp,
    };
  }
}

export default MockConnectorBase;
