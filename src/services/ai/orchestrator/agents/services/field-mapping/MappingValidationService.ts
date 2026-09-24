import type { FieldMapping } from '../../../../../../types';
import type {
  CardinalityAnalysisInput,
  CardinalityFieldMetadata,
} from '../../../../../../types/cardinality';
import { analyze } from '../../../../../cardinality/CardinalityAnalysisService';
import type { DataSample, MappingSuggestion, TransformationRule } from '../../fieldMappingTypes';
import type { CardinalityAdvisoryContext, EnhancedFieldMapping, FieldMappingInput } from '../../../interfaces';

/** Transformation kinds the canonical `FieldMapping` shape can express. */
const ANALYZER_TRANSFORMATION_TYPES: ReadonlySet<FieldMapping['transformationType']> = new Set([
  'direct',
  'concatenate',
  'concatenation',
  'split',
  'lookup',
  'expression',
  'conditional',
  'calculation',
]);

/**
 * Handles post-suggestion validation, alternative generation, and data-quality scoring.
 */
export class MappingValidationService {
  /**
   * One bounded penalty per affected suggestion (design doc, "Suggestion-time
   * integration"). Multiplicative rather than subtractive so a low-confidence
   * suggestion is not driven to zero, and applied AT MOST ONCE regardless of
   * how many findings reference the mapping — stacking would let finding count,
   * not risk, dominate the score.
   */
  private static readonly ADVISORY_PENALTY_FACTOR = 0.7;

  /** Floor so a penalized suggestion stays visible and rankable, never 0. */
  private static readonly ADVISORY_CONFIDENCE_FLOOR = 0.05;

  validateMappings(
    suggestions: MappingSuggestion[],
    input: FieldMappingInput,
    confidenceThreshold: number
  ): EnhancedFieldMapping[] {
    const validated: EnhancedFieldMapping[] = [];

    for (const suggestion of suggestions) {
      let isValid = true;
      let validationScore = 1.0;

      if (input.sampleData && input.sampleData.length > 0) {
        const sampleValidation = this.validateWithSampleData(suggestion, input.sampleData as DataSample[]);
        isValid = sampleValidation.isValid;
        validationScore = sampleValidation.score;
      }

      if (isValid && suggestion.confidence > confidenceThreshold) {
        validated.push({
          sourceField: suggestion.sourceField,
          targetField: suggestion.targetField,
          confidence: suggestion.confidence * validationScore,
          transformationType: suggestion.transformation.type,
          transformationLogic: suggestion.transformation.expression,
          validationRules: this.generateValidationRules(suggestion),
          businessRule: suggestion.reasoning.join('; '),
          dataQualityImpact: this.assessDataQualityImpact(suggestion),
          alternatives: suggestion.alternatives,
          origin: suggestion.origin,
          providerId: suggestion.providerId
        });
      }
    }

    return this.applyCardinalityAdvisories(validated, input);
  }

  /**
   * Annotates already-validated mappings with advisory cardinality findings.
   *
   * Runs the SAME pure analyzer the activation gate runs, so a suggestion-time
   * warning and an activation-time blocking finding can never disagree about
   * the rules. It is nonetheless advisory only: it never drops a suggestion,
   * never rewrites a mapping into a "safe" one, and never authorizes
   * activation.
   *
   * Unavailable evidence warns WITHOUT a penalty — "we could not check" is not
   * evidence of risk, and penalizing it would train operators to ignore the
   * warning that matters. Any analyzer failure leaves the mappings untouched;
   * an advisory annotation must never fail a suggestion request.
   */
  private applyCardinalityAdvisories(
    mappings: EnhancedFieldMapping[],
    input: FieldMappingInput
  ): EnhancedFieldMapping[] {
    const advisory = input.cardinalityAdvisory;
    if (!advisory || mappings.length === 0) {
      return mappings;
    }

    let report;
    try {
      report = analyze(this.buildAdvisoryAnalysisInput(advisory, input, mappings));
    } catch {
      return mappings;
    }

    // Plan-level findings (no mapping indexes) describe the whole run —
    // unavailable evidence being the canonical case — so they surface on every
    // suggestion, while only mapping-scoped findings can penalize.
    const planWarnings: string[] = [];
    const warningsByIndex = new Map<number, string[]>();
    const penalized = new Set<number>();

    for (const finding of report.findings) {
      if (finding.mappingIndexes.length === 0) {
        planWarnings.push(finding.message);
        continue;
      }
      for (const index of finding.mappingIndexes) {
        const bucket = warningsByIndex.get(index);
        if (bucket) bucket.push(finding.message);
        else warningsByIndex.set(index, [finding.message]);
        if (finding.type !== 'relationship_evidence_unavailable') {
          penalized.add(index);
        }
      }
    }

    return mappings.map((mapping, index) => {
      const warnings = [...new Set([...planWarnings, ...(warningsByIndex.get(index) ?? [])])];
      if (warnings.length === 0) {
        return mapping;
      }
      return {
        ...mapping,
        confidence: penalized.has(index)
          ? this.penalizeConfidence(mapping.confidence)
          : mapping.confidence,
        cardinalityWarnings: warnings,
      };
    });
  }

