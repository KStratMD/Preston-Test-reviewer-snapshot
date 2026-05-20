import { Router, type Request, type Response } from 'express';
// Small local type to represent authenticated requests used in logging.
// Keeps the file-level changes minimal and avoids repeating `any` casts.
type AuthRequest = Request & { user?: { id?: string } };
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SecureCredentialManager } from '../services/SecureCredentialManager';
import type { SecureConfigurationService } from '../services/SecureConfigurationService';
import type { Logger } from '../utils/Logger';
import { authMiddleware } from '../middleware/auth';
import { rbacMiddleware } from '../middleware/rbac';
import { validationMiddleware } from '../middleware/validation';
import { z } from 'zod';

const router = Router();
const credentialManager = container.get<SecureCredentialManager>(TYPES.SecureCredentialManager);
const secureConfigService = container.get<SecureConfigurationService>(TYPES.SecureConfigurationService);
const logger = container.get<Logger>(TYPES.Logger);

// Validation schemas
const storeCredentialsSchema = z.object({
  systemType: z.string().min(1),
  systemId: z.string().min(1),
  credentials: z.record(z.string(), z.any()),
});

const rotateCredentialsSchema = z.object({
  systemType: z.string().min(1),
  systemId: z.string().min(1),
  newCredentials: z.record(z.string(), z.any()),
});

const updateIntegrationCredentialsSchema = z.object({
  systemType: z.enum(['source', 'target']),
  newCredentials: z.record(z.string(), z.any()),
});

/**
 * @swagger
 * components:
 *   schemas:
 *     CredentialMetadata:
 *       type: object
 *       properties:
 *         systemType:
 *           type: string
 *           description: Type of the system (NetSuite, Salesforce, etc.)
 *         systemId:
 *           type: string
 *           description: Unique identifier for the system instance
 *         credentialType:
 *           type: string
 *           description: Type of credentials (oauth1, oauth2, basic, api_key)
 *         lastRotated:
 *           type: string
 *           format: date-time
 *           description: When credentials were last rotated
 *         rotationRequired:
 *           type: boolean
 *           description: Whether credentials need rotation
 *         accessCount:
 *           type: number
 *           description: Number of times credentials have been accessed
 */

/**
 * @swagger
 * /api/credentials:
 *   get:
 *     summary: List all stored credentials (metadata only)
 *     description: Returns metadata for all stored credentials without exposing sensitive data
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of credential metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CredentialMetadata'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
import { asyncHandler } from '../middleware/asyncHandler';

router.get('/', authMiddleware, rbacMiddleware(['admin', 'security_manager']), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const credentials = await credentialManager.listCredentials();

  logger.info('Credentials listed', {
    userId,
    count: credentials.length,
    operation: 'list_credentials',
  });

  res.json({
    success: true,
    data: credentials,
  });
}));

/**
 * @swagger
 * /api/credentials:
 *   post:
 *     summary: Store new system credentials
 *     description: Securely store credentials for a system using the configured secret manager
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - systemType
 *               - systemId
 *               - credentials
 *             properties:
 *               systemType:
 *                 type: string
 *                 description: Type of system (NetSuite, Salesforce, etc.)
 *                 example: NetSuite
 *               systemId:
 *                 type: string
 *                 description: Unique identifier for the system instance
 *                 example: production
 *               credentials:
 *                 type: object
 *                 description: Credential object (structure depends on system type)
 *                 example:
 *                   accountId: "12345"
 *                   consumerKey: "abcd1234"
 *                   consumerSecret: "secret123"
 *                   tokenId: "token456"
 *                   tokenSecret: "tokensecret789"
 *     responses:
 *       201:
 *         description: Credentials stored successfully
 *       400:
 *         description: Invalid request data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.post(
  '/',
  authMiddleware,
  rbacMiddleware(['admin', 'security_manager']),
  validationMiddleware(storeCredentialsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { systemType, systemId, credentials } = req.body;

    await credentialManager.storeCredentials(systemType, systemId, credentials);

    logger.info('Credentials stored successfully', {
      systemType,
      systemId,
      userId,
      operation: 'store_credentials',
    });

    res.status(201).json({
      success: true,
      message: 'Credentials stored successfully',
    });
  }),
);

/**
 * @swagger
 * /api/credentials/{systemType}/{systemId}:
 *   get:
 *     summary: Get credential metadata for a specific system
 *     description: Returns metadata for credentials without exposing sensitive data
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: systemType
 *         required: true
 *         schema:
 *           type: string
 *         description: Type of system
 *       - in: path
 *         name: systemId
 *         required: true
 *         schema:
 *           type: string
 *         description: System identifier
 *     responses:
 *       200:
 *         description: Credential metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/CredentialMetadata'
 *       404:
 *         description: Credentials not found
 */
