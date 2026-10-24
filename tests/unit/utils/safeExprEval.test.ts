/**
 * Safe Expression Evaluation Unit Tests
 * Tests for secure expression evaluation with DoS protection
 */

import { safeEvaluate, safeEvaluateSync, validateExpression } from '../../../src/utils/safeExprEval';

describe('safeExprEval', () => {
  describe('safeEvaluate', () => {
    it('should evaluate simple arithmetic', async () => {
      const result = await safeEvaluate('2 + 2');
      expect(result).toBe(4);
    });

    it('should evaluate with variables', async () => {
      const result = await safeEvaluate('x + y * 2', { x: 10, y: 5 });
      expect(result).toBe(20);
    });

    it('should handle boolean variables', async () => {
      const result = await safeEvaluate('x and y', { x: true, y: false });
      expect(result).toBe(false);
    });

    it('should convert non-numeric values to numbers', async () => {
      const result = await safeEvaluate('x + y', { x: '10', y: null });
      expect(result).toBe(10);
    });

    it('should reject expressions exceeding max length', async () => {
      const longExpr = 'a + '.repeat(300) + 'a';
      await expect(safeEvaluate(longExpr, {}, { maxLength: 100 }))
        .rejects.toThrow('exceeds maximum length');
    });

    it('should reject expressions with excessive nesting', async () => {
      const deepNesting = '(' .repeat(25) + '1' + ')'.repeat(25);
      await expect(safeEvaluate(deepNesting, {}, { maxNestingDepth: 20 }))
        .rejects.toThrow('nesting depth');
    });

    it('should reject dangerous computation patterns', async () => {
      // Multiple exponentiation is considered dangerous
      await expect(safeEvaluate('2^^2'))
        .rejects.toThrow('dangerous computation patterns');
    });

    it('should reject factorial of large numbers', async () => {
      await expect(safeEvaluate('factorial(1000)'))
        .rejects.toThrow('dangerous computation patterns');
    });

    it('should evaluate mathematical functions', async () => {
      const result = await safeEvaluate('abs(-5)');
      expect(result).toBe(5);
    });

    it('should reject invalid expressions', async () => {
      // Invalid syntax with unclosed parenthesis
      await expect(safeEvaluate('2 + (3 *'))
        .rejects.toThrow('parse error');
    });

    it('should respect custom timeout', async () => {
      // Short timeout for testing
      await expect(safeEvaluate('1 + 1', {}, { timeoutMs: 1 }))
        .resolves.toBe(2);
    });

    it('should reject when elapsed evaluation time exceeds timeout budget', async () => {
      const slowValue = {
        valueOf: () => {
          const start = Date.now();
          while (Date.now() - start < 15) {
            // Busy wait to simulate blocking computation
          }
          return 1;
        },
      };

      await expect(safeEvaluate('x + 1', { x: slowValue }, { timeoutMs: 1 }))
        .rejects.toThrow('exceeded timeout');
    });

    it('should prefix evaluation errors consistently', async () => {
      await expect(safeEvaluate('f(1)', { f: 1 }))
        .rejects.toThrow('Expression evaluation error');
    });
  });

  describe('safeEvaluateSync', () => {
    it('should evaluate simple arithmetic', () => {
      const result = safeEvaluateSync('3 * 4');
      expect(result).toBe(12);
    });

    it('should evaluate with variables', () => {
      const result = safeEvaluateSync('a - b', { a: 10, b: 3 });
      expect(result).toBe(7);
    });

    it('should handle string variables', () => {
      const result = safeEvaluateSync('x', { x: 'hello' });
      expect(result).toBe('hello');
    });

    it('should reject expressions exceeding max length', () => {
      const longExpr = 'x + '.repeat(300) + 'x';
      expect(() => safeEvaluateSync(longExpr, {}, { maxLength: 100 }))
        .toThrow('exceeds maximum length');
    });

    it('should reject expressions with excessive nesting', () => {
      const deepNesting = '(' .repeat(25) + '1' + ')'.repeat(25);
      expect(() => safeEvaluateSync(deepNesting, {}, { maxNestingDepth: 20 }))
        .toThrow('nesting depth');
    });

    it('should reject dangerous computation patterns', () => {
      expect(() => safeEvaluateSync('2^^2'))
        .toThrow('dangerous computation patterns');
    });

    it('should handle undefined variables as 0', () => {
      const result = safeEvaluateSync('x + 1', { x: undefined });
      expect(result).toBe(1);
    });

    it('should handle null variables as 0', () => {
      const result = safeEvaluateSync('x + 5', { x: null });
      expect(result).toBe(5);
    });

    it('should handle object variables by converting to number', () => {
      const result = safeEvaluateSync('x + 2', { x: { valueOf: () => 3 } });
      expect(result).toBe(5);
    });

    it('should prefix parse errors consistently', () => {
      expect(() => safeEvaluateSync('2 + (3 *'))
        .toThrow('Expression parse error');
    });

    it('should prefix evaluation errors consistently', () => {
      expect(() => safeEvaluateSync('f(1)', { f: 1 }))
        .toThrow('Expression evaluation error');
    });
  });

  describe('validateExpression', () => {
    it('should validate correct expression', () => {
      const result = validateExpression('2 + 2');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid syntax', () => {
      // Invalid syntax with unclosed parenthesis
      const result = validateExpression('2 + (3 *');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Parse error');
    });

    it('should reject too long expression', () => {
      const longExpr = 'x + '.repeat(300) + 'x';
      const result = validateExpression(longExpr, { maxLength: 100 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length');
    });

    it('should reject excessive nesting', () => {
      const deepNesting = '(' .repeat(25) + '1' + ')'.repeat(25);
      const result = validateExpression(deepNesting, { maxNestingDepth: 20 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('nesting depth');
    });

    it('should reject dangerous patterns', () => {
      const result = validateExpression('factorial(1000)');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('dangerous computation patterns');
    });

    it('should validate complex but safe expressions', () => {
      const result = validateExpression('sin(x) + cos(y) * tan(z)');
      expect(result.valid).toBe(true);
    });

    it('should validate conditional expressions', () => {
      const result = validateExpression('x > 5 ? 10 : 0');
      expect(result.valid).toBe(true);
    });
  });
});
