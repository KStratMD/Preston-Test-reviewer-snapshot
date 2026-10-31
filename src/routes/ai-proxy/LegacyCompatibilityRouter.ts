/**
 * Legacy AI Compatibility Router
 *
 * PR 1B redirects retired /api/ai/* paths into /api/ai/proxy/*.
 * These handlers preserve the legacy direct-family response shapes for
 * endpoints that do not have a one-for-one canonical proxy counterpart.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../../utils/Logger';
import type { AIDataQualityService } from '../../services/AIDataQualityService';
import type { AIBusinessIntelligenceService } from '../../services/AIBusinessIntelligenceService';
import { handleApprovalQueueError } from '../../middleware/governance/approvalQueueErrorHandler';

const GenerateBodySchema = z.object({
  sourceSchema: z.array(z.string().min(1)).min(1),
  sampleData: z.unknown().optional(),
  existingMappings: z.unknown().optional(),
  context: z.unknown().optional(),
});

const MappingItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  sourceField: z.string().optional(),
  targetField: z.string().optional(),
  transformation: z.unknown().optional(),
  confidence: z.number().optional(),
  isRequired: z.boolean().optional(),
}).passthrough();

const AnalyzeBodySchema = z.object({
  mappings: z.array(MappingItemSchema).min(1),
  sampleData: z.unknown().optional(),
});

const ValidateBodySchema = z.object({
  mappings: z.array(MappingItemSchema).min(1),
  testData: z.unknown().optional(),
});

const FieldEntrySchema = z.union([
  z.string(),
  z.object({ name: z.string() }).passthrough(),
  z.unknown(),
]);

const SuggestionsBodySchema = z.object({
  sourceFields: z.array(FieldEntrySchema).min(1),
  targetFields: z.array(FieldEntrySchema).optional(),
  sourceSystem: z.string().optional(),
  targetSystem: z.string().optional(),
  sampleData: z.unknown().optional(),
  context: z.unknown().optional(),
});

const AdvancedAnalysisBodySchema = z.object({
  mappings: z.array(MappingItemSchema).min(1),
  sourceFields: z.array(z.unknown()).optional(),
  targetFields: z.array(z.unknown()).optional(),
  sourceSystem: z.string().optional(),
  targetSystem: z.string().optional(),
  sampleData: z.unknown().optional(),
});

interface MappingItem {
  id?: string | number;
  sourceField?: string;
  targetField?: string;
  transformation?: unknown;
  confidence?: number;
  isRequired?: boolean;
}

interface LegacyDataQualityIssue {
  field: string;
  issue: 'format' | 'missing' | 'anomaly' | 'duplicate' | 'inconsistent';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  suggestion: string;
  confidence: number;
  autoFixable: boolean;
}

function normalizeFieldName(field: unknown): string {
  if (typeof field === 'string') {
    return field;
  }
  if (field && typeof field === 'object' && 'name' in field && typeof field.name === 'string') {
    return field.name;
  }
  return String(field);
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[_\s]/g, '').replace(/[^a-z0-9]/g, '');
}

function validationFailure(res: Response, error: z.ZodError): void {
  res.status(400).json({
    success: false,
    error: 'Validation failed',
    issues: error.issues,
  });
}

function createMappingSuggestion(sourceField: string, targetFields: string[], index: number) {
  const normalizedSource = normalizeForMatch(sourceField);
  const matchingTarget = targetFields.find((target) => normalizeForMatch(target).includes(normalizedSource));
  const targetField = matchingTarget ? normalizeForMatch(matchingTarget) : normalizedSource;

  let transformation = '';
  let transformationReason = '';
  const lowerSource = sourceField.toLowerCase();
  if (lowerSource.includes('name')) {
    transformation = 'value.trim().replace(/\\b\\w/g, l => l.toUpperCase())';
    transformationReason = 'Convert to title case for proper name formatting';
  } else if (lowerSource.includes('email')) {
    transformation = 'value.toLowerCase().trim()';
    transformationReason = 'Normalize email to lowercase and remove whitespace';
  } else if (lowerSource.includes('date') || lowerSource.includes('timestamp')) {
    transformation = 'new Date(value).toISOString()';
    transformationReason = 'Convert to ISO 8601 format for standard date handling';
  } else if (lowerSource.includes('phone')) {
    transformation = 'value.replace(/[^0-9+]/g, "")';
    transformationReason = 'Extract only digits and plus sign from phone number';
  }

  return {
    id: Date.now() + index,
    sourceField,
    targetField,
    sourceType: 'String',
    targetType: 'String',
    isRequired: /^(id|.*_id|name|email)$/i.test(sourceField),
    transformation,
    transformationReason,
    defaultValue: '',
    aiGenerated: true,
    confidence: transformation ? 0.92 : 0.75,
    reasoning: `AI analyzed "${sourceField}". ${transformationReason || 'Direct mapping recommended.'}`,
  };
}

export function createLegacyFieldMappingRouter(aiAuthMiddleware: RequestHandler): Router {
  const router = Router();

  router.head('/generate', aiAuthMiddleware, async (_req: Request, res: Response): Promise<void> => {
    res.status(200).end();
  });

  router.post('/generate', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = GenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      validationFailure(res, parsed.error);
      return;
    }

    const mappings = parsed.data.sourceSchema.map((sourceField, index) => ({
      ...createMappingSuggestion(sourceField, [], index),
      targetField: normalizeForMatch(sourceField),
      confidence: sourceField.toLowerCase().includes('email') ? 0.95 : 0.88,
    })).slice(0, 5);

    res.json({
      success: true,
      mappings,
      metadata: {
        totalSuggestions: mappings.length,
        averageConfidence: mappings.reduce((acc, mapping) => acc + mapping.confidence, 0) / mappings.length,
        processingTime: 500,
      },
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/analyze', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = AnalyzeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      validationFailure(res, parsed.error);
      return;
    }

    res.json({
      success: true,
      analysis: {
        totalMappings: parsed.data.mappings.length,
        qualityScore: 90,
        issues: [],
        improvements: [],
      },
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/validate', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = ValidateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      validationFailure(res, parsed.error);
      return;
    }

    const validationResults = parsed.data.mappings.map((mapping: MappingItem) => {
      const isValid = Boolean(mapping.sourceField && mapping.targetField);
      const hasTransformation = Boolean(mapping.transformation);
      return {
        mappingId: mapping.id,
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        isValid,
        hasTransformation,
        validationScore: isValid ? (hasTransformation ? 100 : 80) : 0,
        suggestions: !isValid ? ['Missing required fields'] : hasTransformation ? [] : ['Consider adding data transformation'],
      };
    });

    res.json({
      success: true,
      validationResults,
      overallScore: Math.round(validationResults.reduce((acc, result) => acc + result.validationScore, 0) / validationResults.length),
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/suggestions', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = SuggestionsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      validationFailure(res, parsed.error);
      return;
    }

    const sourceFields = parsed.data.sourceFields.map(normalizeFieldName);
    const targetFields = (parsed.data.targetFields ?? []).map(normalizeFieldName);
    const suggestions = sourceFields.map((sourceField, index) => createMappingSuggestion(sourceField, targetFields, index));

    res.json({
      success: true,
      suggestions,
      metadata: {
        totalSuggestions: suggestions.length,
        averageConfidence: suggestions.reduce((acc, suggestion) => acc + suggestion.confidence, 0) / suggestions.length,
        highConfidenceMappings: suggestions.filter((suggestion) => suggestion.confidence > 0.8).length,
        transformationsApplied: suggestions.filter((suggestion) => suggestion.transformation).length,
      },
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/advanced-analysis', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = AdvancedAnalysisBodySchema.safeParse(req.body);
    if (!parsed.success) {
      validationFailure(res, parsed.error);
      return;
    }

    const mappings = parsed.data.mappings;
    const averageConfidence = mappings.reduce((acc, mapping) => acc + (mapping.confidence ?? 0), 0) / mappings.length;

    res.json({
      success: true,
      analysis: {
        overallScore: Math.round(averageConfidence * 100),
        confidence: {
          average: averageConfidence,
          distribution: {
            high: mappings.filter((mapping) => (mapping.confidence ?? 0) >= 0.8).length,
            medium: mappings.filter((mapping) => (mapping.confidence ?? 0) >= 0.6 && (mapping.confidence ?? 0) < 0.8).length,
            low: mappings.filter((mapping) => (mapping.confidence ?? 0) < 0.6).length,
          },
        },
        risks: mappings
          .filter((mapping) => mapping.isRequired && !mapping.targetField)
          .map((mapping) => ({
            level: 'high',
            message: `Required field ${mapping.sourceField ?? 'unknown'} is unmapped`,
            impact: 'Data completeness risk',
          })),
      },
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

export function createLegacyDataQualityRouter(
  dataQualityService: AIDataQualityService,
  aiAuthMiddleware: RequestHandler
): Router {
  const router = Router();

  router.post('/analyze', aiAuthMiddleware, async (req: Request, res: Response, next): Promise<void> => {
    const { record, systemType } = req.body as { record?: unknown; systemType?: string };
    if (record === undefined && systemType === undefined) {
      next();
      return;
    }
    if (!record || !systemType) {
      res.status(400).json({ error: 'Record and system type are required' });
      return;
    }

    try {
      const analysis = await dataQualityService.analyzeDataQuality(record, systemType);
      res.json({ success: true, analysis, timestamp: new Date().toISOString() });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.legacy.analyze',
        resourceId: 'new',
      })) return;
      logger.error('Legacy data quality analysis error:', error);
      res.status(500).json({ error: 'Failed to analyze data quality', details: (error as Error).message });
    }
  });

  router.post('/generate-rules', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { data, systemType } = req.body as { data?: unknown[]; systemType?: string };
    if (!data || !Array.isArray(data)) {
      res.status(400).json({ error: 'Data array is required' });
      return;
    }

    try {
      const rules = await dataQualityService.generateCleansingRules(data, systemType ?? 'generic');
      res.json({ success: true, rules, totalRules: rules.length, timestamp: new Date().toISOString() });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.legacy.generate_rules',
        resourceId: 'new',
      })) return;
      logger.error('Legacy rule generation error:', error);
      res.status(500).json({ error: 'Failed to generate cleansing rules', details: (error as Error).message });
    }
  });

  router.post('/auto-fix', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { record, issues } = req.body as { record?: unknown; issues?: LegacyDataQualityIssue[] };
    if (!record || !issues) {
      res.status(400).json({ error: 'Record and issues are required' });
      return;
    }

    try {
      const fixedRecord = await dataQualityService.autoFixIssues(record, issues);
      res.json({
        success: true,
        originalRecord: record,
        fixedRecord,
        fixesApplied: issues.filter((issue) => issue.autoFixable).length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.legacy.auto_fix',
        resourceId: 'new',
      })) return;
      logger.error('Legacy auto-fix error:', error);
      res.status(500).json({ error: 'Failed to auto-fix issues', details: (error as Error).message });
    }
  });

  return router;
}

export function createLegacyBusinessIntelligenceRouter(
  businessIntelligenceService: AIBusinessIntelligenceService,
  aiAuthMiddleware: RequestHandler
): Router {
  const router = Router();

  router.get('/insights', aiAuthMiddleware, async (_req: Request, res: Response): Promise<void> => {
    try {
      const insights = await businessIntelligenceService.generateBusinessInsights();
      res.json({ success: true, insights, totalInsights: insights.length, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Legacy BI insights error:', error);
      res.status(500).json({ error: 'Failed to generate insights', details: (error as Error).message });
    }
  });

  router.get('/roi/:integrationId', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
      const roiPrediction = await businessIntelligenceService.predictROI(req.params.integrationId);
      res.json({ success: true, roiPrediction, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Legacy BI ROI error:', error);
      res.status(500).json({ error: 'Failed to predict ROI', details: (error as Error).message });
    }
  });

  router.get('/usage-patterns', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
      const patterns = await businessIntelligenceService.analyzeUsagePatterns(req.query.integrationId as string | undefined);
      res.json({ success: true, patterns, totalPatterns: patterns.length, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Legacy BI usage patterns error:', error);
      res.status(500).json({ error: 'Failed to analyze usage patterns', details: (error as Error).message });
    }
  });

  router.get('/optimizations', aiAuthMiddleware, async (_req: Request, res: Response): Promise<void> => {
    try {
      const optimizations = await businessIntelligenceService.generatePerformanceOptimizations();
      res.json({ success: true, optimizations, totalOptimizations: optimizations.length, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Legacy BI optimizations error:', error);
      res.status(500).json({ error: 'Failed to generate optimizations', details: (error as Error).message });
    }
  });

  router.get('/predictive/:integrationId', aiAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
      const analytics = await businessIntelligenceService.generatePredictiveAnalytics(req.params.integrationId);
      res.json({ success: true, analytics, totalMetrics: analytics.length, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Legacy BI predictive analytics error:', error);
      res.status(500).json({ error: 'Failed to generate predictive analytics', details: (error as Error).message });
    }
  });

  return router;
}
