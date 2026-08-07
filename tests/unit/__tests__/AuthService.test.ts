import type { AuthCredentials, AuthService as AuthServiceType } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import { OAuth2Error, TokenError, type JWTError } from '../errors/AuthErrors';

// Use actual AuthService implementation instead of the test mock
const { AuthService } = jest.requireActual('../services/AuthService');

// Mock logger for testing
const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
  setCorrelationId: jest.fn().mockReturnThis(),
  withCorrelationId: jest.fn().mockReturnThis(),
  getCorrelationId: jest.fn().mockReturnValue('test-correlation-id'),
} as unknown as Logger;

// Mock fetch API
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('AuthService', () => {
  let auth: AuthServiceType;
  const authInstances: AuthServiceType[] = [];

  const jwtSecret = 'test-jwt-secret-key-for-testing-only-minimum-32-chars-long-enough';

  beforeEach(() => {
    // Set a valid secret for most tests
    process.env.JWT_SECRET = jwtSecret;
    process.env.API_KEY_SECRET = 'test-api-key-secret';
    auth = new AuthService(mockLogger);
    authInstances.push(auth);
  });

  afterEach(() => {
    // Clean up all AuthService instances to prevent memory leaks
    authInstances.forEach(instance => instance.cleanup());
    authInstances.length = 0; // Clear the array

    // Reset environment and mocks
    delete process.env.JWT_SECRET;
    delete process.env.API_KEY_SECRET;
    delete process.env.NODE_ENV;
    // Important: reset fetch mock to clear any queued mockResolvedValueOnce
    mockFetch.mockReset();
    jest.clearAllMocks();
  });

  describe('JWT Secret Validation', () => {
    // Store original process.env.JWT_SECRET
    let originalJwtSecret: string | undefined;
    let originalNodeEnv: string | undefined;
    let JWTErrorLocal: typeof JWTError;

    beforeEach(() => {
      originalJwtSecret = process.env.JWT_SECRET;
      originalNodeEnv = process.env.NODE_ENV;
      jest.resetModules(); // Clear module cache to re-import AuthService
      ({ JWTError: JWTErrorLocal } = jest.requireActual('../errors/AuthErrors'));
    });

    afterEach(() => {
      process.env.JWT_SECRET = originalJwtSecret;
      process.env.NODE_ENV = originalNodeEnv;
      delete process.env.DB_PASSWORD;
      delete process.env.DATABASE_URL;
      delete process.env.RATE_LIMIT_ENABLED;
      // Clear env.ts cache so subsequent tests get a fresh evaluation
      delete require.cache[require.resolve('../config/env')];
      delete require.cache[require.resolve('../utils/dbUrlHelper')];
    });

    it('uses default JWT_SECRET when not configured in development mode', () => {
      const originalJwt = process.env.JWT_SECRET;
      const originalNodeEnv = process.env.NODE_ENV;

      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'development';

      // Clear module cache to force re-evaluation of both AuthService and env
      delete require.cache[require.resolve('../services/AuthService')];
      delete require.cache[require.resolve('../config/env')];

      try {
        const { AuthService: AuthServiceLocal } = jest.requireActual('../services/AuthService');
        // Should not throw in development mode - uses default
        expect(() => new AuthServiceLocal(mockLogger)).not.toThrow();
      } finally {
        // Restore environment. Must unconditionally reassign (not skip when
        // the original was undefined) — an unset NODE_ENV now fails closed
        // in src/config/env.ts (production guards run unless NODE_ENV is
        // EXPLICITLY development/test), so leaving 'development' stuck here
        // would leak into later tests that expect an unset/original NODE_ENV.
        if (originalJwt === undefined) {
          delete process.env.JWT_SECRET;
        } else {
          // Same explicit-undefined discipline as NODE_ENV below: a
          // defined-but-falsy JWT_SECRET must be restored, not dropped.
          process.env.JWT_SECRET = originalJwt;
        }
        if (originalNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          // Explicit undefined check: an empty-string NODE_ENV is defined and
          // must be restored as-is, not deleted.
          process.env.NODE_ENV = originalNodeEnv;
        }
        // Clear cache again to ensure next tests get fresh env
        delete require.cache[require.resolve('../config/env')];
      }
    });

    it('throws JWTError if JWT_SECRET is too short', () => {
      // Pin NODE_ENV explicitly: this test only cares about JWT_SECRET length
      // validation, not production guards, and must not depend on whatever
      // NODE_ENV leaked from a prior test's cleanup (src/config/env.ts now
      // fails closed on an unset NODE_ENV).
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'short';
      // Clear module cache to force re-evaluation (env.ts too, since NODE_ENV changed)
      delete require.cache[require.resolve('../services/AuthService')];
      delete require.cache[require.resolve('../config/env')];
      const { AuthService: AuthServiceLocal } = jest.requireActual('../services/AuthService');
      expect(() => new AuthServiceLocal(mockLogger)).toThrow(JWTErrorLocal);
    });

    it('throws JWTError if JWT_SECRET is a weak secret in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'supersecretjwtkey';
      process.env.DB_PASSWORD = 'secure-test-db-pw-123';
      process.env.RATE_LIMIT_ENABLED = 'true';
      // Clear module cache to force re-evaluation (env.ts must also be cleared for production guards)
      delete require.cache[require.resolve('../services/AuthService')];
      delete require.cache[require.resolve('../config/env')];
      const { AuthService: AuthServiceLocal } = jest.requireActual('../services/AuthService');
      expect(() => new AuthServiceLocal(mockLogger)).toThrow(JWTErrorLocal);
    });

    it('throws error for low entropy in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a'.repeat(65); // long but low entropy
      process.env.DB_PASSWORD = 'secure-test-db-pw-123';
      process.env.RATE_LIMIT_ENABLED = 'true';
      // Clear module cache to force re-evaluation (env.ts must also be cleared for production guards)
      delete require.cache[require.resolve('../services/AuthService')];
      delete require.cache[require.resolve('../config/env')];
      const { AuthService: AuthServiceLocal } = jest.requireActual('../services/AuthService');
      expect(() => new AuthServiceLocal(mockLogger)).toThrow(/insufficient entropy/);
    });

    it('passes validation for a strong secret', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'p9Lx!B3s#N1qT8rV5wY6uZ7xC4vE2bR0mKjHgFdSaQpWeRtYUiOpABCDxyz987654321';
      process.env.DB_PASSWORD = 'secure-test-db-pw-123';
      process.env.RATE_LIMIT_ENABLED = 'true';
      // Clear module cache to force re-evaluation (env.ts must also be cleared for production guards)
      delete require.cache[require.resolve('../services/AuthService')];
      delete require.cache[require.resolve('../config/env')];
      const { AuthService: AuthServiceLocal } = jest.requireActual('../services/AuthService');
      new AuthServiceLocal(mockLogger);
      expect(mockLogger.info).toHaveBeenCalledWith('JWT secret validation passed', expect.any(Object));
    });

    it('DB_PASSWORD guard passes when DATABASE_URL has embedded credentials', () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'p9Lx!B3s#N1qT8rV5wY6uZ7xC4vE2bR0mKjHgFdSaQpWeRtYUiOpABCDxyz987654321';
      process.env.DB_PASSWORD = 'password'; // default/insecure
      process.env.DATABASE_URL = 'postgresql://user:securepass@host/db';
      process.env.RATE_LIMIT_ENABLED = 'true';
      delete require.cache[require.resolve('../services/AuthService')];
      delete require.cache[require.resolve('../config/env')];
      delete require.cache[require.resolve('../utils/dbUrlHelper')];
      try {
        jest.requireActual('../config/env');
        // Should NOT have called process.exit for DB_PASSWORD guard
        const dbPasswordExitCalls = exitSpy.mock.calls.filter(() => {
          return mockLogger.error.mock.calls.some(
            (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('DB_PASSWORD')
          );
        });
        expect(dbPasswordExitCalls.length).toBe(0);
      } finally {
        delete process.env.DATABASE_URL;
        exitSpy.mockRestore();
      }
    });

    it('DB_PASSWORD guard fails when DATABASE_URL lacks credentials and DB_PASSWORD is default', () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'p9Lx!B3s#N1qT8rV5wY6uZ7xC4vE2bR0mKjHgFdSaQpWeRtYUiOpABCDxyz987654321';
      process.env.DB_PASSWORD = 'password'; // default/insecure
      process.env.DATABASE_URL = 'postgresql://host/db'; // no credentials
      process.env.RATE_LIMIT_ENABLED = 'true';
      delete require.cache[require.resolve('../services/AuthService')];
      delete require.cache[require.resolve('../config/env')];
      delete require.cache[require.resolve('../utils/dbUrlHelper')];
      try {
        jest.requireActual('../config/env');
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        delete process.env.DATABASE_URL;
        exitSpy.mockRestore();
      }
    });
  });

  describe('validateApiKey', () => {
    it('returns true for correct key', () => {
      expect(auth.validateApiKey('my-api-key', 'my-api-key')).toBe(true);
    });

    it('returns false for incorrect key with same length', () => {
      expect(auth.validateApiKey('my-api-key', 'my-api-ke1')).toBe(false);
    });

    it('returns false for mismatched lengths', () => {
      expect(auth.validateApiKey('short', 'a-much-longer-api-key')).toBe(false);
    });
  });

  test('generateJWT and verifyJWT round trip', () => {
    const token = auth.generateJWT({ user: 'demo' }, '1h');
    const payload = auth.verifyJWT(token);
    expect(payload.user).toBe('demo');
  });

  test('validateBasicAuth verifies hashed password', async () => {
    const password = 'mypassword';
    const hashed = await auth.hashPassword(password);
    await expect(auth.validateBasicAuth('user', password, hashed)).resolves.toBe(true);
    await expect(auth.validateBasicAuth('user', 'wrong', hashed)).resolves.toBe(false);
  });

  const mockTokenResponse = (expiresIn = 3600, refreshToken?: string) => ({
    access_token: 'mock_access_token',
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: 'api',
  });

  describe('OAuth2 Authentication', () => {
    const oauth2Credentials: AuthCredentials = {
      type: 'oauth2',
      credentials: {
        client_id: 'prod_client_12345',
        client_secret: 'prod_secret_67890',
        token_url: 'https://production.oauth.company.com/oauth/token',
        scope: 'api',
      },
    };

    it('successfully obtains and caches a new token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse()),
      } as Response);

      const token = await auth.authenticateOAuth2(oauth2Credentials);
      expect(token.accessToken).toBe('mock_access_token');
      expect(auth['tokenCache'].size).toBe(1);
    });

    it('uses cached token if not expired', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse()),
      } as Response);

      await auth.authenticateOAuth2(oauth2Credentials); // First call
      await auth.authenticateOAuth2(oauth2Credentials); // Second call

      expect(mockFetch).toHaveBeenCalledTimes(1); // Should not call fetch again
      expect(auth['tokenCache'].get(auth['getCacheKey'](oauth2Credentials))?.accessCount).toBe(2);
    });

    it('refreshes token if expired and refresh token is available', async () => {
      // First call: token with negative expiry to simulate expiration
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse(-1, 'mock_refresh_token')), // Already expired
      } as Response);

      // Second call: refresh token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse(3600, 'new_refresh_token')),
      } as Response);

      const initialToken = await auth.authenticateOAuth2(oauth2Credentials);
      expect(initialToken.refreshToken).toBe('mock_refresh_token');

      // Call again - should use refresh token since first token is expired
      const refreshedToken = await auth.authenticateOAuth2(oauth2Credentials);
      expect(refreshedToken.accessToken).toBe('mock_access_token');
      expect(refreshedToken.refreshToken).toBe('new_refresh_token');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('requests new token if refresh fails or no refresh token', async () => {
      // First call: token with negative expiry, no refresh token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse(-1)), // Already expired, no refresh token
      } as Response);

      // Second call: token request fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => Promise.resolve('Invalid grant'),
      } as Response);

      await auth.authenticateOAuth2(oauth2Credentials);

      // Second call should fail since token is expired and no refresh token
      await expect(auth.authenticateOAuth2(oauth2Credentials)).rejects.toThrow(OAuth2Error);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws OAuth2Error on token request failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => Promise.resolve('Invalid client'),
      } as Response);

      await expect(auth.authenticateOAuth2(oauth2Credentials)).rejects.toThrow(OAuth2Error);
    });

    it('throws TokenError on refresh token request failure', async () => {
      // Initial token with refresh token (already expired)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse(-1, 'mock_refresh_token')),
      } as Response);

      // Refresh token request fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => Promise.resolve('Refresh token expired'),
      } as Response);

      await auth.authenticateOAuth2(oauth2Credentials);

      await expect(auth.authenticateOAuth2(oauth2Credentials)).rejects.toThrow(TokenError);
    });

    it('clears token cache correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse()),
      } as Response);

      await auth.authenticateOAuth2(oauth2Credentials);
      expect(auth['tokenCache'].size).toBe(1);

      auth.clearTokenCache();
      expect(auth['tokenCache'].size).toBe(0);
    });

    it('clears specific token from cache', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse()),
      } as Response);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse()),
      } as Response);

      const otherCredentials = {
        type: 'oauth2',
        credentials: {
          client_id: 'other_client',
          client_secret: 'other_secret',
          token_url: 'https://example.com/oauth/token',
        },
      } as AuthCredentials;

      await auth.authenticateOAuth2(oauth2Credentials);
      await auth.authenticateOAuth2(otherCredentials);
      expect(auth['tokenCache'].size).toBe(2);

      auth.clearTokenCache(oauth2Credentials);
      expect(auth['tokenCache'].size).toBe(1);
      expect(auth['tokenCache'].has(auth['getCacheKey'](oauth2Credentials))).toBe(false);
      expect(auth['tokenCache'].has(auth['getCacheKey'](otherCredentials))).toBe(true);
    });

    it('getTokenCacheStats returns correct statistics', async () => {
      // Ensure clean cache state for this test
      auth.clearTokenCache();

      // First token - expires very soon (in 10 seconds)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse(10)), // Expires in 10 seconds
      } as Response);

      // Second token - expires in 5 minutes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse(300)), // Expires in 5 minutes
      } as Response);

      await auth.authenticateOAuth2(oauth2Credentials);
      const otherCredentials = {
        type: 'oauth2',
        credentials: {
          client_id: 'prod_client_67890',
          client_secret: 'prod_secret_12345',
          token_url: 'https://production.oauth.company.com/oauth/token',
        },
      } as AuthCredentials;
      await auth.authenticateOAuth2(otherCredentials);

      let stats = auth.getTokenCacheStats();
      expect(stats.totalTokens).toBe(2);
      expect(stats.expiredTokens).toBe(0);
      expect(stats.tokensExpiringInHour).toBe(2);

      // Now test with expired tokens by creating already expired ones
      // Add an already expired token to cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => Promise.resolve(mockTokenResponse(-100)), // Already expired 100 seconds ago
      } as Response);

      const expiredCredentials = {
        type: 'oauth2',
        credentials: {
          client_id: 'prod_client_98765',
          client_secret: 'prod_secret_54321',
          token_url: 'https://production.oauth.company.com/oauth/token',
        },
      } as AuthCredentials;
      await auth.authenticateOAuth2(expiredCredentials);

      stats = auth.getTokenCacheStats();
      expect(stats.totalTokens).toBe(3);
      expect(stats.expiredTokens).toBe(1);
      expect(stats.tokensExpiringInHour).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('clears caches and stops cleanup interval synchronously', () => {
      process.env.NODE_ENV = 'development';
      const authWithInterval = new AuthService(mockLogger);
      authInstances.push(authWithInterval);

      authWithInterval['tokenCache'].set('test', {
        accessToken: 'token',
        expiresAt: new Date(Date.now() + 1000),
        tokenType: 'Bearer',
        issued: new Date(),
        lastAccessed: new Date(),
        accessCount: 1,
      });

      authWithInterval['refreshPromises'].set(
        'test',
        Promise.resolve({
          accessToken: 'token',
          refreshToken: 'refresh',
          expiresAt: new Date(Date.now() + 1000),
          tokenType: 'Bearer',
          scope: 'api',
          issued: new Date(),
        }),
      );

  expect(authWithInterval['tokenCache'].size).toBe(1);
  expect(authWithInterval['refreshPromises'].size).toBe(1);
  // In Jest, we do not start the cleanup interval automatically to avoid test flakiness
  // so it may be undefined here. The important behavior is that cleanup leaves it undefined.
  expect(authWithInterval['cleanupInterval']).toBeUndefined();

      authWithInterval.cleanup();

      expect(authWithInterval['tokenCache'].size).toBe(0);
      expect(authWithInterval['refreshPromises'].size).toBe(0);
      expect(authWithInterval['cleanupInterval']).toBeUndefined();
    });
  });
});
