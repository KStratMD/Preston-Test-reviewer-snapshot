import type { FieldMapping } from '../../types';
import {
  CARDINALITY_RUNTIME_CAPABILITIES,
  type CardinalityAnalysisInput,
  type CardinalityFinding,
  type CardinalityFindingType,
  type CardinalityResolutionKind,
  type CardinalityStrategy,
  type CardinalitySimulation,
  type CardinalityReport,
  type FieldCardinalityResolution,
  type RelationshipEvidence,
} from '../../types/cardinality';
import { canonicalJson, computeReportFingerprint, computeSampleDigest } from './fingerprint';
import { profileSamples, type SampleResolutionMode } from './sampleProfiling';

/**
 * Pure structural cardinality analyzer for the preflight and activation gate.
 *
 * See docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Findings" and "Sample profiling". `analyze` is deterministic and has no I/O,
 * clock reads, randomness, or environment access, so its report — including the
 * fingerprint — is reproducible for identical input. Structural checks run
 * without samples; sample profiling runs only when bounded samples are present.
 *
 * PRIVACY (non-negotiable): a serialized report carries row indexes and
 * report-local collision-group identifiers only. Raw parent/key values, record
 * bodies, and reusable per-key hashes never leave the analyzer.
 */

/** Per-segment path normalization pinned by the design: trim + locale-lower. */
function normalizeSegment(segment: string): string {
  return segment.trim().toLocaleLowerCase('en-US');
}

