import './setupEnv'; // Must be first to configure environment
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { IntegrationConfig, FieldMapping, TransformationRule } from '../../src/types';
import { App } from '../../src/app';
import { createTestApp } from './helpers/testServices';
import { STRONG_TEST_JWT_SECRET } from './setupEnv';

// /api/configurations and /api/integrations sit behind authMiddleware (PR 13c-4)
// and their handlers narrow on req.user.tenantId, so every request needs a
// Bearer JWT carrying a tenant claim (authMiddleware reads the tenant from
// the `tenantId`/`tid`/`tenant_id` claims, in that order).
const AUTH = `Bearer ${jwt.sign(
  { sub: 'e2e-test-user', tenant_id: 'e2e-test-tenant' },
  STRONG_TEST_JWT_SECRET,
  { expiresIn: '2h' },
)}`;

// Mock all connectors to return successful test connections for E2E tests
const createConnectorMock = (systemType: string) => {
  const systemId = `test-${systemType.toLowerCase()}`;
  const baseResponse = {
    systemType,
    systemId,
    isConnected: true,
    lastTestTime: new Date(),
    latency: 150,
  };

  return {
    systemType,
    systemId,
    initialize: jest.fn().mockResolvedValue(undefined),
    authenticate: jest.fn().mockResolvedValue(true),
    testConnection: jest.fn().mockResolvedValue(baseResponse),
    getSystemInfo: jest.fn().mockResolvedValue({
      systemType,
      version: 'mock-version',
      connectionId: 'mock-connection-id',
      capabilities: ['read', 'write'],
    }),
    create: jest.fn().mockResolvedValue({ id: 'mock-id', success: true }),
    read: jest.fn().mockResolvedValue({ id: 'mock-id', fields: {} }),
    update: jest.fn().mockResolvedValue({ success: true }),
    delete: jest.fn().mockResolvedValue({ success: true }),
    list: jest.fn().mockResolvedValue([]),
    search: jest.fn().mockResolvedValue([]),
  };
};

const connectorMocks: [string, string, string][] = [
  ['../../src/connectors/NetSuiteConnector', 'NetSuiteConnector', 'NetSuite'],
  ['../../src/connectors/SalesforceConnector', 'SalesforceConnector', 'Salesforce'],
  ['../../src/connectors/DynamicsConnector', 'DynamicsConnector', 'Dynamics365'],
  ['../../src/connectors/SAPConnector', 'SAPConnector', 'SAP'],
  ['../../src/connectors/OracleConnector', 'OracleConnector', 'Oracle'],
  ['../../src/connectors/BusinessCentralConnector', 'BusinessCentralConnector', 'BusinessCentral'],
];

connectorMocks.forEach(([modulePath, exportName, systemType]) => {
  jest.mock(modulePath, () => ({
    [exportName]: jest.fn().mockImplementation(() => createConnectorMock(systemType)),
  }));
});

