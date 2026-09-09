import * as fs from 'fs';
import * as path from 'path';
import { UnifiedTemplate, TemplateCategory, TemplateLibrary, FieldMapping, BusinessRule, TemplateConfiguration } from '../types/template.types';
import { logger } from '../utils/Logger';

export class UnifiedTemplateService {
  private readonly libraryPath: string;
  private readonly customPath: string;
  private cache: TemplateLibrary | null = null;

  constructor() {
    const configDir = path.resolve(process.cwd(), 'config');
    this.libraryPath = path.join(configDir, 'template-library.json');
    this.customPath = path.join(configDir, 'custom-templates.json');
    this.ensureDirectoryExists(configDir);
  }

  private ensureDirectoryExists(dir: string): void {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (error) {
      logger.error(`Failed to create directory ${dir}:`, error);
    }
  }

  private loadBuiltinTemplates(): UnifiedTemplate[] {
    // Convert existing builtin templates to unified format
    const builtinTemplates: UnifiedTemplate[] = [
      {
        key: 'suitecentral-customer',
        name: 'SuiteCentral: Customer Standard',
        description: 'Complete customer identity and contact mapping with validation',
        sourceSystem: 'Salesforce',
        targetSystem: 'SuiteCentral',
        category: 'Customer Management',
        fields: [
          { source: 'firstName', target: 'first_name', transformation: 'direct', required: true },
          { source: 'lastName', target: 'last_name', transformation: 'direct', required: true },
          { source: 'email', target: 'email', transformation: 'lowercase', required: true, validation: '^[^@]+@[^@]+\\.[^@]+$' },
          { source: 'phone', target: 'phone', transformation: 'format', params: { format: '{value}' } },
          { source: 'companyName', target: 'company', transformation: 'direct' },
          { source: 'firstName', target: 'full_name', transformation: 'concatenation', params: { template: '{firstName} {lastName}' } },
        ],
        configuration: {
          syncDirection: 'unidirectional',
          syncMode: 'realtime',
          batchSize: 100,
          retryAttempts: 3,
          errorHandling: 'dlq',
          businessRules: [
            {
              name: 'Customer Tier Classification',
              condition: 'annualRevenue > 1000000',
              action: 'setField',
              targetField: 'customerTier',
              value: 'Enterprise'
            }
          ]
        },
        metadata: {
          estimatedSetupTime: 30,
          popularity: 95,
          benefits: [
            'Eliminate duplicate data entry',
            'Real-time customer information',
            'Reduce manual errors by 95%',
            'Save 10+ hours per week'
          ],
          requirements: [
            'API access to both systems',
            'Admin credentials',
            'Network connectivity'
          ]
        },
        source: 'builtin',
        tags: ['suitecentral', 'customer', 'standard', 'crm'],
        icon: '👥'
      },
      {
        key: 'salesforce-netsuite-customers',
        name: 'Salesforce to NetSuite Customer Sync',
        description: 'Enterprise-grade customer data mapping with address normalization and validation',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        category: 'Customer Management',
        fields: [
          { source: 'Name', target: 'companyname', transformation: 'direct', required: true },
          { source: 'AccountNumber', target: 'entityid', transformation: 'direct', required: true },
          { source: 'Phone', target: 'phone', transformation: 'format', params: { format: '{value}' } },
          { source: 'Website', target: 'url', transformation: 'direct' },
          { source: 'BillingStreet', target: 'billaddr1', transformation: 'direct' },
          { source: 'BillingCity', target: 'billcity', transformation: 'direct' },
          { source: 'BillingState', target: 'billstate', transformation: 'lookup', params: { map: '{"CA":"California","NY":"New York","TX":"Texas"}' } },
          { source: 'BillingPostalCode', target: 'billzip', transformation: 'format', params: { format: '{value}' } },
          { source: 'Type', target: 'category', transformation: 'lookup', params: { map: '{"Customer":"Customer","Partner":"Partner","Prospect":"Lead"}' } },
        ],
        configuration: {
          syncDirection: 'bidirectional',
          syncMode: 'realtime',
          batchSize: 50,
          retryAttempts: 3,
          errorHandling: 'dlq',
          validation: {
            duplicateCheck: true,
            dataIntegrityChecks: true,
            businessRuleValidation: true
          }
        },
        metadata: {
          estimatedSetupTime: 45,
          popularity: 92,
          benefits: [
            'Automatic customer synchronization',
            'Address validation and normalization',
            'Duplicate prevention',
            'Real-time updates'
          ],
          requirements: [
            'Salesforce API access',
            'NetSuite SuiteScript enabled',
            'Field mapping permissions'
          ]
        },
        source: 'builtin',
        tags: ['salesforce', 'netsuite', 'customer', 'crm-erp', 'enterprise'],
        icon: '🔄'
      },
      {
        key: 'payment-processor-sync',
        name: 'Payment Processor to ERP',
        description: 'Sync payment transactions from Stripe, PayPal, or other processors to your ERP',
        sourceSystem: 'Payment Processor',
        targetSystem: 'ERP System',
        category: 'Financial Management',
        fields: [
          { source: 'amount', target: 'amount', transformation: 'decimal', required: true, params: { precision: 2 } },
          { source: 'currency', target: 'currency', transformation: 'uppercase', required: true },
          { source: 'status', target: 'paymentStatus', transformation: 'lookup', required: true, params: { lookupTable: 'payment_status_mapping' } },
          { source: 'customer', target: 'customerEmail', transformation: 'lowercase', required: true },
          { source: 'created', target: 'transactionDate', transformation: 'dateFormat', required: true, params: { format: 'YYYY-MM-DD HH:mm:ss' } },
          { source: 'description', target: 'memo', transformation: 'truncate', params: { maxLength: 200 } }
        ],
        configuration: {
          syncDirection: 'unidirectional',
          syncMode: 'every_5_minutes',
          batchSize: 50,
          errorHandling: 'retry',
          businessRules: [
            {
              name: 'Auto-reconcile small amounts',
              condition: 'amount < 100',
              action: 'setField',
              targetField: 'autoReconcile',
              value: true
            },
            {
              name: 'Flag high-value transactions',
              condition: 'amount > 10000',
              action: 'setField',
              targetField: 'requiresReview',
              value: true
            },
            {
              name: 'Handle refunds',
              condition: 'status == "refunded"',
              action: 'createCreditMemo',
              targetField: 'creditMemoRef'
            }
          ],
          validation: {
            duplicateCheck: true,
            approvalRequired: 'amount > 5000',
            auditLog: true
          }
        },
        metadata: {
          estimatedSetupTime: 45,
          popularity: 88,
          benefits: [
            'Automatic payment reconciliation',
            'Real-time financial reporting',
            'Eliminate manual payment entry',
            'Reduce accounting errors by 99%'
          ],
          requirements: [
            'Payment processor API keys',
            'ERP integration access',
            'Accounting permissions'
          ],
          supportedSources: ['Stripe', 'PayPal', 'Adyen', 'Square', 'Braintree'],
          supportedTargets: ['NetSuite', 'QuickBooks', 'SAP', 'BusinessCentral', 'Oracle']
        },
        source: 'builtin',
        tags: ['payment', 'financial', 'reconciliation', 'accounting'],
        icon: '💰'
      },
      {
        key: 'inventory-multi-location',
        name: 'Multi-Location Inventory Sync',
        description: 'Real-time inventory synchronization across multiple systems and warehouse locations',
        sourceSystem: 'WMS/Inventory System',
        targetSystem: 'E-Commerce/ERP',
        category: 'Inventory Management',
        fields: [
          { source: 'itemId', target: 'sku', transformation: 'uppercase', required: true },
          { source: 'quantityOnHand', target: 'availableQuantity', transformation: 'integer', required: true },
          { source: 'location', target: 'locationCode', transformation: 'lookup', required: true, params: { lookupTable: 'location_mapping' } },
          { source: 'lastUpdated', target: 'lastSyncDate', transformation: 'timestamp', required: true },
          { source: 'reorderPoint', target: 'minQuantity', transformation: 'integer' },
          { source: 'maxStock', target: 'maxQuantity', transformation: 'integer' }
        ],
        configuration: {
          syncDirection: 'bidirectional',
          syncMode: 'every_15_minutes',
          conflictResolution: 'source_wins',
          businessRules: [
            {
              name: 'Low stock alert',
              condition: 'availableQuantity < reorderPoint',
              action: 'createAlert',
              alertType: 'low_stock'
            },
            {
              name: 'Prevent negative inventory',
              condition: 'availableQuantity < 0',
              action: 'setField',
              targetField: 'availableQuantity',
              value: 0
            },
            {
              name: 'Auto-reorder trigger',
              condition: 'availableQuantity <= reorderPoint && autoReorder == true',
              action: 'createPurchaseOrder'
            }
          ],
          validation: {
            dataIntegrityChecks: true,
            businessRuleValidation: true
          }
        },
        metadata: {
          estimatedSetupTime: 60,
          popularity: 85,
          benefits: [
            'Real-time inventory visibility',
            'Prevent overselling',
            'Optimize stock levels',
            'Reduce carrying costs by 25%',
            'Multi-warehouse support'
          ],
          requirements: [
            'Inventory system API access',
            'Location mapping configuration',
            'Real-time data sync capability'
          ],
          supportedSources: ['NetSuite', 'SAP', 'Oracle WMS', 'Manhattan WMS'],
          supportedTargets: ['Shopify', 'Amazon', 'NetSuite', 'BusinessCentral']
        },
        source: 'builtin',
        tags: ['inventory', 'warehouse', 'stock', 'multi-location'],
        icon: '📦'
      },
      {
        key: 'order-to-fulfillment',
        name: 'Order to Fulfillment Pipeline',
        description: 'Complete order processing automation from sale to shipment with tracking',
        sourceSystem: 'E-Commerce/CRM',
        targetSystem: 'ERP/WMS',
        category: 'Order Management',
        fields: [
          { source: 'orderNumber', target: 'salesOrderNumber', transformation: 'direct', required: true },
          { source: 'customerEmail', target: 'billToEmail', transformation: 'lowercase', required: true },
          { source: 'shippingAddress', target: 'shipToAddress', transformation: 'address_parse', required: true },
          { source: 'orderItems', target: 'lineItems', transformation: 'array_map', required: true },
          { source: 'orderTotal', target: 'totalAmount', transformation: 'decimal', required: true, params: { precision: 2 } },
          { source: 'shippingMethod', target: 'shipMethod', transformation: 'lookup', params: { lookupTable: 'shipping_methods' } }
        ],
        configuration: {
          syncDirection: 'unidirectional',
          syncMode: 'realtime',
          errorHandling: 'dlq',
          businessRules: [
            {
              name: 'Expedite high-value orders',
              condition: 'totalAmount > 1000',
              action: 'setField',
              targetField: 'priority',
              value: 'HIGH'
            },
            {
              name: 'Fraud check',
              condition: 'totalAmount > 5000 || isNewCustomer == true',
              action: 'requireApproval',
              targetField: 'fraudReview'
            }
          ]
        },
        workflow: {
          stages: [
            { name: 'Order Validation', actions: ['validate_customer', 'check_inventory', 'verify_payment'] },
            { name: 'Order Processing', actions: ['create_sales_order', 'allocate_inventory', 'generate_pick_list'] },
            { name: 'Fulfillment', actions: ['create_shipment', 'print_labels', 'update_tracking'] },
            { name: 'Post-Fulfillment', actions: ['send_notification', 'update_inventory', 'trigger_invoice'] }
          ],
          triggers: ['order_placed', 'payment_confirmed'],
          notifications: ['order_confirmed', 'shipment_created', 'tracking_updated']
        },
        metadata: {
          estimatedSetupTime: 90,
          popularity: 90,
          benefits: [
            'Reduce order processing time by 80%',
            'Eliminate manual order entry',
            'Improve order accuracy to 99.9%',
            'Real-time order tracking',
            'Automated customer notifications'
          ],
          requirements: [
            'Order system API access',
            'Fulfillment system integration',
            'Inventory availability checks',
            'Shipping carrier integration'
          ],
          supportedSources: ['Salesforce', 'Shopify', 'Amazon', 'WooCommerce', 'Magento'],
          supportedTargets: ['NetSuite', 'SAP', '3PL Systems', 'WMS']
        },
        source: 'builtin',
        tags: ['order', 'fulfillment', 'e-commerce', 'shipping', 'workflow'],
        icon: '🛒'
      },
      {
        key: 'hr-it-sync',
        name: 'HR to IT System Sync',
        description: 'Automate employee provisioning and access management across HR and IT systems',
        sourceSystem: 'HR System',
        targetSystem: 'IT/Identity Management',
        category: 'Human Resources',
        fields: [
          { source: 'employeeId', target: 'userPrincipalName', transformation: 'format', required: true, params: { format: '{employeeId}@company.com' } },
          { source: 'firstName', target: 'givenName', transformation: 'direct', required: true },
          { source: 'lastName', target: 'surname', transformation: 'direct', required: true },
          { source: 'department', target: 'department', transformation: 'lookup', required: true, params: { lookupTable: 'department_mapping' } },
          { source: 'manager', target: 'manager', transformation: 'lookup', params: { lookupTable: 'employee_hierarchy' } },
          { source: 'startDate', target: 'accountActivationDate', transformation: 'dateFormat', required: true },
          { source: 'title', target: 'jobTitle', transformation: 'direct' }
        ],
        configuration: {
          syncDirection: 'unidirectional',
          syncMode: 'every_hour',
          errorHandling: 'alert',
          businessRules: [
            {
              name: 'Auto-provision accounts',
              condition: 'startDate <= today()',
              action: 'createAccount'
            },
            {
              name: 'Assign licenses',
              condition: 'department IN ("Sales", "Marketing")',
              action: 'assignLicense',
              licenseType: 'E3'
            },
            {
              name: 'Termination processing',
              condition: 'status == "terminated"',
              action: 'disableAccount'
            },
            {
              name: 'VIP access',
              condition: 'level >= "Director"',
              action: 'assignGroup',
              value: 'VIP_Access'
            }
          ],
          validation: {
            duplicateCheck: true,
            auditLog: true
          }
        },
        metadata: {
          estimatedSetupTime: 60,
          popularity: 82,
          benefits: [
            'Automatic account provisioning',
            'Consistent access management',
            'Improved security compliance',
            'Reduce IT tickets by 60%',
            'Zero-day employee onboarding'
          ],
          requirements: [
            'HR system API access',
            'Active Directory admin rights',
            'Identity management platform',
            'License management access'
          ],
          supportedSources: ['Workday', 'BambooHR', 'ADP', 'SuccessFactors', 'UltiPro'],
          supportedTargets: ['ActiveDirectory', 'Azure AD', 'Okta', 'Office365', 'Google Workspace']
        },
        source: 'builtin',
        tags: ['hr', 'it', 'provisioning', 'identity', 'security'],
        icon: '👔'
      },
      {
        key: 'data-migration-legacy',
        name: 'Legacy System Migration',
        description: 'Comprehensive data migration framework for moving from legacy systems to modern platforms',
        sourceSystem: 'Legacy System',
        targetSystem: 'Modern Platform',
        category: 'Data Migration',
        fields: [
          { source: 'legacyId', target: 'externalId', transformation: 'direct', required: true, description: 'Preserve legacy ID for reference' },
          { source: 'data', target: 'data', transformation: 'custom', required: true, description: 'Custom transformation logic' }
        ],
        configuration: {
          syncDirection: 'unidirectional',
          syncMode: 'batch',
          batchSize: 1000,
          errorHandling: 'retry',
          validation: {
            recordCountValidation: true,
            dataIntegrityChecks: true,
            businessRuleValidation: true,
            rollbackCapability: true
          }
        },
        workflow: {
          stages: [
            { name: 'Assessment', actions: ['data_profiling', 'quality_assessment', 'mapping_analysis'], duration: 7200 },
            { name: 'Preparation', actions: ['data_cleansing', 'deduplication', 'standardization'], duration: 14400 },
            { name: 'Migration', actions: ['initial_load', 'delta_sync', 'validation'], duration: 28800 },
            { name: 'Cutover', actions: ['final_sync', 'verification', 'go_live'], duration: 3600 }
          ],
          triggers: ['manual', 'scheduled'],
          notifications: ['phase_complete', 'error_threshold', 'migration_complete']
        },
        metadata: {
          estimatedSetupTime: 180,
          popularity: 75,
          benefits: [
            'Zero downtime migration',
            'Data quality improvement',
            'Automated validation and verification',
            'Reduced migration risk',
            'Rollback capability'
          ],
          requirements: [
            'Source system data access',
            'Target system API access',
            'Data mapping documentation',
            'Testing environment',
            'Rollback plan'
          ],
          supportedSources: ['CSV', 'Excel', 'Legacy Database', 'Custom API', 'FTP'],
          supportedTargets: ['NetSuite', 'Salesforce', 'SAP', 'Oracle', 'Microsoft Dynamics']
        },
        source: 'builtin',
        tags: ['migration', 'legacy', 'data', 'transformation', 'enterprise'],
        icon: '🔄'
      }
    ];

    return builtinTemplates;
  }

