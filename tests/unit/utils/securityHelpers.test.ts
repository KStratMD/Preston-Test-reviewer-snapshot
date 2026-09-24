import { timingSafeCompare, maskSensitiveData, SENSITIVE_FIELD_PATTERNS } from '../../../src/utils/securityHelpers';

describe('securityHelpers', () => {
  describe('timingSafeCompare', () => {
    it('should return true for equal strings', () => {
      expect(timingSafeCompare('test', 'test')).toBe(true);
      expect(timingSafeCompare('api-key-12345', 'api-key-12345')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(timingSafeCompare('test', 'testing')).toBe(false);
      expect(timingSafeCompare('abc', 'def')).toBe(false);
    });

    it('should return false for strings of different lengths', () => {
      expect(timingSafeCompare('short', 'much-longer-string')).toBe(false);
      expect(timingSafeCompare('a', 'abc')).toBe(false);
    });

    it('should handle empty strings', () => {
      expect(timingSafeCompare('', '')).toBe(true);
      expect(timingSafeCompare('', 'nonempty')).toBe(false);
    });

    it('should be case-sensitive', () => {
      expect(timingSafeCompare('Test', 'test')).toBe(false);
      expect(timingSafeCompare('API_KEY', 'api_key')).toBe(false);
    });

    it('should correctly compare secrets longer than 64 characters', () => {
      // Regression test: ensure long secrets are fully compared, not truncated
      const prefix = 'a'.repeat(64);
      const secretA = prefix + 'ENDING_A';
      const secretB = prefix + 'ENDING_B';
      const secretC = prefix + 'ENDING_A';

      // Same prefix but different endings - should be false
      expect(timingSafeCompare(secretA, secretB)).toBe(false);

      // Identical long strings - should be true
      expect(timingSafeCompare(secretA, secretC)).toBe(true);

      // Test with 100+ character secrets
      const longSecretA = 'x'.repeat(100) + 'suffix1';
      const longSecretB = 'x'.repeat(100) + 'suffix2';
      expect(timingSafeCompare(longSecretA, longSecretB)).toBe(false);
      expect(timingSafeCompare(longSecretA, longSecretA)).toBe(true);
    });
  });

  describe('maskSensitiveData', () => {
    it('should redact sensitive fields', () => {
      const data = {
        username: 'john',
        password: 'secret123',
        api_key: 'key-12345',
        token: 'jwt-token',
      };

      const masked = maskSensitiveData(data) as Record<string, unknown>;

      expect(masked.username).toBe('john');
      expect(masked.password).toBe('[REDACTED]');
      expect(masked.api_key).toBe('[REDACTED]');
      expect(masked.token).toBe('[REDACTED]');
    });

    it('should handle nested objects', () => {
      const data = {
        user: {
          name: 'john',
          userPassword: 'secret', // Field containing 'password'
        },
      };

      const masked = maskSensitiveData(data) as any;

      expect(masked.user.name).toBe('john');
      expect(masked.user.userPassword).toBe('[REDACTED]');
    });

    it('should truncate long strings', () => {
      const longString = 'a'.repeat(150);
      const masked = maskSensitiveData(longString);

      expect(masked).toContain('[truncated]');
      expect((masked as string).length).toBeLessThan(150);
    });

    it('should limit array output', () => {
      const longArray = Array(10).fill('item');
      const masked = maskSensitiveData(longArray) as unknown[];

      expect(masked).toHaveLength(6); // 5 items + "...X more items" message
      expect(masked[5]).toContain('more items');
    });

    it('should handle null and undefined', () => {
      expect(maskSensitiveData(null)).toBe(null);
      expect(maskSensitiveData(undefined)).toBe(undefined);
    });

    it('should prevent deep recursion', () => {
      // Create deeply nested object (more than 10 levels)
      let deepObj: any = { value: 'test' };
      for (let i = 0; i < 15; i++) {
        deepObj = { nested: deepObj };
      }

      const masked = maskSensitiveData(deepObj) as any;

      // Should eventually hit MAX_DEPTH_EXCEEDED
      let current = masked;
      let maxDepthFound = false;
      for (let i = 0; i < 20; i++) {
        if (current === '[MAX_DEPTH_EXCEEDED]') {
          maxDepthFound = true;
          break;
        }
        if (!current || typeof current !== 'object' || !current.nested) {
          break;
        }
        current = current.nested;
      }
      // Should hit MAX_DEPTH_EXCEEDED at some point
      expect(maxDepthFound).toBe(true);
    });
  });

  describe('SENSITIVE_FIELD_PATTERNS', () => {
    it('should include common sensitive field names', () => {
      const expectedPatterns = ['password', 'token', 'secret', 'key', 'authorization'];

      expectedPatterns.forEach(pattern => {
        expect(SENSITIVE_FIELD_PATTERNS).toContain(pattern);
      });
    });
  });
});
