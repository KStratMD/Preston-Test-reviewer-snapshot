import 'reflect-metadata';
import { AIFieldMappingService, type SchemaDefinition, type NetSuiteSchema } from '../../services/ai/AIFieldMappingService';
import type { Logger } from '../../utils/Logger';
import type { DataRecord } from '../../types';

describe('AIFieldMappingService', () => {
  let service: AIFieldMappingService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    const mockTrainingDataRepo = {
      getTrainingExamples: jest.fn().mockResolvedValue([]),
      saveTrainingExample: jest.fn().mockResolvedValue(undefined),
      storeTrainingExample: jest.fn().mockResolvedValue(undefined),
      getSignalEffectiveness: jest.fn().mockResolvedValue({}),
      getDatasetStatistics: jest.fn().mockResolvedValue({ totalExamples: 0, successRate: 0, averageConfidence: 0, sourceSystemBreakdown: {}, targetSystemBreakdown: {}, transformationTypeBreakdown: {}, feedbackBreakdown: {} }),
    } as any;

    service = new AIFieldMappingService(mockLogger, mockTrainingDataRepo);
  });

  describe('suggestFieldMappings', () => {
    it('should generate AI field mapping suggestions', async () => {
      const sourceSchema: SchemaDefinition = {
        systemType: 'Salesforce',
        fields: [
          { name: 'Name', type: 'string', required: true },
          { name: 'Email', type: 'email', required: false },
          { name: 'Phone', type: 'phone', required: false },
        ],
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'companyname', type: 'string', required: true },
          { name: 'email', type: 'email', required: false },
          { name: 'phone', type: 'phone', required: false },
        ],
        customFields: [],
        relationships: [],
      };

      const sampleData: DataRecord[] = [
        {
          id: '1',
          fields: {
            Name: 'ACME Corp',
            Email: 'contact@acme.com',
            Phone: '+1-555-0123',
          },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
      ];

      const suggestions = await service.suggestFieldMappings(sourceSchema, targetSchema, sampleData);

      expect(suggestions).toBeDefined();
      expect(suggestions.length).toBeGreaterThan(0);

      // Check for high-confidence mappings
      const nameMapping = suggestions.find(s => s.sourceField === 'Name');
      expect(nameMapping).toBeDefined();
      expect(nameMapping?.targetField).toBe('companyname');
      expect(nameMapping?.confidence).toBeGreaterThan(0.8);

      const emailMapping = suggestions.find(s => s.sourceField === 'Email');
      expect(emailMapping).toBeDefined();
      expect(emailMapping?.targetField).toBe('email');
      expect(emailMapping?.confidence).toBeGreaterThan(0.8);
    });

    it('should handle custom fields', async () => {
      const sourceSchema: SchemaDefinition = {
        systemType: 'Salesforce',
        fields: [
          { name: 'Industry', type: 'string', required: false },
        ],
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [],
        customFields: [
          {
            id: 'custentity_industry',
            label: 'Industry',
            type: 'string',
            recordType: 'customer',
          },
        ],
        relationships: [],
      };

      const sampleData: DataRecord[] = [
        {
          id: '1',
          fields: { Industry: 'Technology' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
      ];

      const suggestions = await service.suggestFieldMappings(sourceSchema, targetSchema, sampleData);

      expect(suggestions.length).toBeGreaterThan(0);

      const industryMapping = suggestions.find(s => s.sourceField === 'Industry');
      expect(industryMapping).toBeDefined();
      expect(industryMapping?.targetField).toBe('custentity_industry');
      expect(industryMapping?.netsuiteSpecific?.customFieldId).toBe('custentity_industry');
    });

    it('should provide alternatives for mappings', async () => {
      const sourceSchema: SchemaDefinition = {
        systemType: 'Salesforce',
        fields: [
          { name: 'CompanyName', type: 'string', required: true },
        ],
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'companyname', type: 'string', required: true },
          { name: 'entityid', type: 'string', required: false },
        ],
        customFields: [],
        relationships: [],
      };

      const sampleData: DataRecord[] = [
        {
          id: '1',
          fields: { CompanyName: 'ACME Corp' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
      ];

      const suggestions = await service.suggestFieldMappings(sourceSchema, targetSchema, sampleData);

      const companyMapping = suggestions.find(s => s.sourceField === 'CompanyName');
      expect(companyMapping).toBeDefined();
      expect(companyMapping?.alternatives).toBeDefined();
      expect(companyMapping?.alternatives.length).toBeGreaterThan(0);
    });
  });

  describe('validateMappingQuality', () => {
    it('should validate field mapping quality', async () => {
      const mappings = [
        {
          sourceField: 'Name',
          targetField: 'companyname',
          transformationType: 'direct' as const,
          isRequired: true,
        },
        {
          sourceField: 'InvalidField',
          targetField: 'nonexistent',
          transformationType: 'direct' as const,
          isRequired: false,
        },
      ];

      const sourceSchema: SchemaDefinition = {
        systemType: 'Salesforce',
        fields: [
          { name: 'Name', type: 'string', required: true },
        ],
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'companyname', type: 'string', required: true },
        ],
        customFields: [],
        relationships: [],
      };

      const qualityReport = await service.validateMappingQuality(mappings, sourceSchema, targetSchema);

      expect(qualityReport).toBeDefined();
      expect(qualityReport.overallScore).toBeDefined();
      expect(qualityReport.fieldMappings).toHaveLength(2);
      expect(qualityReport.potentialIssues).toBeDefined();

      // Valid mapping should have high quality score
      const validMapping = qualityReport.fieldMappings.find(fm => fm.sourceField === 'Name');
      expect(validMapping?.qualityScore).toBeGreaterThan(0.8);

      // Invalid mapping should have low quality score
      const invalidMapping = qualityReport.fieldMappings.find(fm => fm.sourceField === 'InvalidField');
      expect(invalidMapping?.qualityScore).toBeLessThan(0.5);
    });

    it('should identify type mismatches', async () => {
      const mappings = [
        {
          sourceField: 'Revenue',
          targetField: 'email',
          transformationType: 'direct' as const,
          isRequired: false,
        },
      ];

      const sourceSchema: SchemaDefinition = {
        systemType: 'Salesforce',
        fields: [
          { name: 'Revenue', type: 'number', required: false },
        ],
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [
          { name: 'email', type: 'email', required: false },
        ],
        customFields: [],
        relationships: [],
      };

      const qualityReport = await service.validateMappingQuality(mappings, sourceSchema, targetSchema);

      const mappingQuality = qualityReport.fieldMappings[0]!;
      expect(mappingQuality.issues.length).toBeGreaterThan(0);
      expect(mappingQuality.issues.some(issue => issue.includes('Type mismatch'))).toBe(true);
    });
  });

  describe('recordUserFeedback', () => {
    it('should record positive user feedback', async () => {
      const suggestion = {
        sourceField: 'Name',
        targetField: 'companyname',
        confidence: 0.95,
        transformationType: 'direct' as const,
        explanation: 'Test suggestion',
        alternatives: [],
      };

      await expect(service.recordUserFeedback(suggestion, true)).resolves.not.toThrow();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Recording user feedback for AI learning',
        expect.objectContaining({
          sourceField: 'Name',
          targetField: 'companyname',
          accepted: true,
        }),
      );
    });

    it('should record negative feedback with alternative', async () => {
      const suggestion = {
        sourceField: 'Name',
        targetField: 'companyname',
        confidence: 0.95,
        transformationType: 'direct' as const,
        explanation: 'Test suggestion',
        alternatives: [],
      };

      await expect(service.recordUserFeedback(suggestion, false, 'entityid')).resolves.not.toThrow();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Recording user feedback for AI learning',
        expect.objectContaining({
          sourceField: 'Name',
          accepted: false,
          alternativeUsed: 'entityid',
        }),
      );
    });
  });

  describe('edge cases', () => {
    it('should handle empty sample data', async () => {
      const sourceSchema: SchemaDefinition = {
        systemType: 'Test',
        fields: [{ name: 'TestField', type: 'string' }],
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [{ name: 'companyname', type: 'string' }],
        customFields: [],
        relationships: [],
      };

      const suggestions = await service.suggestFieldMappings(sourceSchema, targetSchema, []);

      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('should handle schema with no matching fields', async () => {
      const sourceSchema: SchemaDefinition = {
        systemType: 'Test',
        fields: [{ name: 'UnknownField', type: 'string' }],
      };

      const targetSchema: NetSuiteSchema = {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [{ name: 'completelydifferent', type: 'string' }],
        customFields: [],
        relationships: [],
      };

      const sampleData: DataRecord[] = [
        {
          id: '1',
          fields: { UnknownField: 'test' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
      ];

      const suggestions = await service.suggestFieldMappings(sourceSchema, targetSchema, sampleData);

      expect(suggestions).toBeDefined();
      // Should still attempt to suggest mappings, even with low confidence
    });
  });
});
