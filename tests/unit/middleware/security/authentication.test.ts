/**
 * Unit tests for src/middleware/security/authentication.ts —
 * createJWTValidator's string-payload guard (#1033 deferred follow-up).
 *
 * jwt.verify returns `string` for a validly-signed token whose payload is
 * not JSON. Without the guard, that string became req.user; downstream code
 * expects an object with id/roles/tenantId.
 */

import 'reflect-metadata';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { createJWTValidator } from '../../../../src/middleware/security/authentication';
import { UnauthorizedAppError } from '../../../../src/errors/AppError';
import type { Logger } from '../../../../src/utils/Logger';

describe('createJWTValidator — jwt string-payload guard (#1033)', () => {
  const secret = 'unit-test-jwt-validator-secret';
  let mockLogger: jest.Mocked<Logger>;
  let mockReq: Partial<Request> & { user?: unknown };
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock;
  let validator: (req: Request, res: Response, next: NextFunction) => void;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>;
    mockReq = {
      headers: {},
      path: '/api/test',
      ip: '127.0.0.1',
      get: jest.fn(),
    } as unknown as Partial<Request>;
    mockRes = {};
    mockNext = jest.fn();
    validator = createJWTValidator(mockLogger, secret);
  });

  it('rejects a validly-signed string-payload token with UnauthorizedAppError and never sets req.user', () => {
    const token = jwt.sign('just-a-string-payload', secret);
    mockReq.headers = { authorization: `Bearer ${token}` };

    validator(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    const err = mockNext.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedAppError);
    expect((err as Error).message).toBe('Invalid JWT token');
    expect(mockReq.user).toBeUndefined();
  });

  it('accepts an object-payload token and sets req.user', () => {
    const token = jwt.sign({ id: 'user-1', roles: ['viewer'], tenantId: 't-1' }, secret);
    mockReq.headers = { authorization: `Bearer ${token}` };

    validator(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockNext.mock.calls[0][0]).toBeUndefined();
    expect(mockReq.user).toMatchObject({ id: 'user-1', tenantId: 't-1' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = jwt.sign({ id: 'user-1' }, 'some-other-secret');
    mockReq.headers = { authorization: `Bearer ${token}` };

    validator(mockReq as Request, mockRes as Response, mockNext);

    const err = mockNext.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedAppError);
    expect(mockReq.user).toBeUndefined();
  });
});
