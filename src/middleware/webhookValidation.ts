/**
 * Webhook Signature Validation Middleware
 *
 * HMAC signature validation for incoming webhooks with replay attack prevention.
 * Supports multiple provider signature schemes (Stripe, ShipStation, HubSpot, etc.)
 *
 * Phase 4 Implementation - SuiteCentral Parity
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger, type Logger } from '../utils/Logger';

// Extend Express Request to include webhook validation data
declare global {
  namespace Express {
    interface Request {
      webhookValidation?: {
        provider: string;
        signatureValid: boolean;
        timestampValid: boolean;
        payload: Buffer;
      };
    }
  }
}

export interface WebhookProviderConfig {
  /** Secret key for HMAC signature verification */
  secret: string;
  /** Header name containing the signature */
  signatureHeader: string;
  /** Header name containing the timestamp (optional) */
  timestampHeader?: string;
  /** Signature algorithm (default: sha256) */
  algorithm?: 'sha256' | 'sha512' | 'sha1';
  /** Signature encoding (default: hex) */
  encoding?: 'hex' | 'base64';
  /** Signature prefix to strip (e.g., 'sha256=' for GitHub) */
  signaturePrefix?: string;
  /** Maximum age in seconds for timestamp validation (default: 300 = 5 min) */
  maxTimestampAge?: number;
  /** Custom signature computation function */
  computeSignature?: (payload: Buffer, secret: string, timestamp?: string) => string;
}

// Pre-configured provider schemes
export const WEBHOOK_PROVIDERS: Record<string, Omit<WebhookProviderConfig, 'secret'>> = {
  stripe: {
    signatureHeader: 'stripe-signature',
    timestampHeader: 'stripe-signature', // Embedded in signature header
    algorithm: 'sha256',
    encoding: 'hex',
    maxTimestampAge: 300,
  },
  shipstation: {
    signatureHeader: 'x-shipstation-signature',
    algorithm: 'sha256',
    encoding: 'base64',
    maxTimestampAge: 300,
  },
  hubspot: {
    signatureHeader: 'x-hubspot-signature-v3',
    timestampHeader: 'x-hubspot-request-timestamp',
    algorithm: 'sha256',
    encoding: 'base64',
    maxTimestampAge: 300,
  },
  github: {
    signatureHeader: 'x-hub-signature-256',
    algorithm: 'sha256',
    encoding: 'hex',
    signaturePrefix: 'sha256=',
  },
  slack: {
    signatureHeader: 'x-slack-signature',
    timestampHeader: 'x-slack-request-timestamp',
    algorithm: 'sha256',
    encoding: 'hex',
    signaturePrefix: 'v0=',
    maxTimestampAge: 300,
  },
  netsuite: {
    signatureHeader: 'x-netsuite-signature',
    algorithm: 'sha256',
    encoding: 'base64',
    maxTimestampAge: 600,
  },
  generic: {
    signatureHeader: 'x-webhook-signature',
    timestampHeader: 'x-webhook-timestamp',
    algorithm: 'sha256',
    encoding: 'hex',
    maxTimestampAge: 300,
  },
};

export interface WebhookValidationOptions {
  /** Provider name (stripe, shipstation, hubspot, etc.) or 'custom' */
  provider: string;
  /** Secret key for signature validation */
  secret: string;
  /** Custom provider configuration (when provider is 'custom') */
  customConfig?: Omit<WebhookProviderConfig, 'secret'>;
  /** Skip validation in certain conditions */
  skipValidation?: (req: Request) => boolean;
  /** Reject request on validation failure (default: true) */
  rejectOnFailure?: boolean;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Parse Stripe-style signature header
 * Format: t=timestamp,v1=signature
 */
function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } {
  const parts = header.split(',');
  let timestamp = '';
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  return { timestamp, signatures };
}

/**
 * Compute expected signature for various providers
 */
function computeExpectedSignature(
  config: WebhookProviderConfig,
  payload: Buffer,
  timestamp?: string,
  provider?: string
): string {
  // Use custom signature computation if provided
  if (config.computeSignature) {
    return config.computeSignature(payload, config.secret, timestamp);
  }

  const algorithm = config.algorithm || 'sha256';
  const encoding = config.encoding || 'hex';

  let data: string | Buffer = payload;

  // Some providers include timestamp in the signed payload
  if (timestamp && provider === 'stripe') {
    // Stripe format: timestamp.payload
    data = `${timestamp}.${payload.toString('utf8')}`;
  } else if (timestamp && provider === 'slack') {
    // Slack format: v0:timestamp:payload
    data = `v0:${timestamp}:${payload.toString('utf8')}`;
  } else if (timestamp && provider === 'hubspot') {
    // HubSpot format: method + url + body + timestamp
    data = payload.toString('utf8') + timestamp;
  }

  const hmac = crypto.createHmac(algorithm, config.secret);
  hmac.update(data);
  return hmac.digest(encoding);
}

/**
 * Constant-time signature comparison to prevent timing attacks
 */
function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare dummy buffer to maintain constant time
    const dummy = Buffer.alloc(32);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Create webhook signature validation middleware
 */