  private loadCustomTemplates(): UnifiedTemplate[] {
    try {
      if (!fs.existsSync(this.customPath)) {
        return [];
      }
      const content = fs.readFileSync(this.customPath, 'utf8');
      const templates = JSON.parse(content);
      return Array.isArray(templates) ? templates : [];
    } catch (error) {
      logger.error('Error loading custom templates:', error);
      return [];
    }
  }

  private saveCustomTemplates(templates: UnifiedTemplate[]): void {
    try {
      fs.writeFileSync(this.customPath, JSON.stringify(templates, null, 2), 'utf8');
      this.cache = null; // Invalidate cache
    } catch (error) {
      logger.error('Error saving custom templates:', error);
      throw error;
    }
  }

  private getCategories(): TemplateCategory[] {
    return [
      { key: 'customer-management', name: 'Customer Management', icon: '👥', description: 'Customer data synchronization and management', order: 1 },
      { key: 'financial-management', name: 'Financial Management', icon: '💰', description: 'Payment and financial data integration', order: 2 },
      { key: 'inventory-management', name: 'Inventory Management', icon: '📦', description: 'Stock and inventory synchronization', order: 3 },
      { key: 'order-management', name: 'Order Management', icon: '🛒', description: 'Order processing and fulfillment', order: 4 },
      { key: 'vendor-management', name: 'Vendor Management', icon: '🤝', description: 'Supplier and vendor integrations', order: 5 },
      { key: 'human-resources', name: 'Human Resources', icon: '👔', description: 'Employee data synchronization', order: 6 },
      { key: 'data-migration', name: 'Data Migration', icon: '🔄', description: 'Legacy system migrations', order: 7 },
      { key: 'custom', name: 'Custom', icon: '⚙️', description: 'Custom integration templates', order: 8 }
    ];
  }

