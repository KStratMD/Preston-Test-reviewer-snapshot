import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { NetSuiteSchema, NetSuiteCustomField, NetSuiteRelationship, FieldDefinition } from './AIFieldMappingService';

export interface NetSuiteRecordMetadata {
  recordType: string;
  standardFields: NetSuiteStandardField[];
  customFields: NetSuiteCustomField[];
  relationships: NetSuiteRelationship[];
  businessRules: NetSuiteBusinessRule[];
  subsidiaryDependent: boolean;
  multiCurrencySupport: boolean;
  workflowsAvailable: boolean;
}

export interface NetSuiteStandardField {
  id: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'email' | 'phone' | 'currency' | 'object';
  required: boolean;
  maxLength?: number;
  description?: string;
  format?: string;
  availableIn: NetSuiteEdition[];
  apiAccess: {
    rest: boolean;
    soap: boolean;
    suiteScript: boolean;
  };
}

export interface NetSuiteBusinessRule {
  id: string;
  name: string;
  description: string;
  applies_to: string[];
  conditions: string[];
  actions: string[];
}

export type NetSuiteEdition = 'starter' | 'pro' | 'premium' | 'enterprise' | 'ultimate';

export interface SchemaDiscoveryResult {
  recordType: string;
  discoveredFields: FieldDefinition[];
  confidence: number;
  recommendations: string[];
  warnings: string[];
}

/**
 * NetSuite Schema Intelligence Service
 * Provides deep understanding of NetSuite record structures, custom fields,
 * business rules, and system-specific requirements.
 */
@injectable()
export class NetSuiteSchemaIntelligence {
  private logger: Logger;
  private schemaCache = new Map<string, NetSuiteRecordMetadata>();

