import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo, OAuth2Credentials } from '../types';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import { mapCommonFields } from '../utils/connectorHelpers';
import { MetadataClient } from './businessCentral/MetadataClient';
import type { BCFieldCatalog } from './businessCentral/types';
import { isDemoMode, isTestEnvironment } from '../config/runtimeFlags';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';

export interface BusinessCentralRecord {
  '@odata.etag': string;
  id: string;
  [key: string]: unknown;
}

export interface BusinessCentralResponse<T = unknown> {
  '@odata.context': string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: T[];
}

export interface BusinessCentralCreateResponse {
  '@odata.context': string;
  '@odata.etag': string;
  id: string;
  [key: string]: unknown;
}

/**
 * Microsoft Dynamics 365 Business Central connector
 * Implements Business Central API v2.0 integration with OAuth2 authentication
 * Supports companies, customers, vendors, items, and financial data
 */
@injectable()
export class BusinessCentralConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'OData v4 with metadata discovery via src/connectors/businessCentral/MetadataClient.ts; OAuth2 client-credentials';
  static readonly proofCard = 'docs/review/proof-cards/business-central-connector.md';

  private tenantId!: string;
  private environment = 'production';
  private companyId?: string;
  private readonly apiVersion = 'v2.0';
  private readonly authService: AuthService;
  private readonly outboundGovernance: OutboundGovernanceService;
  private metadataClient?: MetadataClient;

  constructor(
    systemId: string,
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) authService: AuthService,
    outboundGovernance: OutboundGovernanceService,
  ) {
    super('BusinessCentral', systemId, logger);
    this.authService = authService;
    if (!outboundGovernance) {
      throw new Error('OutboundGovernanceService is required for production connector outbound protection');
    }
    this.outboundGovernance = outboundGovernance;
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    if (config.type !== 'oauth2') {
      throw new Error('Business Central connector requires OAuth2 authentication');
    }

    const credentials = config.credentials as OAuth2Credentials & {
      tenantId: string;
      environment?: string;
      companyId?: string;
    };

    this.tenantId = credentials.tenantId;
    this.environment = credentials.environment || 'production';
    this.companyId = credentials.companyId;

    // Construct base URL for Business Central API
    const baseUrl = `https://api.businesscentral.dynamics.com/${this.apiVersion}/${this.tenantId}/${this.environment}`;
    this.httpClient.defaults.baseURL = baseUrl;

    // Initialize metadata client
    const demoMode = isDemoMode() || isTestEnvironment();
    this.metadataClient = new MetadataClient(
      {
        demoMode,
        baseURL: baseUrl,
        companyId: this.companyId,
        cacheEnabled: true,
        cacheTTLMs: 24 * 60 * 60 * 1000 // 24 hours
      },
      this.logger
    );

    this.logger.info('Business Central connector initialized', {
      tenantId: this.tenantId,
      environment: this.environment,
      companyId: this.companyId,
      apiVersion: this.apiVersion,
      demoMode
    });
  }

  async authenticate(): Promise<boolean> {
    try {
      const credentials = this.authConfig.credentials as OAuth2Credentials & {
        tenantId: string;
      };

      // Business Central OAuth2 Client Credentials flow
      const authCredentials = {
        type: 'oauth2' as const,
        credentials: {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          token_url: `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`,
          grant_type: 'client_credentials',
          scope: 'https://api.businesscentral.dynamics.com/.default',
        },
      };

      const tokenInfo = await this.authService.authenticateOAuth2(authCredentials);

      if (!tokenInfo?.accessToken) {
        throw new Error('Failed to obtain Business Central access token');
      }

      if (this.authConfig) {
        this.authConfig.expiresAt = tokenInfo.expiresAt;
      }

      this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${tokenInfo.accessToken}`;
      this.httpClient.defaults.headers.common['Content-Type'] = 'application/json';
      this.httpClient.defaults.headers.common['Accept'] = 'application/json';
      this.httpClient.defaults.headers.common['OData-MaxVersion'] = '4.0';
      this.httpClient.defaults.headers.common['OData-Version'] = '4.0';

      // Get company ID if not provided
      if (!this.companyId) {
        await this.fetchCompanyId();
      }

      this.isAuthenticated = true;
      this.logger.info('Business Central authentication successful', {
        companyId: this.companyId,
      });
      return true;
    } catch (error: unknown) {
      this.logger.error('Business Central authentication failed', error);
      this.isAuthenticated = false;
      throw error;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    try {
      // Get company information
      const response = await this.makeRequest<BusinessCentralResponse<{
        id: string;
        displayName: string;
        systemVersion: string;
      }>>({
        method: 'GET',
        url: '/companies',
      });

      const company = response.value?.[0];

      return {
        name: company?.displayName || 'Business Central',
        type: 'BusinessCentral',
        version: company?.systemVersion || this.apiVersion,
        capabilities: [
          'companies',
          'customers',
          'vendors',
          'items',
          'sales_orders',
          'purchase_orders',
          'invoices',
          'payments',
          'general_ledger',
          'chart_of_accounts',
          'dimensions',
          'currencies',
          'tax_groups',
          'payment_terms',
          'shipping_methods',
          'units_of_measure',
          'custom_fields',
        ],
        rateLimits: {
          requestsPerMinute: 600,
          requestsPerHour: 20000,
          requestsPerDay: 200000,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL || '',
          authUrl: `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize`,
          webhookUrl: `${this.httpClient.defaults.baseURL || ''}/subscriptions`,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get Business Central system info: ${message}`, { cause: error });
    }
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();

    const entityName = this.getEntityName(entityType);
    const rawPayload = this.formatDataForBusinessCentral(data);
    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'create', entityType, rawPayload);

    try {
      const response = await this.makeRequest<BusinessCentralCreateResponse>({
        method: 'POST',
        url: `/companies(${this.companyId})/${entityName}`,
        data: payload,
      });

      return this.formatDataFromBusinessCentral(response, entityType);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create ${entityType}: ${message}`, { cause: error });
    }
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    await this.ensureAuthenticated();

    const entityName = this.getEntityName(entityType);

    try {
      const response = await this.makeRequest<BusinessCentralRecord>({
        method: 'GET',
        url: `/companies(${this.companyId})/${entityName}(${id})`,
      });

      return this.formatDataFromBusinessCentral(response, entityType);
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

    const entityName = this.getEntityName(entityType);
    const rawPayload = this.formatDataForBusinessCentral(data);
    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'update', entityType, rawPayload, { resourceId: id });

    try {
      // First get the current record to retrieve ETag
      const currentRecord = await this.makeRequest<BusinessCentralRecord>({
        method: 'GET',
        url: `/companies(${this.companyId})/${entityName}(${id})`,
      });

      const response = await this.makeRequest<BusinessCentralRecord>({
        method: 'PATCH',
        url: `/companies(${this.companyId})/${entityName}(${id})`,
        data: payload,
        headers: {
          'If-Match': currentRecord['@odata.etag'],
        },
      });

      return this.formatDataFromBusinessCentral(response, entityType);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    await this.ensureAuthenticated();

    const entityName = this.getEntityName(entityType);
    await this.validateOutboundWrite(this.outboundGovernance, 'delete', entityType, { id }, { resourceId: id });

    try {
      // First get the current record to retrieve ETag
      const currentRecord = await this.makeRequest<BusinessCentralRecord>({
        method: 'GET',
        url: `/companies(${this.companyId})/${entityName}(${id})`,
      });

      await this.makeRequest({
        method: 'DELETE',
        url: `/companies(${this.companyId})/${entityName}(${id})`,
        headers: {
          'If-Match': currentRecord['@odata.etag'],
        },
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async list(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const entityName = this.getEntityName(entityType);

    const params = new URLSearchParams();

    // Add $select for specific fields
    if (options.fields) {
      params.append('$select', options.fields.join(','));
    }

    // Add $filter for filtering
    if (options.filters) {
      const filterString = this.buildODataFilter(options.filters);
      if (filterString) {
        params.append('$filter', filterString);
      }
    }

    // Add $orderby for sorting
    if (options.sortBy) {
      const sortOrder = options.sortOrder === 'desc' ? 'desc' : 'asc';
      params.append('$orderby', `${options.sortBy} ${sortOrder}`);
    }

    // Add $top for limit
    if (options.limit) {
      params.append('$top', options.limit.toString());
    }

    // Add $skip for offset
    if (options.offset) {
      params.append('$skip', options.offset.toString());
    }

    const url = `/companies(${this.companyId})/${entityName}?${params.toString()}`;

    try {
      const response = await this.makeRequest<BusinessCentralResponse<BusinessCentralRecord>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.value)) {
        return response.value.map((item: BusinessCentralRecord) =>
          this.formatDataFromBusinessCentral(item, entityType),
        );
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list ${entityType}: ${message}`, { cause: error });
    }
  }

  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const entityName = this.getEntityName(entityType);
    const filterString = this.buildODataFilter(criteria.filters, criteria.operator);

    const params = new URLSearchParams();
    if (filterString) {
      params.append('$filter', filterString);
    }
    if (criteria.limit) {
      params.append('$top', criteria.limit.toString());
    }
    if (criteria.offset) {
      params.append('$skip', criteria.offset.toString());
    }

    const url = `/companies(${this.companyId})/${entityName}?${params.toString()}`;

    try {
      const response = await this.makeRequest<BusinessCentralResponse<BusinessCentralRecord>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.value)) {
        return response.value.map((item: BusinessCentralRecord) =>
          this.formatDataFromBusinessCentral(item, entityType),
        );
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search ${entityType}: ${message}`, { cause: error });
    }
  }

  async setupWebhook(webhookUrl: string, events: string[]): Promise<string> {
    await this.ensureAuthenticated();

    // Business Central webhook setup using subscriptions
    const payload = {
      subscriptionId: `IntegrationHub_${Date.now()}`,
      notificationUrl: webhookUrl,
      resource: events.join(','),
      clientState: 'integration-hub',
      expirationDateTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    };

    try {
      const response = await this.makeRequest<{ subscriptionId: string }>({
        method: 'POST',
        url: '/subscriptions',
        data: payload,
      });

      return response.subscriptionId || `webhook_${Date.now()}`;
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
        url: `/subscriptions(${webhookId})`,
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to remove webhook: ${message}`, { cause: error });
    }
  }

  async getChanges(entityType: string, since: Date): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const entityName = this.getEntityName(entityType);
    const sinceDate = since.toISOString();

    const filterString = `lastModifiedDateTime ge ${sinceDate}`;

    const params = new URLSearchParams();
    params.append('$filter', filterString);
    params.append('$orderby', 'lastModifiedDateTime desc');
    params.append('$top', '1000');

    const url = `/companies(${this.companyId})/${entityName}?${params.toString()}`;

    try {
      const response = await this.makeRequest<BusinessCentralResponse<BusinessCentralRecord>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.value)) {
        return response.value.map((item: BusinessCentralRecord) =>
          this.formatDataFromBusinessCentral(item, entityType),
        );
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get changes for ${entityType}: ${message}`, { cause: error });
    }
  }

  private async fetchCompanyId(): Promise<void> {
    try {
      const response = await this.makeRequest<BusinessCentralResponse<{ id: string }>>({
        method: 'GET',
        url: '/companies',
      });

      if (response.value && response.value.length > 0 && response.value[0] && response.value[0].id) {
        const first = response.value[0] as { id: string };
        this.companyId = first.id;
        this.logger.info('Retrieved Business Central company ID', {
          companyId: this.companyId,
        });
      } else {
        throw new Error('Could not retrieve Business Central company ID: empty or invalid response');
      }
    } catch (error: unknown) {
      this.logger.error('Failed to fetch company ID', error);
      throw new Error('Could not retrieve Business Central company ID', { cause: error });
    }
  }

  private getEntityName(entityType: string): string {
    // Map entity types to Business Central entity names
    const entityMapping: Record<string, string> = {
      'customer': 'customers',
      'vendor': 'vendors',
      'item': 'items',
      'employee': 'employees',
      'sales_order': 'salesOrders',
      'purchase_order': 'purchaseOrders',
      'invoice': 'salesInvoices',
      'payment': 'customerPayments',
      'account': 'accounts',
      'dimension': 'dimensions',
      'currency': 'currencies',
      'tax_group': 'taxGroups',
      'payment_term': 'paymentTerms',
      'shipping_method': 'shipmentMethods',
      'unit_of_measure': 'unitsOfMeasure',
    };

    return entityMapping[entityType.toLowerCase()] || entityType;
  }

  private buildODataFilter(filters: Record<string, unknown>, operator: 'AND' | 'OR' = 'AND'): string {
    const conditions: string[] = [];

    Object.entries(filters).forEach(([field, value]) => {
      if (typeof value === 'object' && value !== null && 'operator' in value) {
        // Advanced filter with operator
        const filterValue = value as { operator: string; value: unknown };
        const op = filterValue.operator;
        const val = filterValue.value;

        switch (op) {
        case 'equals':
          conditions.push(`${field} eq ${this.formatODataValue(val)}`);
          break;
        case 'not_equals':
          conditions.push(`${field} ne ${this.formatODataValue(val)}`);
          break;
        case 'greater_than':
          conditions.push(`${field} gt ${this.formatODataValue(val)}`);
          break;
        case 'less_than':
          conditions.push(`${field} lt ${this.formatODataValue(val)}`);
          break;
        case 'contains':
          conditions.push(`contains(${field}, ${this.formatODataValue(val)})`);
          break;
        case 'startswith':
          conditions.push(`startswith(${field}, ${this.formatODataValue(val)})`);
          break;
        }
      } else {
        // Simple equality filter
        conditions.push(`${field} eq ${this.formatODataValue(value)}`);
      }
    });

    return conditions.join(` ${operator.toLowerCase()} `);
  }

  private formatODataValue(value: unknown): string {
    if (typeof value === 'string') {
      return `'${value.replace(/'/g, '\'\'')}'`;
    } else if (value instanceof Date) {
      return value.toISOString();
    } else if (typeof value === 'boolean') {
      return value.toString();
    } else if (typeof value === 'number') {
      return value.toString();
    } else if (value === null || value === undefined) {
      return 'null';
    } else {
      return `'${String(value).replace(/'/g, '\'\'')}'`;
    }
  }

  private formatDataForBusinessCentral(data: Partial<DataRecord>): Record<string, unknown> {
    const fieldMap = {
      name: 'displayName',
      email: 'email',
      phone: 'phoneNumber',
      address: 'address',
      city: 'city',
      postalCode: 'postalCode',
      country: 'countryRegionCode',
      website: 'website',
      taxId: 'taxRegistrationNumber',
    };

    const formatted = mapCommonFields((data.fields ?? {}) as Record<string, unknown>, fieldMap);

    // Remove null and undefined values
    Object.keys(formatted).forEach(key => {
      if (formatted[key] === null || formatted[key] === undefined) {
        delete formatted[key];
      }
    });

    return formatted;
  }

  private formatDataFromBusinessCentral(bcData: BusinessCentralRecord, _entityType: string): DataRecord {
    const fields: Record<string, unknown> = {};

    const fieldMap = {
      displayName: 'name',
      email: 'email',
      phoneNumber: 'phone',
      address: 'address',
      city: 'city',
      postalCode: 'postalCode',
      countryRegionCode: 'country',
      website: 'website',
      taxRegistrationNumber: 'taxId',
    };

    Object.assign(fields, mapCommonFields(bcData, fieldMap));

    // Remove Business Central system fields from fields object
    delete fields.id;
    delete fields['@odata.etag'];
    delete fields.lastModifiedDateTime;
    delete fields.systemCreatedAt;
    delete fields.systemModifiedAt;

    return {
      id: bcData.id,
      externalId: bcData.id,
      fields,
      metadata: {
        source: 'BusinessCentral',
        lastModified: bcData.lastModifiedDateTime ? new Date(bcData.lastModifiedDateTime as string) : new Date(),
        version: bcData['@odata.etag']?.toString() ?? '1.0',
      },
    };
  }

  /**
   * Get field catalog for an entity type (for AI prompts and UI)
   */
  async getFieldCatalog(entityType: string): Promise<BCFieldCatalog | null> {
    if (!this.metadataClient) {
      this.logger.warn('Metadata client not initialized');
      return null;
    }

    try {
      const schema = await this.metadataClient.fetchMetadata(entityType);
      return this.metadataClient.getFieldCatalog(schema);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to get field catalog', {
        entityType,
        error: err.message
      });
      return null;
    }
  }

  /**
   * Get supported entity types (demo mode only)
   */
  getSupportedEntityTypes(): string[] {
    if (!this.metadataClient) {
      return [];
    }

    try {
      return this.metadataClient.getSupportedEntityTypes();
    } catch (error) {
      this.logger.warn('getSupportedEntityTypes only available in demo mode');
      return [];
    }
  }
}
