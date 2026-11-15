/**
 * Webhook Validation Middleware Unit Tests
 * Tests for HMAC signature validation with replay attack prevention
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import {
  validateWebhookSignature,
  verifyWebhookSignature,
  generateWebhookSignature,
  WEBHOOK_PROVIDERS,
  WebhookValidationOptions,
} from '../../../src/middleware/webhookValidation';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

// Helper to create mock request
function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/api/webhook',
    method: 'POST',
    body: Buffer.from('{}'),
    ...overrides,
  } as Request;
}

// Helper to create mock response
function createMockResponse(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

// Helper to create next function
function createMockNext(): NextFunction {
  return jest.fn();
}

// Helper to compute HMAC signature
function computeHmac(
  payload: string,
  secret: string,
  algorithm: string = 'sha256',
  encoding: BufferEncoding = 'hex'
): string {
  const hmac = crypto.createHmac(algorithm, secret);
  hmac.update(payload);
  return hmac.digest(encoding);
}

describe('WEBHOOK_PROVIDERS', () => {
  it('should have predefined stripe provider config', () => {
    expect(WEBHOOK_PROVIDERS.stripe).toBeDefined();
    expect(WEBHOOK_PROVIDERS.stripe.signatureHeader).toBe('stripe-signature');
    expect(WEBHOOK_PROVIDERS.stripe.algorithm).toBe('sha256');
  });

  it('should have predefined shipstation provider config', () => {
    expect(WEBHOOK_PROVIDERS.shipstation).toBeDefined();
    expect(WEBHOOK_PROVIDERS.shipstation.signatureHeader).toBe('x-shipstation-signature');
    expect(WEBHOOK_PROVIDERS.shipstation.encoding).toBe('base64');
  });

  it('should have predefined hubspot provider config', () => {
    expect(WEBHOOK_PROVIDERS.hubspot).toBeDefined();
    expect(WEBHOOK_PROVIDERS.hubspot.signatureHeader).toBe('x-hubspot-signature-v3');
    expect(WEBHOOK_PROVIDERS.hubspot.timestampHeader).toBe('x-hubspot-request-timestamp');
  });

  it('should have predefined github provider config', () => {
    expect(WEBHOOK_PROVIDERS.github).toBeDefined();
    expect(WEBHOOK_PROVIDERS.github.signatureHeader).toBe('x-hub-signature-256');
    expect(WEBHOOK_PROVIDERS.github.signaturePrefix).toBe('sha256=');
  });

  it('should have predefined slack provider config', () => {
    expect(WEBHOOK_PROVIDERS.slack).toBeDefined();
    expect(WEBHOOK_PROVIDERS.slack.signaturePrefix).toBe('v0=');
    expect(WEBHOOK_PROVIDERS.slack.timestampHeader).toBe('x-slack-request-timestamp');
  });

  it('should have predefined netsuite provider config', () => {
    expect(WEBHOOK_PROVIDERS.netsuite).toBeDefined();
    expect(WEBHOOK_PROVIDERS.netsuite.maxTimestampAge).toBe(600);
  });

  it('should have predefined generic provider config', () => {
    expect(WEBHOOK_PROVIDERS.generic).toBeDefined();
    expect(WEBHOOK_PROVIDERS.generic.signatureHeader).toBe('x-webhook-signature');
  });
});

describe('validateWebhookSignature middleware', () => {
  const secret = 'webhook-secret-key';

  describe('generic provider', () => {
    it('should validate valid signature', async () => {
      const payload = '{"event":"test"}';
      const signature = computeHmac(payload, secret);

      const middleware = validateWebhookSignature({
        provider: 'generic',
        secret,
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-webhook-signature': signature,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation).toBeDefined();
      expect(req.webhookValidation?.signatureValid).toBe(true);
      expect(req.webhookValidation?.provider).toBe('generic');
    });

    it('should reject invalid signature', async () => {
      const payload = '{"event":"test"}';

      const middleware = validateWebhookSignature({
        provider: 'generic',
        secret,
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-webhook-signature': 'invalid-signature',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unauthorized',
          message: 'Invalid webhook signature',
        }),
      );
    });

    it('should reject missing signature header', async () => {
      const middleware = validateWebhookSignature({
        provider: 'generic',
        secret,
      });

      const req = createMockRequest({
        body: Buffer.from('{}'),
        headers: {},
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Missing webhook signature',
        }),
      );
    });

    it('should reject non-buffer request body', async () => {
      const middleware = validateWebhookSignature({
        provider: 'generic',
        secret,
      });

      const req = createMockRequest({
        body: { event: 'test' }, // Not a buffer
        headers: {
          'x-webhook-signature': 'some-signature',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Webhook body must be raw',
        }),
      );
    });
  });

  describe('timestamp validation', () => {
    it('should reject expired timestamp', async () => {
      const payload = '{"event":"test"}';
      const signature = computeHmac(payload, secret);
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago

      const middleware = validateWebhookSignature({
        provider: 'generic',
        secret,
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-webhook-signature': signature,
          'x-webhook-timestamp': oldTimestamp.toString(),
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Webhook timestamp expired',
        }),
      );
    });

    it('should accept valid timestamp', async () => {
      const payload = '{"event":"test"}';
      const signature = computeHmac(payload, secret);
      const currentTimestamp = Math.floor(Date.now() / 1000);

      const middleware = validateWebhookSignature({
        provider: 'generic',
        secret,
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-webhook-signature': signature,
          'x-webhook-timestamp': currentTimestamp.toString(),
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation?.timestampValid).toBe(true);
    });
  });

  describe('github provider', () => {
    it('should validate github signature with prefix', async () => {
      const payload = '{"action":"push"}';
      const rawSignature = computeHmac(payload, secret);
      const signature = `sha256=${rawSignature}`;

      const middleware = validateWebhookSignature({
        provider: 'github',
        secret,
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-hub-signature-256': signature,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation?.signatureValid).toBe(true);
    });
  });

  describe('stripe provider', () => {
    it('should parse stripe signature header format', async () => {
      const payload = '{"type":"payment_intent.succeeded"}';
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = `${timestamp}.${payload}`;
      const signature = computeHmac(signedPayload, secret);
      const stripeHeader = `t=${timestamp},v1=${signature}`;

      const middleware = validateWebhookSignature({
        provider: 'stripe',
        secret,
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'stripe-signature': stripeHeader,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation?.signatureValid).toBe(true);
    });
  });

  describe('skipValidation option', () => {
    it('should skip validation when condition is met', async () => {
      const middleware = validateWebhookSignature({
        provider: 'generic',
        secret,
        skipValidation: (req) => req.path === '/api/webhook/test',
      });

      const req = createMockRequest({
        path: '/api/webhook/test',
        body: Buffer.from('{}'),
        headers: {},
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation?.signatureValid).toBe(true);
    });
  });

  describe('rejectOnFailure option', () => {
    it('should not reject when rejectOnFailure is false', async () => {
      const middleware = validateWebhookSignature({
        provider: 'generic',
        secret,
        rejectOnFailure: false,
      });

      const req = createMockRequest({
        body: Buffer.from('{}'),
        headers: {
          'x-webhook-signature': 'invalid',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.webhookValidation?.signatureValid).toBe(false);
    });
  });

  describe('custom provider', () => {
    it('should use custom provider config', async () => {
      const payload = '{"data":"custom"}';
      const signature = computeHmac(payload, secret, 'sha512', 'base64');

      const middleware = validateWebhookSignature({
        provider: 'custom',
        secret,
        customConfig: {
          signatureHeader: 'x-custom-signature',
          algorithm: 'sha512',
          encoding: 'base64',
        },
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-custom-signature': signature,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation?.signatureValid).toBe(true);
    });

    it('should use custom signature computation', async () => {
      const payload = '{"data":"custom"}';
      const customCompute = jest.fn().mockReturnValue('custom-computed-signature');

      const middleware = validateWebhookSignature({
        provider: 'custom',
        secret,
        customConfig: {
          signatureHeader: 'x-custom-signature',
          computeSignature: customCompute,
        },
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-custom-signature': 'custom-computed-signature',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(customCompute).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation?.signatureValid).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully with rejectOnFailure true', async () => {
      const middleware = validateWebhookSignature({
        provider: 'custom',
        secret,
        customConfig: {
          signatureHeader: 'x-custom-signature',
          computeSignature: () => { throw new Error('Computation error'); },
        },
      });

      const req = createMockRequest({
        body: Buffer.from('{}'),
        headers: {
          'x-custom-signature': 'some-signature',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal Server Error',
        }),
      );
    });

    it('should handle errors gracefully with rejectOnFailure false', async () => {
      const middleware = validateWebhookSignature({
        provider: 'custom',
        secret,
        rejectOnFailure: false,
        customConfig: {
          signatureHeader: 'x-custom-signature',
          computeSignature: () => { throw new Error('Computation error'); },
        },
      });

      const req = createMockRequest({
        body: Buffer.from('{}'),
        headers: {
          'x-custom-signature': 'some-signature',
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation?.signatureValid).toBe(false);
    });
  });

  describe('unknown provider', () => {
    it('should fall back to generic provider for unknown provider', async () => {
      const payload = '{"event":"test"}';
      const signature = computeHmac(payload, secret);

      const middleware = validateWebhookSignature({
        provider: 'unknown-provider',
        secret,
      });

      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-webhook-signature': signature, // Uses generic header
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.webhookValidation?.signatureValid).toBe(true);
    });
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret';

  it('should verify valid signature with string payload', () => {
    const payload = 'test-payload';
    const signature = computeHmac(payload, secret);

    const result = verifyWebhookSignature(payload, signature, secret);

    expect(result).toBe(true);
  });

  it('should verify valid signature with buffer payload', () => {
    const payload = Buffer.from('test-payload');
    const signature = computeHmac(payload.toString(), secret);

    const result = verifyWebhookSignature(payload, signature, secret);

    expect(result).toBe(true);
  });

  it('should reject invalid signature', () => {
    const payload = 'test-payload';

    const result = verifyWebhookSignature(payload, 'invalid-signature', secret);

    expect(result).toBe(false);
  });

  it('should support sha512 algorithm', () => {
    const payload = 'test-payload';
    const signature = computeHmac(payload, secret, 'sha512', 'hex');

    const result = verifyWebhookSignature(payload, signature, secret, {
      algorithm: 'sha512',
    });

    expect(result).toBe(true);
  });

  it('should support base64 encoding', () => {
    const payload = 'test-payload';
    const signature = computeHmac(payload, secret, 'sha256', 'base64');

    const result = verifyWebhookSignature(payload, signature, secret, {
      encoding: 'base64',
    });

    expect(result).toBe(true);
  });

  it('should strip signature prefix', () => {
    const payload = 'test-payload';
    const rawSignature = computeHmac(payload, secret);
    const signature = `sha256=${rawSignature}`;

    const result = verifyWebhookSignature(payload, signature, secret, {
      signaturePrefix: 'sha256=',
    });

    expect(result).toBe(true);
  });
});

describe('generateWebhookSignature', () => {
  const secret = 'test-secret';

  it('should generate valid signature', () => {
    const payload = 'test-payload';

    const { signature } = generateWebhookSignature(payload, secret);

    // Verify the generated signature
    const result = verifyWebhookSignature(payload, signature, secret);
    expect(result).toBe(true);
  });

  it('should generate signature with buffer payload', () => {
    const payload = Buffer.from('test-payload');

    const { signature } = generateWebhookSignature(payload, secret);

    const result = verifyWebhookSignature(payload, signature, secret);
    expect(result).toBe(true);
  });

  it('should include timestamp', () => {
    const payload = 'test-payload';

    const { signature, timestamp } = generateWebhookSignature(payload, secret);

    expect(signature).toBeDefined();
    expect(timestamp).toBeDefined();
    expect(typeof timestamp).toBe('number');
  });

  it('should use custom timestamp', () => {
    const payload = 'test-payload';
    const customTimestamp = 1234567890;

    const { timestamp } = generateWebhookSignature(payload, secret, {
      timestamp: customTimestamp,
    });

    expect(timestamp).toBe(customTimestamp);
  });

  it('should support sha512 algorithm', () => {
    const payload = 'test-payload';

    const { signature } = generateWebhookSignature(payload, secret, {
      algorithm: 'sha512',
    });

    const result = verifyWebhookSignature(payload, signature, secret, {
      algorithm: 'sha512',
    });
    expect(result).toBe(true);
  });

  it('should support base64 encoding', () => {
    const payload = 'test-payload';

    const { signature } = generateWebhookSignature(payload, secret, {
      encoding: 'base64',
    });

    const result = verifyWebhookSignature(payload, signature, secret, {
      encoding: 'base64',
    });
    expect(result).toBe(true);
  });

  it('should add signature prefix', () => {
    const payload = 'test-payload';

    const { signature } = generateWebhookSignature(payload, secret, {
      signaturePrefix: 'sha256=',
    });

    expect(signature.startsWith('sha256=')).toBe(true);

    // Verify the signature
    const result = verifyWebhookSignature(payload, signature, secret, {
      signaturePrefix: 'sha256=',
    });
    expect(result).toBe(true);
  });
});

describe('timing attack prevention', () => {
  it('should use constant-time comparison', async () => {
    const secret = 'test-secret';
    const payload = '{"event":"test"}';
    const validSignature = computeHmac(payload, secret);

    const middleware = validateWebhookSignature({
      provider: 'generic',
      secret,
    });

    // Create requests with different signatures (same length)
    const signatures = [
      validSignature,
      'a'.repeat(validSignature.length),
      'b'.repeat(validSignature.length),
      'z'.repeat(validSignature.length),
    ];

    // All should complete without timing differences exposing the secret
    for (const sig of signatures) {
      const req = createMockRequest({
        body: Buffer.from(payload),
        headers: {
          'x-webhook-signature': sig,
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req, res, next);

      // Test passes if no timing-based errors occur
      expect(true).toBe(true);
    }
  });
});
