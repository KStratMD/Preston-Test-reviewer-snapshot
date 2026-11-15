// Type definitions for AWS and Azure SDKs when packages are not available
declare module '@aws-sdk/client-secrets-manager' {
  export interface GetSecretValueCommand {
    constructor(params: { SecretId: string; VersionId?: string });
  }

  export interface CreateSecretCommand {
    constructor(params: { Name: string; SecretString: string; Description?: string });
  }

  export interface UpdateSecretCommand {
    constructor(params: { SecretId: string; SecretString: string; Description?: string });
  }

  export interface DeleteSecretCommand {
    constructor(params: { SecretId: string; ForceDeleteWithoutRecovery?: boolean });
  }

  export class SecretsManagerClient {
    constructor(config: unknown);
    send(command: unknown): Promise<any>;
  }
}

declare module '@azure/keyvault-secrets' {
  export interface SecretClientOptions {
    retryOptions?: unknown;
  }

  export class SecretClient {
    constructor(vaultUrl: string, credential: unknown, options?: SecretClientOptions);
    getSecret(name: string, options?: unknown): Promise<{ value?: string; properties?: unknown }>;
    setSecret(name: string, value: string, options?: unknown): Promise<any>;
    deleteSecret(name: string): Promise<any>;
  }
}

declare module '@azure/identity' {
  export class DefaultAzureCredential {
    constructor(options?: unknown);
  }
}