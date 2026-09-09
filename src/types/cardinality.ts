import type { IntegrationConfig, FieldMapping } from './index';

/**
 * Domain types for the cardinality preflight and activation gate.
 *
 * This module is the single source of truth for the feature's pinned public
 * signatures (see docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md).
 * It contains pure data contracts only: no logging, persistence, connector I/O,
 * clock reads, or environment access.
 */

// ---------------------------------------------------------------------------
// Direction and runtime capabilities
// ---------------------------------------------------------------------------

/** Directional plan orientation. Bidirectional configs analyze as two of these. */
export type MappingDirection = 'source_to_target' | 'target_to_source';

/** Aggregate operators available to a field-value `aggregate` resolution. */
export type AggregateOperator = 'join' | 'sum' | 'count' | 'min' | 'max' | 'first_non_null';

/**
 * Which record-grain resolutions the runtime can actually execute. A declared
 * resolution is accepted only when its referenced capability exists. Capabilities
 * ship disabled and turn on only alongside an end-to-end runtime test.
 */
export interface CardinalityRuntimeCapabilities {
  fanOut: boolean;
  separateRecords: boolean;
  aggregateOperators: AggregateOperator[];
  selectOne: boolean;
}

/** Initial registry: no executable cardinality resolution is advertised. */
export const CARDINALITY_RUNTIME_CAPABILITIES = {
  fanOut: false,
  separateRecords: false,
  // Cast keeps the pinned empty-list value while satisfying noImplicitAny.
  aggregateOperators: [] as AggregateOperator[],
  selectOne: false,
} satisfies CardinalityRuntimeCapabilities;

// ---------------------------------------------------------------------------
// Resolution model
// ---------------------------------------------------------------------------

/**
 * Executable resolution kinds a finding can offer. `manual_review` is deliberately
 * absent: it is an operator disposition, never a resolution.
 */
export type CardinalityResolutionKind = 'separate_records' | 'fan_out' | 'aggregate' | 'select_one';

/** Entity/flow strategies that live at configuration level. */
export type CardinalityStrategy =
  | {
      resolution: 'separate_records';
      direction: MappingDirection;
      relationshipPath: string[];
      childConfigurationId: string;
      parentKeyMapping: { sourceField: string; targetField: string };
    }
  | {
      resolution: 'fan_out';
      direction: MappingDirection;
      relationshipPath: string[];
      targetEntity: string;
      targetKeyFields: string[];
    };

/** Field-value strategies that live on the one mapping owning the target field. */
export type FieldCardinalityResolution =
  | {
      resolution: 'aggregate';
      operator: AggregateOperator;
      separator?: string;
    }
  | {
      resolution: 'select_one';
      orderBy: { field: string; direction: 'asc' | 'desc' }[];
      tieBreak: { field: string; direction: 'asc' | 'desc' };
    };

/**
 * Proposed keys the analyzer uses to test uniqueness and records-per-parent.
 * Sample profiling requires non-empty parent and target keys.
 */
export interface CardinalityKeyDeclarations {
  sourceRecordKeys: string[];
  parentKeys: string[];
  targetKeys: string[];
}

// ---------------------------------------------------------------------------
// Relationship evidence
// ---------------------------------------------------------------------------

/** A canonical directed relationship edge, exactly as normalized. */
export interface CardinalityEdge {
  fromEntity: string;
  fromField: string;
  toEntity: string;
  toField: string;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  direction: 'source_to_target';
  required: boolean;
}

/** Server-trusted relationship evidence for one system/entity. */
export interface RelationshipEvidence {
  system: string;
  entity: string;
  status: 'available' | 'unavailable' | 'partial';
  edges: CardinalityEdge[];
  provenance: {
    source: 'api' | 'cache' | 'manual_server';
    schemaVersion?: string;
    discoveredAt?: string;
  };
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// Findings, simulation, and reports
// ---------------------------------------------------------------------------

export type CardinalityFindingType =
  | 'relationship_flatten'
  | 'collection_to_scalar'
  | 'target_collision'
  | 'key_collision'
  | 'resolution_incomplete'
  | 'runtime_capability_missing'
  | 'relationship_evidence_unavailable';

export type CardinalityFindingSeverity = 'blocking' | 'warning';

/** A single deterministic cardinality finding. Its `key` is stable within a report. */
export interface CardinalityFinding {
  key: string;
  type: CardinalityFindingType;
  severity: CardinalityFindingSeverity;
  overrideable: boolean;
  direction: MappingDirection;
  mappingIndexes: number[];
  relationshipPath?: string[];
  message: string;
  resolutionOptions: CardinalityResolutionKind[];
}

/**
 * Advisory, sample-observed simulation. Every count is limited to provided
 * samples; it never exposes raw key values or record bodies. Collision groups
 * are referenced only by row index.
 */
export interface CardinalitySimulation {
  direction: MappingDirection;
  inputRowCount: number;
  distinctParentCount: number;
  childrenPerParent: { min: number; median: number; p95: number; max: number };
  expectedTargetRecordCount: number;
  collisionCount: number;
  collisionRowIndexes: number[];
  rejectedRecordCount: number;
  droppedChildCount: number;
  compressedChildCount: number;
  assumptions: string[];
  unavailableChecks: string[];
}

/**
 * The deterministic output of a single directional analysis. Time is never part
 * of analysis or its fingerprint; `analyzedAt` belongs to the persisted snapshot.
 */
export interface CardinalityReport {
  analyzerVersion: string;
  direction: MappingDirection;
  findings: CardinalityFinding[];
  simulation?: CardinalitySimulation;
  fingerprint: string;
  unavailableChecks: string[];
}

// ---------------------------------------------------------------------------
// Analyzer input (pinned)
// ---------------------------------------------------------------------------

/**
 * Normalized per-field grain metadata the analyzer uses to detect
 * collection-to-scalar flattening. `entity`/`field` are matched
 * case-insensitively after the same `trim().toLocaleLowerCase('en-US')`
 * segment normalization applied to mapping paths.
 */
export interface CardinalityFieldMetadata {
  entity: string;
  field: string;
  isCollection: boolean;
}

/**
 * The fully normalized, single-direction input to the pure analyzer. The
 * coordinator assembles it from server-trusted evidence, orienting the source
 * and target sides for `direction`; bidirectional configurations are analyzed
 * as two independent inputs. `samples` are pre-validated by
 * `validateSampleSafety` — the analyzer assumes safe (plain-JSON) input but
 * must not choke on an empty array.
 */
export interface CardinalityAnalysisInput {
  analyzerVersion: string;
  direction: MappingDirection;
  sourceSystem: string;
  targetSystem: string;
  sourceEntity: string;
  targetEntity: string;
  fieldMetadata: CardinalityFieldMetadata[];
  sourceEvidence: RelationshipEvidence;
  targetEvidence: RelationshipEvidence;
  fieldMappings: FieldMapping[];
  strategies: CardinalityStrategy[];
  keyDeclarations: CardinalityKeyDeclarations;
  samples?: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Coordinator inputs and results (pinned signatures)
// ---------------------------------------------------------------------------

export interface PreflightRunResult {
  reports: CardinalityReport[];
  blocking: boolean;
  combinedFingerprint: string;
}

/** A safe, server-assembled mapping-plan projection for one preflight run. */
export interface CardinalityPlanInput {
  sourceSystem: string;
  targetSystem: string;
  sourceEntity: string;
  targetEntity: string;
  syncDirection: IntegrationConfig['syncDirection'];
  fieldMappings: FieldMapping[];
  strategies: CardinalityStrategy[];
  keyDeclarations: CardinalityKeyDeclarations;
}

/** The coordinator boundary shared by activation and the preflight route. */
export interface CardinalityPreflight {
  runForConfig(
    config: IntegrationConfig,
    samples?: Record<string, unknown>[],
  ): Promise<PreflightRunResult>;

