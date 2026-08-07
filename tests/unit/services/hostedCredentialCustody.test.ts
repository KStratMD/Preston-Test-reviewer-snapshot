import {
  isHostedCredentialCustodyRequired,
  validateHostedCredentialInfrastructure,
  validateHostedCredentialCustody,
  type HostedCredentialCustodyInput,
} from '../../../src/services/hostedCredentialCustody';

function makeInput(overrides: Partial<HostedCredentialCustodyInput> = {}): HostedCredentialCustodyInput {
  return {
    sourceSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
    targetSystem: { type: 'NetSuite', systemId: 'ns-prod', credentialSource: 'environment' },
    ...overrides,
  };
}

describe('hosted credential custody policy', () => {
  it.each([
    ['development', false],
    ['test', false],
    ['production', true],
    ['staging', true],
    ['', true],
  ])('uses the fail-closed production-strength predicate for NODE_ENV=%s', (nodeEnv, expected) => {
    expect(isHostedCredentialCustodyRequired(nodeEnv)).toBe(expected);
  });

  it('treats an unset NODE_ENV as production-strength', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(isHostedCredentialCustodyRequired()).toBe(true);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('requires a systemId for secret_manager references', () => {
    const violations = validateHostedCredentialCustody(makeInput({
      sourceSystem: { type: 'Salesforce', credentialSource: 'secret_manager' },
    }), 'production');
    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sourceSystem.systemId', code: 'credential_reference_required' }),
    ]));
  });

  it('rejects systemIds that cannot pass the ownership registry key contract', () => {
    const violations = validateHostedCredentialCustody(makeInput({
      sourceSystem: { type: 'Salesforce', systemId: ' sf-prod ', credentialSource: 'secret_manager' },
    }), 'production');
    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sourceSystem.systemId', code: 'credential_reference_invalid' }),
    ]));
  });

  it('rejects unrecognized hosted fields before they can carry credential material', () => {
    const violations = validateHostedCredentialCustody({
      ...makeInput(),
      sourceCredentials: { opaque: 'unknown-secret-sentinel' },
    } as HostedCredentialCustodyInput & Record<string, unknown>, 'production');
    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sourceCredentials', code: 'unknown_field_forbidden' }),
    ]));
    expect(JSON.stringify(violations)).not.toContain('unknown-secret-sentinel');
  });
  it.each([
    ['secret_manager', { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' }],
    ['environment', { type: 'Salesforce', credentialSource: 'environment' }],
  ] as const)('accepts a %s system reference in a production-strength environment', (_source, sourceSystem) => {
    expect(validateHostedCredentialCustody(makeInput({ sourceSystem }), 'production')).toEqual([]);
  });

  it('does not mutate the configuration input', () => {
    const input = makeInput({
      sourceSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'inline' },
      sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'local-only-secret' } },
    });
    const snapshot = structuredClone(input);

    validateHostedCredentialCustody(input, 'production');

    expect(input).toEqual(snapshot);
  });

  it('rejects an inline system reference without exposing the credential value', () => {
    const sentinel = 'hosted-inline-secret-sentinel';
    const violations = validateHostedCredentialCustody(makeInput({
      sourceSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'inline' },
      sourceAuthentication: { type: 'api_key', credentials: { apiKey: sentinel } },
    }), 'production');

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sourceSystem.credentialSource', code: 'inline_credentials_forbidden' }),
      expect.objectContaining({ path: 'sourceAuthentication', code: 'inline_credentials_forbidden' }),
    ]));
    expect(JSON.stringify(violations)).not.toContain(sentinel);
  });

  it('rejects legacy string systems and legacy authentication in production-strength environments', () => {
    const violations = validateHostedCredentialCustody(makeInput({
      sourceSystem: 'Salesforce',
      authentication: {
        source: { type: 'oauth2', credentials: { clientSecret: 'legacy-secret-sentinel' } },
      },
    }), 'production');

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sourceSystem', code: 'credential_reference_required' }),
      expect.objectContaining({ path: 'authentication.source', code: 'inline_credentials_forbidden' }),
    ]));
    expect(JSON.stringify(violations)).not.toContain('legacy-secret-sentinel');
  });

  it.each(['development', 'test'])('preserves inline compatibility in %s', (nodeEnv) => {
    expect(validateHostedCredentialCustody(makeInput({
      sourceSystem: 'Salesforce',
      sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'local-only-secret' } },
    }), nodeEnv)).toEqual([]);
  });

  it('accepts every boot-seeded sample configuration in production-strength mode', async () => {
    const { sampleConfigurations } = await import('../../../src/examples/sample-integrations');
    for (const config of sampleConfigurations) {
      expect(validateHostedCredentialCustody(config, 'production')).toEqual([]);
    }
  });

  describe('startup credential infrastructure', () => {
    it('requires the encryption key when hosted encryption is enabled', () => {
      const violations = validateHostedCredentialInfrastructure({
        nodeEnv: 'production', provider: 'env', encryptionEnabled: true, encryptionKey: '',
      });
      expect(violations).toEqual([expect.objectContaining({ path: 'CREDENTIAL_ENCRYPTION_KEY', code: 'credential_infrastructure_required' })]);
    });

    it('requires provider configuration for Azure and HashiCorp in production-strength mode', () => {
      expect(validateHostedCredentialInfrastructure({ nodeEnv: 'production', provider: 'azure' })).toEqual([expect.objectContaining({ path: 'AZURE_KEY_VAULT_NAME' })]);
      expect(validateHostedCredentialInfrastructure({ nodeEnv: 'production', provider: 'hashicorp' })).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'VAULT_URL' }),
        expect.objectContaining({ path: 'VAULT_TOKEN' }),
      ]));
    });

    it('does not impose hosted infrastructure requirements in development or test', () => {
      expect(validateHostedCredentialInfrastructure({ nodeEnv: 'test', provider: 'azure' })).toEqual([]);
      expect(validateHostedCredentialInfrastructure({ nodeEnv: 'development', provider: 'hashicorp' })).toEqual([]);
    });
  });
});