  public getLibrary(): TemplateLibrary {
    if (this.cache) {
      return this.cache;
    }

    const builtinTemplates = this.loadBuiltinTemplates();
    const customTemplates = this.loadCustomTemplates();
    const allTemplates = [...builtinTemplates, ...customTemplates];
    
    const categories = this.getCategories();
    // Update template counts
    categories.forEach(cat => {
      cat.templateCount = allTemplates.filter(t => 
        t.category?.toLowerCase().replace(/\s+/g, '-') === cat.key
      ).length;
    });

    this.cache = {
      templates: allTemplates,
      categories,
      version: '2.0.0',
      lastUpdated: new Date().toISOString()
    };

    return this.cache;
  }

  public getTemplate(key: string): UnifiedTemplate | undefined {
    const library = this.getLibrary();
    return library.templates.find(t => t.key === key);
  }

  public getTemplatesByCategory(category: string): UnifiedTemplate[] {
    const library = this.getLibrary();
    return library.templates.filter(t => 
      t.category?.toLowerCase().replace(/\s+/g, '-') === category.toLowerCase()
    );
  }

  public searchTemplates(query: string, filters?: {
    category?: string;
    sourceSystem?: string;
    targetSystem?: string;
    tags?: string[];
  }): UnifiedTemplate[] {
    const library = this.getLibrary();
    let results = library.templates;

    // Text search
    if (query) {
      const searchTerm = query.toLowerCase();
      results = results.filter(t =>
        t.name.toLowerCase().includes(searchTerm) ||
        t.description.toLowerCase().includes(searchTerm) ||
        t.sourceSystem?.toLowerCase().includes(searchTerm) ||
        t.targetSystem?.toLowerCase().includes(searchTerm) ||
        t.tags?.some(tag => tag.toLowerCase().includes(searchTerm))
      );
    }

    // Apply filters
    if (filters) {
      if (filters.category) {
        results = results.filter(t => 
          t.category?.toLowerCase().replace(/\s+/g, '-') === filters.category!.toLowerCase()
        );
      }
      if (filters.sourceSystem) {
        results = results.filter(t => t.sourceSystem === filters.sourceSystem);
      }
      if (filters.targetSystem) {
        results = results.filter(t => t.targetSystem === filters.targetSystem);
      }
      if (filters.tags && filters.tags.length > 0) {
        results = results.filter(t =>
          filters.tags!.every(tag => t.tags?.includes(tag))
        );
      }
    }

    return results;
  }

