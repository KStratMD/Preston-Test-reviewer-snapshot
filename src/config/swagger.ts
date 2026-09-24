import swaggerJSDoc, { type Options } from 'swagger-jsdoc';

const options: Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Business Systems Integration Hub API',
      version: '1.0.0',
      description: 'A comprehensive middleware platform for synchronizing data between various business systems',
      contact: {
        name: 'API Support',
        email: 'support@integrationhub.com',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: process.env.API_BASE_URL || 'http://localhost:3000',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'message'],
          properties: {
            error: {
              type: 'string',
              description: 'Error code',
            },
            message: {
              type: 'string',
              description: 'Human-readable error message',
            },
            details: {
              type: 'array',
              items: { type: 'string' },
              description: 'Additional error details',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              description: 'Error timestamp',
            },
          },
        },
        HealthStatus: {
          type: 'object',
          required: ['status', 'timestamp'],
          properties: {
            status: {
              type: 'string',
              enum: ['healthy', 'degraded', 'unhealthy'],
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
            uptime: {
              type: 'string',
              description: 'Server uptime in seconds',
            },
            services: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['connected', 'disconnected', 'error'],
                  },
                  responseTime: {
                    type: 'number',
                    description: 'Response time in milliseconds',
                  },
                },
              },
            },
          },
        },
        IntegrationConfig: {
          type: 'object',
          required: ['id', 'name', 'sourceSystem', 'targetSystem', 'syncDirection', 'syncMode'],
          properties: {
            id: {
              type: 'string',
              pattern: '^[a-zA-Z0-9_-]+$',
              description: 'Unique integration identifier',
            },
            name: {
              type: 'string',
              maxLength: 100,
              description: 'Human-readable integration name',
            },
            sourceSystem: {
              type: 'string',
              enum: ['NetSuite', 'Dynamics365', 'Salesforce', 'BusinessCentral'],
            },
            targetSystem: {
              type: 'string',
              enum: ['NetSuite', 'Dynamics365', 'Salesforce', 'BusinessCentral'],
            },
            syncDirection: {
              type: 'string',
              enum: ['unidirectional', 'bidirectional'],
            },
            syncMode: {
              type: 'string',
              enum: ['batch', 'realtime', 'manual'],
            },
            isActive: {
              type: 'boolean',
              default: true,
            },
            fieldMappings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['sourceField', 'targetField'],
                properties: {
                  sourceField: { type: 'string' },
                  targetField: { type: 'string' },
                  transformationType: {
                    type: 'string',
                    enum: ['direct', 'lookup', 'calculation', 'concatenation'],
                  },
                  isRequired: { type: 'boolean', default: false },
                  defaultValue: { type: 'string' },
                },
              },
            },
            transformationRules: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'type'],
                properties: {
                  id: { type: 'string' },
                  type: {
                    type: 'string',
                    enum: ['field_mapping', 'data_validation', 'business_logic', 'enrichment'],
                  },
                  condition: { type: 'string' },
                  parameters: { type: 'object' },
                },
              },
            },
          },
        },
        DataRecord: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            externalId: { type: 'string' },
            fields: {
              type: 'object',
              additionalProperties: true,
            },
            metadata: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                lastModified: { type: 'string', format: 'date-time' },
                version: { type: 'string' },
              },
            },
          },
        },
        IntegrationRun: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', default: false },
            batchSize: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
            filters: { type: 'object' },
          },
        },
        SyncResult: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            recordsProcessed: { type: 'integer' },
            recordsSucceeded: { type: 'integer' },
            recordsFailed: { type: 'integer' },
            errors: {
              type: 'array',
              items: { type: 'string' },
            },
            duration: { type: 'number', description: 'Duration in milliseconds' },
          },
        },
      },
    },
    security: [
      { bearerAuth: [] },
      { apiKeyAuth: [] },
    ],
  },
  apis: [
    './src/routes/*.ts',
    './src/index.ts',
  ],
};

export type SwaggerSpec = Record<string, unknown>;

/**
 * Always generated with `failOnErrors: true`. Without it swagger-jsdoc reports
 * a parse failure on stdout and returns a spec missing that route, so a broken
 * annotation reads downstream as an endpoint that was never documented.
 */
export function buildSwaggerSpec(overrides: Partial<Pick<Options, 'apis'>> = {}): SwaggerSpec {
  return swaggerJSDoc({ ...options, ...overrides, failOnErrors: true });
}

export const swaggerSpec: SwaggerSpec = buildSwaggerSpec();
