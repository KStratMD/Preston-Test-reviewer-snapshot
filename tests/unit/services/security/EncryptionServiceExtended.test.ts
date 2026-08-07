/**
 * Comprehensive unit tests for EncryptionService
 * Covers: encrypt, decrypt, encryptForStorage, decryptFromStorage,
 *         generateNewKey, isEncrypted, createHash, maskApiKey, validateApiKeyFormat
 */
import 'reflect-metadata';

// Mock logger before importing EncryptionService
jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Set a test encryption key before importing the module
process.env.AI_CONFIG_ENCRYPTION_KEY = 'a'.repeat(64);

import { EncryptionService } from '../../../../src/services/security/EncryptionService';

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AI_CONFIG_ENCRYPTION_KEY = 'a'.repeat(64);
    service = new EncryptionService();
  });

  describe('constructor', () => {
    it('should initialize with environment key', () => {
      const svc = new EncryptionService();
      expect(svc).toBeDefined();
    });

    it('should throw on invalid key length', () => {
      process.env.AI_CONFIG_ENCRYPTION_KEY = 'tooshort';
      expect(() => new EncryptionService()).toThrow('64 hexadecimal characters');
    });

    it('should generate key when env not set', () => {
      delete process.env.AI_CONFIG_ENCRYPTION_KEY;
      const svc = new EncryptionService();
      expect(svc).toBeDefined();
    });
  });

  describe('encrypt', () => {
    it('should encrypt a string', async () => {
      const result = await service.encrypt('sk-test-key-12345');
      expect(result.encryptedText).toBeDefined();
      expect(result.iv).toBeDefined();
      expect(result.authTag).toBeDefined();
      expect(result.algorithm).toBe('aes-256-gcm');
    });

    it('should produce different ciphertexts for same input (random IV)', async () => {
      const r1 = await service.encrypt('same-plaintext');
      const r2 = await service.encrypt('same-plaintext');
      expect(r1.encryptedText).not.toBe(r2.encryptedText);
      expect(r1.iv).not.toBe(r2.iv);
    });

    it('should throw on empty input', async () => {
      await expect(service.encrypt('')).rejects.toThrow('Cannot encrypt empty');
    });

    it('should throw on whitespace-only input', async () => {
      await expect(service.encrypt('   ')).rejects.toThrow('Cannot encrypt empty');
    });
  });

  describe('decrypt', () => {
    it('should decrypt to original plaintext', async () => {
      const original = 'sk-ant-api-key-1234567890';
      const encrypted = await service.encrypt(original);
      const decrypted = await service.decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should throw on null input', async () => {
      await expect(service.decrypt(null as any)).rejects.toThrow('Cannot decrypt null');
    });

    it('should throw on empty encryptedText', async () => {
      await expect(service.decrypt({ encryptedText: '', iv: 'a', authTag: 'b', algorithm: 'aes-256-gcm' }))
        .rejects.toThrow('Cannot decrypt null');
    });

    it('should throw on wrong algorithm', async () => {
      const encrypted = await service.encrypt('test');
      encrypted.algorithm = 'aes-128-cbc';
      await expect(service.decrypt(encrypted)).rejects.toThrow('Unsupported encryption algorithm');
    });

    it('should throw on tampered data', async () => {
      const encrypted = await service.encrypt('test');
      // XOR-flip the first byte so the mutation is guaranteed regardless of
      // the original value (overwriting with a constant flaked when ciphertext
      // already started with that constant).
      const flipped = (parseInt(encrypted.encryptedText.slice(0, 2), 16) ^ 0xff)
        .toString(16)
        .padStart(2, '0');
      encrypted.encryptedText = flipped + encrypted.encryptedText.slice(2);
      await expect(service.decrypt(encrypted)).rejects.toThrow('Decryption failed');
    });
  });

  describe('encryptForStorage / decryptFromStorage', () => {
    it('should roundtrip through JSON storage', async () => {
      const original = 'my-secret-api-key';
      const stored = await service.encryptForStorage(original);
      expect(typeof stored).toBe('string');
      const parsed = JSON.parse(stored);
      expect(parsed.encryptedText).toBeDefined();

      const recovered = await service.decryptFromStorage(stored);
      expect(recovered).toBe(original);
    });

    it('should throw on invalid JSON', async () => {
      await expect(service.decryptFromStorage('not-json')).rejects.toThrow('Failed to decrypt from storage');
    });
  });

  describe('generateNewKey', () => {
    it('should generate a 64-char hex key', () => {
      const key = service.generateNewKey();
      expect(key.length).toBe(64);
      expect(/^[a-f0-9]+$/.test(key)).toBe(true);
    });

    it('should generate unique keys', () => {
      const k1 = service.generateNewKey();
      const k2 = service.generateNewKey();
      expect(k1).not.toBe(k2);
    });
  });

  describe('isEncrypted', () => {
    it('should return true for encrypted data', async () => {
      const stored = await service.encryptForStorage('test');
      expect(service.isEncrypted(stored)).toBe(true);
    });

    it('should return false for plain text', () => {
      expect(service.isEncrypted('plain-text')).toBe(false);
    });

    it('should return false for JSON without required fields', () => {
      expect(service.isEncrypted(JSON.stringify({ foo: 'bar' }))).toBeFalsy();
    });

    it('should return false for wrong algorithm', () => {
      expect(service.isEncrypted(JSON.stringify({
        encryptedText: 'abc',
        iv: 'def',
        authTag: 'ghi',
        algorithm: 'aes-128-cbc',
      }))).toBe(false);
    });
  });

  describe('createHash', () => {
    it('should create a SHA-256 hash', () => {
      const hash = service.createHash('test');
      expect(hash.length).toBe(64); // SHA-256 = 64 hex chars
    });

    it('should be deterministic', () => {
      const h1 = service.createHash('same-input');
      const h2 = service.createHash('same-input');
      expect(h1).toBe(h2);
    });

    it('should produce different hashes for different inputs', () => {
      const h1 = service.createHash('input-a');
      const h2 = service.createHash('input-b');
      expect(h1).not.toBe(h2);
    });
  });

  describe('maskApiKey', () => {
    it('should mask middle of key', () => {
      const masked = service.maskApiKey('sk-1234567890abcdef');
      expect(masked.startsWith('sk-1')).toBe(true);
      expect(masked.endsWith('cdef')).toBe(true);
      expect(masked).toContain('****');
    });

    it('should return [INVALID_KEY] for short keys', () => {
      expect(service.maskApiKey('short')).toBe('[INVALID_KEY]');
    });

    it('should return [INVALID_KEY] for empty string', () => {
      expect(service.maskApiKey('')).toBe('[INVALID_KEY]');
    });

    it('should handle 8-char key (minimum)', () => {
      const masked = service.maskApiKey('12345678');
      expect(masked).toBe('1234****5678');
    });
  });

  describe('validateApiKeyFormat', () => {
    it('should accept valid OpenAI key', () => {
      const result = service.validateApiKeyFormat('openai', 'sk-' + 'a'.repeat(48));
      expect(result.valid).toBe(true);
    });

    it('should accept valid OpenAI project key', () => {
      const result = service.validateApiKeyFormat('openai', 'sk-proj-' + 'a'.repeat(48));
      expect(result.valid).toBe(true);
    });

    it('should reject invalid OpenAI key', () => {
      const result = service.validateApiKeyFormat('openai', 'invalid-key');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid openai API key');
    });

    it('should accept valid Claude key', () => {
      const result = service.validateApiKeyFormat('claude', 'sk-ant-' + 'a'.repeat(95));
      expect(result.valid).toBe(true);
    });

    it('should reject invalid Claude key', () => {
      const result = service.validateApiKeyFormat('claude', 'sk-invalid');
      expect(result.valid).toBe(false);
    });

    it('should accept valid OpenRouter key', () => {
      const result = service.validateApiKeyFormat('openrouter', 'sk-or-' + 'a'.repeat(48));
      expect(result.valid).toBe(true);
    });

    it('should reject invalid OpenRouter key', () => {
      const result = service.validateApiKeyFormat('openrouter', 'sk-invalid');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid openrouter API key');
    });

    it('should accept valid Grok key', () => {
      const result = service.validateApiKeyFormat('grok', 'xai-' + 'a'.repeat(48));
      expect(result.valid).toBe(true);
    });

    it('should skip validation for lmstudio with key', () => {
      const result = service.validateApiKeyFormat('lmstudio', 'any-key');
      expect(result.valid).toBe(true);
    });

    it('should skip validation for rule-based with key', () => {
      const result = service.validateApiKeyFormat('rule-based', 'any-key');
      expect(result.valid).toBe(true);
    });

    it('should reject empty key even for lmstudio', () => {
      const result = service.validateApiKeyFormat('lmstudio', '');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('should reject unknown provider', () => {
      const result = service.validateApiKeyFormat('unknown-provider', 'some-key');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown provider');
    });

    it('should reject empty API key', () => {
      const result = service.validateApiKeyFormat('openai', '');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });
  });
});
