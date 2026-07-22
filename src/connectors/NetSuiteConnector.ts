import { BaseConnector } from '../core/BaseConnector';
import { NotFoundAppError } from '../errors/AppError';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo, OAuth1Credentials } from '../types';
import type { AuthService } from '../services/AuthService';
import type { NetSuiteRecord, NetSuiteListResponse } from '../types/api-responses';
import { mapCommonFields, mapFromCommonFields } from '../utils/connectorHelpers';
import type { Logger } from '../utils/Logger';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import crypto from 'crypto';
import { getOAuth1AuthorizationHeader } from '../utils/oauth1Helper';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';

@injectable()
export class NetSuiteConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'OAuth1 HMAC-SHA256 signing via src/utils/oauth1Helper.ts; tested against sandbox TSTDRV2698307';
  static readonly proofCard = 'docs/review/proof-cards/netsuite-connector.md';

  private accountId!: string;
  private consumerKey!: string;
  private consumerSecret!: string;
  private tokenId!: string;
  private tokenSecret!: string;
  private baseUrl!: string;
  private readonly authService: AuthService;
  private readonly outboundGovernance: OutboundGovernanceService;
  private readonly recordServiceBasePath = '/services/rest/record/v1';
  private readonly searchServiceBasePath = '/services/rest/search/v1';
  private readonly platformServiceBasePath = '/services/rest/platform/v1';

  constructor(
    systemId: string,
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuthService) _authService: AuthService,
    outboundGovernance: OutboundGovernanceService,
  ) {
    super('NetSuite', systemId, logger);
    this.authService = _authService;
    if (!outboundGovernance) {
      throw new Error('OutboundGovernanceService is required for production connector outbound protection');
    }
    this.outboundGovernance = outboundGovernance;
  }

  private buildServiceUrl(service: 'record' | 'search' | 'platform', path = '', query?: URLSearchParams): string {
    const basePath = (() => {
      switch (service) {
        case 'record':
          return this.recordServiceBasePath;
        case 'search':
          return this.searchServiceBasePath;
        default:
          return this.platformServiceBasePath;
      }
    })();

    const normalizedSegments = path
      .split('/')
      .map(segment => segment.trim())
      .filter(segment => segment.length > 0);

    const joinedPath = normalizedSegments.length > 0 ? `${basePath}/${normalizedSegments.join('/')}` : basePath;
    const queryString = query?.toString() ?? '';

    return queryString.length > 0 ? `${joinedPath}?${queryString}` : joinedPath;
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    if (config.type !== 'oauth1') {
      throw new Error('NetSuite connector requires OAuth1 authentication');
    }

    const credentials = config.credentials as OAuth1Credentials;
    this.accountId = credentials.accountId;
    this.consumerKey = credentials.consumerKey;
    this.consumerSecret = credentials.consumerSecret;
    this.tokenId = credentials.tokenId;
    this.tokenSecret = credentials.tokenSecret;
    // NetSuite's DNS convention for the derived API host lowercases the
    // account ID and swaps underscores for hyphens (sandbox accounts look
    // like "1234567_SB1" -> "1234567-sb1"). This normalization applies ONLY
    // to the derived hostname — this.accountId itself must stay in its
    // original form because it also doubles as the OAuth1 realm (see
    // getAuthHeaders() below), which NetSuite requires unmodified.
    const dnsNormalizedAccountId = this.accountId.toLowerCase().replace(/_/g, '-');
    this.baseUrl =
      credentials.base_url ||
      credentials.baseUrl ||
      `https://${dnsNormalizedAccountId}.suitetalk.api.netsuite.com`;

    this.httpClient.defaults.baseURL = this.baseUrl;
    this.logger.info('NetSuite connector initialized');
  }

  async authenticate(): Promise<boolean> {
    try {
      const credentials = {
        type: 'token' as const,
        credentials: {
          accountId: this.accountId,
          consumerKey: this.consumerKey,
          consumerSecret: this.consumerSecret,
          tokenId: this.tokenId,
          tokenSecret: this.tokenSecret,
        },
      };

      const tokenInfo = await this.authService.authenticateOAuth1(credentials);

      if (!tokenInfo?.tokenId || !tokenInfo?.tokenSecret) {
        throw new Error('Failed to obtain NetSuite OAuth1 tokens');
      }

      // Update credentials in case they were rotated
      this.accountId = tokenInfo.accountId;
      this.consumerKey = tokenInfo.consumerKey;
      this.consumerSecret = tokenInfo.consumerSecret;
      this.tokenId = tokenInfo.tokenId;
      this.tokenSecret = tokenInfo.tokenSecret;

      this.isAuthenticated = true;
      this.logger.info('NetSuite authentication successful');
      return true;
    } catch (error: unknown) {
      this.logger.error('NetSuite authentication failed', error);
      this.isAuthenticated = false;
      throw error;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    try {
      // Get account info to verify connection
      const probeParams = new URLSearchParams();
      probeParams.set('limit', '1');
      const probeUrl = this.buildServiceUrl('record', 'customer', probeParams);

      await this.makeRequest({
        method: 'GET',
        url: probeUrl,
        headers: this.getAuthHeaders('GET', probeUrl),
      });

      return {
        name: 'NetSuite',
        type: 'NetSuite',
        version: '2023.2',
        capabilities: [
          'customers',
          'vendors',
          'items',
          'transactions',
          'employees',
          'contacts',
          'custom_records',
          'real_time_sync',
          'bulk_operations',
          'webhooks',
        ],
        rateLimits: {
          requestsPerMinute: 100,
          requestsPerHour: 5000,
          requestsPerDay: 100000,
        },
        endpoints: {
          baseUrl: this.baseUrl,
          authUrl: `${this.baseUrl}/services/rest/auth`,
          webhookUrl: `${this.baseUrl}/services/rest/platform/v1/webhooks`,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get NetSuite system info: ${message}`, { cause: error });
    }
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();

    const url = this.buildServiceUrl('record', entityType);
    const rawPayload = this.formatDataForNetSuite(data);
    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'create', entityType, rawPayload);

    try {
      const response = await this.makeRequest<NetSuiteRecord>({
        method: 'POST',
        url,
        data: payload,
        headers: this.getAuthHeaders('POST', url, JSON.stringify(payload)),
      });

      return this.formatDataFromNetSuite(response, entityType);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create ${entityType}: ${message}`, { cause: error });
    }
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    await this.ensureAuthenticated();

    const url = this.buildServiceUrl('record', `${entityType}/${id}`);

    try {
      const response = await this.makeRequest({
        method: 'GET',
        url,
        headers: this.getAuthHeaders('GET', url),
      });

      return this.formatDataFromNetSuite(response, entityType);
    } catch (error: unknown) {
      // BaseConnector.handleApiError wraps HTTP 404 as NotFoundAppError
      // (message "Resource not found: <statusText>"), so the legacy
      // string-includes('404') guard never matches on the live wire path.
      // Recognize NotFoundAppError first; keep the legacy string match as
      // a defensive fallback for any caller still throwing plain Errors.
      if (error instanceof NotFoundAppError) {
        return null;
      }
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    await this.ensureAuthenticated();

    const url = this.buildServiceUrl('record', `${entityType}/${id}`);
    const rawPayload = this.formatDataForNetSuite(data);
    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'update', entityType, rawPayload, { resourceId: id });

    try {
      const response = await this.makeRequest({
        method: 'PATCH',
        url,
        data: payload,
        headers: this.getAuthHeaders('PATCH', url, JSON.stringify(payload)),
      });

      return this.formatDataFromNetSuite(response, entityType);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    await this.ensureAuthenticated();

    const url = this.buildServiceUrl('record', `${entityType}/${id}`);
    await this.validateOutboundWrite(this.outboundGovernance, 'delete', entityType, { id }, { resourceId: id });

    try {
      await this.makeRequest({
        method: 'DELETE',
        url,
        headers: this.getAuthHeaders('DELETE', url),
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async list(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.offset) params.append('offset', options.offset.toString());
    if (options.fields) params.append('fields', options.fields.join(','));

    const url = this.buildServiceUrl('record', entityType, params);

    try {
      const response = await this.makeRequest<NetSuiteListResponse>({
        method: 'GET',
        url,
        headers: this.getAuthHeaders('GET', url),
      });

      if (Array.isArray(response.items)) {
        return response.items.map((item: NetSuiteRecord) => this.formatDataFromNetSuite(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list ${entityType}: ${message}`, { cause: error });
    }
  }

  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const searchPayload = {
      criteria: criteria.filters,
      operator: criteria.operator || 'AND',
      limit: criteria.limit || 100,
      offset: criteria.offset || 0,
    };

    const url = this.buildServiceUrl('record', `${entityType}/_search`);

    try {
      const response = await this.makeRequest<NetSuiteListResponse>({
        method: 'POST',
        url,
        data: searchPayload,
        headers: this.getAuthHeaders('POST', url, JSON.stringify(searchPayload)),
      });

      if (Array.isArray(response.items)) {
        return response.items.map((item: NetSuiteRecord) => this.formatDataFromNetSuite(item, entityType));
      }

      return [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search ${entityType}: ${message}`, { cause: error });
    }
  }

  async setupWebhook(webhookUrl: string, events: string[]): Promise<string> {
    await this.ensureAuthenticated();

    const payload = {
      name: `IntegrationHub_${Date.now()}`,
      url: webhookUrl,
      events,
      isActive: true,
    };

    const url = this.buildServiceUrl('platform', 'webhooks');

    try {
      const response = await this.makeRequest<{ id: string }>({
        method: 'POST',
        url,
        data: payload,
        headers: this.getAuthHeaders('POST', url, JSON.stringify(payload)),
      });

      return response.id;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to setup webhook: ${message}`, { cause: error });
    }
  }

  async removeWebhook(webhookId: string): Promise<boolean> {
    await this.ensureAuthenticated();

    const url = this.buildServiceUrl('platform', `webhooks/${webhookId}`);

    try {
      await this.makeRequest({
        method: 'DELETE',
        url,
        headers: this.getAuthHeaders('DELETE', url),
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to remove webhook: ${message}`, { cause: error });
    }
  }

  async getChanges(entityType: string, since: Date): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const searchCriteria = {
      filters: {
        lastModified: {
          operator: 'after',
          value: since.toISOString(),
        },
      },
      limit: 1000,
    };

    return this.search(entityType, searchCriteria);
  }

  private getAuthHeaders(method: string, url: string, body?: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;

    const authHeader = getOAuth1AuthorizationHeader(
      method,
      fullUrl,
      {
        consumerKey: this.consumerKey,
        consumerSecret: this.consumerSecret,
        tokenId: this.tokenId,
        tokenSecret: this.tokenSecret,
        nonce,
        timestamp,
        realm: this.accountId,
      },
      body,
    );

    return {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  private formatDataForNetSuite(data: Partial<DataRecord>): Record<string, unknown> {
    const fieldMap = { name: 'companyname', email: 'email', phone: 'phone' };
    return mapCommonFields((data.fields ?? {}) as Record<string, unknown>, fieldMap);
  }

  /**
   * Formats data from NetSuite's format to the standard DataRecord format.
   * @param {NetSuiteRecord | unknown} netsuiteData - The data received from NetSuite.
   * @param {string} _entityType - The entity type (unused in this implementation but part of interface).
   * @returns {DataRecord} The formatted standard data record.
   * @private
   */
  private formatDataFromNetSuite(netsuiteData: NetSuiteRecord | unknown, _entityType: string): DataRecord {
    // Convert NetSuite format to our standard format
    const fields: Record<string, unknown> = {};

    // Type guard to ensure we have an object with potential NetSuite properties
    const isNetSuiteObject = (obj: unknown): obj is Record<string, unknown> & {
      internalid?: string | number;
      externalid?: string;
      lastmodifieddate?: string;
      version?: string | number;
    } => typeof obj === 'object' && obj !== null;

    if (!isNetSuiteObject(netsuiteData)) {
      throw new Error('Invalid data format from NetSuite');
    }

    const fieldMap = { name: 'companyname', email: 'email', phone: 'phone' };
    Object.assign(fields, mapFromCommonFields(netsuiteData, fieldMap));
    delete fields.internalid;

    return {
      id: netsuiteData.internalid?.toString() ?? '',
      externalId: netsuiteData.externalid ?? '',
      fields,
      metadata: {
        source: 'NetSuite',
        lastModified: netsuiteData.lastmodifieddate ? new Date(netsuiteData.lastmodifieddate) : new Date(),
        version: netsuiteData.version?.toString() ?? '1.0',
      },
    };
  }
}