  runForPlan(
    plan: CardinalityPlanInput,
    tenantId: string,
    samples?: Record<string, unknown>[],
  ): Promise<PreflightRunResult>;
}

/**
 * The ADVISORY-ONLY evidence boundary used at suggestion time. It is separate
 * from `CardinalityPreflight` on purpose: nothing reached through this method
 * authorizes an activation, and no caller of it may persist a configuration.
 *
 * Unlike the activation path, it NEVER throws — a discovery transport failure
 * is translated into `status: 'unavailable'` evidence so a suggestion request
 * degrades to "we could not check" instead of failing. That translation is
 * legitimate ONLY because the result is advisory; the activation path must keep
 * distinguishing an inability to decide (503) from a trustworthy unavailable
 * result, and therefore uses `runForConfig`/`runForPlan`, never this method.
 */
export interface CardinalityAdvisoryEvidence {
  getAdvisoryEvidence(system: string, entity: string): Promise<RelationshipEvidence>;
}

// ---------------------------------------------------------------------------
// Override request and server-authored persisted metadata
// ---------------------------------------------------------------------------

/**
 * Transport metadata: the client's request to override overrideable blocking
 * findings. It is never part of the canonical `IntegrationConfig`.
 */
export interface CardinalityOverrideRequest {
  reason: string;
  findingKeys: string[];
  reportFingerprint: string;
}

/**
 * The server-authored override record persisted atomically with configuration.
 * Actor and tenant come only from trusted command context, never request JSON.
 */
export interface PersistedCardinalityOverride {
  reason: string;
  findingKeys: string[];
  reportFingerprint: string;
  actorUserId: string;
  actorTenantId: string;
  approvedAt: string;
  analyzerVersion: string;
}

/** Sanitized validation snapshot persisted on active configurations. */
export interface CardinalityValidationSnapshot {
  analyzerVersion: string;
  reportFingerprint: string;
  checkedAt: string;
  directions: MappingDirection[];
  blockingFindingKeys: string[];
  overriddenFindingKeys: string[];
  unavailableChecks: string[];
}

// ---------------------------------------------------------------------------
// Command context, authorization input, and the write boundary (pinned)
// ---------------------------------------------------------------------------

/** Every active-write path that crosses the authorization method. */
export type ConfigurationOperationKind =
  | 'create'
  | 'update'
  | 'import'
  | 'secure_save'
  | 'bulk_restore'
  | 'admin_activation'
  | 'startup_migration';

/**
 * Trusted command context constructed by authenticated route or administrative-job
 * code from verified identity. It is never accepted from request JSON.
 */
export interface ConfigurationCommandContext {
  tenantId: string;
  actorUserId: string;
  correlationId: string;
  operation: ConfigurationOperationKind;
}

/**
 * The server-side authorization input carried alongside an active save: the
 * override request and the bounded samples needed to enforce or override a
 * sample-derived finding. Mirrors the stripped `_cardinality` transport envelope.
 */
export interface CardinalityAuthorizationInput {
  override?: CardinalityOverrideRequest;
  samples?: Record<string, unknown>[];
}

/** The persistence boundary crossed by every active configuration write. */
export interface ConfigurationWriteBoundary {
  /** Resolves with a defensive copy of the persisted record (server-generated id included). */
  saveConfiguration(
    config: IntegrationConfig,
    context?: ConfigurationCommandContext,
    authorization?: CardinalityAuthorizationInput,
  ): Promise<IntegrationConfig>;

  importAll(
    data: unknown,
    context?: ConfigurationCommandContext,
  ): Promise<void>;
}
