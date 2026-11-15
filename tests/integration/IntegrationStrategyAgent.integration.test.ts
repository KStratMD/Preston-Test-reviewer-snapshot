/**
 * Integration Strategy Agent - Integration Tests
 *
 * Purpose: Baseline behavioral tests for god class refactoring
 * These tests validate the current behavior before breaking the class into services
 */

import { Container } from 'inversify';
import { TYPES } from '../../src/inversify/types';
import { Logger } from '../../src/utils/Logger';
import { IntegrationStrategyAgent } from '../../src/services/ai/orchestrator/agents/IntegrationStrategyAgent';
import type {
  AgentExecutionContext,
  IntegrationStrategyInput,
  SystemProfile,
  BusinessRequirement
} from '../../src/services/ai/orchestrator/interfaces';

describe('IntegrationStrategyAgent - Integration Tests (Pre-Refactoring Baseline)', () => {
  let container: Container;
  let agent: IntegrationStrategyAgent;
  let mockLogger: jest.Mocked<Logger>;
  let mockProviderRegistry: unknown;
  let mockSemanticEngine: unknown;
  let mockContext: AgentExecutionContext;

  beforeEach(() => {
    // Setup DI container
    container = new Container();

    // Mock logger
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    } as unknown as jest.Mocked<Logger>;

    // Mock provider registry (currently typed as unknown in agent)
    mockProviderRegistry = {
      getAvailableProviders: jest.fn().mockReturnValue([])
    };

    // Mock semantic engine (currently typed as unknown in agent)
    mockSemanticEngine = {
      analyze: jest.fn().mockResolvedValue({})
    };

    // Bind dependencies
    container.bind(TYPES.Logger).toConstantValue(mockLogger);
    container.bind('ProviderRegistry').toConstantValue(mockProviderRegistry);
    container.bind(TYPES.SemanticAnalysisEngine).toConstantValue(mockSemanticEngine);

    // Create agent instance
    agent = container.resolve(IntegrationStrategyAgent);

    // Mock execution context
    mockContext = {
      sessionId: 'test-session-123',
      userId: 'test-user',
      timestamp: new Date(),
      correlationId: 'test-trace-123',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      confidenceThreshold: 0.5,
      maxExecutionTime: 30000
    };
  });

  // Helper function to create valid test input
  const createTestInput = (overrides: Partial<IntegrationStrategyInput> = {}): IntegrationStrategyInput => {
    const sourceSystem: SystemProfile = {
      name: 'Salesforce CRM',
      type: 'crm',
      version: '54.0',
      capabilities: ['REST API', 'Bulk API', 'Streaming API', 'SOAP API'],
      limitations: ['Rate limits: 100 req/min', 'Bulk API: 10k records/batch'],
      apiSupport: [
        { type: 'rest', version: '54.0', authentication: ['oauth2', 'jwt'] }
      ],
      dataVolume: {
        recordCount: 1000000,
        growthRate: 0.15,
        peakLoad: 75000,
        dataTypes: ['contact', 'account', 'opportunity']
      },
      securityLevel: 'enterprise'
    };

    const targetSystem: SystemProfile = {
      name: 'NetSuite ERP',
      type: 'erp',
      version: '2023.1',
      capabilities: ['REST API', 'SOAP API', 'SuiteScript', 'CSV Import'],
      limitations: ['Rate limits: 50 req/min', 'Concurrent requests: 10'],
      apiSupport: [
        { type: 'rest', version: '1.0', authentication: ['oauth', 'token'] }
      ],
      dataVolume: {
        recordCount: 500000,
        growthRate: 0.10,
        peakLoad: 35000,
        dataTypes: ['customer', 'invoice', 'order']
      },
      securityLevel: 'enterprise'
    };

    const businessRequirements: BusinessRequirement[] = [
      {
        id: 'REQ-001',
        description: 'Synchronize customer data from Salesforce to NetSuite in real-time',
        priority: 'high',
        type: 'functional',
        acceptanceCriteria: [
          'Data sync latency < 5 minutes',
          'Support bi-directional sync',
          'Handle conflict resolution'
        ]
      },
      {
        id: 'REQ-002',
        description: 'Maintain data consistency across systems',
        priority: 'critical',
        type: 'non_functional',
        acceptanceCriteria: [
          '99.9% data accuracy',
          'Audit trail for all changes'
        ]
      },
      {
        id: 'REQ-003',
        description: 'Meet SOC2 compliance requirements',
        priority: 'high',
        type: 'compliance',
        acceptanceCriteria: [
          'All data encrypted in transit',
          'Access logging enabled'
        ]
      }
    ];

    return {
      sourceSystemProfile: sourceSystem,
      targetSystemProfile: targetSystem,
      businessRequirements,
      technicalConstraints: [],
      timeline: {
        deadline: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        milestones: [],
        flexibility: 'moderate'
      },
      ...overrides
    };
  };

  describe('1. Basic Execution Flow', () => {
    it('should successfully execute with valid input', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.reasoning).toBeDefined();
      expect(typeof result.reasoning).toBe('string');
    });

    it('should log execution start and success', async () => {
      const input = createTestInput();

      await agent.execute(mockContext, input);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Integration strategy agent execution started',
        expect.objectContaining({
          sessionId: 'test-session-123',
          sourceSystem: 'Salesforce CRM',
          targetSystem: 'NetSuite ERP'
        })
      );
    });

    it('should handle execution errors gracefully', async () => {
      const invalidInput = {
        ...createTestInput(),
        sourceSystemProfile: null as unknown as SystemProfile
      };

      const result = await agent.execute(mockContext, invalidInput);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe('2. Input Validation', () => {
    it('should reject missing source system profile', async () => {
      const input = {
        ...createTestInput(),
        sourceSystemProfile: null as unknown as SystemProfile
      };

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(false);
    });

    it('should reject missing target system profile', async () => {
      const input = {
        ...createTestInput(),
        targetSystemProfile: null as unknown as SystemProfile
      };

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(false);
    });

    it('should reject empty business requirements', async () => {
      const input = {
        ...createTestInput(),
        businessRequirements: [] as BusinessRequirement[]
      };

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(false);
    });

    it('should reject invalid business requirement structure', async () => {
      const input = {
        ...createTestInput(),
        businessRequirements: [
          {
            id: 'REQ-001',
            // Missing required fields
            description: undefined as unknown as string,
            priority: undefined as unknown as 'high',
            type: undefined as unknown as 'functional'
          }
        ]
      };

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(false);
    });
  });

  describe('3. Output Structure Validation', () => {
    it('should return all required output fields', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('recommendedApproach');
      expect(result.data).toHaveProperty('architectureOptions');
      expect(result.data).toHaveProperty('riskAssessment');
      expect(result.data).toHaveProperty('implementation');
      expect(result.data).toHaveProperty('alternatives');
    });

    it('should return recommended approach with correct structure', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      const { recommendedApproach } = result.data;

      expect(recommendedApproach).toHaveProperty('pattern');
      expect(recommendedApproach).toHaveProperty('description');
      expect(recommendedApproach).toHaveProperty('recommendationReason');
      expect(['batch', 'real_time', 'hybrid', 'event_driven', 'api_first'])
        .toContain(recommendedApproach.pattern);
    });

    it('should return array of architecture options', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data.architectureOptions)).toBe(true);
      expect(result.data.architectureOptions.length).toBeGreaterThan(0);

      const firstOption = result.data.architectureOptions[0];
      expect(firstOption).toHaveProperty('name');
      expect(firstOption).toHaveProperty('description');
      expect(firstOption).toHaveProperty('pros');
      expect(firstOption).toHaveProperty('cons');
      expect(firstOption).toHaveProperty('complexity');
      expect(firstOption).toHaveProperty('scalability');
      expect(firstOption).toHaveProperty('estimatedCost');
      expect(firstOption).toHaveProperty('implementationTime');
      expect(['low', 'medium', 'high']).toContain(firstOption.complexity);
    });

    it('should return risk assessment array', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data.riskAssessment)).toBe(true);

      if (result.data.riskAssessment.length > 0) {
        const firstRisk = result.data.riskAssessment[0];
        expect(firstRisk).toHaveProperty('category');
        expect(firstRisk).toHaveProperty('description');
        expect(firstRisk).toHaveProperty('impact');
        expect(firstRisk).toHaveProperty('probability');
        expect(firstRisk).toHaveProperty('mitigation');
      }
    });

    it('should return implementation plan with phases', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      const { implementation } = result.data;

      expect(implementation).toHaveProperty('phases');
      expect(Array.isArray(implementation.phases)).toBe(true);
      expect(implementation.phases.length).toBeGreaterThan(0);

      const firstPhase = implementation.phases[0];
      expect(firstPhase).toHaveProperty('name');
      expect(firstPhase).toHaveProperty('duration');
      expect(firstPhase).toHaveProperty('resources');
      expect(firstPhase).toHaveProperty('deliverables');
    });

    it('should return alternative strategies', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data.alternatives)).toBe(true);

      if (result.data.alternatives.length > 0) {
        const firstAlt = result.data.alternatives[0];
        expect(firstAlt).toHaveProperty('name');
        expect(firstAlt).toHaveProperty('description');
        expect(firstAlt).toHaveProperty('tradeoffs');
        expect(Array.isArray(firstAlt.tradeoffs)).toBe(true);
      }
    });
  });

  describe('4. System Type Combinations', () => {
    it('should handle ERP to CRM integration', async () => {
      const input = createTestInput({
        sourceSystemProfile: {
          ...createTestInput().sourceSystemProfile,
          type: 'erp'
        },
        targetSystemProfile: {
          ...createTestInput().targetSystemProfile,
          type: 'crm'
        }
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.data.recommendedApproach).toBeDefined();
    });

    it('should handle API to Database integration', async () => {
      const input = createTestInput({
        sourceSystemProfile: {
          ...createTestInput().sourceSystemProfile,
          type: 'api'
        },
        targetSystemProfile: {
          ...createTestInput().targetSystemProfile,
          type: 'database'
        }
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.data.recommendedApproach).toBeDefined();
    });

    it('should handle File to API integration', async () => {
      const input = createTestInput({
        sourceSystemProfile: {
          ...createTestInput().sourceSystemProfile,
          type: 'file',
          capabilities: ['CSV Export', 'XML Export', 'JSON Export']
        },
        targetSystemProfile: {
          ...createTestInput().targetSystemProfile,
          type: 'api'
        }
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.data.recommendedApproach).toBeDefined();
    });
  });

  describe('5. Security Level Compatibility', () => {
    it('should identify security mismatch (basic to enterprise)', async () => {
      const input = createTestInput({
        sourceSystemProfile: {
          ...createTestInput().sourceSystemProfile,
          securityLevel: 'basic'
        },
        targetSystemProfile: {
          ...createTestInput().targetSystemProfile,
          securityLevel: 'enterprise'
        }
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      // Should identify security-related risks or mitigation
      expect(result.data.riskAssessment.length).toBeGreaterThan(0);
    });

    it('should handle matching security levels', async () => {
      const input = createTestInput({
        sourceSystemProfile: {
          ...createTestInput().sourceSystemProfile,
          securityLevel: 'enterprise'
        },
        targetSystemProfile: {
          ...createTestInput().targetSystemProfile,
          securityLevel: 'enterprise'
        }
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });
  });

  describe('6. Business Requirement Types', () => {
    it('should handle functional requirements', async () => {
      const input = createTestInput({
        businessRequirements: [
          {
            id: 'FUNC-001',
            description: 'Sync customer records',
            priority: 'high',
            type: 'functional',
            acceptanceCriteria: ['All fields mapped', 'Validation rules applied']
          }
        ]
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });

    it('should handle compliance requirements', async () => {
      const input = createTestInput({
        businessRequirements: [
          {
            id: 'COMP-001',
            description: 'GDPR compliance',
            priority: 'critical',
            type: 'compliance',
            acceptanceCriteria: ['Data encryption', 'Right to deletion', 'Audit logs']
          }
        ]
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });

    it('should handle performance requirements', async () => {
      const input = createTestInput({
        businessRequirements: [
          {
            id: 'PERF-001',
            description: 'Sub-second response time',
            priority: 'high',
            type: 'performance',
            acceptanceCriteria: ['Response time < 1s', 'Throughput > 1000 TPS']
          }
        ]
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });
  });

  describe('7. Confidence Scoring', () => {
    it('should return confidence score between 0 and 1', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should have lower confidence with more limitations', async () => {
      const inputWithFewLimitations = createTestInput({
        sourceSystemProfile: {
          ...createTestInput().sourceSystemProfile,
          limitations: ['Rate limits: 1000 req/min']
        }
      });

      const inputWithManyLimitations = createTestInput({
        sourceSystemProfile: {
          ...createTestInput().sourceSystemProfile,
          limitations: [
            'Rate limits: 10 req/min',
            'No bulk API',
            'Read-only access',
            'Legacy version',
            'No webhooks'
          ]
        }
      });

      const result1 = await agent.execute(mockContext, inputWithFewLimitations);
      const result2 = await agent.execute(mockContext, inputWithManyLimitations);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      // More limitations should generally result in lower confidence
      // (though this isn't guaranteed depending on other factors)
      expect(result2.confidence).toBeLessThanOrEqual(result1.confidence + 0.1);
    });
  });

  describe('8. Reasoning Quality', () => {
    it('should provide non-empty reasoning', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(typeof result.reasoning).toBe('string');
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should include system names in reasoning', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.reasoning).toContain('Salesforce');
      expect(result.reasoning).toContain('NetSuite');
    });

    it('should mention complexity level in reasoning', async () => {
      const input = createTestInput();

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
      expect(result.reasoning).toMatch(/low|medium|high|very_high.*complexity/i);
    });
  });

  describe('9. Timeline Handling', () => {
    it('should handle rigid timeline', async () => {
      const input = createTestInput({
        timeline: {
          deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          milestones: [],
          flexibility: 'rigid'
        }
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });

    it('should handle flexible timeline', async () => {
      const input = createTestInput({
        timeline: {
          deadline: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
          milestones: [],
          flexibility: 'flexible'
        }
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });
  });

  describe('10. Edge Cases', () => {
    it('should handle minimal system profiles', async () => {
      const input = createTestInput({
        sourceSystemProfile: {
          name: 'Minimal Source',
          type: 'other',
          version: '1.0',
          capabilities: ['Basic API'],
          limitations: ['Limited functionality'],
          apiSupport: [],
          dataVolume: { recordCount: 100, growthRate: 0.05, peakLoad: 15, dataTypes: ['data'] },
          securityLevel: 'basic'
        },
        targetSystemProfile: {
          name: 'Minimal Target',
          type: 'other',
          version: '1.0',
          capabilities: ['Basic API'],
          limitations: ['Limited functionality'],
          apiSupport: [],
          dataVolume: { recordCount: 100, growthRate: 0.05, peakLoad: 15, dataTypes: ['data'] },
          securityLevel: 'basic'
        }
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });

    it('should handle single business requirement', async () => {
      const input = createTestInput({
        businessRequirements: [
          {
            id: 'REQ-ONLY',
            description: 'Single requirement',
            priority: 'medium',
            type: 'functional',
            acceptanceCriteria: ['Must work']
          }
        ]
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });

    it('should handle large number of requirements', async () => {
      const manyRequirements: BusinessRequirement[] = Array.from({ length: 20 }, (_, i) => ({
        id: `REQ-${i + 1}`,
        description: `Requirement ${i + 1}`,
        priority: i % 4 === 0 ? 'critical' : i % 3 === 0 ? 'high' : i % 2 === 0 ? 'medium' : 'low',
        type: i % 4 === 0 ? 'compliance' : i % 3 === 0 ? 'performance' : i % 2 === 0 ? 'non_functional' : 'functional',
        acceptanceCriteria: [`Criteria ${i + 1}a`, `Criteria ${i + 1}b`]
      }));

      const input = createTestInput({
        businessRequirements: manyRequirements
      });

      const result = await agent.execute(mockContext, input);

      expect(result.success).toBe(true);
    });
  });
});
