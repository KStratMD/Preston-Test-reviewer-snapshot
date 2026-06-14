import { injectable, inject } from 'inversify';
import { BaseConnector } from '../core/BaseConnector';
import type { AuthService } from '../services/AuthService';
import type { AuthConfig } from '../types';
import type { Logger } from '../utils/Logger';
import type { DataRecord, FieldMapping, SystemInfo, ConnectionStatus } from '../types';
import type { CircuitBreakerOptions } from '../utils/CircuitBreaker';
import { CryptoUtils } from '../utils/crypto';
import { TYPES } from '../inversify/types';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as crypto from 'crypto';

interface ErrorWithResponse {
  response?: {
    status?: number;
  };
}

export interface SuiteCentralConfig {
  baseUrl: string;
  apiVersion?: string;
  environment: 'sandbox' | 'production';
  clientId: string;
  clientSecret: string;
  companyId?: string;
  timeout?: number;
  retryAttempts?: number;
  rateLimitConfig?: {
    requestsPerSecond: number;
    burstAllowance: number;
  };
}

export interface SuiteCentralEntityConfig {
  entityType: string;
  endpoint: string;
  primaryKey: string;
  fields: Record<string, {
    type: 'string' | 'number' | 'date' | 'boolean' | 'object';
    required?: boolean;
    maxLength?: number;
    validation?: RegExp;
  }>;
}

export interface WebhookSubscription {
  id: string;
  entityType: string;
  events: string[];
  targetUrl: string;
  secret: string;
  isActive: boolean;
  createdAt: Date;
  lastTriggered?: Date;
}

export interface SuiteCentralBulkOperation {
  operationId: string;
  type: 'import' | 'export' | 'update' | 'delete';
  entityType: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalRecords: number;
  processedRecords: number;
  successCount: number;
  errorCount: number;
  errors: {
    recordIndex: number;
    error: string;
    recordData?: unknown;
  }[];
  createdAt: Date;
  completedAt?: Date;
}

/**
 * Production-ready SuiteCentral connector with advanced features including:
 * - Real API integration with OAuth2 authentication
 * - Connection pooling and rate limiting
 * - Comprehensive error handling and retry logic
 * - Webhook management for real-time updates
 * - Bulk operation support with progress tracking
 * - Advanced security and telemetry integration
 * - Health monitoring and performance optimization
 */
@injectable()
export class SuiteCentralConnectorProd extends BaseConnector {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Real OAuth2 + axios HTTP scaffolding (no demo fallback — throws on misconfig); bound at inversify.config.ts:514, used by src/routes/suiteCentralProd.ts; no production credential test on file';

  protected override httpClient: AxiosInstance = null as any;
  private config?: SuiteCentralConfig;
  private accessToken?: string;
  private tokenExpiresAt?: Date;
  private webhookSubscriptions = new Map<string, WebhookSubscription>();
  private bulkOperations = new Map<string, SuiteCentralBulkOperation>();
  private rateLimiter = {
    tokens: 10,
    lastRefill: Date.now(),
    refillRate: 10, // tokens per second
    maxTokens: 10
  };

  // Entity configurations for SuiteCentral API
  private readonly entityConfigs: Record<string, SuiteCentralEntityConfig> = {
    customers: {
      entityType: 'customers',
      endpoint: '/api/v1/customers',
      primaryKey: 'customerId',
      fields: {
        customerId: { type: 'string', required: true },
        companyName: { type: 'string', required: true, maxLength: 255 },
        contactName: { type: 'string', maxLength: 255 },
        email: { type: 'string', validation: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
        phone: { type: 'string', maxLength: 20 },
        address: { type: 'object' },
        status: { type: 'string', required: true },
        createdDate: { type: 'date' },
        lastModified: { type: 'date' }
      }
    },
    vendors: {
      entityType: 'vendors',
      endpoint: '/api/v1/vendors',
      primaryKey: 'vendorId',
      fields: {
        vendorId: { type: 'string', required: true },
        vendorName: { type: 'string', required: true, maxLength: 255 },
        contactInfo: { type: 'object' },
        paymentTerms: { type: 'string' },
        isActive: { type: 'boolean', required: true },
        createdDate: { type: 'date' },
        lastModified: { type: 'date' }
      }
    },
    products: {
      entityType: 'products',
      endpoint: '/api/v1/products',
      primaryKey: 'productId',
      fields: {
        productId: { type: 'string', required: true },
        productName: { type: 'string', required: true, maxLength: 255 },
        sku: { type: 'string', required: true, maxLength: 100 },
        category: { type: 'string' },
        price: { type: 'number', required: true },
        isActive: { type: 'boolean', required: true },
        createdDate: { type: 'date' },
        lastModified: { type: 'date' }
      }
    },
    orders: {
      entityType: 'orders',
      endpoint: '/api/v1/orders',
      primaryKey: 'orderId',
      fields: {
        orderId: { type: 'string', required: true },
        customerId: { type: 'string', required: true },
        orderDate: { type: 'date', required: true },
        totalAmount: { type: 'number', required: true },
        status: { type: 'string', required: true },
        items: { type: 'object' },
        createdDate: { type: 'date' },
        lastModified: { type: 'date' }
      }
    }
  };

  constructor(
    systemId = 'suitecentral-prod',
    @inject(TYPES.Logger) logger: Logger,
    circuitBreakerOptions?: Partial<CircuitBreakerOptions>
  ) {
    super('SuiteCentral', systemId, logger, circuitBreakerOptions);
    
    this.httpClient = axios.create({
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Preston-Integration-Hub/1.0'
      }
    });

    this.setupAxiosInterceptors();
    this.logger.info('SuiteCentral production connector initialized');
  }

