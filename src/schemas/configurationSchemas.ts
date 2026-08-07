import { z } from 'zod';
import { getSystemType } from '../connectors/connectorIdentity';
import {
  evaluateSerializedAssetProfile,
  SALESFORCE_FIELD_NAME_PATTERN,
} from '../services/serializedAsset/SerializedAssetProfileValidator';

// Authentication Schema
const AuthenticationCredentialsSchema = z.record(z.string(), z.any()).refine(
  (credentials) => {
    // Must have at least one credential field
    return Object.keys(credentials).length > 0;
  },
  {
    message: 'Authentication credentials cannot be empty',
  },
);

const AuthenticationConfigSchema = z.object({
  type: z.enum(['oauth1', 'oauth2', 'api_key', 'basic', 'token'], {
    message: 'Authentication type must be one of: oauth1, oauth2, api_key, basic, token',
  }),
  credentials: AuthenticationCredentialsSchema,
  refreshable: z.boolean().optional(),
  expiresAt: z.coerce.date().optional(),
});

// Managed credential reference schema (Prerequisite PR B, 2026-07-27 NetSuite
// serialized-asset sync plan — decision 15: managed credentials are a
// prerequisite PLATFORM capability, not feature-specific parsing).
// `.strict()` rejects unknown keys so a server-authored SystemConfig can't
// silently carry an unrecognized field through persistence. Deliberately does
// NOT `.transform()`: `validateIntegrationConfig()` discards `result.data`, so
// the canonical schema must ACCEPT (never rewrite) whatever valid SystemConfig
// shape a caller supplies. Runtime projections (`getSystemType` /
// `connectorKeyForSystem` from Prerequisite A's connectorIdentity module)
// normalize casing/spelling at every read boundary instead.
/**
 * REJECTS surrounding whitespace rather than trimming it (Copilot R4; scope
 * settled by Codex R5, then corrected by Codex R6).
 *
 * `.trim()` is a transform, which contradicts the "accept, never rewrite" rule
 * above in the one way that matters: `validateIntegrationConfig()` discards
 * `result.data`, so a padded value validates against its TRIMMED form and then
 * persists RAW. Every consumer downstream reads the raw string, and NOT all of
 * them trim:
 *
 *   - `SecureCredentialManager.getCredentialKey` builds
 *     `credentials_${systemType}_${systemId}` and lowercases WITHOUT trimming,
 *     so a padded object-form record NAMES a different secret than the operator
 *     configured — two configs identical in the UI addressing different
 *     credentials. `TenantSettingSystemCredentialRegistry` derives its
 *     ownership-registry key the same untrimmed way, deliberately, so the
 *     ownership decision and the key derivation can never disagree.
 *   - `IntegrationService.getSystemHealth()` collects system types from stored
 *     configurations with RAW `getSystemType()` and resolves them through this
 *     class's own exact-match PascalCase `registryKeyMap`, so a padded
 *     reference misses the map and that system is reported unreachable.
 *
 * Those are why this applies to the legacy plain-string branch too. A round-5
 * revision exempted that branch on the theory that `connectorKeyForSystem`
 * (which does trim) was its only projection; Codex R6 reproduced a failure and
 * refuted it, so the exemption is withdrawn. The asymmetry is pinned by test
 * rather than left to this comment.
 *
 * WHAT PR A2 CHANGED (deployment-readiness Tranche A). The second bullet used
 * to name `testIntegration` and the sync paths, which projected raw and threw
 * `Unsupported system type:  Salesforce `. A2 routed those four standard paths
 * (run, test, single-record, initialize) through `ConnectorManager`, whose
 * `connectorKeyForSystem()` projection DOES trim — so on those paths a padded
 * reference now resolves a connector, and that particular runtime failure is
 * gone. The justification did not evaporate, it split:
 *
 *   - For a MANAGED (`secret_manager`) reference the runtime still fails
 *     closed, and harder than before: the resolver hands the untrimmed type to
 *     the ownership registry, which looks under
 *     `integration.managed_systems. netsuite ` — a key the clean registration
 *     cannot occupy — and returns a 403 refusal before any secret is fetched
 *     and before any connector is created. Pinned in
 *     `tests/unit/services/IntegrationService.core.test.ts`.
 *   - For a legacy plain-string reference the surviving runtime consequence is
 *     the `getSystemHealth()` miss above.
 *
 * So the schema rule is the PRIMARY guard here and the runtime failures are
 * defense in depth, not the operator-facing experience. Neither this rule nor
 * the registry's no-trim policy should be relaxed on the strength of A2.
 *
 * Refusing is the only option that keeps validation and persistence describing
 * the same string, given the parse result is thrown away. The blank case needs
 * no second refine: '' fails `.min(1)`, and any other whitespace-only string
 * fails the trim-equality check.
 *
 * MIGRATION IMPACT, stated plainly because an earlier version of this comment
 * got it wrong: the object-form system reference PREDATES this PR
 * (`src/types/index.ts`), and `loadSingleConfiguration()` parses stored JSON
 * WITHOUT canonical validation, so a stored record may already carry a padded
 * `type`/`systemId`/string reference. Such a record keeps LOADING; only the next
 * save/import of it is refused. This is not a working configuration being taken
 * away — a padded record either resolves the wrong secret or cannot construct
 * its connector at all. A validation error naming the field beats both.
 */
