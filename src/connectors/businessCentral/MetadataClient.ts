/**
 * Business Central Metadata Client
 * Fetches $metadata from BC API or loads from fixtures in demo mode
 */

import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import type { Logger } from '../../utils/Logger';
import type {
  BCMetadataSchema,
  BCProperty,
  BCNavProperty,
  BCFieldCatalog,
  BCFieldDefinition,
  MetadataClientConfig
} from './types';

/**
 * Structural shapes for OData CSDL XML elements as parsed by xml2js.
 * Each element has a `$` property holding string-valued attributes.
 */
interface ODataPropertyElement {
  $: {
    Name?: string;
    Type?: string;
    Nullable?: string;
    MaxLength?: string;
    Precision?: string;
    Scale?: string;
  };
}

interface ODataNavigationElement {
  $: {
    Name?: string;
    Type?: string;
  };
}

interface ODataPropertyRefElement {
  $: {
    Name?: string;
  };
}

interface ODataKeyElement {
  PropertyRef?: ODataPropertyRefElement[];
}

interface ODataEntityElement {
  $: {
    Name?: string;
  };
  Property?: ODataPropertyElement[];
  NavigationProperty?: ODataNavigationElement[];
  Key?: ODataKeyElement[];
}

export class MetadataClient {
  private cache = new Map<string, { data: BCMetadataSchema; timestamp: number }>();
  private readonly defaultCacheTTL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private config: MetadataClientConfig,
    private logger: Logger
  ) {
    this.logger.info('MetadataClient initialized', {
      demoMode: config.demoMode,
      cacheEnabled: config.cacheEnabled !== false
    });
  }

  /**
   * Fetch metadata schema for an entity type
   */
  async fetchMetadata(entityType: string): Promise<BCMetadataSchema> {
    // Check cache first
    if (this.config.cacheEnabled !== false) {
      const cached = this.getCached(entityType);
      if (cached) {
        this.logger.debug('Returning cached metadata', { entityType });
        return cached;
      }
    }

    // Fetch fresh metadata
    const schema = this.config.demoMode
      ? await this.loadFromFixture(entityType)
      : await this.fetchFromAPI(entityType);

    // Cache result
    if (this.config.cacheEnabled !== false) {
      this.setCached(entityType, schema);
    }

    return schema;
  }

  /**
   * Load metadata from fixture XML file
   */
  private async loadFromFixture(entityType: string): Promise<BCMetadataSchema> {
    try {
      const fixturePath = path.join(
        __dirname,
        '..',
        'fixtures',
        'bc',
        'metadata',
        `${entityType}.xml`
      );

      this.logger.debug('Loading BC metadata fixture', { entityType, fixturePath });

      if (!fs.existsSync(fixturePath)) {
        throw new Error(`Metadata fixture not found for entity type: ${entityType}`);
      }

      const xmlContent = fs.readFileSync(fixturePath, 'utf-8');
      const schema = await this.parseMetadataXML(xmlContent, entityType);

      this.logger.info('Loaded BC metadata from fixture', {
        entityType,
        propertyCount: schema.properties.length,
        navPropertyCount: schema.navigationProperties.length
      });

      return schema;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to load BC metadata fixture', {
        entityType,
        error: err.message
      });
      throw error;
    }
  }

  /**
   * Fetch metadata from live Business Central API
   */
  private async fetchFromAPI(entityType: string): Promise<BCMetadataSchema> {
    if (!this.config.baseURL || !this.config.companyId) {
      throw new Error('Base URL and company ID required for live metadata fetch');
    }

    try {
      const metadataURL = `${this.config.baseURL}/companies(${this.config.companyId})/$metadata`;

      this.logger.debug('Fetching BC metadata from API', { metadataURL, entityType });

      // For now, return a minimal schema - actual API fetch would require authentication
      // This is a placeholder for production implementation
      this.logger.warn('Live BC metadata fetch not yet implemented, falling back to fixture');
      return this.loadFromFixture(entityType);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to fetch BC metadata from API', {
        entityType,
        error: err.message
      });
      throw error;
    }
  }

  /**
   * Parse OData XML metadata
   */
  private async parseMetadataXML(xmlContent: string, entityType: string): Promise<BCMetadataSchema> {
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlContent);

    // Navigate OData XML structure
    const dataServices = result['edmx:Edmx']['edmx:DataServices'][0];
    const schema = dataServices['Schema'][0];
    const entityTypes = schema['EntityType'] || [];

    const targetEntity = (entityTypes as ODataEntityElement[]).find(
      (e: ODataEntityElement) => e.$?.Name?.toLowerCase() === entityType.toLowerCase()
    );

    if (!targetEntity) {
      throw new Error(`Entity type ${entityType} not found in metadata`);
    }

    // Extract properties — skip elements with missing required Name/Type
    // rather than fabricating empty strings that would propagate corrupted
    // schema fields into downstream validation/matching.
    const properties: BCProperty[] = (targetEntity.Property || []).flatMap(
      (prop: ODataPropertyElement): BCProperty[] => {
        const attrs = prop.$;
        const name = attrs?.Name;
        const type = attrs?.Type;
        if (!name || !type) {
          this.logger.warn('Skipping malformed BC Property (missing Name or Type)', {
            entityType, name, type
          });
          return [];
        }
        return [{
          name,
          type: this.mapODataType(type),
          nullable: attrs?.Nullable !== 'false',
          maxLength: attrs?.MaxLength ? parseInt(attrs.MaxLength) : undefined,
          precision: attrs?.Precision ? parseInt(attrs.Precision) : undefined,
          scale: attrs?.Scale ? parseInt(attrs.Scale) : undefined
        }];
      }
    );

    // Extract navigation properties — same skip-on-missing treatment.
    const navigationProperties: BCNavProperty[] = (targetEntity.NavigationProperty || []).flatMap(
      (nav: ODataNavigationElement): BCNavProperty[] => {
        const navName = nav.$?.Name;
        const navType = nav.$?.Type;
        if (!navName || !navType) {
          this.logger.warn('Skipping malformed BC NavigationProperty (missing Name or Type)', {
            entityType, name: navName, type: navType
          });
          return [];
        }
        return [{
          name: navName,
          type: navType.replace('Collection(', '').replace(')', ''),
          collection: navType.startsWith('Collection(')
        }];
      }
    );

    // Extract key — drop PropertyRef entries with missing Name.
    const keyProps = targetEntity.Key?.[0]?.PropertyRef || [];
    const key = keyProps.flatMap((k: ODataPropertyRefElement): string[] => {
      const kName = k.$?.Name;
      if (!kName) {
        this.logger.warn('Skipping BC Key PropertyRef with missing Name', { entityType });
        return [];
      }
      return [kName];
    });

    // entityType.$.Name was matched at the find() above, but treat its
    // absence here as a malformed-metadata error rather than emitting an
    // empty identifier into the returned schema.
    const resolvedEntityName = targetEntity.$?.Name;
    if (!resolvedEntityName) {
      throw new Error(`BC metadata for entity ${entityType} has no Name attribute`);
    }

    return {
      entityType: resolvedEntityName,
      namespace: schema.$.Namespace,
      properties,
      navigationProperties,
      key
    };
  }

  /**
   * Map OData types to common types
   */
  private mapODataType(odataType: string): string {
    const typeMap: Record<string, string> = {
      'Edm.String': 'string',
      'Edm.Int32': 'number',
      'Edm.Int64': 'number',
      'Edm.Decimal': 'number',
      'Edm.Double': 'number',
      'Edm.Boolean': 'boolean',
      'Edm.DateTimeOffset': 'date',
      'Edm.Date': 'date',
      'Edm.Guid': 'guid'
    };

    return typeMap[odataType] || odataType;
  }

  /**
   * Convert metadata schema to field catalog for AI prompts
   */
  getFieldCatalog(schema: BCMetadataSchema): BCFieldCatalog {
    const fields: BCFieldDefinition[] = schema.properties.map(prop => ({
      name: prop.name,
      type: this.mapToFieldType(prop.type),
      required: !prop.nullable,
      maxLength: prop.maxLength,
      format: this.getFieldFormat(prop),
      isNavigation: false
    }));

    const relationships: BCFieldDefinition[] = schema.navigationProperties.map(nav => ({
      name: nav.name,
      type: 'object',
      required: false,
      isNavigation: true,
      description: nav.collection ? `Collection of ${nav.type}` : `Reference to ${nav.type}`
    }));

    return {
      entityType: schema.entityType,
      fields,
      relationships
    };
  }

  /**
   * Map to simplified field types for UI and AI
   */
  private mapToFieldType(type: string): 'string' | 'number' | 'boolean' | 'date' | 'guid' | 'object' {
    const typeMap: Record<string, 'string' | 'number' | 'boolean' | 'date' | 'guid'> = {
      string: 'string',
      number: 'number',
      boolean: 'boolean',
      date: 'date',
      guid: 'guid'
    };

    return typeMap[type] || 'string';
  }

  /**
   * Get field format hint
   */
  private getFieldFormat(prop: BCProperty): string | undefined {
    if (prop.type === 'date') return 'iso8601';
    if (prop.type === 'guid') return 'uuid';
    if (prop.maxLength && prop.maxLength <= 10) return 'short-text';
    if (prop.maxLength && prop.maxLength <= 50) return 'medium-text';
    if (prop.maxLength && prop.maxLength > 50) return 'long-text';
    return undefined;
  }

  /**
   * Get cached metadata if still valid
   */
  private getCached(entityType: string): BCMetadataSchema | null {
    const cached = this.cache.get(entityType);
    if (!cached) return null;

    const ttl = this.config.cacheTTLMs || this.defaultCacheTTL;
    const age = Date.now() - cached.timestamp;

    if (age > ttl) {
      this.cache.delete(entityType);
      return null;
    }

    return cached.data;
  }

  /**
   * Cache metadata schema
   */
  private setCached(entityType: string, schema: BCMetadataSchema): void {
    this.cache.set(entityType, {
      data: schema,
      timestamp: Date.now()
    });
  }

  /**
   * Clear cache for specific entity or all
   */
  clearCache(entityType?: string): void {
    if (entityType) {
      this.cache.delete(entityType);
      this.logger.debug('Cleared metadata cache', { entityType });
    } else {
      this.cache.clear();
      this.logger.debug('Cleared all metadata cache');
    }
  }

  /**
   * Get all supported entity types (demo mode only)
   */
  getSupportedEntityTypes(): string[] {
    if (!this.config.demoMode) {
      throw new Error('getSupportedEntityTypes only available in demo mode');
    }

    const fixturesDir = path.join(__dirname, '..', 'fixtures', 'bc', 'metadata');

    if (!fs.existsSync(fixturesDir)) {
      return [];
    }

    return fs
      .readdirSync(fixturesDir)
      .filter(file => file.endsWith('.xml'))
      .map(file => file.replace('.xml', ''));
  }
}