  async initialize(authConfig: AuthConfig): Promise<void> {
    this.logger.info('Initializing SuiteCentral production connector', { 
      environment: authConfig.credentials?.environment || 'unknown' 
    });

    if (authConfig.type !== 'oauth2') {
      throw new Error('SuiteCentral production connector requires OAuth2 authentication');
    }

    // Validate required credentials
    const credentials = authConfig.credentials as any;
    if (!credentials.clientId || !credentials.clientSecret || !credentials.baseUrl) {
      throw new Error('Missing required SuiteCentral credentials: clientId, clientSecret, baseUrl');
    }

    this.config = {
      baseUrl: credentials.baseUrl,
      apiVersion: credentials.apiVersion || 'v1',
      environment: credentials.environment || 'sandbox',
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      companyId: credentials.companyId,
      timeout: credentials.timeout || 30000,
      retryAttempts: credentials.retryAttempts || 3,
      rateLimitConfig: credentials.rateLimitConfig || {
        requestsPerSecond: 10,
        burstAllowance: 20
      }
    };

    // Configure HTTP client
    this.httpClient.defaults.baseURL = this.config.baseUrl;
    this.httpClient.defaults.timeout = this.config.timeout;

    // Configure rate limiting
    this.rateLimiter.refillRate = this.config.rateLimitConfig?.requestsPerSecond || 10;
    this.rateLimiter.maxTokens = this.config.rateLimitConfig?.burstAllowance || 20;
    this.rateLimiter.tokens = this.rateLimiter.maxTokens;

    this.authConfig = authConfig;

    this.logger.info('SuiteCentral production connector initialized successfully', {
      baseUrl: this.config.baseUrl,
      environment: this.config.environment,
      apiVersion: this.config.apiVersion
    });
  }

