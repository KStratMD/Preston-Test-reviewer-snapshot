import { injectable, inject } from 'inversify';
import { BaseConnector } from '../core/BaseConnector';
import type { AuthConfig } from '../types';
import type { Logger } from '../utils/Logger';
import type { DataRecord, SystemInfo, ConnectionStatus } from '../types';
import type { CircuitBreakerOptions } from '../utils/CircuitBreaker';
import { CryptoUtils } from '../utils/crypto';
import { TYPES } from '../inversify/types';
import type {
  PinnedHttpsClient,
  PinnedRequestOptions,
  PinnedResponse,
} from '../services/suitecentral/controlPlane/PinnedHttpsTransport';

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
 * Production-ready SuiteCentral connector.
 *
 * DNS-rebinding hardening (PR-A4): every outbound HTTP call — OAuth token
 * exchange AND every API request — is routed through an injected
 * {@link PinnedHttpsClient}. That client is built by `PinnedHttpsTransport`
 * against a validated, address-pinned destination, so the connector cannot
 * reach any host other than the one the outbound policy approved. There is NO
 * static `axios` escape hatch and NO per-connector base URL; the pinned client's
 * base is fixed at construction.
 *
 * The connector is constructed fresh per operation by
 * `SuiteCentralConnectorFactory` (never cached/singleton with a live secret).
 * When no pinned client is injected (e.g. the inert DI-bound instance) every
 * request fails closed with `suitecentral_transport_not_configured`.
 */
@injectable()
export class SuiteCentralConnectorProd extends BaseConnector {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Real OAuth2 over an injected PinnedHttpsClient (DNS-rebind-proof pinned transport; no demo fallback — throws on misconfig); constructed per-operation by SuiteCentralConnectorFactory; no production credential test on file';

