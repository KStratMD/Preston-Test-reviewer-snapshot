/**
 * Schema Discovery Service - Phase 5 AI Accuracy Improvements
 * Discovers and caches target system schemas via API queries
 *
 * Purpose:
 * - Query NetSuite, Salesforce, and Business Central APIs for schema metadata
 * - Cache schemas to minimize API calls and improve performance
 * - Provide unified interface for schema discovery across systems
 * - Enable real-time validation of AI suggestions
 *
 * Phase 2 MCP Integration:
 * - Optional NetSuite MCP adapter for schema discovery
 * - Feature flag controlled (ENABLE_NETSUITE_MCP_SCHEMA)
 * - Fallback to existing implementation if MCP unavailable
 */

import { logger } from '../../../utils/Logger';
import type {
  SystemSchema,
  SchemaField,
  SchemaRelationship,
  SchemaCacheEntry,
  SystemType,
  EntityType
} from './types';
import { isNetSuiteMCPSchemaEnabled } from '../../../config/runtimeFlags';
import type { NetSuiteMCPSchemaAdapter } from '../../netsuite/mcp/NetSuiteMCPSchemaAdapter';

// Module-scope structural interfaces for opaque connector-metadata payloads.
// These reflect the property shape we actually walk in this file; they are
// intentionally narrow (no exhaustive coverage of NetSuite/Salesforce APIs).

interface NetSuiteFieldMeta {
  name?: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  format?: string;
  allowedValues?: string[];
  label?: string;
}

interface NetSuiteMetadataShape {
  fields?: unknown[];
  version?: string;
}

interface SalesforcePicklistValue {
  value?: string;
}

interface SalesforceFieldMeta {
  name?: string;
  type?: string;
  nillable?: boolean;
  defaultedOnCreate?: boolean;
  length?: number;
  picklistValues?: SalesforcePicklistValue[];
  label?: string;
}

interface SalesforceChildRelationship {
  field?: string;
  childSObject?: string;
  relationshipName?: string;
}

interface SalesforceDescribeShape {
  fields?: unknown[];
  childRelationships?: unknown[];
}

/**
 * Live-Salesforce-relationship-discovery configuration, closed over the
 * CARDINALITY_SALESFORCE_RELATIONSHIP_MODE env contract (B3.5). Deliberately
 * separate from `enableSalesforce` above, which gates the UNRELATED
 * suggestion-time getSchema()/getSalesforceSchema() mock-vs-real behavior —
 * this member alone controls discoverSalesforceRelationshipSchema() (the
 * RelationshipEvidenceProvider path). The discriminated union makes an
 * incomplete live configuration unrepresentable: `{ mode: 'live' }` without
 * both credentials is a compile error, not a runtime check.
 */
export type SalesforceRelationshipDiscoveryConfig =
  | { mode: 'disabled' }
  | { mode: 'live'; instanceUrl: string; accessToken: string };

export interface SchemaDiscoveryConfig {
  cacheEnabled?: boolean; // Default: true
  cacheTTL?: number; // Cache time-to-live in ms (default: 1 hour)
  enableNetSuite?: boolean; // Default: false (requires API credentials)
  enableSalesforce?: boolean; // Default: false (requires API credentials)
  enableBusinessCentral?: boolean; // Default: false (requires API credentials)
  mcpSchemaAdapter?: NetSuiteMCPSchemaAdapter; // Optional MCP adapter (Phase 2)
  salesforceRelationshipDiscovery?: SalesforceRelationshipDiscoveryConfig; // Default: { mode: 'disabled' }
}

export class SchemaDiscoveryService {
  private schemaCache = new Map<string, SchemaCacheEntry>();
  private logger = logger;
  private config: Required<Omit<SchemaDiscoveryConfig, 'mcpSchemaAdapter'>> & {
    mcpSchemaAdapter?: NetSuiteMCPSchemaAdapter;
  };