const noSurroundingWhitespace = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), {
      message: 'must not have leading or trailing whitespace',
    });

const SystemConfigSchema = z.object({
  type: noSurroundingWhitespace(50),
  systemId: noSurroundingWhitespace(200).optional(),
  credentialSource: z.enum(['secret_manager', 'environment', 'inline']).optional(),
}).strict();

const SystemReferenceSchema = z.union([
  noSurroundingWhitespace(50),
  SystemConfigSchema,
]);

type ParsedSystemReference = z.infer<typeof SystemReferenceSchema>;

/**
 * Cross-field credential/authentication rule for ONE side (source or target)
 * of an IntegrationConfig. Resolution rules are exact (mirrored in
 * ConnectorCredentialResolver):
 *   - `secret_manager`: `systemId` is required and the side's inline
 *     authentication object must be ABSENT (the secret manager is the only
 *     credential source once declared);
 *   - `inline`, omitted `credentialSource`, or a legacy string system
 *     reference: the side's PRE-EXISTING authentication requirement applies
 *     (source: unconditional; target: only when `syncDirection` is
 *     'bidirectional', per `requireAuth`) — unchanged from before this PR;
 *   - `environment`: no secret value is persisted by this model; no
 *     authentication requirement is imposed (existing environment-backed
 *     connector behavior — ConnectorManager skips `initialize()` — is
 *     unchanged).
 */
function checkManagedCredentialPair(
  system: ParsedSystemReference,
  auth: unknown,
  authField: 'sourceAuthentication' | 'targetAuthentication',
  systemField: 'sourceSystem' | 'targetSystem',
  requireAuth: boolean,
  ctx: z.RefinementCtx,
): void {
  if (typeof system === 'string') {
    if (requireAuth && auth === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `${authField} is required when ${systemField} has no managed credential reference`,
        path: [authField],
      });
    }
    return;
  }

  switch (system.credentialSource) {
    case 'secret_manager':
      if (!system.systemId) {
        ctx.addIssue({
          code: 'custom',
          message: `${systemField}.systemId is required when credentialSource is 'secret_manager'`,
          path: [systemField, 'systemId'],
        });
      }
      if (auth !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${authField} must be absent when ${systemField}.credentialSource is 'secret_manager'`,
          path: [authField],
        });
      }
      break;
    case 'environment':
      // 'environment' declares that credentials come from the process
      // environment, so an inline auth object alongside it is REFUSED (Copilot
      // R4) rather than tolerated: it persists a plaintext secret at rest that
      // the declaration says should not exist. Same posture as 'secret_manager'.
      //
      // MIGRATION IMPACT (Codex R5 refuted the original claim here; Codex R6
      // corrected the follow-up too). `credentialSource` is NOT introduced by
      // this PR — it predates it in `src/types/index.ts`, and
      // `loadSingleConfiguration()` parses stored JSON WITHOUT canonical
      // validation — so a stored record CAN already pair 'environment' with an
      // inline auth object.
      //
      // And that inline object is NOT merely dead weight: `ConnectorCredentialResolver`
      // ignores it, but `IntegrationService`'s legacy paths call
      // `initialize(config.sourceAuthentication)` directly, gated only against
      // 'secret_manager'. Such a record is therefore genuinely USING those
      // credentials today while declaring that its credentials come from the
      // environment.
      //
      // The refusal stands — the record is mislabelled, and the schema should
      // not certify a declaration its own runtime contradicts — but the operator
      // remedy is a real choice, so the message states both halves: drop the
      // inline object and supply the credentials through the environment, or set
      // `credentialSource: 'inline'`, which preserves today's behavior exactly.
      // The record keeps LOADING either way; only the next save/import is refused.
      if (auth !== undefined) {
        ctx.addIssue({
          code: 'custom',
          // Field-neutral about WHERE the inline auth came from (Codex R7):
          // `auth` is resolved from `${authField}` OR the legacy
          // `authentication.source`/`.target` fallback, so naming only the
          // former would point an operator at a field their config may not
          // contain.
          message: `inline authentication (${authField} or the legacy authentication.${systemField === 'sourceSystem' ? 'source' : 'target'}) must be absent when ${systemField}.credentialSource is 'environment' — either remove it and supply the credentials through the environment, or set ${systemField}.credentialSource to 'inline' to keep using it`,
          path: [authField],
        });
      }
      break;
    case 'inline':
    case undefined:
      if (requireAuth && auth === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${authField} is required when ${systemField}.credentialSource is 'inline' or omitted`,
          path: [authField],
        });
      }
      break;
  }
}

