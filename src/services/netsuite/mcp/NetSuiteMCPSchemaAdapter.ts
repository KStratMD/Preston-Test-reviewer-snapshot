/**
 * NetSuite MCP Schema Adapter - Phase 2: Schema Discovery Prototype
 *
 * Adapts NetSuite MCP client for use with SchemaDiscoveryService.
 * Provides schema discovery via MCP with caching and fallback mechanisms.
 *
 * Features:
 * - 24-hour schema caching (reduces API calls)
 * - Automatic fallback to hardcoded schemas (graceful degradation)
 * - Health monitoring and error tracking
 * - Version tracking for schema drift detection
 * - Optional dependency injection (can be disabled via feature flag)
 *
 * Integration Pattern:
 * ```typescript
 * // Optional injection in SchemaDiscoveryService
 * @injectable()
 * class SchemaDiscoveryService {
 *   constructor(
 *     @optional() private mcpAdapter?: NetSuiteMCPSchemaAdapter
 *   ) {}
 *
 *   async getSchema(system: string, entity: string) {
 *     if (system === 'NetSuite' && this.mcpAdapter) {
 *       return await this.mcpAdapter.getSchema(entity);
 *     }
 *     return this.getHardcodedSchema(system, entity);
 *   }
 * }
 * ```
 */

import crypto from 'crypto';
import { NetSuiteMCPClient, type NetSuiteSchemaResult } from './NetSuiteMCPClient';
import type { OAuth1Credentials } from '../../../types';
import type { Logger } from '../../../utils/Logger';
import type { SystemSchema, SchemaField, SchemaRelationship } from '../../ai/validation/types';

/**
 * Schema cache entry with metadata
 */
interface SchemaCacheEntry {
  schema: SystemSchema;
  timestamp: Date;
  ttl: number;
  hash: string; // SHA-256 hash for change detection
  source: 'mcp' | 'fallback';
}

/**
 * Schema adapter configuration
 */
export interface MCPSchemaAdapterConfig {
  cacheEnabled?: boolean; // Default: true
  cacheTTL?: number; // Cache TTL in ms (default: 24 hours)
  enableFallback?: boolean; // Default: true
  healthCheckInterval?: number; // Health check interval in ms (default: 5 minutes)
  maxRetries?: number; // Max retry attempts (default: 3)
}

/**
 * Health status of MCP connection
 */
export interface MCPHealthStatus {
  connected: boolean;
  lastSuccessfulQuery?: Date;
  lastError?: {
    message: string;
    timestamp: Date;
  };
  consecutiveFailures: number;
  uptime: number; // Percentage (0-100)
}

/**
 * NetSuite MCP Schema Adapter
 *
 * Wraps NetSuiteMCPClient to provide schema discovery with caching,
 * fallback, and health monitoring.
 *
 * Usage:
 * ```typescript
 * const adapter = new NetSuiteMCPSchemaAdapter(credentials, logger);
 * await adapter.initialize();
 *
 * // Get schema (from cache or MCP)
 * const schema = await adapter.getSchema('customer');
 *
 * // Check health
 * const health = adapter.getHealthStatus();
 *
 * // Clear cache
 * adapter.clearCache();
 * ```
 */
export class NetSuiteMCPSchemaAdapter {
  private client: NetSuiteMCPClient;
  private schemaCache = new Map<string, SchemaCacheEntry>();
  private readonly logger: Logger;
  private readonly config: Required<MCPSchemaAdapterConfig>;
  private initialized = false;
  private healthStatus: MCPHealthStatus = {
    connected: false,
    consecutiveFailures: 0,
    uptime: 100
  };

