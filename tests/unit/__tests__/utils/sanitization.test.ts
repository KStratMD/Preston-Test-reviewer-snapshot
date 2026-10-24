/**
 * Unit tests for sanitization utilities
 * Author: Eric Stratford
 * Module 3.1 - Learning Jest
 */

import { stripControlCharacters } from '../../../../src/utils/sanitization';

describe('stripControlCharacters', () => {

  test('returns normal text unchanged', () => {
    const result = stripControlCharacters('Hello');
    expect(result).toBe('Hello');
  });

  test('removes control characters from text', () => {
    const result = stripControlCharacters('Hello\x00World');
    expect(result).toBe('HelloWorld');
  });

  test('handles empty string', () => {
    const result = stripControlCharacters('');
    expect(result).toBe('');
  });

  test('removes multiple control characters', () => {
    const result = stripControlCharacters('\x00Test\x1FData\x7F');
    expect(result).toBe('TestData');
  });

});
