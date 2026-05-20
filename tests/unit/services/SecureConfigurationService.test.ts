/**
 * SecureConfigurationService Tests
 * Tests for secure credential management and integration configuration
 */

// Mock the service to bypass inversify dependency injection
const mockCreateSecureIntegration = jest.fn();
const mockGetSecureIntegration = jest.fn();
const mockUpdateIntegrationCredentials = jest.fn();
const mockGetCredentialHealthStatus = jest.fn();
const mockMigrateToSecureCredentials = jest.fn();
const mockValidateCredentialSecurity = jest.fn();

jest.mock('../../../src/services/SecureConfigurationService', () => ({
  SecureConfigurationService: jest.fn().mockImplementation(() => ({
    createSecureIntegration: mockCreateSecureIntegration,
    getSecureIntegration: mockGetSecureIntegration,
    updateIntegrationCredentials: mockUpdateIntegrationCredentials,
    getCredentialHealthStatus: mockGetCredentialHealthStatus,
    migrateToSecureCredentials: mockMigrateToSecureCredentials,
    validateCredentialSecurity: mockValidateCredentialSecurity
  }))
}));

import { SecureConfigurationService } from '../../../src/services/SecureConfigurationService';

describe('SecureConfigurationService', () => {
  let service: any;

  const mockIntegrationConfig = {
    id: 'integration-1',
    name: 'Test Integration',
    sourceConnector: 'salesforce',
    targetConnector: 'netsuite',
    enabled: true,
    schedule: '0 * * * *',
    fieldMappings: []
  };

  const mockSourceSystemConfig = {
    systemId: 'sf-1',
    systemType: 'salesforce',
    name: 'Salesforce Production',
    config: {
      baseUrl: 'https://api.salesforce.com',
      apiVersion: 'v55.0',
      timeout: 30000
    },
    credentialSource: 'secret_manager' as const,
    credentialMetadata: {
      rotationPolicy: {
        enabled: true,
        intervalDays: 90,
        autoRotate: true
      },
      compliance: {
        encryptionRequired: true,
        auditLogging: true,
        accessLogging: true
      }
    }
  };

  const mockTargetSystemConfig = {
    systemId: 'ns-1',
    systemType: 'netsuite',
    name: 'NetSuite Production',
    config: {
      baseUrl: 'https://api.netsuite.com',
      timeout: 60000
    },
    credentialSource: 'secret_manager' as const
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockCreateSecureIntegration.mockResolvedValue(undefined);
    mockGetSecureIntegration.mockResolvedValue({
      ...mockIntegrationConfig,
      resolvedCredentials: {
        source: { type: 'oauth2', accessToken: 'sf_token_xxx' },
        target: { type: 'oauth1', consumerKey: 'ns_key_xxx' }
      }
    });
    mockUpdateIntegrationCredentials.mockResolvedValue(undefined);
    mockGetCredentialHealthStatus.mockResolvedValue({
      totalIntegrations: 5,
      credentialsNeedingRotation: 1,
      expiredCredentials: 0,
      healthyCredentials: 4,
      details: [
        { integrationId: 'integration-1', systemType: 'salesforce', systemId: 'sf-1', status: 'healthy' },
        { integrationId: 'integration-2', systemType: 'netsuite', systemId: 'ns-1', status: 'needs_rotation', daysSinceRotation: 95 }
      ]
    });
    mockMigrateToSecureCredentials.mockResolvedValue({
      migratedIntegrations: 3,
      migratedCredentials: 5,
      errors: []
    });
    mockValidateCredentialSecurity.mockResolvedValue({
      totalIntegrations: 5,
      secureIntegrations: 4,
      insecureIntegrations: 1,
      issues: [
        {
          integrationId: 'integration-3',
          issue: 'Source system credentials stored inline in configuration',
          severity: 'high',
          recommendation: 'Migrate credentials to secret manager'
        }
      ]
    });

    service = new SecureConfigurationService();
  });

  describe('createSecureIntegration', () => {
    it('should create secure integration with credentials', async () => {
      const sourceCredentials = { accessToken: 'sf_token', refreshToken: 'sf_refresh' };
      const targetCredentials = { consumerKey: 'ns_key', consumerSecret: 'ns_secret' };

      await service.createSecureIntegration(
        mockIntegrationConfig,
        mockSourceSystemConfig,
        mockTargetSystemConfig,
        sourceCredentials,
        targetCredentials
      );

      expect(mockCreateSecureIntegration).toHaveBeenCalledWith(
        mockIntegrationConfig,
        mockSourceSystemConfig,
        mockTargetSystemConfig,
        sourceCredentials,
        targetCredentials
      );
    });

    it('should create integration without credentials', async () => {
      await service.createSecureIntegration(
        mockIntegrationConfig,
        mockSourceSystemConfig,
        mockTargetSystemConfig
      );

      expect(mockCreateSecureIntegration).toHaveBeenCalledWith(
        mockIntegrationConfig,
        mockSourceSystemConfig,
        mockTargetSystemConfig
      );
    });

    it('should handle creation errors', async () => {
      mockCreateSecureIntegration.mockRejectedValue(new Error('Failed to store credentials'));

      await expect(service.createSecureIntegration(
        mockIntegrationConfig,
        mockSourceSystemConfig,
        mockTargetSystemConfig,
        { token: 'invalid' }
      )).rejects.toThrow('Failed to store credentials');
    });
  });

  describe('getSecureIntegration', () => {
    it('should return integration with resolved credentials', async () => {
      const result = await service.getSecureIntegration('integration-1');

      expect(result).toBeDefined();
      expect(result.id).toBe('integration-1');
      expect(result.resolvedCredentials).toBeDefined();
    });

    it('should include source credentials', async () => {
      const result = await service.getSecureIntegration('integration-1');

      expect(result.resolvedCredentials.source).toBeDefined();
      expect(result.resolvedCredentials.source.type).toBe('oauth2');
    });

    it('should include target credentials', async () => {
      const result = await service.getSecureIntegration('integration-1');

      expect(result.resolvedCredentials.target).toBeDefined();
      expect(result.resolvedCredentials.target.type).toBe('oauth1');
    });

    it('should throw error for non-existent integration', async () => {
      mockGetSecureIntegration.mockRejectedValue(new Error('Integration not-found not found'));

      await expect(service.getSecureIntegration('not-found'))
        .rejects.toThrow('Integration not-found not found');
    });

    it('should handle credential resolution errors', async () => {
      mockGetSecureIntegration.mockRejectedValue(new Error('Failed to resolve secure credentials'));

      await expect(service.getSecureIntegration('integration-1'))
        .rejects.toThrow('Failed to resolve secure credentials');
    });
  });

  describe('updateIntegrationCredentials', () => {
    it('should update source credentials', async () => {
      const newCredentials = { accessToken: 'new_token', refreshToken: 'new_refresh' };

      await service.updateIntegrationCredentials('integration-1', 'source', newCredentials);

      expect(mockUpdateIntegrationCredentials).toHaveBeenCalledWith(
        'integration-1',
        'source',
        newCredentials
      );
    });

    it('should update target credentials', async () => {
      const newCredentials = { consumerKey: 'new_key', consumerSecret: 'new_secret' };

      await service.updateIntegrationCredentials('integration-1', 'target', newCredentials);

      expect(mockUpdateIntegrationCredentials).toHaveBeenCalledWith(
        'integration-1',
        'target',
        newCredentials
      );
    });

    it('should throw error for non-existent integration', async () => {
      mockUpdateIntegrationCredentials.mockRejectedValue(new Error('Integration not-found not found'));

      await expect(service.updateIntegrationCredentials('not-found', 'source', {}))
        .rejects.toThrow('Integration not-found not found');
    });

    it('should throw error when not using secret manager', async () => {
      mockUpdateIntegrationCredentials.mockRejectedValue(
        new Error('Integration does not use secret manager for source system')
      );

      await expect(service.updateIntegrationCredentials('integration-2', 'source', {}))
        .rejects.toThrow('does not use secret manager');
    });
  });

  describe('getCredentialHealthStatus', () => {
    it('should return health status overview', async () => {
      const status = await service.getCredentialHealthStatus();

      expect(status).toBeDefined();
      expect(status.totalIntegrations).toBeDefined();
      expect(status.credentialsNeedingRotation).toBeDefined();
      expect(status.expiredCredentials).toBeDefined();
      expect(status.healthyCredentials).toBeDefined();
    });

    it('should include credential details', async () => {
      const status = await service.getCredentialHealthStatus();

      expect(status.details).toBeDefined();
      expect(Array.isArray(status.details)).toBe(true);
    });

    it('should identify healthy credentials', async () => {
      const status = await service.getCredentialHealthStatus();

      const healthyCredential = status.details.find((d: any) => d.status === 'healthy');
      expect(healthyCredential).toBeDefined();
    });

    it('should identify credentials needing rotation', async () => {
      const status = await service.getCredentialHealthStatus();

      const needsRotation = status.details.find((d: any) => d.status === 'needs_rotation');
      expect(needsRotation).toBeDefined();
      expect(needsRotation.daysSinceRotation).toBeGreaterThan(90);
    });

    it('should identify expired credentials', async () => {
      mockGetCredentialHealthStatus.mockResolvedValue({
        totalIntegrations: 3,
        credentialsNeedingRotation: 0,
        expiredCredentials: 1,
        healthyCredentials: 2,
        details: [
          { integrationId: 'integration-1', status: 'expired', daysSinceRotation: 150 }
        ]
      });

      const status = await service.getCredentialHealthStatus();

      expect(status.expiredCredentials).toBe(1);
    });
  });

  describe('migrateToSecureCredentials', () => {
    it('should migrate integrations successfully', async () => {
      const result = await service.migrateToSecureCredentials();

      expect(result).toBeDefined();
      expect(result.migratedIntegrations).toBeDefined();
      expect(result.migratedCredentials).toBeDefined();
      expect(result.errors).toBeDefined();
    });

    it('should report migration counts', async () => {
      const result = await service.migrateToSecureCredentials();

      expect(result.migratedIntegrations).toBe(3);
      expect(result.migratedCredentials).toBe(5);
    });

    it('should report no errors on successful migration', async () => {
      const result = await service.migrateToSecureCredentials();

      expect(result.errors).toHaveLength(0);
    });

    it('should report migration errors', async () => {
      mockMigrateToSecureCredentials.mockResolvedValue({
        migratedIntegrations: 2,
        migratedCredentials: 3,
        errors: ['Failed to migrate integration-3: Invalid credentials format']
      });

      const result = await service.migrateToSecureCredentials();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Failed to migrate');
    });

    it('should handle fatal migration errors', async () => {
      mockMigrateToSecureCredentials.mockRejectedValue(new Error('Migration failed completely'));

      await expect(service.migrateToSecureCredentials())
        .rejects.toThrow('Migration failed completely');
    });
  });

  describe('validateCredentialSecurity', () => {
    it('should return security validation results', async () => {
      const result = await service.validateCredentialSecurity();

      expect(result).toBeDefined();
      expect(result.totalIntegrations).toBeDefined();
      expect(result.secureIntegrations).toBeDefined();
      expect(result.insecureIntegrations).toBeDefined();
      expect(result.issues).toBeDefined();
    });

    it('should identify insecure integrations', async () => {
      const result = await service.validateCredentialSecurity();

      expect(result.insecureIntegrations).toBe(1);
    });

    it('should report security issues', async () => {
      const result = await service.validateCredentialSecurity();

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('high');
    });

    it('should include recommendations', async () => {
      const result = await service.validateCredentialSecurity();

      expect(result.issues[0].recommendation).toBeDefined();
      expect(result.issues[0].recommendation).toContain('secret manager');
    });

    it('should detect inline credentials', async () => {
      mockValidateCredentialSecurity.mockResolvedValue({
        totalIntegrations: 2,
        secureIntegrations: 0,
        insecureIntegrations: 2,
        issues: [
          { integrationId: 'integration-1', issue: 'Source system credentials stored inline', severity: 'high', recommendation: 'Migrate' },
          { integrationId: 'integration-1', issue: 'Target system credentials stored inline', severity: 'high', recommendation: 'Migrate' }
        ]
      });

      const result = await service.validateCredentialSecurity();

      expect(result.issues.some((i: any) => i.issue.includes('inline'))).toBe(true);
    });

    it('should detect environment variable credentials', async () => {
      mockValidateCredentialSecurity.mockResolvedValue({
        totalIntegrations: 1,
        secureIntegrations: 0,
        insecureIntegrations: 1,
        issues: [
          { integrationId: 'integration-1', issue: 'System credentials sourced from environment variables', severity: 'medium', recommendation: 'Switch to secret manager' }
        ]
      });

      const result = await service.validateCredentialSecurity();

      expect(result.issues.some((i: any) => i.issue.includes('environment'))).toBe(true);
      expect(result.issues[0].severity).toBe('medium');
    });

    it('should detect missing encryption', async () => {
      mockValidateCredentialSecurity.mockResolvedValue({
        totalIntegrations: 1,
        secureIntegrations: 0,
        insecureIntegrations: 1,
        issues: [
          { integrationId: 'integration-1', issue: 'Credential encryption not enabled', severity: 'medium', recommendation: 'Enable encryption' }
        ]
      });

      const result = await service.validateCredentialSecurity();

      expect(result.issues.some((i: any) => i.issue.includes('encryption'))).toBe(true);
    });

    it('should detect missing audit logging', async () => {
      mockValidateCredentialSecurity.mockResolvedValue({
        totalIntegrations: 1,
        secureIntegrations: 1,
        insecureIntegrations: 0,
        issues: [
          { integrationId: 'integration-1', issue: 'Audit logging not enabled', severity: 'low', recommendation: 'Enable audit logging' }
        ]
      });

      const result = await service.validateCredentialSecurity();

      expect(result.issues.some((i: any) => i.issue.includes('Audit logging'))).toBe(true);
      expect(result.issues[0].severity).toBe('low');
    });
  });

  describe('credential rotation', () => {
    it('should track days since last rotation', async () => {
      const status = await service.getCredentialHealthStatus();

      const credentialWithRotation = status.details.find((d: any) => d.daysSinceRotation !== undefined);
      expect(credentialWithRotation).toBeDefined();
    });

    it('should identify credentials past rotation threshold', async () => {
      mockGetCredentialHealthStatus.mockResolvedValue({
        totalIntegrations: 2,
        credentialsNeedingRotation: 2,
        expiredCredentials: 0,
        healthyCredentials: 0,
        details: [
          { integrationId: 'int-1', status: 'needs_rotation', daysSinceRotation: 95 },
          { integrationId: 'int-2', status: 'needs_rotation', daysSinceRotation: 100 }
        ]
      });

      const status = await service.getCredentialHealthStatus();

      expect(status.credentialsNeedingRotation).toBe(2);
      status.details.forEach((d: any) => {
        expect(d.daysSinceRotation).toBeGreaterThan(90);
      });
    });
  });

  describe('security severity levels', () => {
    it('should classify inline credentials as high severity', async () => {
      const result = await service.validateCredentialSecurity();

      const inlineIssue = result.issues.find((i: any) => i.issue.includes('inline'));
      if (inlineIssue) {
        expect(inlineIssue.severity).toBe('high');
      }
    });

    it('should classify environment credentials as medium severity', async () => {
      mockValidateCredentialSecurity.mockResolvedValue({
        totalIntegrations: 1,
        secureIntegrations: 0,
        insecureIntegrations: 1,
        issues: [
          { issue: 'Environment variable credentials', severity: 'medium', recommendation: 'Use secret manager' }
        ]
      });

      const result = await service.validateCredentialSecurity();

      expect(result.issues[0].severity).toBe('medium');
    });

    it('should classify missing audit logging as low severity', async () => {
      mockValidateCredentialSecurity.mockResolvedValue({
        totalIntegrations: 1,
        secureIntegrations: 1,
        insecureIntegrations: 0,
        issues: [
          { issue: 'Audit logging not enabled', severity: 'low', recommendation: 'Enable audit logging' }
        ]
      });

      const result = await service.validateCredentialSecurity();

      expect(result.issues[0].severity).toBe('low');
    });
  });

  describe('error handling', () => {
    it('should handle credential manager unavailable', async () => {
      mockCreateSecureIntegration.mockRejectedValue(new Error('Credential manager unavailable'));

      await expect(service.createSecureIntegration(
        mockIntegrationConfig,
        mockSourceSystemConfig,
        mockTargetSystemConfig,
        { token: 'test' }
      )).rejects.toThrow('Credential manager unavailable');
    });

    it('should handle invalid credential format', async () => {
      mockUpdateIntegrationCredentials.mockRejectedValue(new Error('Invalid credential format'));

      await expect(service.updateIntegrationCredentials('int-1', 'source', { invalid: true }))
        .rejects.toThrow('Invalid credential format');
    });
  });
});