  constructor(
    credentials: OAuth1Credentials,
    logger: Logger,
    config?: MCPSchemaAdapterConfig
  ) {
    this.logger = logger;
    this.config = {
      cacheEnabled: config?.cacheEnabled ?? true,
      cacheTTL: config?.cacheTTL ?? 24 * 60 * 60 * 1000, // 24 hours default
      enableFallback: config?.enableFallback ?? true,
      healthCheckInterval: config?.healthCheckInterval ?? 5 * 60 * 1000, // 5 minutes
      maxRetries: config?.maxRetries ?? 3
    };

    this.client = new NetSuiteMCPClient(credentials, logger);
  }

  /**
   * Initialize MCP client connection
   *
   * Attempts to connect to NetSuite MCP server.
   * If connection fails and fallback is enabled, adapter still initializes
   * but will use fallback schemas.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('MCP schema adapter already initialized');
      return;
    }

    try {
      this.logger.info('Initializing NetSuite MCP schema adapter');

      // Attempt to connect to MCP server
      await this.client.connect();

      this.healthStatus.connected = this.client.isConnected();
      this.healthStatus.lastSuccessfulQuery = new Date();
      this.initialized = true;

      this.logger.info('MCP schema adapter initialized', {
        connected: this.healthStatus.connected,
        cacheEnabled: this.config.cacheEnabled,
        cacheTTL: this.config.cacheTTL,
        fallbackEnabled: this.config.enableFallback
      });

    } catch (error) {
      this.healthStatus.connected = false;
      this.healthStatus.lastError = {
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date()
      };
      this.healthStatus.consecutiveFailures++;

      if (this.config.enableFallback) {
        this.logger.warn('MCP connection failed, initializing in fallback mode', {
          error: error instanceof Error ? error.message : String(error),
          fallbackEnabled: true
        });
        this.initialized = true; // Initialize anyway, will use fallback
      } else {
        this.logger.error('MCP connection failed and fallback disabled', {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  }

  /**
   * Get schema for NetSuite entity
   *
   * Flow:
   * 1. Check cache (if enabled and not expired)
   * 2. Query MCP server
   * 3. Fallback to hardcoded schema (if MCP fails and fallback enabled)
   *
   * @param entityType - NetSuite record type (e.g., 'customer', 'item', 'salesorder')
   * @returns SystemSchema with fields, types, constraints
   */
  async getSchema(entityType: string): Promise<SystemSchema> {
    this.ensureInitialized();

    const cacheKey = `netsuite:${entityType.toLowerCase()}`;

    // Check cache first
    if (this.config.cacheEnabled) {
      const cached = this.getCachedSchema(cacheKey);
      if (cached) {
        this.logger.info('Schema retrieved from cache', {
          entityType,
          age: Date.now() - cached.timestamp.getTime(),
          source: cached.source
        });
        return cached.schema;
      }
    }

    // Try MCP query
    if (this.healthStatus.connected) {
      try {
        const mcpSchema = await this.client.getEntitySchema(entityType);
        const systemSchema = this.convertMCPSchemaToSystemSchema(mcpSchema);

        // Cache the result
        if (this.config.cacheEnabled) {
          this.cacheSchema(cacheKey, systemSchema, 'mcp');
        }

        // Update health status
        this.healthStatus.lastSuccessfulQuery = new Date();
        this.healthStatus.consecutiveFailures = 0;

        this.logger.info('Schema fetched from MCP', {
          entityType,
          fieldCount: systemSchema.fields.length
        });

        return systemSchema;

      } catch (error) {
        this.logger.warn('MCP schema query failed', {
          entityType,
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures: this.healthStatus.consecutiveFailures + 1
        });

        // Update health status
        this.healthStatus.lastError = {
          message: error instanceof Error ? error.message : String(error),
          timestamp: new Date()
        };
        this.healthStatus.consecutiveFailures++;

        // Check if we should mark as disconnected
        if (this.healthStatus.consecutiveFailures >= this.config.maxRetries) {
          this.healthStatus.connected = false;
          this.logger.error('MCP marked as disconnected after consecutive failures', {
            failures: this.healthStatus.consecutiveFailures,
            maxRetries: this.config.maxRetries
          });
        }

        // Fall through to fallback if enabled
        if (!this.config.enableFallback) {
          throw error;
        }
      }
    }

    // Fallback to hardcoded schema
    if (this.config.enableFallback) {
      this.logger.info('Using fallback hardcoded schema', { entityType });
      const fallbackSchema = this.getFallbackSchema(entityType);

      // Cache the fallback
      if (this.config.cacheEnabled) {
        this.cacheSchema(cacheKey, fallbackSchema, 'fallback');
      }

      return fallbackSchema;
    }

    throw new Error(`Failed to fetch schema for ${entityType} and fallback is disabled`);
  }

