import { Router } from 'express';
import { observabilityMiddlewareConfig } from '../config/observability';
import { createObservabilityMiddleware } from '../middleware/observabilityMiddleware';
import { asyncHandler } from '../middleware/asyncHandler';
import { runSquireSuiteCentralSync } from '../integrations/SquireSuiteCentralSync';
import type { IntegrationService } from '../services/IntegrationService';
import type { ObservabilityService } from '../observability';
import { syncRunsCounter, syncErrorsCounter } from './metrics';

export const createSuiteCentralSyncRouter = (
  integrationService: IntegrationService,
  observabilityService: ObservabilityService,
): Router => {
  const router = Router();

  router.use(createObservabilityMiddleware(observabilityService, observabilityMiddlewareConfig));

  router.post(
    '/',
    asyncHandler(async (_req, res) => {
      try {
        const result = await runSquireSuiteCentralSync(integrationService);
        syncRunsCounter.inc();
        // Ensure processing duration fields are present for clients
        try {
          if (result && (result as any).processingMs === undefined && result.startTime && result.endTime) {
            const startMs = (result.startTime instanceof Date) ? result.startTime.getTime() : new Date(result.startTime).getTime();
            const endMs = (result.endTime instanceof Date) ? result.endTime.getTime() : new Date(result.endTime).getTime();
            const ms = Math.max(0, endMs - startMs);
            (result as any).processingMs = ms;
            (result as any).processingTime = `${(ms / 1000).toFixed(1)}s`;
          }
        } catch (_e) { /* ignore */ }
        res.json(result);
      } catch (error) {
        syncErrorsCounter.inc();
        try {
          const stack = error && (error as any).stack ? (error as any).stack : String(error);
          process.stderr.write('[ROUTE ERROR] /sync handler caught error: ' + stack + '\n');
        } catch (loggingErr) {
          process.stderr.write('[ROUTE ERROR] error serializing thrown error: ' + String(loggingErr) + '\n');
        }
        throw error;
      }
    }),
  );

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const status = integrationService.getIntegrationStatus('squire-suitecentral');
      res.json(status);
    }),
  );

  return router;
};