  public createTemplate(template: Partial<UnifiedTemplate>): UnifiedTemplate {
    if (!template.name || !template.fields || template.fields.length === 0) {
      throw new Error('Template must have a name and at least one field mapping');
    }

    const key = template.key || template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const customTemplates = this.loadCustomTemplates();
    
    const newTemplate: UnifiedTemplate = {
      key,
      name: template.name,
      description: template.description || '',
      sourceSystem: template.sourceSystem || 'Custom',
      targetSystem: template.targetSystem || 'Custom',
      fields: template.fields,
      category: template.category || 'custom',
      tags: template.tags || [],
      source: 'custom',
      configuration: template.configuration,
      metadata: {
        ...template.metadata,
        createdBy: 'user',
        lastModified: new Date().toISOString(),
        version: '1.0.0'
      },
      workflow: template.workflow
    };

    // Check for duplicate key
    const existingIndex = customTemplates.findIndex(t => t.key === key);
    if (existingIndex >= 0) {
      customTemplates[existingIndex] = newTemplate;
    } else {
      customTemplates.push(newTemplate);
    }

    this.saveCustomTemplates(customTemplates);
    return newTemplate;
  }

  public updateTemplate(key: string, updates: Partial<UnifiedTemplate>): UnifiedTemplate {
    const customTemplates = this.loadCustomTemplates();
    const index = customTemplates.findIndex(t => t.key === key);
    
    if (index === -1) {
      throw new Error(`Template with key "${key}" not found or is not editable`);
    }

    const existing = customTemplates[index]!; // Non-null assertion since we checked index
    const updated = {
      ...existing,
      ...updates,
      key: existing.key, // Preserve original key
      source: 'custom' as const,
      metadata: {
        ...existing.metadata,
        ...updates.metadata,
        lastModified: new Date().toISOString(),
        version: this.incrementVersion(existing.metadata?.version || '1.0.0')
      }
    } as UnifiedTemplate;

    customTemplates[index] = updated;
    this.saveCustomTemplates(customTemplates);
    return updated;
  }

