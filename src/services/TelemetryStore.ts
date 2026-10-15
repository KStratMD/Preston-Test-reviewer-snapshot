import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { AllTelemetryEvents } from '../domain/telemetry/events';

export interface TelemetryQueryOptions {
  startTime?: number;
  endTime?: number;
  eventTypes?: string[];
  flowId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'type';
  sortOrder?: 'asc' | 'desc';
}

export interface TelemetryMetrics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  successRate: number;
  averageDuration: number;
  totalRecordsProcessed: number;
  failureCount: number;
  timeRange: {
    start: number;
    end: number;
  };
}

/**
 * TelemetryStore provides persistent storage and querying capabilities
 * for telemetry events. Supports both in-memory and external storage.
 */
@injectable()
export class TelemetryStore {
  private events = new Map<string, AllTelemetryEvents>();
  private eventsByType = new Map<string, Set<string>>();
  private eventsByFlow = new Map<string, Set<string>>();
  private eventsByUser = new Map<string, Set<string>>();

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
  ) {
    this.logger.info('TelemetryStore initialized');
  }

  /**
   * Store a telemetry event
   */
  async storeEvent(event: AllTelemetryEvents): Promise<void> {
    try {
      this.events.set(event.id, event);

      // Index by type
      if (!this.eventsByType.has(event.type)) {
        this.eventsByType.set(event.type, new Set());
      }
      this.eventsByType.get(event.type)!.add(event.id);

      // Index by flow ID if present
      if (event.flowId) {
        if (!this.eventsByFlow.has(event.flowId)) {
          this.eventsByFlow.set(event.flowId, new Set());
        }
        this.eventsByFlow.get(event.flowId)!.add(event.id);
      }

      // Index by user ID if present
      if (event.userId) {
        if (!this.eventsByUser.has(event.userId)) {
          this.eventsByUser.set(event.userId, new Set());
        }
        this.eventsByUser.get(event.userId)!.add(event.id);
      }

      this.logger.debug('Telemetry event stored', {
        eventId: event.id,
        eventType: event.type,
        flowId: event.flowId,
        userId: event.userId,
      });
    } catch (error) {
      this.logger.error('Failed to store telemetry event', { error, eventId: event.id });
      throw error;
    }
  }

  /**
   * Query telemetry events with filtering and pagination
   */
  async queryEvents(options: TelemetryQueryOptions = {}): Promise<AllTelemetryEvents[]> {
    try {
      let eventIds: string[] = [];

      // Apply filters to get relevant event IDs
      if (options.eventTypes && options.eventTypes.length > 0) {
        const typeEventIds = new Set<string>();
        for (const eventType of options.eventTypes) {
          const ids = this.eventsByType.get(eventType);
          if (ids) {
            ids.forEach(id => typeEventIds.add(id));
          }
        }
        eventIds = Array.from(typeEventIds);
      } else if (options.flowId) {
        const ids = this.eventsByFlow.get(options.flowId);
        eventIds = ids ? Array.from(ids) : [];
      } else if (options.userId) {
        const ids = this.eventsByUser.get(options.userId);
        eventIds = ids ? Array.from(ids) : [];
      } else {
        eventIds = Array.from(this.events.keys());
      }

      // Get events and apply additional filters
      let events = eventIds
        .map(id => this.events.get(id)!)
        .filter(event => {
          if (options.startTime && event.timestamp < options.startTime) return false;
          if (options.endTime && event.timestamp > options.endTime) return false;
          if (options.flowId && event.flowId !== options.flowId) return false;
          if (options.userId && event.userId !== options.userId) return false;
          return true;
        });

      // Sort events
      const sortBy = options.sortBy || 'timestamp';
      const sortOrder = options.sortOrder || 'desc';
      events.sort((a, b) => {
        const aValue = sortBy === 'timestamp' ? a.timestamp : a.type;
        const bValue = sortBy === 'timestamp' ? b.timestamp : b.type;
        
        if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
        return 0;
      });

      // Apply pagination
      const offset = options.offset || 0;
      const limit = options.limit || 100;
      events = events.slice(offset, offset + limit);

      this.logger.debug('Telemetry events queried', {
        totalFound: events.length,
        options,
      });

      return events;
    } catch (error) {
      this.logger.error('Failed to query telemetry events', { error, options });
      throw error;
    }
  }

  /**
   * Get telemetry metrics for a time range
   */
  async getMetrics(options: TelemetryQueryOptions = {}): Promise<TelemetryMetrics> {
    try {
      const events = await this.queryEvents(options);
      
      const eventsByType: Record<string, number> = {};
      let totalDuration = 0;
      let durationCount = 0;
      let totalRecordsProcessed = 0;
      let failureCount = 0;

      for (const event of events) {
        // Count by type
        eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;

        // Calculate durations for flow events
        if ('durationMs' in event && typeof event.durationMs === 'number') {
          totalDuration += event.durationMs;
          durationCount++;
        }

        // Count records processed
        if ('recordCount' in event && typeof event.recordCount === 'number') {
          totalRecordsProcessed += event.recordCount;
        }
        if ('successCount' in event && typeof event.successCount === 'number') {
          totalRecordsProcessed += event.successCount;
        }

        // Count failures
        if (event.type.includes('Failed') || 
            ('outcome' in event && event.outcome === 'failure')) {
          failureCount++;
        }
      }

      const successfulFlows = events.filter(e => e.type.includes('Completed')).length;
      const totalFlows = events.filter(e => e.type.includes('Started')).length;
      const successRate = totalFlows > 0 ? (successfulFlows / totalFlows) * 100 : 100;

      const timeRange = {
        start: Math.min(...events.map(e => e.timestamp)),
        end: Math.max(...events.map(e => e.timestamp)),
      };

      return {
        totalEvents: events.length,
        eventsByType,
        successRate,
        averageDuration: durationCount > 0 ? totalDuration / durationCount : 0,
        totalRecordsProcessed,
        failureCount,
        timeRange,
      };
    } catch (error) {
      this.logger.error('Failed to calculate telemetry metrics', { error, options });
      throw error;
    }
  }

  /**
   * Get event count by type
   */
  async getEventCountByType(eventType: string): Promise<number> {
    const ids = this.eventsByType.get(eventType);
    return ids ? ids.size : 0;
  }

  /**
   * Get recent events for a specific flow
   */
  async getFlowEvents(flowId: string, limit = 50): Promise<AllTelemetryEvents[]> {
    return this.queryEvents({
      flowId,
      limit,
      sortBy: 'timestamp',
      sortOrder: 'desc',
    });
  }

  /**
   * Get events for a specific user
   */
  async getUserEvents(userId: string, limit = 100): Promise<AllTelemetryEvents[]> {
    return this.queryEvents({
      userId,
      limit,
      sortBy: 'timestamp',
      sortOrder: 'desc',
    });
  }

  /**
   * Clear old events (retention policy)
   */
  async clearOldEvents(olderThanTimestamp: number): Promise<number> {
    try {
      let deletedCount = 0;
      const eventsToDelete: string[] = [];

      for (const [id, event] of this.events) {
        if (event.timestamp < olderThanTimestamp) {
          eventsToDelete.push(id);
        }
      }

      for (const eventId of eventsToDelete) {
        const event = this.events.get(eventId);
        if (event) {
          // Remove from main storage
          this.events.delete(eventId);

          // Remove from indexes
          this.eventsByType.get(event.type)?.delete(eventId);
          if (event.flowId) {
            this.eventsByFlow.get(event.flowId)?.delete(eventId);
          }
          if (event.userId) {
            this.eventsByUser.get(event.userId)?.delete(eventId);
          }

          deletedCount++;
        }
      }

      this.logger.info('Old telemetry events cleared', {
        deletedCount,
        olderThanTimestamp,
      });

      return deletedCount;
    } catch (error) {
      this.logger.error('Failed to clear old events', { error, olderThanTimestamp });
      throw error;
    }
  }

  /**
   * Get storage statistics
   */
  getStorageStats(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    memoryUsageEstimate: number;
  } {
    const eventsByType: Record<string, number> = {};
    for (const [type, ids] of this.eventsByType) {
      eventsByType[type] = ids.size;
    }

    // Rough memory usage estimate (each event ~1KB average)
    const memoryUsageEstimate = this.events.size * 1024;

    return {
      totalEvents: this.events.size,
      eventsByType,
      memoryUsageEstimate,
    };
  }
}