  // NetSuite standard field definitions
  private readonly standardFields: Record<string, NetSuiteStandardField[]> = {
    customer: [
      {
        id: 'companyname',
        label: 'Company Name',
        type: 'string',
        required: true,
        maxLength: 83,
        description: 'Primary company name for the customer',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'email',
        label: 'Email',
        type: 'email',
        required: false,
        maxLength: 254,
        description: 'Primary email address for the customer',
        format: 'email',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'phone',
        label: 'Phone',
        type: 'phone',
        required: false,
        maxLength: 21,
        description: 'Primary phone number for the customer',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'subsidiary',
        label: 'Subsidiary',
        type: 'object',
        required: false,
        description: 'Subsidiary assignment for multi-subsidiary accounts',
        availableIn: ['premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'currency',
        label: 'Currency',
        type: 'object',
        required: false,
        description: 'Primary currency for the customer',
        availableIn: ['pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'creditlimit',
        label: 'Credit Limit',
        type: 'currency',
        required: false,
        description: 'Maximum credit limit allowed for the customer',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'terms',
        label: 'Terms',
        type: 'object',
        required: false,
        description: 'Payment terms for the customer',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'category',
        label: 'Category',
        type: 'object',
        required: false,
        description: 'Customer category classification',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'defaultaddress',
        label: 'Default Address',
        type: 'string',
        required: false,
        description: 'Default address for the customer',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'billcity',
        label: 'Billing City',
        type: 'string',
        required: false,
        maxLength: 50,
        description: 'City for billing address',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'billstate',
        label: 'Billing State',
        type: 'string',
        required: false,
        maxLength: 50,
        description: 'State/province for billing address',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'billcountry',
        label: 'Billing Country',
        type: 'string',
        required: false,
        maxLength: 50,
        description: 'Country for billing address',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'billzip',
        label: 'Billing ZIP',
        type: 'string',
        required: false,
        maxLength: 36,
        description: 'ZIP/postal code for billing address',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
    ],
    vendor: [
      {
        id: 'companyname',
        label: 'Company Name',
        type: 'string',
        required: true,
        maxLength: 83,
        description: 'Primary company name for the vendor',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'email',
        label: 'Email',
        type: 'email',
        required: false,
        maxLength: 254,
        description: 'Primary email address for the vendor',
        format: 'email',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'phone',
        label: 'Phone',
        type: 'phone',
        required: false,
        maxLength: 21,
        description: 'Primary phone number for the vendor',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'terms',
        label: 'Terms',
        type: 'object',
        required: false,
        description: 'Payment terms with the vendor',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
    ],
    item: [
      {
        id: 'itemid',
        label: 'Item Name/Number',
        type: 'string',
        required: true,
        maxLength: 40,
        description: 'Unique identifier for the item',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'displayname',
        label: 'Display Name',
        type: 'string',
        required: false,
        maxLength: 100,
        description: 'Display name for the item',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'description',
        label: 'Description',
        type: 'string',
        required: false,
        description: 'Item description',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'baseprice',
        label: 'Base Price',
        type: 'currency',
        required: false,
        description: 'Base selling price for the item',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
    ],
    contact: [
      {
        id: 'firstname',
        label: 'First Name',
        type: 'string',
        required: false,
        maxLength: 32,
        description: 'Contact\'s first name',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'lastname',
        label: 'Last Name',
        type: 'string',
        required: true,
        maxLength: 32,
        description: 'Contact\'s last name',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
      {
        id: 'email',
        label: 'Email',
        type: 'email',
        required: false,
        maxLength: 254,
        description: 'Contact\'s email address',
        format: 'email',
        availableIn: ['starter', 'pro', 'premium', 'enterprise', 'ultimate'],
        apiAccess: { rest: true, soap: true, suiteScript: true },
      },
    ],
  };

  // Common custom field patterns in NetSuite
  private readonly customFieldPatterns = {
    entity: [
      'custentity_custom_field',
      'custentity_external_id',
      'custentity_integration_id',
      'custentity_source_system',
      'custentity_sync_status',
    ],
    transaction: [
      'custbody_external_ref',
      'custbody_source_doc',
      'custbody_integration_notes',
    ],
    item: [
      'custitem_product_code',
      'custitem_manufacturer',
      'custitem_category',
    ],
  };

  constructor(
    @inject(TYPES.Logger) logger: Logger,
  ) {
    this.logger = logger;
  }

  /**
   * Get comprehensive schema information for a NetSuite record type
   */
  async getNetSuiteSchema(recordType: string, accountId?: string): Promise<NetSuiteSchema> {
    this.logger.debug('Retrieving NetSuite schema', { recordType, accountId });

    const cacheKey = `${recordType}_${accountId || 'default'}`;

    if (this.schemaCache.has(cacheKey)) {
      const cached = this.schemaCache.get(cacheKey)!;
      return this.convertToNetSuiteSchema(cached);
    }

    // Build schema from standard fields
    const standardFields = this.standardFields[recordType] || [];

    // Discover custom fields (in real implementation, this would call NetSuite API)
    const customFields = await this.discoverCustomFields(recordType, accountId);

    // Get relationships
    const relationships = this.getRecordRelationships(recordType);

    // Get business rules
    const businessRules = this.getBusinessRules(recordType);

    const metadata: NetSuiteRecordMetadata = {
      recordType,
      standardFields,
      customFields,
      relationships,
      businessRules,
      subsidiaryDependent: this.isSubsidiaryDependent(recordType),
      multiCurrencySupport: this.supportsMultiCurrency(recordType),
      workflowsAvailable: this.hasWorkflowSupport(recordType),
    };

    this.schemaCache.set(cacheKey, metadata);

    return this.convertToNetSuiteSchema(metadata);
  }

  /**
   * Discover custom fields for a record type
   */
  async discoverCustomFields(recordType: string, accountId?: string): Promise<NetSuiteCustomField[]> {
    this.logger.debug('Discovering custom fields', { recordType, accountId });

    // In a real implementation, this would make API calls to NetSuite
    // For now, returning common patterns based on record type

    const commonCustomFields: NetSuiteCustomField[] = [];
    const patterns = this.customFieldPatterns.entity; // Default to entity patterns

    for (let i = 0; i < 3; i++) {
      commonCustomFields.push({
        id: `custentity_custom_field_${i + 1}`,
        label: `Custom Field ${i + 1}`,
        type: 'string',
        helpText: `Custom field for additional ${recordType} information`,
        recordType,
      });
    }

    // Add integration-specific fields
    commonCustomFields.push(
      {
        id: 'custentity_external_id',
        label: 'External System ID',
        type: 'string',
        helpText: 'ID from external system for synchronization',
        recordType,
      },
      {
        id: 'custentity_last_sync_date',
        label: 'Last Sync Date',
        type: 'date',
        helpText: 'Last synchronization timestamp',
        recordType,
      },
      {
        id: 'custentity_source_system',
        label: 'Source System',
        type: 'string',
        helpText: 'Originating system for this record',
        recordType,
      },
    );

    return commonCustomFields;
  }

  /**
   * Get relationship information for a record type
   */
  getRecordRelationships(recordType: string): NetSuiteRelationship[] {
    const relationships: NetSuiteRelationship[] = [];

    switch (recordType) {
    case 'customer':
      relationships.push(
        { field: 'subsidiary', relatedRecord: 'subsidiary', type: 'lookup' },
        { field: 'currency', relatedRecord: 'currency', type: 'lookup' },
        { field: 'terms', relatedRecord: 'term', type: 'lookup' },
        { field: 'category', relatedRecord: 'customercategory', type: 'lookup' },
        { field: 'contacts', relatedRecord: 'contact', type: 'child' },
        { field: 'addresses', relatedRecord: 'customeraddress', type: 'child' },
      );
      break;

    case 'vendor':
      relationships.push(
        { field: 'subsidiary', relatedRecord: 'subsidiary', type: 'lookup' },
        { field: 'currency', relatedRecord: 'currency', type: 'lookup' },
        { field: 'terms', relatedRecord: 'term', type: 'lookup' },
        { field: 'category', relatedRecord: 'vendorcategory', type: 'lookup' },
      );
      break;

    case 'item':
      relationships.push(
        { field: 'subsidiary', relatedRecord: 'subsidiary', type: 'lookup' },
        { field: 'itemtype', relatedRecord: 'itemtype', type: 'lookup' },
        { field: 'units', relatedRecord: 'unitstype', type: 'lookup' },
      );
      break;

    case 'contact':
      relationships.push(
        { field: 'company', relatedRecord: 'customer', type: 'parent' },
      );
      break;
    }

    return relationships;
  }

  /**
   * Get business rules for a record type
   */
  getBusinessRules(recordType: string): NetSuiteBusinessRule[] {
    const rules: NetSuiteBusinessRule[] = [];

    // Common business rules across record types
    rules.push({
      id: 'required_fields_validation',
      name: 'Required Fields Validation',
      description: 'Validates that all required fields are populated',
      applies_to: [recordType],
      conditions: ['record_save'],
      actions: ['validate_required_fields'],
    });

    // Record-specific business rules
    switch (recordType) {
    case 'customer':
      rules.push(
        {
          id: 'customer_credit_limit',
          name: 'Customer Credit Limit Validation',
          description: 'Ensures credit limit is within acceptable range',
          applies_to: ['customer'],
          conditions: ['creditlimit > 0'],
          actions: ['validate_credit_limit'],
        },
        {
          id: 'subsidiary_currency_alignment',
          name: 'Subsidiary Currency Alignment',
          description: 'Ensures customer currency aligns with subsidiary',
          applies_to: ['customer'],
          conditions: ['subsidiary_exists', 'currency_exists'],
          actions: ['validate_currency_subsidiary'],
        },
      );
      break;

    case 'item':
      rules.push({
        id: 'item_pricing_validation',
        name: 'Item Pricing Validation',
        description: 'Validates item pricing structure',
        applies_to: ['item'],
        conditions: ['baseprice >= 0'],
        actions: ['validate_pricing'],
      });
      break;
    }

    return rules;
  }

  /**
   * Analyze field mapping compatibility with NetSuite requirements
   */
  async analyzeMappingCompatibility(
    sourceField: FieldDefinition,
    targetField: string,
    recordType: string,
  ): Promise<{
    compatible: boolean;
    confidence: number;
    issues: string[];
    recommendations: string[];
  }> {
    this.logger.debug('Analyzing mapping compatibility', {
      sourceField: sourceField.name,
      targetField,
      recordType,
    });

    const schema = await this.getNetSuiteSchema(recordType);
    const netsuiteField = schema.fields.find(f => f.name === targetField) ||
                         schema.customFields.find(f => f.id === targetField);

    if (!netsuiteField) {
      return {
        compatible: false,
        confidence: 0,
        issues: [`Target field '${targetField}' not found in NetSuite ${recordType} schema`],
        recommendations: ['Verify field name or create custom field'],
      };
    }

    const issues: string[] = [];
    const recommendations: string[] = [];
    let compatible = true;
    let confidence = 1.0;

    // Type compatibility check
    if (!this.areTypesCompatible(sourceField.type, netsuiteField.type || 'string')) {
      issues.push(`Type mismatch: ${sourceField.type} -> ${netsuiteField.type}`);
      recommendations.push('Add data transformation to handle type conversion');
      compatible = false;
      confidence -= 0.3;
    }

    // Length validation
    if ('maxLength' in netsuiteField && netsuiteField.maxLength && sourceField.maxLength) {
      if (sourceField.maxLength > netsuiteField.maxLength) {
        issues.push(`Source field length (${sourceField.maxLength}) exceeds NetSuite limit (${netsuiteField.maxLength})`);
        recommendations.push('Add truncation or validation to handle length limits');
        confidence -= 0.2;
      }
    }

    // Required field validation
    if ('required' in netsuiteField && netsuiteField.required && !sourceField.required) {
      issues.push('NetSuite field is required but source field is optional');
      recommendations.push('Ensure source field always has a value or provide default');
      confidence -= 0.2;
    }

    // Custom field validation
    if ('id' in netsuiteField && netsuiteField.id.startsWith('cust')) {
      recommendations.push('Custom field mapping - verify field exists in target NetSuite account');
      confidence -= 0.1;
    }

    return {
      compatible: compatible && confidence > 0.5,
      confidence: Math.max(confidence, 0),
      issues,
      recommendations,
    };
  }

  /**
   * Suggest optimal NetSuite field for a source field
   */
  async suggestOptimalField(
    sourceField: FieldDefinition,
    recordType: string,
    context?: Record<string, unknown>,
  ): Promise<{
    suggestedField: string;
    confidence: number;
    reasoning: string;
    alternatives: { field: string; confidence: number }[];
  }> {
    const schema = await this.getNetSuiteSchema(recordType);
    const suggestions: { field: string; confidence: number; reasoning: string }[] = [];

    // Analyze standard fields
    for (const field of schema.fields) {
      const compatibility = await this.analyzeMappingCompatibility(sourceField, field.name, recordType);
      if (compatibility.compatible) {
        const semanticScore = this.calculateSemanticScore(sourceField.name, field.name);
        const typeScore = this.calculateTypeScore(sourceField.type, field.type);
        const confidence = (compatibility.confidence * 0.4) + (semanticScore * 0.4) + (typeScore * 0.2);

        suggestions.push({
          field: field.name,
          confidence,
          reasoning: `Standard field match with ${Math.round(confidence * 100)}% confidence`,
        });
      }
    }

    // Analyze custom fields
    for (const field of schema.customFields) {
      const compatibility = await this.analyzeMappingCompatibility(sourceField, field.id, recordType);
      if (compatibility.compatible) {
        const semanticScore = this.calculateSemanticScore(sourceField.name, field.label);
        const confidence = (compatibility.confidence * 0.5) + (semanticScore * 0.4);

        suggestions.push({
          field: field.id,
          confidence: confidence * 0.9, // Slight penalty for custom fields
          reasoning: `Custom field match: "${field.label}"`,
        });
      }
    }

    // Sort by confidence
    suggestions.sort((a, b) => b.confidence - a.confidence);

    const bestSuggestion = suggestions[0];
    const alternatives = suggestions.slice(1, 4).map(s => ({
      field: s.field,
      confidence: s.confidence,
    }));

    return {
      suggestedField: bestSuggestion?.field || '',
      confidence: bestSuggestion?.confidence || 0,
      reasoning: bestSuggestion?.reasoning || 'No suitable field found',
      alternatives,
    };
  }

  /**
   * Convert metadata to NetSuite schema format
   */
  private convertToNetSuiteSchema(metadata: NetSuiteRecordMetadata): NetSuiteSchema {
    const fields: FieldDefinition[] = metadata.standardFields.map(sf => ({
      name: sf.id,
      type: sf.type,
      description: sf.description,
      required: sf.required,
      maxLength: sf.maxLength,
      format: sf.format,
      customField: false,
    }));

    return {
      fields,
      systemType: 'NetSuite',
      recordType: metadata.recordType as any,
      customFields: metadata.customFields,
      relationships: metadata.relationships,
    };
  }

  /**
   * Check if record type is subsidiary dependent
   */
  private isSubsidiaryDependent(recordType: string): boolean {
    const subsidiaryDependentRecords = ['customer', 'vendor', 'employee', 'item', 'account'];
    return subsidiaryDependentRecords.includes(recordType);
  }

  /**
   * Check if record type supports multi-currency
   */
  private supportsMultiCurrency(recordType: string): boolean {
    const multiCurrencyRecords = ['customer', 'vendor', 'item', 'transaction'];
    return multiCurrencyRecords.includes(recordType);
  }

  /**
   * Check if record type has workflow support
   */
  private hasWorkflowSupport(recordType: string): boolean {
    const workflowSupportedRecords = ['customer', 'vendor', 'item', 'transaction', 'case'];
    return workflowSupportedRecords.includes(recordType);
  }

  /**
   * Calculate semantic similarity score
   */
  private calculateSemanticScore(sourceName: string, targetName: string): number {
    const source = sourceName.toLowerCase();
    const target = targetName.toLowerCase();

    if (source === target) return 1.0;
    if (source.includes(target) || target.includes(source)) return 0.8;

    // Check for common synonyms
    const synonyms = {
      'name': ['title', 'label', 'companyname'],
      'email': ['emailaddress', 'mail'],
      'phone': ['telephone', 'mobile'],
      'address': ['location', 'addr'],
    };

    for (const [key, values] of Object.entries(synonyms)) {
      if ((source.includes(key) && values.some(v => target.includes(v))) ||
          (target.includes(key) && values.some(v => source.includes(v)))) {
        return 0.7;
      }
    }

    return 0.0;
  }

  /**
   * Calculate type compatibility score
   */
  private calculateTypeScore(sourceType: string, targetType: string): number {
    if (sourceType === targetType) return 1.0;

    const compatibilityMatrix: Record<string, Record<string, number>> = {
      'string': { 'email': 0.9, 'phone': 0.9, 'currency': 0.7 },
      'number': { 'currency': 0.9, 'string': 0.7 },
      'email': { 'string': 0.8 },
      'phone': { 'string': 0.8 },
      'currency': { 'number': 0.8, 'string': 0.6 },
    };

    return compatibilityMatrix[sourceType]?.[targetType] || 0.3;
  }

  /**
   * Check if field types are compatible
   */
  private areTypesCompatible(sourceType: string, targetType: string): boolean {
    return this.calculateTypeScore(sourceType, targetType) >= 0.5;
  }

  /**
   * Clear schema cache
   */
  clearCache(): void {
    this.schemaCache.clear();
    this.logger.info('NetSuite schema cache cleared');
  }

  /**
   * Get cached schema information
   */
  getCachedSchemas(): string[] {
    return Array.from(this.schemaCache.keys());
  }
}