  constructor(config: SchemaDiscoveryConfig = {}) {
    this.config = {
      cacheEnabled: config.cacheEnabled ?? true,
      cacheTTL: config.cacheTTL ?? 3600000, // 1 hour default
      enableNetSuite: config.enableNetSuite ?? false,
      enableSalesforce: config.enableSalesforce ?? false,
      enableBusinessCentral: config.enableBusinessCentral ?? false,
      mcpSchemaAdapter: config.mcpSchemaAdapter, // Optional MCP adapter
      salesforceRelationshipDiscovery: config.salesforceRelationshipDiscovery ?? { mode: 'disabled' }
    };
  }

  /**
   * Get schema for a specific system and entity
   */
  async getSchema(system: SystemType, entity: EntityType): Promise<SystemSchema> {
    const cacheKey = `${system}:${entity}`;

    // Check cache first
    if (this.config.cacheEnabled) {
      const cached = this.getCachedSchema(cacheKey);
      if (cached) {
        this.logger.info('Schema retrieved from cache', {
          system,
          entity,
          age: Date.now() - cached.timestamp.getTime()
        });
        return cached.schema;
      }
    }

    // Fetch from API
    let schema: SystemSchema;
    switch (system) {
      case 'NetSuite':
        schema = await this.getNetSuiteSchema(entity);
        break;
      case 'Salesforce':
        schema = await this.getSalesforceSchema(entity);
        break;
      case 'BusinessCentral':
        schema = await this.getBusinessCentralSchema(entity);
        break;
      default:
        throw new Error(`Unsupported system: ${system}`);
    }

    // Cache the result
    if (this.config.cacheEnabled) {
      this.cacheSchema(cacheKey, schema);
    }

    return schema;
  }

