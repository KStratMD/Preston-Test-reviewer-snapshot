import { injectable, inject } from 'inversify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import { TokenError, OAuth2Error, JWTError } from '../errors/AuthErrors';
import { AUTH_CONSTANTS } from '../constants/systemConstants';
import type { OAuth1Credentials } from '../types';
import { env } from '../config/env';
import { isDemoMode, isTestEnvironment } from '../config/runtimeFlags';

export type AuthCredentials =
  | {
      type: 'oauth2';
      credentials: {
        client_id: string;
        client_secret: string;
        token_url: string;
        scope?: string;
        grant_type?: string;
      };
    }
  | { type: 'api_key'; credentials: { api_key: string; } }
  | { type: 'basic'; credentials: { username: string; password: string; } }
  | {
      type: 'token';
      credentials: {
        accountId: string;
        consumerKey: string;
        consumerSecret: string;
        tokenId: string;
        tokenSecret: string;
      };
    }
  | { type: 'certificate'; credentials: { certificate: string; private_key: string; } };

export interface TokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  tokenType: string;
  scope?: string;
  instanceUrl?: string;
  issued: Date;
}

interface CachedToken extends TokenInfo {
  lastAccessed: Date;
  accessCount: number;
}

/**
 * Service for handling various authentication mechanisms and token management.
 * Supports OAuth2, API Key, Basic, Token, and Certificate authentications.
 * Manages token caching and JWT operations.
 */
@injectable()
export class AuthService {
  private readonly logger: Logger;
  private readonly tokenCache = new Map<string, CachedToken>();
  private readonly refreshPromises = new Map<string, Promise<TokenInfo>>();
  private cleanupInterval: NodeJS.Timeout | undefined;
  private readonly tokenCleanupIntervalMs: number;

  /**
   * Creates an instance of AuthService.
   * @param {Logger} logger - The logger instance for logging messages.
   */
  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
    this.tokenCleanupIntervalMs = env.TOKEN_CLEANUP_INTERVAL_MS;
    this.validateJWTSecret();

