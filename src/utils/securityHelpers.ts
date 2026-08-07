/**
 * Shared security utility functions
 * Centralized to avoid code duplication across security middleware
 *
 * @module utils/securityHelpers
 */

import crypto from 'crypto';

/**
 * SECURITY: Sensitive field patterns for data masking
 * Used to prevent exposure of passwords, tokens, keys in log files
 */
export const SENSITIVE_FIELD_PATTERNS = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'key', 'apikey', 'api_key',
  'authorization', 'auth', 'credential', 'private', 'bearer', 'session',
  'cookie', 'csrf', 'xsrf', 'refresh', 'access_token', 'client_secret'
];

/**
 * SECURITY: Mask sensitive fields before logging
 * Prevents exposure of passwords, tokens, keys in log files
 *
 * @param obj - The object to mask
 * @param depth - Current recursion depth (internal use)
 * @returns Masked copy of the object
 */
export function maskSensitiveData(obj: unknown, depth = 0): unknown {
  // Prevent deep recursion attacks
  if (depth > 10) return '[MAX_DEPTH_EXCEEDED]';

  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Truncate long strings
    return obj.length > 100 ? `${obj.substring(0, 100)}...[truncated]` : obj;
  }

  if (Array.isArray(obj)) {
    // Limit array logging
    const limited = obj.slice(0, 5).map(item => maskSensitiveData(item, depth + 1));
    if (obj.length > 5) limited.push(`[...${obj.length - 5} more items]`);
    return limited;
  }

  if (typeof obj === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      const isSensitive = SENSITIVE_FIELD_PATTERNS.some(pattern => keyLower.includes(pattern));
      if (isSensitive) {
        masked[key] = '[REDACTED]';
      } else {
        masked[key] = maskSensitiveData(value, depth + 1);
      }
    }
    return masked;
  }

  return obj;
}

/**
 * SECURITY: Timing-safe string comparison to prevent timing attacks
 *
 * Uses SHA-256 hashing to ensure constant-time comparison regardless of
 * input lengths. This prevents timing side-channel attacks that could
 * reveal information about the secret.
 *
 * Why hashing? Direct buffer comparison with variable-length inputs can leak
 * timing information. By hashing both inputs first, we always compare
 * fixed 32-byte digests, ensuring truly constant-time execution.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns True if strings are equal
 */
export function timingSafeCompare(a: string, b: string): boolean {
  // Hash both inputs to get fixed 32-byte digests
  // This ensures we always compare the full content regardless of length
  const aHash = crypto.createHash('sha256').update(a).digest();
  const bHash = crypto.createHash('sha256').update(b).digest();

  // Timing-safe comparison of the hashes
  // crypto.timingSafeEqual requires equal-length buffers, which hashes guarantee
  return crypto.timingSafeEqual(aHash, bHash);
}
