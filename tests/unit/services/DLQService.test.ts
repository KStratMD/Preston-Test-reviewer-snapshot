import { describe, it, expect, beforeEach } from '@jest/globals';
import { DLQService } from './DLQService';
import type { Logger } from '../utils/Logger';
import type { TelemetryService } from './TelemetryService';
import type { DLQMessage } from './DLQService';

describe('DLQService', () => {
  let dlqService: DLQService;
  let mockLogger: Logger;
  let mockTelemetryService: TelemetryService;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;

    mockTelemetryService = {
      trackEvent: jest.fn(),
      trackError: jest.fn(),
      trackMetric: jest.fn(),
      flush: jest.fn(),
      recordEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as TelemetryService;

    dlqService = new DLQService(mockLogger, mockTelemetryService);
  });

  describe('addMessage', () => {
    it('should add a message to the DLQ', async () => {
      const message = {
        flowId: 'test-flow',
        messageId: 'test-message-1',
        originalPayload: { test: 'data' },
        errorCode: 'TEST_ERROR',
        errorMessage: 'Test error message',
        retryCount: 3,
        maxRetries: 5,
        lastAttemptTime: Date.now(),
        severity: 'high' as const,
        sourceSystem: 'TestSystem',
        targetSystem: 'TargetSystem',
        recordType: 'Customer',
        processingStage: 'transformation' as const,
        businessImpact: {
          affectedRecords: 1,
          urgency: 'medium' as const,
        },
        status: 'pending' as const,
        tags: ['test'],
      };

      const id = await dlqService.addMessage(message);
      
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^dlq_\d+_[a-z0-9]+$/);
      
      // Verify the message was stored
      const retrieved = await dlqService.getMessage(id);
      expect(retrieved).toBeDefined();
    });
  });

  describe('getMessage', () => {
    it('should retrieve a message by ID', async () => {
      const message = {
        flowId: 'test-flow',
        messageId: 'test-message-1',
        originalPayload: { test: 'data' },
        errorCode: 'TEST_ERROR',
        errorMessage: 'Test error message',
        retryCount: 2,
        maxRetries: 5,
        lastAttemptTime: Date.now(),
        severity: 'medium' as const,
        sourceSystem: 'TestSystem',
        targetSystem: 'TargetSystem',
        recordType: 'Customer',
        processingStage: 'transformation' as const,
        businessImpact: {
          affectedRecords: 1,
          urgency: 'medium' as const,
        },
        status: 'pending' as const,
        tags: ['test'],
      };

      const id = await dlqService.addMessage(message);
      const retrieved = await dlqService.getMessage(id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(id);
      expect(retrieved?.flowId).toBe(message.flowId);
      expect(retrieved?.messageId).toBe(message.messageId);
    });

    it('should return null for non-existent message', async () => {
      const retrieved = await dlqService.getMessage('non-existent-id');
      expect(retrieved).toBeNull();
    });
  });
});