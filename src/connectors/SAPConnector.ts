import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo, SyncResult } from '../types';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import { mapCommonFields } from '../utils/connectorHelpers';
import { isDemoMode } from '../config/runtimeFlags';

export interface SAPCredentials {
  username: string;
  password: string;
  client: string;
  systemId: string;
  host: string;
  port?: number;
  protocol?: 'http' | 'https';
  apiKey?: string;
}

export interface SAPResponse<T = unknown> {
  d: {
    results: T[];
    __count?: string;
    __next?: string;
  };
}

export interface SAPEntity {
  __metadata: {
    uri: string;
    type: string;
  };
  [key: string]: unknown;
}

// Type guard helper for error objects with HTTP response
interface ErrorWithResponse {
  response?: {
    status?: number;
    headers?: Record<string, string>;
  };
  code?: string;
}

/**
 * SAP connector implementing OData v2/v4 API integration
 * Supports both SAP ECC and SAP S/4HANA systems
 * Uses REST/OData endpoints for data operations
 */
@injectable()
export class SAPConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Real SAP OData v2 scaffolding (Basic + ApiKey + X-CSRF-Token); ships demo fallback when isDemoMode() or demoCredentials — no production credential test on file';

  // private _authService: AuthService;
  private sapClient!: string;
  private sapSystemId!: string;
  private host!: string;
  private port = 8000;
  private protocol: 'http' | 'https' = 'https';
  private readonly odataVersion = 'v2'; // v2 or v4
  private readonly serviceNamespace = 'sap/opu/odata/sap';
  private demoMode = false;
  private readonly demoStore = new Map<string, Map<string, DataRecord>>();

  constructor(
    systemId: string,
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) _authService: AuthService,
  ) {
    super('SAP', systemId, logger);
    // this._authService = authService;
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    if (config.type !== 'basic' && config.type !== 'api_key') {
      throw new Error('SAP connector requires Basic or API Key authentication');
    }

    const credentials = config.credentials as unknown as SAPCredentials;

    this.sapClient = credentials.client;
    this.sapSystemId = credentials.systemId;
    this.host = credentials.host;
    this.port = credentials.port || 8000;
    this.protocol = credentials.protocol || 'https';

    // Construct base URL for SAP OData services
    const baseUrl = `${this.protocol}://${this.host}:${this.port}/${this.serviceNamespace}`;
    this.httpClient.defaults.baseURL = baseUrl;

    // SAP-specific timeout optimization (SAP systems can be slow)
    this.httpClient.defaults.timeout = 45000; // 45 seconds for SAP operations
    
    // Set SAP-specific headers
    this.httpClient.defaults.headers.common['sap-client'] = this.sapClient;
    this.httpClient.defaults.headers.common['Content-Type'] = 'application/json';
    this.httpClient.defaults.headers.common['Accept'] = 'application/json';
    this.httpClient.defaults.headers.common['X-Requested-With'] = 'XMLHttpRequest';

    // Add CSRF token handling for SAP
    this.httpClient.defaults.headers.common['X-CSRF-Token'] = 'Fetch';
    
    // SAP-specific connection optimizations
    this.httpClient.defaults.headers.common['Connection'] = 'keep-alive';
    this.httpClient.defaults.headers.common['Cache-Control'] = 'no-cache';

    const demoCredentials = credentials.username?.toLowerCase().includes('demo') ||
                           credentials.apiKey?.toLowerCase().includes('demo');

    if (isDemoMode() || demoCredentials) {
      this.demoMode = true;
      this.seedDemoData();
      this.logger.info('SAP connector initialized in DEMO mode');
      return;
    }

    this.logger.info('SAP connector initialized', {
      host: this.host,
      client: this.sapClient,
      systemId: this.sapSystemId,
      odataVersion: this.odataVersion,
    });
  }

  private seedDemoData(): void {
    // Seed materials
    const materials = this.demoStore.get('material') || new Map();
    materials.set('MAT-001', {
      id: 'MAT-001',
      fields: {
        MaterialNumber: 'MAT-001',
        Description: 'Demo Material A',
        MaterialType: 'FERT',
        BaseUnitOfMeasure: 'EA',
        MaterialGroup: 'DEMO-GROUP',
        Plant: '1000',
        StorageLocation: '0001'
      }
    });
    materials.set('MAT-002', {
      id: 'MAT-002',
      fields: {
        MaterialNumber: 'MAT-002',
        Description: 'Demo Material B',
        MaterialType: 'ROH',
        BaseUnitOfMeasure: 'KG',
        MaterialGroup: 'DEMO-GROUP',
        Plant: '1000',
        StorageLocation: '0001'
      }
    });
    this.demoStore.set('material', materials);

    // Seed purchase orders
    const purchaseOrders = this.demoStore.get('purchase_order') || new Map();
    purchaseOrders.set('PO-001', {
      id: 'PO-001',
      fields: {
        PurchaseOrder: 'PO-001',
        CompanyCode: '1000',
        PurchaseOrderType: 'NB',
        Vendor: 'VENDOR-001',
        PurchasingOrganization: '1000',
        PurchasingGroup: 'DEMO',
        DocumentDate: '2025-10-15',
        TotalValue: 15000
      }
    });
    this.demoStore.set('purchase_order', purchaseOrders);

    // Seed sales orders
    const salesOrders = this.demoStore.get('sales_order') || new Map();
    salesOrders.set('SO-001', {
      id: 'SO-001',
      fields: {
        SalesOrder: 'SO-001',
        SalesOrganization: '1000',
        DistributionChannel: '10',
        Division: '00',
        SoldToParty: 'CUST-001',
        OrderDate: '2025-10-16',
        NetValue: 25000
      }
    });
    this.demoStore.set('sales_order', salesOrders);

    this.logger.info('SAP demo data seeded', {
      materials: materials.size,
      purchaseOrders: purchaseOrders.size,
      salesOrders: salesOrders.size
    });
  }

  async authenticate(): Promise<boolean> {
    if (this.demoMode) {
      this.isAuthenticated = true;
      this.logger.info('SAP authentication successful (demo mode)');
      return true;
    }

    try {
      const credentials = this.authConfig.credentials as unknown as SAPCredentials;

      if (this.authConfig.type === 'basic') {
        // Basic Authentication
        const authString = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
        this.httpClient.defaults.headers.common['Authorization'] = `Basic ${authString}`;
      } else if (this.authConfig.type === 'api_key') {
        // API Key Authentication (for SAP Cloud services)
        this.httpClient.defaults.headers.common['Authorization'] = `ApiKey ${credentials.apiKey}`;
      }

      // Test authentication by fetching service document
      await this.makeRequest({
        method: 'GET',
        url: '/SERVICE_SRV/$metadata',
        headers: {
          'Accept': 'application/xml',
        },
      });

      this.isAuthenticated = true;
      this.logger.info('SAP authentication successful');
      return true;
    } catch (error: unknown) {
      this.logger.error('SAP authentication failed', error);
      this.isAuthenticated = false;
      this.handleAuthError(error);
      throw error;
    }
  }

  private handleAuthError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 401 || err.response?.status === 403) {
      this.isAuthenticated = false;
      throw new Error(
        'SAP Authentication failed. Please check your credentials.\n' +
        'Troubleshooting:\n' +
        '- Verify SAP username and password\n' +
        '- Check SAP client and system ID\n' +
        '- Ensure user has proper authorizations\n' +
        '- Verify SAP system is accessible'
      );
    }
  }

  private handleRateLimitError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 429) {
      const retryAfter = err.response.headers?.['retry-after'] || '60';
      throw new Error(`SAP rate limit exceeded. Retry after ${retryAfter} seconds`);
    }
  }

  private handleTimeoutError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new Error(
        'SAP request timed out. The SAP system may be slow or unavailable.\n' +
        'Troubleshooting:\n' +
        '- Check SAP system status\n' +
        '- Verify network connectivity\n' +
        '- Consider increasing timeout value'
      );
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return {
        name: 'SAP ERP (Demo)',
        type: 'SAP',
        version: 'S/4HANA 2023',
        capabilities: [
          'master_data',
          'business_partners',
          'materials',
          'purchase_orders',
          'sales_orders',
          'invoices',
          'financial_documents',
          'cost_centers',
          'profit_centers',
          'odata_queries',
          'demo_mode',
        ],
        rateLimits: {
          requestsPerMinute: 300,
          requestsPerHour: 10000,
          requestsPerDay: 100000,
        },
        endpoints: {
          baseUrl: 'https://sap.demo.local',
          authUrl: 'https://sap.demo.local/oauth2',
          webhookUrl: 'https://sap.demo.local/webhooks',
        },
      };
    }

    try {
      // Get system information from SAP
      const response = await this.makeRequest<SAPResponse<{
        SystemId: string;
        Client: string;
        Release: string;
        Version: string;
      }>>({
        method: 'GET',
        url: '/SYSTEM_INFO_SRV/SystemInfoSet',
      });

      const systemInfo = response.d?.results?.[0];

      return {
        name: `SAP ${systemInfo?.SystemId || this.sapSystemId}`,
        type: 'SAP',
        version: systemInfo?.Release || 'Unknown',
        capabilities: [
          'master_data',
          'business_partners',
          'materials',
          'purchase_orders',
          'sales_orders',
          'invoices',
          'financial_documents',
          'cost_centers',
          'profit_centers',
          'odata_queries',
          'bapi_calls',
          'rfc_calls',
          'custom_tables',
        ],
        rateLimits: {
          requestsPerMinute: 300,
          requestsPerHour: 10000,
          requestsPerDay: 100000,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL || '',
          authUrl: `${this.protocol}://${this.host}:${this.port}/sap/bc/rest/oauth2`,
          webhookUrl: `${this.protocol}://${this.host}:${this.port}/sap/bc/rest/webhooks`,
        },
      };
    } catch (error: unknown) {
      this.handleTimeoutError(error);
      this.logger.warn('Could not fetch detailed system info, using defaults', { error: error instanceof Error ? error.message : String(error) });

      return {
        name: `SAP ${this.sapSystemId}`,
        type: 'SAP',
        version: 'Unknown',
        capabilities: [
          'master_data',
          'business_partners',
          'materials',
          'odata_queries',
        ],
        rateLimits: {
          requestsPerMinute: 300,
          requestsPerHour: 10000,
          requestsPerDay: 100000,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL || '',
          authUrl: `${this.protocol}://${this.host}:${this.port}/sap/bc/rest/oauth2`,
          webhookUrl: `${this.protocol}://${this.host}:${this.port}/sap/bc/rest/webhooks`,
        },
      };
    }
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();

    if (this.demoMode) {
      return this.createDemo(entityType, data);
    }

    const serviceName = this.getServiceName(entityType);
    const entitySet = this.getEntitySet(entityType);
    const payload = this.formatDataForSAP(data);

    try {
      const response = await this.makeRequest<SAPEntity>({
        method: 'POST',
        url: `/${serviceName}/${entitySet}`,
        data: payload,
      });

      return this.formatDataFromSAP(response, entityType);
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

    const serviceName = this.getServiceName(entityType);
    const entitySet = this.getEntitySet(entityType);

    try {
      const response = await this.makeRequest<SAPEntity>({
        method: 'GET',
        url: `/${serviceName}/${entitySet}('${id}')`,
      });

      return this.formatDataFromSAP(response, entityType);
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

    const serviceName = this.getServiceName(entityType);
    const entitySet = this.getEntitySet(entityType);
    const payload = this.formatDataForSAP(data);

    try {
      // SAP OData typically uses MERGE or PUT for updates
      const response = await this.makeRequest<SAPEntity>({
        method: 'PATCH',
        url: `/${serviceName}/${entitySet}('${id}')`,
        data: payload,
        headers: {
          'If-Match': '*', // SAP requires ETag handling
        },
      });

      return this.formatDataFromSAP(response, entityType);
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

    const serviceName = this.getServiceName(entityType);
    const entitySet = this.getEntitySet(entityType);

    try {
      await this.makeRequest({
        method: 'DELETE',
        url: `/${serviceName}/${entitySet}('${id}')`,
        headers: {
          'If-Match': '*',
        },
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

    const serviceName = this.getServiceName(entityType);
    const entitySet = this.getEntitySet(entityType);

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

    const url = `/${serviceName}/${entitySet}?${params.toString()}`;

    try {
      const response = await this.makeRequest<SAPResponse<SAPEntity>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.d?.results)) {
        return response.d.results.map((item: SAPEntity) => this.formatDataFromSAP(item, entityType));
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

    const serviceName = this.getServiceName(entityType);
    const entitySet = this.getEntitySet(entityType);
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

    const url = `/${serviceName}/${entitySet}?${params.toString()}`;

    try {
      const response = await this.makeRequest<SAPResponse<SAPEntity>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.d?.results)) {
        return response.d.results.map((item: SAPEntity) => this.formatDataFromSAP(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search ${entityType}: ${message}`, { cause: error });
    }
  }

  async setupWebhook(webhookUrl: string, events: string[]): Promise<string> {
    await this.ensureAuthenticated();

    // SAP webhook setup is typically done through configuration
    // This would be system-specific implementation
    const payload = {
      Name: `IntegrationHub_${Date.now()}`,
      EndpointUrl: webhookUrl,
      IsActive: true,
      Events: events.join(','),
      Client: this.sapClient,
    };

    try {
      // This is a conceptual implementation - actual SAP webhook setup
      // would depend on the specific SAP system and configuration
      const response = await this.makeRequest<{ Id: string }>({
        method: 'POST',
        url: '/WEBHOOK_SRV/WebhookSet',
        data: payload,
      });

      return response.Id || `webhook_${Date.now()}`;
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
        url: `/WEBHOOK_SRV/WebhookSet('${webhookId}')`,
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to remove webhook: ${message}`, { cause: error });
    }
  }

  async getChanges(entityType: string, since: Date): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const serviceName = this.getServiceName(entityType);
    const entitySet = this.getEntitySet(entityType);
    const sinceDate = since.toISOString();

    // Use $filter with timestamp comparison
    const filterString = `ChangedOn ge datetime'${sinceDate}'`;

    const url = `/${serviceName}/${entitySet}?$filter=${encodeURIComponent(filterString)}` +
      '&$orderby=ChangedOn desc&$top=1000';

    try {
      const response = await this.makeRequest<SAPResponse<SAPEntity>>({
        method: 'GET',
        url,
      });

      if (Array.isArray(response.d?.results)) {
        return response.d.results.map((item: SAPEntity) => this.formatDataFromSAP(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get changes for ${entityType}: ${message}`, { cause: error });
    }
  }

  private getServiceName(entityType: string): string {
    // Map entity types to SAP service names
    const serviceMapping: Record<string, string> = {
      'business_partner': 'API_BUSINESS_PARTNER',
      'customer': 'API_BUSINESS_PARTNER',
      'vendor': 'API_BUSINESS_PARTNER',
      'material': 'API_PRODUCT_SRV',
      'product': 'API_PRODUCT_SRV',
      'sales_order': 'API_SALES_ORDER_SRV',
      'purchase_order': 'API_PURCHASEORDER_PROCESS_SRV',
      'invoice': 'API_FINANCIALDOCUMENT_SRV',
      'cost_center': 'API_COSTCENTER_SRV',
      'profit_center': 'API_PROFITCENTER_SRV',
    };

    return serviceMapping[entityType.toLowerCase()] || 'CUSTOM_SRV';
  }

  private getEntitySet(entityType: string): string {
    // Map entity types to SAP entity sets
    const entitySetMapping: Record<string, string> = {
      'business_partner': 'A_BusinessPartner',
      'customer': 'A_Customer',
      'vendor': 'A_Supplier',
      'material': 'A_Product',
      'product': 'A_Product',
      'sales_order': 'A_SalesOrder',
      'purchase_order': 'A_PurchaseOrder',
      'invoice': 'A_FinancialDocument',
      'cost_center': 'A_CostCenter',
      'profit_center': 'A_ProfitCenter',
    };

    return entitySetMapping[entityType.toLowerCase()] || `${entityType}Set`;
  }

  private getKeyField(entityType: string): string {
    // Map entity types to their key fields
    const keyFieldMapping: Record<string, string> = {
      'business_partner': 'BusinessPartner',
      'customer': 'Customer',
      'vendor': 'Supplier',
      'material': 'Product',
      'product': 'Product',
      'sales_order': 'SalesOrder',
      'purchase_order': 'PurchaseOrder',
      'invoice': 'FinancialDocument',
      'cost_center': 'CostCenter',
      'profit_center': 'ProfitCenter',
    };

    return keyFieldMapping[entityType.toLowerCase()] || 'Id';
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
          conditions.push(`substringof(${this.formatODataValue(val)}, ${field})`);
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
      return `datetime'${value.toISOString()}'`;
    } else if (typeof value === 'boolean') {
      return value.toString();
    } else if (typeof value === 'number') {
      return value.toString();
    } else {
      return `'${String(value).replace(/'/g, '\'\'')}'`;
    }
  }

  private formatDataForSAP(data: Partial<DataRecord>): Record<string, unknown> {
    const fieldMap = {
      name: 'BusinessPartnerFullName',
      email: 'EmailAddress',
      phone: 'PhoneNumber',
      description: 'BusinessPartnerName',
      companyName: 'OrganizationBPName1',
    };

    return mapCommonFields((data.fields as Record<string, unknown>) ?? {}, fieldMap);
  }

  private formatDataFromSAP(sapData: SAPEntity, entityType: string): DataRecord {
    const fields: Record<string, unknown> = {};
    const _keyField = this.getKeyField(entityType);

    const fieldMap = {
      BusinessPartnerFullName: 'name',
      EmailAddress: 'email',
      PhoneNumber: 'phone',
      BusinessPartnerName: 'description',
      OrganizationBPName1: 'companyName',
    };

    Object.assign(fields, mapCommonFields(sapData, fieldMap));

    // Remove SAP system fields from fields object
    delete fields[_keyField];
    delete fields.__metadata;
    delete fields.CreatedOn;
    delete fields.ChangedOn;

    return {
      id: sapData[_keyField] as string,
      externalId: sapData[_keyField] as string,
      fields,
      metadata: {
        source: 'SAP',
        lastModified: sapData.ChangedOn ? new Date(sapData.ChangedOn as string) : new Date(),
        version: sapData.__metadata?.uri?.split('?')[1] ?? '1.0',
      },
    };
  }

  /**
   * Optimized material sync operation with chunking and improved error handling
   */
  async syncMaterials(options: { batchSize?: number; maxRetries?: number } = {}): Promise<SyncResult> {
    const { batchSize = 100, maxRetries = 3 } = options;
    const syncId = `sap_material_sync_${Date.now()}`;
    const results: SyncResult = {
      integrationId: 'sap-material-sync',
      syncId,
      status: 'success',
      success: true,
      recordsProcessed: 0,
      recordsSuccessful: 0,
      recordsFailed: 0,
      errors: [],
      startTime: new Date(),
      endTime: new Date(),
      batchSize,
    };

    try {
      await this.ensureAuthenticated();
      this.logger.info('Starting optimized SAP material sync', { batchSize, maxRetries });

      // Use optimized query with pagination for materials
      const serviceName = this.getServiceName('material');
      const entitySet = this.getEntitySet('material');
      
      let skip = 0;
      let hasMore = true;
      let attempt = 0;

      while (hasMore && attempt < maxRetries) {
        try {
          // Build optimized query with required fields only
          const url = `/${serviceName}/${entitySet}?` +
            `$select=Product,ProductType,BaseUnit,WeightUnit,ProductGroup&` +
            `$top=${batchSize}&$skip=${skip}&` +
            `$orderby=Product&$format=json`;

          this.logger.debug('Fetching material batch', { skip, batchSize, attempt: attempt + 1 });

          const response = await this.makeRequest<SAPResponse<SAPEntity>>({
            method: 'GET',
            url,
            timeout: 20000, // Shorter timeout for individual requests
            headers: {
              'Cache-Control': 'no-cache',
              'Prefer': 'return=minimal', // SAP optimization
            },
          });

          const materials = response.d?.results || [];
          
          if (materials.length === 0) {
            hasMore = false;
            break;
          }

          // Process materials in smaller chunks to avoid memory issues
          for (const material of materials) {
            try {

              results.recordsProcessed++;
              results.recordsSuccessful++;
              
              // Simulate processing (in real implementation, this would sync to target system)
              await new Promise(resolve => setTimeout(resolve, 10)); // Small delay to prevent overwhelming
              
            } catch (processingError: unknown) {
              const errorMessage = processingError instanceof Error ? processingError.message : String(processingError);
              results.errors.push(errorMessage);
              results.recordsFailed++;
              this.logger.warn('Failed to process material', { material: material.Product, error: errorMessage });
            }
          }

          skip += batchSize;
          
          // Check if we got less than requested batch size (indicates end of data)
          if (materials.length < batchSize) {
            hasMore = false;
          }

          attempt = 0; // Reset attempt counter on successful batch
          
          this.logger.info('Processed material batch', { 
            processed: results.recordsProcessed,
            successful: results.recordsSuccessful,
            failed: results.recordsFailed,
            errors: results.errors.length
          });

        } catch (batchError: unknown) {
          attempt++;
          const errorMessage = batchError instanceof Error ? batchError.message : String(batchError);
          
          this.logger.warn(`Material sync batch failed (attempt ${attempt}/${maxRetries})`, { 
            skip, 
            batchSize, 
            error: errorMessage 
          });

          if (attempt >= maxRetries) {
            throw new Error(`Failed to sync materials after ${maxRetries} attempts: ${errorMessage}`, { cause: batchError });
          }

          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }

      results.endTime = new Date();
      const executionTimeMs = results.endTime.getTime() - results.startTime.getTime();
      results.processingMs = executionTimeMs;
      results.processingTime = `${(executionTimeMs / 1000).toFixed(1)}s`;
      results.success = results.recordsFailed < results.recordsProcessed * 0.1; // Consider successful if <10% errors
      results.status = results.success ? 'success' : (results.recordsSuccessful > 0 ? 'partial' : 'failed');

      this.logger.info('SAP material sync completed', {
        recordsProcessed: results.recordsProcessed,
        recordsSuccessful: results.recordsSuccessful,
        recordsFailed: results.recordsFailed,
        errors: results.errors.length,
        processingMs: results.processingMs,
        success: results.success,
        status: results.status
      });

      return results;

    } catch (error: unknown) {
      results.endTime = new Date();
      const executionTimeMs = results.endTime.getTime() - results.startTime.getTime();
      results.processingMs = executionTimeMs;
      results.processingTime = `${(executionTimeMs / 1000).toFixed(1)}s`;
      results.success = false;
      results.status = 'failed';
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.errors.push(errorMessage);

      this.logger.error('SAP material sync failed', { error: errorMessage, processingMs: results.processingMs });
      throw error;
    }
  }

  // Demo mode helper methods
  private normalizeEntityType(entityType: string): string {
    const normalized = entityType.toLowerCase().replace(/[_-]/g, '');
    if (normalized.includes('material') || normalized.includes('product')) return 'material';
    if (normalized.includes('purchase') && normalized.includes('order')) return 'purchase_order';
    if (normalized.includes('sales') && normalized.includes('order')) return 'sales_order';
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
        CreatedAt: new Date().toISOString(),
        UpdatedAt: new Date().toISOString()
      }
    };

    store.set(id, record);
    this.demoStore.set(normalizedType, store);
    this.logger.info(`Created demo ${entityType}`, { id });
    return record;
  }

  private async readDemo(entityType: string, id: string): Promise<DataRecord | null> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    return store?.get(id) || null;
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
        UpdatedAt: new Date().toISOString()
      }
    };

    store!.set(id, updated);
    this.logger.info(`Updated demo ${entityType}`, { id });
    return updated;
  }

  private async deleteDemo(entityType: string, id: string): Promise<boolean> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const deleted = store?.delete(id) || false;

    if (deleted) {
      this.logger.info(`Deleted demo ${entityType}`, { id });
    }

    return deleted;
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
        return Object.entries(criteria.filters!).every(([key, value]) => {
          const fieldValue = fields?.[key];
          if (typeof value === 'string' && typeof fieldValue === 'string') {
            return fieldValue.toLowerCase().includes(value.toLowerCase());
          }
          return fieldValue === value;
        });
      });
    }

    // Apply pagination
    const offset = criteria.offset || 0;
    const limit = criteria.limit || results.length;

    return results.slice(offset, offset + limit);
  }
}
