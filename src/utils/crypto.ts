import crypto from "crypto";
import { Logger } from "./Logger";

const logger = new Logger("CryptoUtils");

/**
 * Cryptographic utility functions for secure operations
 */
export class CryptoUtils {

  /**
   * Generate a cryptographically secure random JWT secret
   * @param length The length of the secret (default: 64)
   * @returns A secure random string suitable for JWT signing
   */
  static generateJWTSecret(length = 64): string {
    const randomBytes = crypto.randomBytes(Math.ceil(length * 3 / 4));
    const secret = randomBytes.toString("base64").slice(0, length);

    logger.info("Generated new JWT secret", {
      length: secret.length,
      type: "security",
    });

    return secret;
  }

  /**
   * Generate a secure random API key
   * @param prefix Optional prefix for the key
   * @param length The length of the random part (default: 32)
   * @returns A secure API key
   */
  static generateApiKey(prefix?: string, length = 32): string {
    const randomPart = crypto.randomBytes(length).toString("hex");
    const apiKey = prefix ? `${prefix}_${randomPart}` : randomPart;

    logger.info("Generated new API key", {
      hasPrefix: !!prefix,
      totalLength: apiKey.length,
      type: "security",
    });

    return apiKey;
  }

  /**
   * Generate a secure random password
   * @param length The length of the password (default: 16)
   * @param includeSymbols Whether to include symbols (default: true)
   * @param options Complexity options
   * @param options.minUppercase Minimum uppercase characters (default: 1)
   * @param options.minDigits Minimum numeric characters (default: 1)
   * @param options.minSymbols Minimum symbol characters (default: 1 if symbols are included, otherwise 0)
   * @returns A secure random password
   */
  static generatePassword(
    length = 16,
    includeSymbols = true,
    options: {
      minUppercase?: number;
      minDigits?: number;
      minSymbols?: number;
    } = {},
  ): string {
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const numbers = "0123456789";
    const symbols = "!@#$%^&*()_+-=[]{}|;:,.<>?";

    const minUppercase = options.minUppercase ?? 1;
    const minDigits = options.minDigits ?? 1;
    const minSymbols = includeSymbols ? options.minSymbols ?? 1 : 0;

    // Validate length against complexity requirements
    const requiredChars = 1 + minUppercase + minDigits + minSymbols;
    if (length < requiredChars) {
      throw new Error("Password length too short for the given complexity requirements");
    }

    let charset = lowercase + uppercase + numbers;
    if (includeSymbols) {
      charset += symbols;
    }

    const passwordChars: string[] = [];

    // Ensure at least one lowercase character
    passwordChars.push(this.getRandomChar(lowercase));

    // Add required uppercase characters
    for (let i = 0; i < minUppercase; i++) {
      passwordChars.push(this.getRandomChar(uppercase));
    }

    // Add required digits
    for (let i = 0; i < minDigits; i++) {
      passwordChars.push(this.getRandomChar(numbers));
    }

    // Add required symbols if needed
    for (let i = 0; i < minSymbols; i++) {
      passwordChars.push(this.getRandomChar(symbols));
    }

    // Fill the rest randomly
    while (passwordChars.length < length) {
      passwordChars.push(this.getRandomChar(charset));
    }

    // Shuffle the password to avoid predictable patterns
    return this.shuffleString(passwordChars.join(""));
  }

