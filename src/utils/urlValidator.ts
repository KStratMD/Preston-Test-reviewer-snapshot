/**
 * SECURITY: URL validation utility for SSRF protection
 *
 * Validates URLs to prevent Server-Side Request Forgery (SSRF) attacks
 * by blocking requests to internal/private IP addresses and localhost.
 *
 * @module utils/urlValidator
 */

import { URL } from 'url';
import dns from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(dns.lookup);

/**
 * Configuration for URL validation
 */
export interface UrlValidationConfig {
  /** Allow localhost URLs (default: false in production, true in development) */
  allowLocalhost?: boolean;
  /** Allow private IP ranges (10.x, 172.16-31.x, 192.168.x) (default: false) */
  allowPrivateIps?: boolean;
  /** Allow loopback addresses (127.x.x.x, ::1) (default: false in production) */
  allowLoopback?: boolean;
  /** Allowed protocols (default: ['https:', 'http:']) */
  allowedProtocols?: string[];
  /** Blocked hostnames (e.g., 'metadata.google.internal') */
  blockedHostnames?: string[];
  /** Skip DNS resolution check (default: false) */
  skipDnsCheck?: boolean;
}

const DEFAULT_CONFIG: Required<UrlValidationConfig> = {
  allowLocalhost: process.env.NODE_ENV !== 'production',
  allowPrivateIps: false,
  allowLoopback: process.env.NODE_ENV !== 'production',
  allowedProtocols: ['https:', 'http:'],
  blockedHostnames: [
    'metadata.google.internal',       // GCP metadata
    '169.254.169.254',               // AWS/Azure/GCP metadata
    'metadata.azure.com',             // Azure metadata
    'instance-data',                  // AWS metadata
    'kubernetes.default.svc',         // Kubernetes
    'kubernetes.default',
  ],
  skipDnsCheck: false,
};

/**
 * Check if an IP address is in a private range
 */
function isPrivateIp(ip: string): boolean {
  // IPv4 private ranges
  const privateRanges = [
    /^10\./,                          // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // 172.16.0.0/12
    /^192\.168\./,                    // 192.168.0.0/16
    /^127\./,                         // 127.0.0.0/8 (loopback)
    /^0\./,                           // 0.0.0.0/8
    /^169\.254\./,                    // 169.254.0.0/16 (link-local)
    /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,  // 100.64.0.0/10 (CGN)
  ];

  // IPv6 private/special ranges
  const ipv6Private = [
    /^::1$/,                          // Loopback
    /^fe80:/i,                        // Link-local
    /^fc00:/i,                        // Unique local
    /^fd00:/i,                        // Unique local
    /^::ffff:(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/i, // IPv4-mapped
  ];

  for (const range of privateRanges) {
    if (range.test(ip)) return true;
  }

  for (const range of ipv6Private) {
    if (range.test(ip)) return true;
  }

  return false;
}

/**
 * Check if an IP is a loopback address
 */
function isLoopback(ip: string): boolean {
  return /^127\./.test(ip) || ip === '::1' || ip === '0.0.0.0';
}

/**
 * Check if hostname is localhost
 */
function isLocalhost(hostname: string): boolean {
  const localhostNames = ['localhost', 'localhost.localdomain', '127.0.0.1', '::1', '0.0.0.0'];
  return localhostNames.includes(hostname.toLowerCase());
}

/**
 * Check if string is a valid IPv4 address (with proper octet validation 0-255)
 */
function isValidIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  for (const part of parts) {
    // Must be a number with no leading zeros (except "0" itself)
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false;

    const num = parseInt(part, 10);
    if (num < 0 || num > 255) return false;
  }
  return true;
}

/**
 * Check if string is a valid IPv6 address format
 * Validates proper group count (max 8), hex format, and handles compression (::)
 */
function isValidIPv6(ip: string): boolean {
  // Handle common special cases
  if (ip === '::' || ip === '::1') return true;

  // Must contain at least one colon
  if (!ip.includes(':')) return false;

  // Check for IPv4-mapped IPv6 (e.g., ::ffff:192.0.2.1)
  const ipv4MappedMatch = ip.match(/^(.*):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4MappedMatch) {
    const ipv6Part = ipv4MappedMatch[1];
    const ipv4Part = ipv4MappedMatch[2];
    // Validate the IPv4 portion
    if (!isValidIPv4(ipv4Part)) return false;
    // IPv4 counts as 2 groups, so the IPv6 portion must have at most 6 groups
    // Recursively validate the IPv6 prefix (treating it as if it ends with ::)
    const prefixGroups = ipv6Part.replace(/::$/, '').split(':').filter(g => g !== '').length;
    const hasCompression = ipv6Part.includes('::');
    if (hasCompression) {
      return prefixGroups <= 6;
    }
    return prefixGroups === 6;
  }

  // Split on :: for compressed notation
  const parts = ip.split('::');
  if (parts.length > 2) return false; // Can only have one ::

  // Helper to validate hex groups
  const isHexGroup = (g: string): boolean => /^[0-9a-f]{1,4}$/i.test(g);

  // Count groups in each part
  const leftGroups = parts[0] ? parts[0].split(':').filter(g => g !== '') : [];
  const rightGroups = parts.length === 2 && parts[1] ? parts[1].split(':').filter(g => g !== '') : [];

  // Validate all groups are valid hex
  if (!leftGroups.every(isHexGroup)) return false;
  if (!rightGroups.every(isHexGroup)) return false;

  const totalGroups = leftGroups.length + rightGroups.length;

  if (parts.length === 2) {
    // Compressed notation - total must be less than 8 (:: represents at least one group)
    return totalGroups < 8;
  } else {
    // Full notation - must have exactly 8 groups
    return totalGroups === 8;
  }
}

