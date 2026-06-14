/**
 * HubSpot CRM Connector
 *
 * REST API integration for HubSpot CRM with contacts, companies, deals, and tickets.
 * Created: January 8, 2026 (Phase 3 - SuiteCentral Parity)
 * Updated: February 7, 2026 (Phase 8 - Demo code extracted to DemoConnectorDecorator)
 */

import { BaseConnector } from '../core/BaseConnector';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { AuthConfig, DataRecord, SystemInfo } from '../types';
import type { Logger } from '../utils/Logger';
import { mapCommonFields } from '../utils/connectorHelpers';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';

// HubSpot API Types
export interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    company?: string;
    jobtitle?: string;
    lifecyclestage?: string;
    hs_lead_status?: string;
    createdate?: string;
    lastmodifieddate?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubSpotCompany {
  id: string;
  properties: {
    name?: string;
    domain?: string;
    industry?: string;
    phone?: string;
    city?: string;
    state?: string;
    country?: string;
    numberofemployees?: string;
    annualrevenue?: string;
    createdate?: string;
    hs_lastmodifieddate?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubSpotDeal {
  id: string;
  properties: {
    dealname?: string;
    amount?: string;
    dealstage?: string;
    pipeline?: string;
    closedate?: string;
    createdate?: string;
    hs_lastmodifieddate?: string;
    hubspot_owner_id?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubSpotTicket {
  id: string;
  properties: {
    subject?: string;
    content?: string;
    hs_pipeline?: string;
    hs_pipeline_stage?: string;
    hs_ticket_priority?: string;
    createdate?: string;
    hs_lastmodifieddate?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubSpotListResponse<T> {
  results: T[];
  paging?: {
    next?: {
      after: string;
      link: string;
    };
  };
}

export interface HubSpotSearchResponse<T> {
  total: number;
  results: T[];
  paging?: {
    next?: {
      after: string;
    };
  };
}

/**
 * HubSpot CRM Connector
 * Implements HubSpot API v3 integration for CRM operations
 */
export class HubSpotConnector extends BaseConnector implements IConnector {
  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'Real HubSpot CRM REST API v3 calls (contacts, companies, deals, tickets) with bearer-token auth';
  static readonly proofCard = 'docs/review/proof-cards/hubspot-connector.md';

  private readonly apiVersion = 'v3';
  private readonly outboundGovernance: OutboundGovernanceService;

  constructor(logger: Logger, outboundGovernance: OutboundGovernanceService) {
    super('HubSpot', 'hubspot-crm', logger);
    if (!outboundGovernance) {
      throw new Error('OutboundGovernanceService is required for production connector outbound protection');
    }
    this.outboundGovernance = outboundGovernance;
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    // Set base URL for HubSpot API
    const baseUrl = `https://api.hubapi.com/crm/${this.apiVersion}`;
    this.httpClient.defaults.baseURL = baseUrl;

    this.logger.info('HubSpot connector initialized', {
      apiVersion: this.apiVersion,
      baseUrl,
    });
  }

  async authenticate(): Promise<boolean> {
    try {
      const credentials = this.authConfig.credentials as { accessToken?: string; apiKey?: string };

      if (credentials.accessToken) {
        this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        // HubSpot API key authentication (deprecated but still supported for some endpoints)
        this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${credentials.apiKey}`;
      } else {
        throw new Error('No access token or API key provided');
      }

      this.httpClient.defaults.headers.common['Content-Type'] = 'application/json';

      // Verify authentication by making a test request
      await this.makeRequest({
        method: 'GET',
        url: '/objects/contacts',
        params: { limit: 1 },
      });

      this.isAuthenticated = true;
      this.logger.info('HubSpot authentication successful');
      return true;
    } catch (error: unknown) {
      this.logger.error('HubSpot authentication failed', error);
      this.isAuthenticated = false;
      throw error;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    await this.ensureAuthenticated();

    return {
      name: 'HubSpot CRM',
      type: 'HubSpot',
      version: this.apiVersion,
      capabilities: [
        'contacts',
        'companies',
        'deals',
        'tickets',
        'engagements',
        'line_items',
        'products',
        'quotes',
        'workflows',
        'forms',
        'marketing_emails',
      ],
      rateLimits: {
        requestsPerMinute: 100,
        requestsPerHour: 10000,
        requestsPerDay: 250000,
      },
      endpoints: {
        baseUrl: `https://api.hubapi.com/crm/${this.apiVersion}`,
        authUrl: 'https://app.hubspot.com/oauth/authorize',
        webhookUrl: 'https://api.hubapi.com/webhooks/v3',
      },
    };
  }

  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    await this.ensureAuthenticated();

    const objectType = this.getObjectType(entityType);
    const rawPayload = {
      properties: this.formatPropertiesForHubSpot(data),
    };
    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'create', entityType, rawPayload);

    try {
      const response = await this.makeRequest<HubSpotContact | HubSpotCompany | HubSpotDeal | HubSpotTicket>({
        method: 'POST',
        url: `/objects/${objectType}`,
        data: payload,
      });

      return this.formatDataFromHubSpot(response, entityType);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create ${entityType}: ${message}`, { cause: error });
    }
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    await this.ensureAuthenticated();

    const objectType = this.getObjectType(entityType);

    try {
      const response = await this.makeRequest<HubSpotContact | HubSpotCompany | HubSpotDeal | HubSpotTicket>({
        method: 'GET',
        url: `/objects/${objectType}/${id}`,
      });

      return this.formatDataFromHubSpot(response, entityType);
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

    const objectType = this.getObjectType(entityType);
    const rawPayload = {
      properties: this.formatPropertiesForHubSpot(data),
    };
    const payload = await this.validateOutboundWrite(this.outboundGovernance, 'update', entityType, rawPayload, { resourceId: id });

    try {
      const response = await this.makeRequest<HubSpotContact | HubSpotCompany | HubSpotDeal | HubSpotTicket>({
        method: 'PATCH',
        url: `/objects/${objectType}/${id}`,
        data: payload,
      });

      return this.formatDataFromHubSpot(response, entityType);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    await this.ensureAuthenticated();

    const objectType = this.getObjectType(entityType);
    await this.validateOutboundWrite(this.outboundGovernance, 'delete', entityType, { id }, { resourceId: id });

    try {
      await this.makeRequest({
        method: 'DELETE',
        url: `/objects/${objectType}/${id}`,
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete ${entityType} ${id}: ${message}`, { cause: error });
    }
  }

  async list(entityType: string, options: ListOptions = {}): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const objectType = this.getObjectType(entityType);

    try {
      const params: Record<string, unknown> = {};
      if (options.limit) {
        params.limit = options.limit;
      }
      if (options.offset) {
        params.after = options.offset.toString();
      }

      const response = await this.makeRequest<HubSpotListResponse<HubSpotContact | HubSpotCompany | HubSpotDeal | HubSpotTicket>>({
        method: 'GET',
        url: `/objects/${objectType}`,
        params,
      });

      return response.results.map(record => this.formatDataFromHubSpot(record, entityType));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list ${entityType}: ${message}`, { cause: error });
    }
  }

  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    const objectType = this.getObjectType(entityType);
    const filterGroups = this.buildFilterGroups(criteria.filters, criteria.operator);

    try {
      const payload: Record<string, unknown> = {
        filterGroups,
        limit: criteria.limit || 100,
      };

      if (criteria.offset) {
        payload.after = criteria.offset;
      }

      const response = await this.makeRequest<HubSpotSearchResponse<HubSpotContact | HubSpotCompany | HubSpotDeal | HubSpotTicket>>({
        method: 'POST',
        url: `/objects/${objectType}/search`,
        data: payload,
      });

      return response.results.map(record => this.formatDataFromHubSpot(record, entityType));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search ${entityType}: ${message}`, { cause: error });
    }
  }

  async setupWebhook(webhookUrl: string, _events: string[]): Promise<string> {
    await this.ensureAuthenticated();

    // HubSpot webhook subscription
    try {
      // Use absolute URL - webhooks endpoint is not under /crm/v3 base path
      const response = await this.makeRequest<{ id: string }>({
        method: 'POST',
        url: 'https://api.hubapi.com/webhooks/v3/settings',
        data: {
          targetUrl: webhookUrl,
          throttling: {
            period: 'SECONDLY',
            maxConcurrentRequests: 10,
          },
        },
      });

      return response.id;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to setup webhook: ${message}`, { cause: error });
    }
  }

  async removeWebhook(webhookId: string): Promise<boolean> {
    await this.ensureAuthenticated();

    try {
      // Use absolute URL - webhooks endpoint is not under /crm/v3 base path
      await this.makeRequest({
        method: 'DELETE',
        url: `https://api.hubapi.com/webhooks/v3/${webhookId}`,
      });

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to remove webhook: ${message}`, { cause: error });
    }
  }

  async getChanges(entityType: string, since: Date): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    // Use search with lastmodifieddate filter
    return this.search(entityType, {
      filters: {
        lastmodifieddate: {
          operator: 'greater_than',
          value: since.getTime(),
        },
      },
      limit: 1000,
    });
  }

  /**
   * Get pipeline stages for deals or tickets
   */
  async getPipelineStages(pipelineType: 'deals' | 'tickets'): Promise<DataRecord[]> {
    await this.ensureAuthenticated();

    try {
      // Base URL already includes /crm/v3, so just use /pipelines/
      const response = await this.makeRequest<{ results: { stages: { id: string; label: string; displayOrder: number }[] }[] }>({
        method: 'GET',
        url: `/pipelines/${pipelineType}`,
      });

      const stages: DataRecord[] = [];
      for (const pipeline of response.results) {
        for (const stage of pipeline.stages) {
          stages.push({
            id: stage.id,
            fields: {
              label: stage.label,
              displayOrder: stage.displayOrder,
            },
          });
        }
      }

      return stages;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get pipeline stages: ${message}`, { cause: error });
    }
  }

  private getObjectType(entityType: string): string {
    const entityMapping: Record<string, string> = {
      'contact': 'contacts',
      'contacts': 'contacts',
      'company': 'companies',
      'companies': 'companies',
      'deal': 'deals',
      'deals': 'deals',
      'ticket': 'tickets',
      'tickets': 'tickets',
      'engagement': 'engagements',
      'engagements': 'engagements',
    };

    return entityMapping[entityType.toLowerCase()] || entityType;
  }

  private buildFilterGroups(
    filters: Record<string, unknown>,
    operator: 'AND' | 'OR' = 'AND',
  ): { filters: { propertyName: string; operator: string; value: unknown }[] }[] {
    const filterArray = Object.entries(filters).map(([propertyName, value]) => {
      if (value && typeof value === 'object' && 'operator' in (value as Record<string, unknown>)) {
        const filterValue = value as { operator: string; value: unknown };
        return {
          propertyName,
          operator: this.mapOperator(filterValue.operator),
          value: filterValue.value,
        };
      }

      return {
        propertyName,
        operator: 'EQ',
        value,
      };
    });

    if (operator === 'OR') {
      // For OR, each filter gets its own filter group
      return filterArray.map(filter => ({ filters: [filter] }));
    }

    // For AND, all filters are in the same group
    return [{ filters: filterArray }];
  }

  private mapOperator(operator: string): string {
    const operatorMap: Record<string, string> = {
      'equals': 'EQ',
      'not_equals': 'NEQ',
      'greater_than': 'GT',
      'less_than': 'LT',
      'greater_than_or_equal': 'GTE',
      'less_than_or_equal': 'LTE',
      'contains': 'CONTAINS_TOKEN',
      'not_contains': 'NOT_CONTAINS_TOKEN',
    };

    return operatorMap[operator] || 'EQ';
  }

  private formatPropertiesForHubSpot(data: Partial<DataRecord>): Record<string, unknown> {
    const fields = (data.fields as Record<string, unknown>) ?? {};
    const properties: Record<string, unknown> = {};

    // Map common fields to HubSpot property names
    const fieldMap: Record<string, string> = {
      firstName: 'firstname',
      lastName: 'lastname',
      email: 'email',
      phone: 'phone',
      company: 'company',
      name: 'name',
      domain: 'domain',
      industry: 'industry',
    };

    const mapped = mapCommonFields(fields, fieldMap);

    // Copy all properties
    Object.assign(properties, fields, mapped);

    // Remove null and undefined values
    Object.keys(properties).forEach(key => {
      if (properties[key] === null || properties[key] === undefined) {
        delete properties[key];
      }
    });

    return properties;
  }

  private formatDataFromHubSpot(
    hubspotData: HubSpotContact | HubSpotCompany | HubSpotDeal | HubSpotTicket,
    _entityType: string,
  ): DataRecord {
    const properties = hubspotData.properties || {};
    const fields: Record<string, unknown> = { ...properties };

    // Remove system fields from fields object
    delete fields.createdate;
    delete fields.lastmodifieddate;
    delete fields.hs_lastmodifieddate;

    return {
      id: hubspotData.id,
      externalId: hubspotData.id,
      fields,
      metadata: {
        source: 'HubSpot',
        lastModified: new Date(hubspotData.updatedAt),
        archived: hubspotData.archived,
      },
    };
  }
}
