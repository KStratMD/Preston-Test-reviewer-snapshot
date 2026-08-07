import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { ServiceUnavailableAppError } from '../../errors/AppError';
import { logger } from '../../utils/Logger';
import type { FieldMapping, IntegrationConfig, SystemConfig } from '../../types';
import {
  type CardinalityAdvisoryEvidence,
  type CardinalityAnalysisInput,
  type CardinalityPlanInput,
  type CardinalityPreflight,
  type CardinalityReport,
  type MappingDirection,
  type PreflightRunResult,
  type RelationshipEvidence,
} from '../../types/cardinality';
import { analyze } from './CardinalityAnalysisService';
import { computeCombinedFingerprint } from './fingerprint';
import { RelationshipEvidenceProvider } from './RelationshipEvidenceProvider';

/**
 * Trusted preflight coordinator for the cardinality preflight and activation
 * gate. See docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * ("CardinalityPreflightService", "Analysis inputs and fingerprint",
 * "Activation semantics", "Error contract").
 *
 * The coordinator owns ONLY I/O-shaped orchestration:
 *   - direction expansion (a bidirectional config → two independent plans);
 *   - evidence acquisition and reversal (source↔target swap in reverse);
 *   - combined-fingerprint composition;
 *   - translating a discovery TRANSPORT failure into a 503-class inability to
 *     decide.
 *
 * It re-implements NONE of the rules, math, sample profiling, or evidence
 * normalization — those live in `CardinalityAnalysisService`,
 * `sampleProfiling`, and `RelationshipEvidenceProvider` respectively. Both
 * public entry points (`runForConfig`, `runForPlan`) funnel through one private
 * runner and one evidence provider so the activation and preflight paths can
 * never drift.
 */

/**
 * The analyzer version this coordinator runs. Folded into every report
 * fingerprint (via the analysis input), so bumping it deliberately invalidates
 * stored overrides — an override authored against an older analyzer is no
 * longer trustworthy once the rules change.
 */
export const CARDINALITY_ANALYZER_VERSION = '1.0.0';

/**
 * Raised when a transient coordinator/connector/discovery failure prevents the
 * server from determining whether relationship evidence is available. This is
 * the design's 503 class — an INABILITY TO DECIDE — and is deliberately
 * distinct from a trustworthy `status: unavailable` evidence result, which is a
 * blocking `422` finding inside a completed report.
 *
 * It extends `ServiceUnavailableAppError` so the existing global error-boundary
 * branch (`instanceof ServiceUnavailableAppError → 503`) maps it correctly with
 * no boundary change, while the distinct class name keeps it separately
 * catchable by callers and tests. Task 6 wires the boundary for the SEPARATE
 * 422 `CardinalityViolationError`; this 503 needs no new branch.
 */
export class CardinalityPreflightUnavailableError extends ServiceUnavailableAppError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
  }
}

/** One directional plan's source/target orientation after direction expansion. */
interface OrientedPlan {
  sourceSystem: string;
  targetSystem: string;
  sourceEntity: string;
  targetEntity: string;
  fieldMappings: FieldMapping[];
}

@injectable()
export class CardinalityPreflightService implements CardinalityPreflight, CardinalityAdvisoryEvidence {
  private readonly evidenceProvider: RelationshipEvidenceProvider;

  constructor(
    @inject(TYPES.RelationshipEvidenceProvider) evidenceProvider: RelationshipEvidenceProvider,
  ) {
    this.evidenceProvider = evidenceProvider;
  }