// Cardinality aggregate operators (must mirror AggregateOperator in src/types/cardinality.ts)
const AGGREGATE_OPERATORS = ['join', 'sum', 'count', 'min', 'max', 'first_non_null'] as const;

const OrderByEntrySchema = z.object({
  field: z.string().min(1, 'Order-by field cannot be empty'),
  direction: z.enum(['asc', 'desc']),
}).strict();

// Field-value cardinality resolution (lives on the one mapping owning the target).
// `manual_review` is intentionally absent — it is an operator disposition, never a
// resolution, so the discriminated union rejects it.
export const FieldCardinalityResolutionSchema = z.discriminatedUnion('resolution', [
  z.object({
    resolution: z.literal('aggregate'),
    operator: z.enum(AGGREGATE_OPERATORS),
    separator: z.string().min(1, 'Separator cannot be empty').optional(),
  }).strict(),
  z.object({
    resolution: z.literal('select_one'),
    orderBy: z.array(OrderByEntrySchema).min(1, 'select_one requires non-empty ordering'),
    tieBreak: OrderByEntrySchema,
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.resolution === 'aggregate') {
    if (value.operator === 'join' && value.separator === undefined) {
      ctx.addIssue({ code: 'custom', message: 'aggregate join requires a separator', path: ['separator'] });
    }
    if (value.operator !== 'join' && value.separator !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'separator is only valid for join aggregation', path: ['separator'] });
    }
  }
});

