/**
 * CredentialEncryption Unit Tests
 * Tests for AES-256-GCM credential encryption/decryption
 */

import { CredentialEncryption } from '../../../src/utils/CredentialEncryption';
import * as crypto from 'crypto';

describe('CredentialEncryption', () => {
  // Generate a valid test key
  const validKey = crypto.randomBytes(32).toString('base64');
  const originalEnv = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    // Clear the cached key before each test
    CredentialEncryption._clearKeyCache();
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv) {
      process.env.ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
    CredentialEncryption._clearKeyCache();
  });

  describe('generateKey()', () => {
    it('should generate a base64-encoded 32-byte key', () => {
      const key = CredentialEncryption.generateKey();

      expect(typeof key).toBe('string');
      const decoded = Buffer.from(key, 'base64');
      expect(decoded.length).toBe(32);
    });

    it('should generate unique keys each time', () => {
      const key1 = CredentialEncryption.generateKey();
      const key2 = CredentialEncryption.generateKey();

      expect(key1).not.toBe(key2);
    });
  });

  describe('isKeyConfigured()', () => {
    it('should return true when valid key is set', () => {
      process.env.ENCRYPTION_KEY = validKey;

      expect(CredentialEncryption.isKeyConfigured()).toBe(true);
    });

    it('should return false when no key is set', () => {
      delete process.env.ENCRYPTION_KEY;

      expect(CredentialEncryption.isKeyConfigured()).toBe(false);
    });

    it('should return false when key is invalid', () => {
      process.env.ENCRYPTION_KEY = 'too-short';

      expect(CredentialEncryption.isKeyConfigured()).toBe(false);
    });
  });

  describe('encrypt() and decrypt()', () => {
    beforeEach(() => {
      process.env.ENCRYPTION_KEY = validKey;
    });

    it('should encrypt and decrypt credentials round-trip', () => {
      const credentials = {
        accountId: 'ACCT123',
        apiKey: 'secret-api-key',
        username: 'test-user',
      };

      const encrypted = CredentialEncryption.encrypt(credentials);
      const decrypted = CredentialEncryption.decrypt(encrypted);

      expect(decrypted).toEqual(credentials);
    });

    it('should produce different ciphertext for same plaintext (due to random IV)', () => {
      const credentials = { secret: 'value' };

      const encrypted1 = CredentialEncryption.encrypt(credentials);
      const encrypted2 = CredentialEncryption.encrypt(credentials);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should handle complex nested objects', () => {
      const credentials = {
        oauth: {
          clientId: 'id-123',
          clientSecret: 'secret-456',
          tokens: {
            access: 'access-token',
            refresh: 'refresh-token',
          },
        },
        endpoints: ['api.example.com', 'backup.example.com'],
      };

      const encrypted = CredentialEncryption.encrypt(credentials);
      const decrypted = CredentialEncryption.decrypt(encrypted);

      expect(decrypted).toEqual(credentials);
    });

    it('should handle empty object', () => {
      const credentials = {};

      const encrypted = CredentialEncryption.encrypt(credentials);
      const decrypted = CredentialEncryption.decrypt(encrypted);

      expect(decrypted).toEqual(credentials);
    });

    it('should handle special characters in values', () => {
      const credentials = {
        password: 'p@$$w0rd!@#$%^&*()',
        unicodeField: 'こんにちは世界',
        newlines: 'line1\nline2\nline3',
      };

      const encrypted = CredentialEncryption.encrypt(credentials);
      const decrypted = CredentialEncryption.decrypt(encrypted);

      expect(decrypted).toEqual(credentials);
    });

    it('should produce base64-encoded output', () => {
      const credentials = { key: 'value' };

      const encrypted = CredentialEncryption.encrypt(credentials);

      // Should be valid base64
      expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();
      // Base64 characters only
      expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  describe('encryption error handling', () => {
    it('should throw error when ENCRYPTION_KEY is not set for encrypt', () => {
      delete process.env.ENCRYPTION_KEY;

      expect(() => CredentialEncryption.encrypt({ key: 'value' })).toThrow(
        'ENCRYPTION_KEY environment variable not set'
      );
    });

    it('should throw error when ENCRYPTION_KEY is not set for decrypt', () => {
      delete process.env.ENCRYPTION_KEY;

      expect(() => CredentialEncryption.decrypt('somedata')).toThrow(
        'ENCRYPTION_KEY environment variable not set'
      );
    });

    it('should throw error when key length is incorrect', () => {
      // 16-byte key instead of 32
      process.env.ENCRYPTION_KEY = crypto.randomBytes(16).toString('base64');

      expect(() => CredentialEncryption.encrypt({ key: 'value' })).toThrow(
        'ENCRYPTION_KEY must be 32 bytes'
      );
    });
  });

  describe('decryption error handling', () => {
    beforeEach(() => {
      process.env.ENCRYPTION_KEY = validKey;
    });

    it('should throw error for tampered ciphertext', () => {
      const credentials = { secret: 'value' };
      const encrypted = CredentialEncryption.encrypt(credentials);

      // Tamper with the ciphertext (change a character in the middle)
      const replacement = encrypted[50] === 'X' ? 'Y' : 'X';
      const tampered = encrypted.slice(0, 50) + replacement + encrypted.slice(51);

      expect(tampered).not.toBe(encrypted);

      expect(() => CredentialEncryption.decrypt(tampered)).toThrow();
    });

    it('should throw error for corrupted data', () => {
      expect(() => CredentialEncryption.decrypt('not-valid-encrypted-data')).toThrow();
    });

    it('should throw error when decrypting with wrong key', () => {
      const credentials = { secret: 'value' };
      const encrypted = CredentialEncryption.encrypt(credentials);

      // Change to a different key
      CredentialEncryption._clearKeyCache();
      process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

      expect(() => CredentialEncryption.decrypt(encrypted)).toThrow();
    });
  });

  describe('sanitize()', () => {
    it('should redact password field', () => {
      const credentials = {
        username: 'user123',
        password: 'secret123',
      };

      const sanitized = CredentialEncryption.sanitize(credentials);

      expect(sanitized.username).toBe('user123');
      expect(sanitized.password).toBe('[REDACTED]');
    });

    it('should redact apiKey field', () => {
      const credentials = {
        accountId: 'ACCT123',
        apiKey: 'key-secret-value',
      };

      const sanitized = CredentialEncryption.sanitize(credentials);

      expect(sanitized.accountId).toBe('ACCT123');
      expect(sanitized.apiKey).toBe('[REDACTED]');
    });

    it('should redact various secret field names', () => {
      const credentials = {
        consumerSecret: 'secret1',
        tokenSecret: 'secret2',
        clientSecret: 'secret3',
        api_key: 'secret4',
        consumer_secret: 'secret5',
        token_secret: 'secret6',
        client_secret: 'secret7',
      };

      const sanitized = CredentialEncryption.sanitize(credentials);

      expect(sanitized.consumerSecret).toBe('[REDACTED]');
      expect(sanitized.tokenSecret).toBe('[REDACTED]');
      expect(sanitized.clientSecret).toBe('[REDACTED]');
      expect(sanitized.api_key).toBe('[REDACTED]');
      expect(sanitized.consumer_secret).toBe('[REDACTED]');
      expect(sanitized.token_secret).toBe('[REDACTED]');
      expect(sanitized.client_secret).toBe('[REDACTED]');
    });

    it('should redact fields containing "token" in name', () => {
      const credentials = {
        accessToken: 'token-value',
        refreshToken: 'refresh-value',
      };

      const sanitized = CredentialEncryption.sanitize(credentials);

      expect(sanitized.accessToken).toBe('[REDACTED]');
      expect(sanitized.refreshToken).toBe('[REDACTED]');
    });

    it('should not redact non-sensitive fields', () => {
      const credentials = {
        accountId: 'ACCT123',
        baseUrl: 'https://api.example.com',
        environment: 'production',
      };

      const sanitized = CredentialEncryption.sanitize(credentials);

      expect(sanitized.accountId).toBe('ACCT123');
      expect(sanitized.baseUrl).toBe('https://api.example.com');
      expect(sanitized.environment).toBe('production');
    });

    it('should preserve null and undefined values', () => {
      const credentials = {
        username: 'user',
        password: null,
        apiKey: undefined,
      };

      const sanitized = CredentialEncryption.sanitize(credentials);

      expect(sanitized.username).toBe('user');
      expect(sanitized.password).toBeNull();
      expect(sanitized.apiKey).toBeUndefined();
    });

    it('should handle empty object', () => {
      const sanitized = CredentialEncryption.sanitize({});

      expect(sanitized).toEqual({});
    });

    it('should be case-insensitive for field name matching', () => {
      const credentials = {
        PASSWORD: 'secret1',
        ApiKey: 'secret2',
        CLIENTSECRET: 'secret3',
      };

      const sanitized = CredentialEncryption.sanitize(credentials);

      expect(sanitized.PASSWORD).toBe('[REDACTED]');
      expect(sanitized.ApiKey).toBe('[REDACTED]');
      expect(sanitized.CLIENTSECRET).toBe('[REDACTED]');
    });
  });

  describe('key caching', () => {
    it('should cache the encryption key after first access', () => {
      process.env.ENCRYPTION_KEY = validKey;

      // First encryption initializes the key
      CredentialEncryption.encrypt({ test: 'value' });

      // Change env (but cached key should still be used)
      const newKey = crypto.randomBytes(32).toString('base64');
      process.env.ENCRYPTION_KEY = newKey;

      // Should still work with original key (from cache)
      const encrypted = CredentialEncryption.encrypt({ test: 'value2' });
      expect(() => CredentialEncryption.decrypt(encrypted)).not.toThrow();
    });

    it('should clear cache when _clearKeyCache is called', () => {
      process.env.ENCRYPTION_KEY = validKey;
      CredentialEncryption.encrypt({ test: 'value' });

      // Clear cache
      CredentialEncryption._clearKeyCache();

      // Set new key
      const newKey = crypto.randomBytes(32).toString('base64');
      process.env.ENCRYPTION_KEY = newKey;

      // Should use new key now
      const encrypted = CredentialEncryption.encrypt({ test: 'value2' });

      // Verify by clearing cache and using new key to decrypt
      CredentialEncryption._clearKeyCache();
      process.env.ENCRYPTION_KEY = newKey;
      const decrypted = CredentialEncryption.decrypt(encrypted);
      expect(decrypted).toEqual({ test: 'value2' });
    });
  });
});
