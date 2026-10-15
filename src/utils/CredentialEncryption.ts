import * as crypto from 'crypto';

/**
 * Credential Encryption Utility
 *
 * Provides AES-256-GCM encryption/decryption for connector credentials
 * with automatic IV generation and authentication tag verification.
 *
 * Security Features:
 * - AES-256-GCM authenticated encryption
 * - Random IV for each encryption operation
 * - Authentication tag prevents tampering
 * - Key derivation from environment variable
 *
 * Encrypted Format: [IV (12 bytes)][Auth Tag (16 bytes)][Encrypted Data]
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes (96 bits) for GCM
const AUTH_TAG_LENGTH = 16; // 16 bytes (128 bits)
const KEY_LENGTH = 32; // 32 bytes (256 bits)

export class CredentialEncryption {
  private static encryptionKey: Buffer | null = null;

  /**
   * Initialize encryption key from environment variable
   * Key should be 32-byte base64-encoded string
   */
  private static getEncryptionKey(): Buffer {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const keyEnv = process.env.ENCRYPTION_KEY;

    if (!keyEnv) {
      throw new Error(
        'ENCRYPTION_KEY environment variable not set. ' +
        'Generate a secure key with: node -e "console.log(crypto.randomBytes(32).toString(\'base64\'))"'
      );
    }

    try {
      this.encryptionKey = Buffer.from(keyEnv, 'base64');

      if (this.encryptionKey.length !== KEY_LENGTH) {
        throw new Error(
          `ENCRYPTION_KEY must be ${KEY_LENGTH} bytes (base64-encoded). ` +
          `Current key length: ${this.encryptionKey.length} bytes. ` +
          'Generate a new key with: node -e "console.log(crypto.randomBytes(32).toString(\'base64\'))"'
        );
      }

      return this.encryptionKey;
    } catch (error) {
      throw new Error(
        `Invalid ENCRYPTION_KEY format. Must be base64-encoded 32-byte string. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Encrypt credentials object to base64 string
   *
   * @param credentials - Object containing credential fields
   * @returns Base64-encoded encrypted string with IV and auth tag
   *
   * @example
   * const encrypted = CredentialEncryption.encrypt({
   *   accountId: 'ACCT123',
   *   apiKey: 'secret-key'
   * });
   */
  static encrypt(credentials: Record<string, unknown>): string {
    try {
      // Convert credentials to JSON string
      const plaintext = JSON.stringify(credentials);

      // Generate random IV for this encryption
      const iv = crypto.randomBytes(IV_LENGTH);

      // Create cipher with key and IV
      const cipher = crypto.createCipheriv(ALGORITHM, this.getEncryptionKey(), iv);

      // Encrypt the plaintext
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
      ]);

      // Get authentication tag
      const authTag = cipher.getAuthTag();

      // Combine IV + auth tag + encrypted data
      const combined = Buffer.concat([iv, authTag, encrypted]);

      // Return as base64
      return combined.toString('base64');
    } catch (error) {
      throw new Error(
        `Credential encryption failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Decrypt base64 string to credentials object
   *
   * @param encryptedData - Base64-encoded encrypted string
   * @returns Decrypted credentials object
   *
   * @example
   * const credentials = CredentialEncryption.decrypt(encryptedString);
   * console.log(credentials.apiKey); // 'secret-key'
   */
  static decrypt(encryptedData: string): Record<string, unknown> {
    try {
      // Decode from base64
      const combined = Buffer.from(encryptedData, 'base64');

      // Extract IV (first 12 bytes)
      const iv = combined.subarray(0, IV_LENGTH);

      // Extract auth tag (next 16 bytes)
      const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);

      // Extract encrypted data (remaining bytes)
      const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

      // Create decipher with key and IV
      const decipher = crypto.createDecipheriv(ALGORITHM, this.getEncryptionKey(), iv);

      // Set auth tag for verification
      decipher.setAuthTag(authTag);

      // Decrypt the data
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);

      // Parse JSON and return
      return JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
      // Authentication tag verification failure indicates tampering
      if (error instanceof Error && error.message.includes('Unsupported state or unable to authenticate data')) {
        throw new Error(
          'Credential decryption failed: Authentication failed. ' +
          'Data may have been tampered with or encryption key is incorrect.',
          { cause: error }
        );
      }

      throw new Error(
        `Credential decryption failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Generate a new random encryption key (for setup/testing)
   *
   * @returns Base64-encoded 32-byte encryption key
   *
   * @example
   * const newKey = CredentialEncryption.generateKey();
   * console.log('ENCRYPTION_KEY=' + newKey);
   */
  static generateKey(): string {
    return crypto.randomBytes(KEY_LENGTH).toString('base64');
  }

  /**
   * Test if encryption key is properly configured
   *
   * @returns true if key is valid, false otherwise
   */
  static isKeyConfigured(): boolean {
    try {
      this.getEncryptionKey();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sanitize credentials for logging (redact sensitive fields)
   *
   * @param credentials - Credentials object
   * @returns Sanitized object with sensitive fields redacted
   *
   * @example
   * const sanitized = CredentialEncryption.sanitize({
   *   accountId: 'ACCT123',
   *   apiKey: 'secret-key'
   * });
   * // Returns: { accountId: 'ACCT123', apiKey: '[REDACTED]' }
   */
  static sanitize(credentials: Record<string, unknown>): Record<string, unknown> {
    const sensitiveFields = [
      'password',
      'secret',
      'token',
      'key',
      'apiKey',
      'api_key',
      'consumerSecret',
      'consumer_secret',
      'tokenSecret',
      'token_secret',
      'clientSecret',
      'client_secret'
    ];

    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(credentials)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = sensitiveFields.some(field => lowerKey.includes(field.toLowerCase()));

      if (isSensitive && value) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Clear cached encryption key (for testing)
   * @private
   */
  static _clearKeyCache(): void {
    this.encryptionKey = null;
  }
}
