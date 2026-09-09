import type { IntegrationConfig } from '../../../src/types';
import { toExternalIntegrationConfig } from '../../../src/services/configurationRedaction';

describe('toExternalIntegrationConfig', () => {
  it('removes current and legacy authentication while preserving safe metadata without mutating the input', () => {
    const config: IntegrationConfig = {
      id: 'config-redaction-contract',
      tenantId: 'tenant-a',
      name: 'Credential-bearing configuration',
      sourceSystem: {
        type: 'Salesforce',
        systemId: 'salesforce-production',
        credentialSource: 'secret_manager',
      },
      targetSystem: {
        type: 'NetSuite',
        credentialSource: 'environment',
      },
      sourceEntity: 'Account',
      targetEntity: 'Customer',
      syncDirection: 'source_to_target',
      syncMode: 'batch',
      isActive: false,
      fieldMappings: [
        {
          sourceField: 'Name',
          targetField: 'companyname',
          transformationType: 'concatenate',
          isRequired: true,
          transformationConfig: {
            type: 'concatenate',
            fields: ['Name', 'AccountNumber'],
            separator: ' - ',
          },
        },
      ],
      transformationRules: [],
      sourceAuthentication: {
        type: 'api_key',
        credentials: { apiKey: 'source-secret-do-not-return' },
      },
      targetAuthentication: {
        type: 'basic',
        credentials: {
          username: 'target-user-do-not-return',
          password: 'target-secret-do-not-return',
        },
      },
      authentication: {
        source: {
          type: 'oauth2',
          credentials: { clientSecret: 'legacy-source-secret-do-not-return' },
        },
        target: {
          type: 'oauth1',
          credentials: { tokenSecret: 'legacy-target-secret-do-not-return' },
        },
      },
      security: {
        credentialEncryption: true,
        auditLogging: true,
        credentialRotation: { enabled: true, intervalDays: 30 },
      },
      retryConfig: {
        maxRetries: 3,
        retryDelay: 1_000,
        backoffStrategy: 'exponential',
      },
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    };
    const original = structuredClone(config);

    const external = toExternalIntegrationConfig(config);

    expect(external).not.toHaveProperty('sourceAuthentication');
    expect(external).not.toHaveProperty('targetAuthentication');
    expect(external).not.toHaveProperty('authentication');
    expect(external.sourceSystem).toEqual({
      type: 'Salesforce',
      systemId: 'salesforce-production',
      credentialSource: 'secret_manager',
    });
    expect(external.targetSystem).toEqual({
      type: 'NetSuite',
      credentialSource: 'environment',
    });
    expect(external.fieldMappings[0]?.transformationConfig).toEqual({
      type: 'concatenate',
      fields: ['Name', 'AccountNumber'],
      separator: ' - ',
    });
    expect(external.security?.credentialRotation).toEqual({ enabled: true, intervalDays: 30 });
    expect(JSON.stringify(external)).not.toContain('do-not-return');

    external.fieldMappings[0]?.transformationConfig?.fields?.push('SafeNestedField');
    expect(config).toEqual(original);
  });
});
