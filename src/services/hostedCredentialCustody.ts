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

export interface ApprovalFingerprintKeyInput {
  key?: string;
  jwtSecret?: string;
  aiConfigEncryptionKey?: string;
  credentialEncryptionKey?: string;
}

/**
 * A8: validates `APPROVAL_FINGERPRINT_HMAC_KEY` for a production-strength boot.
 *
 * Returns a fixed reason fragment, or `null` when the key is acceptable. The
 * return value is joined to the variable name by the caller and logged, so it
 * must never quote the rejected value — a near-miss key is still key material.
 *
 * The separation rule is partly enforced rather than only documented. An
 * operator asked for "64 hex characters" can satisfy the format by reusing or
 * hex-encoding a secret they already hold, which produces a well-formed key
 * whose compromise blast radius is precisely the one the dedicated key exists
 * to bound.
 *
 * EXACTLY three forms are rejected, and the list is not a claim of coverage:
 *
 *  1. byte-identical reuse of JWT_SECRET;
 *  2. the key being the LEADING 32 bytes of JWT_SECRET;
 *  3. the key being the LEADING 64 characters of JWT_SECRET's hex encoding;
 *
 * plus exact reuse of AI_CONFIG_ENCRYPTION_KEY or CREDENTIAL_ENCRYPTION_KEY.
 *
 * Those are the forms an operator produces by hand. Anything else — a suffix
 * or mid-string slice, a hash, an HMAC, any KDF — is NOT detected and cannot
 * reliably be: a derived key is computationally indistinguishable from an
 * independent one. Copilot review on #1131 flagged an earlier version of this
 * comment for claiming the prefix check worked "regardless of where the
 * encoding was truncated", which was false for exactly that reason. Provisioning
 * a genuinely independent key remains an operator responsibility that this
 * function narrows but does not discharge.
 */
export function validateApprovalFingerprintKey(
  input: ApprovalFingerprintKeyInput,
): string | null {
  const key = input.key;
  if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key)) {
    return 'is required in production and hosted demo, and must be exactly 64 hexadecimal characters (32 bytes)';
  }

  const normalized = key.toLowerCase();
  for (const [label, other] of [
    ['AI_CONFIG_ENCRYPTION_KEY', input.aiConfigEncryptionKey],
    ['CREDENTIAL_ENCRYPTION_KEY', input.credentialEncryptionKey],
  ] as const) {
    if (other && other.trim().toLowerCase() === normalized) {
      return `must not reuse ${label}; provision a dedicated key`;
    }
  }

  if (input.jwtSecret) {
    const jwtSecret = input.jwtSecret;
    // Exact reuse first, and it is NOT covered by the prefix checks below: a
    // JWT_SECRET that happens to be 64 hex characters is byte-identical to the
    // key while its hex ENCODING (128 characters) shares no prefix with it.
    // Codex caught this: key = jwtSecret = 'a'.repeat(64) passed cleanly.
    if (jwtSecret.toLowerCase() === normalized) {
      return 'must not reuse JWT_SECRET; provision a dedicated key';
    }
    // Raw-byte derivation: the key is the first 32 bytes of JWT_SECRET,
    // hex-encoded. Compared as BYTES rather than as decoded text, because
    // decoding 32 random bytes as UTF-8 is lossy — invalid sequences become
    // U+FFFD, so a text comparison silently answers a different question.
    const jwtBytes = Buffer.from(jwtSecret, 'utf8');
    const keyBytes = Buffer.from(normalized, 'hex');
    if (jwtBytes.length >= keyBytes.length && jwtBytes.subarray(0, keyBytes.length).equals(keyBytes)) {
      return 'must not be derived from JWT_SECRET; provision a dedicated key';
    }
    // Hex-encoding derivation: JWT_SECRET hex-encoded and truncated to 64
    // characters, which is what an operator reaching for "64 hex characters"
    // most naturally produces from a secret they already hold.
    const jwtHex = jwtBytes.toString('hex').toLowerCase();
    if (jwtHex.startsWith(normalized)) {
      return 'must not be derived from JWT_SECRET; provision a dedicated key';
    }
  }

  return null;
}
