/**
 * Error Response Utility Unit Tests
 * Tests for error response formatting and sanitization
 */

import { Request, Response } from 'express';
import { sendError, ErrorOptions } from '../../../src/utils/errorResponse';

describe('errorResponse', () => {
  let mockRes: Partial<Response>;
  let mockReq: Partial<Request>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;

  beforeEach(() => {
    mockJson = jest.fn().mockReturnThis();
    mockStatus = jest.fn().mockReturnThis();
    mockRes = {
      json: mockJson,
      status: mockStatus,
    };
    mockReq = {
      originalUrl: '/api/test',
    };
  });

  describe('sendError', () => {
    it('should send error with correct status code', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockStatus).toHaveBeenCalledWith(400);
    });

    it('should include error, code, and message in response', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Test error',
          code: 'ERR_TEST',
          message: 'Test error',
        })
      );
    });

    it('should include timestamp in response', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
      };

      sendError(mockRes as Response, 400, opts);

      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody.timestamp).toBeDefined();
      expect(new Date(responseBody.timestamp)).toBeInstanceOf(Date);
    });

    it('should include path when request is provided', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
      };

      sendError(mockRes as Response, 400, opts, mockReq as Request);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/test',
        })
      );
    });

    it('should include extra properties', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
      };

      sendError(mockRes as Response, 400, opts, undefined, { requestId: '123' });

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: '123',
        })
      );
    });

    it('should include sanitized details', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { field: 'value' },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { field: 'value' },
        })
      );
    });

    it('should not include details if undefined', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
      };

      sendError(mockRes as Response, 400, opts);

      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody).not.toHaveProperty('details');
    });
  });

  describe('sanitization', () => {
    it('should redact password fields', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { password: 'secret123' },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { password: '[REDACTED]' },
        })
      );
    });

    it('should redact token fields', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { token: 'abc123' },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { token: '[REDACTED]' },
        })
      );
    });

    it('should redact secret fields', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { clientSecret: 'abc123' },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { clientSecret: '[REDACTED]' },
        })
      );
    });

    it('should redact api key fields', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { apikey: 'abc123', api_key: 'def456' },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { apikey: '[REDACTED]', api_key: '[REDACTED]' },
        })
      );
    });

    it('should redact JWT patterns in values', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { value: '[REDACTED]' },
        })
      );
    });

    it('should redact email patterns in values', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { value: 'user@example.com' },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { value: '[REDACTED]' },
        })
      );
    });

    it('should redact bearer token patterns', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { value: 'Bearer abc123xyz' },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { value: '[REDACTED]' },
        })
      );
    });

    it('should truncate very long strings', () => {
      const longString = 'a'.repeat(600);
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { value: longString },
      };

      sendError(mockRes as Response, 400, opts);

      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody.details.value).toContain('[TRUNCATED]');
      expect(responseBody.details.value.length).toBeLessThan(200);
    });

    it('should sanitize nested objects', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: {
          user: {
            name: 'John',
            password: 'secret',
          },
        },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: {
            user: {
              name: 'John',
              password: '[REDACTED]',
            },
          },
        })
      );
    });

    it('should sanitize arrays', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: {
          items: [
            { name: 'item1', password: 'pass1' },
            { name: 'item2', password: 'pass2' },
          ],
        },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: {
            items: [
              { name: 'item1', password: '[REDACTED]' },
              { name: 'item2', password: '[REDACTED]' },
            ],
          },
        })
      );
    });

    it('should handle primitive details', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: 'Simple string',
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: 'Simple string',
        })
      );
    });

    it('should handle null details', () => {
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: null,
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: null,
        })
      );
    });

    it('should preserve Date objects', () => {
      const date = new Date('2024-01-01');
      const opts: ErrorOptions = {
        code: 'ERR_TEST',
        message: 'Test error',
        details: { createdAt: date },
      };

      sendError(mockRes as Response, 400, opts);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { createdAt: date },
        })
      );
    });
  });
});