function normalizePath(path: string): string[] {
  return path.split('.').map(normalizeSegment);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Draft of a finding before its deterministic key is stamped on. */
interface FindingDraft {
  type: CardinalityFindingType;
  severity: CardinalityFinding['severity'];
  overrideable: boolean;
  mappingIndexes: number[];
  /** Slot that disambiguates findings of the same type (path, target, or group). */
  discriminator: string;
  relationshipPath?: string[];
  message: string;
  resolutionOptions: CardinalityResolutionKind[];
}

function finalizeFinding(draft: FindingDraft, direction: CardinalityReport['direction']): CardinalityFinding {
  const mappingIndexes = [...draft.mappingIndexes].sort((a, b) => a - b);
  const key = `${draft.type}|${direction}|${draft.discriminator}|${mappingIndexes.join(',')}`;
  return {
    key,
    type: draft.type,
    severity: draft.severity,
    overrideable: draft.overrideable,
    direction,
    mappingIndexes,
    ...(draft.relationshipPath ? { relationshipPath: draft.relationshipPath } : {}),
    message: draft.message,
    resolutionOptions: draft.resolutionOptions,
  };
}

function isStrategyComplete(strategy: CardinalityStrategy): boolean {
  if (strategy.resolution === 'separate_records') {
    return (
      strategy.relationshipPath.length > 0 &&
      strategy.childConfigurationId.trim().length > 0 &&
      strategy.parentKeyMapping.sourceField.trim().length > 0 &&
      strategy.parentKeyMapping.targetField.trim().length > 0
    );
  }
  return (
    strategy.relationshipPath.length > 0 &&
    strategy.targetEntity.trim().length > 0 &&
    strategy.targetKeyFields.length > 0
  );
}

function isStrategyExecutable(strategy: CardinalityStrategy): boolean {
  return strategy.resolution === 'separate_records'
    ? CARDINALITY_RUNTIME_CAPABILITIES.separateRecords
    : CARDINALITY_RUNTIME_CAPABILITIES.fanOut;
}

function isFieldResolutionComplete(resolution: FieldCardinalityResolution): boolean {
  if (resolution.resolution === 'aggregate') {
    // `join` requires a separator; every other operator rejects an irrelevant one.
    return resolution.operator === 'join'
      ? typeof resolution.separator === 'string' && resolution.separator.length > 0
      : resolution.separator === undefined;
  }
  return resolution.orderBy.length > 0 && resolution.tieBreak.field.trim().length > 0;
}

function isFieldResolutionExecutable(resolution: FieldCardinalityResolution): boolean {
  return resolution.resolution === 'aggregate'
    ? CARDINALITY_RUNTIME_CAPABILITIES.aggregateOperators.includes(resolution.operator)
    : CARDINALITY_RUNTIME_CAPABILITIES.selectOne;
}

/** Traversal outcome for one mapping's relationship path against evidence. */
interface TraversalResult {
  crossesToMany: boolean;
  /** Partial evidence could not resolve a segment, so the path is unevaluable. */
  unevaluable: boolean;
}

function traverseRelationship(
  relSteps: string[],
  sourceEntity: string,
  evidence: RelationshipEvidence,
): TraversalResult {
  let currentEntity = normalizeSegment(sourceEntity);
  let crossesToMany = false;
  for (const step of relSteps) {
    const edge = evidence.edges.find(
      (candidate) =>
        normalizeSegment(candidate.fromEntity) === currentEntity &&
        normalizeSegment(candidate.fromField) === step,
    );
    if (!edge) {
      // Available evidence is authoritative: an unknown segment is not a
      // relationship. Partial evidence cannot rule the path safe.
      if (evidence.status === 'partial') return { crossesToMany, unevaluable: true };
      return { crossesToMany, unevaluable: false };
    }
    if (edge.cardinality === 'one_to_many' || edge.cardinality === 'many_to_many') {
      crossesToMany = true;
    }
    currentEntity = normalizeSegment(edge.toEntity);
  }
  return { crossesToMany, unevaluable: false };
}

export function analyze(input: CardinalityAnalysisInput): CardinalityReport {
  const { direction, sourceEntity, targetEntity, fieldMappings, strategies } = input;
  const drafts: FindingDraft[] = [];

  // --- Unavailable relationship evidence (whole-plan, per side) ------------
  const sourceUsable = input.sourceEvidence.status !== 'unavailable';
  const targetUsable = input.targetEvidence.status !== 'unavailable';
  for (const [side, usable] of [
    ['source', sourceUsable],
    ['target', targetUsable],
  ] as const) {
    if (!usable) {
      drafts.push({
        type: 'relationship_evidence_unavailable',
        severity: 'blocking',
        overrideable: true,
        mappingIndexes: [],
        discriminator: side,
        message: `Required ${side} relationship evidence is unavailable`,
        resolutionOptions: [],
      });
    }
  }

  // --- Collection-valued field grain metadata ------------------------------
  const collectionFields = new Set<string>();
  for (const meta of input.fieldMetadata) {
    if (meta.isCollection) {
      collectionFields.add(`${normalizeSegment(meta.entity)}::${normalizeSegment(meta.field)}`);
    }
  }
  const isCollectionField = (entity: string, field: string): boolean =>
    collectionFields.has(`${normalizeSegment(entity)}::${normalizeSegment(field)}`);

  // --- Per-mapping structural checks ---------------------------------------
  fieldMappings.forEach((mapping, index) => {
    const segments = normalizePath(mapping.sourceField);
    const relSteps = segments.slice(0, -1);
    const leaf = segments[segments.length - 1];

    if (relSteps.length > 0) {
      // Relationship-path (flatten) axis; only evaluable with usable evidence.
      if (!sourceUsable) return;
      const traversal = traverseRelationship(relSteps, sourceEntity, input.sourceEvidence);
      if (traversal.unevaluable) {
        drafts.push({
          type: 'relationship_evidence_unavailable',
          severity: 'blocking',
          overrideable: true,
          mappingIndexes: [index],
          discriminator: relSteps.join('.'),
          relationshipPath: relSteps,
          message: `Partial evidence cannot evaluate relationship path ${relSteps.join('.')}`,
          resolutionOptions: [],
        });
        return;
      }
      if (!traversal.crossesToMany) return;

      const matching = strategies.find(
        (strategy) =>
          strategy.direction === direction &&
          arraysEqual(strategy.relationshipPath.map(normalizeSegment), relSteps),
      );
      if (!matching) {
        drafts.push({
          type: 'relationship_flatten',
          severity: 'blocking',
          overrideable: true,
          mappingIndexes: [index],
          discriminator: relSteps.join('.'),
          relationshipPath: relSteps,
          message: `Mapping crosses a to-many relationship ${relSteps.join('.')} without a resolution`,
          resolutionOptions: ['separate_records', 'fan_out'],
        });
      } else if (!isStrategyComplete(matching)) {
        drafts.push({
          type: 'resolution_incomplete',
          severity: 'blocking',
          overrideable: false,
          mappingIndexes: [index],
          discriminator: relSteps.join('.'),
          relationshipPath: relSteps,
          message: `Strategy ${matching.resolution} for ${relSteps.join('.')} is missing required parameters`,
          resolutionOptions: [matching.resolution],
        });
      } else if (!isStrategyExecutable(matching)) {
        drafts.push({
          type: 'runtime_capability_missing',
          severity: 'blocking',
          overrideable: false,
          mappingIndexes: [index],
          discriminator: relSteps.join('.'),
          relationshipPath: relSteps,
          message: `The runtime cannot execute strategy ${matching.resolution}`,
          resolutionOptions: [matching.resolution],
        });
      }
      return;
    }

    // Collection-to-scalar axis (direct array field mapped to a scalar target).
    if (isCollectionField(sourceEntity, leaf) && !isCollectionField(targetEntity, mapping.targetField)) {
      const resolution = mapping.cardinality;
      const targetSlot = normalizeSegment(mapping.targetField);
      if (!resolution) {
        drafts.push({
          type: 'collection_to_scalar',
          severity: 'blocking',
          overrideable: true,
          mappingIndexes: [index],
          discriminator: targetSlot,
          message: `Collection field ${leaf} maps to scalar ${targetSlot} without an aggregate or select-one rule`,
          resolutionOptions: ['aggregate', 'select_one'],
        });
      } else if (!isFieldResolutionComplete(resolution)) {
        drafts.push({
          type: 'resolution_incomplete',
          severity: 'blocking',
          overrideable: false,
          mappingIndexes: [index],
          discriminator: targetSlot,
          message: `Field resolution ${resolution.resolution} for ${targetSlot} is missing required parameters`,
          resolutionOptions: [resolution.resolution],
        });
      } else if (!isFieldResolutionExecutable(resolution)) {
        drafts.push({
          type: 'runtime_capability_missing',
          severity: 'blocking',
          overrideable: false,
          mappingIndexes: [index],
          discriminator: targetSlot,
          message: `The runtime cannot execute field resolution ${resolution.resolution}`,
          resolutionOptions: [resolution.resolution],
        });
      }
    }
  });

  // --- Target collision (more than one mapping writes one target field) ----
  const mappingsByTarget = new Map<string, number[]>();
  fieldMappings.forEach((mapping, index) => {
    const target = normalizeSegment(mapping.targetField);
    const bucket = mappingsByTarget.get(target);
    if (bucket) bucket.push(index);
    else mappingsByTarget.set(target, [index]);
  });
  for (const [target, indexes] of mappingsByTarget) {
    if (indexes.length <= 1) continue;
    const canonicalForms = indexes.map((index) => canonicalJson(fieldMappings[index]));
    const exactDuplicate = canonicalForms.every((form) => form === canonicalForms[0]);
    drafts.push({
      type: 'target_collision',
      severity: 'blocking',
      overrideable: false,
      mappingIndexes: indexes,
      discriminator: target,
      message: exactDuplicate
        ? `Exact duplicate mapping records write target field ${target}`
        : `Multiple distinct mappings write target field ${target}`,
      resolutionOptions: [],
    });
  }

  // --- Sample profiling (advisory simulation + observed key collisions) -----
  let simulation: CardinalitySimulation | undefined;
  const unavailableChecks = new Set<string>();
  if (input.sourceEvidence.status !== 'available') unavailableChecks.add('relationship_evidence:source');
  if (input.targetEvidence.status !== 'available') unavailableChecks.add('relationship_evidence:target');

  if (input.samples === undefined) {
    unavailableChecks.add('sample_profiling');
  } else {
    const profile = profileSamples({
      samples: input.samples,
      parentKeys: input.keyDeclarations.parentKeys,
      targetKeys: input.keyDeclarations.targetKeys,
      resolution: deriveSampleResolutionMode(strategies, fieldMappings, direction),
    });
    profile.unavailableChecks.forEach((check) => unavailableChecks.add(check));

    simulation = {
      direction,
      inputRowCount: profile.inputRowCount,
      distinctParentCount: profile.distinctParentCount,
      childrenPerParent: profile.childrenPerParent,
      expectedTargetRecordCount: profile.expectedTargetRecordCount,
      collisionCount: profile.collisionCount,
      collisionRowIndexes: profile.collisionRowIndexes,
      rejectedRecordCount: profile.rejectedRecordCount,
      droppedChildCount: profile.droppedChildCount,
      compressedChildCount: profile.compressedChildCount,
      assumptions: profile.assumptions,
      unavailableChecks: profile.unavailableChecks,
    };

    const targetKeySet = new Set(input.keyDeclarations.targetKeys.map(normalizeSegment));
    const keyWriterIndexes = fieldMappings
      .map((mapping, index) => ({ index, target: normalizeSegment(mapping.targetField) }))
      .filter(({ target }) => targetKeySet.has(target))
      .map(({ index }) => index);
    for (const group of profile.collisionGroups) {
      drafts.push({
        type: 'key_collision',
        severity: 'blocking',
        overrideable: true,
        mappingIndexes: keyWriterIndexes,
        discriminator: group.groupId,
        message: `Sample-observed target key collision (${group.groupId}) on rows [${group.rowIndexes.join(', ')}]`,
        resolutionOptions: [],
      });
    }
  }

  const findings = drafts
    .map((draft) => finalizeFinding(draft, direction))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const fingerprint = computeReportFingerprint({
    analyzerVersion: input.analyzerVersion,
    direction,
    plan: {
      sourceSystem: input.sourceSystem,
      targetSystem: input.targetSystem,
      sourceEntity,
      targetEntity,
      fieldMappings,
      strategies,
      keyDeclarations: input.keyDeclarations,
      fieldMetadata: input.fieldMetadata,
    },
    evidence: {
      source: fingerprintEvidence(input.sourceEvidence),
      target: fingerprintEvidence(input.targetEvidence),
    },
    sampleDigest: computeSampleDigest(input.samples),
  });

  return {
    analyzerVersion: input.analyzerVersion,
    direction,
    findings,
    ...(simulation ? { simulation } : {}),
    fingerprint,
    unavailableChecks: [...unavailableChecks].sort(),
  };
}

/**
 * The evidence projection folded into the report fingerprint. It explicitly
 * carries the edges and the schema version (when present) so that a schema
 * change invalidates a stored override — the Task-2 carry-forward.
 */
function fingerprintEvidence(evidence: RelationshipEvidence): Record<string, unknown> {
  return {
    system: evidence.system,
    entity: evidence.entity,
    status: evidence.status,
    edges: evidence.edges,
    schemaVersion: evidence.provenance.schemaVersion ?? null,
  };
}

/**
 * The advisory profiling mode: prefer an executable per-child strategy, then a
 * declared field resolution, otherwise a naive flatten. Only affects the
 * advisory expected/dropped/compressed counts, never a blocking decision.
 */
function deriveSampleResolutionMode(
  strategies: CardinalityStrategy[],
  fieldMappings: FieldMapping[],
  direction: CardinalityReport['direction'],
): SampleResolutionMode {
  const directional = strategies.filter((strategy) => strategy.direction === direction);
  if (directional.some((strategy) => strategy.resolution === 'fan_out' && isStrategyComplete(strategy))) {
    return 'fan_out';
  }
  if (
    directional.some((strategy) => strategy.resolution === 'separate_records' && isStrategyComplete(strategy))
  ) {
    return 'separate_records';
  }
  const resolutions = fieldMappings
    .map((mapping) => mapping.cardinality)
    .filter((resolution): resolution is FieldCardinalityResolution => resolution !== undefined);
  if (resolutions.some((resolution) => resolution.resolution === 'select_one')) return 'select_one';
  if (resolutions.some((resolution) => resolution.resolution === 'aggregate')) return 'aggregate';
  return 'flatten';
}
