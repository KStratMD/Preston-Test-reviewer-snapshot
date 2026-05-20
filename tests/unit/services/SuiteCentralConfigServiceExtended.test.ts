/**
 * Comprehensive unit tests for SuiteCentralConfigService
 * Covers: environment management, credential profiles, integration templates,
 *         performance profiles, config validation, health reports
 */
import 'reflect-metadata';
import { SuiteCentralConfigService } from '../../../src/services/SuiteCentralConfigService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockTelemetryService = {
  recordMetric: jest.fn(),
  recordEvent: jest.fn().mockResolvedValue(undefined),
} as any;

describe('SuiteCentralConfigService', () => {
  let service: SuiteCentralConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SuiteCentralConfigService(mockLogger, mockTelemetryService);
  });

  describe('constructor', () => {
    it('should initialize with default configurations', () => {
      expect(service).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('SuiteCentralConfigService initialized');
    });

    it('should have 2 default environments', () => {
      const envs = service.getAllEnvironments();
      expect(envs.length).toBe(2);
      const names = envs.map(e => e.name);
      expect(names).toContain('SuiteCentral Sandbox');
      expect(names).toContain('SuiteCentral Production');
    });
  });

  describe('environment management', () => {
    it('should create a new environment', async () => {
      const envId = await service.createEnvironment({
        name: 'Test Env',
        baseUrl: 'https://test.example.com',
        environment: 'sandbox',
        apiVersion: 'v2',
        timeout: 10000,
        retryAttempts: 3,
        rateLimiting: { requestsPerSecond: 10, burstAllowance: 20, dailyQuota: 5000 },
        security: {
          enabledCiphers: ['TLS_AES_256_GCM_SHA384'],
          tlsVersion: '1.3',
          certificatePinning: false,
          requestSigning: false,
        },
        monitoring: {
          enableHealthCheck: true,
          healthCheckInterval: 60000,
          enableMetrics: true,
          alertThresholds: { errorRate: 5, responseTime: 2000, availabilityThreshold: 99 },
        },
        features: {
          bulkOperations: true,
          webhooks: true,
          realTimeSync: false,
          advancedSearch: true,
          changeTracking: true,
        },
      });
      expect(envId).toBeDefined();
      expect(typeof envId).toBe('string');
    });

    it('should get an environment by ID', async () => {
      const envId = await service.createEnvironment({
        name: 'Get Test',
        baseUrl: 'https://get.example.com',
        environment: 'sandbox',
        apiVersion: 'v1',
        timeout: 10000,
        retryAttempts: 2,
        rateLimiting: { requestsPerSecond: 5, burstAllowance: 10, dailyQuota: 1000 },
        security: { enabledCiphers: [], tlsVersion: '1.2', certificatePinning: false, requestSigning: false },
        monitoring: { enableHealthCheck: true, healthCheckInterval: 60000, enableMetrics: true, alertThresholds: { errorRate: 5, responseTime: 2000, availabilityThreshold: 95 } },
        features: { bulkOperations: false, webhooks: false, realTimeSync: false, advancedSearch: false, changeTracking: false },
      });
      const env = service.getEnvironment(envId);
      expect(env).not.toBeNull();
      expect(env!.name).toBe('Get Test');
    });

    it('should return null for unknown environment', () => {
      expect(service.getEnvironment('nonexistent')).toBeNull();
    });

    it('should get all environments', () => {
      const envs = service.getAllEnvironments();
      expect(envs.length).toBeGreaterThanOrEqual(2);
    });

    it('should update an environment', async () => {
      const envs = service.getAllEnvironments();
      const envId = envs[0].id;
      const result = await service.updateEnvironment(envId, { timeout: 5000 });
      expect(result).toBe(true);
      const updated = service.getEnvironment(envId);
      expect(updated!.timeout).toBe(5000);
    });

    it('should return false when updating nonexistent environment', async () => {
      const result = await service.updateEnvironment('nonexistent', { timeout: 5000 });
      expect(result).toBe(false);
    });
  });

  describe('credential management', () => {
    it('should create a credential profile', async () => {
      const envs = service.getAllEnvironments();
      const profileId = await service.createCredentialProfile({
        name: 'Test Credential',
        environmentId: envs[0].id,
        clientId: 'client-123',
        clientSecret: 'super-secret-key',
        scopes: ['read', 'write'],
        isActive: true,
      });
      expect(profileId).toBeDefined();
      expect(typeof profileId).toBe('string');
    });

    it('should get credential profile without decryption', async () => {
      const envs = service.getAllEnvironments();
      const profileId = await service.createCredentialProfile({
        name: 'No Decrypt',
        environmentId: envs[0].id,
        clientId: 'client-456',
        clientSecret: 'my-secret',
        scopes: ['read'],
        isActive: true,
      });
      const profile = await service.getCredentialProfile(profileId);
      expect(profile).not.toBeNull();
      expect(profile!.name).toBe('No Decrypt');
      // Without decrypt=true, secret should be encrypted JSON
      expect(profile!.clientSecret).not.toBe('my-secret');
    });

    it('should get credential profile with decryption', async () => {
      const envs = service.getAllEnvironments();
      const profileId = await service.createCredentialProfile({
        name: 'Decrypt Test',
        environmentId: envs[0].id,
        clientId: 'client-789',
        clientSecret: 'decrypt-me',
        scopes: ['admin'],
        isActive: true,
      });
      const profile = await service.getCredentialProfile(profileId, true);
      expect(profile).not.toBeNull();
      expect(profile!.clientSecret).toBe('decrypt-me');
    });

    it('should return null for unknown profile', async () => {
      const profile = await service.getCredentialProfile('nonexistent');
      expect(profile).toBeNull();
    });

    it('should get credentials by environment', async () => {
      const envs = service.getAllEnvironments();
      const envId = envs[0].id;
      await service.createCredentialProfile({
        name: 'Cred A',
        environmentId: envId,
        clientId: 'a',
        clientSecret: 'a',
        scopes: [],
        isActive: true,
      });
      const creds = service.getCredentialsByEnvironment(envId);
      expect(creds.length).toBeGreaterThanOrEqual(1);
      expect(creds[0].environmentId).toBe(envId);
    });

    it('should update last used timestamp', async () => {
      const envs = service.getAllEnvironments();
      const profileId = await service.createCredentialProfile({
        name: 'LastUsed',
        environmentId: envs[0].id,
        clientId: 'lu',
        clientSecret: 'lu',
        scopes: [],
        isActive: true,
      });
      await service.updateCredentialLastUsed(profileId);
      const profile = await service.getCredentialProfile(profileId);
      expect(profile!.lastUsed).toBeInstanceOf(Date);
    });
  });

  describe('integration template management', () => {
    it('should create a template', async () => {
      const templateId = await service.createIntegrationTemplate({
        name: 'Customer Sync',
        description: 'Sync customers',
        sourceSystem: 'Salesforce',
        targetEntities: ['Customer'],
        fieldMappings: [
          { sourceField: 'Name', targetField: 'companyname', isRequired: true },
        ],
        businessRules: [],
        syncSettings: {
          direction: 'inbound',
          frequency: 'daily',
          batchSize: 100,
          errorHandling: 'retry',
        },
      });
      expect(templateId).toBeDefined();
    });

    it('should get a template by ID', async () => {
      const templateId = await service.createIntegrationTemplate({
        name: 'Order Sync',
        description: 'Sync orders',
        sourceSystem: 'Shopify',
        targetEntities: ['SalesOrder'],
        fieldMappings: [],
        businessRules: [],
        syncSettings: { direction: 'outbound', frequency: 'realtime', batchSize: 50, errorHandling: 'skip' },
      });
      const template = service.getIntegrationTemplate(templateId);
      expect(template).not.toBeNull();
      expect(template!.name).toBe('Order Sync');
    });

    it('should return null for unknown template', () => {
      expect(service.getIntegrationTemplate('nonexistent')).toBeNull();
    });

    it('should get templates by source system', async () => {
      await service.createIntegrationTemplate({
        name: 'Inventory A',
        description: 'A',
        sourceSystem: 'NetSuite',
        targetEntities: [],
        fieldMappings: [],
        businessRules: [],
        syncSettings: { direction: 'bidirectional', frequency: 'hourly', batchSize: 200, errorHandling: 'fail' },
      });
      const templates = service.getTemplatesBySourceSystem('NetSuite');
      expect(templates.length).toBeGreaterThanOrEqual(1);
    });

    it('should get all templates', () => {
      const templates = service.getAllTemplates();
      expect(Array.isArray(templates)).toBe(true);
    });
  });

  describe('performance profile management', () => {
    it('should create and update performance profile', async () => {
      const envs = service.getAllEnvironments();
      const envId = envs[0].id;
      await service.updatePerformanceProfile(envId, {
        responseTime: 150,
        successRate: 99.5,
        requestCount: 1000,
        errors: { 'timeout': 5 },
      });
      const profile = service.getPerformanceProfile(envId);
      expect(profile).not.toBeNull();
      expect(profile!.environmentId).toBe(envId);
      expect(profile!.averageResponseTime).toBe(150);
      expect(profile!.successRate).toBe(99.5);
    });

    it('should use EMA when updating existing profile', async () => {
      const envs = service.getAllEnvironments();
      const envId = envs[0].id;
      await service.updatePerformanceProfile(envId, {
        responseTime: 100,
        successRate: 99,
        requestCount: 500,
        errors: {},
      });
      await service.updatePerformanceProfile(envId, {
        responseTime: 200,
        successRate: 95,
        requestCount: 300,
        errors: { 'rate-limit': 2 },
      });
      const profile = service.getPerformanceProfile(envId);
      // EMA: 0.7 * 100 + 0.3 * 200 = 130
      expect(profile!.averageResponseTime).toBeCloseTo(130, 0);
    });

    it('should return null for unknown environment', () => {
      expect(service.getPerformanceProfile('nonexistent')).toBeNull();
    });
  });

  describe('validateEnvironmentConfig', () => {
    it('should pass for valid sandbox config', () => {
      const envs = service.getAllEnvironments();
      const sandbox = envs.find(e => e.environment === 'sandbox')!;
      const errors = service.validateEnvironmentConfig(sandbox);
      expect(errors.length).toBe(0);
    });

    it('should pass for valid production config', () => {
      const envs = service.getAllEnvironments();
      const prod = envs.find(e => e.environment === 'production')!;
      const errors = service.validateEnvironmentConfig(prod);
      expect(errors.length).toBe(0);
    });

    it('should reject non-HTTPS URL', () => {
      const envs = service.getAllEnvironments();
      const config = { ...envs[0], baseUrl: 'http://insecure.com' };
      const errors = service.validateEnvironmentConfig(config);
      expect(errors).toContain('Base URL must be HTTPS');
    });

    it('should reject invalid rate limiting', () => {
      const envs = service.getAllEnvironments();
      const config = { ...envs[0], rateLimiting: { ...envs[0].rateLimiting, requestsPerSecond: 0 } };
      const errors = service.validateEnvironmentConfig(config);
      expect(errors).toContain('Requests per second must be between 1 and 1000');
    });

    it('should reject invalid timeout', () => {
      const envs = service.getAllEnvironments();
      const config = { ...envs[0], timeout: 500 };
      const errors = service.validateEnvironmentConfig(config);
      expect(errors).toContain('Timeout must be between 1 and 300 seconds');
    });

    it('should require cert pinning in production', () => {
      const envs = service.getAllEnvironments();
      const prod = envs.find(e => e.environment === 'production')!;
      const config = {
        ...prod,
        security: { ...prod.security, certificatePinning: false },
      };
      const errors = service.validateEnvironmentConfig(config);
      expect(errors).toContain('Certificate pinning must be enabled in production');
    });

    it('should require TLS 1.3 in production', () => {
      const envs = service.getAllEnvironments();
      const prod = envs.find(e => e.environment === 'production')!;
      const config = {
        ...prod,
        security: { ...prod.security, tlsVersion: '1.2' },
      };
      const errors = service.validateEnvironmentConfig(config);
      expect(errors).toContain('TLS 1.3 is required for production environments');
    });
  });

  describe('generateHealthReport', () => {
    it('should generate a complete health report', async () => {
      const report = await service.generateHealthReport();
      expect(report).toBeDefined();
      expect(Array.isArray(report.environments)).toBe(true);
      expect(report.environments.length).toBeGreaterThanOrEqual(2);
      expect(report.credentials).toBeDefined();
      expect(typeof report.credentials.total).toBe('number');
      expect(typeof report.credentials.active).toBe('number');
      expect(report.templates).toBeDefined();
      expect(typeof report.templates.total).toBe('number');
      expect(Array.isArray(report.performance)).toBe(true);
    });

    it('should include environment status', async () => {
      const report = await service.generateHealthReport();
      for (const env of report.environments) {
        expect(env.id).toBeDefined();
        expect(env.name).toBeDefined();
        expect(['healthy', 'warning', 'critical']).toContain(env.status);
        expect(Array.isArray(env.issues)).toBe(true);
      }
    });

    it('should reflect performance data', async () => {
      const envs = service.getAllEnvironments();
      await service.updatePerformanceProfile(envs[0].id, {
        responseTime: 4000,
        successRate: 80,
        requestCount: 1000,
        errors: {},
      });
      const report = await service.generateHealthReport();
      const perfEntry = report.performance.find(p => p.environmentId === envs[0].id);
      expect(perfEntry).toBeDefined();
      expect(perfEntry!.status).toBe('poor');
    });
  });
});
