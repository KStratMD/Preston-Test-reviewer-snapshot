import { SecretManager } from '../services/SecretManager';
import type { Logger } from '../utils/Logger';

jest.mock('@aws-sdk/client-secrets-manager', () => {
  const send = jest.fn().mockResolvedValue({
    SecretString: 'aws-secret-value',
    VersionId: '1',
    CreatedDate: new Date('2024-01-01'),
    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret',
    Name: 'my-secret',
  });
  return {
    SecretsManagerClient: jest.fn().mockImplementation(() => ({ send })),
    GetSecretValueCommand: jest.fn(),
  };
}, { virtual: true });

const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

describe('SecretManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SECRET_MANAGER_PROVIDER;
    delete process.env.AWS_REGION;
    delete process.env.TEST_ENV_SECRET;
  });

  it('retrieves secret from environment variables', async () => {
    process.env.SECRET_MANAGER_PROVIDER = 'env';
    process.env.TEST_ENV_SECRET = 'env-secret';

    const manager = new SecretManager(mockLogger);
    const secret = await manager.getSecret('TEST_ENV_SECRET');

    expect(secret.value).toBe('env-secret');
  });

  it('retrieves secret from AWS Secrets Manager', async () => {
    process.env.SECRET_MANAGER_PROVIDER = 'aws';
    process.env.AWS_REGION = 'us-east-1';

    const manager = new SecretManager(mockLogger);
    jest.spyOn(manager as any, 'getAwsSecret').mockResolvedValue({
      value: 'aws-secret-value',
      version: '1',
      metadata: {
        arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret',
        name: 'my-secret',
      },
    });
    const secret = await manager.getSecret('my-secret');

    expect(secret.value).toBe('aws-secret-value');
  });
});
