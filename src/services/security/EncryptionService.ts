/**
 * Encryption Service for Secure API Key Storage
 * Implements AES-256-GCM encryption for AI provider API keys
 */

import crypto from 'crypto';
import { logger } from '../../utils/Logger';

export interface EncryptedData {
  encryptedText: string;
  iv: string;
  authTag: string;
  algorithm: string;
}

export class EncryptionService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32; // 256 bits
  private readonly ivLength = 16; // 128 bits
  private readonly tagLength = 16; // 128 bits

  private encryptionKey: Buffer;

  constructor() {
    this.initializeEncryptionKey();
  }

  /**
   * Initialize encryption key from environment or generate one
   */
  private initializeEncryptionKey(): void {
    const keyFromEnv = process.env.AI_CONFIG_ENCRYPTION_KEY;

    if (keyFromEnv) {
      // Use provided key from environment
      if (keyFromEnv.length !== 64) { // 32 bytes = 64 hex chars
        throw new Error('AI_CONFIG_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)');
      }
      this.encryptionKey = Buffer.from(keyFromEnv, 'hex');
      logger.info('Encryption service initialized with environment key');
    } else {
      // Generate a new key for development (NOT for production)
      this.encryptionKey = crypto.randomBytes(this.keyLength);
      logger.warn('No AI_CONFIG_ENCRYPTION_KEY found. Generated transient key. Data encrypted with this key will be lost on restart.');
      logger.warn('⚠️  IMPORTANT: Set AI_CONFIG_ENCRYPTION_KEY in production environment');
    }
  }

  /**
   * Encrypt sensitive text (API keys)
   */
  async encrypt(plaintext: string): Promise<EncryptedData> {
    if (!plaintext || plaintext.trim().length === 0) {
      throw new Error('Cannot encrypt empty or whitespace-only text');
    }

    try {
      // Generate random IV for each encryption
      const iv = crypto.randomBytes(this.ivLength);

      // Create cipher
      const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);
      cipher.setAAD(Buffer.from('ai-config')); // Additional authenticated data

      // Encrypt the data
      let encryptedText = cipher.update(plaintext, 'utf8', 'hex');
      encryptedText += cipher.final('hex');

      // Get authentication tag
      const authTag = cipher.getAuthTag();

      const result: EncryptedData = {
        encryptedText,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        algorithm: this.algorithm
      };

      logger.debug('Successfully encrypted data', {
        algorithm: this.algorithm,
        ivLength: iv.length,
        tagLength: authTag.length,
        encryptedLength: encryptedText.length
      });

      return result;
    } catch (error) {
      logger.error('Encryption failed', { error: error.message });
      throw new Error(`Encryption failed: ${error.message}`, { cause: error });
    }
  }

  /**
   * Decrypt sensitive text (API keys)
   */
  async decrypt(encryptedData: EncryptedData): Promise<string> {
    if (!encryptedData || !encryptedData.encryptedText) {
      throw new Error('Cannot decrypt null or empty encrypted data');
    }

    try {
      // Validate algorithm
      if (encryptedData.algorithm !== this.algorithm) {
        throw new Error(`Unsupported encryption algorithm: ${encryptedData.algorithm}`);
      }

      // Convert hex strings back to buffers
      const iv = Buffer.from(encryptedData.iv, 'hex');
      const authTag = Buffer.from(encryptedData.authTag, 'hex');

      // Create decipher
      const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
      decipher.setAAD(Buffer.from('ai-config')); // Same AAD used in encryption
      decipher.setAuthTag(authTag);

      // Decrypt the data
      let decryptedText = decipher.update(encryptedData.encryptedText, 'hex', 'utf8');
      decryptedText += decipher.final('utf8');

      logger.debug('Successfully decrypted data', {
        algorithm: encryptedData.algorithm,
        decryptedLength: decryptedText.length
      });

      return decryptedText;
    } catch (error) {
      logger.error('Decryption failed', {
        error: error.message,
        algorithm: encryptedData.algorithm
      });
      throw new Error(`Decryption failed: ${error.message}`, { cause: error });
    }
  }

  /**
   * Encrypt data for database storage (JSON format)
   */
  async encryptForStorage(plaintext: string): Promise<string> {
    const encryptedData = await this.encrypt(plaintext);
    return JSON.stringify(encryptedData);
  }

  /**
   * Decrypt data from database storage (JSON format)
   */
  async decryptFromStorage(encryptedJson: string): Promise<string> {
    try {
      const encryptedData: EncryptedData = JSON.parse(encryptedJson);
      return await this.decrypt(encryptedData);
    } catch (error) {
      logger.error('Failed to decrypt from storage', { error: error.message });
      throw new Error(`Failed to decrypt from storage: ${error.message}`, { cause: error });
    }
  }

  /**
   * Generate a new encryption key (for key rotation)
   */
  generateNewKey(): string {
    const newKey = crypto.randomBytes(this.keyLength);
    return newKey.toString('hex');
  }

  /**
   * Validate if text appears to be encrypted
   */
  isEncrypted(text: string): boolean {
    try {
      const parsed = JSON.parse(text);
      return (
        parsed.encryptedText &&
        parsed.iv &&
        parsed.authTag &&
        parsed.algorithm === this.algorithm
      );
    } catch {
      return false;
    }
  }

  /**
   * Secure hash for audit trails (one-way)
   */
  createHash(text: string): string {
    return crypto
      .createHash('sha256')
      .update(text)
      .digest('hex');
  }

  /**
   * Mask sensitive data for logging
   */
  maskApiKey(apiKey: string): string {
    if (!apiKey || apiKey.length < 8) {
      return '[INVALID_KEY]';
    }

    const start = apiKey.substring(0, 4);
    const end = apiKey.substring(apiKey.length - 4);
    const masked = '*'.repeat(Math.max(4, apiKey.length - 8));

    return `${start}${masked}${end}`;
  }

  /**
   * Validate API key format before encryption
   */
  validateApiKeyFormat(provider: string, apiKey: string): { valid: boolean; error?: string } {
    if (!apiKey || apiKey.trim().length === 0) {
      return { valid: false, error: 'API key cannot be empty' };
    }

    const patterns = {
      openai: /^sk-(proj-)?[a-zA-Z0-9]{40,}$/,  // Supports both old (sk-...) and new (sk-proj-...) formats
      claude: /^sk-ant-[a-zA-Z0-9_-]{90,}$/,  // Allow hyphens and underscores in Claude keys
      gemini: /^[a-zA-Z0-9_-]{39}$/,
      grok: /^xai-[a-zA-Z0-9_-]{40,}$/,
      openrouter: /^sk-or-[a-zA-Z0-9_-]{40,}$/,
      lmstudio: null as RegExp | null, // No API key required for local
      'rule-based': null as RegExp | null // No API key required
    };

    const pattern = patterns[provider as keyof typeof patterns];

    if (pattern === null) {
      return { valid: true }; // No validation needed
    }

    if (pattern === undefined) {
      return { valid: false, error: `Unknown provider: ${provider}` };
    }

    if (!pattern.test(apiKey)) {
      return {
        valid: false,
        error: `Invalid ${provider} API key format`
      };
    }

    return { valid: true };
  }
}

// Singleton instance
export const encryptionService = new EncryptionService();
