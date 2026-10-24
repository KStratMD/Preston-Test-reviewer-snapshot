import { Router, Request, Response, NextFunction } from 'express';
import { injectable, inject } from 'inversify';
import crypto from 'crypto';
import { ConnectorCredentialService } from '../services/ConnectorCredentialService';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import { AuthenticationMiddleware } from '../middleware/authentication';

/**
 * ConnectorCredentialRouter
 *
 * REST API endpoints for secure connector credential management:
 * - POST   /api/connector-credentials           - Store/update credentials
 * - GET    /api/connector-credentials           - List all user's credentials
 * - GET    /api/connector-credentials/:id/:env  - Get specific credentials
 * - DELETE /api/connector-credentials/:id/:env  - Delete credentials
 * - POST   /api/connector-credentials/:id/:env/test - Test credentials
 * - GET    /api/connector-metadata              - List available connectors
 * - GET    /api/connector-metadata/:id          - Get connector metadata
 *
 * Security:
 * - All credential endpoints require authentication via OAuth2 or API key
 * - User ID extracted from verified authentication context (req.auth)
 * - Supports both numeric and string user IDs (hashed to integers for database compatibility)
 * - Credentials encrypted at rest with AES-256-GCM
 * - Complete audit trail for all operations
 * - Sensitive fields sanitized in responses
 */
@injectable()
export class ConnectorCredentialRouter {
  public router: Router;

