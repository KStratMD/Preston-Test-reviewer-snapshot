/**
 * Unit tests for JSON utilities
 * Author: Eric Stratford
 * Module 3.1 - Learning Jest
 */

import { stripMarkdownCodeFences, parseJsonFromText } from '../../../../src/utils/json';

describe('stripMarkdownCodeFences', () => {

  test('removes code fences from JSON block', () => {
    const input = '```json\n{"a":1}\n```';
    const result = stripMarkdownCodeFences(input);
    expect(result).toBe('{"a":1}');
  });

  test('removes plain code fences without language', () => {
    const input = '```\n{"b":2}\n```';
    const result = stripMarkdownCodeFences(input);
    expect(result).toBe('{"b":2}');
  });

  test('returns text unchanged if no fences', () => {
    const input = '{"c":3}';
    const result = stripMarkdownCodeFences(input);
    expect(result).toBe('{"c":3}');
  });

});

describe('parseJsonFromText', () => {

  test('extracts JSON object from text', () => {
    const input = 'Here is some data: {"name":"Eric"}';
    const result = parseJsonFromText(input);
    expect(result).toEqual({ name: "Eric" });
  });

  test('extracts JSON array from text', () => {
    const input = 'The items are: [1, 2, 3]';
    const result = parseJsonFromText(input);
    expect(result).toEqual([1, 2, 3]);
  });

  test('returns null for invalid JSON', () => {
    const input = 'No JSON here, just text';
    const result = parseJsonFromText(input);
    expect(result).toBeNull();
  });

  test('handles JSON wrapped in markdown code fences', () => {
    const input = '```json\n{"key":"value"}\n```';
    const result = parseJsonFromText(input);
    expect(result).toEqual({ key: "value" });
  });

});
