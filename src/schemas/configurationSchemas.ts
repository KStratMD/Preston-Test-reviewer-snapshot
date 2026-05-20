import { z } from 'zod';

// Authentication Schema
const AuthenticationCredentialsSchema = z.record(z.string(), z.any()).refine(
  (credentials) => {
    // Must have at least one credential field
    return Object.keys(credentials).length > 0;
  },
  {
    message: 'Authentication credentials cannot be empty',
  },
);

const AuthenticationConfigSchema = z.object({
  type: z.enum(['oauth1', 'oauth2', 'api_key', 'basic', 'token'], {
    message: 'Authentication type must be one of: oauth1, oauth2, api_key, basic, token',
  }),
  credentials: AuthenticationCredentialsSchema,
  refreshable: z.boolean().optional(),
  expiresAt: z.coerce.date().optional(),
});

// Field Mapping Schema
const FieldMappingSchema = z.object({
  sourceField: z.string().min(1, 'Source field cannot be empty'),
  targetField: z.string().min(1, 'Target field cannot be empty'),
  transformationType: z.enum(['direct', 'concatenate', 'concatenation', 'split', 'lookup', 'expression', 'conditional', 'calculation'], {
    message: 'Invalid transformation type',
  }),
  isRequired: z.boolean(),
  defaultValue: z.any().optional(),
  transformationConfig: z.object({
    type: z.string().optional(),
    fields: z.array(z.string()).optional(),
    separator: z.string().optional(),
    lookupTable: z.string().optional(),
    keyField: z.string().optional(),
    valueField: z.string().optional(),
    expression: z.string().optional(),
  }).optional(),
});

