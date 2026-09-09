import { injectable, inject, unmanaged } from 'inversify';
import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo } from '../types';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { CircuitBreakerOptions } from '../utils/CircuitBreaker';
import type { SquireVendor, SquireInstaller, SquireProject } from '../data/squireMockData';
import { TYPES } from '../inversify/types';
import crypto from 'crypto';

/**
 * Production SuiteCentral Connector for real NetSuite-native module integration
 * Supports multiple SuiteCentral modules: SupplierCentral, InstallerCentral, PayoutCentral, etc.
 * 
 * This connector interfaces with actual SuiteCentral APIs while providing intelligent
 * fallback to mock behavior for demo/testing environments.
 */
@injectable()
export class SuiteCentralProductionConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Real SuiteCentral API scaffolding (Bearer token + X-SuiteCentral-Tenant) for 6 modules; falls back to squireMockData when isProductionMode is false — no production credential test on file';

  private apiKey = '';
  private baseUrl = '';
  private tenantId = '';
  private moduleEndpoints: Record<string, string> = {};
  private isProductionMode = false;
  
  // Module-specific configuration
  private readonly supportedModules = [
    'SupplierCentral',
    'InstallerCentral', 
    'PayoutCentral',
    'CustomerCentral',
    'ServiceCentral',
    'InventoryCentral'
  ];

  // Mock data store for demo mode
  private readonly mockDataStore = new Map<string, Map<string, DataRecord>>();
  private readonly mockChangeLog = new Map<string, {
    id: string; 
    record: DataRecord | null; 
    operation: 'create' | 'update' | 'delete'; 
    timestamp: Date 
  }[]>();

  constructor(
    @unmanaged() systemType = 'SuiteCentral',
    @unmanaged() systemId = 'suitecentral-prod',
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) _authService: AuthService,
    @unmanaged() circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    super(systemType, systemId, logger, circuitBreakerOptions);
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;
    
    if (config.type !== 'api_key') {
      throw new Error('SuiteCentral connector requires API key authentication');
    }
    
    const credentials = config.credentials as { 
      apiKey: string; 
      baseUrl?: string; 
      tenantId?: string;
      moduleEndpoints?: Record<string, string>;
      productionMode?: boolean;
    };
    
    this.apiKey = credentials.apiKey;
    this.baseUrl = credentials.baseUrl || this.detectSuiteCentralEnvironment();
    this.tenantId = credentials.tenantId || 'default';
    this.moduleEndpoints = credentials.moduleEndpoints || this.getDefaultModuleEndpoints();
    this.isProductionMode = credentials.productionMode ?? this.detectProductionMode();
    
    // Configure HTTP client for SuiteCentral
    this.httpClient.defaults.baseURL = this.baseUrl;
    this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${this.apiKey}`;
    this.httpClient.defaults.headers.common['X-SuiteCentral-Tenant'] = this.tenantId;
    this.httpClient.defaults.headers.common['Content-Type'] = 'application/json';
    this.httpClient.defaults.headers.common['Accept'] = 'application/json';
    this.httpClient.defaults.headers.common['User-Agent'] = 'IntegrationHub/1.0';
    
    // Set SuiteCentral-specific timeouts and retry policy
    this.httpClient.defaults.timeout = 30000; // 30 seconds for NetSuite operations
    
    this.logger.info('SuiteCentral Production connector initialized', { 
      baseUrl: this.baseUrl,
      tenantId: this.tenantId,
      productionMode: this.isProductionMode,
      supportedModules: this.supportedModules 
    });
    
    // Validate connectivity and seed demo data if needed
    if (this.isProductionMode) {
      await this.validateSuiteCentralConnection();
    } else {
      await this.seedDemoData();
    }
  }

  /**
   * Detect SuiteCentral environment based on configuration
   */
  private detectSuiteCentralEnvironment(): string {
    // Check environment variables for SuiteCentral configuration
    const envUrl = process.env.SUITECENTRAL_BASE_URL;
    if (envUrl) return envUrl;
    
    // Check for NetSuite environment indicators
    const netsuiteAccount = process.env.NETSUITE_ACCOUNT_ID;
    if (netsuiteAccount) {
      // SuiteCentral typically runs on NetSuite subdomain
      return `https://${netsuiteAccount}.suitecentral.netsuite.com/api/v1`;
    }
    
    // Default to demo/sandbox environment
    return 'https://demo.suitecentral.integration-hub.local/api/v1';
  }

  /**
   * Detect if we should use production mode or demo/mock mode
   */
  private detectProductionMode(): boolean {
    // Check explicit environment variable
    const prodMode = process.env.SUITECENTRAL_PRODUCTION_MODE;
    if (prodMode !== undefined) {
      return prodMode.toLowerCase() === 'true';
    }
    
    // Check if we have real SuiteCentral credentials
    const hasRealCredentials = process.env.SUITECENTRAL_API_KEY && 
                              process.env.SUITECENTRAL_BASE_URL &&
                              !process.env.SUITECENTRAL_BASE_URL.includes('mock') &&
                              !process.env.SUITECENTRAL_BASE_URL.includes('demo');
    
    return hasRealCredentials || false;
  }

  /**
   * Get default API endpoints for each SuiteCentral module
   */
  private getDefaultModuleEndpoints(): Record<string, string> {
    return {
      SupplierCentral: '/suppliers',
      InstallerCentral: '/installers', 
      PayoutCentral: '/payouts',
      CustomerCentral: '/customers',
      ServiceCentral: '/services',
      InventoryCentral: '/inventory'
    };
  }

  /**
   * Validate connection to real SuiteCentral and check module availability
   */
  private async validateSuiteCentralConnection(): Promise<void> {
    try {
      this.logger.info('Validating SuiteCentral production connection...');
      
      // Check SuiteCentral API health
      const healthResponse = await this.makeRequest<{ status: 'healthy' | 'degraded' | 'unhealthy'; message?: string }>({
        method: 'GET',
        url: '/health',
        timeout: 10000
      });
      
      if (healthResponse.status !== 'healthy') {
        throw new Error(`SuiteCentral health check failed: ${healthResponse.message}`);
      }
      
      // Validate module access permissions
      const moduleStatus = await this.validateModuleAccess();
      this.logger.info('SuiteCentral module validation completed', { moduleStatus });
      
    } catch (error) {
      this.logger.warn('SuiteCentral production connection failed, falling back to demo mode', { error });
      this.isProductionMode = false;
      await this.seedDemoData();
    }
  }

  /**
   * Validate access to each SuiteCentral module
   */
  private async validateModuleAccess(): Promise<Record<string, boolean>> {
    const moduleStatus: Record<string, boolean> = {};
    
    for (const module of this.supportedModules) {
      try {
        const endpoint = this.moduleEndpoints[module];
        if (!endpoint) {
          moduleStatus[module] = false;
          continue;
        }
        
        // Test module endpoint with minimal request
        await this.makeRequest({
          method: 'GET',
          url: `${endpoint}/ping`,
          timeout: 5000
        });
        
        moduleStatus[module] = true;
        this.logger.debug(`${module} access validated`);
        
      } catch (error) {
        moduleStatus[module] = false;
        this.logger.warn(`${module} access validation failed`, { error });
      }
    }
    
    return moduleStatus;
  }

  /**
   * Seed demo data for development/testing
   */
  private async seedDemoData(): Promise<void> {
    this.logger.info('Seeding SuiteCentral demo data...');
    
    // Import sample data from our existing mock data
    const { squireVendors, squireInstallers, squireProjects } = await import('../data/squireMockData');
    
    // Seed suppliers (from vendors)
    const supplierStore = this.getEntityStore('suppliers');
    squireVendors.forEach((vendor: SquireVendor) => {
      const supplier = this.convertVendorToSupplier(vendor);
      const supplierId = String(supplier.id || crypto.randomUUID());
      supplier.id = supplierId;
      supplierStore.set(supplierId, supplier);
    });

    // Seed installers
    const installerStore = this.getEntityStore('installers');
    squireInstallers.forEach((installer: SquireInstaller) => {
      const id = String(installer.id || crypto.randomUUID());
      installerStore.set(id, { ...installer, id });
    });

    // Seed payouts (from projects)
    const payoutStore = this.getEntityStore('payouts');
    squireProjects.forEach((project: SquireProject) => {
      const payout = this.convertProjectToPayout(project);
      const payoutId = String(payout.id || crypto.randomUUID());
      payout.id = payoutId;
      payoutStore.set(payoutId, payout);
    });
    
    this.logger.info('SuiteCentral demo data seeded', {
      suppliers: supplierStore.size,
      installers: installerStore.size,
      payouts: payoutStore.size
    });
  }

  /**
   * Convert vendor data to SuiteCentral supplier format
   */
  private convertVendorToSupplier(vendor: SquireVendor): DataRecord {
    return {
      id: vendor.id,
      externalId: vendor.squireVendorCode,
      supplierName: vendor.vendorName,
      contactPerson: vendor.contactPerson,
      contactEmail: vendor.vendorEmail,
      phone: vendor.businessPhone,
      address: vendor.businessAddress,
      paymentTerms: vendor.paymentTermsCode,
      supplierType: vendor.vendorCategory,
      status: vendor.approvalStatus === 'Approved' ? 'active' : 'pending',
      supplierScore: vendor.qualityRating * 20,
      isPreferred: vendor.preferredVendor,
      creditLimit: vendor.creditLimit,
      lastModified: new Date().toISOString(),
      _suiteCentral: {
        module: 'SupplierCentral',
        tenantId: this.tenantId,
        syncedFrom: 'Squire'
      }
    };
  }

  /**
   * Convert project data to SuiteCentral payout format
   */
  private convertProjectToPayout(project: SquireProject): DataRecord {
    const commissionAmount = project.projectValue * project.commissionRate;
    return {
      id: `payout_${project.id}`,
      externalId: project.squireProjectId,
      projectId: project.projectNumber,
      clientName: project.customerName,
      serviceType: project.projectType,
      status: project.projectStatus === 'Completed' ? 'completed' : 'active',
      installerId: project.assignedInstaller,
      totalAmount: project.projectValue,
      commissionPercent: project.commissionRate * 100,
      commissionAmount: Number(commissionAmount.toFixed(2)),
      hoursWorked: project.actualHours || project.estimatedHours,
      completedDate: project.completionDate,
      satisfactionScore: project.customerSatisfaction,
      paymentStatus: project.payoutStatus === 'Paid' ? 'paid' : 'pending',
      invoiceRef: project.invoiceNumber,
      lastModified: new Date().toISOString(),
      _suiteCentral: {
        module: 'PayoutCentral',
        tenantId: this.tenantId,
        syncedFrom: 'Squire'
      }
    };
  }

  async authenticate(): Promise<boolean> {
    if (!this.isProductionMode) {
      // Demo mode - always authenticate successfully
      this.isAuthenticated = true;
      this.logger.info('SuiteCentral demo authentication successful');
      return true;
    }
    
    try {
      // Production mode - validate API key with SuiteCentral
      const authResponse = await this.makeRequest<{ valid: boolean; permissions?: string[] }>({
        method: 'POST',
        url: '/auth/validate',
        data: {
          apiKey: this.apiKey,
          tenantId: this.tenantId
        }
      });
      
      if (authResponse.valid) {
        this.isAuthenticated = true;
        this.logger.info('SuiteCentral production authentication successful', {
          tenantId: this.tenantId,
          permissions: authResponse.permissions
        });
        return true;
      } else {
        throw new Error('Invalid API key or tenant ID');
      }
      
    } catch (error) {
      this.logger.error('SuiteCentral authentication failed', error);
      this.isAuthenticated = false;
      throw error;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();
    
    if (!this.isProductionMode) {
      // Return demo system info
      return {
        name: 'SuiteCentral (Demo)',
        type: 'SuiteCentral',
        version: '2024.1-demo',
        capabilities: [
          'suppliers', 'installers', 'payouts', 'customers', 'services', 'inventory',
          'demo_mode', 'mock_endpoints', 'field_mapping', 'business_rules'
        ],
        rateLimits: {
          requestsPerMinute: 1000,
          requestsPerHour: 60000,
          requestsPerDay: 1000000,
        },
        endpoints: {
          baseUrl: this.baseUrl,
          authUrl: `${this.baseUrl}/auth`,
          webhookUrl: `${this.baseUrl}/webhooks`,
        },
        modules: this.supportedModules,
      };
    }
    
    try {
      const systemResponse = await this.makeRequest<{ version?: string; rateLimits?: { perMinute?: number; perHour?: number; perDay?: number } }>({
        method: 'GET',
        url: '/system/info'
      });
      
      return {
        name: 'SuiteCentral',
        type: 'SuiteCentral',
        version: systemResponse.version || '2024.1',
        capabilities: [
          'suppliers', 'installers', 'payouts', 'customers', 'services', 'inventory',
          'real_time_sync', 'bulk_operations', 'webhooks', 'netsuite_native',
          'field_mapping', 'business_rules', 'audit_trail'
        ],
        rateLimits: {
          requestsPerMinute: systemResponse.rateLimits?.perMinute || 500,
          requestsPerHour: systemResponse.rateLimits?.perHour || 10000,
          requestsPerDay: systemResponse.rateLimits?.perDay || 100000,
        },
        endpoints: {
          baseUrl: this.baseUrl,
          authUrl: `${this.baseUrl}/auth`,
          webhookUrl: `${this.baseUrl}/webhooks`,
        },
        modules: this.supportedModules,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get SuiteCentral system info: ${message}`, { cause: error });
    }
  }

  /**
   * Create record - routes to production or demo implementation
   */
  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();
    
    if (this.isProductionMode) {
      return this.createProduction(entityType, data);
    } else {
      return this.createDemo(entityType, data);
    }
  }

  /**
   * Create record in production SuiteCentral
   */
  private async createProduction(entityType: string, data: DataRecord): Promise<DataRecord> {
    const { module, endpoint } = this.resolveModuleEndpoint(entityType);
    const url = `${endpoint}`;
    
    // Add SuiteCentral-specific metadata
    const enrichedData = this.enrichDataForSuiteCentral(data, module);
    
    try {
      this.logger.debug(`Creating ${entityType} in ${module}`, { 
        entityType, 
        module,
        recordId: data.id || 'new'
      });
      
      const response = await this.makeRequest<any>({
        method: 'POST',
        url,
        data: enrichedData,
      });
      
      const result = this.formatDataFromSuiteCentral(response, entityType, module);
      
      this.logger.info(`Successfully created ${entityType} in ${module}`, {
        id: result.id,
        externalId: result.externalId
      });
      
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create ${entityType} in ${module}`, error);
      throw new Error(`Failed to create ${entityType}: ${message}`, { cause: error });
    }
  }

  /**
   * Create record in demo mode
   */
  private async createDemo(entityType: string, data: DataRecord): Promise<DataRecord> {
    const store = this.getEntityStore(entityType);
    const id = data.id || crypto.randomUUID();
    const record: DataRecord = { 
      ...data, 
      id,
      lastModified: new Date().toISOString(),
      _suiteCentral: {
        module: this.resolveModuleEndpoint(entityType).module,
        tenantId: this.tenantId,
        demo: true
      }
    };
    
    store.set(id, record);
    this.logChange(entityType, id, record, 'create');
    
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
    
    this.logger.info(`Demo: Created ${entityType}`, { id });
    return record;
  }

  /**
   * Read, update, delete, list, search methods follow similar pattern...
   * Implementation delegates to production or demo based on isProductionMode
   */
  
  async read(entityType: string, id: string): Promise<DataRecord | null> {
    await this.ensureAuthenticated();
    
    if (this.isProductionMode) {
      return this.readProduction(entityType, id);
    } else {
      return this.readDemo(entityType, id);
    }
  }

  private async readProduction(entityType: string, id: string): Promise<DataRecord | null> {
    const { module, endpoint } = this.resolveModuleEndpoint(entityType);
    const url = `${endpoint}/${id}`;
    
    try {
      const response = await this.makeRequest({
        method: 'GET',
        url,
      });
      
      if (!response) return null;
      return this.formatDataFromSuiteCentral(response, entityType, module);
    } catch (error: unknown) {
      if (error instanceof Error && (error.message.includes('404') || error.message.includes('not found'))) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  private async readDemo(entityType: string, id: string): Promise<DataRecord | null> {
    const store = this.getEntityStore(entityType);
    await new Promise(resolve => setTimeout(resolve, Math.random() * 50 + 25)); // Simulate delay
    return store.get(id) ?? null;
  }

  async list(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
    await this.ensureAuthenticated();
    
    if (this.isProductionMode) {
      return this.listProduction(entityType, options);
    } else {
      return this.listDemo(entityType, options);
    }
  }

  private async listProduction(entityType: string, options: ListOptions): Promise<DataRecord[]> {
    const { module, endpoint } = this.resolveModuleEndpoint(entityType);
    
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.offset) params.append('offset', options.offset.toString());
    if (options.fields) params.append('fields', options.fields.join(','));
    params.append('module', module);
    
    const url = `${endpoint}?${params.toString()}`;
    
    try {
      const response = await this.makeRequest<{items: unknown[], totalCount: number}>({
        method: 'GET',
        url,
      });
      
      if (Array.isArray(response.items)) {
        return response.items.map((item: unknown) => 
          this.formatDataFromSuiteCentral(item, entityType, module)
        );
      }
      
      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list ${entityType}: ${message}`, { cause: error });
    }
  }

  private async listDemo(entityType: string, options: ListOptions): Promise<DataRecord[]> {
    const store = this.getEntityStore(entityType);
    let records = Array.from(store.values());
    
    if (options.offset) {
      records = records.slice(options.offset);
    }
    if (options.limit) {
      records = records.slice(0, options.limit);
    }
    
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50)); // Simulate delay
    return records;
  }

  // Utility methods

  private getEntityStore(entityType: string): Map<string, DataRecord> {
    if (!this.mockDataStore.has(entityType)) {
      this.mockDataStore.set(entityType, new Map());
    }
    return this.mockDataStore.get(entityType)!;
  }

  private logChange(
    entityType: string,
    id: string,
    record: DataRecord | null,
    operation: 'create' | 'update' | 'delete',
  ): void {
    if (!this.mockChangeLog.has(entityType)) {
      this.mockChangeLog.set(entityType, []);
    }
    this.mockChangeLog.get(entityType)!.push({ id, record, operation, timestamp: new Date() });
  }

  private resolveModuleEndpoint(entityType: string): { module: string; endpoint: string } {
    const moduleMapping: Record<string, string> = {
      'vendors': 'SupplierCentral',
      'suppliers': 'SupplierCentral', 
      'installers': 'InstallerCentral',
      'technicians': 'InstallerCentral',
      'payouts': 'PayoutCentral',
      'commissions': 'PayoutCentral',
      'customers': 'CustomerCentral',
      'services': 'ServiceCentral',
      'inventory': 'InventoryCentral'
    };
    
    const module = moduleMapping[entityType.toLowerCase()] || 'SupplierCentral';
    const endpoint = this.moduleEndpoints[module];
    
    if (!endpoint) {
      throw new Error(`No endpoint configured for SuiteCentral module: ${module}`);
    }
    
    return { module, endpoint };
  }

  private enrichDataForSuiteCentral(
    data: Partial<DataRecord>, 
    module: string, 
    operation: 'create' | 'update' = 'create'
  ): unknown {
    const timestamp = new Date().toISOString();
    
    return {
      ...data,
      _suiteCentral: {
        module,
        operation,
        timestamp,
        tenantId: this.tenantId,
        version: '2024.1',
        source: 'IntegrationHub',
        productionMode: this.isProductionMode
      },
      lastModified: timestamp,
      modifiedBy: 'IntegrationHub'
    };
  }

  private formatDataFromSuiteCentral(
    suiteCentralData: unknown,
    entityType: string,
    module: string,
    changeMetadata?: unknown
  ): DataRecord {
    // Narrow once: treat the response as an indexable record. Non-object inputs
    // produce an empty record, which keeps downstream property access safe.
    const raw: Record<string, unknown> =
      suiteCentralData && typeof suiteCentralData === 'object'
        ? (suiteCentralData as Record<string, unknown>)
        : {};

    const fields: Record<string, unknown> = { ...raw };

    // Remove SuiteCentral internal fields
    delete fields._suiteCentral;
    delete fields.internalId;

    const id =
      typeof raw.id === 'string'
        ? raw.id
        : typeof raw.id === 'number'
          ? String(raw.id)
          : '';
    const externalId =
      typeof raw.externalId === 'string'
        ? raw.externalId
        : typeof raw.externalId === 'number'
          ? String(raw.externalId)
          : '';
    const lastModifiedRaw = raw.lastModified;
    const lastModified =
      typeof lastModifiedRaw === 'string' || typeof lastModifiedRaw === 'number'
        ? new Date(lastModifiedRaw)
        : new Date();
    const suiteCentralMeta =
      raw._suiteCentral && typeof raw._suiteCentral === 'object'
        ? (raw._suiteCentral as Record<string, unknown>)
        : undefined;
    const version =
      typeof suiteCentralMeta?.version === 'string' ? suiteCentralMeta.version : '2024.1';
    const extraMetadata =
      changeMetadata && typeof changeMetadata === 'object'
        ? (changeMetadata as Record<string, unknown>)
        : {};

    return {
      id: id || externalId || '',
      externalId: externalId || id || '',
      fields,
      metadata: {
        source: 'SuiteCentral',
        module,
        entityType,
        productionMode: this.isProductionMode,
        lastModified,
        version,
        tenantId: this.tenantId,
        ...extraMetadata,
      },
    };
  }

  // Placeholder implementations for remaining methods
  async update(_entityType: string, _id: string, _data: Partial<DataRecord>): Promise<DataRecord> {
    // Implementation follows same production/demo pattern
    await this.ensureAuthenticated();
    throw new Error('Update method implementation needed');
  }

  async delete(_entityType: string, _id: string): Promise<boolean> {
    // Implementation follows same production/demo pattern
    await this.ensureAuthenticated();
    throw new Error('Delete method implementation needed');
  }

  async search(_entityType: string, _criteria: SearchCriteria): Promise<DataRecord[]> {
    // Implementation follows same production/demo pattern
    await this.ensureAuthenticated();
    throw new Error('Search method implementation needed');
  }

  async setupWebhook(_webhookUrl: string, _events: string[]): Promise<string> {
    await this.ensureAuthenticated();
    throw new Error('Webhook setup implementation needed');
  }

  async getChanges(_entityType: string, _since: Date): Promise<DataRecord[]> {
    await this.ensureAuthenticated();
    throw new Error('Get changes implementation needed');
  }
}

export default SuiteCentralProductionConnector;
