/**
 * NetSuite MCP Client - Phase 2: Schema Discovery Prototype
 *
 * Connects to NetSuite AI Connector Service (MCP Standard Tools SuiteApp)
 * using the Model Context Protocol for schema discovery and data queries.
 *
 * Architecture:
 * - Uses @modelcontextprotocol/sdk for MCP communication
 * - Authenticates with OAuth 1.0a (same credentials as REST connector)
 * - Provides tools for schema discovery, SuiteQL queries, and saved searches
 * - Integrates with existing NetSuite connector infrastructure
 *
 * References:
 * - Oracle NetSuite Help: article_3200541651.html (Get Started with AI Connector)
 * - MCP Protocol: https://modelcontextprotocol.io/
 * - Assessment: docs/evaluation/NETSUITE-MCP-ASSESSMENT.md
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { OAuth1Credentials } from '../../../types';
import type { Logger } from '../../../utils/Logger';
import crypto from 'crypto';

/**
 * MCP Tool Definition
 * Represents an available operation in the MCP server
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP Resource Definition
 * Represents accessible data or documents
 */
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * MCP Tool Call Result
 */
export interface MCPToolResult {
  content: {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }[];
  isError?: boolean;
}

/**
 * NetSuite Schema Query Result
 * Response from schema discovery queries
 */
export interface NetSuiteSchemaResult {
  entityType: string;
  fields: {
    name: string;
    type: string;
    label?: string;
    required?: boolean;
    maxLength?: number;
    description?: string;
    allowedValues?: string[];
  }[];
  relationships?: {
    name: string;
    targetEntity: string;
    type: string;
  }[];
}

/**
 * MCP Client Configuration
 */
export interface MCPClientConfig {
  credentials: OAuth1Credentials;
  serverUrl?: string; // URL of MCP server (if remote)
  transport?: 'stdio' | 'sse' | 'http'; // Transport type
  timeout?: number; // Request timeout in ms
}

/**
 * NetSuite MCP Client
 *
 * Handles communication with NetSuite's MCP Standard Tools SuiteApp
 * for schema discovery, SuiteQL queries, and saved searches.
 *
 * Usage:
 * ```typescript
 * const client = new NetSuiteMCPClient(credentials, logger);
 * await client.connect();
 *
 * // List available tools
 * const tools = await client.listTools();
 *
 * // Query customer schema
 * const schema = await client.getEntitySchema('customer');
 *
 * // Execute SuiteQL query
 * const results = await client.executeSuiteQL('SELECT * FROM customer WHERE companyname LIKE ?', ['Acme%']);
 *
 * await client.disconnect();
 * ```
 */
