import { initializeIntegrationSuite } from './SystemInfrastructureOrchestrator';
import { runSquireSuiteCentralSync } from './SquireSuiteCentralSync';
import { runSuiteCentralNetSuiteSync } from './SuiteCentralNetSuiteSync';
import type { IntegrationService } from '../services/IntegrationService';
import type { SyncResult } from '../types';

/**
 * Orchestrates an end-to-end sync from Squire → SuiteCentral → NetSuite.
 * First runs the Squire ↔ SuiteCentral sync to populate SuiteCentral, then
 * pushes those transformed records from SuiteCentral into NetSuite.
 */
export async function runSquireSuiteCentralNetSuiteSync(integrationService: IntegrationService): Promise<SyncResult> {
  const orchestrator = await initializeIntegrationSuite();
  const eventBus = orchestrator.getEventBus();

  eventBus.emit('sync:squire-suitecentral-netsuite:start', { timestamp: new Date() });

  const startTime = new Date();
  const squireSuiteCentralResult = await runSquireSuiteCentralSync(integrationService);
  const suiteCentralNetSuiteResult = await runSuiteCentralNetSuiteSync(integrationService, {
    skipSuiteCentralInit: true,
  });

  const combined: SyncResult = {
    integrationId: 'squire-suitecentral-netsuite',
    syncId: `sync_${Date.now()}`,
    status:
      squireSuiteCentralResult.success && suiteCentralNetSuiteResult.success
        ? 'success'
        : squireSuiteCentralResult.success || suiteCentralNetSuiteResult.success
          ? 'partial'
          : 'failed',
    success: squireSuiteCentralResult.success && suiteCentralNetSuiteResult.success,
    recordsProcessed:
      (squireSuiteCentralResult.recordsProcessed || 0) + (suiteCentralNetSuiteResult.recordsProcessed || 0),
    recordsSuccessful:
      (squireSuiteCentralResult.recordsSuccessful || 0) + (suiteCentralNetSuiteResult.recordsSuccessful || 0),
    recordsFailed: (squireSuiteCentralResult.recordsFailed || 0) + (suiteCentralNetSuiteResult.recordsFailed || 0),
    errors: [...(squireSuiteCentralResult.errors || []), ...(suiteCentralNetSuiteResult.errors || [])],
    startTime,
    endTime: new Date(),
  };

  try {
    const endMs = combined.endTime instanceof Date ? combined.endTime.getTime() : new Date(combined.endTime).getTime();
    const startMs = startTime.getTime();
    const ms = Math.max(0, endMs - startMs);
    combined.processingMs = ms;
    combined.processingTime = `${(ms / 1000).toFixed(1)}s`;
  } catch {
    /* ignore */
  }

  integrationService.recordSyncResult('squire-suitecentral-netsuite', combined);

  eventBus.emit('sync:squire-suitecentral-netsuite:complete', {
    timestamp: combined.endTime,
    result: combined,
  });

  return combined;
}