  /**
   * Convert MCP schema result to SystemSchema format
   */
  private convertMCPSchemaToSystemSchema(mcpSchema: NetSuiteSchemaResult): SystemSchema {
    const fields: SchemaField[] = mcpSchema.fields.map(f => ({
      name: f.name,
      type: this.mapNetSuiteTypeToStandard(f.type),
      required: f.required ?? false,
      maxLength: f.maxLength,
      description: f.label || f.description || f.name,
      allowedValues: f.allowedValues,
      nullable: !f.required
    }));

    const relationships: SchemaRelationship[] = (mcpSchema.relationships || []).map(r => ({
      sourceField: r.name,
      targetEntity: r.targetEntity,
      targetField: r.name,
      type: r.type === 'many-to-one' ? 'many-to-one' : 'one-to-many'
    }));

    return {
      system: 'NetSuite',
      entity: mcpSchema.entityType,
      fields,
      relationships,
      metadata: {
        source: 'api',
        lastUpdated: new Date()
      }
    };
  }

  /**
   * Map NetSuite field type to standard type
   */
  private mapNetSuiteTypeToStandard(netsuiteType: string): string {
    const mapping: Record<string, string> = {
      'string': 'string',
      'text': 'string',
      'textarea': 'string',
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

  /**
   * Get fallback hardcoded schema
   *
   * Used when MCP is unavailable or query fails
   */
  private getFallbackSchema(entityType: string): SystemSchema {
    const commonFields: SchemaField[] = [
      { name: 'id', type: 'number', required: true, description: 'Internal ID' },
      { name: 'internalId', type: 'string', required: false, description: 'NetSuite Internal ID' },
      { name: 'externalId', type: 'string', required: false, maxLength: 255, description: 'External System ID' }
    ];

    switch (entityType.toLowerCase()) {
      case 'customer':
        return {
          system: 'NetSuite',
          entity: 'customer',
          fields: [
            ...commonFields,
            { name: 'companyName', type: 'string', required: true, maxLength: 83, description: 'Company Name' },
            { name: 'email', type: 'string', required: false, maxLength: 254, format: 'email' },
            { name: 'phone', type: 'string', required: false, maxLength: 21, format: 'phone' },
            { name: 'subsidiary', type: 'string', required: true, description: 'Subsidiary' },
            { name: 'isPerson', type: 'boolean', required: false, description: 'Individual' },
            { name: 'isInactive', type: 'boolean', required: false, description: 'Inactive' }
          ],
          relationships: [],
          metadata: { source: 'manual', lastUpdated: new Date() }
        };

      case 'vendor':
        return {
          system: 'NetSuite',
          entity: 'vendor',
          fields: [
            ...commonFields,
            { name: 'companyName', type: 'string', required: true, maxLength: 83, description: 'Company Name' },
            { name: 'legalName', type: 'string', required: false, maxLength: 83, description: 'Legal Name' },
            { name: 'email', type: 'string', required: false, maxLength: 254, format: 'email' },
            { name: 'phone', type: 'string', required: false, maxLength: 21, format: 'phone' },
            { name: 'subsidiary', type: 'string', required: true, description: 'Subsidiary' },
            { name: 'taxId', type: 'string', required: false, maxLength: 30, description: 'Tax ID' },
            { name: 'isInactive', type: 'boolean', required: false, description: 'Inactive' }
          ],
          relationships: [],
          metadata: { source: 'manual', lastUpdated: new Date() }
        };

      case 'item':
      case 'inventoryitem':
        return {
          system: 'NetSuite',
          entity: 'item',
          fields: [
            ...commonFields,
            { name: 'itemId', type: 'string', required: true, maxLength: 40, description: 'Item Name/Number' },
            { name: 'displayName', type: 'string', required: false, maxLength: 60, description: 'Display Name' },
            { name: 'description', type: 'string', required: false, maxLength: 4000, description: 'Description' },
            { name: 'basePrice', type: 'number', required: false, description: 'Base Price' },
            { name: 'cost', type: 'number', required: false, description: 'Cost' },
            { name: 'isInactive', type: 'boolean', required: false, description: 'Inactive' }
          ],
          relationships: [],
          metadata: { source: 'manual', lastUpdated: new Date() }
        };

      default:
        return {
          system: 'NetSuite',
          entity: entityType,
          fields: commonFields,
          relationships: [],
          metadata: { source: 'manual', lastUpdated: new Date() }
        };
    }
  }

  /**
   * Get cached schema if available and not expired
   */
  private getCachedSchema(key: string): SchemaCacheEntry | null {
    const cached = this.schemaCache.get(key);
    if (!cached) return null;

    // Check if cache has expired
    const age = Date.now() - cached.timestamp.getTime();
    if (age > cached.ttl) {
      this.schemaCache.delete(key);
      this.logger.debug('Schema cache expired', { key, age, ttl: cached.ttl });
      return null;
    }

    return cached;
  }

  /**
   * Cache schema with hash for change detection
   */
  private cacheSchema(key: string, schema: SystemSchema, source: 'mcp' | 'fallback'): void {
    const schemaJSON = JSON.stringify(schema);
    const hash = this.hashString(schemaJSON);

    // Check if schema has changed
    const existing = this.schemaCache.get(key);
    if (existing && existing.hash !== hash) {
      this.logger.info('Schema changed detected', {
        key,
        oldHash: existing.hash.substring(0, 8),
        newHash: hash.substring(0, 8),
        source
      });
    }

    this.schemaCache.set(key, {
      schema,
      timestamp: new Date(),
      ttl: this.config.cacheTTL,
      hash,
      source
    });

    this.logger.debug('Schema cached', {
      key,
      ttl: this.config.cacheTTL,
      fieldCount: schema.fields.length,
      source
    });
  }

  /**
   * Simple SHA-256 hash implementation
   */
  private hashString(str: string): string {
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * Clear cache (all or specific entity)
   */
  clearCache(entityType?: string): void {
    if (entityType) {
      const key = `netsuite:${entityType.toLowerCase()}`;
      this.schemaCache.delete(key);
      this.logger.info('Schema cache cleared for entity', { entityType });
    } else {
      const count = this.schemaCache.size;
      this.schemaCache.clear();
      this.logger.info('Schema cache cleared', { count });
    }
  }

  /**
   * Get health status
   */
  getHealthStatus(): MCPHealthStatus {
    return { ...this.healthStatus };
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    entries: { key: string; age: number; source: 'mcp' | 'fallback' }[];
  } {
    return {
      size: this.schemaCache.size,
      entries: Array.from(this.schemaCache.entries()).map(([key, entry]) => ({
        key,
        age: Date.now() - entry.timestamp.getTime(),
        source: entry.source
      }))
    };
  }

  /**
   * Ensure adapter is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MCP schema adapter not initialized. Call initialize() first.');
    }
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
    if (this.client.isConnected()) {
      await this.client.disconnect();
    }

    this.initialized = false;
    this.healthStatus.connected = false;

    this.logger.info('MCP schema adapter disconnected');
  }
}