router.get(
  '/:systemType/:systemId',
  authMiddleware,
  rbacMiddleware(['admin', 'security_manager', 'integration_manager']),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { systemType, systemId } = req.params;

    if (!systemType) {
      res.status(400).json({
        success: false,
        error: 'System type is required',
      });
      return;
    }

    if (!systemId) {
      res.status(400).json({
        success: false,
        error: 'System ID is required',
      });
      return;
    }

    const metadata = await credentialManager.getCredentialMetadata(systemType, systemId);

    if (!metadata) {
      res.status(404).json({
        success: false,
        error: 'Credentials not found',
      });
      return;
    }

    logger.info('Credential metadata retrieved', {
      systemType,
      systemId,
      userId,
      operation: 'get_credential_metadata',
    });

    res.json({
      success: true,
      data: metadata,
    });
  }),
);

/**
 * @swagger
 * /api/credentials/{systemType}/{systemId}:
 *   delete:
 *     summary: Delete system credentials
 *     description: Remove credentials from secure storage
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: systemType
 *         required: true
 *         schema:
 *           type: string
 *         description: Type of system
 *       - in: path
 *         name: systemId
 *         required: true
 *         schema:
 *           type: string
 *         description: System identifier
 *     responses:
 *       200:
 *         description: Credentials deleted successfully
 *       404:
 *         description: Credentials not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.delete(
  '/:systemType/:systemId',
  authMiddleware,
  rbacMiddleware(['admin', 'security_manager']),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { systemType, systemId } = req.params;

    if (!systemType) {
      res.status(400).json({
        success: false,
        error: 'System type is required',
      });
      return;
    }

    if (!systemId) {
      res.status(400).json({
        success: false,
        error: 'System ID is required',
      });
      return;
    }

    await credentialManager.deleteCredentials(systemType, systemId);

    logger.info('Credentials deleted successfully', {
      systemType,
      systemId,
      userId,
      operation: 'delete_credentials',
    });

    res.json({
      success: true,
      message: 'Credentials deleted successfully',
    });
  }),
);

/**
 * @swagger
 * /api/credentials/rotate:
 *   post:
 *     summary: Rotate system credentials
 *     description: Replace existing credentials with new ones, keeping backup
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - systemType
 *               - systemId
 *               - newCredentials
 *             properties:
 *               systemType:
 *                 type: string
 *               systemId:
 *                 type: string
 *               newCredentials:
 *                 type: object
 *     responses:
 *       200:
 *         description: Credentials rotated successfully
 *       400:
 *         description: Invalid request data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.post(
  '/rotate',
  authMiddleware,
  rbacMiddleware(['admin', 'security_manager']),
  validationMiddleware(rotateCredentialsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { systemType, systemId, newCredentials } = req.body;

    await credentialManager.rotateCredentials(systemType, systemId, newCredentials);

    logger.info('Credentials rotated successfully', {
      systemType,
      systemId,
      userId,
      operation: 'rotate_credentials',
    });

    res.json({
      success: true,
      message: 'Credentials rotated successfully',
    });
  }),
);

/**
 * @swagger
 * /api/credentials/health:
 *   get:
 *     summary: Get credential health status
 *     description: Returns overview of credential health across all integrations
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Credential health status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalIntegrations:
 *                       type: number
 *                     credentialsNeedingRotation:
 *                       type: number
 *                     expiredCredentials:
 *                       type: number
 *                     healthyCredentials:
 *                       type: number
 *                     details:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           integrationId:
 *                             type: string
 *                           systemType:
 *                             type: string
 *                           systemId:
 *                             type: string
 *                           status:
 *                             type: string
 *                             enum: [healthy, needs_rotation, expired]
 *                           daysSinceRotation:
 *                             type: number
 */
