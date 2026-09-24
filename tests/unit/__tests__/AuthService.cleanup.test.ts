jest.useFakeTimers();

import type { Logger } from '../utils/Logger';

const { AuthService } = jest.requireActual('../services/AuthService');

const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

describe('AuthService cleanup', () => {
  const secret = 'test-jwt-secret-key-for-testing-only-minimum-32-chars-long-enough';

  afterEach(() => {
    delete process.env.JWT_SECRET;
    jest.clearAllTimers();
  });

  it('clears token cache and stops cleanup interval', () => {
    process.env.JWT_SECRET = secret;
    const auth = new AuthService(mockLogger);

    const tokenInfo = {
      accessToken: 'token',
      expiresAt: new Date(Date.now() + 1000),
      tokenType: 'Bearer',
      issued: new Date(),
      lastAccessed: new Date(),
      accessCount: 1,
    };

    auth['tokenCache'].set('test', tokenInfo as any);
    auth['cleanupInterval'] = setInterval(() => {}, 1000);

    auth.cleanup();

    expect(auth['tokenCache'].size).toBe(0);
    expect(auth['cleanupInterval']).toBeUndefined();
  });
});