// Entity/flow cardinality strategy (lives at configuration level).
export const CardinalityStrategySchema = z.discriminatedUnion('resolution', [
  z.object({
    resolution: z.literal('separate_records'),
    direction: z.enum(['source_to_target', 'target_to_source']),
    relationshipPath: z.array(z.string().min(1)).min(1, 'relationshipPath cannot be empty'),
    childConfigurationId: z.string().min(1, 'childConfigurationId is required'),
    parentKeyMapping: z.object({
      sourceField: z.string().min(1),
      targetField: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    resolution: z.literal('fan_out'),
    direction: z.enum(['source_to_target', 'target_to_source']),
    relationshipPath: z.array(z.string().min(1)).min(1, 'relationshipPath cannot be empty'),
    targetEntity: z.string().min(1, 'targetEntity is required'),
    targetKeyFields: z.array(z.string().min(1)).min(1, 'targetKeyFields cannot be empty'),
  }).strict(),
]);

// Field Mapping Schema
export const FieldMappingSchema = z.object({
  sourceField: z.string().min(1, 'Source field cannot be empty'),
  targetField: z.string().min(1, 'Target field cannot be empty'),
  transformationType: z.enum(['direct', 'concatenate', 'concatenation', 'split', 'lookup', 'expression', 'conditional', 'calculation'], {
    message: 'Invalid transformation type',
  }),
  isRequired: z.boolean(),
  defaultValue: z.any().optional(),
  transformationConfig: z.object({
    type: z.string().optional(),
    fields: z.array(z.string()).optional(),
    separator: z.string().optional(),
    lookupTable: z.string().optional(),
    keyField: z.string().optional(),
    valueField: z.string().optional(),
    expression: z.string().optional(),
  }).optional(),
  cardinality: FieldCardinalityResolutionSchema.optional(),
});

// Validation Rule Schema
const ValidationRuleSchema = z.object({
  field: z.string().min(1, 'Field name is required'),
  type: z.enum(['required', 'pattern', 'length', 'range', 'custom', 'format'], {
    message: 'Invalid validation rule type',
  }),
  value: z.object({
    pattern: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
  message: z.string().min(1, 'Validation message is required'),
});

// Transformation Rule Schema
const TransformationRuleSchema = z.object({
  id: z.string().min(1, 'Transformation rule ID is required'),
  name: z.string().min(1, 'Transformation rule name is required'),
  type: z.enum([
    'conditional_logic', 'data_validation', 'data_enrichment', 'business_logic',
    'field_mapping', 'enrichment', 'VALIDATION', 'TRANSFORMATION', 'ENRICHMENT', 'FILTER',
  ], {
    message: 'Invalid transformation rule type',
  }),
  condition: z.string().optional(),
  action: z.enum([
    'set_field_value', 'validate_field', 'calculate_field', 'transform', 'validate',
    'enrich', 'filter', 'reject', 'conditional_mapping', 'set_default_value',
    'validate_required', 'derive_account_type', 'validate_email_format',
  ], {
    message: 'Invalid transformation rule action',
  }),
  parameters: z.object({
    targetField: z.string().optional(),
    field: z.string().optional(),
    validationType: z.string().optional(),
    validationConfig: z.object({
      pattern: z.string().optional(),
    }).optional(),
    conditions: z.array(z.object({
      field: z.string(),
      operator: z.enum(['equals', 'greater_than', 'less_than', 'greater_equal', 'less_equal', 'contains']),
      value: z.any(),
      result: z.any(),
    })).optional(),
    defaultValue: z.any().optional(),
    calculation: z.string().optional(),
    sourceField: z.string().optional(),
    referenceDate: z.string().optional(),
    unit: z.string().optional(),
    type: z.string().optional(),
    rules: z.array(ValidationRuleSchema).optional(),
    expression: z.string().optional(),
    context: z.record(z.string(), z.any()).optional(),
  }).optional(),
});

// Retry Configuration Schema
const RetryConfigSchema = z.object({
  maxRetries: z.number().int().min(0).max(10, 'Maximum retries cannot exceed 10'),
  retryDelay: z.number().int().min(100, 'Retry delay must be at least 100ms').max(60000, 'Retry delay cannot exceed 60 seconds'),
  backoffStrategy: z.enum(['linear', 'exponential'], {
    message: 'Backoff strategy must be either \'linear\' or \'exponential\'',
  }),
});

// netsuite_serialized_asset execution profile (Task 1, 2026-07-27 NetSuite
// serialized-asset sync plan). `.strict()` rejects unknown keys. Salesforce
// field identifiers are validated for shape only — NEVER `.trim()`ed or
// otherwise rewritten (decision: "Salesforce field API names are never
// normalized or rewritten — they stay exact validated identifiers"). The
// regex is the single `SALESFORCE_FIELD_NAME_PATTERN` shared with
// SerializedAssetProfileValidator so the two layers can't drift.
const SerializedAssetProfileDraftConfigSchema = z.object({
  executionProfile: z.literal('netsuite_serialized_asset'),
  productExternalIdField: z.string().min(1).max(200)
    .regex(SALESFORCE_FIELD_NAME_PATTERN, 'productExternalIdField must be a valid Salesforce field API name')
    .optional(),
  assetExternalIdField: z.string().min(1).max(200)
    .regex(SALESFORCE_FIELD_NAME_PATTERN, 'assetExternalIdField must be a valid Salesforce field API name')
    .optional(),
  serialNumberTargetField: z.literal('SerialNumber').optional(),
  productReferenceTargetField: z.literal('Product2Id').optional(),
  statusTargetField: z.string().min(1).max(200)
    .regex(SALESFORCE_FIELD_NAME_PATTERN, 'statusTargetField must be a valid Salesforce field API name')
    .optional(),
  locationTargetField: z.string().min(1).max(200)
    .regex(SALESFORCE_FIELD_NAME_PATTERN, 'locationTargetField must be a valid Salesforce field API name')
    .optional(),
}).strict();

// Main Integration Configuration Schema
export const IntegrationConfigSchema = z.object({
  id: z.string()
    .min(1, 'Configuration ID is required')
    .max(100, 'Configuration ID cannot exceed 100 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Configuration ID must contain only alphanumeric characters, underscores, and hyphens'),

  tenantId: z.string()
    .min(1, 'Tenant ID is required')
    .max(100, 'Tenant ID cannot exceed 100 characters')
    // Mirror the `id` constraint: tenantId is the in-memory storage-key component
    // (`${tenantId}::${id}`) and ConfigurationService.storageKey() already rejects
    // non-segment-safe values at runtime. Declaring it here surfaces the same
    // constraint at the schema layer with a clear message instead of a later
    // ValidationError from storageKey (Copilot review).
    .regex(/^[a-zA-Z0-9_-]+$/, 'Tenant ID must contain only alphanumeric characters, underscores, and hyphens'),

  name: z.string()
    .min(1, 'Configuration name is required')
    .max(200, 'Configuration name cannot exceed 200 characters'),

  description: z.string()
    .max(1000, 'Description cannot exceed 1000 characters')
    .optional(),

  sourceSystem: SystemReferenceSchema,

  targetSystem: SystemReferenceSchema,

  sourceEntity: z.string()
    .min(1, 'Source entity is required')
    .max(100, 'Source entity name cannot exceed 100 characters'),

  targetEntity: z.string()
    .min(1, 'Target entity is required')
    .max(100, 'Target entity name cannot exceed 100 characters'),

  syncDirection: z.enum(['unidirectional', 'bidirectional', 'source_to_target', 'target_to_source'], {
    message: 'Sync direction must be one of: unidirectional, bidirectional, source_to_target, target_to_source',
  }),

  syncMode: z.enum(['realtime', 'batch', 'manual'], {
    message: 'Sync mode must be one of: realtime, batch, manual',
  }),

  isActive: z.boolean(),

  fieldMappings: z.array(FieldMappingSchema)
    .max(100, 'Cannot have more than 100 field mappings')
    .optional()
    .default([]),

  transformationRules: z.array(TransformationRuleSchema)
    .max(50, 'Cannot have more than 50 transformation rules')
    .optional()
    .default([]),

  // Optional (Prerequisite PR B): a secret-manager/environment system
  // reference can exist without an inline secret. Cross-field requirement is
  // enforced below by checkManagedCredentialPair, not by base-schema
  // requiredness.
  sourceAuthentication: AuthenticationConfigSchema.optional(),

  targetAuthentication: AuthenticationConfigSchema.optional(),

  // Legacy fallback shape (IntegrationConfig.authentication.source/.target).
  // MUST be declared here (not left undeclared) — a plain z.object() strips
  // unrecognized keys from its parsed output BEFORE superRefine ever runs, so
  // an undeclared `authentication` field would be invisible to
  // checkManagedCredentialPair() below and let a plaintext secret persist
  // alongside a `secret_manager` reference (validateIntegrationConfig
  // discards result.data, so the RAW input — including this field — persists
  // verbatim regardless of what the parsed shape strips).
  authentication: z.object({
    source: AuthenticationConfigSchema.optional(),
    target: AuthenticationConfigSchema.optional(),
  }).optional(),

  batchSize: z.number()
    .int()
    .min(1, 'Batch size must be at least 1')
    .max(10000, 'Batch size cannot exceed 10,000')
    .optional()
    .default(100),

  retryConfig: RetryConfigSchema.optional(),

  // Entity/flow cardinality strategies are persisted configuration.
  cardinalityStrategies: z.array(CardinalityStrategySchema).optional(),

  // The `_cardinality` transport envelope (override + samples) must be stripped
  // before persistence. Declaring it as `never` turns silent stripping into an
  // explicit rejection if it ever reaches the canonical schema. Server-authored
  // `cardinalityApproval` / `cardinalityValidation` are deliberately NOT declared
  // here, so a client- or import-supplied value is stripped (never trusted); the
  // server writes those onto the in-memory config outside this input schema.
  _cardinality: z.never().optional(),

  // Dedicated execution profile (Task 1). `undefined` and `'standard'`
  // preserve current behavior; `executionProfileConfig` is validated for
  // discriminator agreement and (when active) full readiness below.
  executionProfile: z.enum(['standard', 'netsuite_serialized_asset']).optional(),
  executionProfileConfig: SerializedAssetProfileDraftConfigSchema.optional(),

  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
}).superRefine((config, ctx) => {
  // The "auth present?" check must see BOTH the direct field
  // (sourceAuthentication/targetAuthentication) AND the legacy fallback
  // shape (authentication.source/.target) — ConnectorCredentialResolver
  // treats them as equivalent inline-auth sources (`?? ` fallback), so a
  // secret_manager reference paired with EITHER shape is the same plaintext-
  // secret-at-rest violation. Combining them here closes that bypass.
  const sourceAuth = config.sourceAuthentication ?? config.authentication?.source;
  const targetAuth = config.targetAuthentication ?? config.authentication?.target;

  // Source authentication is unconditionally required unless the source
  // system reference resolves its credential another way (secret_manager /
  // environment) — unchanged from the pre-PR-B unconditional requirement.
  checkManagedCredentialPair(
    config.sourceSystem, sourceAuth, 'sourceAuthentication', 'sourceSystem', true, ctx,
  );
  // Target authentication is required only for bidirectional sync — the
  // pre-existing rule ("bidirectional sync requires target authentication")
  // is preserved, now folded into the same per-side check so a
  // secret_manager/environment target reference satisfies it without an
  // inline secret.
  checkManagedCredentialPair(
    config.targetSystem, targetAuth, 'targetAuthentication', 'targetSystem',
    config.syncDirection === 'bidirectional', ctx,
  );

  // netsuite_serialized_asset execution profile (Task 1). Discriminator
  // agreement is checked regardless of isActive — a draft cannot carry
  // executionProfileConfig without declaring the profile, and vice versa.
  // Full readiness (systems/entities/direction/mode + required mappings) is
  // only enforced for ACTIVE specialized persistence ("Active specialized
  // persistence always uses that strict path" — inactive drafts may still
  // omit discovered fields/mappings).
  if (config.executionProfileConfig !== undefined && config.executionProfile !== 'netsuite_serialized_asset') {
    ctx.addIssue({
      code: 'custom',
      message: "executionProfileConfig requires executionProfile to be 'netsuite_serialized_asset'",
      path: ['executionProfileConfig'],
    });
  } else if (config.executionProfile === 'netsuite_serialized_asset') {
    if (config.executionProfileConfig === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "executionProfileConfig is required when executionProfile is 'netsuite_serialized_asset'",
        path: ['executionProfileConfig'],
      });
    } else if (config.isActive) {
      const evaluation = evaluateSerializedAssetProfile({
        sourceSystem: config.sourceSystem,
        targetSystem: config.targetSystem,
        sourceEntity: config.sourceEntity,
        targetEntity: config.targetEntity,
        syncDirection: config.syncDirection,
        syncMode: config.syncMode,
        isActive: config.isActive,
        fieldMappings: config.fieldMappings,
        executionProfile: config.executionProfile,
        executionProfileConfig: config.executionProfileConfig,
      });
      // `=== false`, not `!evaluation.ok` — see the comment on the equivalent
      // guard in SerializedAssetProfileValidator.requireReadySerializedAssetProfile.
      if (evaluation.ok === false) {
        evaluation.issues.forEach(issue => {
          ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
        });
      }
    }
  }
}).refine(
  (config) => {
    // Custom validation: source and target systems cannot be the same.
    // Projected through getSystemType() so a legacy string and a SystemConfig
    // object referencing the same system.type are both caught (identity
    // projection for plain strings, so existing plain-string behavior is
    // unchanged).
    if (getSystemType(config.sourceSystem) === getSystemType(config.targetSystem)) {
      return false;
    }
    return true;
  },
  {
    message: 'Source and target systems cannot be the same',
    path: ['targetSystem'],
  },
).refine(
  (config) => {
    // Custom validation: active configurations require at least one field mapping
    if (config.isActive && (!config.fieldMappings || config.fieldMappings.length === 0)) {
      return false;
    }
    return true;
  },
  {
    message: 'Active configurations must have at least one field mapping',
    path: ['fieldMappings'],
  },
);
// NOTE: the former blanket prohibition on duplicate source/target field mappings
// was removed here. Draft configurations must remain saveable while incomplete,
// and duplicate-target detection is now a record-grain cardinality-analysis
// finding at activation time, not a schema-level rejection. A single mapping may
// consolidate multiple source fields, and one source field may legitimately fan
// out to multiple targets; only exact-duplicate/ambiguous target writers are
// blocked, and that decision belongs to CardinalityAnalysisService.

// OAuth2 Specific Schema
export const OAuth2ConfigSchema = z.object({
  type: z.literal('oauth2'),
  credentials: z.object({
    clientId: z.string().min(1, 'Client ID is required'),
    clientSecret: z.string().min(1, 'Client secret is required'),
    tenantId: z.string().optional(),
    resourceUrl: z.string().url('Resource URL must be a valid URL').optional(),
    baseUrl: z.string().url('Base URL must be a valid URL').optional(),
    scope: z.string().optional(),
    tokenUrl: z.string().url('Token URL must be a valid URL').optional(),
  }),
});

// OAuth1 Specific Schema (for NetSuite)
export const OAuth1ConfigSchema = z.object({
  type: z.literal('oauth1'),
  credentials: z.object({
    consumerKey: z.string().min(1, 'Consumer key is required'),
    consumerSecret: z.string().min(1, 'Consumer secret is required'),
    tokenId: z.string().min(1, 'Token ID is required'),
    tokenSecret: z.string().min(1, 'Token secret is required'),
    accountId: z.string().min(1, 'Account ID is required'),
    baseUrl: z.string().url('Base URL must be a valid URL').optional(),
  }),
});

// API Key Schema
export const ApiKeyConfigSchema = z.object({
  type: z.literal('api_key'),
  credentials: z.object({
    apiKey: z.string().min(1, 'API key is required'),
    username: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }),
});

// Basic Auth Schema
export const BasicAuthConfigSchema = z.object({
  type: z.literal('basic'),
  credentials: z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }),
});

