/**
 * DemoConnectorDecorator
 *
 * Decorator that wraps any IConnector and intercepts all operations with
 * an in-memory store when the application is running in demo mode.
 * The decorator is always instantiated but checks isDemoMode() at runtime
 * on each call — when demo mode is off it delegates transparently to the
 * inner connector with zero behavioral change.
 *
 * This eliminates the need for every connector to carry its own demo branching,
 * demo store, and demo seed data — keeping production connector code focused
 * solely on real API integration.
 *
 * Created: February 7, 2026 (Phase 8 - Demo Decoupling)
 */

import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SyncResult, ConnectionStatus, SystemInfo } from '../types';
import type { Logger } from '../utils/Logger';
import { CryptoUtils } from '../utils/crypto';
import { isDemoMode } from '../config/runtimeFlags';

export class DemoConnectorDecorator implements IConnector {
  private readonly demoStore = new Map<string, Map<string, DataRecord>>();
  private seedDataImported = false;

  get systemType(): string {
    return this.inner.systemType;
  }

  get systemId(): string {
    return this.inner.systemId;
  }

  constructor(
    private readonly inner: IConnector,
    private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle — always delegate to inner so seed data / real init still runs
  // ---------------------------------------------------------------------------

  async initialize(config: AuthConfig): Promise<void> {
    await this.inner.initialize(config);
    if (isDemoMode()) {
      this.logger.info(`${this.systemType} connector initialized in demo mode (decorator)`);
      this.ensureSeedData();
    }
  }

  async authenticate(): Promise<boolean> {
    if (isDemoMode()) {
      this.logger.info(`${this.systemType} demo authentication successful`);
      return true;
    }
    return this.inner.authenticate();
  }

  async testConnection(): Promise<ConnectionStatus> {
    if (isDemoMode()) {
      return {
        systemType: this.systemType,
        systemId: this.systemId,
        isConnected: true,
        lastTestTime: new Date(),
        latency: 1,
      };
    }
    return this.inner.testConnection();
  }

  async getSystemInfo(): Promise<SystemInfo> {
    if (isDemoMode()) {
      return {
        name: `${this.systemType} (Demo)`,
        type: this.systemType,
        version: 'demo',
        capabilities: ['demo_mode'],
        rateLimits: {
          requestsPerMinute: 1000,
          requestsPerHour: 60000,
          requestsPerDay: 100000,
        },
        endpoints: {
          baseUrl: `https://${this.systemType.toLowerCase()}.demo.local`,
          authUrl: `https://${this.systemType.toLowerCase()}.demo.local/auth`,
          webhookUrl: `https://${this.systemType.toLowerCase()}.demo.local/webhooks`,
        },
      };
    }
    return this.inner.getSystemInfo();
  }

  // ---------------------------------------------------------------------------
  // CRUD — demo mode uses in-memory store; non-demo delegates to inner
  // ---------------------------------------------------------------------------

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    if (!isDemoMode()) return this.inner.create(entityType, data);
    const store = this.getEntityStore(entityType);
    const id = data.id || CryptoUtils.generateUUID();
    const record: DataRecord = { ...data, id };
    store.set(id, record);
    return record;
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    if (!isDemoMode()) return this.inner.read(entityType, id);
    return this.getEntityStore(entityType).get(id) ?? null;
  }

  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    if (!isDemoMode()) return this.inner.update(entityType, id, data);
    const store = this.getEntityStore(entityType);
    const existing = store.get(id) ?? ({ id } as DataRecord);
    const updated: DataRecord = { ...existing, ...data, id } as DataRecord;
    store.set(id, updated);
    return updated;
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    if (!isDemoMode()) return this.inner.delete(entityType, id);
    return this.getEntityStore(entityType).delete(id);
  }

  async list(entityType: string, options?: ListOptions): Promise<DataRecord[]> {
    if (!isDemoMode()) return this.inner.list(entityType, options);
    let records = Array.from(this.getEntityStore(entityType).values());
    records = this.applyFilters(records, options?.filters);
    if (options?.sortBy) records = this.applySorting(records, options.sortBy, options.sortOrder);
    if (options?.offset) records = records.slice(options.offset);
    if (options?.limit) records = records.slice(0, options.limit);
    return records;
  }

  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    if (!isDemoMode()) return this.inner.search(entityType, criteria);
    let records = Array.from(this.getEntityStore(entityType).values());
    records = this.applyFilters(records, criteria.filters, criteria.operator);
    if (criteria.offset) records = records.slice(criteria.offset);
    if (criteria.limit) records = records.slice(0, criteria.limit);
    return records;
  }

  // ---------------------------------------------------------------------------
  // Bulk operations
  // ---------------------------------------------------------------------------

  async bulkCreate(entityType: string, records: DataRecord[]): Promise<SyncResult> {
    if (!isDemoMode()) return this.inner.bulkCreate(entityType, records);
    const startTime = new Date();
    for (const r of records) {
      await this.create(entityType, r);
    }
    return this.buildSyncResult(records.length, records.length, 0, startTime);
  }

  async bulkUpdate(entityType: string, records: Partial<DataRecord>[]): Promise<SyncResult> {
    if (!isDemoMode()) return this.inner.bulkUpdate(entityType, records);
    const startTime = new Date();
    let successCount = 0;
    for (const record of records) {
      const id = record.id || record.externalId;
      if (id) {
        await this.update(entityType, id, record);
        successCount++;
      }
    }
    return this.buildSyncResult(records.length, successCount, records.length - successCount, startTime);
  }

  async bulkDelete(entityType: string, ids: string[]): Promise<SyncResult> {
    if (!isDemoMode()) return this.inner.bulkDelete(entityType, ids);
    const startTime = new Date();
    let successCount = 0;
    for (const id of ids) {
      if (await this.delete(entityType, id)) successCount++;
    }
    return this.buildSyncResult(ids.length, successCount, ids.length - successCount, startTime);
  }

  // ---------------------------------------------------------------------------
  // Optional interface methods
  // ---------------------------------------------------------------------------

  async setupWebhook(webhookUrl: string, events: string[]): Promise<string> {
    if (!isDemoMode() && this.inner.setupWebhook) return this.inner.setupWebhook(webhookUrl, events);
    return `demo-webhook-${CryptoUtils.generateUUID()}`;
  }

  async removeWebhook(webhookId: string): Promise<boolean> {
    if (!isDemoMode() && this.inner.removeWebhook) return this.inner.removeWebhook(webhookId);
    return true;
  }

  async getChanges(entityType: string, since: Date): Promise<DataRecord[]> {
    if (!isDemoMode() && this.inner.getChanges) return this.inner.getChanges(entityType, since);
    return this.list(entityType);
  }

  async validateSchema(entityType: string, schema: Record<string, unknown>): Promise<boolean> {
    if (!isDemoMode() && this.inner.validateSchema) return this.inner.validateSchema(entityType, schema);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Count — returns unsliced total for pagination metadata
  // ---------------------------------------------------------------------------

  /**
   * Returns the total number of records matching optional filters.
   * In demo mode, counts from the in-memory store without slicing.
   * In non-demo mode, delegates to inner connector's count() if available,
   * otherwise returns -1 (unknown). The Proxy in wrapWithDecorator exposes
   * this method regardless of mode, so the guard must be here.
   */
  count(entityType: string, filters?: Record<string, unknown>, operator?: 'AND' | 'OR'): number {
    if (!isDemoMode()) {
      // Delegate to inner connector's count() if available (future real-connector support)
      const inner = this.inner as unknown as Record<string, unknown>;
      if (typeof inner.count === 'function') {
        return (inner.count as (e: string, f?: Record<string, unknown>, o?: 'AND' | 'OR') => number)(entityType, filters, operator);
      }
      return -1;
    }
    let records = Array.from(this.getEntityStore(entityType).values());
    if (filters) records = this.applyFilters(records, filters, operator);
    return records.length;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Import seeded fixtures from inner connector's dataStore (MockConnectorBase).
   * Real connectors don't have a dataStore Map, so the guard returns immediately.
   */
  private importSeedData(): void {
    const inner = this.inner as unknown as Record<string, unknown>;
    const dataStore = inner.dataStore;
    if (!(dataStore instanceof Map)) return;

    for (const [entityType, store] of dataStore.entries()) {
      if (!(store instanceof Map) || store.size === 0) continue;
      const target = this.getEntityStore(String(entityType));
      for (const [id, record] of store.entries()) {
        target.set(id, JSON.parse(JSON.stringify(record)) as DataRecord);
      }
    }
  }

  /**
   * Lazily import seed data on first demo-mode access.
   * This ensures seeded fixtures are visible even when demo mode is toggled
   * on after initial connector initialization (runtime toggle scenario).
   */
  private ensureSeedData(): void {
    if (this.seedDataImported) return;
    this.seedDataImported = true;
    this.importSeedData();
  }

  private getEntityStore(entityType: string): Map<string, DataRecord> {
    this.ensureSeedData();
    const key = entityType.toLowerCase();
    if (!this.demoStore.has(key)) {
      this.demoStore.set(key, new Map());
    }
    return this.demoStore.get(key)!;
  }

  /**
   * Apply key-value filters to records. Supports simple equality matching.
   * Operator defaults to 'AND' — all filters must match.
   */
  private applyFilters(
    records: DataRecord[],
    filters?: Record<string, unknown>,
    operator: 'AND' | 'OR' = 'AND',
  ): DataRecord[] {
    if (!filters || Object.keys(filters).length === 0) return records;
    return records.filter((record) => {
      const entries = Object.entries(filters);
      if (operator === 'OR') {
        return entries.some(([key, value]) => this.matchField(record, key, value));
      }
      return entries.every(([key, value]) => this.matchField(record, key, value));
    });
  }

  /** Case-insensitive equality check; supports string-contains for string values. */
  private matchField(record: DataRecord, key: string, value: unknown): boolean {
    const recordValue = (record as Record<string, unknown>)[key];
    const fields = (record as Record<string, unknown>).fields as Record<string, unknown> | undefined;
    const fieldValue = fields?.[key];

    // Exact match on either level
    if (recordValue === value || fieldValue === value) return true;

    // String-contains matching
    if (typeof value === 'string') {
      if (typeof recordValue === 'string' && recordValue.toLowerCase().includes(value.toLowerCase())) return true;
      if (typeof fieldValue === 'string' && fieldValue.toLowerCase().includes(value.toLowerCase())) return true;
    }

    // String coercion fallback
    const effective = recordValue !== undefined ? recordValue : fieldValue;
    if (effective !== undefined) return String(effective) === String(value);
    return false;
  }

  /** Resolve a value from top-level record or record.fields. */
  private resolveValue(record: DataRecord, key: string): unknown {
    const top = (record as Record<string, unknown>)[key];
    if (top !== undefined) return top;
    const fields = (record as Record<string, unknown>).fields as Record<string, unknown> | undefined;
    return fields?.[key];
  }

  private applySorting(records: DataRecord[], sortBy: string, sortOrder?: 'asc' | 'desc'): DataRecord[] {
    const order = sortOrder === 'desc' ? -1 : 1;
    return [...records].sort((a, b) => {
      const aVal = this.resolveValue(a, sortBy);
      const bVal = this.resolveValue(b, sortBy);
      if (aVal === bVal) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      return aVal < bVal ? -order : order;
    });
  }

  private buildSyncResult(total: number, success: number, failed: number, startTime: Date): SyncResult {
    return {
      integrationId: this.systemId,
      syncId: CryptoUtils.generateUUID(),
      status: failed === 0 ? 'success' : failed < total ? 'partial' : 'failed',
      success: failed === 0,
      recordsProcessed: total,
      recordsSuccessful: success,
      recordsFailed: failed,
      errors: [],
      startTime,
      endTime: new Date(),
    };
  }
}
