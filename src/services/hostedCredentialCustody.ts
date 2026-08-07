import type { IntegrationConfig } from '../types';

export type HostedCredentialCustodyInput = Pick<IntegrationConfig,
  'sourceSystem' | 'targetSystem' | 'sourceAuthentication' | 'targetAuthentication' | 'authentication'>;

export interface HostedCredentialCustodyViolation {
  path: string;
  code: 'credential_reference_required' | 'credential_reference_invalid' | 'inline_credentials_forbidden' | 'credential_infrastructure_required' | 'unknown_field_forbidden';
  message: string;
}

const HOSTED_CONFIGURATION_FIELDS = {
  id: true, tenantId: true, name: true, description: true, sourceSystem: true, targetSystem: true,
  sourceEntity: true, targetEntity: true, syncDirection: true, syncMode: true, isActive: true,
  fieldMappings: true, transformationRules: true, sourceAuthentication: true,
  targetAuthentication: true, authentication: true, security: true, batchSize: true,
  retryConfig: true, cardinalityStrategies: true, cardinalityApproval: true,
  cardinalityValidation: true, executionProfile: true, executionProfileConfig: true,
  createdAt: true, updatedAt: true,
} as const satisfies Record<keyof IntegrationConfig, true>;

export function isHostedCredentialCustodyRequired(nodeEnv?: string): boolean {
  const effectiveEnv = nodeEnv ?? process.env.NODE_ENV ?? 'production';
  return effectiveEnv !== 'development' && effectiveEnv !== 'test';
}

function isSystemReference(value: HostedCredentialCustodyInput['sourceSystem']): value is Exclude<HostedCredentialCustodyInput['sourceSystem'], string> {
  return typeof value === 'object' && value !== null;
}

function addSystemViolation(
  violations: HostedCredentialCustodyViolation[],
  path: 'sourceSystem' | 'targetSystem',
  value: HostedCredentialCustodyInput['sourceSystem'],
): void {
  if (!isSystemReference(value)) {
    violations.push({
      path,
      code: 'credential_reference_required',
      message: `${path} must contain a managed credential reference`,
    });
    return;
  }

  if (value.credentialSource === 'inline') {
    violations.push({
      path: `${path}.credentialSource`,
      code: 'inline_credentials_forbidden',
      message: `${path} cannot use inline credentials in hosted mode`,
    });
    return;
  }

  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'systemId' && key !== 'credentialSource') {
      violations.push({
        path: `${path}.${key}`,
        code: 'unknown_field_forbidden',
        message: `${path}.${key} is not allowed in hosted credential references`,
      });
    }
  }

  if (value.credentialSource === 'secret_manager' && !value.systemId?.trim()) {
    violations.push({
      path: `${path}.systemId`,
      code: 'credential_reference_required',
      message: `${path}.systemId is required for a secret_manager credential reference`,
    });
  } else if (value.credentialSource === 'secret_manager' && value.systemId !== value.systemId?.trim()) {
    violations.push({
      path: `${path}.systemId`,
      code: 'credential_reference_invalid',
      message: `${path}.systemId must not have leading or trailing whitespace`,
    });
  }

  if (value.credentialSource !== 'secret_manager' && value.credentialSource !== 'environment') {
    violations.push({
      path,
      code: 'credential_reference_required',
      message: `${path} must declare a secret_manager or environment credential reference`,
    });
  }
}

function addUnknownFieldViolations(
  violations: HostedCredentialCustodyViolation[],
  config: HostedCredentialCustodyInput,
): void {
  for (const key of Object.keys(config as object)) {
    if (!Object.prototype.hasOwnProperty.call(HOSTED_CONFIGURATION_FIELDS, key)) {
      violations.push({
        path: key,
        code: 'unknown_field_forbidden',
        message: `${key} is not allowed in hosted configuration storage`,
      });
    }
  }
}

export function validateHostedCredentialCustody(
  config: HostedCredentialCustodyInput,
  nodeEnv = process.env.NODE_ENV,
): HostedCredentialCustodyViolation[] {
  if (!isHostedCredentialCustodyRequired(nodeEnv)) return [];

  const violations: HostedCredentialCustodyViolation[] = [];
  addUnknownFieldViolations(violations, config);
  addSystemViolation(violations, 'sourceSystem', config.sourceSystem);
  addSystemViolation(violations, 'targetSystem', config.targetSystem);

  if (config.sourceAuthentication !== undefined) {
    violations.push({
      path: 'sourceAuthentication',
      code: 'inline_credentials_forbidden',
      message: 'sourceAuthentication must be written through the secure credential surface',
    });
  }
  if (config.targetAuthentication !== undefined) {
    violations.push({
      path: 'targetAuthentication',
      code: 'inline_credentials_forbidden',
      message: 'targetAuthentication must be written through the secure credential surface',
    });
  }
  if (config.authentication) {
    for (const key of Object.keys(config.authentication)) {
      if (key !== 'source' && key !== 'target') {
        violations.push({
          path: `authentication.${key}`,
          code: 'unknown_field_forbidden',
          message: `authentication.${key} is not allowed in hosted configuration storage`,
        });
      }
    }
  }

  if (config.authentication?.source !== undefined) {
    violations.push({
      path: 'authentication.source',
      code: 'inline_credentials_forbidden',
      message: 'authentication.source must be written through the secure credential surface',
    });
  }
  if (config.authentication?.target !== undefined) {
    violations.push({
      path: 'authentication.target',
      code: 'inline_credentials_forbidden',
      message: 'authentication.target must be written through the secure credential surface',
    });
  }

  return violations;
}

export interface HostedCredentialInfrastructureInput {
  nodeEnv?: string;
  provider?: string;
  encryptionEnabled?: boolean;
  encryptionKey?: string;
  azureKeyVaultName?: string;
  vaultUrl?: string;
  vaultToken?: string;
}

export function validateHostedCredentialInfrastructure(
  input: HostedCredentialInfrastructureInput,
): HostedCredentialCustodyViolation[] {
  if (!isHostedCredentialCustodyRequired(input.nodeEnv)) return [];

  const violations: HostedCredentialCustodyViolation[] = [];
  const provider = input.provider?.trim().toLowerCase() || 'env';
  const add = (path: string, message: string): void => {
    violations.push({ path, code: 'credential_infrastructure_required', message });
  };

  if (input.encryptionEnabled && !input.encryptionKey?.trim()) {
    add('CREDENTIAL_ENCRYPTION_KEY', 'CREDENTIAL_ENCRYPTION_KEY is required when credential encryption is enabled');
  }

  if (provider === 'azure' && !input.azureKeyVaultName?.trim()) {
    add('AZURE_KEY_VAULT_NAME', 'AZURE_KEY_VAULT_NAME is required for the Azure secret provider');
  }
  if (provider === 'hashicorp') {
    if (!input.vaultUrl?.trim()) {
      add('VAULT_URL', 'VAULT_URL is required for the HashiCorp secret provider');
    }
    if (!input.vaultToken?.trim()) {
      add('VAULT_TOKEN', 'VAULT_TOKEN is required for the HashiCorp secret provider');
    }
  }

  return violations;
}
