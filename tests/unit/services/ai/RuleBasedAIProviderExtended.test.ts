/**
 * Comprehensive unit tests for RuleBasedAIProvider
 * Covers: analyzeSemanticSimilarity, findSemanticMatches, analyzeFieldPattern,
 *         classifyDataType, analyzeFieldDescription, generateMappingExplanation
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { RuleBasedAIProvider } from '../../../../src/services/ai/providers/RuleBasedAIProvider';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('RuleBasedAIProvider', () => {
  let provider: RuleBasedAIProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new RuleBasedAIProvider(mockLogger);
  });

  describe('properties', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('Rule-Based AI Provider');
    });

    it('should have correct version', () => {
      expect(provider.version).toBe('1.0.0');
    });

    it('should have rule-based type', () => {
      expect(provider.type).toBe('rule-based');
    });

    it('should be available', () => {
      expect(provider.isAvailable).toBe(true);
    });
  });

  describe('analyzeSemanticSimilarity', () => {
    it('should detect exact match', async () => {
      const result = await provider.analyzeSemanticSimilarity('email', 'email');
      expect(result.similarity).toBe(0.95);
      expect(result.confidence).toBe(0.98);
      expect(result.matchType).toBe('exact');
    });

    it('should detect exact match case-insensitive', async () => {
      const result = await provider.analyzeSemanticSimilarity('Email', 'email');
      expect(result.matchType).toBe('exact');
    });

    it('should detect exact match with separators normalized', async () => {
      const result = await provider.analyzeSemanticSimilarity('customer_name', 'customername');
      expect(result.matchType).toBe('exact');
    });

    it('should detect partial match (source contains target)', async () => {
      const result = await provider.analyzeSemanticSimilarity('customer_email_address', 'email');
      expect(result.matchType).toBe('partial');
      expect(result.confidence).toBe(0.85);
    });

    it('should detect partial match (target contains source)', async () => {
      const result = await provider.analyzeSemanticSimilarity('name', 'companyname');
      expect(result.matchType).toBe('partial');
    });

    it('should detect synonym match', async () => {
      const result = await provider.analyzeSemanticSimilarity('customer', 'client');
      expect(result.matchType).toBe('synonym');
      expect(result.similarity).toBe(0.85);
    });

    it('should detect partial match for phone/telephone', async () => {
      // 'telephone' contains 'phone', so partial match takes priority over synonym
      const result = await provider.analyzeSemanticSimilarity('phone', 'telephone');
      expect(result.matchType).toBe('partial');
    });

    it('should detect contextual match for NetSuite', async () => {
      // Use 'organization' → 'companyname' to avoid partial-match shortcut
      const result = await provider.analyzeSemanticSimilarity(
        'organization', 'companyname',
        { sourceSystem: 'Salesforce', targetSystem: 'NetSuite' },
      );
      expect(result.matchType).toBe('contextual');
      expect(result.similarity).toBe(0.9);
    });

    it('should return low similarity for no match', async () => {
      const result = await provider.analyzeSemanticSimilarity('sku', 'revenue');
      expect(result.similarity).toBe(0.1);
      expect(result.matchType).toBe('semantic');
    });

    it('should not use contextual match without context', async () => {
      const result = await provider.analyzeSemanticSimilarity('xyz', 'abc');
      expect(result.matchType).toBe('semantic');
    });
  });

  describe('findSemanticMatches', () => {
    it('should find matching candidates', async () => {
      const matches = await provider.findSemanticMatches(
        'email',
        ['emailaddress', 'phone', 'name'],
      );
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].field).toBe('emailaddress');
    });

    it('should sort by similarity descending', async () => {
      const matches = await provider.findSemanticMatches(
        'customer_name',
        ['companyname', 'customername', 'sku'],
      );
      for (let i = 1; i < matches.length; i++) {
        expect(matches[i - 1].similarity).toBeGreaterThanOrEqual(matches[i].similarity);
      }
    });

    it('should filter out low similarity matches', async () => {
      const matches = await provider.findSemanticMatches(
        'sku',
        ['totallyunrelatedfield'],
      );
      expect(matches).toHaveLength(0);
    });

    it('should include context in matching', async () => {
      const matches = await provider.findSemanticMatches(
        'company',
        ['companyname', 'phone'],
        { sourceSystem: 'Salesforce', targetSystem: 'NetSuite' },
      );
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  describe('analyzeFieldPattern', () => {
    it('should detect email pattern', async () => {
      const result = await provider.analyzeFieldPattern('email', [
        'test@test.com', 'user@example.org', 'admin@site.co',
      ]);
      expect(result.pattern).toBe('email');
      expect(result.confidence).toBeGreaterThan(0.7);
    });

    it('should detect boolean pattern', async () => {
      const result = await provider.analyzeFieldPattern('active', [
        'true', 'false', 'true', 'false',
      ]);
      expect(result.pattern).toBe('boolean');
    });

    it('should detect currency pattern', async () => {
      const result = await provider.analyzeFieldPattern('price', [
        '$100.00', '$55.99', '$0.50',
      ]);
      expect(result.pattern).toBe('currency');
    });

    it('should return unknown for all null/empty values', async () => {
      const result = await provider.analyzeFieldPattern('empty', [null, '', undefined]);
      expect(result.pattern).toBe('unknown');
      expect(result.confidence).toBe(0.1);
      expect(result.statistics.nullValues).toBe(3);
    });

    it('should default to string for mixed data', async () => {
      const result = await provider.analyzeFieldPattern('mixed', [
        'hello', 'world', 'foo', 'bar',
      ]);
      expect(result.pattern).toBe('string');
    });

    it('should include statistics', async () => {
      const result = await provider.analyzeFieldPattern('field', [
        'a', 'b', null, 'c',
      ]);
      expect(result.statistics.totalSamples).toBe(4);
      expect(result.statistics.nullValues).toBe(1);
      expect(result.statistics.uniqueValues).toBe(3);
    });

    it('should limit examples to 5', async () => {
      const values = Array.from({ length: 10 }, (_, i) => `val${i}@test.com`);
      const result = await provider.analyzeFieldPattern('emails', values);
      expect(result.examples.length).toBeLessThanOrEqual(5);
    });
  });

  describe('classifyDataType', () => {
    it('should detect number type in scores', async () => {
      // string always has score 1.0, so ties go to string as primaryType
      // but number should appear in alternatives or have a high score
      const result = await provider.classifyDataType(['42', '100', '3.14']);
      const numberAlt = result.alternativeTypes.find(t => t.type === 'number');
      // number score should be 1.0 (all values are numbers)
      expect(numberAlt?.confidence || (result.primaryType === 'number' ? 1 : 0)).toBe(1);
    });

    it('should detect boolean type in scores', async () => {
      const result = await provider.classifyDataType(['true', 'false', 'yes', 'no']);
      const boolAlt = result.alternativeTypes.find(t => t.type === 'boolean');
      expect(boolAlt?.confidence || (result.primaryType === 'boolean' ? 1 : 0)).toBe(1);
    });

    it('should detect email type in scores', async () => {
      const result = await provider.classifyDataType(['a@b.com', 'c@d.org']);
      const emailAlt = result.alternativeTypes.find(t => t.type === 'email');
      expect(emailAlt?.confidence || (result.primaryType === 'email' ? 1 : 0)).toBe(1);
    });

    it('should default to string for empty values', async () => {
      const result = await provider.classifyDataType([null, undefined, '']);
      expect(result.primaryType).toBe('string');
      expect(result.confidence).toBe(0.1);
    });

    it('should include alternative types', async () => {
      const result = await provider.classifyDataType(['42', '100']);
      expect(result.alternativeTypes.length).toBeGreaterThan(0);
    });

    it('should sort alternatives by confidence', async () => {
      const result = await provider.classifyDataType(['test@test.com', 'hello']);
      for (let i = 1; i < result.alternativeTypes.length; i++) {
        expect(result.alternativeTypes[i - 1].confidence)
          .toBeGreaterThanOrEqual(result.alternativeTypes[i].confidence);
      }
    });
  });

  describe('analyzeFieldDescription', () => {
    it('should detect identification intent', async () => {
      const result = await provider.analyzeFieldDescription('Unique identifier for the record');
      expect(result.intent).toBe('identification');
    });

    it('should detect communication intent', async () => {
      const result = await provider.analyzeFieldDescription('Contact email for communication');
      expect(result.intent).toBe('communication');
    });

    it('should detect financial intent', async () => {
      const result = await provider.analyzeFieldDescription('Total amount for the order');
      expect(result.intent).toBe('financial');
    });

    it('should return unknown for generic description', async () => {
      const result = await provider.analyzeFieldDescription('Some field data');
      expect(result.intent).toBe('unknown');
    });

    it('should extract keywords', async () => {
      const result = await provider.analyzeFieldDescription('Customer revenue from invoice');
      expect(result.keywords).toContain('customer');
      expect(result.keywords).toContain('revenue');
      expect(result.keywords).toContain('invoice');
    });

    it('should filter stop words', async () => {
      const result = await provider.analyzeFieldDescription('the name of the customer');
      expect(result.keywords).not.toContain('the');
    });

    it('should filter short words', async () => {
      const result = await provider.analyzeFieldDescription('id is ok at');
      // Short words (<=3 chars) should be excluded
      expect(result.keywords).toEqual([]);
    });

    it('should identify business terms', async () => {
      const result = await provider.analyzeFieldDescription('Customer account revenue');
      expect(result.businessContext).toContain('customer');
      expect(result.businessContext).toContain('account');
      expect(result.businessContext).toContain('revenue');
    });

    it('should identify technical terms', async () => {
      const result = await provider.analyzeFieldDescription('API database integration mapping');
      expect(result.technicalTerms).toContain('database');
      expect(result.technicalTerms).toContain('integration');
      expect(result.technicalTerms).toContain('mapping');
    });

    it('should return neutral sentiment', async () => {
      const result = await provider.analyzeFieldDescription('Some description');
      expect(result.sentiment).toBe('neutral');
    });

    it('should have high confidence with keywords', async () => {
      const result = await provider.analyzeFieldDescription('Customer account number');
      expect(result.confidence).toBe(0.7);
    });

    it('should have low confidence without keywords', async () => {
      const result = await provider.analyzeFieldDescription('ok');
      expect(result.confidence).toBe(0.3);
    });
  });

  describe('generateMappingExplanation', () => {
    it('should return high confidence explanation', async () => {
      const result = await provider.generateMappingExplanation('email', 'email', 0.95);
      expect(result).toContain('High confidence');
      expect(result).toContain('email');
    });

    it('should return good mapping explanation', async () => {
      const result = await provider.generateMappingExplanation('name', 'companyName', 0.8);
      expect(result).toContain('Good mapping');
    });

    it('should return moderate mapping explanation', async () => {
      const result = await provider.generateMappingExplanation('src', 'tgt', 0.6);
      expect(result).toContain('Moderate mapping');
    });

    it('should return low confidence explanation', async () => {
      const result = await provider.generateMappingExplanation('x', 'y', 0.3);
      expect(result).toContain('Low confidence');
      expect(result).toContain('manual review');
    });
  });
});