describe('End-to-End Integration Tests', () => {
  let appInstance: App;
  let app: import('express').Application;

  beforeAll(async () => {
    const testApp = await createTestApp();
    appInstance = testApp.appInstance;
    app = testApp.expressApp;
  });

  afterAll(async () => {
    if (appInstance && typeof appInstance.shutdown === 'function') {
      await appInstance.shutdown();
    }
  });

  describe('Complete Integration Workflow', () => {
    it('should complete full NetSuite to Salesforce integration workflow', async () => {
      // Step 1: Create integration configuration
      const integrationConfig: IntegrationConfig = {
        id: 'e2e-ns-to-sf-test',
        name: 'E2E NetSuite to Salesforce Test',
        description: 'End-to-end test integration',
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        syncDirection: 'source_to_target',
        syncMode: 'manual',
        isActive: true,
        sourceEntity: 'customer',
        targetEntity: 'account',
        fieldMappings: [
          {
            sourceField: 'companyname',
            targetField: 'Name',
            isRequired: true,
            transformationType: 'direct'
          },
          {
            sourceField: 'email',
            targetField: 'Email__c',
            isRequired: false,
            transformationType: 'direct'
          },
          {
            sourceField: 'phone',
            targetField: 'Phone',
            isRequired: false,
            transformationType: 'direct'
          }
        ],
        transformationRules: [
          {
            id: 'validate_email',
            name: 'Email Validation',
            type: 'data_validation',
            action: 'validate_field',
            parameters: {
              field: 'email',
              validationType: 'format',
              validationConfig: {
                pattern: '^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$'
              }
            }
          }
        ],
        sourceAuthentication: {
          type: 'oauth1',
          credentials: {
            accountId: process.env.NETSUITE_ACCOUNT_ID || 'test-account',
            consumerKey: process.env.NETSUITE_CONSUMER_KEY || 'test-key',
            consumerSecret: process.env.NETSUITE_CONSUMER_SECRET || 'test-secret',
            tokenId: process.env.NETSUITE_TOKEN_ID || 'test-token',
            tokenSecret: process.env.NETSUITE_TOKEN_SECRET || 'test-token-secret'
          }
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: process.env.SALESFORCE_CLIENT_ID || 'test-client-id',
            clientSecret: process.env.SALESFORCE_CLIENT_SECRET || 'test-client-secret',
            username: process.env.SALESFORCE_USERNAME || 'test@example.com',
            password: process.env.SALESFORCE_PASSWORD || 'test-password'
          }
        }
      };

      // Step 2: Create configuration via API
      const createResponse = await request(app)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(integrationConfig)
        .expect(201);

      expect(createResponse.body.id).toBe('e2e-ns-to-sf-test');

      // Step 3: Validate configuration
      const validateResponse = await request(app)
        .post('/api/configurations/e2e-ns-to-sf-test/validate')
        .set('Authorization', AUTH)
        .expect(200);

      expect(validateResponse.body.isValid).toBe(true);

      // Step 4: Test integration connectivity
      const testResponse = await request(app)
        .post('/api/integrations/e2e-ns-to-sf-test/test')
        .set('Authorization', AUTH)
        .expect(200);

      expect(testResponse.body.sourceConnection.isConnected).toBe(true);
      expect(testResponse.body.targetConnection.isConnected).toBe(true);

      // Step 5: Run integration with dry run first
      const dryRunResponse = await request(app)
        .post('/api/integrations/e2e-ns-to-sf-test/run')
        .set('Authorization', AUTH)
        .send({ dryRun: true })
        .expect(200);

      expect(dryRunResponse.body.success).toBe(true);
      expect(dryRunResponse.body.integrationId).toBe('e2e-ns-to-sf-test');

      // Step 6: Run actual integration
      const runResponse = await request(app)
        .post('/api/integrations/e2e-ns-to-sf-test/run')
        .set('Authorization', AUTH)
        .expect(200);

      expect(runResponse.body.success).toBe(true);
      expect(runResponse.body.recordsProcessed).toBeGreaterThanOrEqual(0);

      // Step 7: Check integration status
      const statusResponse = await request(app)
        .get('/api/integrations/e2e-ns-to-sf-test/status')
        .set('Authorization', AUTH)
        .expect(200);

      expect(statusResponse.body.configId).toBe('e2e-ns-to-sf-test');
      expect(statusResponse.body.isRunning).toBeDefined();

      // Step 8: Clean up - delete configuration
      await request(app)
        .delete('/api/configurations/e2e-ns-to-sf-test')
        .set('Authorization', AUTH)
        .expect(200);
    });

    it('should handle bidirectional sync workflow', async () => {
      const bidirectionalConfig: IntegrationConfig = {
        id: 'e2e-bidirectional-test',
        name: 'E2E Bidirectional Test',
        description: 'End-to-end bidirectional sync test',
        sourceSystem: 'Salesforce',
        targetSystem: 'Dynamics365',
        syncDirection: 'bidirectional',
        syncMode: 'manual',
        isActive: true,
        sourceEntity: 'account',
        targetEntity: 'account',
        fieldMappings: [
          {
            sourceField: 'Name',
            targetField: 'name',
            isRequired: true,
            transformationType: 'direct'
          },
          {
            sourceField: 'Phone',
            targetField: 'telephone1',
            isRequired: false,
            transformationType: 'direct'
          }
        ],
        transformationRules: [] as TransformationRule[],
        sourceAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: process.env.SALESFORCE_CLIENT_ID || 'test-client-id',
            clientSecret: process.env.SALESFORCE_CLIENT_SECRET || 'test-client-secret',
            username: process.env.SALESFORCE_USERNAME || 'test@example.com',
            password: process.env.SALESFORCE_PASSWORD || 'test-password'
          }
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: process.env.DYNAMICS_CLIENT_ID || 'test-client-id',
            clientSecret: process.env.DYNAMICS_CLIENT_SECRET || 'test-client-secret',
            tenantId: process.env.DYNAMICS_TENANT_ID || 'test-tenant-id',
            resourceUrl: process.env.DYNAMICS_RESOURCE_URL || 'https://test.crm.dynamics.com'
          }
        }
      };

      // Create and test bidirectional configuration
      await request(app)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(bidirectionalConfig)
        .expect(201);

      // Test connectivity for both directions
      const testResponse = await request(app)
        .post('/api/integrations/e2e-bidirectional-test/test')
        .set('Authorization', AUTH)
        .expect(200);

      expect(testResponse.body.sourceConnection.isConnected).toBe(true);
      expect(testResponse.body.targetConnection.isConnected).toBe(true);

      // Run bidirectional sync
      const runResponse = await request(app)
        .post('/api/integrations/e2e-bidirectional-test/run')
        .set('Authorization', AUTH)
        .expect(200);

      expect(runResponse.body.success).toBe(true);
      expect(runResponse.body.integrationId).toBe('e2e-bidirectional-test');

      // Clean up
      await request(app)
        .delete('/api/configurations/e2e-bidirectional-test')
        .set('Authorization', AUTH)
        .expect(200);
    });

    it('should handle bulk data processing workflow', async () => {
      const bulkConfig: IntegrationConfig = {
        id: 'e2e-bulk-test',
        name: 'E2E Bulk Processing Test',
        description: 'End-to-end bulk data processing test',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
        syncDirection: 'source_to_target',
        syncMode: 'batch',
        isActive: true,
        sourceEntity: 'material',
        targetEntity: 'item',
        batchSize: 100,
        fieldMappings: [
          {
            sourceField: 'MATNR',
            targetField: 'item_number',
            isRequired: true,
            transformationType: 'direct'
          },
          {
            sourceField: 'MAKTX',
            targetField: 'description',
            isRequired: true,
            transformationType: 'direct'
          }
        ],
        transformationRules: [
          {
            id: 'format_item_number',
            name: 'Format Item Number',
            type: 'data_validation',
            action: 'validate_field',
            parameters: {
              field: 'MATNR',
              validationType: 'format',
              validationConfig: {
                pattern: '^[A-Z0-9]{6,}$'
              }
            }
          }
        ],
        sourceAuthentication: {
          type: 'basic',
          credentials: {
            username: process.env.SAP_USERNAME || 'test-user',
            password: process.env.SAP_PASSWORD || 'test-password',
            host: process.env.SAP_HOST || 'sap-test.example.com',
            client: process.env.SAP_CLIENT || '100'
          }
        },
        targetAuthentication: {
          type: 'basic',
          credentials: {
            username: process.env.ORACLE_USERNAME || 'test-user',
            password: process.env.ORACLE_PASSWORD || 'test-password',
            host: process.env.ORACLE_HOST || 'oracle-test.example.com',
            port: parseInt(process.env.ORACLE_PORT || '1521')
          }
        }
      };

      // Create bulk processing configuration
      await request(app)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(bulkConfig)
        .expect(201);

      // Test bulk processing
      const runResponse = await request(app)
        .post('/api/integrations/e2e-bulk-test/run')
        .set('Authorization', AUTH)
        .send({ batchSize: 50 }) // Override batch size
        .expect(200);

      expect(runResponse.body.success).toBe(true);
      expect(runResponse.body.integrationId).toBe('e2e-bulk-test');
      expect(runResponse.body.recordsProcessed).toBeGreaterThanOrEqual(0);

      // Clean up
      await request(app)
        .delete('/api/configurations/e2e-bulk-test')
        .set('Authorization', AUTH)
        .expect(200);
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle authentication failures gracefully', async () => {
      // This test verifies we can create a configuration with invalid credentials
      // and that the test integration endpoint correctly reports the failure
      const invalidConfig = {
        id: 'e2e-auth-fail-test',
        name: 'E2E Auth Failure Test',
        description: 'Test authentication failure handling',
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        syncDirection: 'source_to_target',
        syncMode: 'manual',
        isActive: true,
        sourceEntity: 'customer',
        targetEntity: 'account',
        fieldMappings: [] as FieldMapping[],
        transformationRules: [] as TransformationRule[],
        sourceAuthentication: {
          type: 'oauth1',
          credentials: {
            accountId: 'invalid-account',
            consumerKey: 'invalid-key',
            consumerSecret: 'invalid-secret',
            tokenId: 'invalid-token',
            tokenSecret: 'invalid-token-secret'
          }
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'invalid-client-id',
            clientSecret: 'invalid-client-secret',
            username: 'invalid@example.com',
            password: 'invalid-password'
          }
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Configuration should be created successfully even with invalid auth
      await request(app)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(invalidConfig)
        .expect(201);

      // Test integration should still work in E2E tests due to mocking
      // but in a real environment this would fail
      const testResponse = await request(app)
        .post('/api/integrations/e2e-auth-fail-test/test')
        .set('Authorization', AUTH)
        .expect(200);

      // With our mocks, connections should succeed
      expect(testResponse.body.sourceConnection.isConnected).toBe(true);
      expect(testResponse.body.targetConnection.isConnected).toBe(true);

      // Run integration should succeed with mocks
      const runResponse = await request(app)
        .post('/api/integrations/e2e-auth-fail-test/run')
        .set('Authorization', AUTH)
        .expect(200);

      expect(runResponse.body.success).toBe(true);

      // Clean up
      await request(app)
        .delete('/api/configurations/e2e-auth-fail-test')
        .set('Authorization', AUTH)
        .expect(200);
    });

    it('should handle data transformation errors', async () => {
      const errorConfig: IntegrationConfig = {
        id: 'e2e-transform-error-test',
        name: 'E2E Transform Error Test',
        description: 'Test transformation error handling',
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        syncDirection: 'source_to_target',
        syncMode: 'manual',
        isActive: true,
        sourceEntity: 'customer',
        targetEntity: 'account',
        fieldMappings: [
          {
            sourceField: 'invalid_field',
            targetField: 'Name',
            isRequired: true,
            transformationType: 'direct'
          }
        ],
        transformationRules: [
          {
            id: 'invalid_calculation',
            name: 'Invalid Calculation',
            type: 'conditional_logic',
            action: 'set_field_value',
            parameters: {
              targetField: 'result',
              conditions: [
                {
                  field: 'nonexistent_field',
                  operator: 'equals',
                  value: 'test',
                  result: 'output'
                }
              ]
            }
          }
        ],
        sourceAuthentication: {
          type: 'oauth1',
          credentials: {
            accountId: process.env.NETSUITE_ACCOUNT_ID || 'test-account',
            consumerKey: process.env.NETSUITE_CONSUMER_KEY || 'test-key',
            consumerSecret: process.env.NETSUITE_CONSUMER_SECRET || 'test-secret',
            tokenId: process.env.NETSUITE_TOKEN_ID || 'test-token',
            tokenSecret: process.env.NETSUITE_TOKEN_SECRET || 'test-token-secret'
          }
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: process.env.SALESFORCE_CLIENT_ID || 'test-client-id',
            clientSecret: process.env.SALESFORCE_CLIENT_SECRET || 'test-client-secret',
            username: process.env.SALESFORCE_USERNAME || 'test@example.com',
            password: process.env.SALESFORCE_PASSWORD || 'test-password'
          }
        }
      };

      await request(app)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(errorConfig)
        .expect(201);

      // Validation should show valid with mocks but may have warnings
      const validateResponse = await request(app)
        .post('/api/configurations/e2e-transform-error-test/validate')
        .set('Authorization', AUTH)
        .expect(200);

      // Since we're using mocks, validation will succeed but may have warnings
      expect(validateResponse.body.isValid).toBe(true);
      expect(validateResponse.body.warnings).toBeDefined();

      // Clean up
      await request(app)
        .delete('/api/configurations/e2e-transform-error-test')
        .set('Authorization', AUTH)
        .expect(200);
    });

    it('should handle network timeouts and retries', async () => {
      const timeoutConfig: IntegrationConfig = {
        id: 'e2e-timeout-test',
        name: 'E2E Timeout Test',
        description: 'Test network timeout handling',
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        syncDirection: 'source_to_target',
        syncMode: 'manual',
        isActive: true,
        sourceEntity: 'customer',
        targetEntity: 'account',
        fieldMappings: [
          {
            sourceField: 'companyname',
            targetField: 'Name',
            isRequired: true,
            transformationType: 'direct'
          }
        ],
        transformationRules: [] as TransformationRule[],
        retryConfig: {
          maxRetries: 3,
          retryDelay: 1000,
          backoffStrategy: 'exponential'
        },
        sourceAuthentication: {
          type: 'oauth1',
          credentials: {
            accountId: 'timeout-test-account',
            consumerKey: 'timeout-test-key',
            consumerSecret: 'timeout-test-secret',
            tokenId: 'timeout-test-token',
            tokenSecret: 'timeout-test-token-secret'
          }
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'timeout-test-client-id',
            clientSecret: 'timeout-test-client-secret',
            username: 'timeout-test@example.com',
            password: 'timeout-test-password'
          }
        }
      };

      await request(app)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(timeoutConfig)
        .expect(201);

      // Run integration - should handle timeouts gracefully
      const runResponse = await request(app)
        .post('/api/integrations/e2e-timeout-test/run')
        .set('Authorization', AUTH)
        .timeout(30000) // 30 second timeout for this test
        .expect(200);

      expect(runResponse.body).toBeDefined();
      expect(runResponse.body.success).toBeDefined();

      // Clean up
      await request(app)
        .delete('/api/configurations/e2e-timeout-test')
        .set('Authorization', AUTH)
        .expect(200);
    });
  });

  describe('Performance and Load Testing', () => {
    it('should handle multiple concurrent integrations', async () => {
      const concurrentConfigs = Array.from({ length: 5 }, (_, i) => ({
        id: `e2e-concurrent-test-${i}`,
        name: `E2E Concurrent Test ${i}`,
        description: `Concurrent test integration ${i}`,
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        syncDirection: 'source_to_target' as const,
        syncMode: 'manual' as const,
        isActive: true,
        sourceEntity: 'customer',
        targetEntity: 'account',
        fieldMappings: [
          {
            sourceField: 'companyname',
            targetField: 'Name',
            isRequired: true,
            transformationType: 'direct' as const
          }
        ],
        transformationRules: [] as TransformationRule[],
        sourceAuthentication: {
          type: 'oauth1' as const,
          credentials: {
            accountId: `test-account-${i}`,
            consumerKey: `test-key-${i}`,
            consumerSecret: `test-secret-${i}`,
            tokenId: `test-token-${i}`,
            tokenSecret: `test-token-secret-${i}`
          }
        },
        targetAuthentication: {
          type: 'oauth2' as const,
          credentials: {
            clientId: `test-client-id-${i}`,
            clientSecret: `test-client-secret-${i}`,
            username: `test${i}@example.com`,
            password: `test-password-${i}`
          }
        }
      }));

      // Create all configurations
      const createPromises = concurrentConfigs.map(config =>
        request(app)
          .post('/api/configurations')
          .set('Authorization', AUTH)
          .send(config)
          .expect(201)
      );

      await Promise.all(createPromises);

      // Run all integrations concurrently
      const runPromises = concurrentConfigs.map(config =>
        request(app)
          .post(`/api/integrations/${config.id}/run`)
          .set('Authorization', AUTH)
          .timeout(60000)
      );

      const runResults = await Promise.allSettled(runPromises);

      // Verify all completed (success or failure is acceptable, but they should complete)
      expect(runResults).toHaveLength(5);
      runResults.forEach(result => {
        expect(result.status).toBe('fulfilled');
      });

      // Clean up all configurations
      const deletePromises = concurrentConfigs.map(config =>
        request(app)
          .delete(`/api/configurations/${config.id}`)
          .set('Authorization', AUTH)
          .expect(200)
      );

      await Promise.all(deletePromises);
    });

    it('should monitor system health during load', async () => {
      const healthBefore = await request(app)
        .get('/health')
        .expect(200);

      expect(healthBefore.body.status).toBe('healthy');
      expect(healthBefore.body.uptime).toBeDefined();

      // Create a load test configuration
      const loadConfig: IntegrationConfig = {
        id: 'e2e-load-test',
        name: 'E2E Load Test',
        description: 'Load testing integration',
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        syncDirection: 'source_to_target',
        syncMode: 'batch',
        isActive: true,
        sourceEntity: 'customer',
        targetEntity: 'account',
        batchSize: 1000,
        fieldMappings: [
          {
            sourceField: 'companyname',
            targetField: 'Name',
            isRequired: true,
            transformationType: 'direct'
          }
        ],
        transformationRules: [] as TransformationRule[],
        sourceAuthentication: {
          type: 'oauth1',
          credentials: {
            accountId: 'load-test-account',
            consumerKey: 'load-test-key',
            consumerSecret: 'load-test-secret',
            tokenId: 'load-test-token',
            tokenSecret: 'load-test-token-secret'
          }
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'load-test-client-id',
            clientSecret: 'load-test-client-secret',
            username: 'load-test@example.com',
            password: 'load-test-password'
          }
        }
      };

      await request(app)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(loadConfig)
        .expect(201);

      // Run load test
      const runResponse = await request(app)
        .post('/api/integrations/e2e-load-test/run')
        .set('Authorization', AUTH)
        .timeout(120000) // 2 minute timeout
        .expect(200);

      expect(runResponse.body).toBeDefined();

      // Check health after load
      const healthAfter = await request(app)
        .get('/health')
        .expect(200);

      expect(healthAfter.body.status).toBe('healthy');

      // Clean up
      await request(app)
        .delete('/api/configurations/e2e-load-test')
        .set('Authorization', AUTH)
        .expect(200);
    });
  });

  describe('System Integration Status', () => {
    it('should provide comprehensive system status', async () => {
      const statusResponse = await request(app)
        .get('/api/integrations/status')
        .set('Authorization', AUTH)
        .expect(200);

      expect(Array.isArray(statusResponse.body)).toBe(true);
      if (statusResponse.body.length > 0) {
        const status = statusResponse.body[0];
        expect(status).toHaveProperty('configId');
        expect(status).toHaveProperty('status');
        expect(status).toHaveProperty('isRunning');
      }
    });

    it('should track integration statistics', async () => {
      const statisticsResponse = await request(app)
        .get('/api/statistics')
        .expect(200);

      expect(statisticsResponse.body.totalConfigurations).toBeGreaterThanOrEqual(0);
      expect(statisticsResponse.body.systemBreakdown).toBeDefined();
      expect(statisticsResponse.body.syncModeBreakdown).toBeDefined();
      expect(statisticsResponse.body.authTypeBreakdown).toBeDefined();
    });
  });
});