/**
 * Crypto Utility Unit Tests
 * Tests for cryptographic utility functions
 */

// Mock logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

import { CryptoUtils, generateSecureJWTSecret } from '../../../src/utils/crypto';

describe('CryptoUtils', () => {
  describe('generateJWTSecret', () => {
    it('should generate secret of default length (64)', () => {
      const secret = CryptoUtils.generateJWTSecret();
      expect(secret.length).toBe(64);
    });

    it('should generate secret of custom length', () => {
      const secret = CryptoUtils.generateJWTSecret(32);
      expect(secret.length).toBe(32);
    });

    it('should generate different secrets each time', () => {
      const secret1 = CryptoUtils.generateJWTSecret();
      const secret2 = CryptoUtils.generateJWTSecret();
      expect(secret1).not.toBe(secret2);
    });

    it('should generate base64-compatible string', () => {
      const secret = CryptoUtils.generateJWTSecret();
      expect(secret).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
  });

  describe('generateApiKey', () => {
    it('should generate key without prefix', () => {
      const key = CryptoUtils.generateApiKey();
      expect(key.length).toBe(64); // 32 bytes * 2 for hex
      expect(key).toMatch(/^[a-f0-9]+$/);
    });

    it('should generate key with prefix', () => {
      const key = CryptoUtils.generateApiKey('sk');
      expect(key).toMatch(/^sk_[a-f0-9]+$/);
    });

    it('should generate key with custom length', () => {
      const key = CryptoUtils.generateApiKey(undefined, 16);
      expect(key.length).toBe(32); // 16 bytes * 2 for hex
    });

    it('should generate different keys each time', () => {
      const key1 = CryptoUtils.generateApiKey();
      const key2 = CryptoUtils.generateApiKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe('generatePassword', () => {
    it('should generate password of default length (16)', () => {
      const password = CryptoUtils.generatePassword();
      expect(password.length).toBe(16);
    });

    it('should generate password of custom length', () => {
      const password = CryptoUtils.generatePassword(24);
      expect(password.length).toBe(24);
    });

    it('should include symbols by default', () => {
      // Generate multiple passwords to increase chance of finding a symbol
      let hasSymbol = false;
      for (let i = 0; i < 10; i++) {
        const password = CryptoUtils.generatePassword(32);
        if (/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password)) {
          hasSymbol = true;
          break;
        }
      }
      expect(hasSymbol).toBe(true);
    });

    it('should exclude symbols when specified', () => {
      const password = CryptoUtils.generatePassword(16, false);
      expect(password).toMatch(/^[A-Za-z0-9]+$/);
    });

    it('should include required uppercase characters', () => {
      const password = CryptoUtils.generatePassword(16, false, { minUppercase: 3 });
      const uppercaseCount = (password.match(/[A-Z]/g) || []).length;
      expect(uppercaseCount).toBeGreaterThanOrEqual(3);
    });

    it('should include required digits', () => {
      const password = CryptoUtils.generatePassword(16, false, { minDigits: 3 });
      const digitCount = (password.match(/[0-9]/g) || []).length;
      expect(digitCount).toBeGreaterThanOrEqual(3);
    });

    it('should throw error if length is too short for requirements', () => {
      expect(() => {
        CryptoUtils.generatePassword(3, true, { minUppercase: 2, minDigits: 2, minSymbols: 2 });
      }).toThrow('Password length too short');
    });

    it('should generate different passwords each time', () => {
      const password1 = CryptoUtils.generatePassword();
      const password2 = CryptoUtils.generatePassword();
      expect(password1).not.toBe(password2);
    });
  });

  describe('hashPassword and verifyPassword', () => {
    it('should hash and verify password correctly', async () => {
      const password = 'MySecurePassword123!';
      const hash = await CryptoUtils.hashPassword(password);

      expect(hash).not.toBe(password);
      expect(hash.length).toBeGreaterThan(50);

      const isValid = await CryptoUtils.verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'MySecurePassword123!';
      const hash = await CryptoUtils.hashPassword(password);

      const isValid = await CryptoUtils.verifyPassword('WrongPassword', hash);
      expect(isValid).toBe(false);
    });

    it('should produce different hashes for same password', async () => {
      const password = 'MySecurePassword123!';
      const hash1 = await CryptoUtils.hashPassword(password);
      const hash2 = await CryptoUtils.hashPassword(password);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('generateToken', () => {
    it('should generate token of default length (64 chars for 32 bytes)', () => {
      const token = CryptoUtils.generateToken();
      expect(token.length).toBe(64);
      expect(token).toMatch(/^[a-f0-9]+$/);
    });

    it('should generate token of custom length', () => {
      const token = CryptoUtils.generateToken(16);
      expect(token.length).toBe(32); // 16 bytes * 2 for hex
    });

    it('should generate different tokens each time', () => {
      const token1 = CryptoUtils.generateToken();
      const token2 = CryptoUtils.generateToken();
      expect(token1).not.toBe(token2);
    });
  });

  describe('generateUUID', () => {
    it('should generate valid UUID v4 format', () => {
      const uuid = CryptoUtils.generateUUID();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('should generate different UUIDs each time', () => {
      const uuid1 = CryptoUtils.generateUUID();
      const uuid2 = CryptoUtils.generateUUID();
      expect(uuid1).not.toBe(uuid2);
    });
  });

  describe('hash', () => {
    it('should create SHA-256 hash in hex format', () => {
      const hash = CryptoUtils.hash('hello');
      expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('should create hash in base64 format', () => {
      const hash = CryptoUtils.hash('hello', 'base64');
      expect(hash).toBe('LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
    });

    it('should produce consistent hashes', () => {
      const hash1 = CryptoUtils.hash('test');
      const hash2 = CryptoUtils.hash('test');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different data', () => {
      const hash1 = CryptoUtils.hash('test1');
      const hash2 = CryptoUtils.hash('test2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('hmac', () => {
    it('should create HMAC signature', () => {
      const signature = CryptoUtils.hmac('data', 'secret');
      expect(signature.length).toBe(64); // SHA-256 produces 64 hex chars
      expect(signature).toMatch(/^[a-f0-9]+$/);
    });

    it('should produce consistent signatures', () => {
      const sig1 = CryptoUtils.hmac('data', 'secret');
      const sig2 = CryptoUtils.hmac('data', 'secret');
      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures for different secrets', () => {
      const sig1 = CryptoUtils.hmac('data', 'secret1');
      const sig2 = CryptoUtils.hmac('data', 'secret2');
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different data', () => {
      const sig1 = CryptoUtils.hmac('data1', 'secret');
      const sig2 = CryptoUtils.hmac('data2', 'secret');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('encrypt and decrypt', () => {
    const key = Buffer.alloc(32, 'test-key-for-encryption');

    it('should encrypt and decrypt data correctly', () => {
      const plaintext = 'Hello, World!';
      const encrypted = CryptoUtils.encrypt(plaintext, key);

      expect(encrypted.encrypted).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();

      const decrypted = CryptoUtils.decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for same plaintext (due to random IV)', () => {
      const plaintext = 'Hello, World!';
      const encrypted1 = CryptoUtils.encrypt(plaintext, key);
      const encrypted2 = CryptoUtils.encrypt(plaintext, key);

      expect(encrypted1.encrypted).not.toBe(encrypted2.encrypted);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
    });

    it('should throw error for invalid key length on encrypt', () => {
      const shortKey = Buffer.alloc(16, 'short');
      expect(() => {
        CryptoUtils.encrypt('data', shortKey);
      }).toThrow('Encryption key must be 32 bytes');
    });

    it('should throw error for invalid key length on decrypt', () => {
      const shortKey = Buffer.alloc(16, 'short');
      expect(() => {
        CryptoUtils.decrypt({ encrypted: '', iv: '', authTag: '' }, shortKey);
      }).toThrow('Decryption key must be 32 bytes');
    });

    it('should fail decryption with wrong key', () => {
      const plaintext = 'Hello, World!';
      const encrypted = CryptoUtils.encrypt(plaintext, key);

      const wrongKey = Buffer.alloc(32, 'wrong-key-for-decryption');
      expect(() => {
        CryptoUtils.decrypt(encrypted, wrongKey);
      }).toThrow();
    });

    it('should fail decryption with tampered data', () => {
      const plaintext = 'Hello, World!';
      const encrypted = CryptoUtils.encrypt(plaintext, key);

      // Tamper with encrypted data
      encrypted.encrypted = 'tampered' + encrypted.encrypted.slice(8);
      expect(() => {
        CryptoUtils.decrypt(encrypted, key);
      }).toThrow();
    });
  });

  describe('timingSafeEqual', () => {
    it('should return true for equal strings', () => {
      expect(CryptoUtils.timingSafeEqual('hello', 'hello')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(CryptoUtils.timingSafeEqual('hello', 'world')).toBe(false);
    });

    it('should return false for strings of different lengths', () => {
      expect(CryptoUtils.timingSafeEqual('hello', 'hi')).toBe(false);
    });

    it('should return true for empty strings', () => {
      expect(CryptoUtils.timingSafeEqual('', '')).toBe(true);
    });
  });

  describe('randomInt', () => {
    it('should generate integer within range', () => {
      for (let i = 0; i < 100; i++) {
        const num = CryptoUtils.randomInt(1, 10);
        expect(num).toBeGreaterThanOrEqual(1);
        expect(num).toBeLessThanOrEqual(10);
      }
    });

    it('should generate same value for single-value range', () => {
      const num = CryptoUtils.randomInt(5, 5);
      expect(num).toBe(5);
    });

    it('should generate different values over multiple calls', () => {
      const values = new Set<number>();
      for (let i = 0; i < 100; i++) {
        values.add(CryptoUtils.randomInt(1, 100));
      }
      expect(values.size).toBeGreaterThan(1);
    });
  });

  describe('analyzeEntropy', () => {
    it('should analyze weak secret', () => {
      const result = CryptoUtils.analyzeEntropy('aaa');
      expect(result.length).toBe(3);
      expect(result.uniqueChars).toBe(1);
      expect(result.strength).toBe('weak');
    });

    it('should analyze fair secret', () => {
      // Need longer string with more unique chars to reach 40+ bits entropy
      const result = CryptoUtils.analyzeEntropy('Password123!@#');
      expect(result.strength).toBe('fair');
    });

    it('should analyze good secret', () => {
      // Need even more entropy (64+ bits) for "good" strength
      const result = CryptoUtils.analyzeEntropy('MyP@ssw0rd!2024AbCdEf');
      expect(result.strength).toBe('good');
    });

    it('should analyze strong secret', () => {
      const secret = CryptoUtils.generateJWTSecret(64);
      const result = CryptoUtils.analyzeEntropy(secret);
      expect(result.strength).toBe('strong');
    });

    it('should calculate entropy correctly', () => {
      const result = CryptoUtils.analyzeEntropy('abcdefgh');
      expect(result.length).toBe(8);
      expect(result.uniqueChars).toBe(8);
      expect(result.estimatedBits).toBeGreaterThan(20);
    });
  });

  describe('generateSecureJWTSecret', () => {
    it('should execute without throwing', () => {
      expect(() => {
        generateSecureJWTSecret(false);
      }).not.toThrow();
    });

    it('should execute with showSecret true', () => {
      expect(() => {
        generateSecureJWTSecret(true);
      }).not.toThrow();
    });
  });
});