  constructor(
    @inject(TYPES.ConnectorCredentialService) private credentialService: ConnectorCredentialService,
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.AuthenticationMiddleware) private authMiddleware: AuthenticationMiddleware
  ) {
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    // Authentication middleware for all credential endpoints
    const requireAuth = this.authMiddleware.authenticate({ requireAuth: true });

    // Credential management endpoints - ALL require authentication
    this.router.post('/connector-credentials', requireAuth, this.storeCredentials.bind(this));
    this.router.get('/connector-credentials', requireAuth, this.listCredentials.bind(this));
    this.router.get('/connector-credentials/:connectorId/:environment', requireAuth, this.getCredentials.bind(this));
    this.router.delete('/connector-credentials/:connectorId/:environment', requireAuth, this.deleteCredentials.bind(this));
    this.router.post('/connector-credentials/:connectorId/:environment/test', requireAuth, this.testCredentials.bind(this));

    // Connector metadata endpoints - public (no auth required)
    this.router.get('/connector-metadata', this.listConnectors.bind(this));
    this.router.get('/connector-metadata/:connectorId', this.getConnectorMetadata.bind(this));
  }

  /**
   * Extract authenticated user ID from request
   * Supports both numeric and string user IDs (UUIDs, emails, etc.)
   *
   * @throws Error if user is not authenticated or user ID cannot be extracted
   * @returns User ID as number (parsed for numeric IDs, hashed for string IDs)
   */
  private getUserId(req: Request): number {
    // Defense-in-depth: ensure authentication middleware ran
    // This check is technically redundant if middleware is configured correctly,
    // but provides safety for security-critical credential operations
    if (!req.auth) {
      throw new Error('Authentication required: no auth context found. This endpoint requires authentication.');
    }

    let userIdString: string;

    // OAuth: user ID is in sub claim
    if (req.auth.type === 'oauth' && req.auth.user?.sub) {
      userIdString = req.auth.user.sub;
    }
    // API Key: use createdBy field
    else if (req.auth.type === 'api_key' && req.auth.apiKey?.createdBy) {
      userIdString = req.auth.apiKey.createdBy;
    }
    else {
      // Authenticated but missing expected user ID field - include diagnostics
      throw new Error(
        `Unable to extract user ID from authentication context. ` +
        `Auth type: ${req.auth.type}, has OAuth user: ${!!req.auth.user}, has API key: ${!!req.auth.apiKey}`
      );
    }

    // Try to parse as number first (for backward compatibility with numeric user IDs)
    const numericId = parseInt(userIdString, 10);
    if (!isNaN(numericId) && numericId.toString() === userIdString) {
      return numericId;
    }

    // For non-numeric user IDs (UUIDs, emails, etc.), hash to a consistent integer
    // TODO: Migrate database schema to support string user_id (TEXT) instead of INTEGER
    // For now, we hash string IDs to maintain backward compatibility with INTEGER columns
    return this.hashUserIdToInt(userIdString);
  }

  /**
   * SECURITY: Hash a string user ID to a positive integer using cryptographic hash
   * Uses SHA-256 for collision resistance and deterministic mapping
   *
   * @param userId - String user ID (UUID, email, etc.)
   * @returns Positive integer between 1 and 2^31-1
   */
  private hashUserIdToInt(userId: string): number {
    // SECURITY: Use cryptographic hash (SHA-256) instead of simple djb2-style hash
    // This provides much better collision resistance and is not predictable
    const hash = crypto.createHash('sha256').update(userId).digest();
    // Read first 4 bytes as unsigned 32-bit integer (big-endian)
    const value = hash.readUInt32BE(0);
    // Ensure positive and within safe integer range for SQLite (1 to 2^31-1)
    return (value % 2147483647) + 1;
  }

  /**
   * POST /api/connector-credentials
   * Store or update connector credentials
   *
   * Body:
   * {
   *   "connectorId": "netsuite",
   *   "connectorName": "NetSuite ERP",
   *   "credentials": {
   *     "accountId": "TSTDRV2698307",
   *     "consumerKey": "...",
   *     "consumerSecret": "...",
   *     "tokenId": "...",
   *     "tokenSecret": "..."
   *   },
   *   "credentialType": "oauth1",
   *   "environment": "sandbox",
   *   "organizationId": 123
   * }
   */
  private async storeCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Get user ID from verified authentication context
      const userId = this.getUserId(req);

      const {
        connectorId,
        connectorName,
        credentials,
        credentialType,
        environment = 'production',
        organizationId
      } = req.body;

      // Validate required fields
      if (!connectorId || !connectorName || !credentials || !credentialType) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: connectorId, connectorName, credentials, credentialType'
        });
        return;
      }

      // Validate environment
      const validEnvironments = ['production', 'sandbox', 'dev', 'test', 'staging'];
      if (!validEnvironments.includes(environment)) {
        res.status(400).json({
          success: false,
          error: `Invalid environment. Must be one of: ${validEnvironments.join(', ')}`
        });
        return;
      }

      // Validate credential type
      const validTypes = ['oauth1', 'oauth2', 'api_key', 'basic', 'custom'];
      if (!validTypes.includes(credentialType)) {
        res.status(400).json({
          success: false,
          error: `Invalid credentialType. Must be one of: ${validTypes.join(', ')}`
        });
        return;
      }

      const result = await this.credentialService.storeCredentials(
        userId,
        connectorId,
        connectorName,
        credentials,
        credentialType,
        environment,
        organizationId
      );

      res.json({
        success: true,
        data: {
          id: result.id,
          connectorId: result.connector_id,
          connectorName: result.connector_name,
          environment: result.environment,
          credentialType: result.credential_type,
          isActive: result.is_active,
          createdAt: result.created_at,
          updatedAt: result.updated_at
        }
      });
    } catch (error) {
      this.logger.error(`Error storing credentials: ${error instanceof Error ? error.message : String(error)}`);
      next(error);
    }
  }

  /**
   * GET /api/connector-credentials
   * List all connector credentials for the authenticated user
   *
   * Query params:
   * - activeOnly: boolean (default: true)
   */
  private async listCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Get user ID from verified authentication context
      const userId = this.getUserId(req);
      const activeOnly = req.query.activeOnly !== 'false';

      const credentials = await this.credentialService.listCredentials(userId, activeOnly);

      res.json({
        success: true,
        data: credentials.map(cred => ({
          id: cred.id,
          connectorId: cred.connector_id,
          connectorName: cred.connector_name,
          environment: cred.environment,
          credentialType: cred.credential_type,
          isActive: cred.is_active,
          lastTestedAt: cred.last_tested_at,
          lastTestStatus: cred.last_test_status,
          lastUsedAt: cred.last_used_at,
          expiresAt: cred.expires_at,
          createdAt: cred.created_at,
          updatedAt: cred.updated_at
        }))
      });
    } catch (error) {
      this.logger.error(`Error listing credentials: ${error instanceof Error ? error.message : String(error)}`);
      next(error);
    }
  }

  /**
   * GET /api/connector-credentials/:connectorId/:environment
   * Get specific connector credentials (decrypted)
   */
  private async getCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Get user ID from verified authentication context
      const userId = this.getUserId(req);
      const { connectorId, environment } = req.params;

      const result = await this.credentialService.getCredentials(userId, connectorId, environment);

      if (!result) {
        res.status(404).json({
          success: false,
          error: `No credentials found for ${connectorId} in ${environment} environment`
        });
        return;
      }

      res.json({
        success: true,
        data: {
          id: result.id,
          connectorId: result.connector_id,
          connectorName: result.connector_name,
          environment: result.environment,
          credentialType: result.credential_type,
          credentials: result.credentials, // Decrypted credentials
          isActive: result.is_active,
          lastTestedAt: result.last_tested_at,
          lastTestStatus: result.last_test_status,
          lastUsedAt: result.last_used_at,
          expiresAt: result.expires_at,
          createdAt: result.created_at,
          updatedAt: result.updated_at
        }
      });
    } catch (error) {
      this.logger.error(`Error getting credentials: ${error instanceof Error ? error.message : String(error)}`);
      next(error);
    }
  }

  /**
   * DELETE /api/connector-credentials/:connectorId/:environment
   * Delete connector credentials
   */
  private async deleteCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Get user ID from verified authentication context
      const userId = this.getUserId(req);
      const { connectorId, environment } = req.params;

      const deleted = await this.credentialService.deleteCredentials(userId, connectorId, environment);

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: `No credentials found for ${connectorId} in ${environment} environment`
        });
        return;
      }

      res.json({
        success: true,
        message: `Credentials deleted for ${connectorId} in ${environment} environment`
      });
    } catch (error) {
      this.logger.error(`Error deleting credentials: ${error instanceof Error ? error.message : String(error)}`);
      next(error);
    }
  }

  /**
   * POST /api/connector-credentials/:connectorId/:environment/test
   * Test connector credentials (decrypt and validate)
   */
  private async testCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Get user ID from verified authentication context
      const userId = this.getUserId(req);
      const { connectorId, environment } = req.params;

      const testResult = await this.credentialService.testCredentials(userId, connectorId, environment);

      res.json({
        success: testResult.success,
        data: {
          connectorId,
          environment,
          testSuccess: testResult.success,
          message: testResult.message,
          testedAt: testResult.timestamp
        }
      });
    } catch (error) {
      this.logger.error(`Error testing credentials: ${error instanceof Error ? error.message : String(error)}`);
      next(error);
    }
  }

  /**
   * GET /api/connector-metadata
   * List all available connectors
   *
   * Query params:
   * - activeOnly: boolean (default: true)
   */
  private async listConnectors(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const activeOnly = req.query.activeOnly !== 'false';

      const connectors = await this.credentialService.listConnectors(activeOnly);

      res.json({
        success: true,
        data: connectors.map(conn => ({
          id: conn.id,
          connectorId: conn.connector_id,
          connectorName: conn.connector_name,
          connectorType: conn.connector_type,
          supportedAuthTypes: conn.supported_auth_types,
          requiredCredentialFields: conn.required_credential_fields,
          optionalCredentialFields: conn.optional_credential_fields,
          defaultCredentialType: conn.default_credential_type,
          supportsSandbox: conn.supports_sandbox,
          supportsMultiEnvironment: conn.supports_multi_environment,
          connectionTestEndpoint: conn.connection_test_endpoint,
          documentationUrl: conn.documentation_url,
          vendorName: conn.vendor_name,
          vendorWebsite: conn.vendor_website,
          logoUrl: conn.logo_url,
          description: conn.description,
          isActive: conn.is_active,
          isBeta: conn.is_beta
        }))
      });
    } catch (error) {
      this.logger.error(`Error listing connectors: ${error instanceof Error ? error.message : String(error)}`);
      next(error);
    }
  }

  /**
   * GET /api/connector-metadata/:connectorId
   * Get metadata for a specific connector
   */
  private async getConnectorMetadata(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { connectorId } = req.params;

      const metadata = await this.credentialService.getConnectorMetadata(connectorId);

      if (!metadata) {
        res.status(404).json({
          success: false,
          error: `No metadata found for connector: ${connectorId}`
        });
        return;
      }

      res.json({
        success: true,
        data: {
          id: metadata.id,
          connectorId: metadata.connector_id,
          connectorName: metadata.connector_name,
          connectorType: metadata.connector_type,
          supportedAuthTypes: metadata.supported_auth_types,
          requiredCredentialFields: metadata.required_credential_fields,
          optionalCredentialFields: metadata.optional_credential_fields,
          defaultCredentialType: metadata.default_credential_type,
          supportsSandbox: metadata.supports_sandbox,
          supportsMultiEnvironment: metadata.supports_multi_environment,
          connectionTestEndpoint: metadata.connection_test_endpoint,
          documentationUrl: metadata.documentation_url,
          vendorName: metadata.vendor_name,
          vendorWebsite: metadata.vendor_website,
          logoUrl: metadata.logo_url,
          description: metadata.description,
          isActive: metadata.is_active,
          isBeta: metadata.is_beta
        }
      });
    } catch (error) {
      this.logger.error(`Error getting connector metadata: ${error instanceof Error ? error.message : String(error)}`);
      next(error);
    }
  }
}
