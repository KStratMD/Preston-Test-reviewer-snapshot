import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { Logger } from '../utils/Logger';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { AIFieldMappingService } from '../services/ai/AIFieldMappingService';

const logger = new Logger('QualityRouter');
const router = Router();

interface QualityAssessmentRequest {
  mappings: {
    sourceField: string;
    targetField: string;
    confidence: number;
    transformation?: string;
  }[];
  sourceSystem: string;
  targetSystem: string;
}

/**
 * Assess the quality of field mappings
 * POST /api/ai/quality/assess
 */
router.post('/assess', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { mappings, sourceSystem, targetSystem } = req.body as QualityAssessmentRequest;

    if (!mappings || !Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Mappings array is required and must not be empty'
      });
    }

    // Calculate quality metrics
    const totalMappings = mappings.length;
    const highConfidenceMappings = mappings.filter(m => m.confidence >= 0.8).length;
    const mediumConfidenceMappings = mappings.filter(m => m.confidence >= 0.6 && m.confidence < 0.8).length;
    const lowConfidenceMappings = mappings.filter(m => m.confidence < 0.6).length;
    const averageConfidence = mappings.reduce((sum, m) => sum + m.confidence, 0) / totalMappings;
    const mappingsWithTransformations = mappings.filter(m => m.transformation).length;

    // Calculate overall quality score (0-100)
    const confidenceScore = averageConfidence * 50; // Up to 50 points for confidence
    const completenessScore = (totalMappings / (totalMappings + lowConfidenceMappings)) * 30; // Up to 30 points for completeness
    const transformationScore = (mappingsWithTransformations / totalMappings) * 20; // Up to 20 points for transformations
    const overallScore = Math.round(confidenceScore + completenessScore + transformationScore);

    // Identify issues and recommendations
    const issues: string[] = [];
    const recommendations: string[] = [];

    if (lowConfidenceMappings > 0) {
      issues.push(`${lowConfidenceMappings} low confidence mapping(s) detected`);
      recommendations.push('Review low confidence mappings manually for accuracy');
    }

    if (averageConfidence < 0.7) {
      issues.push('Average confidence is below recommended threshold (70%)');
      recommendations.push('Consider using sample data to improve mapping accuracy');
    }

    if (mappingsWithTransformations === 0 && totalMappings > 3) {
      issues.push('No data transformations applied');
      recommendations.push('Add transformations to normalize data formats (e.g., lowercase emails, format phone numbers)');
    }

    // Check for missing target fields
    const missingTargetFields = mappings.filter(m => !m.targetField || m.targetField.trim() === '').length;
    if (missingTargetFields > 0) {
      issues.push(`${missingTargetFields} mapping(s) missing target fields`);
      recommendations.push('Ensure all source fields have corresponding target fields');
    }

    logger.info('Quality assessment completed', {
      sourceSystem,
      targetSystem,
      totalMappings,
      overallScore,
      averageConfidence,
      issuesCount: issues.length
    });

    res.json({
      success: true,
      overallScore,
      confidence: {
        average: Math.round(averageConfidence * 100) / 100,
        distribution: {
          high: highConfidenceMappings,
          medium: mediumConfidenceMappings,
          low: lowConfidenceMappings
        }
      },
      completeness: {
        mappedFields: totalMappings - missingTargetFields,
        totalFields: totalMappings,
        percentage: Math.round(((totalMappings - missingTargetFields) / totalMappings) * 100)
      },
      transformations: {
        applied: mappingsWithTransformations,
        total: totalMappings,
        percentage: Math.round((mappingsWithTransformations / totalMappings) * 100)
      },
      issues,
      recommendations,
      metadata: {
        sourceSystem,
        targetSystem,
        assessedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to assess quality', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to assess mapping quality',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

export { router as qualityRouter };
