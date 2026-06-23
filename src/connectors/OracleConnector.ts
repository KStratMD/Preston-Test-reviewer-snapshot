import { randomUUID } from 'crypto';
import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo } from '../types';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import { mapCommonFields } from '../utils/connectorHelpers';
import { isDemoMode, isTestEnvironment } from '../config/runtimeFlags';

type DemoWebhook = {
  url: string;
  events: string[];
};

type DemoChange = {
  entityType: string;
  record: DataRecord;
  operation: 'create' | 'update' | 'delete';
  timestamp: Date;
};

const DEMO_ORACLE_RECORDS: DataRecord[] = [
  {
    id: 'oracle_demo_001',
    externalId: 'ORACLE-DEMO-001',
    fields: {
      name: 'Demo Manufacturing Co',
      status: 'ACTIVE',
      amount: 125000,
      currency: 'USD',
    },
  },
  {
    id: 'oracle_demo_002',
    externalId: 'ORACLE-DEMO-002',
    fields: {
      name: 'Demo Retail Group',
      status: 'PENDING',
      amount: 89000,
      currency: 'USD',
    },
  },
];

export interface OracleCredentials {
  username: string;
  password: string;
  host: string;
  port?: number;
  serviceName?: string;
  sid?: string;
  protocol?: 'http' | 'https';
  wallet?: string;
  apiKey?: string;
}

export interface OracleResponse<T = unknown> {
  items: T[];
  hasMore: boolean;
  limit: number;
  offset: number;
  count: number;
  links?: {
    self: string;
    next?: string;
    prev?: string;
  };
}

export interface OracleRecord {
  [key: string]: unknown;
  ROWID?: string;
  CREATED_DATE?: string;
  LAST_UPDATED?: string;
}

/**
 * Oracle connector implementing Oracle REST Data Services (ORDS) integration
 * Supports Oracle Database, Oracle Cloud, and autonomous database connections
 * Uses REST endpoints for data operations with SQL query capabilities
 */