// Squire and SuiteCentral schemas use API key authentication
export const SuiteCentralConfigSchema = ApiKeyConfigSchema;
export const SquireConfigSchema = ApiKeyConfigSchema;

// System-specific validation schemas
export const SystemSpecificSchemas = {
  NetSuite: OAuth1ConfigSchema,
  Salesforce: OAuth2ConfigSchema,
  'Dynamics365': OAuth2ConfigSchema,
  SAP: z.union([BasicAuthConfigSchema, ApiKeyConfigSchema]),
  Oracle: z.union([BasicAuthConfigSchema, ApiKeyConfigSchema]),
  BusinessCentral: OAuth2ConfigSchema,
  SuiteCentral: SuiteCentralConfigSchema,
  Squire: SquireConfigSchema,
} as const;

// Configuration validation result
export interface ConfigurationValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  fieldErrors?: Record<string, string[]>;
}

// Validation helper functions
export function validateIntegrationConfig(config: unknown): ConfigurationValidationResult {
  const result = IntegrationConfigSchema.safeParse(config);

  if (result.success) {
    return {
      isValid: true,
      errors: [],
      warnings: [],
    };
  }

  const errors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};

  result.error.issues.forEach(issue => {
    const path = issue.path.join('.');
    const message = issue.message;

    errors.push(path ? `${path}: ${message}` : message);

    if (issue.path.length > 0 && issue.path[0] !== undefined) {
      const fieldPath = issue.path[0].toString();
      if (!fieldErrors[fieldPath]) {
        fieldErrors[fieldPath] = [];
      }
      fieldErrors[fieldPath].push(message);
    }
  });

  return {
    isValid: false,
    errors,
    warnings: [],
    fieldErrors,
  };
}

export function validateSystemAuthentication(systemType: string, authConfig: unknown): ConfigurationValidationResult {
  const schema = SystemSpecificSchemas[systemType as keyof typeof SystemSpecificSchemas];

  if (!schema) {
    return {
      isValid: false,
      errors: [`Unsupported system type: ${systemType}`],
      warnings: [],
    };
  }

  const result = schema.safeParse(authConfig);

  if (result.success) {
    return {
      isValid: true,
      errors: [],
      warnings: [],
    };
  }

  const errors: string[] = [];
  result.error.issues.forEach(issue => {
    const path = issue.path.join('.');
    errors.push(path ? `${path}: ${issue.message}` : issue.message);
  });

  return {
    isValid: false,
    errors,
    warnings: [],
  };
}

// Type inference helpers
export type IntegrationConfigType = z.infer<typeof IntegrationConfigSchema>;
export type OAuth2ConfigType = z.infer<typeof OAuth2ConfigSchema>;
export type OAuth1ConfigType = z.infer<typeof OAuth1ConfigSchema>;
export type ApiKeyConfigType = z.infer<typeof ApiKeyConfigSchema>;
export type BasicAuthConfigType = z.infer<typeof BasicAuthConfigSchema>;
