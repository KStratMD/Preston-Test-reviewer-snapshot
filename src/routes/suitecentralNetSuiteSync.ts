import { Router, Request, Response, NextFunction } from 'express';
import { observabilityMiddlewareConfig } from '../config/observability';
import { createObservabilityMiddleware } from '../middleware/observabilityMiddleware';
import { asyncHandler } from '../middleware/asyncHandler';
import { runSuiteCentralNetSuiteSync } from '../integrations/SuiteCentralNetSuiteSync';
import type { IntegrationService } from '../services/IntegrationService';
import type { ObservabilityService } from '../observability';
import { syncRunsCounter } from './metrics';
import { logger } from '../utils/Logger';

export const createSuiteCentralNetSuiteSyncRouter = (
  integrationService: IntegrationService,
  observabilityService: ObservabilityService,
): Router => {
  const router = Router();

  router.use(createObservabilityMiddleware(observabilityService, observabilityMiddlewareConfig));

  /**
   * @openapi
   * /sync:
   *   post:
   *     summary: Run SuiteCentral to NetSuite synchronization
   *     description: Initiates a full synchronization between SuiteCentral and NetSuite systems
   *     responses:
   *       200:
   *         description: Sync completed successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 integrationId:
   *                   type: string
   *                 syncId:
   *                   type: string
   *                 status:
   *                   type: string
   *                 success:
   *                   type: boolean
   *                 recordsProcessed:
   *                   type: number
   *                 recordsSuccessful:
   *                   type: number
   *                 recordsFailed:
   *                   type: number
   *                 errors:
   *                   type: array
   *                   items:
   *                     type: string
   *                 startTime:
   *                   type: string
   *                   format: date-time
   *                 endTime:
   *                   type: string
   *                   format: date-time
   *                 processingMs:
   *                   type: number
   *                 processingTime:
   *                   type: string
   *       500:
   *         description: Internal server error
   */
  router.post(
    '/sync',
    asyncHandler(async (_req: Request, res: Response): Promise<void> => {
      syncRunsCounter.inc();
      const result = await runSuiteCentralNetSuiteSync(integrationService);
      try {
        integrationService.recordSyncResult('suitecentral-netsuite', result as any);
      } catch {/* ignore */}
      res.json(result);
    }),
  );

  /**
   * @openapi
   * /sync/status:
   *   get:
   *     summary: Get SuiteCentral to NetSuite sync status
   *     description: Returns the current status of the SuiteCentral to NetSuite synchronization
   *     responses:
   *       200:
   *         description: Current sync status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 configId:
   *                   type: string
   *                 isRunning:
   *                   type: boolean
   *                 lastSync:
   *                   type: string
   *                   format: date-time
   *                 lastSyncResult:
   *                   type: object
   *                 errorCount:
   *                   type: number
   *                 successCount:
   *                   type: number
   */
  router.get(
    '/sync/status',
    asyncHandler(async (_req: Request, res: Response): Promise<void> => {
      const status = integrationService.getIntegrationStatus('suitecentral-netsuite');
      res.json(status);
    }),
  );

  // Error handling middleware
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    try {
      logger.error('[suitecentralNetSuiteSync router] error:', err?.stack || err?.message || String(err));
    } catch {/* ignore */}
    res.status(500).json({ error: 'internal_error' });
  });

  return router;
};