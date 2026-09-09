import type { EnhancedFieldMapping, FieldMappingInput } from '../../../interfaces';

/**
 * Provides aggregate quality scoring and recommendation generation for field mappings.
 */
export class MappingQualityService {
  calculateOverallQuality(mappings: EnhancedFieldMapping[]): number {
    if (mappings.length === 0) return 0;

    const totalConfidence = mappings.reduce((sum, mapping) => sum + mapping.confidence, 0);
    return totalConfidence / mappings.length;
  }

  generateRecommendations(mappings: EnhancedFieldMapping[], input: FieldMappingInput): string[] {
    const recommendations: string[] = [];

    const mappedSourceFields = new Set(mappings.map(m => m.sourceField));
    const unmappedCount = input.sourceFields.length - mappedSourceFields.size;

    if (unmappedCount > 0) {
      recommendations.push(`${unmappedCount} source fields remain unmapped - review for completeness`);
    }

    const lowConfidenceMappings = mappings.filter(m => m.confidence < 0.7);
    if (lowConfidenceMappings.length > 0) {
      recommendations.push(`${lowConfidenceMappings.length} mappings have low confidence - consider manual review`);
    }

    const complexTransformations = mappings.filter(m =>
      m.transformationType === 'calculation' || m.transformationType === 'conditional'
    );
    if (complexTransformations.length > 0) {
      recommendations.push(`${complexTransformations.length} complex transformations detected - test thoroughly`);
    }

    const highImpactMappings = mappings.filter(m => (m.dataQualityImpact || 0) > 0.7);
    if (highImpactMappings.length > 0) {
      recommendations.push(`${highImpactMappings.length} mappings may impact data quality - implement validation`);
    }

    return recommendations;
  }
}