export function validateWebhookSignature(options: WebhookValidationOptions) {
  const log = options.logger || logger;
  const rejectOnFailure = options.rejectOnFailure !== false;

  // Get provider config
  let providerConfig: Omit<WebhookProviderConfig, 'secret'>;
  if (options.provider === 'custom' && options.customConfig) {
    providerConfig = options.customConfig;
  } else if (WEBHOOK_PROVIDERS[options.provider]) {
    providerConfig = WEBHOOK_PROVIDERS[options.provider];
  } else {
    providerConfig = WEBHOOK_PROVIDERS.generic;
  }

  const config: WebhookProviderConfig & { provider: string } = {
    ...providerConfig,
    secret: options.secret,
    provider: options.provider,
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check if validation should be skipped
      if (options.skipValidation && options.skipValidation(req)) {
        req.webhookValidation = {
          provider: options.provider,
          signatureValid: true,
          timestampValid: true,
          payload: Buffer.from(''),
        };
        return next();
      }

      // Get raw body (requires express.raw() middleware)
      const rawBody = req.body as Buffer;
      if (!Buffer.isBuffer(rawBody)) {
        log.warn('Webhook validation failed: request body not available as Buffer', {
          provider: options.provider,
          path: req.path,
        });

        if (rejectOnFailure) {
          return res.status(400).json({
            error: 'Invalid request',
            message: 'Webhook body must be raw',
          });
        }

        req.webhookValidation = {
          provider: options.provider,
          signatureValid: false,
          timestampValid: false,
          payload: Buffer.from(''),
        };
        return next();
      }

      // Get signature header
      const signatureHeader = req.headers[config.signatureHeader.toLowerCase()] as string;
      if (!signatureHeader) {
        log.warn('Webhook validation failed: missing signature header', {
          provider: options.provider,
          header: config.signatureHeader,
          path: req.path,
        });

        if (rejectOnFailure) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing webhook signature',
          });
        }

        req.webhookValidation = {
          provider: options.provider,
          signatureValid: false,
          timestampValid: false,
          payload: rawBody,
        };
        return next();
      }

      // Handle Stripe-style embedded timestamp
      let timestamp: string | undefined;
      let signatures: string[];

      if (options.provider === 'stripe') {
        const parsed = parseStripeSignature(signatureHeader);
        timestamp = parsed.timestamp;
        signatures = parsed.signatures;
      } else {
        // Get timestamp from separate header if configured
        if (config.timestampHeader) {
          timestamp = req.headers[config.timestampHeader.toLowerCase()] as string;
        }

        // Extract signature, stripping prefix if configured
        let sig = signatureHeader;
        if (config.signaturePrefix && sig.startsWith(config.signaturePrefix)) {
          sig = sig.slice(config.signaturePrefix.length);
        }
        signatures = [sig];
      }

      // Validate timestamp if configured
      let timestampValid = true;
      if (config.maxTimestampAge && timestamp) {
        const timestampSeconds = parseInt(timestamp, 10);
        const currentSeconds = Math.floor(Date.now() / 1000);
        const age = Math.abs(currentSeconds - timestampSeconds);

        if (age > config.maxTimestampAge) {
          log.warn('Webhook validation failed: timestamp too old', {
            provider: options.provider,
            timestampAge: age,
            maxAge: config.maxTimestampAge,
            path: req.path,
          });

          timestampValid = false;

          if (rejectOnFailure) {
            return res.status(401).json({
              error: 'Unauthorized',
              message: 'Webhook timestamp expired',
            });
          }
        }
      }

      // Compute expected signature
      const expectedSignature = computeExpectedSignature(config, rawBody, timestamp, options.provider);

      // Validate signature (check all provided signatures for Stripe-style)
      const signatureValid = signatures.some(sig => secureCompare(sig, expectedSignature));

      if (!signatureValid) {
        log.warn('Webhook validation failed: invalid signature', {
          provider: options.provider,
          path: req.path,
        });

        if (rejectOnFailure) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid webhook signature',
          });
        }
      }

      // Attach validation result to request
      req.webhookValidation = {
        provider: options.provider,
        signatureValid,
        timestampValid,
        payload: rawBody,
      };

      log.debug('Webhook signature validated', {
        provider: options.provider,
        signatureValid,
        timestampValid,
        path: req.path,
      });

      next();
    } catch (error) {
      log.error('Webhook validation error', {
        provider: options.provider,
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
      });

      if (rejectOnFailure) {
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Webhook validation failed',
        });
      }

      req.webhookValidation = {
        provider: options.provider,
        signatureValid: false,
        timestampValid: false,
        payload: Buffer.from(''),
      };
      next();
    }
  };
}

/**
 * Verify a webhook signature manually (for use outside middleware)
 */
export function verifyWebhookSignature(
  payload: Buffer | string,
  signature: string,
  secret: string,
  options: {
    algorithm?: 'sha256' | 'sha512' | 'sha1';
    encoding?: 'hex' | 'base64';
    signaturePrefix?: string;
  } = {}
): boolean {
  const algorithm = options.algorithm || 'sha256';
  const encoding = options.encoding || 'hex';

  // Strip prefix if present
  let sig = signature;
  if (options.signaturePrefix && sig.startsWith(options.signaturePrefix)) {
    sig = sig.slice(options.signaturePrefix.length);
  }

  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const hmac = crypto.createHmac(algorithm, secret);
  hmac.update(payloadBuffer);
  const expected = hmac.digest(encoding);

  return secureCompare(sig, expected);
}

/**
 * Generate a webhook signature (for testing or sending webhooks)
 */
export function generateWebhookSignature(
  payload: Buffer | string,
  secret: string,
  options: {
    algorithm?: 'sha256' | 'sha512' | 'sha1';
    encoding?: 'hex' | 'base64';
    signaturePrefix?: string;
    timestamp?: number;
  } = {}
): { signature: string; timestamp?: number } {
  const algorithm = options.algorithm || 'sha256';
  const encoding = options.encoding || 'hex';
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000);

  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const hmac = crypto.createHmac(algorithm, secret);
  hmac.update(payloadBuffer);
  const rawSignature = hmac.digest(encoding);

  const signature = options.signaturePrefix
    ? `${options.signaturePrefix}${rawSignature}`
    : rawSignature;

  return { signature, timestamp };
}