export class NetSuiteMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private readonly credentials: OAuth1Credentials;
  private readonly logger: Logger;
  private readonly config: MCPClientConfig;

  constructor(
    credentials: OAuth1Credentials,
    logger: Logger,
    config?: Partial<MCPClientConfig>
  ) {
    this.credentials = credentials;
    this.logger = logger;
    this.config = {
      credentials,
      transport: config?.transport || 'stdio',
      timeout: config?.timeout || 30000, // 30 second default
      ...config
    };
  }

  /**
   * Connect to NetSuite MCP server
   *
   * Note: In Phase 2 prototype, this is a placeholder for actual MCP connection.
   * Actual implementation requires MCP Standard Tools SuiteApp installation on NetSuite.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      this.logger.warn('MCP client already connected');
      return;
    }

    try {
      this.logger.info('Connecting to NetSuite MCP server', {
        accountId: this.credentials.accountId,
        transport: this.config.transport
      });

      // TODO Phase 2: Actual MCP connection implementation
      // This is a placeholder - actual implementation requires:
      // 1. MCP Standard Tools SuiteApp installed on NetSuite account
      // 2. SuiteScript RESTlet endpoint configured
      // 3. OAuth 1.0a authentication flow

      // For now, we'll create a client instance but note it's not fully connected
      this.logger.warn('MCP client created (prototype mode - full connection pending SuiteApp installation)');

      this.connected = true;

    } catch (error) {
      this.logger.error('Failed to connect to NetSuite MCP server', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(`MCP connection failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Disconnect from MCP server
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
      }

      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }

      this.connected = false;
      this.logger.info('Disconnected from NetSuite MCP server');

    } catch (error) {
      this.logger.error('Error disconnecting from MCP server', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * List available MCP tools
   *
   * Expected tools from MCP Standard Tools SuiteApp:
   * - get_tables: List available NetSuite record types
   * - get_columns: Get field metadata for specific record type
   * - run_query: Execute SuiteQL query
   * - run_saved_search: Execute saved search
   * - create_record: Create new record
   * - update_record: Update existing record
   */
  async listTools(): Promise<MCPTool[]> {
    this.ensureConnected();

    try {
      // TODO Phase 2: Actual MCP tools/list implementation
      // For now, return expected tools based on MCP Standard Tools SuiteApp documentation

      const expectedTools: MCPTool[] = [
        {
          name: 'netsuite_get_tables',
          description: 'List available NetSuite record types (entities)',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'netsuite_get_columns',
          description: 'Get field metadata for a specific NetSuite record type',
          inputSchema: {
            type: 'object',
            properties: {
              recordType: { type: 'string', description: 'NetSuite record type (e.g., customer, item, salesorder)' }
            },
            required: ['recordType']
          }
        },
        {
          name: 'netsuite_run_query',
          description: 'Execute SuiteQL query',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'SuiteQL query string' },
              parameters: { type: 'array', description: 'Query parameters for placeholders' }
            },
            required: ['query']
          }
        },
        {
          name: 'netsuite_run_saved_search',
          description: 'Execute a saved search by ID',
          inputSchema: {
            type: 'object',
            properties: {
              searchId: { type: 'string', description: 'Saved search internal ID' }
            },
            required: ['searchId']
          }
        },
        {
          name: 'netsuite_create_record',
          description: 'Create a new NetSuite record',
          inputSchema: {
            type: 'object',
            properties: {
              recordType: { type: 'string', description: 'Record type to create' },
              values: { type: 'object', description: 'Field values' }
            },
            required: ['recordType', 'values']
          }
        },
        {
          name: 'netsuite_update_record',
          description: 'Update an existing NetSuite record',
          inputSchema: {
            type: 'object',
            properties: {
              recordType: { type: 'string', description: 'Record type to update' },
              id: { type: 'string', description: 'Internal ID of record' },
              values: { type: 'object', description: 'Field values to update' }
            },
            required: ['recordType', 'id', 'values']
          }
        }
      ];

      this.logger.info('Listed MCP tools (prototype mode)', { count: expectedTools.length });
      return expectedTools;

    } catch (error) {
      this.logger.error('Failed to list MCP tools', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(`Failed to list MCP tools: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Get entity schema metadata
   *
   * Uses netsuite_get_columns tool to fetch field metadata
   *
   * @param entityType - NetSuite record type (e.g., 'customer', 'item', 'salesorder')
   * @returns Schema information including fields, types, constraints
   */
  async getEntitySchema(entityType: string): Promise<NetSuiteSchemaResult> {
    this.ensureConnected();

    try {
      this.logger.info('Fetching NetSuite entity schema via MCP', { entityType });

      // TODO Phase 2: Actual MCP tools/call implementation
      // For now, return mock schema based on entity type

      const mockSchema = this.getMockSchemaForEntity(entityType);

      this.logger.warn('Returned mock schema (prototype mode - awaiting SuiteApp installation)', {
        entityType,
        fieldCount: mockSchema.fields.length
      });

      return mockSchema;

    } catch (error) {
      this.logger.error('Failed to fetch entity schema via MCP', {
        entityType,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(`Failed to fetch schema: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Execute SuiteQL query
   *
   * @param query - SuiteQL query string (supports ? placeholders)
   * @param parameters - Optional parameters for query placeholders
   * @returns Query results
   */
  async executeSuiteQL<T = unknown>(query: string, parameters?: unknown[]): Promise<T[]> {
    this.ensureConnected();

    try {
      this.logger.info('Executing SuiteQL query via MCP', {
        query: query.substring(0, 100), // Log first 100 chars
        paramCount: parameters?.length || 0
      });

      // TODO Phase 2: Actual MCP tools/call implementation
      // For now, throw error indicating prototype mode

      throw new Error('SuiteQL execution not yet implemented - requires MCP Standard Tools SuiteApp installation');

    } catch (error) {
      this.logger.error('Failed to execute SuiteQL query', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Generate OAuth 1.0a signature for MCP authentication
   *
   * NetSuite MCP uses same OAuth 1.0a as REST API
   */
  private generateOAuthSignature(
    method: string,
    url: string,
    params: Record<string, string>
  ): string {
    const { consumerSecret, tokenSecret } = this.credentials;

    // Create signature base string
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');

    const signatureBaseString = [
      method.toUpperCase(),
      encodeURIComponent(url),
      encodeURIComponent(sortedParams)
    ].join('&');

    // Create signing key
    const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

    // Generate HMAC-SHA256 signature
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(signatureBaseString)
      .digest('base64');

    return signature;
  }

  /**
   * Ensure client is connected, throw if not
   */
  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('MCP client not connected. Call connect() first.');
    }
  }

  /**
   * Get mock schema for testing (Phase 2 prototype)
   *
   * This will be replaced with actual MCP schema queries once
   * MCP Standard Tools SuiteApp is installed.
   */
  private getMockSchemaForEntity(entityType: string): NetSuiteSchemaResult {
    const commonFields = [
      { name: 'id', type: 'integer', label: 'Internal ID', required: true, description: 'NetSuite internal ID' },
      { name: 'internalId', type: 'string', label: 'Internal ID (string)', required: false },
      { name: 'externalId', type: 'string', label: 'External ID', required: false, maxLength: 255 }
    ];

    switch (entityType.toLowerCase()) {
      case 'customer':
        return {
          entityType: 'customer',
          fields: [
            ...commonFields,
            { name: 'companyName', type: 'string', label: 'Company Name', required: true, maxLength: 83 },
            { name: 'firstName', type: 'string', label: 'First Name', required: false, maxLength: 32 },
            { name: 'lastName', type: 'string', label: 'Last Name', required: false, maxLength: 32 },
            { name: 'email', type: 'string', label: 'Email', required: false, maxLength: 254 },
            { name: 'phone', type: 'string', label: 'Phone', required: false, maxLength: 21 },
            { name: 'subsidiary', type: 'select', label: 'Subsidiary', required: true },
            { name: 'terms', type: 'select', label: 'Terms', required: false },
            { name: 'currency', type: 'select', label: 'Currency', required: false },
            { name: 'isPerson', type: 'checkbox', label: 'Individual', required: false },
            { name: 'isInactive', type: 'checkbox', label: 'Inactive', required: false }
          ],
          relationships: [
            { name: 'subsidiary', targetEntity: 'subsidiary', type: 'many-to-one' },
            { name: 'terms', targetEntity: 'term', type: 'many-to-one' },
            { name: 'currency', targetEntity: 'currency', type: 'many-to-one' }
          ]
        };

      case 'vendor':
        return {
          entityType: 'vendor',
          fields: [
            ...commonFields,
            { name: 'companyName', type: 'string', label: 'Company Name', required: true, maxLength: 83 },
            { name: 'legalName', type: 'string', label: 'Legal Name', required: false, maxLength: 83 },
            { name: 'email', type: 'string', label: 'Email', required: false, maxLength: 254 },
            { name: 'phone', type: 'string', label: 'Phone', required: false, maxLength: 21 },
            { name: 'subsidiary', type: 'select', label: 'Subsidiary', required: true },
            { name: 'currency', type: 'select', label: 'Currency', required: false },
            { name: 'terms', type: 'select', label: 'Terms', required: false },
            { name: 'taxId', type: 'string', label: 'Tax ID', required: false, maxLength: 30 },
            { name: 'isInactive', type: 'checkbox', label: 'Inactive', required: false }
          ]
        };

      case 'item':
      case 'inventoryitem':
        return {
          entityType: 'item',
          fields: [
            ...commonFields,
            { name: 'itemId', type: 'string', label: 'Name/Number', required: true, maxLength: 40 },
            { name: 'displayName', type: 'string', label: 'Display Name', required: false, maxLength: 60 },
            { name: 'description', type: 'textarea', label: 'Description', required: false, maxLength: 4000 },
            { name: 'itemType', type: 'select', label: 'Type', required: true, allowedValues: ['Assembly', 'InvtPart', 'NonInvtPart', 'Service'] },
            { name: 'basePrice', type: 'currency', label: 'Base Price', required: false },
            { name: 'cost', type: 'currency', label: 'Cost', required: false },
            { name: 'subsidiary', type: 'select', label: 'Subsidiary', required: true },
            { name: 'isInactive', type: 'checkbox', label: 'Inactive', required: false }
          ]
        };

      default:
        return {
          entityType,
          fields: commonFields
        };
    }
  }
}
