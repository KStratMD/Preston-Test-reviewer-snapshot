/**
 * Data Normalization Utility Unit Tests
 * Tests for data normalization, comparison, and fuzzy matching functions
 */

import {
  levenshteinDistance,
  fuzzyCompare,
  normalizePhone,
  comparePhones,
  normalizeEmail,
  compareEmails,
  normalizeAddress,
  compareAddresses,
  normalizeCompanyName,
  compareCompanyNames,
  detectDataPattern,
  getNestedValue,
  scoreToConfidence,
} from '../../../src/utils/DataNormalization';

describe('DataNormalization', () => {
  describe('levenshteinDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshteinDistance('hello', 'hello')).toBe(0);
    });

    it('should return correct distance for single char difference', () => {
      expect(levenshteinDistance('hello', 'hallo')).toBe(1);
    });

    it('should return correct distance for insertions', () => {
      expect(levenshteinDistance('helo', 'hello')).toBe(1);
    });

    it('should return correct distance for deletions', () => {
      expect(levenshteinDistance('hello', 'helo')).toBe(1);
    });

    it('should handle empty strings', () => {
      expect(levenshteinDistance('', 'hello')).toBe(5);
      expect(levenshteinDistance('hello', '')).toBe(5);
      expect(levenshteinDistance('', '')).toBe(0);
    });

    it('should return length for completely different strings', () => {
      expect(levenshteinDistance('abc', 'xyz')).toBe(3);
    });
  });

  describe('fuzzyCompare', () => {
    it('should return 1 for identical strings', () => {
      expect(fuzzyCompare('hello', 'hello')).toBe(1);
    });

    it('should return 1 for case-different strings', () => {
      expect(fuzzyCompare('Hello', 'HELLO')).toBe(1);
    });

    it('should return 1 for strings with whitespace differences', () => {
      expect(fuzzyCompare('  hello  ', 'hello')).toBe(1);
    });

    it('should return high score for similar strings', () => {
      const score = fuzzyCompare('hello', 'hallo');
      expect(score).toBeGreaterThan(0.7);
    });

    it('should return 1 for two empty strings', () => {
      expect(fuzzyCompare('', '')).toBe(1);
    });

    it('should handle null/undefined gracefully', () => {
      expect(fuzzyCompare(null as unknown as string, 'hello')).toBeLessThan(1);
      expect(fuzzyCompare('hello', undefined as unknown as string)).toBeLessThan(1);
    });
  });

  describe('normalizePhone', () => {
    it('should return empty string for null/undefined', () => {
      expect(normalizePhone(null)).toBe('');
      expect(normalizePhone(undefined)).toBe('');
    });

    it('should strip non-digit characters', () => {
      expect(normalizePhone('(555) 123-4567')).toBe('5551234567');
    });

    it('should remove leading 1 for 11-digit US numbers', () => {
      expect(normalizePhone('1-555-123-4567')).toBe('5551234567');
    });

    it('should preserve 10-digit numbers', () => {
      expect(normalizePhone('5551234567')).toBe('5551234567');
    });

    it('should handle international format', () => {
      expect(normalizePhone('+1 555 123 4567')).toBe('5551234567');
    });
  });

  describe('comparePhones', () => {
    it('should return 1 for identical phones', () => {
      expect(comparePhones('5551234567', '5551234567')).toBe(1);
    });

    it('should return 1 for both empty', () => {
      expect(comparePhones(null, null)).toBe(1);
    });

    it('should return 0 when one is empty', () => {
      expect(comparePhones('5551234567', null)).toBe(0);
      expect(comparePhones(null, '5551234567')).toBe(0);
    });

    it('should return 0.95 for matching last 10 digits', () => {
      // normalizePhone strips leading 1 from US numbers, so these become equal
      // Use international format that doesn't get stripped
      expect(comparePhones('445551234567', '5551234567')).toBe(0.95);
    });

    it('should return 0.8 for matching last 7 digits', () => {
      expect(comparePhones('5551234567', '1231234567')).toBe(0.8);
    });

    it('should return fuzzy match for different numbers', () => {
      const score = comparePhones('5551234567', '5559876543');
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(0.8);
    });
  });

  describe('normalizeEmail', () => {
    it('should return empty string for null/undefined', () => {
      expect(normalizeEmail(null)).toBe('');
      expect(normalizeEmail(undefined)).toBe('');
    });

    it('should lowercase and trim', () => {
      expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
    });

    it('should remove plus addressing when option is set', () => {
      expect(normalizeEmail('user+tag@example.com', { removePlusAddressing: true })).toBe('user@example.com');
    });

    it('should preserve plus addressing by default', () => {
      expect(normalizeEmail('user+tag@example.com')).toBe('user+tag@example.com');
    });
  });

  describe('compareEmails', () => {
    it('should return 1 for identical emails', () => {
      expect(compareEmails('user@example.com', 'user@example.com')).toBe(1);
    });

    it('should return 1 for case-different emails', () => {
      expect(compareEmails('User@Example.com', 'USER@EXAMPLE.COM')).toBe(1);
    });

    it('should return 1 for both empty', () => {
      expect(compareEmails(null, null)).toBe(1);
    });

    it('should return 0 when one is empty', () => {
      expect(compareEmails('user@example.com', null)).toBe(0);
    });

    it('should return high score for same domain, similar local', () => {
      const score = compareEmails('john.smith@example.com', 'johnsmith@example.com');
      expect(score).toBeGreaterThan(0.7);
    });

    it('should cap score at 80% for different domains', () => {
      const score = compareEmails('user@example.com', 'user@different.com');
      expect(score).toBeLessThanOrEqual(0.8);
    });
  });

  describe('normalizeAddress', () => {
    it('should return empty string for null/undefined', () => {
      expect(normalizeAddress(null)).toBe('');
      expect(normalizeAddress(undefined)).toBe('');
    });

    it('should lowercase and trim', () => {
      expect(normalizeAddress('  123 Main STREET  ')).toBe('123 main st');
    });

    it('should convert street type abbreviations', () => {
      expect(normalizeAddress('123 Oak Avenue')).toBe('123 oak ave');
      expect(normalizeAddress('456 Pine Boulevard')).toBe('456 pine blvd');
      expect(normalizeAddress('789 Elm Drive')).toBe('789 elm dr');
    });

    it('should convert direction words', () => {
      expect(normalizeAddress('100 North Main Street')).toBe('100 n main st');
      expect(normalizeAddress('200 Southwest Avenue')).toBe('200 sw ave');
    });

    it('should convert unit type abbreviations', () => {
      expect(normalizeAddress('123 Main Suite 100')).toBe('123 main ste 100');
      expect(normalizeAddress('456 Oak Apartment 2B')).toBe('456 oak apt 2b');
    });
  });

  describe('compareAddresses', () => {
    it('should return 1 for identical addresses', () => {
      expect(compareAddresses('123 Main Street', '123 Main Street')).toBe(1);
    });

    it('should return 1 for equivalent addresses', () => {
      expect(compareAddresses('123 Main Street', '123 Main St')).toBe(1);
    });

    it('should return 1 for both empty', () => {
      expect(compareAddresses(null, null)).toBe(1);
    });

    it('should return 0 when one is empty', () => {
      expect(compareAddresses('123 Main St', null)).toBe(0);
    });

    it('should return 0.9 when one contains the other', () => {
      expect(compareAddresses('123 main st', '123 main st ste 100')).toBe(0.9);
    });
  });

  describe('normalizeCompanyName', () => {
    it('should return empty string for null/undefined', () => {
      expect(normalizeCompanyName(null)).toBe('');
      expect(normalizeCompanyName(undefined)).toBe('');
    });

    it('should lowercase and trim', () => {
      expect(normalizeCompanyName('  ACME Corp  ')).toBe('acme');
    });

    it('should remove common suffixes', () => {
      expect(normalizeCompanyName('Acme Inc.')).toBe('acme');
      expect(normalizeCompanyName('Acme LLC')).toBe('acme');
      expect(normalizeCompanyName('Acme Corporation')).toBe('acme');
      expect(normalizeCompanyName('Acme Ltd')).toBe('acme');
    });

    it('should remove "the" prefix', () => {
      expect(normalizeCompanyName('The Acme Company')).toBe('acme');
    });

    it('should remove punctuation', () => {
      expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
    });
  });

  describe('compareCompanyNames', () => {
    it('should return 1 for identical names', () => {
      expect(compareCompanyNames('Acme Corp', 'Acme Corp')).toBe(1);
    });

    it('should return 1 for equivalent names with different suffixes', () => {
      expect(compareCompanyNames('Acme Inc.', 'Acme LLC')).toBe(1);
    });

    it('should return 1 for both empty', () => {
      expect(compareCompanyNames(null, null)).toBe(1);
    });

    it('should return 0 when one is empty', () => {
      expect(compareCompanyNames('Acme', null)).toBe(0);
    });

    it('should return 0.85 for acronym match', () => {
      expect(compareCompanyNames('ibm', 'International Business Machines')).toBe(0.85);
    });

    it('should return fuzzy match for similar names', () => {
      const score = compareCompanyNames('Acme Industries', 'Acme Industry');
      expect(score).toBeGreaterThan(0.7);
    });
  });

  describe('detectDataPattern', () => {
    it('should return unknown for null/undefined', () => {
      expect(detectDataPattern(null)).toEqual({ type: 'unknown', confidence: 0 });
      expect(detectDataPattern(undefined)).toEqual({ type: 'unknown', confidence: 0 });
    });

    it('should detect boolean values', () => {
      expect(detectDataPattern(true)).toEqual({ type: 'boolean', confidence: 1 });
      expect(detectDataPattern(false)).toEqual({ type: 'boolean', confidence: 1 });
    });

    it('should detect boolean strings', () => {
      expect(detectDataPattern('true')).toEqual({ type: 'boolean', confidence: 0.9 });
      expect(detectDataPattern('yes')).toEqual({ type: 'boolean', confidence: 0.9 });
      expect(detectDataPattern('no')).toEqual({ type: 'boolean', confidence: 0.9 });
    });

    it('should detect numbers', () => {
      expect(detectDataPattern(123)).toEqual({ type: 'number', confidence: 1 });
      // 123.45 matches currency pattern (decimal with 2 digits)
      expect(detectDataPattern('123.45')).toEqual({ type: 'currency', confidence: 0.8 });
      expect(detectDataPattern('-100')).toEqual({ type: 'number', confidence: 0.8 });
      // Test a number that doesn't match currency pattern
      expect(detectDataPattern('12345')).toEqual({ type: 'number', confidence: 0.8 });
    });

    it('should detect emails', () => {
      expect(detectDataPattern('user@example.com')).toEqual({ type: 'email', confidence: 0.95 });
    });

    it('should detect phones', () => {
      const result = detectDataPattern('555-123-4567');
      expect(result.type).toBe('phone');
      expect(result.confidence).toBeCloseTo(0.85, 1);
    });

    it('should detect currency', () => {
      expect(detectDataPattern('$100.00')).toEqual({ type: 'currency', confidence: 0.8 });
      expect(detectDataPattern('1000.99')).toEqual({ type: 'currency', confidence: 0.8 });
    });

    it('should detect dates', () => {
      // ISO format dates are detected properly
      expect(detectDataPattern('2024-01-15T12:00:00')).toEqual({ type: 'date', confidence: 0.9 });
      // Slash format dates
      expect(detectDataPattern('1/15/24')).toEqual({ type: 'date', confidence: 0.9 });
    });

    it('should detect identifiers', () => {
      const result = detectDataPattern('SKU-12345');
      expect(result.type).toBe('identifier');
      expect(result.confidence).toBeCloseTo(0.75, 1);
    });

    it('should detect text as fallback', () => {
      expect(detectDataPattern('Hello World')).toEqual({ type: 'text', confidence: 0.5 });
    });
  });

  describe('getNestedValue', () => {
    it('should get top-level value', () => {
      expect(getNestedValue({ name: 'John' }, 'name')).toBe('John');
    });

    it('should get nested value', () => {
      expect(getNestedValue({ user: { name: 'John' } }, 'user.name')).toBe('John');
    });

    it('should get deeply nested value', () => {
      expect(getNestedValue({ a: { b: { c: 'value' } } }, 'a.b.c')).toBe('value');
    });

    it('should return undefined for missing path', () => {
      expect(getNestedValue({ name: 'John' }, 'age')).toBeUndefined();
    });

    it('should return undefined for invalid nested path', () => {
      expect(getNestedValue({ name: 'John' }, 'name.first')).toBeUndefined();
    });
  });

  describe('scoreToConfidence', () => {
    it('should return high for scores >= 0.9', () => {
      expect(scoreToConfidence(0.9)).toBe('high');
      expect(scoreToConfidence(1.0)).toBe('high');
      expect(scoreToConfidence(0.95)).toBe('high');
    });

    it('should return medium for scores >= 0.75 and < 0.9', () => {
      expect(scoreToConfidence(0.75)).toBe('medium');
      expect(scoreToConfidence(0.8)).toBe('medium');
      expect(scoreToConfidence(0.89)).toBe('medium');
    });

    it('should return low for scores < 0.75', () => {
      expect(scoreToConfidence(0.74)).toBe('low');
      expect(scoreToConfidence(0.5)).toBe('low');
      expect(scoreToConfidence(0)).toBe('low');
    });
  });
});
