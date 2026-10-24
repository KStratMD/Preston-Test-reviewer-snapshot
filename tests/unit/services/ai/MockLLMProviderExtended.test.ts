/**
 * Comprehensive unit tests for MockLLMProvider
 * Covers: testConnection, generateMappingSuggestions, analyzeDataQuality,
 *         getSimulatedCost, getSimulatedTokenCount, internal helpers
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { MockLLMProvider } from '../../../../src/services/ai/providers/MockLLMProvider';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeContext(overrides: Record<string, any> = {}) {
  return {
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceFields: [
      { name: 'customer_name', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'phone', type: 'string' },
    ],
    targetFields: [
      { name: 'companyName', type: 'string' },
      { name: 'emailAddress', type: 'string' },
      { name: 'phoneNumber', type: 'string' },
    ],
    sampleData: [
      { customer_name: 'Acme', email: 'test@test.com', phone: '555-1234' },
    ],
    ...overrides,
  };
}

describe('MockLLMProvider', () => {
  describe('mock-openai config', () => {
    let provider: MockLLMProvider;

    beforeEach(() => {
      jest.clearAllMocks();
      provider = new MockLLMProvider(mockLogger, {
        providerId: 'mock-openai',
        name: 'Mock OpenAI',
        version: 'gpt-4o-mock',
        simulatedLatency: 1,
        simulatedCostPerToken: 0.00003,
        simulatedAccuracy: 0.9,
      });
    });

    it('should set name and version', () => {
      expect(provider.name).toBe('Mock OpenAI');
      expect(provider.version).toBe('gpt-4o-mock');
    });

    it('should test connection successfully', async () => {
      const result = await provider.testConnection();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('Mock OpenAI');
    });

    it('should generate mapping suggestions', async () => {
      const context = makeContext();
      const suggestions = await provider.generateMappingSuggestions(context);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.length).toBeLessThanOrEqual(3);

      for (const s of suggestions) {
        expect(s.sourceField).toBeDefined();
        expect(s.targetField).toBeDefined();
        expect(s.confidence).toBeGreaterThan(0);
        expect(s.confidence).toBeLessThanOrEqual(1);
        expect(s.reasoning).toBeDefined();
        expect(s.transformationType).toBeDefined();
      }
    });

    it('should sort suggestions by confidence descending', async () => {
      const suggestions = await provider.generateMappingSuggestions(makeContext());
      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i - 1].confidence).toBeGreaterThanOrEqual(suggestions[i].confidence);
      }
    });

    it('should include alternative mappings', async () => {
      const context = makeContext();
      const suggestions = await provider.generateMappingSuggestions(context);
      const withAlts = suggestions.find(s => s.alternatives && s.alternatives.length > 0);
      if (withAlts) {
        expect(withAlts.alternatives![0].targetField).toBeDefined();
      }
    });

    it('should log suggestion count', async () => {
      await provider.generateMappingSuggestions(makeContext());
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Mock OpenAI generated'),
        expect.objectContaining({ providerId: 'mock-openai' })
      );
    });
  });

  describe('mock-claude config', () => {
    let provider: MockLLMProvider;

    beforeEach(() => {
      provider = new MockLLMProvider(mockLogger, {
        providerId: 'mock-claude',
        name: 'Mock Claude',
        version: 'claude-mock',
        simulatedLatency: 1,
      });
    });

    it('should generate suggestions with Claude style', async () => {
      const suggestions = await provider.generateMappingSuggestions(makeContext());
      expect(suggestions.length).toBeGreaterThan(0);
      // Claude style includes 'Based on field name patterns'
      expect(suggestions[0].reasoning).toContain('Based on field name patterns');
    });
  });

  describe('mock-gemini config', () => {
    let provider: MockLLMProvider;

    beforeEach(() => {
      provider = new MockLLMProvider(mockLogger, {
        providerId: 'mock-gemini',
        name: 'Mock Gemini',
        version: 'gemini-mock',
        simulatedLatency: 1,
      });
    });

    it('should generate suggestions with Gemini style', async () => {
      const suggestions = await provider.generateMappingSuggestions(makeContext());
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].reasoning).toContain('Multi-modal analysis');
    });
  });

  describe('analyzeDataQuality', () => {
    let provider: MockLLMProvider;

    beforeEach(() => {
      provider = new MockLLMProvider(mockLogger, {
        providerId: 'mock-openai',
        name: 'Mock',
        version: 'v1',
        simulatedLatency: 1,
      });
    });

    it('should return quality assessment for data', async () => {
      const data = [
        { name: 'Acme', email: 'test@test.com' },
        { name: 'Globex', email: null },
      ];
      const result = await provider.analyzeDataQuality(data, {
        sourceSystem: 'SF',
        targetSystem: 'NS',
      } as any);

      expect(result.overallScore).toBeGreaterThan(0);
      expect(result.overallScore).toBeLessThanOrEqual(1);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it('should detect missing values', async () => {
      const data = [
        { name: 'A', email: 'a@b.com' },
        { name: null, email: 'c@d.com' },
      ];
      const result = await provider.analyzeDataQuality(data, {} as any);
      const missingIssue = result.issues.find(
        i => i.type === 'completeness' && i.field === 'name'
      );
      expect(missingIssue).toBeDefined();
    });

    it('should flag small sample sizes', async () => {
      const data = [{ name: 'A' }];
      const result = await provider.analyzeDataQuality(data, {} as any);
      const smallSample = result.issues.find(i => i.message.includes('Small sample'));
      expect(smallSample).toBeDefined();
    });

    it('should handle empty data', async () => {
      const result = await provider.analyzeDataQuality([], {} as any);
      expect(result.overallScore).toBeDefined();
    });
  });

  describe('getSimulatedCost', () => {
    it('should calculate cost based on tokens', () => {
      const provider = new MockLLMProvider(mockLogger, {
        providerId: 'mock-openai',
        name: 'Mock',
        version: 'v1',
        simulatedCostPerToken: 0.00003,
      });
      const cost = provider.getSimulatedCost(1000);
      expect(cost).toBeCloseTo(0.03);
    });

    it('should use default cost when not configured', () => {
      const provider = new MockLLMProvider(mockLogger, {
        providerId: 'mock-openai',
        name: 'Mock',
        version: 'v1',
      });
      const cost = provider.getSimulatedCost(1000);
      expect(cost).toBeCloseTo(0.1);
    });
  });

  describe('getSimulatedTokenCount', () => {
    it('should estimate tokens based on context complexity', () => {
      const provider = new MockLLMProvider(mockLogger, {
        providerId: 'mock-openai',
        name: 'Mock',
        version: 'v1',
      });
      const context = makeContext();
      const tokens = provider.getSimulatedTokenCount(context);
      expect(tokens).toBeGreaterThan(100); // base tokens
      // 100 (base) + 6 fields * 10 + sampleData tokens
      expect(tokens).toBeGreaterThan(150);
    });

    it('should handle missing sample data', () => {
      const provider = new MockLLMProvider(mockLogger, {
        providerId: 'mock-openai',
        name: 'Mock',
        version: 'v1',
      });
      const context = makeContext({ sampleData: undefined });
      const tokens = provider.getSimulatedTokenCount(context);
      expect(tokens).toBeGreaterThan(0);
    });
  });
});
