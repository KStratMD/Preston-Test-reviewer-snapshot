/**
 * Comprehensive unit tests for DLQService
 * Covers: addMessage, getMessages, getMessage, retryMessage, resolveMessage,
 *         getAnalytics, bulkRetry, getQueueStatus, and private helpers
 */
import 'reflect-metadata';
import { DLQService } from '../../../src/services/DLQService';
import type { DLQMessage, DLQFilter } from '../../../src/services/DLQService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockTelemetryService = {
  recordEvent: jest.fn().mockResolvedValue(undefined),
} as any;

function buildDLQMessage(overrides: Partial<Omit<DLQMessage, 'id' | 'firstFailureTime'>> = {}): Omit<DLQMessage, 'id' | 'firstFailureTime'> {
  return {
    flowId: 'flow-1',
    messageId: 'msg-1',
    originalPayload: { data: 'test' },
    errorCode: 'VALIDATION_ERROR',
    errorMessage: 'Field validation failed',
    retryCount: 0,
    maxRetries: 3,
    lastAttemptTime: Date.now(),
    severity: 'medium',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    recordType: 'Customer',
    processingStage: 'validation',
    businessImpact: {
      affectedRecords: 1,
      urgency: 'medium',
    },
    status: 'pending',
    tags: ['validation'],
    ...overrides,
  };
}