    // Only start cleanup interval outside of Jest and when NODE_ENV is explicitly set and not 'test'
    const nodeEnv = process.env.NODE_ENV;
    const isJest = process.env.JEST_WORKER_ID !== undefined;
    if (!isJest && nodeEnv && nodeEnv !== 'test') {
      this.startTokenCleanup();
    }
  }

  public cleanup(): void {
    this.clearTokenCleanup();
    this.tokenCache.clear();
    this.refreshPromises.clear();
  }

  private validateJWTSecret(): void {
    const rawSecret = process.env.JWT_SECRET;
    if (!rawSecret && process.env.NODE_ENV !== 'production') {
      // In non-production environments allow the default secret to be used
      this.logger.warn('JWT_SECRET not set - using default development secret');
    } else if (!rawSecret) {
      throw new JWTError('JWT_SECRET environment variable is required but not configured');
    }
    const secret = rawSecret || env.JWT_SECRET;
    if (!secret) {
      throw new JWTError('JWT_SECRET environment variable is required but not configured');
    }
    if (secret.length < 32) {
      throw new JWTError('JWT_SECRET must be at least 32 characters long for HS256 algorithm');
    }

    const minLength = AUTH_CONSTANTS.JWT_SECRET_MIN_LENGTH;
    const productionMinLength = AUTH_CONSTANTS.JWT_SECRET_PRODUCTION_MIN_LENGTH;
    const minEntropyChars = AUTH_CONSTANTS.MIN_ENTROPY_UNIQUE_CHARS;
    const skipStrictValidation = ['1', 'true', 'yes'].includes((process.env.SKIP_JWT_SECRET_VALIDATION ?? '').toLowerCase());

    if (secret.length < minLength) {
      throw new JWTError(`JWT_SECRET must be at least ${minLength} characters long for security. Current length: ${secret.length}`);
    }

    // Enhanced validation for production
    const effectiveEnv = process.env.NODE_ENV || env.NODE_ENV;
    if (effectiveEnv === 'production' && skipStrictValidation) {
      this.logger.warn('Production JWT secret strict validation skipped via SKIP_JWT_SECRET_VALIDATION flag. Use only for non-production testing scenarios.', {
        type: 'security',
      });
    }

    if (effectiveEnv === 'production' && !skipStrictValidation) {
      if (secret.length < productionMinLength) {
        throw new JWTError(`Production JWT_SECRET must be at least ${productionMinLength} characters long for enhanced security. Current length: ${secret.length}. Consider using a cryptographically secure random generator.`);
      }

      // Check for weak/default secrets (expanded list)
      const weakSecrets = [
        'supersecretjwtkey',
        'your-super-secret-jwt-key',
        'jwt-secret',
        'secret',
        'password',
        '123456',
        'abcdef',
        'qwerty',
        'default',
        'changeme',
        'admin',
        'test',
        'demo',
        'development',
        'dev-demo-secret',
      ];

      const secretLower = secret.toLowerCase();
      const weakSecretFound = weakSecrets.find(weak => secretLower.includes(weak));
      if (weakSecretFound) {
        throw new JWTError(`JWT_SECRET contains weak pattern '${weakSecretFound}'. Use a cryptographically secure random value in production. Generate with: openssl rand -base64 64`);
      }

      // Enhanced entropy check
      const uniqueChars = new Set(secret).size;
      if (uniqueChars < minEntropyChars) {
        throw new JWTError(`JWT_SECRET has insufficient entropy (${uniqueChars} unique characters). Production requires at least ${minEntropyChars} unique characters.`);
      }

      // Check character set diversity for better security
      const hasLowercase = /[a-z]/.test(secret);
      const hasUppercase = /[A-Z]/.test(secret);
      const hasNumbers = /[0-9]/.test(secret);
      const hasSpecialChars = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(secret);
      
      const charSetCount = [hasLowercase, hasUppercase, hasNumbers, hasSpecialChars].filter(Boolean).length;
      if (charSetCount < 3) {
        this.logger.warn('JWT_SECRET should include at least 3 character types (lowercase, uppercase, numbers, special characters) for optimal security.', {
          hasLowercase,
          hasUppercase,
          hasNumbers,
          hasSpecialChars,
          type: 'security',
        });
      }
    }

    // Additional check for staging environments with production-like requirements
    // Note: staging is not in the NODE_ENV enum but might be used in practice
    if (process.env.NODE_ENV === 'staging' && secret.length < productionMinLength) {
      this.logger.warn(`Staging environment should use production-strength JWT_SECRET (${productionMinLength}+ characters). Current: ${secret.length}`, {
        type: 'security',
        recommendation: 'Use production-grade secret in staging for better testing',
      });
    }

    this.logger.info('JWT secret validation passed', {
      secretLength: secret.length,
      environment: env.NODE_ENV,
    });
  }

  async authenticateOAuth1(credentials: AuthCredentials): Promise<OAuth1Credentials> {
    if (credentials.type !== 'token') {
      throw new TokenError('Invalid credentials type for OAuth1 authentication');
    }

    const {
      accountId,
      consumerKey,
      consumerSecret,
      tokenId,
      tokenSecret,
    } = credentials.credentials;

    if (!accountId || !consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
      throw new TokenError('Missing required OAuth1 credentials');
    }

    this.logger.info('OAuth1 authentication successful');
    return { accountId, consumerKey, consumerSecret, tokenId, tokenSecret };
  }

  async authenticateOAuth2(credentials: AuthCredentials): Promise<TokenInfo> {
    const cacheKey = this.getCacheKey(credentials);
    const cached = this.tokenCache.get(cacheKey);

    // Check if token is still valid (with buffer)
    const bufferTime = AUTH_CONSTANTS.TOKEN_EXPIRY_BUFFER_MS;
    const now = new Date();

    if (this.shouldSimulateOAuth2(credentials)) {
      if (cached && cached.expiresAt.getTime() > now.getTime() + bufferTime) {
        cached.lastAccessed = now;
        cached.accessCount++;
        this.logger.debug('Using cached OAuth2 token');
        return cached;
      }

      const simulated = this.createDemoOAuth2Token(credentials);
      const cachedToken: CachedToken = {
        ...simulated,
        lastAccessed: now,
        accessCount: 1,
      };
      this.tokenCache.set(cacheKey, cachedToken);
      this.logger.info('OAuth2 authentication simulated for demo credentials', {
        clientId: credentials.credentials.client_id || 'demo-client',
      });
      return simulated;
    }

    if (cached && cached.expiresAt.getTime() > now.getTime() + bufferTime) {
      cached.lastAccessed = now;
      cached.accessCount++;
      this.logger.debug('Using cached OAuth2 token');
      return cached;
    }

    // If token is expired but we have a refresh token, try to refresh
    if (cached?.refreshToken && cached.expiresAt.getTime() <= now.getTime() + bufferTime) {
      // Attempt refresh and propagate errors
      return this.refreshOAuth2Token(credentials, cached.refreshToken);
    }

    // Prevent multiple concurrent token requests for the same credentials
    const existingPromise = this.refreshPromises.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const tokenPromise = this.requestOAuth2Token(credentials);
    this.refreshPromises.set(cacheKey, tokenPromise);

    try {
      const tokenInfo = await tokenPromise;
      const cachedToken: CachedToken = {
        ...tokenInfo,
        lastAccessed: now,
        accessCount: 1,
      };
      this.tokenCache.set(cacheKey, cachedToken);
      this.logger.info('OAuth2 authentication successful');
      return tokenInfo;
    } catch (error) {
      this.logger.error('OAuth2 authentication failed', error);
      throw new OAuth2Error(
        `OAuth2 authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        undefined,
        error instanceof Error ? error : undefined,
      );
    } finally {
      this.refreshPromises.delete(cacheKey);
    }
  }

  async refreshOAuth2Token(credentials: AuthCredentials, refreshToken: string): Promise<TokenInfo> {
    try {
      const tokenInfo = await this.requestOAuth2Refresh(credentials, refreshToken);
      const cacheKey = this.getCacheKey(credentials);
      const cachedToken: CachedToken = {
        ...tokenInfo,
        lastAccessed: new Date(),
        accessCount: 1,
      };
      this.tokenCache.set(cacheKey, cachedToken);
      this.logger.info('OAuth2 token refreshed successfully');
      return tokenInfo;
    } catch (error) {
      this.logger.error('OAuth2 token refresh failed', error);
      throw new TokenError(
        `OAuth2 token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  validateApiKey(apiKey: string, expectedKey: string): boolean {
    if (!apiKey || !expectedKey) {
      return false;
    }

    const apiKeyBuffer = Buffer.from(apiKey);
    const expectedKeyBuffer = Buffer.from(expectedKey);

    if (apiKeyBuffer.length !== expectedKeyBuffer.length) {
      return false;
    }

    try {
      return crypto.timingSafeEqual(apiKeyBuffer, expectedKeyBuffer);
    } catch (error) {
      this.logger.error('API key validation failed', error);
      return false;
    }
  }

  async validateBasicAuth(_username: string, password: string, hashedPassword: string): Promise<boolean> {
    try {
      return await bcrypt.compare(password, hashedPassword);
    } catch (error) {
      this.logger.error('Basic auth validation failed', error);
      return false;
    }
  }

  generateJWT(payload: Record<string, unknown>, expiresIn: string = AUTH_CONSTANTS.DEFAULT_TOKEN_EXPIRES_IN): string {
    const secret = env.JWT_SECRET;
    if (!secret) {
      throw new JWTError('JWT_SECRET not configured');
    }
    try {
      return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
    } catch (error) {
      throw new JWTError(`JWT generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`, error instanceof Error ? error : undefined);
    }
  }

  verifyJWT(token: string): Record<string, unknown> {
    const secret = env.JWT_SECRET;
    if (!secret) {
      throw new JWTError('JWT_SECRET not configured');
    }
    try {
      // Pin HS256 (A3): tokens are symmetric-signed with JWT_SECRET, so
      // rejecting any other alg forecloses algorithm-confusion attacks.
      const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') {
        throw new JWTError('Invalid JWT payload format');
      }
      return decoded as Record<string, unknown>;
    } catch (error) {
      if (error instanceof JWTError) {
        throw error;
      }
      throw new JWTError(`JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`, error instanceof Error ? error : undefined);
    }
  }

  private async requestOAuth2Token(credentials: AuthCredentials): Promise<TokenInfo> {
    if (credentials.type !== 'oauth2') {
      throw new OAuth2Error('Invalid credentials type for OAuth2 authentication');
    }

    const {
      client_id,
      client_secret,
      scope,
      token_url,
      grant_type = 'client_credentials',
    } = credentials.credentials;

    if (!client_id || !client_secret || !token_url) {
      throw new OAuth2Error('Missing required OAuth2 credentials');
    }

    const params = new URLSearchParams({
      grant_type,
      client_id,
      client_secret,
      ...(scope && { scope }),
    });

    return this._makeOAuth2TokenRequest(token_url, params);
  }

  private async requestOAuth2Refresh(credentials: AuthCredentials, refreshToken: string): Promise<TokenInfo> {
    if (credentials.type !== 'oauth2') {
      throw new TokenError('Invalid credentials type for OAuth2 token refresh');
    }

    const { client_id, client_secret, token_url } = credentials.credentials;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id,
      client_secret,
    });

    const tokenInfo = await this._makeOAuth2TokenRequest(token_url, params);
    return {
      ...tokenInfo,
      refreshToken: tokenInfo.refreshToken || refreshToken, // Preserve existing refresh token if new one not provided
    };
  }

  private getCacheKey(credentials: AuthCredentials): string {
    let identifier = 'default';

    switch (credentials.type) {
    case 'oauth2':
      identifier = credentials.credentials.client_id;
      break;
    case 'basic':
      identifier = credentials.credentials.username;
      break;
    case 'api_key':
      identifier = 'api_key';
      break;
    case 'token':
      identifier = credentials.credentials.accountId;
      break;
    case 'certificate':
      identifier = 'certificate';
      break;
    }

    const key = `${credentials.type}_${identifier}`;
    return Buffer.from(key).toString('base64');
  }

  private shouldSimulateOAuth2(credentials: AuthCredentials): credentials is Extract<AuthCredentials, { type: 'oauth2' }> {
    if (credentials.type !== 'oauth2') {
      return false;
    }

    const allowDemo = isDemoMode() || isTestEnvironment();
    if (!allowDemo) {
      return false;
    }

    const markers = [
      credentials.credentials.client_id,
      credentials.credentials.client_secret,
      credentials.credentials.token_url,
      credentials.credentials.scope,
    ]
      .filter(Boolean)
      .map(value => String(value).toLowerCase());

    return markers.some(value =>
      value.includes('demo') ||
      value.includes('test') ||
      value.includes('example') ||
      value.includes('localhost') ||
      value.includes('placeholder'),
    );
  }

  private createDemoOAuth2Token(credentials: Extract<AuthCredentials, { type: 'oauth2' }>): TokenInfo {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const clientId = credentials.credentials.client_id || 'integration-hub';
    const tokenUrl = credentials.credentials.token_url || '';
    const instanceUrlGuess = tokenUrl.toLowerCase().includes('salesforce')
      ? 'https://salesforce.demo.local'
      : 'https://demo.oauth.local';

    return {
      accessToken: `demo-access-token-${clientId}`,
      refreshToken: `demo-refresh-token-${clientId}`,
      expiresAt,
      tokenType: 'Bearer',
      scope: credentials.credentials.scope,
      instanceUrl: instanceUrlGuess,
      issued: now,
    };
  }

  /**
   * Makes an internal HTTP request to the OAuth2 token endpoint.
   * @param {string} tokenUrl - The URL of the token endpoint.
   * @param {URLSearchParams} params - The URL search parameters for the request body.
   * @returns {Promise<TokenInfo>} The parsed token information.
   * @throws {OAuth2Error | TokenError} If the request fails or returns an error.
   * @private
   */
  /**
   * Makes an internal HTTP request to the OAuth2 token endpoint.
   * @param {string} tokenUrl - The URL of the token endpoint.
   * @param {URLSearchParams} params - The URL search parameters for the request body.
   * @returns {Promise<TokenInfo>} The parsed token information.
   * @throws {OAuth2Error | TokenError} If the request fails or returns an error.
   * @private
   */
  private async _makeOAuth2TokenRequest(tokenUrl: string, params: URLSearchParams): Promise<TokenInfo> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.OAUTH2_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: params,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OAuth2Error(
          `Token request timed out after ${env.OAUTH2_REQUEST_TIMEOUT_MS}ms`,
          undefined,
          undefined,
          error,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorData = await response.text();
      let errorMessage = 'Token request failed';
      try {
        const parsedError = JSON.parse(errorData);
        errorMessage = parsedError.error_description || parsedError.error || errorMessage;
      } catch {
        errorMessage = errorData || errorMessage;
      }
      throw new OAuth2Error(
        `Token request failed: ${errorMessage}`,
        response.status,
        errorData,
      );
    }

    interface OAuth2TokenResponse {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
      instance_url?: string;
    }

    const data = await response.json() as OAuth2TokenResponse;
    const expiresIn = data.expires_in || 3600;
    const expiresAt = new Date(Date.now() + (expiresIn * 1000));

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope,
      instanceUrl: data.instance_url,
      issued: new Date(),
    };
  }

  clearTokenCache(credentials?: AuthCredentials): void {
    if (credentials) {
      const cacheKey = this.getCacheKey(credentials);
      this.tokenCache.delete(cacheKey);
    } else {
      this.tokenCache.clear();
    }
    this.logger.debug('Token cache cleared');
  }

  async hashPassword(password: string): Promise<string> {
    if (!password || password.length === 0) {
      throw new Error('Password cannot be empty');
    }
    return bcrypt.hash(password, AUTH_CONSTANTS.BCRYPT_SALT_ROUNDS);
  }

  private startTokenCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(() => {
      const now = new Date();
      const bufferMs = AUTH_CONSTANTS.TOKEN_CLEANUP_BUFFER_MS;
      const expiredKeys: string[] = [];

      this.tokenCache.forEach((token, key) => {
        // Only purge tokens that have been expired for longer than the buffer window
        if (token.expiresAt.getTime() + bufferMs < now.getTime()) {
          expiredKeys.push(key);
        }
      });

      expiredKeys.forEach(key => {
        this.tokenCache.delete(key);
        this.logger.debug(`Cleaned up expired token for key: ${key}`);
      });
    }, this.tokenCleanupIntervalMs);

    // Use unref() to prevent keeping Jest from exiting
    this.cleanupInterval.unref();
  }

  /**
   * Clears the token cleanup interval.
   * @private
   */
  private clearTokenCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  public destroy(): void {
    this.clearTokenCleanup();
    this.tokenCache.clear();
    this.refreshPromises.clear();
  }

  getTokenCacheStats(): {
    totalTokens: number;
    expiredTokens: number;
    tokensExpiringInHour: number;
    } {
    const now = new Date();
    const oneHour = 60 * 60 * 1000;

    let expiredTokens = 0;
    let tokensExpiringInHour = 0;

    for (const token of this.tokenCache.values()) {
      const nowMs = now.getTime();
      const expiresAt = token.expiresAt as unknown as Date | string | number;
      const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();

      // If expiresAt is invalid, treat as expired to avoid undercounting
      if (!Number.isFinite(expiresAtMs)) {
        expiredTokens++;
        continue;
      }

      const diff = expiresAtMs - nowMs;
      if (diff < 0) {
        // Already expired
        expiredTokens++;
      } else if (diff <= oneHour) {
        // Expires within the next hour (including exactly at 1h)
        tokensExpiringInHour++;
      }
    }

    return {
      totalTokens: this.tokenCache.size,
      expiredTokens,
      tokensExpiringInHour,
    };
  }
}