  public deleteTemplate(key: string): boolean {
    const customTemplates = this.loadCustomTemplates();
    const index = customTemplates.findIndex(t => t.key === key);
    
    if (index === -1) {
      return false;
    }

    customTemplates.splice(index, 1);
    this.saveCustomTemplates(customTemplates);
    return true;
  }

  public importTemplates(templates: UnifiedTemplate[]): { imported: number; errors: string[] } {
    const customTemplates = this.loadCustomTemplates();
    const templateMap = new Map(customTemplates.map(t => [t.key, t]));
    const errors: string[] = [];
    let imported = 0;

    for (const template of templates) {
      try {
        if (!template.name || !template.fields || template.fields.length === 0) {
          errors.push(`Invalid template: ${template.name || 'unnamed'}`);
          continue;
        }

        const importedTemplate: UnifiedTemplate = {
          ...template,
          source: 'custom',
          metadata: {
            ...template.metadata,
            lastModified: new Date().toISOString()
          }
        };

        templateMap.set(template.key, importedTemplate);
        imported++;
      } catch (error) {
        errors.push(`Failed to import ${template.name}: ${error}`);
      }
    }

    this.saveCustomTemplates(Array.from(templateMap.values()));
    return { imported, errors };
  }

  public exportTemplates(keys?: string[]): UnifiedTemplate[] {
    const library = this.getLibrary();
    if (!keys || keys.length === 0) {
      return library.templates;
    }
    return library.templates.filter(t => keys.includes(t.key));
  }

