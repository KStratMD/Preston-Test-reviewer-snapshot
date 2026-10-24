/**
 * Comprehensive unit tests for ConsensusValidator
 * Covers: getConsensusSuggestions, findDisagreements, getHighConfidenceMappings,
 *         buildConsensusReasoning, confidence boost, filtering
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

import { ConsensusValidator } from '../../../../src/services/ai/validation/ConsensusValidator';

function makeSuggestion(overrides: Record<string, any> = {}) {
  return {
    sourceField: 'CustomerName',
    targetField: 'companyname',
    transformationType: 'direct',
    confidence: 85,
    reasoning: 'Name field maps directly',
    ...overrides,
  };
}

function makeProvider(name: string, suggestions: any[]) {
  return {
    name,
    suggest: jest.fn().mockResolvedValue(suggestions),
  } as any;
}

describe('ConsensusValidator', () => {
  let validator: ConsensusValidator;

  beforeEach(() => {
    jest.clearAllMocks();
    validator = new ConsensusValidator();
  });

  describe('constructor', () => {
    it('should set default config', () => {
      const v = new ConsensusValidator();
      expect(v).toBeDefined();
    });

    it('should accept custom config', () => {
      const v = new ConsensusValidator({
        minProviderCount: 3,
        minAgreementScore: 75,
        boostConfidenceOnAgreement: false,
      });
      expect(v).toBeDefined();
    });
  });

  describe('getConsensusSuggestions', () => {
    it('should return empty for fewer than 2 providers', async () => {
      const result = await validator.getConsensusSuggestions(
        [makeProvider('p1', [makeSuggestion()])],
        'Salesforce', 'NetSuite', []
      );
      expect(result).toEqual([]);
    });

    it('should find consensus when providers agree', async () => {
      const suggestion = makeSuggestion();
      const p1 = makeProvider('OpenAI', [suggestion]);
      const p2 = makeProvider('Claude', [{ ...suggestion, confidence: 90 }]);

      const results = await validator.getConsensusSuggestions(
        [p1, p2], 'Salesforce', 'NetSuite', []
      );

      expect(results.length).toBe(1);
      expect(results[0].providerCount).toBe(2);
      expect(results[0].agreementScore).toBe(100);
      expect(results[0].providers).toContain('OpenAI');
      expect(results[0].providers).toContain('Claude');
    });

    it('should boost confidence when providers agree', async () => {
      const suggestion = makeSuggestion({ confidence: 80 });
      const p1 = makeProvider('OpenAI', [suggestion]);
      const p2 = makeProvider('Claude', [suggestion]);

      const results = await validator.getConsensusSuggestions(
        [p1, p2], 'Salesforce', 'NetSuite', []
      );

      // 2 providers agree: boost = (2-1)*5 = 5, so 80+5=85
      expect(results[0].suggestion.confidence).toBe(85);
    });

    it('should cap confidence boost at 100', async () => {
      const suggestion = makeSuggestion({ confidence: 98 });
      const p1 = makeProvider('P1', [suggestion]);
      const p2 = makeProvider('P2', [suggestion]);
      const p3 = makeProvider('P3', [suggestion]);
      const p4 = makeProvider('P4', [suggestion]);

      const results = await validator.getConsensusSuggestions(
        [p1, p2, p3, p4], 'Salesforce', 'NetSuite', []
      );

      expect(results[0].suggestion.confidence).toBeLessThanOrEqual(100);
    });

    it('should not boost confidence when disabled', async () => {
      const v = new ConsensusValidator({ boostConfidenceOnAgreement: false });
      const suggestion = makeSuggestion({ confidence: 80 });
      const p1 = makeProvider('OpenAI', [suggestion]);
      const p2 = makeProvider('Claude', [suggestion]);

      const results = await v.getConsensusSuggestions(
        [p1, p2], 'Salesforce', 'NetSuite', []
      );

      expect(results[0].suggestion.confidence).toBe(80);
    });

    it('should track alternative mappings', async () => {
      const p1 = makeProvider('OpenAI', [
        makeSuggestion({ sourceField: 'Name', targetField: 'companyname' }),
      ]);
      const p2 = makeProvider('Claude', [
        makeSuggestion({ sourceField: 'Name', targetField: 'entityname' }),
      ]);

      const results = await validator.getConsensusSuggestions(
        [p1, p2], 'Salesforce', 'NetSuite', []
      );

      // Both should appear since they meet 50% agreement (1/2 = 50%)
      expect(results.length).toBe(2);
      // Each should have the other as alternative
      const companyResult = results.find(r => r.suggestion.targetField === 'companyname');
      expect(companyResult!.alternativeMappings.length).toBe(1);
    });

    it('should handle provider failures gracefully', async () => {
      const p1 = makeProvider('OpenAI', [makeSuggestion()]);
      const p2 = {
        name: 'FailingProvider',
        suggest: jest.fn().mockRejectedValue(new Error('Connection failed')),
      } as any;
      const p3 = makeProvider('Claude', [makeSuggestion()]);

      const results = await validator.getConsensusSuggestions(
        [p1, p2, p3], 'Salesforce', 'NetSuite', []
      );

      // Two providers returned suggestions, both agree
      expect(results.length).toBe(1);
      expect(results[0].providerCount).toBe(2);
    });

    it('should sort by agreement score descending', async () => {
      const p1 = makeProvider('P1', [
        makeSuggestion({ sourceField: 'A', targetField: 'a' }),
        makeSuggestion({ sourceField: 'B', targetField: 'b' }),
      ]);
      const p2 = makeProvider('P2', [
        makeSuggestion({ sourceField: 'A', targetField: 'a' }),
      ]);

      const results = await validator.getConsensusSuggestions(
        [p1, p2], 'Salesforce', 'NetSuite', []
      );

      // A->a has 100% agreement (2/2), B->b has 50% (1/2)
      if (results.length >= 2) {
        expect(results[0].agreementScore).toBeGreaterThanOrEqual(results[1].agreementScore);
      }
    });

    it('should build consensus reasoning', async () => {
      const suggestion = makeSuggestion({ reasoning: 'Direct name match' });
      const p1 = makeProvider('OpenAI', [suggestion]);
      const p2 = makeProvider('Claude', [suggestion]);

      const results = await validator.getConsensusSuggestions(
        [p1, p2], 'Salesforce', 'NetSuite', []
      );

      expect(results[0].suggestion.reasoning).toContain('[Consensus:');
      expect(results[0].suggestion.reasoning).toContain('2/2 providers agree');
      expect(results[0].suggestion.reasoning).toContain('Direct name match');
    });

    it('should handle all providers returning empty', async () => {
      const p1 = makeProvider('P1', []);
      const p2 = makeProvider('P2', []);

      const results = await validator.getConsensusSuggestions(
        [p1, p2], 'Salesforce', 'NetSuite', []
      );

      expect(results).toEqual([]);
    });

    it('should pick highest confidence suggestion per mapping', async () => {
      const p1 = makeProvider('P1', [makeSuggestion({ confidence: 70 })]);
      const p2 = makeProvider('P2', [makeSuggestion({ confidence: 95 })]);

      const results = await validator.getConsensusSuggestions(
        [p1, p2], 'Salesforce', 'NetSuite', []
      );

      // Should pick confidence 95 as the best, then boost by 5 = 100
      expect(results[0].suggestion.confidence).toBe(100);
    });
  });

  describe('findDisagreements', () => {
    it('should find low-agreement results', () => {
      const results = [
        { suggestion: makeSuggestion(), providerCount: 1, agreementScore: 50, providers: ['P1'], alternativeMappings: [] },
        { suggestion: makeSuggestion(), providerCount: 2, agreementScore: 100, providers: ['P1', 'P2'], alternativeMappings: [] },
      ];

      const disagreements = validator.findDisagreements(results);
      expect(disagreements.length).toBe(1);
      expect(disagreements[0].agreementScore).toBe(50);
    });

    it('should find results with alternatives', () => {
      const results = [
        {
          suggestion: makeSuggestion(),
          providerCount: 2,
          agreementScore: 100,
          providers: ['P1', 'P2'],
          alternativeMappings: [makeSuggestion({ targetField: 'other' })],
        },
      ];

      const disagreements = validator.findDisagreements(results);
      expect(disagreements.length).toBe(1);
    });

    it('should return empty when all agree without alternatives', () => {
      const results = [
        { suggestion: makeSuggestion(), providerCount: 3, agreementScore: 100, providers: ['P1', 'P2', 'P3'], alternativeMappings: [] },
      ];

      const disagreements = validator.findDisagreements(results);
      expect(disagreements.length).toBe(0);
    });
  });

  describe('getHighConfidenceMappings', () => {
    it('should return only 90%+ agreement results', () => {
      const results = [
        { suggestion: makeSuggestion(), providerCount: 3, agreementScore: 100, providers: ['P1', 'P2', 'P3'], alternativeMappings: [] },
        { suggestion: makeSuggestion(), providerCount: 1, agreementScore: 50, providers: ['P1'], alternativeMappings: [] },
        { suggestion: makeSuggestion(), providerCount: 2, agreementScore: 90, providers: ['P1', 'P2'], alternativeMappings: [] },
      ];

      const highConf = validator.getHighConfidenceMappings(results);
      expect(highConf.length).toBe(2);
      expect(highConf.every(r => r.agreementScore >= 90)).toBe(true);
    });

    it('should return empty when no high agreement', () => {
      const results = [
        { suggestion: makeSuggestion(), providerCount: 1, agreementScore: 50, providers: ['P1'], alternativeMappings: [] },
      ];

      const highConf = validator.getHighConfidenceMappings(results);
      expect(highConf.length).toBe(0);
    });
  });
});