describe('DLQService', () => {
  let service: DLQService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-02-18T12:00:00Z') });
    service = new DLQService(mockLogger, mockTelemetryService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize and log', () => {
      expect(service).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('DLQService initialized');
    });
  });

  describe('addMessage', () => {
    it('should add a message and return an id', async () => {
      const id = await service.addMessage(buildDLQMessage());
      expect(id).toMatch(/^dlq_/);
    });

    it('should store the message retrievable by id', async () => {
      const id = await service.addMessage(buildDLQMessage());
      const msg = await service.getMessage(id);
      expect(msg).not.toBeNull();
      expect(msg!.flowId).toBe('flow-1');
      expect(msg!.errorCode).toBe('VALIDATION_ERROR');
    });

    it('should set firstFailureTime', async () => {
      const id = await service.addMessage(buildDLQMessage());
      const msg = await service.getMessage(id);
      expect(msg!.firstFailureTime).toBeGreaterThan(0);
    });

    it('should record telemetry event', async () => {
      await service.addMessage(buildDLQMessage());
      expect(mockTelemetryService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'DLQMessageCreated' })
      );
    });

    it('should log warning with message details', async () => {
      await service.addMessage(buildDLQMessage());
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Message added to DLQ',
        expect.objectContaining({ flowId: 'flow-1' })
      );
    });

    it('should handle telemetry error gracefully', async () => {
      mockTelemetryService.recordEvent.mockRejectedValueOnce(new Error('telemetry down'));
      await expect(service.addMessage(buildDLQMessage())).rejects.toThrow('telemetry down');
    });
  });

  describe('getMessage', () => {
    it('should return null for non-existent id', async () => {
      const msg = await service.getMessage('nonexistent');
      expect(msg).toBeNull();
    });

    it('should return the stored message', async () => {
      const id = await service.addMessage(buildDLQMessage({ errorCode: 'AUTH_FAILED' }));
      const msg = await service.getMessage(id);
      expect(msg!.errorCode).toBe('AUTH_FAILED');
    });
  });

  describe('getMessages', () => {
    beforeEach(async () => {
      await service.addMessage(buildDLQMessage({ severity: 'critical', sourceSystem: 'SAP', errorCode: 'AUTH_FAILED', tags: ['auth'] }));
      await service.addMessage(buildDLQMessage({ severity: 'high', sourceSystem: 'Salesforce', errorCode: 'NETWORK_TIMEOUT', tags: ['network'] }));
      await service.addMessage(buildDLQMessage({ severity: 'low', sourceSystem: 'SAP', errorCode: 'VALIDATION_ERROR', tags: ['validation'] }));
    });

    it('should return all messages with no filter', async () => {
      const result = await service.getMessages();
      expect(result.totalCount).toBe(3);
      expect(result.messages).toHaveLength(3);
    });

    it('should filter by severity', async () => {
      const result = await service.getMessages({ severity: ['critical'] });
      expect(result.totalCount).toBe(1);
      expect(result.messages[0].severity).toBe('critical');
    });

    it('should filter by sourceSystem', async () => {
      const result = await service.getMessages({ sourceSystem: ['SAP'] });
      expect(result.totalCount).toBe(2);
    });

    it('should filter by errorCode', async () => {
      const result = await service.getMessages({ errorCode: ['AUTH_FAILED'] });
      expect(result.totalCount).toBe(1);
    });

    it('should filter by tags', async () => {
      const result = await service.getMessages({ tags: ['auth'] });
      expect(result.totalCount).toBe(1);
    });

    it('should sort by severity (critical first)', async () => {
      const result = await service.getMessages();
      expect(result.messages[0].severity).toBe('critical');
      expect(result.messages[1].severity).toBe('high');
      expect(result.messages[2].severity).toBe('low');
    });

    it('should paginate with limit and offset', async () => {
      const result = await service.getMessages({}, 2, 0);
      expect(result.messages).toHaveLength(2);
      expect(result.totalCount).toBe(3);

      const page2 = await service.getMessages({}, 2, 2);
      expect(page2.messages).toHaveLength(1);
    });

    it('should filter by status', async () => {
      const result = await service.getMessages({ status: ['pending'] });
      expect(result.totalCount).toBe(3);
    });

    it('should filter by businessImpact urgency', async () => {
      const result = await service.getMessages({ businessImpact: ['medium'] });
      expect(result.totalCount).toBe(3);
    });
  });

  describe('retryMessage', () => {
    it('should increment retry count', async () => {
      const id = await service.addMessage(buildDLQMessage({ retryCount: 0, maxRetries: 3 }));
      const result = await service.retryMessage(id);
      expect(result.success).toBe(true);
      const msg = await service.getMessage(id);
      expect(msg!.retryCount).toBe(1);
      expect(msg!.status).toBe('retrying');
    });

    it('should set nextRetryTime with backoff', async () => {
      const id = await service.addMessage(buildDLQMessage({ retryCount: 0, maxRetries: 3 }));
      const result = await service.retryMessage(id);
      expect(result.newRetryTime).toBeGreaterThan(Date.now());
    });

    it('should throw for non-existent message', async () => {
      await expect(service.retryMessage('nonexistent')).rejects.toThrow('DLQ message not found');
    });

    it('should throw for resolved message', async () => {
      const id = await service.addMessage(buildDLQMessage());
      await service.resolveMessage(id, { resolvedBy: 'admin', resolution: 'Fixed', actionsTaken: ['fixed'] });
      await expect(service.retryMessage(id)).rejects.toThrow('Cannot retry message with status: resolved');
    });

    it('should throw when max retries exceeded', async () => {
      const id = await service.addMessage(buildDLQMessage({ retryCount: 3, maxRetries: 3 }));
      await expect(service.retryMessage(id)).rejects.toThrow('exceeded maximum retry attempts');
    });

    it('should record telemetry event', async () => {
      const id = await service.addMessage(buildDLQMessage());
      mockTelemetryService.recordEvent.mockClear();
      await service.retryMessage(id);
      expect(mockTelemetryService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RetryScheduled' })
      );
    });
  });

  describe('resolveMessage', () => {
    it('should set status to resolved', async () => {
      const id = await service.addMessage(buildDLQMessage());
      await service.resolveMessage(id, { resolvedBy: 'admin', resolution: 'Manual fix', actionsTaken: ['Fixed data'] });
      const msg = await service.getMessage(id);
      expect(msg!.status).toBe('resolved');
      expect(msg!.resolution!.resolvedBy).toBe('admin');
      expect(msg!.resolution!.resolvedAt).toBeGreaterThan(0);
    });

    it('should throw for non-existent message', async () => {
      await expect(service.resolveMessage('nonexistent', {
        resolvedBy: 'admin', resolution: 'test', actionsTaken: [],
      })).rejects.toThrow('DLQ message not found');
    });

    it('should record telemetry event', async () => {
      const id = await service.addMessage(buildDLQMessage());
      mockTelemetryService.recordEvent.mockClear();
      await service.resolveMessage(id, { resolvedBy: 'admin', resolution: 'Fixed', actionsTaken: ['fixed'] });
      expect(mockTelemetryService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'DLQMessageReplayed' })
      );
    });

    it('should log resolution details', async () => {
      const id = await service.addMessage(buildDLQMessage());
      await service.resolveMessage(id, { resolvedBy: 'admin', resolution: 'Fixed', actionsTaken: ['fixed'] });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'DLQ message resolved',
        expect.objectContaining({ resolvedBy: 'admin' })
      );
    });
  });

  describe('getAnalytics', () => {
    it('should return analytics with empty queue', async () => {
      const analytics = await service.getAnalytics();
      expect(analytics.summary.totalMessages).toBe(0);
      expect(analytics.errorPatterns).toEqual([]);
      expect(analytics.systemBreakdown).toEqual([]);
    });

    it('should compute summary statistics', async () => {
      await service.addMessage(buildDLQMessage({ severity: 'critical' }));
      await service.addMessage(buildDLQMessage({ severity: 'high', errorCode: 'AUTH_FAILED' }));
      const id3 = await service.addMessage(buildDLQMessage({ severity: 'low' }));
      await service.resolveMessage(id3, { resolvedBy: 'admin', resolution: 'fixed', actionsTaken: [] });

      const analytics = await service.getAnalytics();
      expect(analytics.summary.totalMessages).toBe(3);
      expect(analytics.summary.criticalMessages).toBe(1);
      expect(analytics.summary.resolvedMessages).toBe(1);
    });

    it('should compute error patterns', async () => {
      await service.addMessage(buildDLQMessage({ errorCode: 'AUTH_FAILED' }));
      await service.addMessage(buildDLQMessage({ errorCode: 'AUTH_FAILED' }));
      await service.addMessage(buildDLQMessage({ errorCode: 'NETWORK_TIMEOUT' }));

      const analytics = await service.getAnalytics();
      expect(analytics.errorPatterns.length).toBe(2);
      expect(analytics.errorPatterns[0].errorCode).toBe('AUTH_FAILED');
      expect(analytics.errorPatterns[0].count).toBe(2);
    });

    it('should categorize error types', async () => {
      await service.addMessage(buildDLQMessage({ errorCode: 'AUTH_FAILED' }));
      await service.addMessage(buildDLQMessage({ errorCode: 'NETWORK_TIMEOUT' }));
      await service.addMessage(buildDLQMessage({ errorCode: 'RATE_LIMIT_EXCEEDED' }));
      await service.addMessage(buildDLQMessage({ errorCode: 'SERVER_ERROR' }));
      await service.addMessage(buildDLQMessage({ errorCode: 'VALIDATION_ERROR' }));
      await service.addMessage(buildDLQMessage({ errorCode: 'CUSTOM_BIZ_ERROR' }));

      const analytics = await service.getAnalytics();
      const types = analytics.errorPatterns.map(p => p.errorType);
      expect(types).toContain('Authentication');
      expect(types).toContain('Network');
      expect(types).toContain('Rate Limiting');
      expect(types).toContain('Server Error');
      expect(types).toContain('Validation');
      expect(types).toContain('Business Logic');
    });

    it('should compute system breakdown', async () => {
      await service.addMessage(buildDLQMessage({ sourceSystem: 'SAP', targetSystem: 'NetSuite' }));
      await service.addMessage(buildDLQMessage({ sourceSystem: 'SAP', targetSystem: 'NetSuite', severity: 'critical' }));
      await service.addMessage(buildDLQMessage({ sourceSystem: 'Salesforce', targetSystem: 'HubSpot' }));

      const analytics = await service.getAnalytics();
      expect(analytics.systemBreakdown.length).toBe(2);
      const sapNs = analytics.systemBreakdown.find(s => s.system === 'SAP-NetSuite');
      expect(sapNs!.totalErrors).toBe(2);
      expect(sapNs!.criticalErrors).toBe(1);
    });

    it('should compute time analysis', async () => {
      await service.addMessage(buildDLQMessage());
      await service.addMessage(buildDLQMessage());
      const analytics = await service.getAnalytics();
      expect(analytics.timeAnalysis).toBeDefined();
      expect(Array.isArray(analytics.timeAnalysis.peakErrorHours)).toBe(true);
      expect(Array.isArray(analytics.timeAnalysis.errorsByDay)).toBe(true);
      expect(typeof analytics.timeAnalysis.mttr).toBe('number');
      expect(typeof analytics.timeAnalysis.mtbf).toBe('number');
    });

    it('should get suggested actions for known error codes', async () => {
      await service.addMessage(buildDLQMessage({ errorCode: 'AUTH_FAILED' }));
      const analytics = await service.getAnalytics();
      expect(analytics.errorPatterns[0].suggestedAction).toContain('credentials');
    });
  });

  describe('bulkRetry', () => {
    it('should retry multiple messages', async () => {
      const id1 = await service.addMessage(buildDLQMessage({ maxRetries: 3 }));
      const id2 = await service.addMessage(buildDLQMessage({ maxRetries: 3 }));
      const result = await service.bulkRetry([id1, id2]);
      expect(result.succeeded).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
    });

    it('should handle mixed success/failure', async () => {
      const id1 = await service.addMessage(buildDLQMessage({ maxRetries: 3 }));
      const result = await service.bulkRetry([id1, 'nonexistent']);
      expect(result.succeeded).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toContain('not found');
    });

    it('should handle empty array', async () => {
      const result = await service.bulkRetry([]);
      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe('getQueueStatus', () => {
    it('should return healthy when queue is empty', async () => {
      const status = await service.getQueueStatus();
      expect(status.status).toBe('healthy');
      expect(status.message).toContain('No messages');
    });

    it('should return critical when critical messages exist', async () => {
      await service.addMessage(buildDLQMessage({ severity: 'critical' }));
      const status = await service.getQueueStatus();
      expect(status.status).toBe('critical');
      expect(status.metrics!.criticalMessages).toBe(1);
    });

    it('should return degraded when many high-priority messages', async () => {
      for (let i = 0; i < 6; i++) {
        await service.addMessage(buildDLQMessage({ severity: 'high' }));
      }
      const status = await service.getQueueStatus();
      expect(status.status).toBe('degraded');
    });
  });
});
