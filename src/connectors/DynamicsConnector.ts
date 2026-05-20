import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, ConnectionStatus, DataRecord, SystemInfo, OAuth2Credentials, ODataResponse, FilterOptions, FilterValue } from '../types';
import type { AuthService } from '../services/AuthService';
import type { DynamicsListResponse, DynamicsOrganization } from '../types/api-responses';
import type { Logger } from '../utils/Logger';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import { mapCommonFields, mapFromCommonFields } from '../utils/connectorHelpers';
import { isDemoMode } from '../config/runtimeFlags';

// Type guard helper for error objects with HTTP response
interface ErrorWithResponse {
  response?: {
    status?: number;
    headers?: Record<string, string>;
  };
  code?: string;
}

/**
 * DynamicsConnector class for integrating with Microsoft Dynamics 365 via its Web API.
 * Implements the IConnector interface for standardized data operations.
 */
@injectable()
export class DynamicsConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Real Dynamics 365 Web API v9.2 OAuth2 scaffolding; ships demo fallback when isDemoMode() or demoCredentials — no production credential test on file';

  private readonly authService: AuthService;
  private tenantId!: string;
  private clientId!: string;
  private clientSecret!: string;
  private resourceUrl!: string;
  private readonly apiVersion = 'v9.2';
  private demoMode = false;
  private readonly demoStore = new Map<string, Map<string, DataRecord>>();

  /**
   * Creates an instance of DynamicsConnector.
   * @param {string} systemId - The unique identifier for this Dynamics 365 system instance.
   * @param {Logger} logger - The logger instance.
   * @param {AuthService} authService - The authentication service.
   */
  constructor(
    systemId: string,
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) authService: AuthService,
  ) {
    super('Dynamics365', systemId, logger);
    this.authService = authService;
  }

  /**
   * Initializes the Dynamics 365 connector with authentication configuration.
   * @param {AuthConfig} config - The authentication configuration for Dynamics 365.
   * @returns {Promise<void>}
   * @throws {Error} If the authentication type is not OAuth2.
   */
  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    if (config.type !== 'oauth2') {
      throw new Error('Dynamics 365 connector requires OAuth2 authentication');
    }

    const credentials = config.credentials as OAuth2Credentials;
    this.tenantId = credentials.tenant_id || credentials.tenantId || '';
    this.clientId = credentials.clientId;
    this.clientSecret = credentials.clientSecret;
    this.resourceUrl = credentials.resource_url || credentials.resourceUrl || '';

    const baseUrl = credentials.base_url || credentials.baseUrl || `${this.resourceUrl}/api/data/${this.apiVersion}`;
    this.httpClient.defaults.baseURL = baseUrl;

    const demoCredentials = this.clientId?.toLowerCase().includes('demo') ||
                           this.clientSecret?.toLowerCase().includes('demo') ||
                           this.tenantId?.toLowerCase().includes('demo');

    if (isDemoMode() || demoCredentials) {
      this.demoMode = true;
      this.seedDemoData();
      this.logger.info('Dynamics 365 connector initialized in DEMO mode');
      return;
    }

    this.logger.info('Dynamics 365 connector initialized');
  }

  private seedDemoData(): void {
    // Seed accounts
    const accounts = this.demoStore.get('account') || new Map();
    accounts.set('ACCT-001', {
      id: 'ACCT-001',
      fields: {
        accountid: 'ACCT-001',
        name: 'Demo Corporation A',
        accountnumber: 'ACC-10001',
        revenue: 5000000,
        numberofemployees: 250,
        industry: 'Technology',
        address1_city: 'Seattle',
        address1_stateorprovince: 'WA',
        address1_country: 'USA',
        emailaddress1: 'contact@democorpa.com',
        telephone1: '555-0100'
      }
    });
    accounts.set('ACCT-002', {
      id: 'ACCT-002',
      fields: {
        accountid: 'ACCT-002',
        name: 'Demo Corporation B',
        accountnumber: 'ACC-10002',
        revenue: 8500000,
        numberofemployees: 450,
        industry: 'Manufacturing',
        address1_city: 'Chicago',
        address1_stateorprovince: 'IL',
        address1_country: 'USA',
        emailaddress1: 'info@democorpb.com',
        telephone1: '555-0200'
      }
    });
    this.demoStore.set('account', accounts);

    // Seed contacts
    const contacts = this.demoStore.get('contact') || new Map();
    contacts.set('CONT-001', {
      id: 'CONT-001',
      fields: {
        contactid: 'CONT-001',
        firstname: 'John',
        lastname: 'Smith',
        emailaddress1: 'john.smith@democorpa.com',
        telephone1: '555-0101',
        jobtitle: 'VP of Sales',
        parentcustomerid: 'ACCT-001'
      }
    });
    contacts.set('CONT-002', {
      id: 'CONT-002',
      fields: {
        contactid: 'CONT-002',
        firstname: 'Jane',
        lastname: 'Doe',
        emailaddress1: 'jane.doe@democorpb.com',
        telephone1: '555-0201',
        jobtitle: 'Director of Operations',
        parentcustomerid: 'ACCT-002'
      }
    });
    this.demoStore.set('contact', contacts);

    // Seed opportunities
    const opportunities = this.demoStore.get('opportunity') || new Map();
    opportunities.set('OPP-001', {
      id: 'OPP-001',
      fields: {
        opportunityid: 'OPP-001',
        name: 'Enterprise Software License',
        estimatedvalue: 250000,
        closeprobability: 75,
        estimatedclosedate: '2025-12-31',
        stepname: 'Proposal',
        parentaccountid: 'ACCT-001'
      }
    });
    this.demoStore.set('opportunity', opportunities);

    this.logger.info('Dynamics 365 demo data seeded', {
      accounts: accounts.size,
      contacts: contacts.size,
      opportunities: opportunities.size
    });
  }

  private handleAuthError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 401 || err.response?.status === 403) {
      this.isAuthenticated = false;
      throw new Error(
        'Dynamics 365 Authentication failed. Please check your credentials.\n' +
        'Troubleshooting:\n' +
        '- Verify Azure AD tenant ID, client ID, and client secret\n' +
        '- Check application permissions in Azure AD\n' +
        '- Ensure the app has API permissions for Dynamics 365\n' +
        '- Verify the resource URL is correct'
      );
    }
  }

  private handleRateLimitError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 429) {
      const retryAfter = err.response.headers?.['retry-after'] || '60';
      throw new Error(`Dynamics 365 rate limit exceeded. Retry after ${retryAfter} seconds`);
    }
  }

  private handleTimeoutError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new Error(
        'Dynamics 365 request timed out. The service may be slow or unavailable.\n' +
        'Troubleshooting:\n' +
        '- Check Dynamics 365 service status\n' +
        '- Verify network connectivity\n' +
        '- Consider increasing timeout value'
      );
    }
  }

  async authenticate(): Promise<boolean> {
    if (this.demoMode) {
      this.isAuthenticated = true;
      this.logger.info('Dynamics 365 authentication successful (demo mode)');
      return true;
    }

    try {
      const credentials = {
        type: 'oauth2' as const,
        credentials: {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          token_url: `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
          scope: `${this.resourceUrl}/.default`,
          grant_type: 'client_credentials',
        },
      };

      const tokenInfo = await this.authService.authenticateOAuth2(credentials);

      if (!tokenInfo?.accessToken) {
        throw new Error('Failed to obtain access token');
      }

      if (this.authConfig) {
        this.authConfig.expiresAt = tokenInfo.expiresAt;
      }

      this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${tokenInfo.accessToken}`;
      this.httpClient.defaults.headers.common['OData-MaxVersion'] = '4.0';
      this.httpClient.defaults.headers.common['OData-Version'] = '4.0';
      this.httpClient.defaults.headers.common['Accept'] = 'application/json';
      this.httpClient.defaults.headers.common['Prefer'] = 'return=representation';

      this.isAuthenticated = true;
      this.logger.info('Dynamics 365 authentication successful');
      return true;
    } catch (error: unknown) {
      this.logger.error('Dynamics 365 authentication failed', error);
      this.isAuthenticated = false;
      this.handleAuthError(error);
      throw error;
    }
  }

  override async testConnection(): Promise<ConnectionStatus> {
    try {
      const startTime = Date.now();
      await this.authenticate();
      await this.getSystemInfo();
      const endTime = Date.now();

      return {
        systemType: this.systemType,
        systemId: this.systemId,
        isConnected: true,
        lastTestTime: new Date(),
        latency: endTime - startTime,
      };
    } catch (error: unknown) {
      this.logger.error('Connection test failed', error);
      return {
        systemType: this.systemType,
        systemId: this.systemId,
        isConnected: false,
        lastTestTime: new Date(),
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return {
        name: 'Dynamics 365 (Demo)',
        type: 'Dynamics365',
        version: '9.2.0',
        capabilities: [
          'accounts',
          'contacts',
          'leads',
          'opportunities',
          'cases',
          'activities',
          'custom_entities',
          'real_time_sync',
          'bulk_operations',
          'webhooks',
          'business_process_flows',
          'demo_mode'
        ],
        rateLimits: {
          requestsPerMinute: 6000,
          requestsPerHour: 300000,
          requestsPerDay: 1000000,
        },
        endpoints: {
          baseUrl: 'https://demo.dynamics.com/api/data/v9.2',
          authUrl: 'https://login.microsoftonline.com/demo/oauth2/v2.0/authorize',
          webhookUrl: 'https://demo.dynamics.com/api/data/v9.2/serviceendpoints',
        },
      };
    }

    try {
      // Get organization info
      const response = await this.makeRequest<DynamicsListResponse<DynamicsOrganization>>({
        method: 'GET',
        url: '/organizations',
      });

      const organization = response.value?.[0];

      return {
        name: organization?.friendlyname || 'Dynamics 365',
        type: 'Dynamics365',
        version: organization?.version || 'Unknown',
        capabilities: [
          'accounts',
          'contacts',
          'leads',
          'opportunities',
          'cases',
          'activities',
          'custom_entities',
          'real_time_sync',
          'bulk_operations',
          'webhooks',
          'business_process_flows',
        ],
        rateLimits: {
          requestsPerMinute: 6000,
          requestsPerHour: 300000,
          requestsPerDay: 1000000,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL || '',
          authUrl: `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize`,
          webhookUrl: `${this.resourceUrl}/api/data/${this.apiVersion}/serviceendpoints`,
        },
      };
    } catch (error: unknown) {
      this.handleTimeoutError(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get Dynamics 365 system info: ${message}`, { cause: error });
    }
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.createDemo(entityType, data);
    }

    const entitySetName = this.getEntitySetName(entityType);
    const payload = this.formatDataForDynamics(data);

    try {
      const response = await this.makeRequest<Record<string, unknown>>({
        method: 'POST',
        url: `/${entitySetName}`,
        data: payload,
      });

      return this.formatDataFromDynamics(response, entityType);
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create ${entityType}: ${message}`, { cause: error });
    }
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.readDemo(entityType, id);
    }

    const entitySetName = this.getEntitySetName(entityType);
    const primaryKey = this.getPrimaryKeyField(entityType);

    try {
      const response = await this.makeRequest<Record<string, unknown>>({
        method: 'GET',
        url: `/${entitySetName}(${primaryKey}=${id})`,
      });

      return this.formatDataFromDynamics(response, entityType);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      this.handleTimeoutError(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.updateDemo(entityType, id, data);
    }

    const entitySetName = this.getEntitySetName(entityType);
    const primaryKey = this.getPrimaryKeyField(entityType);
    const payload = this.formatDataForDynamics(data);

    try {
      const response = await this.makeRequest<Record<string, unknown>>({
        method: 'PATCH',
        url: `/${entitySetName}(${primaryKey}=${id})`,
        data: payload,
      });

      return this.formatDataFromDynamics(response, entityType);
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.deleteDemo(entityType, id);
    }

    const entitySetName = this.getEntitySetName(entityType);
    const primaryKey = this.getPrimaryKeyField(entityType);

    try {
      await this.makeRequest({
        method: 'DELETE',
        url: `/${entitySetName}(${primaryKey}=${id})`,
      });

      return true;
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async list(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.listDemo(entityType, options);
    }

    const entitySetName = this.getEntitySetName(entityType);
    const params = new URLSearchParams();

    if (options.limit) params.append('$top', options.limit.toString());
    if (options.offset) params.append('$skip', options.offset.toString());
    if (options.fields) params.append('$select', options.fields.join(','));
    if (options.sortBy) {
      const order = options.sortOrder === 'desc' ? 'desc' : 'asc';
      params.append('$orderby', `${options.sortBy} ${order}`);
    }
    if (options.filters) {
      const filterString = this.buildODataFilter(options.filters);
      if (filterString) params.append('$filter', filterString);
    }

    const url = `/${entitySetName}${params.toString() ? `?${params.toString()}` : ''}`;

    try {
      const response = await this.makeRequest<ODataResponse>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.value)) {
        return response.value.map((item: unknown) => this.formatDataFromDynamics(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list ${entityType}: ${message}`, { cause: error });
    }
  }

  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.searchDemo(entityType, criteria);
    }

    const entitySetName = this.getEntitySetName(entityType);
    const filterString = this.buildODataFilter(criteria.filters, criteria.operator);

    const params = new URLSearchParams();
    if (filterString) params.append('$filter', filterString);
    if (criteria.limit) params.append('$top', criteria.limit.toString());
    if (criteria.offset) params.append('$skip', criteria.offset.toString());

    const url = `/${entitySetName}?${params.toString()}`;

    try {
      const response = await this.makeRequest<ODataResponse>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.value)) {
        return response.value.map((item: unknown) => this.formatDataFromDynamics(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search ${entityType}: ${message}`, { cause: error });
    }
  }

  async setupWebhook(webhookUrl: string, _events: string[], authType = 1): Promise<string> {
    await this.ensureAuthenticated();

    const payload = {
      name: `IntegrationHub_${Date.now()}`,
      url: webhookUrl,
      contract: 8, // REST webhook contract
      authtype: authType, // Configurable authentication: 1=None, 2=SAS Key, 3=Webhook Key, 4=HttpHeader
      description: 'Integration Hub webhook',
    };

    try {
      const response = await this.makeRequest<{ serviceendpointid: string }>({
        method: 'POST',
        url: '/serviceendpoints',
        data: payload,
      });

      return response.serviceendpointid;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to setup webhook: ${message}`, { cause: error });
    }
  }

  async removeWebhook(webhookId: string): Promise<boolean> {
    await this.ensureAuthenticated();

    try {
      await this.makeRequest({
        method: 'DELETE',
        url: `/serviceendpoints(${webhookId})`,
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to remove webhook: ${message}`, { cause: error });
    }
  }

  async getChanges(entityType: string, since: Date): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    return this.search(entityType, {
      filters: { modifiedon: { operator: 'gt', value: since.toISOString() } },
      limit: 1000,
    });
  }

  private getEntitySetName(entityType: string): string {
    // Map common entity types to Dynamics entity set names
    const entityMapping: Record<string, string> = {
      'account': 'accounts',
      'contact': 'contacts',
      'lead': 'leads',
      'opportunity': 'opportunities',
      'case': 'incidents',
      'custom_entity': 'new_customentities', // example custom entity
    };

    return entityMapping[entityType.toLowerCase()] || `${entityType.toLowerCase()}s`;
  }

  private getPrimaryKeyField(entityType: string): string {
    // Map entity types to their primary key fields
    const keyMapping: Record<string, string> = {
      'account': 'accountid',
      'contact': 'contactid',
      'lead': 'leadid',
      'opportunity': 'opportunityid',
      'case': 'incidentid',
      'custom_entity': 'new_customentityid',
    };

    return keyMapping[entityType.toLowerCase()] || `${entityType.toLowerCase()}id`;
  }

  private buildODataFilter(filters: FilterOptions | Record<string, unknown>, operator: 'AND' | 'OR' = 'AND'): string {
    const filterParts: string[] = [];

    Object.entries(filters).forEach(([field, value]) => {
      if (typeof value === 'object' && value !== null && 'operator' in value) {
        // Advanced filter with operator
        const filterValue = value as FilterValue;
        const op = filterValue.operator;
        const val = filterValue.value;

        switch (op) {
        case 'equals':
          filterParts.push(`${field} eq ${this.formatFilterValue(val)}`);
          break;
        case 'not_equals':
          filterParts.push(`${field} ne ${this.formatFilterValue(val)}`);
          break;
        case 'greater_than':
          filterParts.push(`${field} gt ${this.formatFilterValue(val)}`);
          break;
        case 'less_than':
          filterParts.push(`${field} lt ${this.formatFilterValue(val)}`);
          break;
        case 'contains':
          filterParts.push(`contains(${field}, ${this.formatFilterValue(val)})`);
          break;
        case 'startswith':
          filterParts.push(`startswith(${field}, ${this.formatFilterValue(val)})`);
          break;
        }
      } else {
        // Simple equality filter
        filterParts.push(`${field} eq ${this.formatFilterValue(value)}`);
      }
    });

    return filterParts.join(` ${operator.toLowerCase()} `);
  }

  private formatFilterValue(value: unknown): string {
    if (typeof value === 'string') {
      return `'${value.replace(/'/g, '\'\'')}'`;
    } else if (value instanceof Date) {
      return value.toISOString();
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      return value.toString();
    } else {
      return `'${String(value).replace(/'/g, '\'\'')}'`;
    }
  }

  private formatDataForDynamics(data: Partial<DataRecord>): Record<string, unknown> {
    const fieldMap = {
      name: 'name',
      email: 'emailaddress1',
      phone: 'telephone1',
      description: 'description',
    };
    return mapCommonFields((data.fields ?? {}) as Record<string, unknown>, fieldMap);
  }

  /**
   * Formats data from Dynamics 365's format to the standard DataRecord format.
   * @param {any} dynamicsData - The data received from Dynamics 365.
   * @param {string} entityType - The entity type.
   * @returns {DataRecord} The formatted standard data record.
   * @private
   */
  private formatDataFromDynamics(dynamicsData: unknown, entityType: string): DataRecord {
    // Convert Dynamics format to our standard format
    const fields: Record<string, unknown> = {};
    const primaryKey = this.getPrimaryKeyField(entityType);

    const isDynamicsObject = (obj: unknown): obj is Record<string, unknown> & {
      externalid?: string;
      modifiedon?: string;
      versionnumber?: number;
    } => typeof obj === 'object' && obj !== null;

    if (!isDynamicsObject(dynamicsData)) {
      return {
        externalId: '',
        metadata: {
          source: 'Dynamics365',
          lastModified: new Date(),
          version: '0',
        },
        fields,
      };
    }

    const fieldMap = {
      name: 'name',
      email: 'emailaddress1',
      phone: 'telephone1',
      description: 'description',
    };
    Object.assign(fields, mapFromCommonFields(dynamicsData, fieldMap));
    delete fields[primaryKey];
    delete fields.createdon;
    delete fields.modifiedon;

    return {
      id: dynamicsData[primaryKey] as string,
      externalId: dynamicsData.externalid ?? '',
      fields,
      metadata: {
        source: 'Dynamics365',
        lastModified: dynamicsData.modifiedon ? new Date(dynamicsData.modifiedon) : new Date(),
        version: dynamicsData.versionnumber?.toString() ?? '0',
      },
    };
  }

  // Demo mode helper methods
  private normalizeEntityType(entityType: string): string {
    const normalized = entityType.toLowerCase().replace(/[_-]/g, '');
    if (normalized.includes('account')) return 'account';
    if (normalized.includes('contact')) return 'contact';
    if (normalized.includes('opportun')) return 'opportunity';
    if (normalized.includes('lead')) return 'lead';
    if (normalized.includes('case')) return 'case';
    return entityType.toLowerCase();
  }

  private async createDemo(entityType: string, data: DataRecord): Promise<DataRecord> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType) || new Map();

    const id = `${entityType.toUpperCase()}-${Date.now()}`;
    const record: DataRecord = {
      id,
      ...data,
      fields: {
        ...(data.fields as any),
        createdon: new Date().toISOString(),
        modifiedon: new Date().toISOString()
      }
    };

    store.set(id, record);
    this.demoStore.set(normalizedType, store);

    this.logger.info(`Demo: Created ${entityType} ${id}`);
    return record;
  }

  private async readDemo(entityType: string, id: string): Promise<DataRecord | null> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const record = store?.get(id) || null;

    if (record) {
      this.logger.info(`Demo: Read ${entityType} ${id}`);
    }

    return record;
  }

  private async updateDemo(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const existing = store?.get(id);

    if (!existing) {
      throw new Error(`${entityType} not found: ${id}`);
    }

    const updated: DataRecord = {
      ...existing,
      ...data,
      fields: {
        ...(existing.fields as any),
        ...(data.fields as any),
        modifiedon: new Date().toISOString()
      }
    };

    store!.set(id, updated);
    this.logger.info(`Demo: Updated ${entityType} ${id}`);
    return updated;
  }

  private async deleteDemo(entityType: string, id: string): Promise<boolean> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const result = store?.delete(id) || false;

    if (result) {
      this.logger.info(`Demo: Deleted ${entityType} ${id}`);
    }

    return result;
  }

  private async listDemo(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);

    if (!store) {
      return [];
    }

    let results = Array.from(store.values());

    // Apply filters
    if (options.filters) {
      results = results.filter(record => {
        const fields = record.fields as Record<string, unknown> | undefined;
        return Object.entries(options.filters!).every(([key, value]) => {
          return fields?.[key] === value;
        });
      });
    }

    // Apply sorting. Nulls/undefined always go to the end regardless of
    // sortOrder — matches the shared convention in DemoConnectorDecorator.applySorting
    // so mixed-sort-key records don't displace populated records from page 1.
    if (options.sortBy) {
      const sortKey = options.sortBy;
      const order = options.sortOrder === 'desc' ? -1 : 1;
      results.sort((a, b) => {
        const aFields = a.fields as Record<string, unknown> | undefined;
        const bFields = b.fields as Record<string, unknown> | undefined;
        const aVal = aFields?.[sortKey];
        const bVal = bFields?.[sortKey];
        if (aVal === bVal) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * order;
        if (aVal instanceof Date && bVal instanceof Date) return (aVal.getTime() - bVal.getTime()) * order;
        return String(aVal).localeCompare(String(bVal)) * order;
      });
    }

    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit || results.length;

    this.logger.info(`Demo: Listed ${entityType} (${results.length} results, returning ${Math.min(limit, results.length - offset)})`);
    return results.slice(offset, offset + limit);
  }

  private async searchDemo(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);

    if (!store) {
      return [];
    }

    let results = Array.from(store.values());

    // Apply filters
    if (criteria.filters) {
      results = results.filter(record => {
        const fields = record.fields as Record<string, unknown> | undefined;
        const matchesAll = Object.entries(criteria.filters!).every(([key, value]) => {
          const fieldValue = fields?.[key];
          if (typeof fieldValue === 'string' && typeof value === 'string') {
            return fieldValue.toLowerCase().includes(value.toLowerCase());
          }
          return fieldValue === value;
        });

        return criteria.operator === 'OR' ? !matchesAll : matchesAll;
      });
    }

    // Apply pagination
    const offset = criteria.offset || 0;
    const limit = criteria.limit || results.length;

    this.logger.info(`Demo: Searched ${entityType} (${results.length} matches, returning ${Math.min(limit, results.length - offset)})`);
    return results.slice(offset, offset + limit);
  }
}
