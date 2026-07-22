import { injectable, inject } from 'inversify';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { DatabaseService } from '../database/DatabaseService';
import type { AuditLogRepository } from '../database/repositories/AuditLogRepository';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';

export interface OAuthClient {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  isActive: boolean;
  tenantId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  userId: string;
  scopes: string[];
  redirectUri: string;
  expiresAt: Date;
  used: boolean;
}

export interface AccessToken {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken?: string;
  scope: string;
  userId: string;
  clientId: string;
  tenantId?: string;
}

export interface RefreshTokenData {
  token: string;
  userId: string;
  clientId: string;
  scopes: string[];
  expiresAt: Date;
  tenantId?: string;
}

export interface OIDCClaims {
  iss: string; // issuer
  sub: string; // subject (user ID)
  aud: string; // audience (client ID)
  exp: number; // expiration time
  iat: number; // issued at
  auth_time?: number; // authentication time
  nonce?: string; // nonce
  acr?: string; // authentication context class reference
  amr?: string[]; // authentication methods references
  azp?: string; // authorized party
  scope?: string;
  tenant_id?: string;
  email?: string;
  name?: string;
  role?: string;
}

/**
 * OAuth2 and OpenID Connect service
 * Provides comprehensive authentication and authorization capabilities
 */
@injectable()
export class OAuth2Service {
  private readonly logger: Logger;
  private readonly databaseService: DatabaseService;
  private readonly auditLogRepository: AuditLogRepository;
  private readonly issuer: string;
  private readonly accessTokenTTL = 3600; // 1 hour
  private readonly refreshTokenTTL = 86400 * 7; // 7 days
  private readonly authCodeTTL = 600; // 10 minutes

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.DatabaseService) databaseService: DatabaseService,
    @inject(TYPES.AuditLogRepository) auditLogRepository: AuditLogRepository,
  ) {
    this.logger = logger;
    this.databaseService = databaseService;
    this.auditLogRepository = auditLogRepository;
    this.issuer = process.env.OAUTH_ISSUER || 'https://integration-hub.local';
  }

  /**
   * Initialize OAuth2 service and create default client if needed
   */
  async initialize(): Promise<void> {
    try {
      await this.createTablesIfNotExist();
      await this.createDefaultClient();

      this.logger.info('OAuth2 service initialized', { issuer: this.issuer });
    } catch (error) {
      this.logger.error('Failed to initialize OAuth2 service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Register a new OAuth2 client
   */
  async registerClient(
    name: string,
    redirectUris: string[],
    grantTypes: string[] = ['authorization_code', 'refresh_token'],
    scopes: string[] = ['read', 'write'],
    tenantId?: string,
  ): Promise<OAuthClient> {
    try {
      const clientId = this.generateClientId();
      const clientSecret = this.generateClientSecret();

      const client: OAuthClient = {
        id: crypto.randomUUID(),
        name,
        clientId,
        clientSecret,
        redirectUris,
        grantTypes,
        scopes,
        isActive: true,
        tenantId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const db = this.databaseService.getDatabase();
      await db
        .insertInto('oauth_clients')
        .values({
          id: client.id,
          name: client.name,
          client_id: client.clientId,
          client_secret: await this.hashSecret(client.clientSecret),
          redirect_uris: JSON.stringify(client.redirectUris),
          grant_types: JSON.stringify(client.grantTypes),
          scopes: JSON.stringify(client.scopes),
          is_active: client.isActive,
          tenant_id: client.tenantId,
          created_at: client.createdAt,
          updated_at: client.updatedAt,
        })
        .execute();

      // Audit log
      await this.auditLogRepository.create({
        tenant_id: tenantId ?? SYSTEM_IDENTITY.tenantId,
        user_id: 'system',
        action: 'oauth_client_created',
        resource_type: 'oauth_client',
        resource_id: client.id,
        old_values: null,
        new_values: {
          name: client.name,
          clientId: client.clientId,
          redirectUris: client.redirectUris,
          grantTypes: client.grantTypes,
          scopes: client.scopes,
        },
        ip_address: null,
        user_agent: null,
      });

      this.logger.info('OAuth2 client registered', {
        clientId: client.clientId,
        name: client.name,
        tenantId,
      });

      return client;
    } catch (error) {
      this.logger.error('Failed to register OAuth2 client', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate authorization URL for OAuth2 flow
   */
  generateAuthorizationUrl(
    clientId: string,
    redirectUri: string,
    scopes: string[] = ['read'],
    state?: string,
    nonce?: string,
  ): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
    });

    if (state) {
      params.append('state', state);
    }

    if (nonce) {
      params.append('nonce', nonce);
    }

    return `${this.issuer}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Create authorization code
   */
  async createAuthorizationCode(
    clientId: string,
    userId: string,
    redirectUri: string,
    scopes: string[],
  ): Promise<string> {
    try {
      const code = this.generateAuthorizationCode();
      const expiresAt = new Date(Date.now() + this.authCodeTTL * 1000);

      const authCode: AuthorizationCode = {
        code,
        clientId,
        userId,
        scopes,
        redirectUri,
        expiresAt,
        used: false,
      };

      const db = this.databaseService.getDatabase();
      await db
        .insertInto('oauth_authorization_codes')
        .values({
          code: authCode.code,
          client_id: authCode.clientId,
          user_id: authCode.userId,
          scopes: JSON.stringify(authCode.scopes),
          redirect_uri: authCode.redirectUri,
          expires_at: authCode.expiresAt,
          used: authCode.used,
          created_at: new Date(),
        })
        .execute();

      this.logger.debug('Authorization code created', {
        clientId,
        userId,
        scopes,
        expiresAt,
      });

      return code;
    } catch (error) {
      this.logger.error('Failed to create authorization code', {
        clientId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<AccessToken> {
    try {
      // Verify client credentials
      const client = await this.verifyClient(clientId, clientSecret);
      if (!client) {
        throw new Error('Invalid client credentials');
      }

      // Get and validate authorization code
      const db = this.databaseService.getDatabase();
      const authCode = await db
        .selectFrom('oauth_authorization_codes')
        .selectAll()
        .where('code', '=', code)
        .where('client_id', '=', clientId)
        .where('redirect_uri', '=', redirectUri)
        .where('used', '=', false)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();

      if (!authCode) {
        throw new Error('Invalid or expired authorization code');
      }

      // Mark code as used
      await db
        .updateTable('oauth_authorization_codes')
        .set({ used: true, updated_at: new Date() })
        .where('code', '=', code)
        .execute();

      // Generate tokens
      const userId = authCode.user_id;
      if (!userId) {
        throw new Error('Authorization code missing user ID');
      }

      const accessToken = await this.generateAccessToken(
        userId,
        clientId,
        JSON.parse(authCode.scopes),
        client.tenantId || undefined,
      );

      const refreshToken = await this.generateRefreshToken(
        userId,
        clientId,
        JSON.parse(authCode.scopes),
        client.tenantId || undefined,
      );

      // Audit log
      await this.auditLogRepository.create({
        tenant_id: client.tenantId ?? SYSTEM_IDENTITY.tenantId,
        user_id: userId,
        action: 'access_token_generated',
        resource_type: 'oauth_token',
        resource_id: `${accessToken.token.substring(0, 16)}...`,
        old_values: null,
        new_values: {
          clientId,
          scopes: JSON.parse(authCode.scopes) as string[],
          hasRefreshToken: !!refreshToken,
        },
        ip_address: null,
        user_agent: null,
      });

      return {
        token: accessToken.token,
        tokenType: 'Bearer',
        expiresIn: this.accessTokenTTL,
        refreshToken: refreshToken?.token,
        scope: (JSON.parse(authCode.scopes) as string[]).join(' '),
        userId,
        clientId,
        tenantId: client.tenantId,
      };
    } catch (error) {
      this.logger.error('Failed to exchange code for token', {
        clientId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<AccessToken> {
    try {
      // Verify client credentials
      const client = await this.verifyClient(clientId, clientSecret);
      if (!client) {
        throw new Error('Invalid client credentials');
      }

      // Verify refresh token
      const db = this.databaseService.getDatabase();
      const refreshTokenData = await db
        .selectFrom('oauth_refresh_tokens')
        .selectAll()
        .where('token', '=', refreshToken)
        .where('client_id', '=', clientId)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();

      if (!refreshTokenData) {
        throw new Error('Invalid or expired refresh token');
      }

      const refreshUserId = refreshTokenData.user_id;
      if (!refreshUserId) {
        throw new Error('Refresh token missing user ID');
      }

      // Generate new access token
      const accessToken = await this.generateAccessToken(
        refreshUserId,
        clientId,
        JSON.parse(refreshTokenData.scopes) as string[],
        client.tenantId ?? undefined,
      );

      return {
        token: accessToken.token,
        tokenType: 'Bearer',
        expiresIn: this.accessTokenTTL,
        refreshToken, // Keep the same refresh token
        scope: (JSON.parse(refreshTokenData.scopes) as string[]).join(' '),
        userId: refreshUserId,
        clientId,
        tenantId: client.tenantId,
      };
    } catch (error) {
      this.logger.error('Failed to refresh access token', {
        clientId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate access token and return claims
   */
  async validateAccessToken(token: string): Promise<OIDCClaims | null> {
    try {
      // Pin HS256 (A3): access tokens are symmetric-signed with JWT_SECRET.
      const verified = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] });
      // jwt.verify returns `string` for non-JSON payloads; a string has no
      // exp claim, so the expiry check below would silently pass and the
      // function could hand back a string as OIDCClaims. Reject it outright.
      if (typeof verified === 'string') {
        return null;
      }
      const decoded = verified as OIDCClaims;

      // Check if token is not expired
      if (decoded.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }

      // Verify token exists in database and is not revoked
      const db = this.databaseService.getDatabase();
      const storedToken = await db
        .selectFrom('oauth_access_tokens')
        .selectAll()
        .where('token_hash', '=', this.hashToken(token))
        .where('revoked', '=', false)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();

      if (!storedToken) {
        return null;
      }

      return decoded;
    } catch (error) {
      this.logger.debug('Token validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Revoke access token
   */
  async revokeToken(token: string, userId?: string): Promise<void> {
    try {
      const db = this.databaseService.getDatabase();
      const tokenHash = this.hashToken(token);

      let query = db
        .updateTable('oauth_access_tokens')
        .set({
          revoked: true,
          revoked_at: new Date(),
          updated_at: new Date(),
        })
        .where('token_hash', '=', tokenHash);

      if (userId) {
        query = query.where('user_id', '=', userId);
      }

      await query.execute();

      this.logger.info('Access token revoked', { userId });
    } catch (error) {
      this.logger.error('Failed to revoke token', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get OIDC discovery document
   */
  getDiscoveryDocument(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      userinfo_endpoint: `${this.issuer}/oauth/userinfo`,
      jwks_uri: `${this.issuer}/.well-known/jwks.json`,
      scopes_supported: ['openid', 'profile', 'email', 'read', 'write', 'admin'],
      response_types_supported: ['code', 'token', 'id_token'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['HS256', 'RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'email', 'name', 'role'],
    };
  }

  /**
   * Generate access token
   */
  private async generateAccessToken(
    userId: string,
    clientId: string,
    scopes: string[],
    tenantId?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + this.accessTokenTTL) * 1000);

    const claims: OIDCClaims = {
      iss: this.issuer,
      sub: userId,
      aud: clientId,
      exp: now + this.accessTokenTTL,
      iat: now,
      scope: scopes.join(' '),
      tenant_id: tenantId,
    };

    const token = jwt.sign(claims, process.env.JWT_SECRET!);

    // Store token in database
    const db = this.databaseService.getDatabase();
    await db
      .insertInto('oauth_access_tokens')
      .values({
        id: crypto.randomUUID(),
        token_hash: this.hashToken(token),
        user_id: userId,
        client_id: clientId,
        scopes: JSON.stringify(scopes),
        expires_at: expiresAt,
        tenant_id: tenantId,
        revoked: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    return { token, expiresAt };
  }

  /**
   * Generate refresh token
   */
  private async generateRefreshToken(
    userId: string,
    clientId: string,
    scopes: string[],
    tenantId?: string,
  ): Promise<RefreshTokenData> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.refreshTokenTTL * 1000);

    const refreshTokenData: RefreshTokenData = {
      token,
      userId,
      clientId,
      scopes,
      expiresAt,
      tenantId,
    };

    // Store refresh token in database
    const db = this.databaseService.getDatabase();
    await db
      .insertInto('oauth_refresh_tokens')
      .values({
        id: crypto.randomUUID(),
        token,
        user_id: userId,
        client_id: clientId,
        scopes: JSON.stringify(scopes),
        expires_at: expiresAt,
        tenant_id: tenantId,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    return refreshTokenData;
  }

  /**
   * Verify client credentials
   */
  private async verifyClient(clientId: string, clientSecret: string): Promise<OAuthClient | null> {
    try {
      const db = this.databaseService.getDatabase();
      const client = await db
        .selectFrom('oauth_clients')
        .selectAll()
        .where('client_id', '=', clientId)
        .where('is_active', '=', true)
        .executeTakeFirst();

      if (!client) {
        return null;
      }

      const isValidSecret = await this.verifySecret(clientSecret, client.client_secret);
      if (!isValidSecret) {
        return null;
      }

      return {
        id: client.id,
        name: client.name,
        clientId: client.client_id,
        clientSecret: client.client_secret,
        redirectUris: JSON.parse(client.redirect_uris),
        grantTypes: JSON.parse(client.grant_types),
        scopes: JSON.parse(client.scopes),
        isActive: client.is_active,
        tenantId: client.tenant_id || undefined,
        createdAt: client.created_at,
        updatedAt: client.updated_at,
      };
    } catch (error) {
      this.logger.error('Failed to verify client', {
        clientId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create necessary database tables
   */
  private async createTablesIfNotExist(): Promise<void> {
    const db = this.databaseService.getDatabase();

    // Create oauth_clients table
    await db.schema
      .createTable('oauth_clients')
      .ifNotExists()
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('name', 'varchar(255)', (col) => col.notNull())
      .addColumn('client_id', 'varchar(255)', (col) => col.notNull().unique())
      .addColumn('client_secret', 'varchar(255)', (col) => col.notNull())
      .addColumn('redirect_uris', 'text', (col) => col.notNull())
      .addColumn('grant_types', 'text', (col) => col.notNull())
      .addColumn('scopes', 'text', (col) => col.notNull())
      .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('tenant_id', 'varchar(255)')
      .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo('now()'))
      .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo('now()'))
      .execute();

    // Create other OAuth tables...
    // (Implementation continues with other necessary tables)
  }

  /**
   * Create default client for development
   */
  private async createDefaultClient(): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      try {
        const db = this.databaseService.getDatabase();
        const existingClient = await db
          .selectFrom('oauth_clients')
          .selectAll()
          .where('client_id', '=', 'default-client')
          .executeTakeFirst();

        if (!existingClient) {
          await this.registerClient(
            'Default Development Client',
            ['http://localhost:3000/callback'],
            ['authorization_code', 'refresh_token'],
            ['read', 'write', 'admin'],
          );
        }
      } catch (error) {
        this.logger.debug('Could not create default client', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private generateClientId(): string {
    return `client_${crypto.randomBytes(16).toString('hex')}`;
  }

  private generateClientSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private generateAuthorizationCode(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private async hashSecret(secret: string): Promise<string> {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }

  private async verifySecret(plaintext: string, hash: string): Promise<boolean> {
    const plaintextHash = await this.hashSecret(plaintext);
    return plaintextHash === hash;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