router.get(
  '/health',
  authMiddleware,
  rbacMiddleware(['admin', 'security_manager', 'integration_manager']),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const healthStatus = await secureConfigService.getCredentialHealthStatus();

    logger.info('Credential health status retrieved', {
      userId,
      totalIntegrations: healthStatus.totalIntegrations,
      needsRotation: healthStatus.credentialsNeedingRotation,
      operation: 'get_credential_health',
    });

    res.json({
      success: true,
      data: healthStatus,
    });
  }),
);

/**
 * @swagger
 * /api/credentials/security/validate:
 *   get:
 *     summary: Validate credential security across all integrations
 *     description: Performs security audit of all integration credentials
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Security validation results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalIntegrations:
 *                       type: number
 *                     secureIntegrations:
 *                       type: number
 *                     insecureIntegrations:
 *                       type: number
 *                     issues:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           integrationId:
 *                             type: string
 *                           issue:
 *                             type: string
 *                           severity:
 *                             type: string
 *                             enum: [high, medium, low]
 *                           recommendation:
 *                             type: string
 */
router.get(
  '/security/validate',
  authMiddleware,
  rbacMiddleware(['admin', 'security_manager']),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const validationResults = await secureConfigService.validateCredentialSecurity();

    logger.info('Credential security validation completed', {
      userId,
      totalIntegrations: validationResults.totalIntegrations,
      secureIntegrations: validationResults.secureIntegrations,
      insecureIntegrations: validationResults.insecureIntegrations,
      issues: validationResults.issues.length,
      operation: 'validate_credential_security',
    });

    res.json({
      success: true,
      data: validationResults,
    });
  }),
);

/**
 * @swagger
 * /api/credentials/migrate:
 *   post:
 *     summary: Migrate credentials to secure storage
 *     description: Migrate existing credentials from environment variables and inline configs to secret manager
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Migration completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     migratedIntegrations:
 *                       type: number
 *                     migratedCredentials:
 *                       type: number
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: string
 */
router.post('/migrate', authMiddleware, rbacMiddleware(['admin']), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const migrationResults = await secureConfigService.migrateToSecureCredentials();

  logger.info('Credential migration completed', {
    userId,
    migratedIntegrations: migrationResults.migratedIntegrations,
    migratedCredentials: migrationResults.migratedCredentials,
    errors: migrationResults.errors.length,
    operation: 'migrate_credentials',
  });

  res.json({
    success: true,
    data: migrationResults,
  });
}));

/**
 * @swagger
 * /api/credentials/integrations/{integrationId}/credentials:
 *   put:
 *     summary: Update credentials for an integration
 *     description: Update credentials for a specific system within an integration
 *     tags: [Credentials]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: integrationId
 *         required: true
 *         schema:
 *           type: string
 *         description: Integration identifier
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - systemType
 *               - newCredentials
 *             properties:
 *               systemType:
 *                 type: string
 *                 enum: [source, target]
 *               newCredentials:
 *                 type: object
 *     responses:
 *       200:
 *         description: Integration credentials updated
 *       400:
 *         description: Invalid request data
 *       404:
 *         description: Integration not found
 */
router.put(
  '/integrations/:integrationId/credentials',
  authMiddleware,
  rbacMiddleware(['admin', 'security_manager', 'integration_manager']),
  validationMiddleware(updateIntegrationCredentialsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    const { integrationId } = req.params;
    const { systemType, newCredentials } = req.body;

    if (!integrationId) {
      res.status(400).json({
        success: false,
        error: 'Integration ID is required',
      });
      return;
    }

    await secureConfigService.updateIntegrationCredentials(integrationId, systemType, newCredentials);

    logger.info('Integration credentials updated', {
      integrationId,
      systemType,
      userId,
      operation: 'update_integration_credentials',
    });

    res.json({
      success: true,
      message: 'Integration credentials updated successfully',
    });
  }),
);

export { router as credentialsRouter };
