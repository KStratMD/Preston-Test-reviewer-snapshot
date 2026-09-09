import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { getConnectorRegistration } from '../connectors/connectorRegistry';
import { MockConnectorAdapter } from '../connectors/MockConnectorAdapter';
import { Logger } from '../utils/Logger';
import { AuthService } from '../services/AuthService';
import { container } from '../inversify/inversify.config';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';
import { TYPES } from '../inversify/types';

const router = Router();
const logger = new Logger('ConnectorTest');
const authService = new AuthService(logger);

/**
 * POST /api/test-connection
 * Test connection to any connector type
 *
 * Request body:
 * {
 *   connectorType: string (e.g., 'netsuite', 'salesforce'),
 *   connectorName: string (e.g., 'NetSuite', 'Salesforce'),
 *   configuration: {
 *     authType: string,
 *     ... (connector-specific credentials)
 *   }
 * }
 */
router.post('/test-connection', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { connectorType, connectorName, configuration } = req.body;

    if (!connectorType || !configuration) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: connectorType and configuration are required'
      });
    }

    let connector;
    let testResult;

    // Initialize the appropriate connector based on type
    switch (connectorType.toLowerCase()) {
      case 'netsuite':
        // For NetSuite, use the real connector via the canonical registry factory.
        {
          const outboundGovernance = container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
          connector = getConnectorRegistration('netsuite')!.factory!('netsuite-test', {
            logger,
            authService,
            outboundGovernance,
          });
        }

        try {
          await connector.initialize({
            type: 'oauth1',
            credentials: {
              accountId: configuration.accountId,
              consumerKey: configuration.consumerKey,
              consumerSecret: configuration.consumerSecret,
              tokenId: configuration.tokenId,
              tokenSecret: configuration.tokenSecret
            }
          });
          testResult = await connector.testConnection();

          return res.json({
            success: true,
            message: `✅ Successfully connected to ${connectorName}!`,
            connectionType: 'real',
            details: {
              responseTime: '245ms',
              apiVersion: testResult.version || 'N/A',
              permissions: testResult.permissions || ['read', 'write'],
              rateLimits: testResult.rateLimits || 'Available',
              connectionType: 'real'
            }
          });
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          return res.status(500).json({
            success: false,
            error: err.message,
            details: {
              suggestion: 'Check your NetSuite credentials and ensure the account ID, consumer key/secret, and token ID/secret are correct'
            }
          });
        }

      default:
        // For other connectors, use mock connector
        connector = new MockConnectorAdapter(connectorType.toLowerCase());
        await connector.initialize();
        testResult = await connector.testConnection();

        const mockDetails = testResult.details as Record<string, unknown> | undefined;
        return res.json({
          success: testResult.success,
          message: testResult.message,
          connectionType: (mockDetails?.connectionType as string) || 'demo',
          details: {
            ...(mockDetails ?? {}),
            responseTime: (mockDetails?.responseTime as string) || '150ms',
            apiVersion: (mockDetails?.version as string) || 'v1.0 (demo)',
            permissions: (mockDetails?.permissions as string[]) || ['read', 'write'],
            rateLimits: (mockDetails?.rateLimits as string) || 'Available',
            connectionType: (mockDetails?.connectionType as string) || 'demo',
          }
        });
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    return res.status(500).json({
      success: false,
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}));

export default router;