  /**
   * Get NetSuite schema via SuiteTalk REST API or MCP (Phase 2)
   *
   * Strategy:
   * 1. If MCP adapter available and feature flag enabled → use MCP
   * 2. If enableNetSuite config true → use REST API
   * 3. Otherwise → use mock schema
   */
  private async getNetSuiteSchema(entity: EntityType): Promise<SystemSchema> {
    // Phase 2: Try MCP adapter first (if available and enabled)
    if (this.config.mcpSchemaAdapter && isNetSuiteMCPSchemaEnabled()) {
      try {
        this.logger.info('Fetching NetSuite schema via MCP', { entity });
        const schema = await this.config.mcpSchemaAdapter.getSchema(
          this.mapEntityToNetSuiteType(entity)
        );

        this.logger.info('NetSuite schema fetched via MCP', {
          entity,
          fieldCount: schema.fields.length,
          source: schema.metadata?.source
        });

        return schema;

      } catch (error) {
        this.logger.warn('MCP schema fetch failed, falling back to REST/mock', {
          entity,
          error: error instanceof Error ? error.message : String(error)
        });
        // Fall through to REST API or mock
      }
    }

    // Existing REST API implementation
    if (!this.config.enableNetSuite) {
      return this.getMockNetSuiteSchema(entity);
    }

    try {
      const accountId = process.env.NETSUITE_ACCOUNT_ID;
      const accessToken = process.env.NETSUITE_ACCESS_TOKEN;
      if (!accountId || !accessToken) {
        this.logger.debug('NetSuite account ID or access token not configured, using mock schema', {
          entity,
          hasAccountId: !!accountId,
          hasAccessToken: !!accessToken
        });
        return this.getMockNetSuiteSchema(entity);
      }
      // DNS-normalize (lowercase, underscores -> hyphens) so sandbox account
      // IDs like "1234567_SB1" resolve to NetSuite's actual host convention
      // "1234567-sb1.suitetalk.api.netsuite.com".
      const dnsNormalizedAccountId = accountId.toLowerCase().replace(/_/g, '-');
      const baseURL = `https://${dnsNormalizedAccountId}.suitetalk.api.netsuite.com/services/rest/record/v1`;

      // Map entity to NetSuite record type
      const recordType = this.mapEntityToNetSuiteType(entity);

      const response = await fetch(`${baseURL}/metadata-catalog/${recordType}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'prefer': 'respond-async'
        }
      });

      if (!response.ok) {
        throw new Error(`NetSuite API error: ${response.status} ${response.statusText}`);
      }

      const metadata = await response.json();
      return this.parseNetSuiteMetadata(metadata, entity);

    } catch (error) {
      this.logger.warn('Failed to fetch NetSuite schema, using mock', {
        entity,
        error: error instanceof Error ? error.message : String(error)
      });
      return this.getMockNetSuiteSchema(entity);
    }
  }

  /**
   * Get Salesforce schema via REST API (Describe)
   */
  private async getSalesforceSchema(entity: EntityType): Promise<SystemSchema> {
    if (!this.config.enableSalesforce) {
      return this.getMockSalesforceSchema(entity);
    }

    try {
      const instanceURL = process.env.SALESFORCE_INSTANCE_URL;
      const sobject = this.mapEntityToSalesforceType(entity);

      const response = await fetch(
        `${instanceURL}/services/data/v58.0/sobjects/${sobject}/describe`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${process.env.SALESFORCE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Salesforce API error: ${response.status} ${response.statusText}`);
      }

      const describe = await response.json();
      return this.parseSalesforceDescribe(describe, entity);

    } catch (error) {
      this.logger.warn('Failed to fetch Salesforce schema, using mock', {
        entity,
        error: error.message
      });
      return this.getMockSalesforceSchema(entity);
    }
  }

  /**
   * Get Business Central schema via OData $metadata
   */
  private async getBusinessCentralSchema(entity: EntityType): Promise<SystemSchema> {
    if (!this.config.enableBusinessCentral) {
      return this.getMockBusinessCentralSchema(entity);
    }

    try {
      const baseURL = process.env.BC_BASE_URL;

      const response = await fetch(`${baseURL}/api/v2.0/$metadata`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.BC_ACCESS_TOKEN}`,
          'Accept': 'application/xml'
        }
      });

      if (!response.ok) {
        throw new Error(`Business Central API error: ${response.status} ${response.statusText}`);
      }

      const metadataXML = await response.text();
      return this.parseODataMetadata(metadataXML, entity);

    } catch (error) {
      this.logger.warn('Failed to fetch Business Central schema, using mock', {
        entity,
        error: error.message
      });
      return this.getMockBusinessCentralSchema(entity);
    }
  }

  /**
   * Parse NetSuite metadata response
   */
  private parseNetSuiteMetadata(metadata: unknown, entity: EntityType): SystemSchema {
    const m = metadata as NetSuiteMetadataShape;
    const fields: SchemaField[] = (m.fields || []).flatMap((f: unknown) => {
      const fm = f as NetSuiteFieldMeta;
      const fieldName = typeof fm.name === 'string' ? fm.name.trim() : '';
      if (!fieldName) {
        this.logger.warn('Skipping NetSuite schema field with missing name', {
          entity,
          fieldType: fm.type,
          fieldLabel: fm.label
        });
        return [];
      }
      return [{
        name: fieldName,
        type: this.mapNetSuiteTypeToStandard(fm.type ?? ''),
        required: fm.required || false,
        maxLength: fm.maxLength,
        format: fm.format,
        allowedValues: fm.allowedValues,
        description: fm.label || fieldName,
        nullable: !fm.required
      }];
    });

    return {
      system: 'NetSuite',
      entity,
      fields,
      relationships: [],
      metadata: {
        version: m.version,
        lastUpdated: new Date(),
        source: 'api'
      }
    };
  }

  /**
   * Fetches a live Salesforce Describe schema for relationship-evidence
   * normalization (RelationshipEvidenceProvider). Unlike getSchema() /
   * getSalesforceSchema() above — which intentionally degrade to a mock
   * schema on any failure for suggestion-time callers — this method
   * distinguishes "discovery not configured" (returns null; the caller
   * treats that as an unavailable manual schema) from "discovery attempted
   * and the transport failed" (throws, so the caller can surface a
   * transient/503 condition instead of a trustworthy "unavailable" evidence
   * result). See docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
   * "Error contract".
   *
   * Every thrown error carries a FIXED message — never `response.statusText`
   * (remote-controlled text), a caught transport exception's own `.message`
   * (may embed hostnames/IPs from the network stack), the response body, or
   * the entity/payload. This is the actual discovery boundary: callers up
   * the chain (RelationshipEvidenceProvider, CardinalityPreflightService)
   * treat whatever this throws as opaque and propagate its `.message`
   * unchanged into logs (`getAdvisoryEvidence`) and `AppError.toJSON()`'s
   * `cause` field (which reaches API responses) — so sanitizing HERE is what
   * keeps every downstream surface safe, without each of them re-implementing
   * the same redaction.
   */
  async discoverSalesforceRelationshipSchema(entity: EntityType): Promise<SystemSchema | null> {
    const discoveryConfig = this.config.salesforceRelationshipDiscovery;
    if (discoveryConfig.mode === 'disabled') {
      return null;
    }

    const sobject = this.mapEntityToSalesforceType(entity);

    let response: Response;
    try {
      response = await fetch(
        `${discoveryConfig.instanceUrl}/services/data/v58.0/sobjects/${sobject}/describe`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${discoveryConfig.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      this.logger.warn('Salesforce relationship discovery transport failed', { entity });
      // Intentional: attaching `cause` would put the raw transport error (can embed
      // host/URL) on `error.cause.message`, reachable via default Node error printing,
      // undoing the B3.5 sanitization boundary.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Salesforce relationship discovery failed: transport error');
    }

    if (!response.ok) {
      this.logger.warn('Salesforce relationship discovery received a non-OK response', {
        entity,
        status: response.status
      });
      throw new Error(`Salesforce relationship discovery failed with status ${response.status}`);
    }

    // One boundary for both JSON-syntax failures (response.json() throws) and
    // malformed-SHAPE failures (valid JSON, but `fields`/`childRelationships`
    // are not arrays, so parseSalesforceDescribe's .flatMap throws) — both are
    // "the remote response could not be trusted", and neither should let a
    // raw parser exception (which can embed body content) past this boundary.
    try {
      const describe = await response.json();
      return this.parseSalesforceDescribe(describe, entity);
    } catch (error) {
      this.logger.warn('Salesforce relationship discovery returned an unparseable or malformed-shape response', { entity });
      // Intentional: attaching `cause` would put the raw parser/shape exception (can
      // embed response body content) on `error.cause.message`, undoing the B3.5
      // sanitization boundary this file enforces.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Salesforce relationship discovery failed: unparseable response');
    }
  }

  /**
   * Parse Salesforce describe response
   */
  private parseSalesforceDescribe(describe: unknown, entity: EntityType): SystemSchema {
    const d = describe as SalesforceDescribeShape;
    const fields: SchemaField[] = (d.fields || []).flatMap((f: unknown) => {
      const fm = f as SalesforceFieldMeta;
      const fieldName = typeof fm.name === 'string' ? fm.name.trim() : '';
      if (!fieldName) {
        // Bounded metadata only (B3.5) — fm.type/fm.label are remote response
        // content and must not reach logs unredacted, same boundary as
        // discoverSalesforceRelationshipSchema's own sanitization.
        this.logger.warn('Skipping Salesforce schema field with missing name', {
          entity,
          hasType: typeof fm.type === 'string',
          hasLabel: typeof fm.label === 'string'
        });
        return [];
      }
      return [{
        name: fieldName,
        type: this.mapSalesforceTypeToStandard(fm.type ?? ''),
        required: !fm.nillable && !fm.defaultedOnCreate,
        maxLength: fm.length,
        format: this.inferFormatFromSalesforceField(f),
        allowedValues: fm.picklistValues
          ?.map((pv) => pv.value)
          .filter((v): v is string => typeof v === 'string'),
        description: fm.label,
        nullable: fm.nillable
      }];
    });

    const relationships: SchemaRelationship[] = (d.childRelationships || []).flatMap((rel: unknown) => {
      const rm = rel as SalesforceChildRelationship;
      const sourceField = typeof rm.field === 'string' ? rm.field.trim() : '';
      const targetEntity = typeof rm.childSObject === 'string' ? rm.childSObject.trim() : '';
      const targetField = typeof rm.relationshipName === 'string' ? rm.relationshipName.trim() : '';
      if (!sourceField || !targetEntity || !targetField) {
        // Bounded metadata only (B3.5) — rm.field/childSObject/relationshipName
        // are remote response content and must not reach logs unredacted.
        this.logger.warn('Skipping Salesforce child relationship with missing identifiers', {
          entity,
          hasField: typeof rm.field === 'string',
          hasChildSObject: typeof rm.childSObject === 'string',
          hasRelationshipName: typeof rm.relationshipName === 'string'
        });
        return [];
      }
      return [{
        sourceField,
        targetEntity,
        targetField,
        type: 'one-to-many' as const
      }];
    });

    return {
      system: 'Salesforce',
      entity,
      fields,
      relationships,
      metadata: {
        lastUpdated: new Date(),
        source: 'api'
      }
    };
  }

  /**
   * Parse Business Central OData $metadata
   */
  private parseODataMetadata(metadataXML: string, entity: EntityType): SystemSchema {
    // Simplified XML parsing - in production, use xml2js or similar
    // For now, return mock schema
    this.logger.warn('OData XML parsing not yet implemented, using mock schema', { entity });
    return this.getMockBusinessCentralSchema(entity);
  }

  /**
   * Mock schemas for testing and fallback
   */
  private getMockNetSuiteSchema(entity: EntityType): SystemSchema {
    const commonFields: SchemaField[] = [
      { name: 'entityId', type: 'string', required: true, description: 'Internal ID' },
      { name: 'companyName', type: 'string', required: true, maxLength: 255 },
      { name: 'email', type: 'string', required: false, format: 'email', maxLength: 255 },
      { name: 'phone', type: 'string', required: false, format: 'phone', maxLength: 50 },
      { name: 'internalId', type: 'string', required: false, description: 'NetSuite Internal ID' }
    ];

    return {
      system: 'NetSuite',
      entity,
      fields: commonFields,
      relationships: [],
      metadata: { source: 'manual', lastUpdated: new Date() }
    };
  }

  private getMockSalesforceSchema(entity: EntityType): SystemSchema {
    const commonFields: SchemaField[] = [
      { name: 'Id', type: 'string', required: true, maxLength: 18, description: 'Salesforce ID' },
      { name: 'Name', type: 'string', required: true, maxLength: 255 },
      { name: 'Email', type: 'string', required: false, format: 'email', maxLength: 80 },
      { name: 'Phone', type: 'string', required: false, format: 'phone', maxLength: 40 },
      { name: 'AccountId', type: 'string', required: false, maxLength: 18 }
    ];

    return {
      system: 'Salesforce',
      entity,
      fields: commonFields,
      relationships: [],
      metadata: { source: 'manual', lastUpdated: new Date() }
    };
  }

  private getMockBusinessCentralSchema(entity: EntityType): SystemSchema {
    const commonFields: SchemaField[] = [
      { name: 'No_', type: 'string', required: true, maxLength: 20, description: 'Customer Number' },
      { name: 'Name', type: 'string', required: true, maxLength: 100 },
      { name: 'E_Mail', type: 'string', required: false, format: 'email', maxLength: 80 },
      { name: 'Phone_No_', type: 'string', required: false, format: 'phone', maxLength: 30 }
    ];

    return {
      system: 'BusinessCentral',
      entity,
      fields: commonFields,
      relationships: [],
      metadata: { source: 'manual', lastUpdated: new Date() }
    };
  }

  /**
   * Type mapping utilities
   */
  private mapNetSuiteTypeToStandard(netsuiteType: string): string {
    const mapping: Record<string, string> = {
      'string': 'string',
      'text': 'string',
      'select': 'string',
      'multiselect': 'array',
      'integer': 'number',
      'float': 'number',
      'currency': 'number',
      'date': 'date',
      'datetime': 'date',
      'boolean': 'boolean',
      'checkbox': 'boolean'
    };
    return mapping[netsuiteType.toLowerCase()] || 'string';
  }

  private mapSalesforceTypeToStandard(salesforceType: string): string {
    const mapping: Record<string, string> = {
      'string': 'string',
      'id': 'string',
      'reference': 'string',
      'picklist': 'string',
      'multipicklist': 'array',
      'email': 'string',
      'phone': 'string',
      'url': 'string',
      'textarea': 'string',
      'double': 'number',
      'currency': 'number',
      'percent': 'number',
      'int': 'number',
      'date': 'date',
      'datetime': 'date',
      'boolean': 'boolean'
    };
    return mapping[salesforceType.toLowerCase()] || 'string';
  }

  private mapEntityToNetSuiteType(entity: EntityType): string {
    const mapping: Record<EntityType, string> = {
      'Customer': 'customer',
      'Contact': 'contact',
      'Account': 'customer',
      'Order': 'salesorder',
      'Product': 'item',
      'Invoice': 'invoice'
    };
    return mapping[entity] || entity.toLowerCase();
  }

  private mapEntityToSalesforceType(entity: EntityType): string {
    const mapping: Record<EntityType, string> = {
      'Customer': 'Account',
      'Contact': 'Contact',
      'Account': 'Account',
      'Order': 'Order',
      'Product': 'Product2',
      'Invoice': 'Invoice'
    };
    return mapping[entity] || entity;
  }

  private inferFormatFromSalesforceField(field: unknown): string | undefined {
    const fm = field as SalesforceFieldMeta;
    if (fm.type === 'email') return 'email';
    if (fm.type === 'phone') return 'phone';
    if (fm.type === 'url') return 'url';
    if (fm.type === 'date') return 'date';
    if (fm.type === 'datetime') return 'datetime';
    return undefined;
  }

  /**
   * Cache management
   */
  private getCachedSchema(key: string): SchemaCacheEntry | null {
    const cached = this.schemaCache.get(key);
    if (!cached) return null;

    // Check if cache has expired
    const age = Date.now() - cached.timestamp.getTime();
    if (age > cached.ttl) {
      this.schemaCache.delete(key);
      return null;
    }

    return cached;
  }

  private cacheSchema(key: string, schema: SystemSchema): void {
    this.schemaCache.set(key, {
      schema,
      timestamp: new Date(),
      ttl: this.config.cacheTTL
    });

    this.logger.debug('Schema cached', {
      key,
      ttl: this.config.cacheTTL,
      fieldsCount: schema.fields.length
    });
  }

  /**
   * Clear cache (useful for testing or forced refresh)
   */
  clearCache(system?: SystemType): void {
    if (system) {
      // Clear cache for specific system
      const keysToDelete = Array.from(this.schemaCache.keys())
        .filter(key => key.startsWith(`${system}:`));
      keysToDelete.forEach(key => this.schemaCache.delete(key));

      this.logger.info('Schema cache cleared for system', { system, count: keysToDelete.length });
    } else {
      // Clear all cache
      const count = this.schemaCache.size;
      this.schemaCache.clear();
      this.logger.info('Schema cache cleared', { count });
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    entries: { key: string; age: number }[];
  } {
    return {
      size: this.schemaCache.size,
      entries: Array.from(this.schemaCache.entries()).map(([key, entry]) => ({
        key,
        age: Date.now() - entry.timestamp.getTime()
      }))
    };
  }
}