/**
 * Validation result
 */
export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  url?: URL;
  resolvedIp?: string;
}

/**
 * Validate a URL for SSRF safety
 *
 * @param urlString - The URL to validate
 * @param config - Optional configuration overrides
 * @returns Validation result with error message if invalid
 *
 * @example
 * ```typescript
 * // Basic validation
 * const result = await validateUrlForSsrf('https://api.example.com/data');
 * if (!result.valid) {
 *   throw new Error(`SSRF blocked: ${result.error}`);
 * }
 *
 * // Allow localhost in development
 * const result = await validateUrlForSsrf(url, { allowLocalhost: true });
 * ```
 */
export async function validateUrlForSsrf(
  urlString: string,
  config: UrlValidationConfig = {}
): Promise<UrlValidationResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Parse URL
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check protocol
  if (!mergedConfig.allowedProtocols.includes(url.protocol)) {
    return {
      valid: false,
      error: `Protocol '${url.protocol}' not allowed. Allowed: ${mergedConfig.allowedProtocols.join(', ')}`,
    };
  }

  const hostname = url.hostname.toLowerCase();

  // Check blocked hostnames
  if (mergedConfig.blockedHostnames.some(blocked => hostname === blocked || hostname.endsWith('.' + blocked))) {
    return { valid: false, error: `Hostname '${hostname}' is blocked for security reasons` };
  }

  // Check localhost
  if (isLocalhost(hostname) && !mergedConfig.allowLocalhost) {
    return { valid: false, error: 'Localhost URLs are not allowed in production' };
  }

  // If hostname is an IP address, check directly using proper validation functions
  // that verify octet ranges (0-255 for IPv4) and proper format
  if (isValidIPv4(hostname) || isValidIPv6(hostname)) {
    if (isLoopback(hostname) && !mergedConfig.allowLoopback) {
      return { valid: false, error: 'Loopback addresses are not allowed' };
    }
    if (isPrivateIp(hostname) && !mergedConfig.allowPrivateIps) {
      return { valid: false, error: 'Private IP addresses are not allowed' };
    }
    return { valid: true, url, resolvedIp: hostname };
  }

  // DNS resolution check to catch DNS rebinding attacks
  if (!mergedConfig.skipDnsCheck) {
    try {
      const { address } = await dnsLookup(hostname);

      if (isLoopback(address) && !mergedConfig.allowLoopback) {
        return { valid: false, error: `DNS resolved to loopback address: ${address}` };
      }
      if (isPrivateIp(address) && !mergedConfig.allowPrivateIps) {
        return { valid: false, error: `DNS resolved to private IP: ${address}` };
      }

      return { valid: true, url, resolvedIp: address };
    } catch (dnsError) {
      // DNS resolution failed - could be a non-existent domain
      return {
        valid: false,
        error: `DNS resolution failed for '${hostname}': ${dnsError instanceof Error ? dnsError.message : 'Unknown error'}`,
      };
    }
  }

  return { valid: true, url };
}

/**
 * Synchronous URL validation (without DNS check)
 * Use this when async is not possible, but note it doesn't protect against DNS rebinding
 */
export function validateUrlForSsrfSync(
  urlString: string,
  config: UrlValidationConfig = {}
): UrlValidationResult {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config, skipDnsCheck: true };

  // Parse URL
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check protocol
  if (!mergedConfig.allowedProtocols.includes(url.protocol)) {
    return {
      valid: false,
      error: `Protocol '${url.protocol}' not allowed`,
    };
  }

  const hostname = url.hostname.toLowerCase();

  // Check blocked hostnames
  if (mergedConfig.blockedHostnames.some(blocked => hostname === blocked || hostname.endsWith('.' + blocked))) {
    return { valid: false, error: `Hostname '${hostname}' is blocked` };
  }

  // Check localhost
  if (isLocalhost(hostname) && !mergedConfig.allowLocalhost) {
    return { valid: false, error: 'Localhost URLs are not allowed' };
  }

  // Check if hostname is an IP using proper validation functions
  if (isValidIPv4(hostname) || isValidIPv6(hostname)) {
    if (isLoopback(hostname) && !mergedConfig.allowLoopback) {
      return { valid: false, error: 'Loopback addresses are not allowed' };
    }
    if (isPrivateIp(hostname) && !mergedConfig.allowPrivateIps) {
      return { valid: false, error: 'Private IP addresses are not allowed' };
    }
  }

  return { valid: true, url };
}