  /**
   * Hash a password using bcrypt-compatible algorithm
   * @param password The password to hash
   * @param saltRounds The number of salt rounds (default: 12)
   * @returns Promise resolving to the hashed password
   */
  static async hashPassword(password: string, saltRounds = 12): Promise<string> {
    const bcrypt = await import("bcryptjs");
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * Verify a password against a hash
   * @param password The plain text password
   * @param hash The hashed password
   * @returns Promise resolving to boolean indicating match
   */
  static async verifyPassword(password: string, hash: string): Promise<boolean> {
    const bcrypt = await import("bcryptjs");
    return bcrypt.compare(password, hash);
  }

  /**
   * Generate a secure random token for one-time use
   * @param length The length in bytes (default: 32)
   * @returns A hex-encoded random token
   */
  static generateToken(length = 32): string {
    return crypto.randomBytes(length).toString("hex");
  }

  /**
   * Generate a UUID v4
   * @returns A UUID v4 string
   */
  static generateUUID(): string {
    return crypto.randomUUID();
  }

  /**
   * Create a secure hash of data using SHA-256
   * @param data The data to hash
   * @param encoding The output encoding (default: 'hex')
   * @returns The hash string
   */
  static hash(data: string, encoding: "hex" | "base64" = "hex"): string {
    return crypto.createHash("sha256").update(data).digest(encoding);
  }

  /**
   * Create an HMAC signature
   * @param data The data to sign
   * @param secret The secret key
   * @param algorithm The HMAC algorithm (default: 'sha256')
   * @returns The HMAC signature
   */
  static hmac(data: string, secret: string, algorithm = "sha256"): string {
    return crypto.createHmac(algorithm, secret).update(data).digest("hex");
  }

  /**
   * Encrypt data using AES-256-GCM
   * @param data The data to encrypt
   * @param key The encryption key (32 bytes)
   * @returns Object containing encrypted data, IV, and auth tag
   */
  static encrypt(data: string, key: Buffer): { encrypted: string; iv: string; authTag: string } {
    if (key.length !== 32) {
      throw new Error("Encryption key must be 32 bytes");
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("integration-hub", "utf8"));

    let encrypted = cipher.update(data, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
    };
  }

  /**
   * Decrypt data using AES-256-GCM
   * @param encryptedData The encrypted data object
   * @param key The decryption key (32 bytes)
   * @returns The decrypted string
   */
  static decrypt(
    encryptedData: { encrypted: string; iv: string; authTag: string },
    key: Buffer,
  ): string {
    if (key.length !== 32) {
      throw new Error("Decryption key must be 32 bytes");
    }

    const iv = Buffer.from(encryptedData.iv, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from("integration-hub", "utf8"));
    decipher.setAuthTag(Buffer.from(encryptedData.authTag, "hex"));

    let decrypted = decipher.update(encryptedData.encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Timing-safe string comparison
   * @param a First string
   * @param b Second string
   * @returns Boolean indicating equality
   */
  static timingSafeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, "utf8");
    const bufferB = Buffer.from(b, "utf8");

    if (bufferA.length !== bufferB.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufferA, bufferB);
  }

  /**
   * Generate a cryptographically secure random integer
   * @param min Minimum value (inclusive)
   * @param max Maximum value (inclusive)
   * @returns Random integer
   */
  static randomInt(min: number, max: number): number {
    return crypto.randomInt(min, max + 1);
  }

  /**
   * Validate the entropy of a secret
   * @param secret The secret to validate
   * @returns Entropy analysis object
   */
  static analyzeEntropy(secret: string): {
    length: number;
    uniqueChars: number;
    estimatedBits: number;
    strength: "weak" | "fair" | "good" | "strong";
  } {
    const length = secret.length;
    const uniqueChars = new Set(secret).size;

    // Simple entropy estimation
    const estimatedBits = Math.log2(Math.pow(uniqueChars, length));

    let strength: "weak" | "fair" | "good" | "strong";
    if (estimatedBits < 40) {
      strength = "weak";
    } else if (estimatedBits < 64) {
      strength = "fair";
    } else if (estimatedBits < 128) {
      strength = "good";
    } else {
      strength = "strong";
    }

    return {
      length,
      uniqueChars,
      estimatedBits: Math.round(estimatedBits),
      strength,
    };
  }

  /**
   * Get a random character from a charset
   */
  private static getRandomChar(charset: string): string {
    const randomIndex = crypto.randomInt(0, charset.length);
    return charset[randomIndex]!;
  }

  /**
   * Shuffle a string randomly
   */
  private static shuffleString(str: string): string {
    const array = str.split("");
    for (let i = array.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      const temp = array[i] || "";
      array[i] = array[j] || "";
      array[j] = temp;
    }
    return array.join("");
  }
}

/**
 * CLI utility to generate secure secrets
 */
export function generateSecureJWTSecret(showSecret = false): void {
  const secret = CryptoUtils.generateJWTSecret(64);
  const analysis = CryptoUtils.analyzeEntropy(secret);

  logger.info("Generated secure JWT secret");

  if (showSecret) {
    logger.warn("Displaying generated JWT secret at user request");
    logger.info(`JWT_SECRET=${secret}`);
    logger.info("Entropy analysis", { analysis });
  } else {
    logger.info(
      "Secret generation complete. Use --show-secret flag or set DEBUG=true to display it.",
    );
  }

  logger.warn("Store this secret securely and never commit it to version control!");
}

// Export for CLI usage
if (require.main === module) {
  const showSecret =
    process.argv.includes("--show-secret") || process.env.DEBUG === "true";
  generateSecureJWTSecret(showSecret);
}