  private incrementVersion(version: string): string {
    const parts = version.split('.');
    const patch = parseInt(parts[2] || '0', 10);
    return `${parts[0] || '1'}.${parts[1] || '0'}.${patch + 1}`;
  }

  // Convert old format to unified format
  public migrateOldTemplate(oldTemplate: unknown): UnifiedTemplate {
    // Legacy template shape — captures both pre-unified field names
    // (`id`, `fieldMappings`, top-level `supportedSources`/`benefits`/etc.)
    // and current unified names. Every property optional so callers can pass
    // a partial / empty object; tests in UnifiedTemplateServiceExtended.test.ts
    // exercise both `migrateOldTemplate({})` and the full shape.
    interface LegacyTemplate {
      key?: string;
      id?: string;
      name?: string;
      description?: string;
      sourceSystem?: string;
      targetSystem?: string;
      // Loosened to Partial<FieldMapping>[] — the migrate test fixtures pass
      // legacy items as `{ source, target }` without the required
      // `transformation`, so claiming `FieldMapping[]` would be a false safety
      // assertion. Callers downstream already accept this looseness — the
      // resulting UnifiedTemplate's `fields` is built via a passthrough that
      // doesn't read `transformation`.
      fields?: Partial<FieldMapping>[];
      fieldMappings?: Partial<FieldMapping>[];
      category?: string;
      tags?: string[];
      configuration?: TemplateConfiguration;
      metadata?: Record<string, unknown>;
      estimatedSetupTime?: number;
      popularity?: number;
      benefits?: string[];
      requirements?: string[];
      supportedSources?: string[];
      supportedTargets?: string[];
      workflow?: UnifiedTemplate['workflow'];
    }
    // Reject non-object payloads (null, undefined, primitives, arrays) up front
    // so /api/unified-templates/migrate fails fast on bad client input instead
    // of fabricating a default template. The pre-tranche `(oldTemplate as any)
    // .key` access threw on null/undefined too — this preserves that contract.
    if (oldTemplate === null || typeof oldTemplate !== 'object' || Array.isArray(oldTemplate)) {
      throw new TypeError('migrateOldTemplate: oldTemplate must be a non-null object');
    }
    const legacy = oldTemplate as LegacyTemplate;

    return {
      key: legacy.key || legacy.id || 'migrated-' + Date.now(),
      name: legacy.name || 'Migrated Template',
      description: legacy.description || '',
      sourceSystem: legacy.sourceSystem || legacy.supportedSources?.[0] || 'Unknown',
      targetSystem: legacy.targetSystem || legacy.supportedTargets?.[0] || 'Unknown',
      // Cast back to FieldMapping[] at the construction boundary — the
      // legacy interface admits partial shape (existing migrate tests pass
      // `{ source, target }` without the required `transformation`), and the
      // pre-tranche code passed those through unchanged. Tightening the
      // public FieldMapping type or synthesizing `transformation: 'direct'`
      // defaults is out of scope for this tranche.
      fields: (legacy.fields || legacy.fieldMappings || []) as FieldMapping[],
      category: legacy.category || 'custom',
      tags: legacy.tags || [],
      source: 'custom',
      configuration: legacy.configuration || {
        syncDirection: 'unidirectional',
        syncMode: 'realtime'
      },
      metadata: {
        ...legacy.metadata,
        estimatedSetupTime: legacy.estimatedSetupTime,
        popularity: legacy.popularity,
        benefits: legacy.benefits,
        requirements: legacy.requirements,
        supportedSources: legacy.supportedSources,
        supportedTargets: legacy.supportedTargets,
        lastModified: new Date().toISOString(),
        version: '1.0.0'
      },
      workflow: legacy.workflow
    };
  }
}

export const unifiedTemplateService = new UnifiedTemplateService();
