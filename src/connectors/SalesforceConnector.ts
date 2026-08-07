import { randomUUID } from 'crypto';
import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria, ConnectorUpsertResult } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo, OAuth2Credentials } from '../types';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import { mapCommonFields } from '../utils/connectorHelpers';
import { isDemoMode, isTestEnvironment } from '../config/runtimeFlags';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';
import type { SalesforceFieldDescription, SalesforceObjectDescription } from '../types/serializedAsset';
// Deliberately from the leaf `salesforceFieldName.ts` module, NOT from
// `SerializedAssetProfileValidator.ts` — that file transitively imports
// `connectorRegistry.ts` (via `connectorIdentity.ts`), which imports this
// class directly for its factory-wired registry entry. Importing the
// pattern from the validator closed a cycle that silently left
// `CONNECTOR_REGISTRY`'s `salesforce.classRef` as `undefined` whenever this
// module was required before `connectorRegistry.ts`. See
// `salesforceFieldName.ts`'s doc comment and
// `tests/unit/connectors/salesforceConnectorRegistryCycle.test.ts`.
import { SALESFORCE_FIELD_NAME_PATTERN } from '../services/serializedAsset/salesforceFieldName';
import { ValidationError } from '../errors/ConfigurationErrors';

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

const DEMO_ACCOUNTS: DataRecord[] = [
  {
    id: 'sf_demo_001',
    externalId: 'SF-DEMO-001',
    fields: {
      Name: 'Demo Manufacturing Co',
      Industry: 'Manufacturing',
      Phone: '+1-555-0100',
      Website: 'https://manufacturing.demo',
      BillingStreet: '100 Demo Way',
      BillingCity: 'Chicago',
      BillingState: 'IL',
      BillingPostalCode: '60601',
    },
  },
  {
    id: 'sf_demo_002',
    externalId: 'SF-DEMO-002',
    fields: {
      Name: 'Demo Retail Group',
      Industry: 'Retail',
      Phone: '+1-555-0200',
      Website: 'https://retail.demo',
      BillingStreet: '42 Commerce Blvd',
      BillingCity: 'Austin',
      BillingState: 'TX',
      BillingPostalCode: '73301',
    },
  },
  {
    id: 'sf_demo_003',
    externalId: 'SF-DEMO-003',
    fields: {
      Name: 'Demo Services LLC',
      Industry: 'Services',
      Phone: '+1-555-0300',
      Website: 'https://services.demo',
      BillingStreet: '500 Market Street',
      BillingCity: 'San Francisco',
      BillingState: 'CA',
      BillingPostalCode: '94105',
    },
  },
];

export interface SalesforceRecord {
  Id: string;
  [key: string]: unknown;
}

export interface SalesforceQueryResponse {
  totalSize: number;
  done: boolean;
  records: SalesforceRecord[];
  nextRecordsUrl?: string;
}

export interface SalesforceCreateResponse {
  id: string;
  success: boolean;
  errors: string[];
}

/**
 * Salesforce connector implementing REST API v59.0 integration
 * Supports SOQL queries, CRUD operations, and bulk data operations
 */
