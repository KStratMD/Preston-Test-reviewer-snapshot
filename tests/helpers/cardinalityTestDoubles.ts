import type { FieldMapping, IntegrationConfig } from '../../src/types';
import type {
  CardinalityAnalysisInput,
  CardinalityEdge,
  CardinalityFieldMetadata,
  CardinalityFinding,
  CardinalityKeyDeclarations,
  CardinalityPlanInput,
  CardinalityPreflight,
  CardinalityReport,
  CardinalityStrategy,
  ConfigurationCommandContext,
  MappingDirection,
  PreflightRunResult,
  RelationshipEvidence,
} from '../../src/types/cardinality';
import type {
  CardinalityActivationDecisionInput,
  CardinalityActivationOutcomeInput,
} from '../../src/services/ai/orchestrator/AuditService';

/**
 * Shared factory/builder helpers for cardinality tests (Task 3 and later
 * tasks). Every factory returns a fresh plain object with sensible defaults
 * and a shallow `overrides` merge, so a test states only the field it exercises.
 * Helpers never read the clock, the filesystem, or the environment.
 */

export function makeEdge(overrides: Partial<CardinalityEdge> = {}): CardinalityEdge {
  return {
    fromEntity: 'Account',
    fromField: 'Contacts',
    toEntity: 'Contact',
    toField: 'AccountId',
    cardinality: 'one_to_many',
    direction: 'source_to_target',
    required: false,
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<RelationshipEvidence> = {}): RelationshipEvidence {
  return {
    system: 'salesforce',
    entity: 'Account',
    status: 'available',
    edges: [],
    provenance: { source: 'api' },
    ...overrides,
  };
}

export function makeFieldMetadata(
  overrides: Partial<CardinalityFieldMetadata> = {},
): CardinalityFieldMetadata {
  return {
    entity: 'Account',
    field: 'Name',
    isCollection: false,
    ...overrides,
  };
}

export function makeFieldMapping(overrides: Partial<FieldMapping> = {}): FieldMapping {
  return {
    sourceField: 'Name',
    targetField: 'companyName',
    transformationType: 'direct',
    isRequired: false,
    ...overrides,
  };
}

export function makeSeparateRecordsStrategy(
  overrides: Partial<Extract<CardinalityStrategy, { resolution: 'separate_records' }>> = {},
): CardinalityStrategy {
  return {
    resolution: 'separate_records',
    direction: 'source_to_target',
    relationshipPath: ['contacts'],
    childConfigurationId: 'child-config-1',
    parentKeyMapping: { sourceField: 'AccountId', targetField: 'parentId' },
    ...overrides,
  };
}

export function makeFanOutStrategy(
  overrides: Partial<Extract<CardinalityStrategy, { resolution: 'fan_out' }>> = {},
): CardinalityStrategy {
  return {
    resolution: 'fan_out',
    direction: 'source_to_target',
    relationshipPath: ['contacts'],
    targetEntity: 'ContactRecord',
    targetKeyFields: ['externalId'],
    ...overrides,
  };
}

export function makeKeyDeclarations(
  overrides: Partial<CardinalityKeyDeclarations> = {},
): CardinalityKeyDeclarations {
  return {
    sourceRecordKeys: ['id'],
    parentKeys: ['accountId'],
    targetKeys: ['externalId'],
    ...overrides,
  };
}

export function makeAnalysisInput(
  overrides: Partial<CardinalityAnalysisInput> = {},
): CardinalityAnalysisInput {
  return {
    analyzerVersion: '1.0.0',
    direction: 'source_to_target',
    sourceSystem: 'salesforce',
    targetSystem: 'netsuite',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    fieldMetadata: [],
    sourceEvidence: makeEvidence(),
    targetEvidence: makeEvidence({ system: 'netsuite', entity: 'Customer' }),
    fieldMappings: [],
    strategies: [],
    keyDeclarations: makeKeyDeclarations(),
    ...overrides,
  };
}

export function makeFinding(overrides: Partial<CardinalityFinding> = {}): CardinalityFinding {
  const direction: MappingDirection = overrides.direction ?? 'source_to_target';
  return {
    key: 'relationship_flatten|source_to_target|contacts|0',
    type: 'relationship_flatten',
    severity: 'blocking',
    overrideable: true,
    direction,
    mappingIndexes: [0],
    message: 'Test finding',
    resolutionOptions: [],
    ...overrides,
  };
}

export function makeReport(overrides: Partial<CardinalityReport> = {}): CardinalityReport {
  return {
    analyzerVersion: '1.0.0',
    direction: 'source_to_target',
    findings: [],
    fingerprint: 'test-fingerprint',
    unavailableChecks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Activation-gate doubles (Task 7). These let ConfigurationService tests drive
// the coordinator result deterministically instead of exercising the real
// evidence provider. A CLEAN preflight double returns a non-blocking result so
// legacy active-save tests keep passing WITHOUT weakening the production gate.
// ---------------------------------------------------------------------------

/** Builds a non-blocking `PreflightRunResult` (one clean directional report). */
export function makePreflightRunResult(
  overrides: Partial<PreflightRunResult> = {},
): PreflightRunResult {
  return {
    reports: [makeReport()],
    blocking: false,
    combinedFingerprint: 'combined-fingerprint',
    ...overrides,
  };
}

/**
 * A `CardinalityPreflight` stub. By default every run resolves to a non-blocking
 * result. Pass a fixed result or a function to drive blocking/override scenarios.
 */
export function makeStubPreflight(
  result: PreflightRunResult | (() => PreflightRunResult) = makePreflightRunResult(),
): CardinalityPreflight {
  const resolve = typeof result === 'function' ? result : () => result;
  return {
    runForConfig: jest.fn(
      async (_config: IntegrationConfig, _samples?: Record<string, unknown>[]) => resolve(),
    ),
    runForPlan: jest.fn(
      async (
        _plan: CardinalityPlanInput,
        _tenantId: string,
        _samples?: Record<string, unknown>[],
      ) => resolve(),
    ),
  };
}

/** Alias that reads clearly at legacy call sites: an explicit non-blocking gate. */
export function makeCleanPreflight(): CardinalityPreflight {
  return makeStubPreflight(makePreflightRunResult());
}

export interface CardinalityAuditDouble {
  logCardinalityDecision: jest.Mock<Promise<string>, [CardinalityActivationDecisionInput]>;
  logCardinalityOutcome: jest.Mock<Promise<string>, [CardinalityActivationOutcomeInput]>;
}

/** Recording audit double. Both methods resolve to a stub id by default. */
export function makeAuditDouble(): CardinalityAuditDouble {
  return {
    logCardinalityDecision: jest.fn(async () => 'decision-audit-id'),
    logCardinalityOutcome: jest.fn(async () => 'outcome-audit-id'),
  };
}

export interface CardinalityGateDouble {
  preflight: CardinalityPreflight;
  audit: CardinalityAuditDouble;
}

/** The full gate bundle ConfigurationService injects, wired to doubles. */
export function makeGateDouble(
  preflight: CardinalityPreflight = makeCleanPreflight(),
  audit: CardinalityAuditDouble = makeAuditDouble(),
): CardinalityGateDouble {
  return { preflight, audit };
}

/**
 * Trusted `ConfigurationCommandContext` factory (Task 8). Every active-write
 * caller — routes, `SecureConfigurationService`, `DisasterRecoveryService`,
 * the boot-owned startup migration — needs a concrete operation/tenant/actor/
 * correlation id; this keeps that four-field literal from being hand-rolled
 * (and drifting) at every call site.
 */
export function makeCommandContext(
  overrides: Partial<ConfigurationCommandContext> = {},
): ConfigurationCommandContext {
  return {
    tenantId: 'test-tenant',
    actorUserId: 'user-1',
    correlationId: 'correlation-1',
    operation: 'create',
    ...overrides,
  };
}