// Validation Rule Schema
const ValidationRuleSchema = z.object({
  field: z.string().min(1, 'Field name is required'),
  type: z.enum(['required', 'pattern', 'length', 'range', 'custom', 'format'], {
    message: 'Invalid validation rule type',
  }),
  value: z.object({
    pattern: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
  message: z.string().min(1, 'Validation message is required'),
});

// Transformation Rule Schema
const TransformationRuleSchema = z.object({
  id: z.string().min(1, 'Transformation rule ID is required'),
  name: z.string().min(1, 'Transformation rule name is required'),
  type: z.enum([
    'conditional_logic', 'data_validation', 'data_enrichment', 'business_logic',
    'field_mapping', 'enrichment', 'VALIDATION', 'TRANSFORMATION', 'ENRICHMENT', 'FILTER',
  ], {
    message: 'Invalid transformation rule type',
  }),
  condition: z.string().optional(),
  action: z.enum([
    'set_field_value', 'validate_field', 'calculate_field', 'transform', 'validate',
    'enrich', 'filter', 'reject', 'conditional_mapping', 'set_default_value',
    'validate_required', 'derive_account_type', 'validate_email_format',
  ], {
    message: 'Invalid transformation rule action',
  }),
  parameters: z.object({
    targetField: z.string().optional(),
    field: z.string().optional(),
    validationType: z.string().optional(),
    validationConfig: z.object({
      pattern: z.string().optional(),
    }).optional(),
    conditions: z.array(z.object({
      field: z.string(),
      operator: z.enum(['equals', 'greater_than', 'less_than', 'greater_equal', 'less_equal', 'contains']),
      value: z.any(),
      result: z.any(),
    })).optional(),
    defaultValue: z.any().optional(),
    calculation: z.string().optional(),
    sourceField: z.string().optional(),
    referenceDate: z.string().optional(),
    unit: z.string().optional(),
    type: z.string().optional(),
    rules: z.array(ValidationRuleSchema).optional(),
    expression: z.string().optional(),
    context: z.record(z.string(), z.any()).optional(),
  }).optional(),
});

// Retry Configuration Schema
const RetryConfigSchema = z.object({
  maxRetries: z.number().int().min(0).max(10, 'Maximum retries cannot exceed 10'),
  retryDelay: z.number().int().min(100, 'Retry delay must be at least 100ms').max(60000, 'Retry delay cannot exceed 60 seconds'),
  backoffStrategy: z.enum(['linear', 'exponential'], {
    message: 'Backoff strategy must be either \'linear\' or \'exponential\'',
  }),
});

// Main Integration Configuration Schema
export const IntegrationConfigSchema = z.object({
  id: z.string()
    .min(1, 'Configuration ID is required')
    .max(100, 'Configuration ID cannot exceed 100 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Configuration ID must contain only alphanumeric characters, underscores, and hyphens'),

  name: z.string()
    .min(1, 'Configuration name is required')
    .max(200, 'Configuration name cannot exceed 200 characters'),

  description: z.string()
    .max(1000, 'Description cannot exceed 1000 characters')
    .optional(),

  sourceSystem: z.string()
    .min(1, 'Source system is required')
    .max(50, 'Source system name cannot exceed 50 characters'),

  targetSystem: z.string()
    .min(1, 'Target system is required')
    .max(50, 'Target system name cannot exceed 50 characters'),

  sourceEntity: z.string()
    .min(1, 'Source entity is required')
    .max(100, 'Source entity name cannot exceed 100 characters'),

  targetEntity: z.string()
    .min(1, 'Target entity is required')
    .max(100, 'Target entity name cannot exceed 100 characters'),

  syncDirection: z.enum(['unidirectional', 'bidirectional', 'source_to_target', 'target_to_source'], {
    message: 'Sync direction must be one of: unidirectional, bidirectional, source_to_target, target_to_source',
  }),

  syncMode: z.enum(['realtime', 'batch', 'manual'], {
    message: 'Sync mode must be one of: realtime, batch, manual',
  }),

  isActive: z.boolean(),

  fieldMappings: z.array(FieldMappingSchema)
    .max(100, 'Cannot have more than 100 field mappings')
    .optional()
    .default([]),

  transformationRules: z.array(TransformationRuleSchema)
    .max(50, 'Cannot have more than 50 transformation rules')
    .optional()
    .default([]),

  sourceAuthentication: AuthenticationConfigSchema,

  targetAuthentication: AuthenticationConfigSchema.optional(),

  batchSize: z.number()
    .int()
    .min(1, 'Batch size must be at least 1')
    .max(10000, 'Batch size cannot exceed 10,000')
    .optional()
    .default(100),

  retryConfig: RetryConfigSchema.optional(),

  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
}).refine(
  (config) => {
    // Custom validation: bidirectional sync requires target authentication
    if (config.syncDirection === 'bidirectional' && !config.targetAuthentication) {
      return false;
    }
    return true;
  },
  {
    message: 'Bidirectional sync requires target authentication configuration',
    path: ['targetAuthentication'],
  },
).refine(
  (config) => {
    // Custom validation: source and target systems cannot be the same
    if (config.sourceSystem === config.targetSystem) {
      return false;
    }
    return true;
  },
  {
    message: 'Source and target systems cannot be the same',
    path: ['targetSystem'],
  },
).refine(
  (config) => {
    // Custom validation: active configurations require at least one field mapping
    if (config.isActive && (!config.fieldMappings || config.fieldMappings.length === 0)) {
      return false;
    }
    return true;
  },
  {
    message: 'Active configurations must have at least one field mapping',
    path: ['fieldMappings'],
  },
).refine(
  (config) => {
    // Custom validation: validate field mapping references
    // Only check if there are field mappings
    if (!config.fieldMappings || config.fieldMappings.length === 0) {
      return true;
    }

    const sourceFields = config.fieldMappings.map(m => m.sourceField);
    const targetFields = config.fieldMappings.map(m => m.targetField);

    // Check for duplicate source fields
    const uniqueSourceFields = new Set(sourceFields);
    if (uniqueSourceFields.size !== sourceFields.length) {
      return false;
    }

    // Check for duplicate target fields
    const uniqueTargetFields = new Set(targetFields);
    if (uniqueTargetFields.size !== targetFields.length) {
      return false;
    }

    return true;
  },
  {
    message: 'Field mappings cannot have duplicate source or target fields',
    path: ['fieldMappings'],
  },
);

// OAuth2 Specific Schema
export const OAuth2ConfigSchema = z.object({
  type: z.literal('oauth2'),
  credentials: z.object({
    clientId: z.string().min(1, 'Client ID is required'),
    clientSecret: z.string().min(1, 'Client secret is required'),
    tenantId: z.string().optional(),
    resourceUrl: z.string().url('Resource URL must be a valid URL').optional(),
    baseUrl: z.string().url('Base URL must be a valid URL').optional(),
    scope: z.string().optional(),
    tokenUrl: z.string().url('Token URL must be a valid URL').optional(),
  }),
});

// OAuth1 Specific Schema (for NetSuite)
export const OAuth1ConfigSchema = z.object({
  type: z.literal('oauth1'),
  credentials: z.object({
    consumerKey: z.string().min(1, 'Consumer key is required'),
    consumerSecret: z.string().min(1, 'Consumer secret is required'),
    tokenId: z.string().min(1, 'Token ID is required'),
    tokenSecret: z.string().min(1, 'Token secret is required'),
    accountId: z.string().min(1, 'Account ID is required'),
    baseUrl: z.string().url('Base URL must be a valid URL').optional(),
  }),
});

// API Key Schema
export const ApiKeyConfigSchema = z.object({
  type: z.literal('api_key'),
  credentials: z.object({
    apiKey: z.string().min(1, 'API key is required'),
    username: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }),
});

// Basic Auth Schema
export const BasicAuthConfigSchema = z.object({
  type: z.literal('basic'),
  credentials: z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }),
});

