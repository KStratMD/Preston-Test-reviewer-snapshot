/**
 * Comprehensive unit tests for TelemetryStore
 * Covers: storeEvent, queryEvents, getMetrics, getEventCountByType,
 *         getFlowEvents, getUserEvents, clearOldEvents, getStorageStats
 */
import 'reflect-metadata';
import { TelemetryStore } from '../../../src/services/TelemetryStore';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeEvent(overrides: Record<string, any> = {}): any {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    type: 'SyncFlowStarted',
    timestamp: Date.now(),
    flowId: 'flow-1',
    userId: 'user-1',
    ...overrides,
  };
}

describe('TelemetryStore', () => {
  let store: TelemetryStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new TelemetryStore(mockLogger);
  });

  describe('constructor', () => {
    it('should initialize and log', () => {
      expect(store).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('TelemetryStore initialized');
    });
  });

  describe('storeEvent', () => {
    it('should store an event', async () => {
      const event = makeEvent({ id: 'e1' });
      await store.storeEvent(event);
      const events = await store.queryEvents({});
      expect(events.length).toBe(1);
      expect(events[0].id).toBe('e1');
    });

    it('should index by type', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'SyncFlowStarted' }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'SyncFlowCompleted' }));
      const count = await store.getEventCountByType('SyncFlowStarted');
      expect(count).toBe(1);
    });

    it('should index by flow ID', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', flowId: 'flow-A' }));
      await store.storeEvent(makeEvent({ id: 'e2', flowId: 'flow-B' }));
      const events = await store.getFlowEvents('flow-A');
      expect(events.length).toBe(1);
      expect(events[0].id).toBe('e1');
    });

    it('should index by user ID', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', userId: 'user-X' }));
      await store.storeEvent(makeEvent({ id: 'e2', userId: 'user-Y' }));
      const events = await store.getUserEvents('user-X');
      expect(events.length).toBe(1);
    });

    it('should handle event without flowId', async () => {
      const event = makeEvent({ id: 'no-flow', flowId: undefined });
      await store.storeEvent(event);
      const events = await store.queryEvents({});
      expect(events.length).toBe(1);
    });

    it('should handle event without userId', async () => {
      const event = makeEvent({ id: 'no-user', userId: undefined });
      await store.storeEvent(event);
      const events = await store.queryEvents({});
      expect(events.length).toBe(1);
    });
  });

  describe('queryEvents', () => {
    beforeEach(async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'SyncFlowStarted', flowId: 'f1', userId: 'u1', timestamp: 1000 }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'SyncFlowCompleted', flowId: 'f1', userId: 'u2', timestamp: 2000 }));
      await store.storeEvent(makeEvent({ id: 'e3', type: 'SyncFlowFailed', flowId: 'f2', userId: 'u1', timestamp: 3000 }));
    });

    it('should return all events when no filters', async () => {
      const events = await store.queryEvents({});
      expect(events.length).toBe(3);
    });

    it('should filter by eventTypes', async () => {
      const events = await store.queryEvents({ eventTypes: ['SyncFlowStarted'] });
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('SyncFlowStarted');
    });

    it('should filter by multiple eventTypes', async () => {
      const events = await store.queryEvents({ eventTypes: ['SyncFlowStarted', 'SyncFlowFailed'] });
      expect(events.length).toBe(2);
    });

    it('should filter by flowId', async () => {
      const events = await store.queryEvents({ flowId: 'f1' });
      expect(events.length).toBe(2);
    });

    it('should filter by userId', async () => {
      const events = await store.queryEvents({ userId: 'u1' });
      expect(events.length).toBe(2);
    });

    it('should filter by startTime', async () => {
      const events = await store.queryEvents({ startTime: 2000 });
      expect(events.length).toBe(2);
    });

    it('should filter by endTime', async () => {
      const events = await store.queryEvents({ endTime: 2000 });
      expect(events.length).toBe(2);
    });

    it('should filter by time range', async () => {
      const events = await store.queryEvents({ startTime: 1500, endTime: 2500 });
      expect(events.length).toBe(1);
      expect(events[0].id).toBe('e2');
    });

    it('should sort by timestamp desc by default', async () => {
      const events = await store.queryEvents({});
      expect(events[0].timestamp).toBeGreaterThanOrEqual(events[1].timestamp);
    });

    it('should sort by timestamp asc', async () => {
      const events = await store.queryEvents({ sortBy: 'timestamp', sortOrder: 'asc' });
      expect(events[0].timestamp).toBeLessThanOrEqual(events[1].timestamp);
    });

    it('should sort by type', async () => {
      const events = await store.queryEvents({ sortBy: 'type', sortOrder: 'asc' });
      expect(events.length).toBe(3);
    });

    it('should apply limit', async () => {
      const events = await store.queryEvents({ limit: 1 });
      expect(events.length).toBe(1);
    });

    it('should apply offset', async () => {
      const events = await store.queryEvents({ offset: 1, sortBy: 'timestamp', sortOrder: 'asc' });
      expect(events.length).toBe(2);
    });

    it('should apply offset and limit', async () => {
      const events = await store.queryEvents({ offset: 1, limit: 1, sortBy: 'timestamp', sortOrder: 'asc' });
      expect(events.length).toBe(1);
    });

    it('should return empty for unknown eventType', async () => {
      const events = await store.queryEvents({ eventTypes: ['NonExistent'] });
      expect(events.length).toBe(0);
    });

    it('should return empty for unknown flowId', async () => {
      const events = await store.queryEvents({ flowId: 'nonexistent' });
      expect(events.length).toBe(0);
    });

    it('should return empty for unknown userId', async () => {
      const events = await store.queryEvents({ userId: 'nonexistent' });
      expect(events.length).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('should return metrics for stored events', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'SyncFlowStarted', timestamp: 1000 }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'SyncFlowCompleted', timestamp: 2000, durationMs: 1000 }));
      await store.storeEvent(makeEvent({ id: 'e3', type: 'SyncFlowFailed', timestamp: 3000 }));

      const metrics = await store.getMetrics({});
      expect(metrics.totalEvents).toBe(3);
      expect(metrics.eventsByType['SyncFlowStarted']).toBe(1);
      expect(metrics.eventsByType['SyncFlowCompleted']).toBe(1);
      expect(metrics.eventsByType['SyncFlowFailed']).toBe(1);
      expect(metrics.failureCount).toBe(1);
    });

    it('should calculate average duration', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'X', timestamp: 1000, durationMs: 100 }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'X', timestamp: 2000, durationMs: 200 }));

      const metrics = await store.getMetrics({});
      expect(metrics.averageDuration).toBe(150);
    });

    it('should count records processed', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'X', timestamp: 1000, recordCount: 50 }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'X', timestamp: 2000, successCount: 30 }));

      const metrics = await store.getMetrics({});
      expect(metrics.totalRecordsProcessed).toBe(80);
    });

    it('should calculate success rate', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'SyncFlowStarted', timestamp: 1000 }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'SyncFlowCompleted', timestamp: 2000 }));

      const metrics = await store.getMetrics({});
      expect(metrics.successRate).toBe(100);
    });

    it('should return 0 average duration when no durations', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'X', timestamp: 1000 }));
      const metrics = await store.getMetrics({});
      expect(metrics.averageDuration).toBe(0);
    });

    it('should detect failure by outcome field', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'X', timestamp: 1000, outcome: 'failure' }));
      const metrics = await store.getMetrics({});
      expect(metrics.failureCount).toBe(1);
    });

    it('should return time range', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'X', timestamp: 1000 }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'X', timestamp: 3000 }));
      const metrics = await store.getMetrics({});
      expect(metrics.timeRange.start).toBe(1000);
      expect(metrics.timeRange.end).toBe(3000);
    });
  });

  describe('getEventCountByType', () => {
    it('should return 0 for unknown type', async () => {
      const count = await store.getEventCountByType('NonExistent');
      expect(count).toBe(0);
    });

    it('should count events by type', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'TypeA' }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'TypeA' }));
      await store.storeEvent(makeEvent({ id: 'e3', type: 'TypeB' }));
      expect(await store.getEventCountByType('TypeA')).toBe(2);
      expect(await store.getEventCountByType('TypeB')).toBe(1);
    });
  });

  describe('getFlowEvents', () => {
    it('should return events for a flow', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', flowId: 'flow-1', timestamp: 1000 }));
      await store.storeEvent(makeEvent({ id: 'e2', flowId: 'flow-1', timestamp: 2000 }));
      await store.storeEvent(makeEvent({ id: 'e3', flowId: 'flow-2', timestamp: 3000 }));

      const events = await store.getFlowEvents('flow-1');
      expect(events.length).toBe(2);
    });

    it('should return empty for unknown flow', async () => {
      const events = await store.getFlowEvents('nonexistent');
      expect(events.length).toBe(0);
    });
  });

  describe('getUserEvents', () => {
    it('should return events for a user', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', userId: 'user-1', timestamp: 1000 }));
      await store.storeEvent(makeEvent({ id: 'e2', userId: 'user-1', timestamp: 2000 }));

      const events = await store.getUserEvents('user-1');
      expect(events.length).toBe(2);
    });

    it('should return empty for unknown user', async () => {
      const events = await store.getUserEvents('nonexistent');
      expect(events.length).toBe(0);
    });
  });

  describe('clearOldEvents', () => {
    it('should clear events older than timestamp', async () => {
      await store.storeEvent(makeEvent({ id: 'old', type: 'X', flowId: 'f1', userId: 'u1', timestamp: 1000 }));
      await store.storeEvent(makeEvent({ id: 'new', type: 'X', flowId: 'f1', userId: 'u1', timestamp: 3000 }));

      const deleted = await store.clearOldEvents(2000);
      expect(deleted).toBe(1);

      const remaining = await store.queryEvents({});
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe('new');
    });

    it('should return 0 when nothing to clear', async () => {
      await store.storeEvent(makeEvent({ id: 'recent', timestamp: Date.now() }));
      const deleted = await store.clearOldEvents(1000);
      expect(deleted).toBe(0);
    });

    it('should clean up indexes on deletion', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'TypeA', flowId: 'f1', userId: 'u1', timestamp: 1000 }));
      await store.clearOldEvents(2000);

      // Verify indexes are cleaned by checking counts
      expect(await store.getEventCountByType('TypeA')).toBe(0);
      const flowEvents = await store.getFlowEvents('f1');
      expect(flowEvents.length).toBe(0);
      const userEvents = await store.getUserEvents('u1');
      expect(userEvents.length).toBe(0);
    });

    it('should handle events without flowId or userId during cleanup', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'X', flowId: undefined, userId: undefined, timestamp: 500 }));
      const deleted = await store.clearOldEvents(1000);
      expect(deleted).toBe(1);
    });
  });

  describe('getStorageStats', () => {
    it('should return empty stats initially', () => {
      const stats = store.getStorageStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.memoryUsageEstimate).toBe(0);
      expect(Object.keys(stats.eventsByType).length).toBe(0);
    });

    it('should return stats after storing events', async () => {
      await store.storeEvent(makeEvent({ id: 'e1', type: 'TypeA' }));
      await store.storeEvent(makeEvent({ id: 'e2', type: 'TypeA' }));
      await store.storeEvent(makeEvent({ id: 'e3', type: 'TypeB' }));

      const stats = store.getStorageStats();
      expect(stats.totalEvents).toBe(3);
      expect(stats.eventsByType['TypeA']).toBe(2);
      expect(stats.eventsByType['TypeB']).toBe(1);
      expect(stats.memoryUsageEstimate).toBe(3 * 1024);
    });
  });
});
