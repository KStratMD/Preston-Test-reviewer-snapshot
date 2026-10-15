/**
 * Unit tests for SemanticAnalysisEngine
 * Tests the core AI semantic analysis service with dependency injection
 * 
 * NOTE: These tests use mocks to avoid actual LLM calls during unit testing.
 * Integration tests with real LMStudio are in tests/integration/
 */

import { Container } from 'inversify';
import { SemanticAnalysisEngine } from '../../../../src/services/ai/SemanticAnalysisEngine';
import { TYPES } from '../../../../src/inversify/types';
import type {
  FieldDefinition,
  BusinessContext,
  FieldAnalysisRequest,
  SemanticAnalysis,
  SimilarityRequest,
  SimilarityResult
} from '../../../../src/types/semantic.types';

// Mock implementations
class MockSecureAIService {
  async callProvider(options: any): Promise<{
    content: string;
    provider: string;
    model: string;
    cost?: number;
    tokensUsed?: { prompt: number; completion: number; total: number };
  }> {
    // Build prompt from messages
    let prompt = '';
    for (const msg of options.messages) {
      prompt += msg.content + ' ';
    }
    
    // Return mock LLM response based on the prompt content
    if (prompt.includes('semantic similarity') || prompt.includes('Compare the semantic similarity')) {
      return {
        content: JSON.stringify({
          similarity: 0.95, // Note: 'similarity' not 'score' - gets mapped to score
          explanation: 'Both fields represent similar concepts with high semantic overlap',
          confidence: 0.9,
          semanticRelationship: 'alias',
          reasons: ['Similar naming patterns', 'Compatible data types', 'Same business domain']
        }),
        provider: 'lmstudio',
        model: 'mock-model',
        cost: 0,
        tokensUsed: { prompt: 50, completion: 30, total: 80 }
      };
    }
    
    // Check if analyzing number/integer types for type compatibility
    const isNumericAnalysis = prompt.includes('age') || 
                             prompt.includes('number') ||
                             prompt.includes('integer');
    
    // Default field mapping response with correct format (targetFieldIndex, not targetField)
    return {
      content: JSON.stringify({
        primaryMapping: {
          targetFieldIndex: 0, // Index into the targetFields array
          confidence: 0.92,
          semanticSimilarity: 0.95,
          reasons: ['Both fields represent email addresses', 'Same data type', 'Compatible formats'],
          typeCompatibility: {
            compatible: true,
            confidence: 1.0,
            conversionNeeded: undefined,
            dataLossRisk: 'none'
          },
          transformationType: 'direct'
        },
        alternativeMappings: [],
        reasoning: 'Fields are semantically identical with strong name similarity and matching data types',
        confidence: 0.92,
        risks: [],
        compliance: [],
        transformation: {
          type: 'direct',
          logic: 'Direct copy with no transformation needed',
          validation: []
        }
      }),
      provider: 'lmstudio',
      model: 'mock-model',
      cost: 0,
      tokensUsed: { prompt: 150, completion: 200, total: 350 }
    };
  }

  supportsEmbeddings(): boolean {
    return false; // Mock doesn't support embeddings
  }
}

class MockLogger {
  info(message: string, data?: any): void { }
  error(message: string, error?: any): void { }
  warn(message: string, data?: any): void { }
  debug(message: string, data?: any): void { }
}