@injectable()
export class OracleConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'beta' as const;
  static readonly statusEvidence = 'IConnector interface satisfied; ORDS REST scaffolding present, API depth thin (basic CRUD only)';
  static readonly proofCard = 'docs/review/proof-cards/oracle-connector.md';

  // private _authService: AuthService;
  private host!: string;
  private port = 8080;
  private protocol: 'http' | 'https' = 'https';
  private serviceName?: string;
  private sid?: string;
  private readonly schema = 'HR'; // Default schema
  // private _ordsVersion: string = 'v1';
  private demoMode = false;
  private readonly demoStore = new Map<string, Map<string, DataRecord>>();
  private readonly demoWebhooks = new Map<string, DemoWebhook>();
  private readonly demoChanges: DemoChange[] = [];

  constructor(
    systemId: string,
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) _authService: AuthService,
  ) {
    super('Oracle', systemId, logger);
    // this._authService = authService;
  }

  private isDemoEnvironment(): boolean {
    if (isDemoMode()) {
      return true;
    }
    return isTestEnvironment();
  }

  private shouldUseDemoMode(credentials: OracleCredentials): boolean {
    if (!this.isDemoEnvironment()) {
      return false;
    }

    const host = (credentials.host || '').toLowerCase();
    const apiKey = (credentials.apiKey || '').toLowerCase();

    if (!host) {
      return true;
    }

    return host.includes('demo') || host.includes('localhost') || host.includes('example') ||
      apiKey.includes('demo') || apiKey.includes('test');
  }

  private getDemoBaseUrl(): string {
    return 'https://oracle.demo.local';
  }

  private enableDemoMode(): void {
    this.demoMode = true;
    this.host = this.host || this.getDemoBaseUrl().replace(/^https?:\/\//, '');
    this.protocol = 'https';
    this.port = 8080;
    const baseUrl = `${this.getDemoBaseUrl()}/ords/${this.schema}`;
    this.httpClient.defaults.baseURL = baseUrl;
    this.httpClient.defaults.headers.common['Authorization'] = 'Bearer demo-oracle-token';
    this.ensureDemoSeed();
    this.logger.info('Oracle connector initialized in demo mode', {
      systemId: this.systemId,
      baseUrl,
    });
  }

  private ensureDemoSeed(): void {
    if (this.demoStore.size > 0) {
      return;
    }

    const store = this.getDemoStore('records');
    for (const record of DEMO_ORACLE_RECORDS) {
      const seeded = this.cloneRecord(record);
      seeded.id = seeded.id || randomUUID();
      seeded.externalId = seeded.externalId || seeded.id;
      store.set(seeded.id, seeded);
    }
  }

  private getDemoStore(entityType: string): Map<string, DataRecord> {
    const key = entityType.toLowerCase();
    if (!this.demoStore.has(key)) {
      this.demoStore.set(key, new Map<string, DataRecord>());
    }
    return this.demoStore.get(key)!;
  }

  private cloneRecord(record: DataRecord): DataRecord {
    return JSON.parse(JSON.stringify(record));
  }

  private resolveField(record: DataRecord, field: string): unknown {
    if (field in record) {
      return record[field];
    }
    if (record.fields && typeof record.fields === 'object' && field in (record.fields as Record<string, unknown>)) {
      return (record.fields as Record<string, unknown>)[field];
    }
    return undefined;
  }

  private matchesFilters(
    record: DataRecord,
    filters: Record<string, unknown>,
    operator: 'AND' | 'OR' = 'AND',
  ): boolean {
    const results = Object.entries(filters).map(([field, value]) => {
      const actual = this.resolveField(record, field);

      if (value && typeof value === 'object' && 'operator' in (value as Record<string, unknown>)) {
        const filterValue = value as { operator: string; value: unknown };
        switch (filterValue.operator) {
        case 'contains':
          return typeof actual === 'string' &&
            actual.toLowerCase().includes(String(filterValue.value).toLowerCase());
        case 'not_equals':
          return actual !== filterValue.value;
        case 'greater_than':
          return typeof actual === 'number' && typeof filterValue.value === 'number' && actual > filterValue.value;
        case 'less_than':
          return typeof actual === 'number' && typeof filterValue.value === 'number' && actual < filterValue.value;
        default:
          return actual === filterValue.value;
        }
      }

      if (Array.isArray(value)) {
        return Array.isArray(actual) && value.every(v => (actual as unknown[]).includes(v));
      }

      return actual === value;
    });

    return operator === 'OR' ? results.some(Boolean) : results.every(Boolean);
  }

  private applyListWindow(records: DataRecord[], options: ListOptions = {}): DataRecord[] {
    let output = [...records];

    if (options.sortBy) {
      const direction = options.sortOrder === 'desc' ? -1 : 1;
      output.sort((a, b) => {
        const aValue = this.resolveField(a, options.sortBy!);
        const bValue = this.resolveField(b, options.sortBy!);

        if (aValue === bValue) return 0;
        if (aValue === undefined || aValue === null) return -1 * direction;
        if (bValue === undefined || bValue === null) return direction;
        return aValue > bValue ? direction : -direction;
      });
    }

    if (options.offset && options.offset > 0) {
      output = output.slice(options.offset);
    }

    if (options.limit !== undefined) {
      output = output.slice(0, options.limit);
    }

    return output;
  }

  private logDemoChange(entityType: string, record: DataRecord, operation: 'create' | 'update' | 'delete'): void {
    const entry: DemoChange = {
      entityType: entityType.toLowerCase(),
      record: this.cloneRecord(record),
      operation,
      timestamp: new Date(),
    };
    this.demoChanges.push(entry);
    if (this.demoChanges.length > 200) {
      this.demoChanges.shift();
    }
  }

  private getDemoRecord(entityType: string, idOrExternalId: string): DataRecord | null {
    const store = this.getDemoStore(entityType);
    if (store.has(idOrExternalId)) {
      return this.cloneRecord(store.get(idOrExternalId)!);
    }

    for (const record of store.values()) {
      if (record.externalId === idOrExternalId) {
        return this.cloneRecord(record);
      }
    }

    return null;
  }

  private upsertDemoRecord(
    entityType: string,
    record: DataRecord,
    operation: 'create' | 'update',
  ): DataRecord {
    const store = this.getDemoStore(entityType);
    const id = record.id && store.has(record.id) ? record.id : record.id ?? randomUUID();
    const existing = store.get(id);
    const merged: DataRecord = {
      ...existing,
      ...record,
      id,
      externalId: record.externalId ?? existing?.externalId ?? id,
      updatedAt: new Date(),
    };

    if (!existing) {
      merged.createdAt = record.createdAt ?? new Date();
    }

    store.set(id, merged);
    this.logDemoChange(entityType, merged, operation);
    return this.cloneRecord(merged);
  }

  private demoDeleteRecord(entityType: string, id: string): boolean {
    const store = this.getDemoStore(entityType);
    const existing = this.getDemoRecord(entityType, id);
    let deleted = false;

    if (store.delete(id)) {
      deleted = true;
    } else {
      for (const [key, value] of store.entries()) {
        if (value.externalId === id) {
          store.delete(key);
          deleted = true;
          break;
        }
      }
    }

    if (deleted && existing) {
      this.logDemoChange(entityType, existing, 'delete');
    }

    return deleted;
  }

  private demoList(entityType: string, options: ListOptions = {}): DataRecord[] {
    this.ensureDemoSeed();
    let records = Array.from(this.getDemoStore(entityType).values());

    if (options.filters) {
      records = records.filter(record => this.matchesFilters(record, options.filters ?? {}));
    }

    return this.applyListWindow(records.map(record => this.cloneRecord(record)), options);
  }

  private demoSearch(entityType: string, criteria: SearchCriteria): DataRecord[] {
    const records = this.demoList(entityType, { filters: criteria.filters });
    const offset = criteria.offset ?? 0;
    const limit = criteria.limit ?? records.length;
    return records.slice(offset, offset + limit);
  }

  private demoCreate(entityType: string, data: DataRecord): DataRecord {
    return this.upsertDemoRecord(entityType, data, 'create');
  }

  private demoUpdate(entityType: string, id: string, data: Partial<DataRecord>): DataRecord {
    const existing = this.getDemoRecord(entityType, id);
    const merged: DataRecord = {
      ...existing,
      ...data,
      id,
      externalId: data.externalId ?? existing?.externalId ?? id,
    };
    return this.upsertDemoRecord(entityType, merged, 'update');
  }

  private demoRead(entityType: string, id: string): DataRecord | null {
    return this.getDemoRecord(entityType, id);
  }

  private demoGetChanges(entityType: string, since: Date): DataRecord[] {
    const lower = entityType.toLowerCase();
    return this.demoChanges
      .filter(change => change.entityType === lower && change.timestamp >= since && change.operation !== 'delete')
      .map(change => this.cloneRecord(change.record));
  }

  private demoRegisterWebhook(webhookUrl: string, events: string[]): string {
    const id = randomUUID();
    this.demoWebhooks.set(id, { url: webhookUrl, events: [...events] });
    return id;
  }

  private demoRemoveWebhook(webhookId: string): boolean {
    return this.demoWebhooks.delete(webhookId);
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    if (config.type !== 'basic' && config.type !== 'api_key') {
      throw new Error('Oracle connector requires Basic or API Key authentication');
    }

    const credentials = config.credentials as OracleCredentials;

    this.host = credentials.host;
    this.port = credentials.port || 8080;
    this.protocol = credentials.protocol || 'https';
    this.serviceName = credentials.serviceName;
    this.sid = credentials.sid;

    if (this.shouldUseDemoMode(credentials)) {
      this.enableDemoMode();
      return;
    }

    // Construct base URL for Oracle REST Data Services (ORDS)
    const baseUrl = `${this.protocol}://${this.host}:${this.port}/ords/${this.schema}`;
    this.httpClient.defaults.baseURL = baseUrl;

    // Set Oracle-specific headers
    this.httpClient.defaults.headers.common['Content-Type'] = 'application/json';
    this.httpClient.defaults.headers.common['Accept'] = 'application/json';
    this.httpClient.defaults.headers.common['X-Requested-With'] = 'XMLHttpRequest';

    this.logger.info('Oracle connector initialized', {
      host: this.host,
      port: this.port,
      serviceName: this.serviceName,
      sid: this.sid,
      schema: this.schema,
    });
  }

  async authenticate(): Promise<boolean> {
    if (this.demoMode) {
      this.isAuthenticated = true;
      this.logger.info('Oracle demo authentication successful');
      return true;
    }

    try {
      const credentials = this.authConfig.credentials as OracleCredentials;

      if (this.authConfig.type === 'basic') {
        // Basic Authentication for ORDS
        const authString = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
        this.httpClient.defaults.headers.common['Authorization'] = `Basic ${authString}`;
      } else if (this.authConfig.type === 'api_key') {
        // API Key Authentication for Oracle Cloud
        this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${credentials.apiKey}`;
      }

      // Test authentication by fetching metadata
      await this.makeRequest({
        method: 'GET',
        url: '/metadata-catalog/',
      });

      this.isAuthenticated = true;
      this.logger.info('Oracle authentication successful');
      return true;
    } catch (error: unknown) {
      this.logger.error('Oracle authentication failed', error);
      this.isAuthenticated = false;
      throw error;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return {
        name: 'Oracle Database (Demo)',
        type: 'Oracle',
        version: 'Demo',
        capabilities: [
          'tables',
          'views',
          'mock_data',
        ],
        rateLimits: {
          requestsPerMinute: 500,
          requestsPerHour: 20000,
          requestsPerDay: 200000,
        },
        endpoints: {
          baseUrl: `${this.getDemoBaseUrl()}/ords/${this.schema}`,
          authUrl: `${this.getDemoBaseUrl()}/ords/auth`,
          webhookUrl: `${this.getDemoBaseUrl()}/ords/webhooks`,
        },
      };
    }

    try {
      // Get database information
      const response = await this.makeRequest<{
        version_full: string;
        version: string;
        banner: string;
      }>({
        method: 'GET',
        url: '/v_$version/',
      });

      const versionInfo = Array.isArray(response) ? response[0] : response;

      return {
        name: 'Oracle Database',
        type: 'Oracle',
        version: versionInfo?.version || 'Unknown',
        capabilities: [
          'tables',
          'views',
          'procedures',
          'functions',
          'packages',
          'sequences',
          'triggers',
          'sql_queries',
          'plsql_execution',
          'batch_operations',
          'transactions',
          'json_support',
          'spatial_data',
          'advanced_analytics',
        ],
        rateLimits: {
          requestsPerMinute: 500,
          requestsPerHour: 20000,
          requestsPerDay: 200000,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL || '',
          authUrl: `${this.protocol}://${this.host}:${this.port}/ords`,
          webhookUrl: `${this.protocol}://${this.host}:${this.port}/ords/webhooks`,
        },
      };
    } catch (error: unknown) {
      this.logger.warn('Could not fetch detailed system info, using defaults', { error: error instanceof Error ? error.message : String(error) });

      return {
        name: 'Oracle Database',
        type: 'Oracle',
        version: 'Unknown',
        capabilities: [
          'tables',
          'views',
          'sql_queries',
          'json_support',
        ],
        rateLimits: {
          requestsPerMinute: 500,
          requestsPerHour: 20000,
          requestsPerDay: 200000,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL || '',
          authUrl: `${this.protocol}://${this.host}:${this.port}/ords`,
          webhookUrl: `${this.protocol}://${this.host}:${this.port}/ords/webhooks`,
        },
      };
    }
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoCreate(entityType, data);
    }

    const tableName = this.getTableName(entityType);
    const payload = this.formatDataForOracle(data);

    try {
      const response = await this.makeRequest<OracleRecord>({
        method: 'POST',
        url: `/${tableName}/`,
        data: payload,
      });

      return this.formatDataFromOracle(response, entityType);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create ${entityType}: ${message}`, { cause: error });
    }
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoRead(entityType, id);
    }

    const tableName = this.getTableName(entityType);

    try {
      const response = await this.makeRequest<OracleRecord>({
        method: 'GET',
        url: `/${tableName}/${encodeURIComponent(id)}`,
      });

      return this.formatDataFromOracle(response, entityType);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoUpdate(entityType, id, data);
    }

    const tableName = this.getTableName(entityType);
    const payload = this.formatDataForOracle(data);

    try {
      const response = await this.makeRequest<OracleRecord>({
        method: 'PUT',
        url: `/${tableName}/${encodeURIComponent(id)}`,
        data: payload,
      });

      return this.formatDataFromOracle(response, entityType);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoDeleteRecord(entityType, id);
    }

    const tableName = this.getTableName(entityType);

    try {
      await this.makeRequest({
        method: 'DELETE',
        url: `/${tableName}/${encodeURIComponent(id)}`,
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async list(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoList(entityType, options);
    }

    const tableName = this.getTableName(entityType);

    const params = new URLSearchParams();

    // Add fields selection
    if (options.fields) {
      params.append('fields', options.fields.join(','));
    }

    // Add filtering using q parameter
    if (options.filters) {
      const whereClause = this.buildWhereClause(options.filters);
      if (whereClause) {
        params.append('q', `{${whereClause}}`);
      }
    }

    // Add sorting
    if (options.sortBy) {
      const sortOrder = options.sortOrder === 'desc' ? ':desc' : ':asc';
      params.append('orderBy', `${options.sortBy}${sortOrder}`);
    }

    // Add pagination
    if (options.limit) {
      params.append('limit', options.limit.toString());
    }

    if (options.offset) {
      params.append('offset', options.offset.toString());
    }

    const url = `/${tableName}/?${params.toString()}`;

    try {
      const response = await this.makeRequest<OracleResponse<OracleRecord>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.items)) {
        return response.items.map((item: OracleRecord) => this.formatDataFromOracle(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list ${entityType}: ${message}`, { cause: error });
    }
  }

  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoSearch(entityType, criteria);
    }

    const tableName = this.getTableName(entityType);
    const whereClause = this.buildWhereClause(criteria.filters, criteria.operator);

    const params = new URLSearchParams();
    if (whereClause) {
      params.append('q', `{${whereClause}}`);
    }
    if (criteria.limit) {
      params.append('limit', criteria.limit.toString());
    }
    if (criteria.offset) {
      params.append('offset', criteria.offset.toString());
    }

    const url = `/${tableName}/?${params.toString()}`;

    try {
      const response = await this.makeRequest<OracleResponse<OracleRecord>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.items)) {
        return response.items.map((item: OracleRecord) => this.formatDataFromOracle(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search ${entityType}: ${message}`, { cause: error });
    }
  }

  async setupWebhook(webhookUrl: string, events: string[]): Promise<string> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      const id = this.demoRegisterWebhook(webhookUrl, events);
      this.logger.info('Oracle demo webhook registered', { webhookId: id, events });
      return id;
    }

    // Oracle ORDS webhook setup using REST handlers
    const payload = {
      name: `IntegrationHub_${Date.now()}`,
      uri_template: '/webhook/:id',
      method: 'POST',
      source_type: 'json/collection',
      source: `
        BEGIN
          -- Insert webhook call record
          INSERT INTO webhook_log (
            webhook_id,
            endpoint_url,
            events,
            created_date
          ) VALUES (
            :id,
            '${webhookUrl}',
            '${events.join(',')}',
            SYSTIMESTAMP
          );
          
          -- Call external webhook
          APEX_WEB_SERVICE.make_rest_request(
            p_url => '${webhookUrl}',
            p_http_method => 'POST',
            p_body => :body
          );
        END;
      `,
    };

    try {
      const response = await this.makeRequest<{ id: string }>({
        method: 'POST',
        url: '/rest-handlers/',
        data: payload,
      });

      return response.id || `webhook_${Date.now()}`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to setup webhook: ${message}`, { cause: error });
    }
  }

  async removeWebhook(webhookId: string): Promise<boolean> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoRemoveWebhook(webhookId);
    }

    try {
      await this.makeRequest({
        method: 'DELETE',
        url: `/rest-handlers/${webhookId}`,
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to remove webhook: ${message}`, { cause: error });
    }
  }

  async getChanges(entityType: string, since: Date): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoGetChanges(entityType, since);
    }

    const tableName = this.getTableName(entityType);
    const sinceDate = since.toISOString();

    const whereClause = `"LAST_UPDATED" >= TO_TIMESTAMP('${sinceDate}', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"')`;

    const params = new URLSearchParams();
    params.append('q', `{${whereClause}}`);
    params.append('orderBy', 'LAST_UPDATED:desc');
    params.append('limit', '1000');

    const url = `/${tableName}/?${params.toString()}`;

    try {
      const response = await this.makeRequest<OracleResponse<OracleRecord>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.items)) {
        return response.items.map((item: OracleRecord) => this.formatDataFromOracle(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get changes for ${entityType}: ${message}`, { cause: error });
    }
  }

  private getTableName(entityType: string): string {
    // Map entity types to Oracle table names
    const tableMapping: Record<string, string> = {
      'customer': 'CUSTOMERS',
      'vendor': 'SUPPLIERS',
      'employee': 'EMPLOYEES',
      'product': 'PRODUCTS',
      'order': 'ORDERS',
      'invoice': 'INVOICES',
      'department': 'DEPARTMENTS',
      'location': 'LOCATIONS',
      'job': 'JOBS',
      'user': 'USERS',
    };

    return tableMapping[entityType.toLowerCase()] || entityType.toUpperCase();
  }

  private getPrimaryKeyField(entityType: string): string {
    // Map entity types to their primary key fields
    const keyFieldMapping: Record<string, string> = {
      'customer': 'CUSTOMER_ID',
      'vendor': 'SUPPLIER_ID',
      'employee': 'EMPLOYEE_ID',
      'product': 'PRODUCT_ID',
      'order': 'ORDER_ID',
      'invoice': 'INVOICE_ID',
      'department': 'DEPARTMENT_ID',
      'location': 'LOCATION_ID',
      'job': 'JOB_ID',
      'user': 'USER_ID',
    };

    return keyFieldMapping[entityType.toLowerCase()] || 'ID';
  }

  private buildWhereClause(filters: Record<string, unknown>, operator: 'AND' | 'OR' = 'AND'): string {
    const conditions: string[] = [];

    Object.entries(filters).forEach(([field, value]) => {
      const oracleField = `"${field.toUpperCase()}"`;

      if (typeof value === 'object' && value !== null && 'operator' in value) {
        // Advanced filter with operator
        const filterValue = value as { operator: string; value: unknown };
        const op = filterValue.operator;
        const val = filterValue.value;

        switch (op) {
        case 'equals':
          conditions.push(`${oracleField} = ${this.formatOracleValue(val)}`);
          break;
        case 'not_equals':
          conditions.push(`${oracleField} != ${this.formatOracleValue(val)}`);
          break;
        case 'greater_than':
          conditions.push(`${oracleField} > ${this.formatOracleValue(val)}`);
          break;
        case 'less_than':
          conditions.push(`${oracleField} < ${this.formatOracleValue(val)}`);
          break;
        case 'contains':
          conditions.push(`UPPER(${oracleField}) LIKE UPPER('%${String(val).replace(/'/g, '\'\'')}%')`);
          break;
        case 'startswith':
          conditions.push(`UPPER(${oracleField}) LIKE UPPER('${String(val).replace(/'/g, '\'\'')}%')`);
          break;
        case 'in':
          if (Array.isArray(val)) {
            const values = val.map(v => this.formatOracleValue(v)).join(', ');
            conditions.push(`${oracleField} IN (${values})`);
          }
          break;
        }
      } else {
        // Simple equality filter
        conditions.push(`${oracleField} = ${this.formatOracleValue(value)}`);
      }
    });

    return conditions.join(` ${operator} `);
  }

  private formatOracleValue(value: unknown): string {
    if (typeof value === 'string') {
      return `'${value.replace(/'/g, '\'\'')}'`;
    } else if (value instanceof Date) {
      return `TO_TIMESTAMP('${value.toISOString()}', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"')`;
    } else if (typeof value === 'boolean') {
      return value ? '1' : '0';
    } else if (typeof value === 'number') {
      return value.toString();
    } else if (value === null || value === undefined) {
      return 'NULL';
    } else {
      return `'${String(value).replace(/'/g, '\'\'')}'`;
    }
  }

  private formatDataForOracle(data: Partial<DataRecord>): Record<string, unknown> {
    const fieldMap = {
      name: 'NAME',
      email: 'EMAIL',
      phone: 'PHONE',
      description: 'DESCRIPTION',
      address: 'ADDRESS',
    };

    const formatted = mapCommonFields((data.fields ?? {}) as Record<string, unknown>, fieldMap);

    // Convert field names to uppercase for Oracle
    const oracleFormatted: Record<string, unknown> = {};
    Object.entries(formatted).forEach(([key, value]) => {
      oracleFormatted[key.toUpperCase()] = value;
    });

    return oracleFormatted;
  }

  private formatDataFromOracle(oracleData: OracleRecord, entityType: string): DataRecord {
    const fields: Record<string, unknown> = {};
    const _primaryKey = this.getPrimaryKeyField(entityType);

    const fieldMap = {
      NAME: 'name',
      EMAIL: 'email',
      PHONE: 'phone',
      DESCRIPTION: 'description',
      ADDRESS: 'address',
    };

    Object.assign(fields, mapCommonFields(oracleData, fieldMap));

    // Remove Oracle system fields from fields object
    delete fields[_primaryKey];
    delete fields.ROWID;
    delete fields.CREATED_DATE;
    delete fields.LAST_UPDATED;

    return {
      id: oracleData[_primaryKey] as string,
      externalId: oracleData[_primaryKey] as string,
      fields,
      metadata: {
        source: 'Oracle',
        lastModified: oracleData.LAST_UPDATED ? new Date(oracleData.LAST_UPDATED) : new Date(),
        version: oracleData.ROWID?.toString() ?? '1.0',
      },
    };
  }
}