  async authenticate(): Promise<boolean> {
    if (!this.config) {
      throw new Error('Connector not initialized');
    }

    try {
      this.logger.debug('Authenticating with SuiteCentral');

      // Check if we have a valid token
      if (this.accessToken && this.tokenExpiresAt && this.tokenExpiresAt > new Date()) {
        return true;
      }

      // OAuth2 Client Credentials flow
      const tokenResponse = await axios.post(`${this.config.baseUrl}/oauth/token`, {
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: 'read write'
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const tokenData = tokenResponse.data;
      this.accessToken = tokenData.access_token;
      this.tokenExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000));

      // Set authorization header for all requests
      this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${this.accessToken}`;

      this.isAuthenticated = true;
      this.logger.info('SuiteCentral authentication successful', {
        expiresAt: this.tokenExpiresAt
      });

      return true;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('SuiteCentral authentication failed', error);
      this.isAuthenticated = false;
      throw new Error(`Authentication failed: ${err.message}`, { cause: error });
    }
  }

  override async testConnection(): Promise<ConnectionStatus> {
    try {
      await this.ensureAuthenticated();
      
      // Test connection with a simple API call
      const response = await this.rateLimitedRequest(() => 
        this.httpClient.get('/api/v1/health')
      );

      return {
        systemType: this.systemType,
        systemId: this.systemId,
        isConnected: response.status === 200,
        lastTestTime: new Date(),
        latency: response.headers['x-response-time'] ? 
          parseInt(response.headers['x-response-time']) : undefined
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        systemType: this.systemType,
        systemId: this.systemId,
        isConnected: false,
        lastTestTime: new Date(),
        errorMessage: err.message
      };
    }
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    await this.ensureAuthenticated();
    
    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    try {
      const response = await this.rateLimitedRequest(() =>
        this.httpClient.get(`${config.endpoint}/${id}`)
      );

      return this.transformToDataRecord(response.data, entityType);
    } catch (error: unknown) {
      const err = error as ErrorWithResponse;
      if (err.response?.status === 404) {
        return null;
      }
      this.logger.error(`Failed to read ${entityType} ${id}`, error);
      throw error;
    }
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();
    
    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    // Validate data according to entity configuration
    this.validateEntityData(data, config);

    try {
      const payload = this.transformFromDataRecord(data, entityType);
      const response = await this.rateLimitedRequest(() =>
        this.httpClient.post(config.endpoint, payload)
      );

      return this.transformToDataRecord(response.data, entityType);
    } catch (error: unknown) {
      this.logger.error(`Failed to create ${entityType}`, error);
      throw error;
    }
  }

  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    await this.ensureAuthenticated();
    
    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    try {
      const payload = this.transformFromDataRecord(data as DataRecord, entityType);
      const response = await this.rateLimitedRequest(() =>
        this.httpClient.put(`${config.endpoint}/${id}`, payload)
      );

      return this.transformToDataRecord(response.data, entityType);
    } catch (error: unknown) {
      this.logger.error(`Failed to update ${entityType} ${id}`, error);
      throw error;
    }
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    await this.ensureAuthenticated();
    
    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    try {
      await this.rateLimitedRequest(() =>
        this.httpClient.delete(`${config.endpoint}/${id}`)
      );

      return true;
    } catch (error: unknown) {
      const err = error as ErrorWithResponse;
      if (err.response?.status === 404) {
        return false;
      }
      this.logger.error(`Failed to delete ${entityType} ${id}`, error);
      throw error;
    }
  }

  async list(entityType: string, options: unknown = {}): Promise<DataRecord[]> {
    await this.ensureAuthenticated();
    
    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    try {
      const params = {
        limit: (options as any).limit || 100,
        offset: (options as any).offset || 0,
        ...(options as any).filters
      };

      const response = await this.rateLimitedRequest(() =>
        this.httpClient.get(config.endpoint, { params })
      );

      return response.data.items?.map((item: unknown) => 
        this.transformToDataRecord(item, entityType)
      ) || [];
    } catch (error: unknown) {
      this.logger.error(`Failed to list ${entityType}`, error);
      throw error;
    }
  }

  async search(entityType: string, criteria: unknown): Promise<DataRecord[]> {
    await this.ensureAuthenticated();
    
    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    try {
      const response = await this.rateLimitedRequest(() =>
        this.httpClient.post(`${config.endpoint}/search`, criteria)
      );

      return response.data.items?.map((item: unknown) => 
        this.transformToDataRecord(item, entityType)
      ) || [];
    } catch (error: unknown) {
      this.logger.error(`Failed to search ${entityType}`, error);
      throw error;
    }
  }

  // Advanced Webhook Management
  async setupWebhook(targetUrl: string, events: string[]): Promise<string> {
    await this.ensureAuthenticated();

    try {
      const webhookSecret = CryptoUtils.generateApiKey('webhook', 32);
      const subscriptionData = {
        targetUrl,
        events,
        secret: webhookSecret,
        isActive: true
      };

      const response = await this.rateLimitedRequest(() =>
        this.httpClient.post('/api/v1/webhooks', subscriptionData)
      );

      const subscription: WebhookSubscription = {
        id: response.data.id,
        entityType: 'all',
        events,
        targetUrl,
        secret: webhookSecret,
        isActive: true,
        createdAt: new Date()
      };

      this.webhookSubscriptions.set(subscription.id, subscription);

      this.logger.info('Webhook subscription created', {
        id: subscription.id,
        targetUrl,
        events
      });

      return subscription.id;
    } catch (error: unknown) {
      this.logger.error('Failed to setup webhook', error);
      throw error;
    }
  }

  async removeWebhook(webhookId: string): Promise<boolean> {
    await this.ensureAuthenticated();

    try {
      await this.rateLimitedRequest(() =>
        this.httpClient.delete(`/api/v1/webhooks/${webhookId}`)
      );

      this.webhookSubscriptions.delete(webhookId);
      this.logger.info('Webhook subscription removed', { webhookId });
      
      return true;
    } catch (error: unknown) {
      this.logger.error('Failed to remove webhook', error);
      return false;
    }
  }

  // Bulk Operations Support
  async bulkImport(entityType: string, records: DataRecord[]): Promise<string> {
    await this.ensureAuthenticated();

    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    try {
      const operationId = CryptoUtils.generateUUID();
      const payload = {
        operationId,
        entityType,
        records: records.map(record => this.transformFromDataRecord(record, entityType))
      };

      const response = await this.rateLimitedRequest(() =>
        this.httpClient.post(`/api/v1/bulk/import`, payload)
      );

      const operation: SuiteCentralBulkOperation = {
        operationId,
        type: 'import',
        entityType,
        status: 'pending',
        totalRecords: records.length,
        processedRecords: 0,
        successCount: 0,
        errorCount: 0,
        errors: [],
        createdAt: new Date()
      };

      this.bulkOperations.set(operationId, operation);

      this.logger.info('Bulk import operation initiated', {
        operationId,
        entityType,
        recordCount: records.length
      });

      return operationId;
    } catch (error: unknown) {
      this.logger.error('Failed to initiate bulk import', error);
      throw error;
    }
  }

  async getBulkOperationStatus(operationId: string): Promise<SuiteCentralBulkOperation | null> {
    await this.ensureAuthenticated();

    try {
      const response = await this.rateLimitedRequest(() =>
        this.httpClient.get(`/api/v1/bulk/operations/${operationId}`)
      );

      const operation: SuiteCentralBulkOperation = {
        ...response.data,
        createdAt: new Date(response.data.createdAt),
        completedAt: response.data.completedAt ? new Date(response.data.completedAt) : undefined
      };

      this.bulkOperations.set(operationId, operation);
      return operation;
    } catch (error: unknown) {
      const err = error as ErrorWithResponse;
      if (err.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getChanges(entityType: string, since: Date): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    try {
      const params = {
        since: since.toISOString(),
        limit: 1000
      };

      const response = await this.rateLimitedRequest(() =>
        this.httpClient.get(`${config.endpoint}/changes`, { params })
      );

      return response.data.items?.map((item: unknown) => 
        this.transformToDataRecord(item, entityType)
      ) || [];
    } catch (error: unknown) {
      this.logger.error(`Failed to get changes for ${entityType}`, error);
      throw error;
    }
  }

  override async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    try {
      const response = await this.rateLimitedRequest(() =>
        this.httpClient.get('/api/v1/system/info')
      );

      return {
        name: 'SuiteCentral',
        type: 'SuiteCentral',
        version: response.data.version || '1.0.0',
        capabilities: [
          'customers', 'vendors', 'products', 'orders',
          'bulk_operations', 'webhooks', 'real_time_sync',
          'advanced_search', 'change_tracking'
        ],
        rateLimits: {
          requestsPerMinute: this.config?.rateLimitConfig?.requestsPerSecond ? 
            this.config.rateLimitConfig.requestsPerSecond * 60 : 600,
          requestsPerHour: this.config?.rateLimitConfig?.requestsPerSecond ? 
            this.config.rateLimitConfig.requestsPerSecond * 3600 : 36000,
          requestsPerDay: this.config?.rateLimitConfig?.requestsPerSecond ? 
            this.config.rateLimitConfig.requestsPerSecond * 86400 : 864000
        },
        endpoints: {
          baseUrl: this.config?.baseUrl || '',
          authUrl: `${this.config?.baseUrl}/oauth`,
          webhookUrl: `${this.config?.baseUrl}/api/v1/webhooks`
        }
      };
    } catch (error: unknown) {
      this.logger.warn('Failed to get system info, returning defaults', { error });
      return {
        name: 'SuiteCentral',
        type: 'SuiteCentral',
        version: '1.0.0',
        capabilities: ['customers', 'vendors', 'products', 'orders'],
        rateLimits: { requestsPerMinute: 600, requestsPerHour: 36000, requestsPerDay: 864000 },
        endpoints: { baseUrl: this.config?.baseUrl || '', authUrl: '', webhookUrl: '' }
      };
    }
  }

  // Private helper methods
  private setupAxiosInterceptors(): void {
    // Request interceptor for logging and rate limiting
    this.httpClient.interceptors.request.use(
      async (config) => {
        await this.waitForRateLimit();
        
        this.logger.debug('SuiteCentral API request', {
          method: config.method?.toUpperCase(),
          url: config.url,
          params: config.params
        });
        
        return config;
      },
      (error) => {
        this.logger.error('Request interceptor error', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for logging and error handling
    this.httpClient.interceptors.response.use(
      (response) => {
        this.logger.debug('SuiteCentral API response', {
          status: response.status,
          url: response.config.url,
          responseTime: response.headers['x-response-time']
        });
        return response;
      },
      (error) => {
        this.logger.error('SuiteCentral API error', {
          status: error.response?.status,
          url: error.config?.url,
          message: error.message,
          data: error.response?.data
        });

        // Handle token expiration
        if (error.response?.status === 401) {
          this.isAuthenticated = false;
          this.accessToken = undefined;
          this.tokenExpiresAt = undefined;
        }

        return Promise.reject(error);
      }
    );
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timePassed = now - this.rateLimiter.lastRefill;
    
    // Refill tokens based on time passed
    const tokensToAdd = Math.floor(timePassed / 1000) * this.rateLimiter.refillRate;
    this.rateLimiter.tokens = Math.min(
      this.rateLimiter.maxTokens,
      this.rateLimiter.tokens + tokensToAdd
    );
    this.rateLimiter.lastRefill = now;

    // If no tokens available, wait
    if (this.rateLimiter.tokens < 1) {
      const waitTime = (1 - this.rateLimiter.tokens) / this.rateLimiter.refillRate * 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.rateLimiter.tokens = 1;
    }

    // Consume a token
    this.rateLimiter.tokens--;
  }

  private async rateLimitedRequest<T>(requestFn: () => Promise<AxiosResponse<T>>): Promise<AxiosResponse<T>> {
    await this.waitForRateLimit();
    return requestFn();
  }

  private isValidDateValue(value: unknown): boolean {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    if (typeof value === 'string' || typeof value === 'number') {
      return !Number.isNaN(new Date(value).getTime());
    }
    return false;
  }

  private matchesFieldType(value: unknown, expectedType: SuiteCentralEntityConfig['fields'][string]['type']): boolean {
    if (expectedType === 'date') return this.isValidDateValue(value);
    if (expectedType === 'object') return typeof value === 'object';
    return typeof value === expectedType;
  }

  private parseLastModified(value: unknown): Date {
    if (!this.isValidDateValue(value)) return new Date();
    if (value instanceof Date) return value;
    return new Date(value as string | number);
  }

  private validateEntityData(data: DataRecord, config: SuiteCentralEntityConfig): void {
    const fields = data.fields as Record<string, unknown> | undefined;
    for (const [fieldName, fieldConfig] of Object.entries(config.fields)) {
      const value = fields?.[fieldName];

      if (fieldConfig.required && (value === undefined || value === null)) {
        throw new Error(`Required field '${fieldName}' is missing`);
      }

      if (value !== undefined && value !== null) {
        // Type validation. `typeof` can't return 'date', so route 'date'
        // and 'object' through matchesFieldType which handles them
        // structurally (Date instance or ISO string/epoch for dates;
        // any non-null object for 'object').
        if (!this.matchesFieldType(value, fieldConfig.type)) {
          const actualType = value instanceof Date ? 'date' : typeof value;
          throw new Error(`Field '${fieldName}' must be of type ${fieldConfig.type}, got ${actualType}`);
        }

        // String length validation
        if (
          fieldConfig.type === 'string' &&
          fieldConfig.maxLength &&
          typeof value === 'string' &&
          value.length > fieldConfig.maxLength
        ) {
          throw new Error(`Field '${fieldName}' exceeds maximum length of ${fieldConfig.maxLength}`);
        }

        // Regex validation
        if (fieldConfig.validation && typeof value === 'string' && !fieldConfig.validation.test(value)) {
          throw new Error(`Field '${fieldName}' does not match required format`);
        }
      }
    }
  }

  private transformToDataRecord(apiData: unknown, entityType: string): DataRecord {
    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    const data = apiData as Record<string, unknown>;
    const primaryKeyValue = data[config.primaryKey];
    if (primaryKeyValue === undefined || primaryKeyValue === null) {
      throw new Error(
        `Missing primary key '${config.primaryKey}' on ${entityType} record from SuiteCentral`
      );
    }
    const id = String(primaryKeyValue);
    return {
      id,
      externalId: id,
      fields: data,
      metadata: {
        source: 'SuiteCentral',
        version: '1.0',
        lastModified: this.parseLastModified(data.lastModified),
        syncStatus: 'synced'
      }
    };
  }

  private transformFromDataRecord(data: DataRecord, entityType: string): unknown {
    const config = this.entityConfigs[entityType];
    if (!config) {
      throw new Error(`Unsupported entity type: ${entityType}`);
    }

    return {
      ...(data.fields as any),
      lastModified: new Date().toISOString()
    };
  }
}

export default SuiteCentralConnectorProd;