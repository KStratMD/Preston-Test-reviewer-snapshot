import { IntegrationConfigSchema } from '../../../src/schemas/configurationSchemas';

const credentialEnvironment = [
  'SALESFORCE_CLIENT_ID',
  'SALESFORCE_CLIENT_SECRET',
  'NETSUITE_CONSUMER_KEY',
  'NETSUITE_CONSUMER_SECRET',
  'NETSUITE_TOKEN_ID',
  'NETSUITE_TOKEN_SECRET',
  'NETSUITE_ACCOUNT_ID',
  'DYNAMICS_CLIENT_ID',
  'DYNAMICS_CLIENT_SECRET',
  'DYNAMICS_TOKEN_URL',
  'BC_CLIENT_ID',
  'BC_CLIENT_SECRET',
  'BC_TOKEN_URL',
  'SQUIRE_API_KEY',
  'SQUIRE_BASE_URL',
] as const;

describe('sample integration credential containment', () => {
  const originalEnvironment = new Map<string, string | undefined>();

  beforeEach(() => {
    jest.resetModules();
    for (const key of credentialEnvironment) {
      originalEnvironment.set(key, process.env[key]);
      process.env[key] = `${key.toLowerCase()}-secret-do-not-seed`;
    }
  });

  afterEach(() => {
    for (const key of credentialEnvironment) {
      const original = originalEnvironment.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalEnvironment.clear();
    jest.resetModules();
  });

  it('does not read real credential environment variables into boot-seeded samples', async () => {
    const { sampleConfigurations, sampleSquireCredentials } = await import(
      '../../../src/examples/sample-integrations'
    );
    const serializedSamples = JSON.stringify({ sampleConfigurations, sampleSquireCredentials });

    for (const key of credentialEnvironment) {
      expect(serializedSamples).not.toContain(`${key.toLowerCase()}-secret-do-not-seed`);
    }

    for (const config of sampleConfigurations) {
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
      expect(config.sourceSystem).toEqual(expect.objectContaining({ credentialSource: 'environment' }));
      expect(config.targetSystem).toEqual(expect.objectContaining({ credentialSource: 'environment' }));
      expect(config).not.toHaveProperty('sourceAuthentication');
      expect(config).not.toHaveProperty('targetAuthentication');
      expect(config).not.toHaveProperty('authentication');
    }

    expect(sampleSquireCredentials).toEqual({
      type: 'api_key',
      credentials: {
        apiKey: 'demo-api-key',
        baseUrl: 'https://api.squire.com',
      },
    });
  });
});
