/**
 * Legacy type definitions for backward compatibility
 * These will be gradually migrated to the new discriminated union types
 */

// Legacy AuthConfig type for existing connectors
export interface LegacyAuthConfig {
  type: 'oauth2' | 'api_key' | 'basic' | 'token' | 'certificate';
  credentials: Record<string, string>;
  refreshable?: boolean;
  expiresAt?: Date;
}

// Legacy transformation config
export type LegacyTransformationConfig = Record<string, unknown>;

// Legacy transformation rule parameters
export type LegacyTransformationRuleParameters = Record<string, unknown>;

/**
 * Convert new AuthConfig to legacy format for existing connectors
 */
export function toLegacyAuthConfig(config: Record<string, unknown>): LegacyAuthConfig {
  return {
    type: config.type as 'oauth2' | 'api_key' | 'basic' | 'token' | 'certificate',
    credentials: config.credentials as Record<string, string>,
    refreshable: config.refreshable as boolean | undefined,
    expiresAt: config.expiresAt as Date | undefined,
  };
}

/**
 * Convert legacy AuthConfig to new format
 */
export function fromLegacyAuthConfig(config: LegacyAuthConfig): Record<string, unknown> {
  return {
    type: config.type,
    credentials: config.credentials,
    refreshable: config.refreshable,
    expiresAt: config.expiresAt,
  };
}