@injectable()
export class SalesforceConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'OAuth2 Resource Owner Password Credentials grant (grant_type=password) against real Salesforce REST API at src/connectors/SalesforceConnector.ts:448-507';
  static readonly proofCard = 'docs/review/proof-cards/salesforce-connector.md';

  private instanceUrl!: string;
  private readonly apiVersion = 'v59.0';
  private readonly authService: AuthService;
  private readonly outboundGovernance: OutboundGovernanceService;
  private demoMode = false;
  private readonly demoStore = new Map<string, Map<string, DataRecord>>();
  private readonly demoWebhooks = new Map<string, DemoWebhook>();
  private readonly demoChanges: DemoChange[] = [];

  constructor(
    systemId: string,
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) authService: AuthService,
    outboundGovernance: OutboundGovernanceService,
  ) {
    super('Salesforce', systemId, logger);
    this.authService = authService;
    if (!outboundGovernance) {
      throw new Error('OutboundGovernanceService is required for production connector outbound protection');
    }
    this.outboundGovernance = outboundGovernance;
  }

  private isDemoEnvironment(): boolean {
    if (process.env.FORCE_DISABLE_DEMO_MODE === '1') {
      return false;
    }
    if (isDemoMode()) {
      return true;
    }
    return isTestEnvironment();
  }

  private shouldUseDemoMode(config: AuthConfig): boolean {
    if (!this.isDemoEnvironment()) {
      return false;
    }

    if (config.type === 'api_key') {
      const credentials = config.credentials as { apiKey?: string };
      const apiKey = (credentials.apiKey || '').toLowerCase();
      return apiKey.length === 0 || apiKey.includes('demo') || apiKey.includes('test');
    }

    if (config.type === 'oauth2') {
      const credentials = config.credentials as OAuth2Credentials & {
        loginUrl?: string;
        instanceUrl?: string;
        username?: string;
        password?: string;
        securityToken?: string;
      };

      const markers = [
        credentials.clientId,
        credentials.clientSecret,
        credentials.loginUrl,
        credentials.instanceUrl,
        credentials.username,
      ]
        .filter(Boolean)
        .map(value => String(value).toLowerCase());

      const hasDemoMarker = markers.some(value =>
        value.includes('demo') ||
        value.includes('test') ||
        value.includes('example') ||
        value.includes('placeholder') ||
        value.includes('localhost'),
      );

      return hasDemoMarker || !credentials.password;
    }

    return false;
  }

  private getDemoBaseUrl(): string {
    return 'https://salesforce.demo.local';
  }

  private enableDemoMode(reason: string): void {
    this.demoMode = true;
    this.instanceUrl = this.getDemoBaseUrl();
    const baseUrl = `${this.instanceUrl}/services/data/${this.apiVersion}`;
    this.httpClient.defaults.baseURL = baseUrl;
    this.httpClient.defaults.headers.common['Authorization'] = 'Bearer demo-token';
    this.ensureDemoSeed();
    this.logger.info('Salesforce connector initialized in demo mode', {
      systemId: this.systemId,
      baseUrl,
      reason,
    });
  }

  private ensureDemoSeed(): void {
    if (this.demoStore.size > 0) {
      return;
    }

    const store = this.getDemoStore('account');
    for (const record of DEMO_ACCOUNTS) {
      const seed = this.cloneRecord(record);
      seed.id = seed.id || randomUUID();
      seed.externalId = seed.externalId || seed.id;
      store.set(seed.id, seed);
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

    if (!merged.fields && existing?.fields) {
      merged.fields = { ...(existing.fields as any) };
    }

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

    if (this.shouldUseDemoMode(config)) {
      this.enableDemoMode(`${config.type} demo credentials`);
      return;
    }

    if (config.type !== 'oauth2') {
      throw new Error('Salesforce connector requires OAuth2 authentication');
    }

    const credentials = config.credentials as OAuth2Credentials & {
      loginUrl?: string;
      instanceUrl?: string;
    };

    this.instanceUrl = credentials.instanceUrl || 'https://login.salesforce.com';

    // Set base URL for Salesforce REST API
    const baseUrl = `${this.instanceUrl}/services/data/${this.apiVersion}`;
    this.httpClient.defaults.baseURL = baseUrl;

    this.logger.info('Salesforce connector initialized', {
      instanceUrl: this.instanceUrl,
      apiVersion: this.apiVersion,
    });
  }

  async authenticate(): Promise<boolean> {
    if (this.demoMode) {
      this.isAuthenticated = true;
      this.logger.info('Salesforce demo authentication successful');
      return true;
    }

    try {
      const credentials = this.authConfig.credentials as OAuth2Credentials & {
        loginUrl?: string;
        username?: string;
        password?: string;
        securityToken?: string;
      };

      // Salesforce OAuth2 Username-Password flow
      const authCredentials = {
        type: 'oauth2' as const,
        credentials: {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          token_url: `${credentials.loginUrl || 'https://login.salesforce.com'}/services/oauth2/token`,
          grant_type: 'password',
          username: credentials.username,
          password: `${credentials.password}${credentials.securityToken || ''}`,
          scope: 'api',
        },
      };

      const tokenInfo = await this.authService.authenticateOAuth2(authCredentials);

      if (!tokenInfo?.accessToken) {
        throw new Error('Failed to obtain Salesforce access token');
      }

      if (tokenInfo.instanceUrl) {
        this.instanceUrl = tokenInfo.instanceUrl;
      }

      if (this.authConfig) {
        this.authConfig.expiresAt = tokenInfo.expiresAt;
      }

      // Update base URL with correct instance URL
      this.httpClient.defaults.baseURL = `${this.instanceUrl}/services/data/${this.apiVersion}`;
      this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${tokenInfo.accessToken}`;
      this.httpClient.defaults.headers.common['Content-Type'] = 'application/json';
      this.httpClient.defaults.headers.common['Accept'] = 'application/json';

      this.isAuthenticated = true;
      this.logger.info('Salesforce authentication successful', {
        instanceUrl: this.instanceUrl,
      });
      return true;
    } catch (error: unknown) {
      this.logger.error('Salesforce authentication failed', error);
      this.isAuthenticated = false;
      throw error;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return {
        name: 'Salesforce (Demo)',
        type: 'Salesforce',
        version: this.apiVersion,
        capabilities: [
          'accounts',
          'contacts',
          'leads',
          'mock_data',
        ],
        rateLimits: {
          requestsPerMinute: 1000,
          requestsPerHour: 60000,
          requestsPerDay: 1000000,
        },
        endpoints: {
          baseUrl: `${this.instanceUrl}/services/data/${this.apiVersion}`,
          authUrl: `${this.instanceUrl}/services/oauth2/authorize`,
          webhookUrl: `${this.instanceUrl}/services/data/${this.apiVersion}/sobjects`,
        },
      };
    }

    try {
      // Get organization info
      const response = await this.makeRequest<SalesforceQueryResponse>({
        method: 'GET',
        url: '/query',
        params: {
          q: 'SELECT Name, OrganizationType, Edition, InstanceName FROM Organization LIMIT 1',
        },
      });

      const org = response.records?.[0];

      return {
        name: org?.Name as string || 'Salesforce',
        type: 'Salesforce',
        version: this.apiVersion,
        capabilities: [
          'accounts',
          'contacts',
          'leads',
          'opportunities',
          'cases',
          'campaigns',
          'tasks',
          'events',
          'custom_objects',
          'soql_queries',
          'bulk_operations',
          'apex_rest',
          'streaming_api',
          'platform_events',
        ],
        rateLimits: {
          requestsPerMinute: 1000,
          requestsPerHour: 100000,
          requestsPerDay: 1000000,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL || '',
          authUrl: `${this.instanceUrl}/services/oauth2/authorize`,
          webhookUrl: `${this.instanceUrl}/services/data/${this.apiVersion}/sobjects`,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get Salesforce system info: ${message}`, { cause: error });
    }
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.demoCreate(entityType, data);
    }

    const sobjectType = this.getSObjectType(entityType);
    const rawPayload = this.formatDataForSalesforce(data);
    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'create', entityType, rawPayload);

    try {
      const response = await this.makeRequest<SalesforceCreateResponse>({
        method: 'POST',
        url: `/sobjects/${sobjectType}`,
        data: payload,
      });

      if (!response.success) {
        throw new Error(`Salesforce create failed: ${response.errors.join(', ')}`);
      }

      // Fetch the created record to return complete data
      const createdRecord = await this.read(entityType, response.id);
      if (!createdRecord) {
        throw new Error('Failed to retrieve created record');
      }
      return createdRecord;
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

    const sobjectType = this.getSObjectType(entityType);

    try {
      const response = await this.makeRequest<SalesforceRecord>({
        method: 'GET',
        url: `/sobjects/${sobjectType}/${id}`,
      });

      return this.formatDataFromSalesforce(response, entityType);
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

    const sobjectType = this.getSObjectType(entityType);
    const rawPayload = this.formatDataForSalesforce(data);
    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'update', entityType, rawPayload, { resourceId: id });

    try {
      await this.makeRequest({
        method: 'PATCH',
        url: `/sobjects/${sobjectType}/${id}`,
        data: payload,
      });

      // Fetch the updated record to return complete data
      const updatedRecord = await this.read(entityType, id);
      if (!updatedRecord) {
        throw new Error('Failed to retrieve updated record');
      }
      return updatedRecord;
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

    const sobjectType = this.getSObjectType(entityType);
    await this.validateOutboundWrite(this.outboundGovernance, 'delete', entityType, { id }, { resourceId: id });

    try {
      await this.makeRequest({
        method: 'DELETE',
        url: `/sobjects/${sobjectType}/${id}`,
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

    const sobjectType = this.getSObjectType(entityType);
    const fields = options.fields?.join(', ') || 'Id, Name, CreatedDate, LastModifiedDate';

    let soql = `SELECT ${fields} FROM ${sobjectType}`;

    // Add WHERE clause for filters
    if (options.filters) {
      const whereClause = this.buildWhereClause(options.filters);
      if (whereClause) {
        soql += ` WHERE ${whereClause}`;
      }
    }

    // Add ORDER BY clause
    if (options.sortBy) {
      const sortOrder = options.sortOrder === 'desc' ? 'DESC' : 'ASC';
      soql += ` ORDER BY ${options.sortBy} ${sortOrder}`;
    }

    // Add LIMIT clause
    if (options.limit) {
      soql += ` LIMIT ${options.limit}`;
    }

    // Add OFFSET clause
    if (options.offset) {
      soql += ` OFFSET ${options.offset}`;
    }

    try {
      const response = await this.makeRequest<SalesforceQueryResponse>({
        method: 'GET',
        url: '/query',
        params: { q: soql },
      });

      return response.records.map((record: SalesforceRecord) =>
        this.formatDataFromSalesforce(record, entityType),
      );
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

    const sobjectType = this.getSObjectType(entityType);
    const whereClause = this.buildWhereClause(criteria.filters, criteria.operator);

    let soql = `SELECT Id, Name, CreatedDate, LastModifiedDate FROM ${sobjectType}`;

    if (whereClause) {
      soql += ` WHERE ${whereClause}`;
    }

    if (criteria.limit) {
      soql += ` LIMIT ${criteria.limit}`;
    }

    if (criteria.offset) {
      soql += ` OFFSET ${criteria.offset}`;
    }

    try {
      const response = await this.makeRequest<SalesforceQueryResponse>({
        method: 'GET',
        url: '/query',
        params: { q: soql },
      });

      return response.records.map((record: SalesforceRecord) =>
        this.formatDataFromSalesforce(record, entityType),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search ${entityType}: ${message}`, { cause: error });
    }
  }

  async setupWebhook(webhookUrl: string, events: string[]): Promise<string> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      const id = this.demoRegisterWebhook(webhookUrl, events);
      this.logger.info('Salesforce demo webhook registered', { webhookId: id, events });
      return id;
    }

    // Salesforce uses Platform Events or Streaming API for webhooks
    // This is a simplified implementation for demonstration
    const payload = {
      Name: `IntegrationHub_${Date.now()}`,
      EndpointUrl: webhookUrl,
      IsActive: true,
      Events: events.join(','),
    };

    try {
      const response = await this.makeRequest<SalesforceCreateResponse>({
        method: 'POST',
        url: '/sobjects/RemoteSiteSetting',
        data: payload,
      });

      return response.id;
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
        url: `/sobjects/RemoteSiteSetting/${webhookId}`,
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

    const sobjectType = this.getSObjectType(entityType);
    const sinceDate = since.toISOString();

    const soql = `SELECT Id, Name, CreatedDate, LastModifiedDate FROM ${sobjectType} ` +
      `WHERE LastModifiedDate >= ${sinceDate} ORDER BY LastModifiedDate DESC LIMIT 1000`;

    try {
      const response = await this.makeRequest<SalesforceQueryResponse>({
        method: 'GET',
        url: '/query',
        params: { q: soql },
      });

      return response.records.map((record: SalesforceRecord) =>
        this.formatDataFromSalesforce(record, entityType),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get changes for ${entityType}: ${message}`, { cause: error });
    }
  }

  /**
   * Live Salesforce object-describe metadata (Task 4, 2026-07-27 NetSuite
   * serialized-asset sync plan). Used by Task 6's activation readiness gate
   * (field createable/updateable/queryable/externalId/unique flags) and by
   * Task 7's run-start capability assertion. `entityType` is a literal path
   * segment here, but is still `encodeURIComponent`-encoded — defense in
   * depth, since the interface only accepts the closed `'Product2' | 'Asset'`
   * union anyway.
   */
  async describeSObject(entityType: 'Product2' | 'Asset'): Promise<SalesforceObjectDescription> {
    await this.ensureAuthenticated();

    const raw = await this.makeRequest<unknown>({
      method: 'GET',
      url: `/sobjects/${encodeURIComponent(entityType)}/describe`,
    });

    return this.parseObjectDescription(raw, entityType);
  }

  /**
   * Defensive parse: the describe response is JSON from a live external API,
   * not a value this codebase controls, so every property is `typeof`-checked
   * before use rather than trusted from the declared response shape. A
   * malformed/non-object response degrades to empty fields and
   * all-flags-false rather than throwing — callers (Task 6 readiness) treat
   * missing capability the same as an absent field either way.
   */
  private parseObjectDescription(raw: unknown, entityType: string): SalesforceObjectDescription {
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const rawFields = Array.isArray(obj.fields) ? obj.fields : [];

    const fields: SalesforceFieldDescription[] = rawFields
      .filter((field): field is Record<string, unknown> => !!field && typeof field === 'object')
      .map((field) => ({
        name: typeof field.name === 'string' ? field.name : '',
        type: typeof field.type === 'string' ? field.type : '',
        createable: field.createable === true,
        updateable: field.updateable === true,
        queryable: field.queryable === true,
        externalId: field.externalId === true,
        unique: field.unique === true,
        referenceTo: Array.isArray(field.referenceTo)
          ? field.referenceTo.filter((ref): ref is string => typeof ref === 'string')
          : [],
      }))
      .filter((field) => field.name.length > 0);

    return {
      name: typeof obj.name === 'string' ? obj.name : entityType,
      createable: obj.createable === true,
      updateable: obj.updateable === true,
      queryable: obj.queryable === true,
      fields,
    };
  }

  /**
   * Exact Product2 External-ID lookup (Task 4). Row-count classification
   * (zero/one/many) is done by the caller (`SalesforceProductResolver`) —
   * this method only validates the field identifier, builds the bounded
   * SOQL query, and returns whatever rows come back. Field identifiers are
   * validated BEFORE query construction; lookup VALUES go through a
   * dedicated single-quote/backslash SOQL escape (`escapeSOQLLiteral`) —
   * deliberately not `formatSOQLValue`/`buildWhereClause`'s existing
   * quote-only escaping, which does not escape backslashes.
   */
  async findProduct2ByExternalId(field: string, value: string): Promise<readonly { Id: string }[]> {
    await this.ensureAuthenticated();

    if (!SALESFORCE_FIELD_NAME_PATTERN.test(field)) {
      throw new ValidationError('Invalid Salesforce field identifier for Product2 lookup', []);
    }

    const soql = `SELECT Id FROM Product2 WHERE ${field} = '${this.escapeSOQLLiteral(value)}'`;

    const response = await this.makeRequest<SalesforceQueryResponse>({
      method: 'GET',
      url: '/query',
      params: { q: soql },
    });

    const records = Array.isArray(response?.records) ? response.records : [];
    return records.map((record) => ({
      Id: typeof record?.Id === 'string' ? record.Id : '',
    }));
  }

  /**
   * Dedicated SOQL string-literal escape: backslash FIRST, then single
   * quote — the order matters (escaping the quote first would double-escape
   * a backslash introduced by the quote-escape step). Distinct from
   * `formatSOQLValue`'s existing quote-only replace, which never escapes a
   * literal backslash in the value.
   */
  private escapeSOQLLiteral(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'');
  }

  /**
   * Native Salesforce External ID upsert for `Asset` (Task 4, decision 4:
   * a read-then-create sequence is prohibited — this is the one mutation
   * call the whole serialized-asset flow issues). Order matches the task
   * brief exactly: (1) reject any entity type but the literal `Asset` before
   * touching auth; (2) authenticate + validate the field identifier;
   * (3) governance, WITHOUT the External ID in `resourceId` (never placed in
   * governance metadata); (4) `PATCH` via `makeSensitiveRequest` with a
   * redacted log URL; (5) classify the response status; (6) never log the
   * External ID or payload — nothing in this method calls `this.logger.*`.
   */
  async upsert(
    entityType: string,
    externalIdField: string,
    externalIdValue: string,
    data: Record<string, unknown>,
  ): Promise<ConnectorUpsertResult> {
    if (entityType !== 'Asset') {
      throw new ValidationError(
        `SalesforceConnector.upsert only supports entityType 'Asset', received '${entityType}'`,
        [],
      );
    }

    await this.ensureAuthenticated();

    if (!SALESFORCE_FIELD_NAME_PATTERN.test(externalIdField)) {
      throw new ValidationError('Invalid Salesforce field identifier for Asset upsert', []);
    }

    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'upsert', 'Asset', data);

    const encodedValue = encodeURIComponent(externalIdValue);
    const safeLogUrl = `/sobjects/Asset/${externalIdField}/[REDACTED]`;

    const response = await this.makeSensitiveRequest<unknown>(
      {
        method: 'PATCH',
        url: `/sobjects/Asset/${externalIdField}/${encodedValue}`,
        data: payload,
      },
      safeLogUrl,
    );

    return this.classifyUpsertResponse(response.status, response.data);
  }

  /** `201` created (surfacing the id when present), `204` updated, anything else unknown. */
  private classifyUpsertResponse(status: number, data: unknown): ConnectorUpsertResult {
    if (status === 201) {
      return { outcome: 'created', id: this.extractSalesforceId(data) };
    }
    if (status === 204) {
      return { outcome: 'updated' };
    }
    return { outcome: 'unknown' };
  }

  private extractSalesforceId(data: unknown): string | undefined {
    if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).id === 'string') {
      return (data as Record<string, unknown>).id as string;
    }
    return undefined;
  }

  private getSObjectType(entityType: string): string {
    // Map common entity types to Salesforce SObject types
    const entityMapping: Record<string, string> = {
      'account': 'Account',
      'contact': 'Contact',
      'lead': 'Lead',
      'opportunity': 'Opportunity',
      'case': 'Case',
      'campaign': 'Campaign',
      'task': 'Task',
      'event': 'Event',
    };

    return entityMapping[entityType.toLowerCase()] || entityType;
  }

  private buildWhereClause(filters: Record<string, unknown>, operator: 'AND' | 'OR' = 'AND'): string {
    const conditions: string[] = [];

    Object.entries(filters).forEach(([field, value]) => {
      if (typeof value === 'object' && value !== null && 'operator' in value) {
        // Advanced filter with operator
        const filterValue = value as { operator: string; value: unknown };
        const op = filterValue.operator;
        const val = filterValue.value;

        switch (op) {
        case 'equals':
          conditions.push(`${field} = ${this.formatSOQLValue(val)}`);
          break;
        case 'not_equals':
          conditions.push(`${field} != ${this.formatSOQLValue(val)}`);
          break;
        case 'greater_than':
          conditions.push(`${field} > ${this.formatSOQLValue(val)}`);
          break;
        case 'less_than':
          conditions.push(`${field} < ${this.formatSOQLValue(val)}`);
          break;
        case 'contains':
          conditions.push(`${field} LIKE '%${String(val).replace(/'/g, '\\\'')}%'`);
          break;
        case 'startswith':
          conditions.push(`${field} LIKE '${String(val).replace(/'/g, '\\\'')}%'`);
          break;
        }
      } else {
        // Simple equality filter
        conditions.push(`${field} = ${this.formatSOQLValue(value)}`);
      }
    });

    return conditions.join(` ${operator} `);
  }

  private formatSOQLValue(value: unknown): string {
    if (typeof value === 'string') {
      return `'${value.replace(/'/g, '\\\'')}'`;
    } else if (value instanceof Date) {
      return value.toISOString();
    } else if (typeof value === 'boolean') {
      return value.toString();
    } else if (typeof value === 'number') {
      return value.toString();
    } else if (value === null || value === undefined) {
      return 'NULL';
    } else {
      return `'${String(value).replace(/'/g, '\\\'')}'`;
    }
  }

  private formatDataForSalesforce(data: Partial<DataRecord>): Record<string, unknown> {
    const fieldMap = {
      name: 'Name',
      email: 'Email',
      phone: 'Phone',
      description: 'Description',
      website: 'Website',
    };

    const formatted = mapCommonFields((data.fields as Record<string, unknown>) ?? {}, fieldMap);

    // Remove null and undefined values as Salesforce doesn't accept them
    Object.keys(formatted).forEach(key => {
      if (formatted[key] === null || formatted[key] === undefined) {
        delete formatted[key];
      }
    });

    return formatted;
  }

  private formatDataFromSalesforce(salesforceData: SalesforceRecord, _entityType: string): DataRecord {
    const fields: Record<string, unknown> = {};

    const fieldMap = {
      Name: 'name',
      Email: 'email',
      Phone: 'phone',
      Description: 'description',
      Website: 'website',
    };

    Object.assign(fields, mapCommonFields(salesforceData, fieldMap));

    // Remove Salesforce system fields from fields object
    delete fields.Id;
    delete fields.CreatedDate;
    delete fields.LastModifiedDate;
    delete fields.SystemModstamp;

    return {
      id: salesforceData.Id,
      externalId: salesforceData.Id,
      fields,
      metadata: {
        source: 'Salesforce',
        lastModified: salesforceData.LastModifiedDate
          ? new Date(salesforceData.LastModifiedDate as string)
          : new Date(),
        version: salesforceData.SystemModstamp?.toString() ?? '1.0',
      },
    };
  }
}
