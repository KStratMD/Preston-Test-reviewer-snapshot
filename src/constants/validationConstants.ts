export const VALID_SYNC_DIRECTIONS = ['bidirectional', 'source_to_target', 'target_to_source'] as const;
export const VALID_SYNC_MODES = ['realtime', 'batch', 'manual', 'scheduled'] as const;
export const VALID_TRANSFORMATION_TYPES = ['direct', 'lookup', 'calculation', 'concatenation'] as const;
export const VALID_RULE_TYPES = ['field_mapping', 'data_validation', 'business_logic', 'enrichment'] as const;
export const VALID_AUTH_TYPES = ['oauth2', 'api_key', 'basic', 'token', 'certificate'] as const;

export type SyncDirection = typeof VALID_SYNC_DIRECTIONS[number];
export type SyncMode = typeof VALID_SYNC_MODES[number];
export type TransformationType = typeof VALID_TRANSFORMATION_TYPES[number];
export type RuleType = typeof VALID_RULE_TYPES[number];
export type AuthType = typeof VALID_AUTH_TYPES[number];

export const NETSUITE_REQUIRED_FIELDS = ['accountId', 'consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret'] as const;
export const DYNAMICS_REQUIRED_FIELDS = ['tenant_id', 'client_id', 'client_secret', 'resource_url'] as const;