  /**
   * Suggestion-time evidence lookup (design doc, "Suggestion-time
   * integration"). Callers get the SAME normalization and provenance rules the
   * activation path uses — the route never re-implements system normalization,
   * so an unsupported system cannot be advisory-"available" here while being
   * unavailable at activation.
   *
   * It never throws and never authorizes: a discovery transport failure is
   * logged and translated into unavailable evidence, which downstream produces
   * a warning without a confidence penalty. The activation path deliberately
   * does NOT share this behavior — there, the same failure must surface as a
   * 503 inability to decide.
   */
  async getAdvisoryEvidence(system: string, entity: string): Promise<RelationshipEvidence> {
    try {
      return await this.evidenceProvider.getEvidence(system, entity);
    } catch (error) {
      logger.warn('Advisory cardinality evidence could not be discovered', {
        system,
        entity,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        system,
        entity,
        status: 'unavailable',
        edges: [],
        provenance: { source: 'manual_server' },
        unavailableReason: 'Relationship discovery failed while assembling advisory evidence',
      };
    }
  }

  async runForConfig(
    config: IntegrationConfig,
    samples?: Record<string, unknown>[],
  ): Promise<PreflightRunResult> {
    return this.run(planFromConfig(config), samples);
  }

  async runForPlan(
    plan: CardinalityPlanInput,
    // `tenantId` is verified by the caller and reserved for tenant-scoped
    // connector/schema resolution. The Task-4 evidence provider resolves by
    // system/entity only (static NetSuite catalog + config-gated Salesforce
    // discovery), so it is intentionally not yet threaded into acquisition.
    _tenantId: string,
    samples?: Record<string, unknown>[],
  ): Promise<PreflightRunResult> {
    return this.run(plan, samples);
  }

  /**
   * The single direction runner both entry points delegate to. Expands the
   * plan into one or two directional analyses, runs each through the shared
   * evidence acquisition + pure analyzer, and composes the combined result.
   */
  private async run(
    plan: CardinalityPlanInput,
    samples?: Record<string, unknown>[],
  ): Promise<PreflightRunResult> {
    const reports: CardinalityReport[] = [];
    for (const direction of expandDirections(plan.syncDirection)) {
      reports.push(await this.runDirection(plan, direction, samples));
    }

    const blocking = reports.some((report) =>
      report.findings.some((finding) => finding.severity === 'blocking'),
    );
    const combinedFingerprint = computeCombinedFingerprint(
      reports.map((report) => ({ direction: report.direction, fingerprint: report.fingerprint })),
    );

    return { reports, blocking, combinedFingerprint };
  }

  private async runDirection(
    plan: CardinalityPlanInput,
    direction: MappingDirection,
    samples?: Record<string, unknown>[],
  ): Promise<CardinalityReport> {
    const oriented = orientPlan(plan, direction);
    const [sourceEvidence, targetEvidence] = await this.acquireEvidence(oriented);

    const input: CardinalityAnalysisInput = {
      analyzerVersion: CARDINALITY_ANALYZER_VERSION,
      direction,
      sourceSystem: oriented.sourceSystem,
      targetSystem: oriented.targetSystem,
      sourceEntity: oriented.sourceEntity,
      targetEntity: oriented.targetEntity,
      // Server field-grain metadata has no trusted source in this task; an
      // empty set means the metadata-driven collection-to-scalar check simply
      // does not fire (the flatten and sample checks still do).
      fieldMetadata: [],
      sourceEvidence,
      targetEvidence,
      fieldMappings: oriented.fieldMappings,
      strategies: plan.strategies,
      keyDeclarations: plan.keyDeclarations,
      ...(samples !== undefined ? { samples } : {}),
    };

    return analyze(input);
  }

  /**
   * Acquires source- and target-side evidence for one oriented direction. A
   * provider THROW is a discovery transport failure — the coordinator cannot
   * decide, so it surfaces the 503 class. A provider that RESOLVES with
   * `status: unavailable` (an unsupported system/entity) is a trustworthy
   * result and flows into the report as a blocking finding, never a 503.
   */
  private async acquireEvidence(
    oriented: OrientedPlan,
  ): Promise<[RelationshipEvidence, RelationshipEvidence]> {
    try {
      const sourceEvidence = await this.evidenceProvider.getEvidence(
        oriented.sourceSystem,
        oriented.sourceEntity,
      );
      const targetEvidence = await this.evidenceProvider.getEvidence(
        oriented.targetSystem,
        oriented.targetEntity,
      );
      return [sourceEvidence, targetEvidence];
    } catch (error) {
      throw new CardinalityPreflightUnavailableError(
        'Cardinality relationship evidence could not be determined',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

/**
 * Which directional plans a sync direction expands to. Bidirectional yields
 * two INDEPENDENT plans; every unidirectional form yields exactly one.
 */
function expandDirections(
  syncDirection: IntegrationConfig['syncDirection'],
): MappingDirection[] {
  switch (syncDirection) {
    case 'bidirectional':
      return ['source_to_target', 'target_to_source'];
    case 'target_to_source':
      return ['target_to_source'];
    case 'source_to_target':
    case 'unidirectional':
    default:
      return ['source_to_target'];
  }
}

/**
 * Orients a plan for one direction. `source_to_target` uses the plan as-is. For
 * `target_to_source`, the sides genuinely swap: the config target becomes the
 * source side (system, entity, AND evidence, resolved in `acquireEvidence`),
 * and each field mapping's `sourceField`/`targetField` are reversed so the
 * analyzer traverses the now-source (config target) grain honestly. Relabeling
 * without this swap would analyze the wrong grain.
 */
function orientPlan(plan: CardinalityPlanInput, direction: MappingDirection): OrientedPlan {
  if (direction === 'source_to_target') {
    return {
      sourceSystem: plan.sourceSystem,
      targetSystem: plan.targetSystem,
      sourceEntity: plan.sourceEntity,
      targetEntity: plan.targetEntity,
      fieldMappings: plan.fieldMappings,
    };
  }
  return {
    sourceSystem: plan.targetSystem,
    targetSystem: plan.sourceSystem,
    sourceEntity: plan.targetEntity,
    targetEntity: plan.sourceEntity,
    fieldMappings: plan.fieldMappings.map(reverseMapping),
  };
}

function reverseMapping(mapping: FieldMapping): FieldMapping {
  return { ...mapping, sourceField: mapping.targetField, targetField: mapping.sourceField };
}

/**
 * Projects an `IntegrationConfig` into the coordinator's safe plan shape. Key
 * declarations have no config-level source yet, so they default empty (sample
 * profiling then simply reports its key checks unavailable); config-level
 * cardinality strategies flow through unchanged.
 */
function planFromConfig(config: IntegrationConfig): CardinalityPlanInput {
  return {
    sourceSystem: systemName(config.sourceSystem),
    targetSystem: systemName(config.targetSystem),
    sourceEntity: config.sourceEntity,
    targetEntity: config.targetEntity,
    syncDirection: config.syncDirection,
    fieldMappings: config.fieldMappings ?? [],
    strategies: config.cardinalityStrategies ?? [],
    keyDeclarations: { sourceRecordKeys: [], parentKeys: [], targetKeys: [] },
  };
}

function systemName(system: string | SystemConfig): string {
  return typeof system === 'string' ? system : system.type;
}