describe('SemanticAnalysisEngine', () => {
  let container: Container;
  let engine: SemanticAnalysisEngine;
  let mockAIService: MockSecureAIService;
  let mockLogger: MockLogger;

  beforeEach(() => {
    // Set up dependency injection container
    container = new Container();
    
    mockAIService = new MockSecureAIService();
    mockLogger = new MockLogger();
    
    container.bind(TYPES.SecureAIService).toConstantValue(mockAIService);
    container.bind(TYPES.Logger).toConstantValue(mockLogger);
    container.bind(TYPES.SemanticAnalysisEngine).to(SemanticAnalysisEngine);
    
    engine = container.get<SemanticAnalysisEngine>(TYPES.SemanticAnalysisEngine);
  });

  describe('Constructor and Initialization', () => {
    test('should initialize successfully', () => {
      expect(engine).toBeDefined();
      expect(engine).toBeInstanceOf(SemanticAnalysisEngine);
    });

    test('should inject dependencies correctly', () => {
      // If we get here without errors, DI worked
      expect(engine).toBeTruthy();
    });
  });

  describe('analyzeFieldMapping', () => {
    let sourceField: FieldDefinition;
    let targetFields: FieldDefinition[];
    let context: BusinessContext;

    beforeEach(() => {
      sourceField = {
        name: 'customer_email',
        type: 'string',
        description: 'Customer email address',
        samples: ['john@example.com', 'jane@test.com'],
        constraints: {
          required: true,
          format: 'email'
        }
      };

      targetFields = [
        {
          name: 'email_address',
          type: 'string',
          description: 'Email address of the customer',
          constraints: {
            required: true,
            format: 'email'
          }
        },
        {
          name: 'contact_email',
          type: 'string',
          description: 'Contact email'
        }
      ];

      context = {
        industry: 'financial',
        process: 'customer-onboarding',
        regulations: ['GDPR', 'SOX'],
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite'
      };
    });

    test('should analyze field mapping successfully', async () => {
      const request: FieldAnalysisRequest = {
        sourceField,
        targetFields,
        context
      };

      const result: SemanticAnalysis = await engine.analyzeFieldMapping(request);

      expect(result).toBeDefined();
      expect(result.primaryMapping).toBeDefined();
      expect(result.primaryMapping.confidence).toBeGreaterThan(0.5);
      expect(result.primaryMapping.targetField).toBeDefined();
      expect(result.primaryMapping.targetField.name).toBe('email_address');
    });

    test('should return confidence scores', async () => {
      const request: FieldAnalysisRequest = {
        sourceField,
        targetFields,
        context
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.primaryMapping.confidence).toBeGreaterThan(0);
      expect(result.primaryMapping.confidence).toBeLessThanOrEqual(1);
    });

    test('should include reasoning', async () => {
      const request: FieldAnalysisRequest = {
        sourceField,
        targetFields,
        context
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result.reasoning).toBeDefined();
      expect(result.reasoning.length).toBeGreaterThan(0);
      expect(result.primaryMapping.reasons).toBeDefined();
      expect(result.primaryMapping.reasons.length).toBeGreaterThan(0);
    });

    test('should assess type compatibility', async () => {
      const request: FieldAnalysisRequest = {
        sourceField,
        targetFields,
        context
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result.primaryMapping.typeCompatibility).toBeDefined();
      expect(result.primaryMapping.typeCompatibility.compatible).toBeDefined();
      expect(result.primaryMapping.typeCompatibility.dataLossRisk).toBeDefined();
      expect(['none', 'low', 'medium', 'high']).toContain(
        result.primaryMapping.typeCompatibility.dataLossRisk
      );
    });

    test('should include metadata', async () => {
      const request: FieldAnalysisRequest = {
        sourceField,
        targetFields,
        context
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result.metadata).toBeDefined();
      expect(result.metadata.provider).toBeDefined();
      expect(result.metadata.model).toBeDefined();
      expect(result.metadata.timestamp).toBeDefined();
      expect(result.metadata.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.metadata.cost).toBeGreaterThanOrEqual(0);
      expect(result.metadata.version).toBeDefined();
    });
  });

  describe('calculateSemanticSimilarity', () => {
    test('should calculate similarity for identical concepts', async () => {
      const request: SimilarityRequest = {
        text1: 'customer_email',
        text2: 'email_address',
        context: 'CRM field mapping'
      };

      const result: SimilarityResult = await engine.calculateSemanticSimilarity(request);

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThan(0.8);
      expect(result.method).toBeDefined();
      expect(['embeddings', 'llm_analysis', 'heuristic', 'calibrated_fallback']).toContain(result.method);
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('should calculate similarity for related concepts', async () => {
      const request: SimilarityRequest = {
        text1: 'customer_name',
        text2: 'full_name',
        context: 'Customer data'
      };

      const result = await engine.calculateSemanticSimilarity(request);

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThan(0.3);
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('should include explanation', async () => {
      const request: SimilarityRequest = {
        text1: 'email',
        text2: 'contact_email',
        context: 'Contact information'
      };

      const result = await engine.calculateSemanticSimilarity(request);

      expect(result.explanation).toBeDefined();
    });

    test('should provide calibrated fallback when embeddings are requested', async () => {
      const request: SimilarityRequest = {
        text1: 'billing_email',
        text2: 'email_address',
        context: 'Billing contact details',
        useEmbeddings: true
      };

      const result = await engine.calculateSemanticSimilarity(request);

      expect(result).toBeDefined();
      expect(result.method).toBe('calibrated_fallback');
      expect(result.score).toBeGreaterThan(0.3);
      expect(result.explanation).toMatch(/token overlap/i);
      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('Confidence Calculation', () => {
    test('should calculate confidence based on multiple factors', async () => {
      const request: FieldAnalysisRequest = {
        sourceField: {
          name: 'email',
          type: 'string',
          samples: ['test@example.com']
        },
        targetFields: [
          {
            name: 'email_address',
            type: 'string'
          }
        ],
        context: {
          industry: 'technology'
        }
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result.confidence).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Type Compatibility', () => {
    test('should detect compatible types', async () => {
      const request: FieldAnalysisRequest = {
        sourceField: {
          name: 'age',
          type: 'number',
          samples: [25, 30, 45]
        },
        targetFields: [
          {
            name: 'customer_age',
            type: 'integer'
          }
        ],
        context: {}
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result.primaryMapping.typeCompatibility.compatible).toBe(true);
    });
  });

  describe('Risk Assessment', () => {
    test('should identify risks', async () => {
      const request: FieldAnalysisRequest = {
        sourceField: {
          name: 'ssn',
          type: 'string',
          description: 'Social Security Number',
          samples: ['123-45-6789']
        },
        targetFields: [
          {
            name: 'tax_id',
            type: 'string'
          }
        ],
        context: {
          regulations: ['HIPAA', 'GDPR']
        }
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result.risks).toBeDefined();
      expect(Array.isArray(result.risks)).toBe(true);
    });

    test('should categorize risks by severity', async () => {
      const request: FieldAnalysisRequest = {
        sourceField: {
          name: 'password',
          type: 'string'
        },
        targetFields: [
          {
            name: 'user_password',
            type: 'string'
          }
        ],
        context: {
          regulations: ['GDPR']
        }
      };

      const result = await engine.analyzeFieldMapping(request);

      if (result.risks.length > 0) {
        result.risks.forEach(risk => {
          expect(['low', 'medium', 'high', 'critical']).toContain(risk.severity);
        });
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid requests gracefully', async () => {
      const request: FieldAnalysisRequest = {
        sourceField: { name: '', type: '' }, // Invalid
        targetFields: [],
        context: {}
      };

      // Should either throw a descriptive error or return a low-confidence result
      await expect(
        engine.analyzeFieldMapping(request)
      ).rejects.toThrow();
    });

    test('should handle missing context', async () => {
      const request: FieldAnalysisRequest = {
        sourceField: {
          name: 'email',
          type: 'string'
        },
        targetFields: [
          {
            name: 'email_address',
            type: 'string'
          }
        ],
        context: {} // Minimal context
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result).toBeDefined();
      expect(result.primaryMapping).toBeDefined();
    });
  });

  describe('Metadata Tracking', () => {
    test('should track analysis metadata', async () => {
      const request: FieldAnalysisRequest = {
        sourceField: {
          name: 'test_field',
          type: 'string'
        },
        targetFields: [
          {
            name: 'target_field',
            type: 'string'
          }
        ],
        context: {}
      };

      const result = await engine.analyzeFieldMapping(request);

      expect(result.metadata.version).toBeDefined();
      expect(result.metadata.provider).toBeDefined();
      expect(result.metadata.model).toBeDefined();
      expect(result.metadata.timestamp).toBeInstanceOf(Date);
      expect(result.metadata.responseTime).toBeGreaterThanOrEqual(0);
    });
  });
});