// Squire and SuiteCentral schemas use API key authentication
export const SuiteCentralConfigSchema = ApiKeyConfigSchema;
export const SquireConfigSchema = ApiKeyConfigSchema;

// System-specific validation schemas
export const SystemSpecificSchemas = {
  NetSuite: OAuth1ConfigSchema,
  Salesforce: OAuth2ConfigSchema,
  'Dynamics365': OAuth2ConfigSchema,
  SAP: z.union([BasicAuthConfigSchema, ApiKeyConfigSchema]),
  Oracle: z.union([BasicAuthConfigSchema, ApiKeyConfigSchema]),
  BusinessCentral: OAuth2ConfigSchema,
  SuiteCentral: SuiteCentralConfigSchema,
  Squire: SquireConfigSchema,
} as const;

// Configuration validation result
export interface ConfigurationValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  fieldErrors?: Record<string, string[]>;
}

// Validation helper functions
export function validateIntegrationConfig(config: unknown): ConfigurationValidationResult {
  const result = IntegrationConfigSchema.safeParse(config);

  if (result.success) {
    return {
      isValid: true,
      errors: [],
      warnings: [],
    };
  }

  const errors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};

  result.error.issues.forEach(issue => {
    const path = issue.path.join('.');
    const message = issue.message;

    errors.push(path ? `${path}: ${message}` : message);

    if (issue.path.length > 0 && issue.path[0] !== undefined) {
      const fieldPath = issue.path[0].toString();
      if (!fieldErrors[fieldPath]) {
        fieldErrors[fieldPath] = [];
      }
      fieldErrors[fieldPath].push(message);
    }
  });

  return {
    isValid: false,
    errors,
    warnings: [],
    fieldErrors,
  };
}

export function validateSystemAuthentication(systemType: string, authConfig: unknown): ConfigurationValidationResult {
  const schema = SystemSpecificSchemas[systemType as keyof typeof SystemSpecificSchemas];

  if (!schema) {
    return {
      isValid: false,
      errors: [`Unsupported system type: ${systemType}`],
      warnings: [],
    };
  }

  const result = schema.safeParse(authConfig);

  if (result.success) {
    return {
      isValid: true,
      errors: [],
      warnings: [],
    };
  }

  const errors: string[] = [];
  result.error.issues.forEach(issue => {
    const path = issue.path.join('.');
    errors.push(path ? `${path}: ${issue.message}` : issue.message);
  });

  return {
    isValid: false,
    errors,
    warnings: [],
  };
}

// Type inference helpers
export type IntegrationConfigType = z.infer<typeof IntegrationConfigSchema>;
export type OAuth2ConfigType = z.infer<typeof OAuth2ConfigSchema>;
export type OAuth1ConfigType = z.infer<typeof OAuth1ConfigSchema>;
export type ApiKeyConfigType = z.infer<typeof ApiKeyConfigSchema>;
export type BasicAuthConfigType = z.infer<typeof BasicAuthConfigSchema>;