  private pinnedClient?: PinnedHttpsClient;
  private config?: SuiteCentralConfig;
  private accessToken?: string;
  private tokenExpiresAt?: Date;
  // One-shot seal (PR-A4 review Finding 1): the factory constructs a fresh
  // connector per (tenant, environment, credential) and initializes it exactly
  // once. `initialize()` is public (from BaseConnector) so a second call could
  // otherwise rebind THIS instance to another tenant's credentials while the
  // pinned client still points at the original destination — a cross-tenant
  // secret leak. Once sealed, any further initialize() fails closed.
  private initialized = false;
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
    circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
    pinnedClient?: PinnedHttpsClient,
  ) {
    super('SuiteCentral', systemId, logger, circuitBreakerOptions);
    this.pinnedClient = pinnedClient;
    this.logger.info('SuiteCentral production connector initialized');
  }

  async initialize(authConfig: AuthConfig): Promise<void> {
    // Fail closed on any re-initialization: a sealed connector must never be
    // rebound to a different credential set (see `initialized` field docs).
    if (this.initialized) {
      throw new Error('suitecentral_connector_already_initialized');
    }

    this.logger.info('Initializing SuiteCentral production connector', {
      environment: authConfig.credentials?.environment || 'unknown'
    });

    if (authConfig.type !== 'oauth2') {
      throw new Error('SuiteCentral production connector requires OAuth2 authentication');
    }

    // Validate required credentials. `credentials` is a typed record with an
    // index signature, so no `any` cast is needed to read the fields.
    const credentials = authConfig.credentials;
    const clientId = typeof credentials.clientId === 'string' ? credentials.clientId : undefined;
    const clientSecret = typeof credentials.clientSecret === 'string' ? credentials.clientSecret : undefined;
    const baseUrl = typeof credentials.baseUrl === 'string' ? credentials.baseUrl : undefined;
    if (!clientId || !clientSecret || !baseUrl) {
      throw new Error('Missing required SuiteCentral credentials: clientId, clientSecret, baseUrl');
    }

    const rateLimitConfig = credentials.rateLimitConfig as
      | { requestsPerSecond: number; burstAllowance: number }
      | undefined;

    this.config = {
      baseUrl,
      apiVersion: typeof credentials.apiVersion === 'string' ? credentials.apiVersion : 'v1',
      environment: this.resolveEnvironment(credentials.environment),
      clientId,
      clientSecret,
      companyId: typeof credentials.companyId === 'string' ? credentials.companyId : undefined,
      timeout: typeof credentials.timeout === 'number' ? credentials.timeout : 30000,
      retryAttempts: typeof credentials.retryAttempts === 'number' ? credentials.retryAttempts : 3,
      rateLimitConfig: rateLimitConfig ?? {
        requestsPerSecond: 10,
        burstAllowance: 20
      }
    };

    // Configure rate limiting. There is deliberately NO base-URL / timeout
    // wiring here: the pinned client's destination and timeout are fixed at
    // construction by the factory, so the connector cannot re-point itself.
    this.rateLimiter.refillRate = this.config.rateLimitConfig?.requestsPerSecond || 10;
    this.rateLimiter.maxTokens = this.config.rateLimitConfig?.burstAllowance || 20;
    this.rateLimiter.tokens = this.rateLimiter.maxTokens;

    this.authConfig = authConfig;

    // Seal only after a fully-successful init so a config that throws mid-way
    // can still be retried; a completed init can never be replaced.
    this.initialized = true;

    // NEVER log baseUrl, tokens, or client id/secret.
    this.logger.info('SuiteCentral production connector initialized successfully', {
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

      // Check if we have a valid, unexpired token
      if (this.isTokenValid()) {
        return true;
      }

      // OAuth2 Client Credentials flow. The path is RELATIVE — the pinned
      // client's base URL is the validated destination, so an absolute URL
      // would be rejected by the transport. `auth: false` because we do not yet
      // have a token. The pinned client JSON-serializes the body and forces
      // application/json.
      const tokenResponse = await this.pinnedRequest('POST', '/oauth/token', {
        auth: false,
        data: {
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: 'read write'
        },
      });

      // Fail closed (Finding 2): only trust a response that carries a non-empty
      // string access_token AND a positive, finite expires_in. Anything else
      // must NOT set a token or flip isAuthenticated — an unauthenticated
      // connector is safer than one holding a bogus/empty credential.
      const tokenData = tokenResponse.data as { access_token?: unknown; expires_in?: unknown };
      const accessToken = tokenData.access_token;
      const expiresIn = tokenData.expires_in;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new Error('SuiteCentral token response missing a non-empty access_token');
      }
      if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error('SuiteCentral token response missing a positive expires_in');
      }

      this.accessToken = accessToken;
      this.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
      // A finite/positive expires_in can still overflow to an Invalid Date
      // (e.g. Number.MAX_VALUE) or land in the past under clock skew — require a
      // valid, strictly-future expiry before trusting the token.
      if (!Number.isFinite(this.tokenExpiresAt.getTime()) || this.tokenExpiresAt <= new Date()) {
        this.accessToken = undefined;
        this.tokenExpiresAt = undefined;
        throw new Error('SuiteCentral token response produced an invalid or non-future expiry');
      }

      this.isAuthenticated = true;
      this.logger.info('SuiteCentral authentication successful', {
        expiresAt: this.tokenExpiresAt
      });

      return true;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('SuiteCentral authentication failed', error);
      // Fail closed: never leave a partial/stale credential behind on failure.
      this.isAuthenticated = false;
      this.accessToken = undefined;
      this.tokenExpiresAt = undefined;
      throw new Error(`Authentication failed: ${err.message}`, { cause: error });
    }
  }

  /**
   * Resolve the environment tier fail-fast: default to `sandbox` only when the
   * field is unset, and THROW on any unexpected value (e.g. 'staging', a 'prod'
   * typo) rather than silently coercing it to sandbox and masking a misconfig.
   */
  private resolveEnvironment(env: unknown): 'sandbox' | 'production' {
    if (env === undefined || env === null) {
      return 'sandbox';
    }
    if (env === 'sandbox' || env === 'production') {
      return env;
    }
    throw new Error(`Invalid SuiteCentral environment: ${String(env)}`);
  }

  /** True only when a non-empty token exists and has not expired. */
  private isTokenValid(): boolean {
    return (
      typeof this.accessToken === 'string' &&
      this.accessToken.length > 0 &&
      this.tokenExpiresAt !== undefined &&
      this.tokenExpiresAt > new Date()
    );
  }

  /**
   * Reauthenticate whenever the token is missing or expired (Finding 2). The
   * BaseConnector default only checks the `isAuthenticated` flag and would keep
   * a stale/expired token in play; this override keys off actual token validity.
   */
  protected override async ensureAuthenticated(): Promise<void> {
    if (!this.isTokenValid()) {
      await this.authenticate();
    }
  }

  override async testConnection(): Promise<ConnectionStatus> {
    try {
      await this.ensureAuthenticated();

      // Test connection with a simple API call. `throwOnError: false` so a
      // non-2xx status is read directly rather than thrown (native https
      // resolves regardless of status).
      const response = await this.pinnedRequest('GET', '/api/v1/health', { throwOnError: false });

      const responseTime = response.headers['x-response-time'];
      const latency = typeof responseTime === 'string' || typeof responseTime === 'number'
        ? parseInt(String(responseTime), 10)
        : Number.NaN;
      return {
        systemType: this.systemType,
        systemId: this.systemId,
        isConnected: response.status === 200,
        lastTestTime: new Date(),
        // Never surface NaN (unparseable x-response-time) into health metrics.
        latency: Number.isFinite(latency) ? latency : undefined
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
      const response = await this.pinnedRequest('GET', `${config.endpoint}/${id}`);
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
      const response = await this.pinnedRequest('POST', config.endpoint, { data: payload });
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
      const response = await this.pinnedRequest('PUT', `${config.endpoint}/${id}`, { data: payload });
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
      await this.pinnedRequest('DELETE', `${config.endpoint}/${id}`);
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
      const opts = (options ?? {}) as { limit?: number; offset?: number; filters?: Record<string, unknown> };
      const params: Record<string, unknown> = {
        limit: opts.limit ?? 100,
        offset: opts.offset ?? 0,
        ...(opts.filters ?? {})
      };

      const response = await this.pinnedRequest('GET', this.withQuery(config.endpoint, params));
      return this.extractItems(response.data, entityType);
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
      const response = await this.pinnedRequest('POST', `${config.endpoint}/search`, { data: criteria });
      return this.extractItems(response.data, entityType);
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

      const response = await this.pinnedRequest('POST', '/api/v1/webhooks', { data: subscriptionData });
      const rawId = (response.data as { id?: unknown }).id;
      // Fail closed rather than store a subscription under an empty/bogus id
      // (which would collide with any other id-less webhook and be un-removable).
      // A numeric id must be finite — NaN/Infinity would stringify to "NaN"/
      // "Infinity".
      if (typeof rawId !== 'string' && (typeof rawId !== 'number' || !Number.isFinite(rawId))) {
        throw new Error('SuiteCentral webhook response missing a usable id');
      }
      const webhookId = String(rawId);
      if (webhookId.length === 0) {
        throw new Error('SuiteCentral webhook response returned an empty id');
      }

      const subscription: WebhookSubscription = {
        id: webhookId,
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
      await this.pinnedRequest('DELETE', `/api/v1/webhooks/${webhookId}`);

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

      await this.pinnedRequest('POST', '/api/v1/bulk/import', { data: payload });

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
      const response = await this.pinnedRequest('GET', `/api/v1/bulk/operations/${operationId}`);

      const body = response.data as Record<string, unknown>;
      const operation = {
        ...body,
        createdAt: new Date(body.createdAt as string | number | Date),
        completedAt: body.completedAt ? new Date(body.completedAt as string | number | Date) : undefined
      } as SuiteCentralBulkOperation;

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

      const response = await this.pinnedRequest('GET', this.withQuery(`${config.endpoint}/changes`, params));
      return this.extractItems(response.data, entityType);
    } catch (error: unknown) {
      this.logger.error(`Failed to get changes for ${entityType}`, error);
      throw error;
    }
  }

  override async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    try {
      const response = await this.pinnedRequest('GET', '/api/v1/system/info');
      const version = (response.data as { version?: unknown }).version;

      return {
        name: 'SuiteCentral',
        type: 'SuiteCentral',
        version: typeof version === 'string' ? version : '1.0.0',
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
          // baseUrl is intentionally NOT surfaced — it is a validated internal
          // destination and must not leak through the connector's public info.
          baseUrl: '',
          authUrl: '/oauth',
          webhookUrl: '/api/v1/webhooks'
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
        endpoints: { baseUrl: '', authUrl: '', webhookUrl: '' }
      };
    }
  }

  // Private helper methods

  /**
   * The single outbound chokepoint. Applies rate limiting, injects the bearer
   * token per-request (the pinned client has no `defaults.headers`), dispatches
   * through the injected {@link PinnedHttpsClient}, and — unlike native
   * `https.request`, which resolves on any status — throws an axios-shaped error
   * (`.response.status`) on a non-2xx status so existing 404 handling keeps
   * working. Pass `throwOnError: false` to read the raw response instead.
   */
  private async pinnedRequest(
    method: PinnedRequestOptions['method'],
    path: string,
    options?: { data?: unknown; headers?: Record<string, string>; auth?: boolean; throwOnError?: boolean },
  ): Promise<PinnedResponse> {
    if (!this.pinnedClient) {
      throw new Error('suitecentral_transport_not_configured');
    }
    await this.waitForRateLimit();

    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.auth !== false) {
      // Fail closed: an auth-required call must NEVER be sent unauthenticated
      // OR with an expired token. Checking isTokenValid() at dispatch (not just
      // presence) also closes the race where the token expires during the
      // rate-limit wait above. Only the OAuth token exchange passes `auth: false`.
      if (!this.isTokenValid()) {
        throw new Error('suitecentral_not_authenticated');
      }
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    const response = await this.pinnedClient.request({ method, path, data: options?.data, headers });

    // Preserve the 401 token-reset behavior the old axios response interceptor
    // provided, without leaking a secret or upstream body into logs.
    if (response.status === 401) {
      this.isAuthenticated = false;
      this.accessToken = undefined;
      this.tokenExpiresAt = undefined;
    }

    if (options?.throwOnError !== false && (response.status < 200 || response.status >= 300)) {
      throw this.toHttpError(response);
    }
    return response;
  }

  /**
   * Wrap a non-2xx pinned response in an axios-shaped error so call sites that
   * branch on `err.response?.status` keep working. The upstream body is
   * deliberately NOT attached — only the status is surfaced.
   */
  private toHttpError(response: PinnedResponse): Error & { response: { status: number } } {
    const err = new Error(`SuiteCentral API error (status ${response.status})`) as Error & {
      response: { status: number };
    };
    err.response = { status: response.status };
    return err;
  }

  /** Append a query string to a relative path, skipping null/undefined values. */
  private withQuery(path: string, params: Record<string, unknown>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const query = search.toString();
    return query ? `${path}?${query}` : path;
  }

  /** Narrow an unknown response body to its `items` array and map to records. */
  private extractItems(body: unknown, entityType: string): DataRecord[] {
    const items = (body as { items?: unknown[] } | null | undefined)?.items;
    if (!Array.isArray(items)) {
      return [];
    }
    return items.map((item) => this.transformToDataRecord(item, entityType));
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

    // Guard a missing/non-object `fields` (e.g. a partial update with no fields):
    // an object spread of undefined/null is already a no-op, but this keeps a
    // non-object primitive from producing surprising index-keyed output.
    const fields = data.fields && typeof data.fields === 'object'
      ? (data.fields as Record<string, unknown>)
      : {};
    return {
      ...fields,
      lastModified: new Date().toISOString()
    };
  }
}

export default SuiteCentralConnectorProd;
