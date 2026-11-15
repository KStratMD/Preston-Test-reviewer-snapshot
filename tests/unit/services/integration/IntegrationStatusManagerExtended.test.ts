/**
 * Comprehensive unit tests for IntegrationStatusManager
 * Covers: initializeStatus, updateStatus, markAsRunning, markAsCompleted,
 *         markAsFailed, getStatus, getAllStatuses, getRunningIntegrations,
 *         isRunning, getIntegrationCounts, getMetrics, removeStatus,
 *         clearAll, getStaleIntegrations, getProblematicIntegrations
 */
import 'reflect-metadata';
import { IntegrationStatusManager } from '../../../../src/services/integration/IntegrationStatusManager';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('IntegrationStatusManager', () => {
  let manager: IntegrationStatusManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new IntegrationStatusManager(mockLogger);
  });

  describe('initializeStatus', () => {
    it('should initialize a new integration status', () => {
      manager.initializeStatus('int-1');
      const status = manager.getStatus('int-1');
      expect(status).toBeDefined();
      expect(status!.configId).toBe('int-1');
      expect(status!.isRunning).toBe(false);
      expect(status!.errorCount).toBe(0);
      expect(status!.successCount).toBe(0);
      expect(status!.totalRuns).toBe(0);
    });

    it('should not overwrite existing status', () => {
      manager.initializeStatus('int-1');
      manager.markAsRunning('int-1');
      manager.initializeStatus('int-1'); // Should not overwrite
      expect(manager.isRunning('int-1')).toBe(true);
    });

    it('should log initialization', () => {
      manager.initializeStatus('int-log');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Initialized status for integration int-log')
      );
    });
  });

  describe('updateStatus', () => {
    it('should update an existing status', () => {
      manager.initializeStatus('int-1');
      manager.updateStatus('int-1', { isRunning: true });
      expect(manager.getStatus('int-1')!.isRunning).toBe(true);
    });

    it('should warn for unknown integration', () => {
      manager.updateStatus('unknown', { isRunning: true });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown integration unknown')
      );
    });

    it('should update the updatedAt timestamp', () => {
      manager.initializeStatus('int-1');
      const before = manager.getStatus('int-1')!.updatedAt;
      manager.updateStatus('int-1', { errorCount: 5 });
      const after = manager.getStatus('int-1')!.updatedAt;
      expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('markAsRunning', () => {
    it('should mark integration as running', () => {
      manager.initializeStatus('int-1');
      manager.markAsRunning('int-1');
      expect(manager.isRunning('int-1')).toBe(true);
      expect(manager.getStatus('int-1')!.isRunning).toBe(true);
    });
  });

  describe('markAsCompleted', () => {
    it('should update status on successful completion', () => {
      manager.initializeStatus('int-1');
      manager.markAsRunning('int-1');

      const result = { status: 'success', recordsProcessed: 100 } as any;
      manager.markAsCompleted('int-1', result, 500);

      const status = manager.getStatus('int-1')!;
      expect(status.isRunning).toBe(false);
      expect(status.successCount).toBe(1);
      expect(status.errorCount).toBe(0);
      expect(status.totalRuns).toBe(1);
      expect(status.averageRunTime).toBe(500);
      expect(status.lastSyncResult).toBe(result);
      expect(manager.isRunning('int-1')).toBe(false);
    });

    it('should update status on failed completion', () => {
      manager.initializeStatus('int-1');
      manager.markAsRunning('int-1');

      const result = { status: 'error', errors: ['Connection timeout'] } as any;
      manager.markAsCompleted('int-1', result, 1000);

      const status = manager.getStatus('int-1')!;
      expect(status.successCount).toBe(0);
      expect(status.errorCount).toBe(1);
      expect(status.lastError).toBe('Connection timeout');
    });

    it('should calculate average run time over multiple runs', () => {
      manager.initializeStatus('int-1');

      manager.markAsCompleted('int-1', { status: 'success' } as any, 100);
      manager.markAsCompleted('int-1', { status: 'success' } as any, 300);
      manager.markAsCompleted('int-1', { status: 'success' } as any, 200);

      const status = manager.getStatus('int-1')!;
      expect(status.averageRunTime).toBe(200);
      expect(status.totalRuns).toBe(3);
    });

    it('should warn for unknown integration', () => {
      manager.markAsCompleted('unknown', { status: 'success' } as any, 100);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown integration unknown')
      );
    });

    it('should cap run times at 100 entries', () => {
      manager.initializeStatus('int-1');
      for (let i = 0; i < 105; i++) {
        manager.markAsCompleted('int-1', { status: 'success' } as any, 100);
      }
      expect(manager.getStatus('int-1')!.totalRuns).toBe(105);
      // Average should still be correct
      expect(manager.getStatus('int-1')!.averageRunTime).toBe(100);
    });
  });

  describe('markAsFailed', () => {
    it('should update status on failure', () => {
      manager.initializeStatus('int-1');
      manager.markAsRunning('int-1');
      manager.markAsFailed('int-1', 'Network error', 200);

      const status = manager.getStatus('int-1')!;
      expect(status.isRunning).toBe(false);
      expect(status.errorCount).toBe(1);
      expect(status.totalRuns).toBe(1);
      expect(status.lastError).toBe('Network error');
      expect(status.averageRunTime).toBe(200);
    });

    it('should warn for unknown integration', () => {
      manager.markAsFailed('unknown', 'error', 100);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown integration unknown')
      );
    });
  });

  describe('getStatus', () => {
    it('should return undefined for unknown integration', () => {
      expect(manager.getStatus('unknown')).toBeUndefined();
    });
  });

  describe('getAllStatuses', () => {
    it('should return all statuses', () => {
      manager.initializeStatus('int-1');
      manager.initializeStatus('int-2');
      manager.initializeStatus('int-3');
      expect(manager.getAllStatuses().length).toBe(3);
    });

    it('should return empty array initially', () => {
      expect(manager.getAllStatuses()).toEqual([]);
    });
  });

  describe('getRunningIntegrations', () => {
    it('should return running integration IDs', () => {
      manager.initializeStatus('int-1');
      manager.initializeStatus('int-2');
      manager.markAsRunning('int-1');
      const running = manager.getRunningIntegrations();
      expect(running.size).toBe(1);
      expect(running.has('int-1')).toBe(true);
    });
  });

  describe('getIntegrationCounts', () => {
    it('should return correct counts', () => {
      manager.initializeStatus('int-1');
      manager.initializeStatus('int-2');
      manager.initializeStatus('int-3');
      manager.markAsRunning('int-1');
      manager.markAsFailed('int-2', 'Error', 100);

      const counts = manager.getIntegrationCounts();
      expect(counts.total).toBe(3);
      expect(counts.running).toBe(1);
      expect(counts.idle).toBe(2);
      expect(counts.withErrors).toBe(1);
    });
  });

  describe('getMetrics', () => {
    it('should return comprehensive metrics', () => {
      manager.initializeStatus('int-1');
      manager.initializeStatus('int-2');
      manager.markAsCompleted('int-1', { status: 'success', recordsProcessed: 50 } as any, 200);
      manager.markAsCompleted('int-1', { status: 'success', recordsProcessed: 100 } as any, 300);
      manager.markAsFailed('int-2', 'Error', 150);

      const metrics = manager.getMetrics();
      expect(metrics.totalIntegrations).toBe(2);
      expect(metrics.successfulRuns).toBe(2);
      expect(metrics.failedRuns).toBe(1);
      expect(metrics.averageRunTime).toBeGreaterThan(0);
      expect(metrics.totalRecordsProcessed).toBe(100); // Only last sync result counts
      expect(metrics.errorRate).toBeCloseTo(33.33, 0);
      expect(metrics.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should return zero metrics when empty', () => {
      const metrics = manager.getMetrics();
      expect(metrics.totalIntegrations).toBe(0);
      expect(metrics.averageRunTime).toBe(0);
      expect(metrics.errorRate).toBe(0);
    });
  });

  describe('removeStatus', () => {
    it('should remove existing status', () => {
      manager.initializeStatus('int-1');
      expect(manager.removeStatus('int-1')).toBe(true);
      expect(manager.getStatus('int-1')).toBeUndefined();
    });

    it('should return false for unknown integration', () => {
      expect(manager.removeStatus('unknown')).toBe(false);
    });

    it('should clean up running state', () => {
      manager.initializeStatus('int-1');
      manager.markAsRunning('int-1');
      manager.removeStatus('int-1');
      expect(manager.isRunning('int-1')).toBe(false);
    });
  });

  describe('clearAll', () => {
    it('should clear all statuses', () => {
      manager.initializeStatus('int-1');
      manager.initializeStatus('int-2');
      manager.markAsRunning('int-1');
      manager.clearAll();
      expect(manager.getAllStatuses()).toEqual([]);
      expect(manager.getRunningIntegrations().size).toBe(0);
    });
  });

  describe('getStaleIntegrations', () => {
    it('should return integrations that never ran', () => {
      manager.initializeStatus('int-never-ran');
      const stale = manager.getStaleIntegrations(24);
      expect(stale.length).toBe(1);
      expect(stale[0].configId).toBe('int-never-ran');
    });

    it('should return integrations with old last sync', () => {
      manager.initializeStatus('int-old');
      manager.updateStatus('int-old', {
        lastSync: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48 hours ago
      });
      const stale = manager.getStaleIntegrations(24);
      expect(stale.length).toBe(1);
    });

    it('should exclude currently running integrations', () => {
      manager.initializeStatus('int-running');
      manager.updateStatus('int-running', {
        lastSync: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      manager.markAsRunning('int-running');
      const stale = manager.getStaleIntegrations(24);
      expect(stale.length).toBe(0);
    });

    it('should exclude recent integrations', () => {
      manager.initializeStatus('int-recent');
      manager.markAsCompleted('int-recent', { status: 'success' } as any, 100);
      const stale = manager.getStaleIntegrations(24);
      expect(stale.length).toBe(0);
    });
  });

  describe('getProblematicIntegrations', () => {
    it('should return integrations with high error rates', () => {
      manager.initializeStatus('int-bad');
      manager.markAsFailed('int-bad', 'Error 1', 100);
      manager.markAsFailed('int-bad', 'Error 2', 100);
      manager.markAsCompleted('int-bad', { status: 'success' } as any, 100);

      const problematic = manager.getProblematicIntegrations(0.5);
      expect(problematic.length).toBe(1);
      expect(problematic[0].configId).toBe('int-bad');
    });

    it('should exclude integrations with no runs', () => {
      manager.initializeStatus('int-new');
      const problematic = manager.getProblematicIntegrations(0.5);
      expect(problematic.length).toBe(0);
    });

    it('should exclude integrations below threshold', () => {
      manager.initializeStatus('int-ok');
      manager.markAsFailed('int-ok', 'Error', 100);
      manager.markAsCompleted('int-ok', { status: 'success' } as any, 100);
      manager.markAsCompleted('int-ok', { status: 'success' } as any, 100);
      manager.markAsCompleted('int-ok', { status: 'success' } as any, 100);

      const problematic = manager.getProblematicIntegrations(0.5);
      expect(problematic.length).toBe(0);
    });
  });
});