  /** Bounded penalty; `Math.min` guarantees the floor can never RAISE a score. */
  private penalizeConfidence(confidence: number): number {
    return Math.min(
      confidence,
      Math.max(
        confidence * MappingValidationService.ADVISORY_PENALTY_FACTOR,
        MappingValidationService.ADVISORY_CONFIDENCE_FLOOR
      )
    );
  }

  /**
   * Projects the validated suggestions and the declared field grain into the
   * analyzer's normalized input. Indexes line up 1:1 with `mappings` so a
   * finding's `mappingIndexes` address the suggestion it describes. No
   * strategies or key declarations exist at suggestion time, so the
   * strategy/sample axes simply report themselves unavailable.
   */
  private buildAdvisoryAnalysisInput(
    advisory: CardinalityAdvisoryContext,
    input: FieldMappingInput,
    mappings: EnhancedFieldMapping[]
  ): CardinalityAnalysisInput {
    return {
      analyzerVersion: advisory.analyzerVersion,
      direction: 'source_to_target',
      sourceSystem: advisory.sourceSystem,
      targetSystem: advisory.targetSystem,
      sourceEntity: advisory.sourceEntity,
      targetEntity: advisory.targetEntity,
      fieldMetadata: [
        ...this.toFieldMetadata(advisory.sourceEntity, input.sourceFields),
        ...this.toFieldMetadata(advisory.targetEntity, input.targetFields),
      ],
      sourceEvidence: advisory.sourceEvidence,
      targetEvidence: advisory.targetEvidence,
      fieldMappings: mappings.map((mapping) => ({
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        transformationType: ANALYZER_TRANSFORMATION_TYPES.has(
          mapping.transformationType as FieldMapping['transformationType']
        )
          ? (mapping.transformationType as FieldMapping['transformationType'])
          : 'direct',
        isRequired: false,
      })),
      strategies: [],
      keyDeclarations: { sourceRecordKeys: [], parentKeys: [], targetKeys: [] },
    };
  }

  private toFieldMetadata(
    entity: string,
    fields: FieldMappingInput['sourceFields']
  ): CardinalityFieldMetadata[] {
    return fields.map((field) => ({
      entity,
      field: field.name,
      isCollection: field.isArray === true || field.type?.toLowerCase() === 'array',
    }));
  }

  generateAlternatives(mappings: EnhancedFieldMapping[]): EnhancedFieldMapping[] {
    return mappings.map(mapping => {
      if (mapping.alternatives && mapping.alternatives.length > 0) {
        return mapping;
      }

      return {
        ...mapping,
        alternatives: []
      };
    });
  }

  private validateWithSampleData(
    suggestion: MappingSuggestion,
    sampleData: DataSample[]
  ): { isValid: boolean; score: number } {
    let validSamples = 0;

    for (const sample of sampleData) {
      const container: unknown = (sample as any)?.sourceValues && typeof (sample as any).sourceValues === 'object'
        ? (sample as any).sourceValues
        : sample as any;

      if (!container || typeof container !== 'object') {
        continue;
      }

      const sourceValue = (container as Record<string, unknown>)[suggestion.sourceField];

      if (sourceValue !== undefined) {
        try {
          const isValid = this.testTransformation(sourceValue, suggestion.transformation);
          if (isValid) validSamples++;
        } catch {
          // Ignore transformation errors and mark as invalid
        }
      }
    }

    const score = sampleData.length > 0 ? validSamples / sampleData.length : 1.0;
    return {
      isValid: score > 0.5,
      score
    };
  }

  private testTransformation(value: unknown, transformation: TransformationRule): boolean {
    switch (transformation.type) {
      case 'direct':
        return true;
      case 'calculation':
        return Boolean(transformation.expression);
      case 'lookup':
        return Boolean(transformation.lookupTable);
      default:
        return true;
    }
  }

  private generateValidationRules(suggestion: MappingSuggestion): string[] {
    const rules: string[] = [];
    rules.push('Validate data type compatibility');
    rules.push('Handle null/empty values appropriately');

    if (suggestion.targetField.toLowerCase().includes('email')) {
      rules.push('Validate email format');
    }

    if (suggestion.targetField.toLowerCase().includes('phone')) {
      rules.push('Validate phone number format');
    }

    return rules;
  }

  private assessDataQualityImpact(suggestion: MappingSuggestion): number {
    let impact = 0;

    if (suggestion.transformation.type === 'calculation') impact += 0.3;
    if (suggestion.transformation.type === 'conditional') impact += 0.4;
    if (suggestion.transformation.type === 'lookup') impact += 0.2;
    if (suggestion.confidence < 0.7) impact += 0.3;

    return Math.min(impact, 1.0);
  }
}
