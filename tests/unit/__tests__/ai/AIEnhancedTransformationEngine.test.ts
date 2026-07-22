import 'reflect-metadata';
import { AIEnhancedTransformationEngine, type SmartMappingRequest } from '../../services/ai/AIEnhancedTransformationEngine';
import type { AIFieldMappingService } from '../../services/ai/AIFieldMappingService';
import type { SemanticAnalyzer } from '../../services/ai/SemanticAnalyzer';
import type { NetSuiteSchemaIntelligence } from '../../services/ai/NetSuiteSchemaIntelligence';
import type { PatternRecognizer } from '../../services/ai/PatternRecognizer';
import type { TrainingDataRepository } from '../../services/ai/TrainingDataRepository';
import type { Logger } from '../../utils/Logger';
import type { TransformationContext } from '../../services/TransformationEngine';
import type { DataRecord } from '../../types';

describe('AIEnhancedTransformationEngine', () => {
  let engine: AIEnhancedTransformationEngine;
  let mockLogger: jest.Mocked<Logger>;
  let mockAIService: jest.Mocked<AIFieldMappingService>;
  let mockSemanticAnalyzer: jest.Mocked<SemanticAnalyzer>;
  let mockNetSuiteIntelligence: jest.Mocked<NetSuiteSchemaIntelligence>;
  let mockPatternRecognizer: jest.Mocked<PatternRecognizer>;
  let mockTrainingRepository: jest.Mocked<TrainingDataRepository>;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockAIService = {
      suggestFieldMappings: jest.fn(),
      validateMappingQuality: jest.fn(),
      recordUserFeedback: jest.fn(),
    } as any;

    mockSemanticAnalyzer = {
      analyzeFieldSemantics: jest.fn(),
    } as any;

    mockNetSuiteIntelligence = {
      getNetSuiteSchema: jest.fn(),
    } as any;

    mockPatternRecognizer = {
      analyzeDataPattern: jest.fn(),
      findPatternMatches: jest.fn(),
    } as any;

    mockTrainingRepository = {
      storeTrainingExample: jest.fn(),
      getTrainingExamples: jest.fn(),
    } as any;

    engine = new AIEnhancedTransformationEngine(
      mockLogger,
      mockAIService,
      mockSemanticAnalyzer,
      mockNetSuiteIntelligence,
      mockPatternRecognizer,
      mockTrainingRepository,
    );
  });

  describe('generateSmartMappings', () => {
    it('should generate smart field mappings with AI suggestions', async () => {
      const request: SmartMappingRequest = {
        sourceData: [
          {
            id: '1',
            fields: { Name: 'ACME Corp', Email: 'contact@acme.com' },
            metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
          },
        ],
        sourceSchema: {
          systemType: 'Salesforce',
          fields: [
            { name: 'Name', type: 'string', required: true },
            { name: 'Email', type: 'email', required: false },
          ],
        },
        targetSchema: {
          systemType: 'NetSuite',
          recordType: 'customer',
          fields: [
            { name: 'companyname', type: 'string', required: true },
            { name: 'email', type: 'email', required: false },
          ],
          customFields: [],
          relationships: [],
        },
      };

      // Mock AI suggestions
      mockAIService.suggestFieldMappings.mockResolvedValue([
        {
          sourceField: 'Name',
          targetField: 'companyname',
          confidence: 0.95,
          transformationType: 'direct',
          explanation: 'High confidence mapping',
          alternatives: [],
        },
        {
          sourceField: 'Email',
          targetField: 'email',
          confidence: 0.98,
          transformationType: 'direct',
          explanation: 'Exact field match',
          alternatives: [],
        },
      ]);

      // Mock quality validation
      mockAIService.validateMappingQuality.mockResolvedValue({
        overallScore: 0.95,
        fieldMappings: [
          {
            sourceField: 'Name',
            targetField: 'companyname',
            qualityScore: 0.95,
            issues: [],
            suggestions: [],
          },
        ],
        recommendations: [],
        potentialIssues: [],
      });

      const response = await engine.generateSmartMappings(request);

      expect(response).toBeDefined();
      expect(response.suggestedMappings).toHaveLength(2);
      expect(response.aiSuggestions).toHaveLength(2);
      expect(response.confidence).toBeGreaterThan(0.9);
      expect(response.qualityReport.overallScore).toBe(0.95);

      expect(mockAIService.suggestFieldMappings).toHaveBeenCalledWith(
        request.sourceSchema,
        request.targetSchema,
        request.sourceData,
      );
    });

    it('should merge existing mappings with AI suggestions', async () => {
      const request: SmartMappingRequest = {
        sourceData: [
          {
            id: '1',
            fields: { Name: 'ACME Corp', Phone: '+1-555-0123' },
            metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
          },
        ],
        sourceSchema: {
          systemType: 'Salesforce',
          fields: [
            { name: 'Name', type: 'string' },
            { name: 'Phone', type: 'phone' },
          ],
        },
        targetSchema: {
          systemType: 'NetSuite',
          recordType: 'customer',
          fields: [
            { name: 'companyname', type: 'string' },
            { name: 'phone', type: 'phone' },
          ],
          customFields: [],
          relationships: [],
        },
        existingMappings: [
          {
            sourceField: 'Name',
            targetField: 'companyname',
            transformationType: 'direct',
            isRequired: true,
          },
        ],
      };

      mockAIService.suggestFieldMappings.mockResolvedValue([
        {
          sourceField: 'Phone',
          targetField: 'phone',
          confidence: 0.92,
          transformationType: 'direct',
          explanation: 'Phone field mapping',
          alternatives: [],
        },
      ]);

      mockAIService.validateMappingQuality.mockResolvedValue({
        overallScore: 0.9,
        fieldMappings: [],
        recommendations: [],
        potentialIssues: [],
      });

      const response = await engine.generateSmartMappings(request);

      expect(response.suggestedMappings).toHaveLength(2);
      // Should include both existing and new mappings
      expect(response.suggestedMappings.some(m => m.sourceField === 'Name')).toBe(true);
      expect(response.suggestedMappings.some(m => m.sourceField === 'Phone')).toBe(true);
    });

    it('should filter mappings by confidence threshold', async () => {
      const request: SmartMappingRequest = {
        sourceData: [],
        sourceSchema: { systemType: 'Test', fields: [{ name: 'TestField', type: 'string' }] },
        targetSchema: {
          systemType: 'NetSuite',
          recordType: 'customer',
          fields: [{ name: 'companyname', type: 'string' }],
          customFields: [],
          relationships: [],
        },
        options: {
          confidenceThreshold: 0.9,
        },
      };

      mockAIService.suggestFieldMappings.mockResolvedValue([
        {
          sourceField: 'TestField',
          targetField: 'companyname',
          confidence: 0.85, // Below threshold
          transformationType: 'direct',
          explanation: 'Low confidence mapping',
          alternatives: [],
        },
      ]);

      mockAIService.validateMappingQuality.mockResolvedValue({
        overallScore: 0.8,
        fieldMappings: [],
        recommendations: [],
        potentialIssues: [],
      });

      const response = await engine.generateSmartMappings(request);

      // Should filter out low-confidence suggestions
      expect(response.suggestedMappings).toHaveLength(0);
      expect(response.aiSuggestions).toHaveLength(1); // Still present in suggestions
    });
  });

  describe('transformWithAI', () => {
    it('should perform AI-enhanced transformation', async () => {
      const context: TransformationContext = {
        sourceData: {
          id: '1',
          fields: { Name: 'ACME Corp' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
        mappings: [
          {
            sourceField: 'Name',
            targetField: 'companyname',
            transformationType: 'direct',
            isRequired: true,
          },
        ],
        rules: [],
      };

      const result = await engine.transformWithAI(context, {
        enableAutoMapping: true,
        confidenceThreshold: 0.8,
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.transformedData).toBeDefined();
      expect(result.confidence).toBeDefined();
      expect(result.aiSuggestions).toBeDefined();
      expect(result.learningInsights).toBeDefined();
    });

    it('should handle auto-mapping with high confidence suggestions', async () => {
      const context: TransformationContext = {
        sourceData: {
          id: '1',
          fields: { Name: 'ACME Corp', UnmappedField: 'Test' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
        mappings: [
          {
            sourceField: 'Name',
            targetField: 'companyname',
            transformationType: 'direct',
            isRequired: true,
          },
        ],
        rules: [],
      };

      const result = await engine.transformWithAI(context, {
        enableAutoMapping: true,
        autoAcceptHighConfidence: true,
        confidenceThreshold: 0.8,
      });

      expect(result.autoMappingsApplied).toBeGreaterThanOrEqual(0);
      expect(result.aiSuggestions).toBeDefined();
    });

    it('should provide learning insights', async () => {
      const context: TransformationContext = {
        sourceData: {
          id: '1',
          fields: { Name: 'ACME Corp' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
        mappings: [
          {
            sourceField: 'Name',
            targetField: 'companyname',
            transformationType: 'direct',
            isRequired: true,
          },
        ],
        rules: [],
      };

      const result = await engine.transformWithAI(context, {
        learningMode: true,
      });

      expect(result.learningInsights).toBeDefined();
      expect(Array.isArray(result.learningInsights)).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      const context: TransformationContext = {
        sourceData: {
          id: '1',
          fields: { Name: 'ACME Corp' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
        mappings: [
          {
            sourceField: 'InvalidField',
            targetField: 'nonexistent',
            transformationType: 'direct',
            isRequired: true,
          },
        ],
        rules: [],
      };

      const result = await engine.transformWithAI(context);

      expect(result).toBeDefined();
      expect(result.confidence).toBeLessThan(1.0);
      expect(result.learningInsights.length).toBeGreaterThan(0);
    });
  });

  describe('analyzeFieldPatterns', () => {
    it('should analyze field patterns in source data', async () => {
      const sourceData: DataRecord[] = [
        {
          id: '1',
          fields: { Email: 'test@example.com' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
        {
          id: '2',
          fields: { Email: 'contact@acme.com' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
      ];

      mockPatternRecognizer.analyzeDataPattern.mockResolvedValue({
        type: 'email',
        confidence: 0.95,
        examples: ['test@example.com', 'contact@acme.com'],
        statistics: {
          totalSamples: 2,
          matchingPatterns: 2,
          uniqueValues: 2,
          nullValues: 0,
        },
      });

      const pattern = await engine.analyzeFieldPatterns(sourceData, 'Email');

      expect(pattern).toBeDefined();
      expect(pattern.type).toBe('email');
      expect(pattern.confidence).toBe(0.95);
      expect(mockPatternRecognizer.analyzeDataPattern).toHaveBeenCalledWith(
        'Email',
        ['test@example.com', 'contact@acme.com'],
      );
    });

    it('should handle empty field data', async () => {
      const sourceData: DataRecord[] = [
        {
          id: '1',
          fields: { EmptyField: null },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
      ];

      mockPatternRecognizer.analyzeDataPattern.mockResolvedValue({
        type: 'string',
        confidence: 0.1,
        examples: [],
        statistics: {
          totalSamples: 1,
          matchingPatterns: 0,
          uniqueValues: 0,
          nullValues: 1,
        },
      });

      const pattern = await engine.analyzeFieldPatterns(sourceData, 'EmptyField');

      expect(pattern).toBeDefined();
      expect(pattern.confidence).toBe(0.1);
    });
  });

  describe('recordMappingFeedback', () => {
    it('should record user feedback for learning', async () => {
      const suggestion = {
        sourceField: 'Name',
        targetField: 'companyname',
        confidence: 0.95,
        transformationType: 'direct' as const,
        explanation: 'Test mapping',
        alternatives: [],
      };

      await engine.recordMappingFeedback(suggestion, true);

      expect(mockAIService.recordUserFeedback).toHaveBeenCalledWith(
        suggestion,
        true,
        undefined,
      );
    });

    it('should record feedback with alternative selection', async () => {
      const suggestion = {
        sourceField: 'Name',
        targetField: 'companyname',
        confidence: 0.95,
        transformationType: 'direct' as const,
        explanation: 'Test mapping',
        alternatives: [],
      };

      await engine.recordMappingFeedback(suggestion, false, 'entityid');

      expect(mockAIService.recordUserFeedback).toHaveBeenCalledWith(
        suggestion,
        false,
        'entityid',
      );
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle missing source data', async () => {
      const request: SmartMappingRequest = {
        sourceData: [],
        sourceSchema: { systemType: 'Test', fields: [] },
        targetSchema: {
          systemType: 'NetSuite',
          recordType: 'customer',
          fields: [],
          customFields: [],
          relationships: [],
        },
      };

      mockAIService.suggestFieldMappings.mockResolvedValue([]);
      mockAIService.validateMappingQuality.mockResolvedValue({
        overallScore: 0,
        fieldMappings: [],
        recommendations: [],
        potentialIssues: [],
      });

      const response = await engine.generateSmartMappings(request);

      expect(response).toBeDefined();
      expect(response.suggestedMappings).toHaveLength(0);
      expect(response.confidence).toBe(0);
    });

    it('should handle AI service errors', async () => {
      const context: TransformationContext = {
        sourceData: {
          id: '1',
          fields: { Name: 'ACME Corp' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
        mappings: [],
        rules: [],
      };

      const result = await engine.transformWithAI(context, {
        enableAutoMapping: true,
      });

      // Should still return a result even if AI enhancement fails
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
      expect(result.learningInsights).toBeDefined();
    });
  });
});
