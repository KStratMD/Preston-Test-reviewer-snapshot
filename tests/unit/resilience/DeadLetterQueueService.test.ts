/**
 * DeadLetterQueueService Unit Tests
 * Tests for dead letter queue handling
 */

import 'reflect-metadata';
import { DeadLetterQueueService, DeadLetterRecord } from '../../../src/resilience/DeadLetterQueueService';
import { Logger } from '../../../src/utils/Logger';
import { DatabaseService } from '../../../src/database/DatabaseService';

// Mock ioredis
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    disconnect: jest.fn(),
  }));
});

// Mock bullmq
const mockQueueAdd = jest.fn().mockResolvedValue({ id: 'job-123' });
const mockQueueClose = jest.fn().mockResolvedValue(undefined);

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: mockQueueClose,
  })),
}));

describe('DeadLetterQueueService', () => {
  let deadLetterQueueService: DeadLetterQueueService;
  let mockLogger: jest.Mocked<Logger>;
  let mockDatabaseService: jest.Mocked<DatabaseService>;
  let mockDb: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    // Create mock database query builder
    mockDb = {
      selectFrom: jest.fn().mockReturnThis(),
      selectAll: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([]),
      executeTakeFirst: jest.fn().mockResolvedValue(null),
      insertInto: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      updateTable: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      deleteFrom: jest.fn().mockReturnThis(),
    };

    mockDatabaseService = {
      getDatabase: jest.fn().mockReturnValue(mockDb),
    } as any;

    deadLetterQueueService = new DeadLetterQueueService(mockLogger, mockDatabaseService);
  });

  describe('initialize()', () => {
    it('should initialize the dead letter queue service', async () => {
      await deadLetterQueueService.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith('Dead letter queue service initialized');
    });

    it('should create Redis connection and Queue', async () => {
      const Redis = require('ioredis');
      const { Queue } = require('bullmq');

      await deadLetterQueueService.initialize();

      expect(Redis).toHaveBeenCalledWith(expect.objectContaining({
        host: 'localhost',
        port: 6379,
      }));
      expect(Queue).toHaveBeenCalledWith('dead-letter-queue', expect.any(Object));
    });
  });

  describe('sendToDeadLetter()', () => {
    const mockJob = {
      id: 'job-123',
      data: { key: 'value' },
      attemptsMade: 3,
    };

    beforeEach(async () => {
      await deadLetterQueueService.initialize();
    });

    it('should send failed job to dead letter queue', async () => {
      const error = new Error('Job failed');

      await deadLetterQueueService.sendToDeadLetter(
        'original-queue',
        mockJob as any,
        error,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'dead-letter-record',
        expect.objectContaining({
          originalQueue: 'original-queue',
          jobId: 'job-123',
          jobData: { key: 'value' },
          error: 'Job failed',
          failureCount: 3,
        }),
        expect.any(Object)
      );
    });

    it('should store dead letter record in database', async () => {
      const error = new Error('Job failed');

      await deadLetterQueueService.sendToDeadLetter(
        'original-queue',
        mockJob as any,
        error,
      );

      expect(mockDb.insertInto).toHaveBeenCalledWith('dead_letter_records');
      expect(mockDb.execute).toHaveBeenCalled();
    });

    it('should log warning when job is sent to DLQ', async () => {
      const error = new Error('Job failed');

      await deadLetterQueueService.sendToDeadLetter(
        'original-queue',
        mockJob as any,
        error,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Job sent to dead letter queue',
        expect.objectContaining({
          originalQueue: 'original-queue',
          jobId: 'job-123',
          error: 'Job failed',
        })
      );
    });

    it('should include metadata when provided', async () => {
      const error = new Error('Job failed');
      const metadata = { retryReason: 'timeout' };

      await deadLetterQueueService.sendToDeadLetter(
        'original-queue',
        mockJob as any,
        error,
        metadata,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'dead-letter-record',
        expect.objectContaining({
          metadata,
        }),
        expect.any(Object)
      );
    });

    it('should throw error when service not initialized', async () => {
      const uninitializedService = new DeadLetterQueueService(mockLogger, mockDatabaseService);
      const error = new Error('Job failed');

      await expect(
        uninitializedService.sendToDeadLetter('queue', mockJob as any, error)
      ).rejects.toThrow('Dead letter queue service not initialized');
    });

    it('should handle attemptsMade being undefined', async () => {
      const jobWithoutAttempts = {
        id: 'job-456',
        data: { key: 'value' },
      };
      const error = new Error('Job failed');

      await deadLetterQueueService.sendToDeadLetter(
        'original-queue',
        jobWithoutAttempts as any,
        error,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'dead-letter-record',
        expect.objectContaining({
          failureCount: 0,
        }),
        expect.any(Object)
      );
    });

    it('should handle queue add failure', async () => {
      mockQueueAdd.mockRejectedValueOnce(new Error('Queue error'));
      const error = new Error('Job failed');

      await expect(
        deadLetterQueueService.sendToDeadLetter('original-queue', mockJob as any, error)
      ).rejects.toThrow('Queue error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send job to dead letter queue',
        expect.any(Object)
      );
    });
  });

  describe('getDeadLetters()', () => {
    const mockRecords = [
      {
        id: 'dlq-1',
        original_queue: 'queue-1',
        job_id: 'job-1',
        job_data: { key: 'value1' },
        error: 'Error 1',
        failure_count: 3,
        last_attempt_at: new Date(),
        created_at: new Date(),
        metadata: { retryReason: 'timeout' },
      },
    ];

    it('should return dead letter records', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 1 });
      mockDb.execute.mockResolvedValueOnce(mockRecords);

      const result = await deadLetterQueueService.getDeadLetters();

      expect(result.total).toBe(1);
      expect(result.records.length).toBe(1);
      expect(result.records[0].id).toBe('dlq-1');
    });

    it('should filter by queue', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 1 });
      mockDb.execute.mockResolvedValueOnce(mockRecords);

      await deadLetterQueueService.getDeadLetters({ queue: 'queue-1' });

      expect(mockDb.where).toHaveBeenCalledWith('dlr.original_queue', '=', 'queue-1');
    });

    it('should filter by since date', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 1 });
      mockDb.execute.mockResolvedValueOnce(mockRecords);
      const since = new Date('2024-01-01');

      await deadLetterQueueService.getDeadLetters({ since });

      expect(mockDb.where).toHaveBeenCalledWith('dlr.created_at', '>=', since);
    });

    it('should filter by error type', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 1 });
      mockDb.execute.mockResolvedValueOnce(mockRecords);

      await deadLetterQueueService.getDeadLetters({ errorType: 'timeout' });

      expect(mockDb.where).toHaveBeenCalledWith('dlr.error', 'ilike', '%timeout%');
    });

    it('should apply pagination', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 10 });
      mockDb.execute.mockResolvedValueOnce(mockRecords);

      await deadLetterQueueService.getDeadLetters({ limit: 5, offset: 10 });

      expect(mockDb.limit).toHaveBeenCalledWith(5);
      expect(mockDb.offset).toHaveBeenCalledWith(10);
    });

    it('should handle database error', async () => {
      mockDb.executeTakeFirst.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        deadLetterQueueService.getDeadLetters()
      ).rejects.toThrow('DB error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get dead letter records',
        expect.any(Object)
      );
    });
  });

  describe('retryDeadLetter()', () => {
    beforeEach(async () => {
      await deadLetterQueueService.initialize();
    });

    it('should retry a dead letter record', async () => {
      const mockRecord = {
        id: 'dlq-1',
        original_queue: 'queue-1',
        job_id: 'job-1',
        job_data: { key: 'value' },
        error: 'Error 1',
      };
      mockDb.executeTakeFirst.mockResolvedValueOnce(mockRecord);
      mockDb.execute.mockResolvedValueOnce([]);

      await deadLetterQueueService.retryDeadLetter('dlq-1');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Dead letter record retried',
        expect.objectContaining({
          deadLetterId: 'dlq-1',
          originalQueue: 'queue-1',
        })
      );
    });

    it('should retry to a different queue if specified', async () => {
      const mockRecord = {
        id: 'dlq-1',
        original_queue: 'queue-1',
        job_id: 'job-1',
        job_data: { key: 'value' },
      };
      mockDb.executeTakeFirst.mockResolvedValueOnce(mockRecord);
      mockDb.execute.mockResolvedValueOnce([]);

      await deadLetterQueueService.retryDeadLetter('dlq-1', 'new-queue');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Dead letter record retried',
        expect.objectContaining({
          targetQueue: 'new-queue',
        })
      );
    });

    it('should throw error when record not found', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      await expect(
        deadLetterQueueService.retryDeadLetter('non-existent')
      ).rejects.toThrow('Dead letter record not found: non-existent');
    });

    it('should update database with retry info', async () => {
      const mockRecord = {
        id: 'dlq-1',
        original_queue: 'queue-1',
        job_id: 'job-1',
        job_data: { key: 'value' },
      };
      mockDb.executeTakeFirst.mockResolvedValueOnce(mockRecord);
      mockDb.execute.mockResolvedValueOnce([]);

      await deadLetterQueueService.retryDeadLetter('dlq-1');

      expect(mockDb.updateTable).toHaveBeenCalledWith('dead_letter_records');
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({
        retried_at: expect.any(Date),
        retry_queue: 'queue-1',
      }));
    });
  });

  describe('bulkRetryDeadLetters()', () => {
    beforeEach(async () => {
      await deadLetterQueueService.initialize();
    });

    it('should retry multiple dead letters', async () => {
      const mockRecords = [
        { id: 'dlq-1', original_queue: 'queue-1', job_id: 'job-1', job_data: {} },
        { id: 'dlq-2', original_queue: 'queue-1', job_id: 'job-2', job_data: {} },
      ];
      mockDb.executeTakeFirst.mockResolvedValue({ total: 2 });
      mockDb.execute.mockResolvedValueOnce(mockRecords);
      // For individual retries
      mockDb.execute.mockResolvedValue([]);

      const retriedCount = await deadLetterQueueService.bulkRetryDeadLetters({
        queue: 'queue-1',
      });

      expect(retriedCount).toBe(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Bulk retry completed',
        expect.objectContaining({
          totalRecords: 2,
          retriedCount: 2,
        })
      );
    });

    it('should continue when individual retry fails', async () => {
      const mockRecords = [
        { id: 'dlq-1', original_queue: 'queue-1', job_id: 'job-1', job_data: {}, error: 'err', failure_count: 1, last_attempt_at: new Date(), created_at: new Date() },
        { id: 'dlq-2', original_queue: 'queue-1', job_id: 'job-2', job_data: {}, error: 'err', failure_count: 1, last_attempt_at: new Date(), created_at: new Date() },
      ];
      // Setup sequential mock responses
      mockDb.executeTakeFirst
        .mockResolvedValueOnce({ total: 2 }) // getDeadLetters count
        .mockResolvedValueOnce({ id: 'dlq-1', original_queue: 'queue-1', job_id: 'job-1', job_data: {} }) // First retry lookup
        .mockResolvedValueOnce(null); // Second retry lookup - not found

      mockDb.execute
        .mockResolvedValueOnce(mockRecords) // getDeadLetters records
        .mockResolvedValueOnce([]); // First retry update

      const retriedCount = await deadLetterQueueService.bulkRetryDeadLetters({
        queue: 'queue-1',
      });

      expect(retriedCount).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to retry individual dead letter record',
        expect.any(Object)
      );
    });

    it('should use default limit', async () => {
      mockDb.executeTakeFirst.mockResolvedValue({ total: 0 });
      mockDb.execute.mockResolvedValueOnce([]);

      await deadLetterQueueService.bulkRetryDeadLetters({});

      expect(mockDb.limit).toHaveBeenCalledWith(100);
    });
  });

  describe('getStatistics()', () => {
    it('should return dead letter statistics', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 10 });
      mockDb.execute.mockResolvedValueOnce([
        { original_queue: 'queue-1', count: 5 },
        { original_queue: 'queue-2', count: 5 },
      ]);
      mockDb.execute.mockResolvedValueOnce([
        { error: 'Network timeout', count: 3 },
        { error: 'Validation error', count: 7 },
      ]);
      mockDb.executeTakeFirst.mockResolvedValueOnce({
        oldest: new Date('2024-01-01'),
        newest: new Date('2024-06-01'),
      });

      const stats = await deadLetterQueueService.getStatistics();

      expect(stats.totalDeadLetters).toBe(10);
      expect(stats.byQueue).toEqual({
        'queue-1': 5,
        'queue-2': 5,
      });
      expect(stats.oldestRecord).toEqual(new Date('2024-01-01'));
      expect(stats.newestRecord).toEqual(new Date('2024-06-01'));
    });

    it('should categorize errors', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 4 });
      mockDb.execute.mockResolvedValueOnce([]);
      mockDb.execute.mockResolvedValueOnce([
        { error: 'Network timeout occurred', count: 1 },
        { error: 'Authentication failed', count: 1 },
        { error: 'Validation error', count: 1 },
        { error: 'Rate limit exceeded', count: 1 },
      ]);
      mockDb.executeTakeFirst.mockResolvedValueOnce({ oldest: null, newest: null });

      const stats = await deadLetterQueueService.getStatistics();

      expect(stats.byErrorType).toEqual({
        'Network/Timeout': 1,
        'Authentication': 1,
        'Validation': 1,
        'Rate Limiting': 1,
      });
    });

    it('should handle empty statistics', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 0 });
      mockDb.execute.mockResolvedValueOnce([]);
      mockDb.execute.mockResolvedValueOnce([]);
      mockDb.executeTakeFirst.mockResolvedValueOnce({ oldest: null, newest: null });

      const stats = await deadLetterQueueService.getStatistics();

      expect(stats.totalDeadLetters).toBe(0);
      expect(stats.byQueue).toEqual({});
      expect(stats.byErrorType).toEqual({});
      expect(stats.oldestRecord).toBeNull();
      expect(stats.newestRecord).toBeNull();
    });
  });

  describe('cleanupOldRecords()', () => {
    it('should cleanup old records', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ numDeletedRows: 5 });

      const deletedCount = await deadLetterQueueService.cleanupOldRecords(30);

      expect(deletedCount).toBe(5);
      expect(mockDb.deleteFrom).toHaveBeenCalledWith('dead_letter_records');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Dead letter records cleaned up',
        expect.objectContaining({
          deletedCount: 5,
          olderThanDays: 30,
        })
      );
    });

    it('should handle database error', async () => {
      mockDb.executeTakeFirst.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        deadLetterQueueService.cleanupOldRecords(30)
      ).rejects.toThrow('DB error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to cleanup old dead letter records',
        expect.any(Object)
      );
    });
  });

  describe('shutdown()', () => {
    it('should shutdown the service cleanly', async () => {
      await deadLetterQueueService.initialize();
      await deadLetterQueueService.shutdown();

      expect(mockQueueClose).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Dead letter queue service shutdown completed');
    });

    it('should handle shutdown when not initialized', async () => {
      await deadLetterQueueService.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith('Dead letter queue service shutdown completed');
    });

    it('should handle shutdown error gracefully', async () => {
      await deadLetterQueueService.initialize();
      mockQueueClose.mockRejectedValueOnce(new Error('Close error'));

      await deadLetterQueueService.shutdown();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error during dead letter queue service shutdown',
        expect.any(Object)
      );
    });
  });

  describe('error categorization', () => {
    it('should categorize network errors', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 1 });
      mockDb.execute.mockResolvedValueOnce([]);
      mockDb.execute.mockResolvedValueOnce([
        { error: 'Connection timeout', count: 1 },
      ]);
      mockDb.executeTakeFirst.mockResolvedValueOnce({ oldest: null, newest: null });

      const stats = await deadLetterQueueService.getStatistics();

      expect(stats.byErrorType['Network/Timeout']).toBe(1);
    });

    it('should categorize not found errors', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 1 });
      mockDb.execute.mockResolvedValueOnce([]);
      mockDb.execute.mockResolvedValueOnce([
        { error: 'Resource not found', count: 1 },
      ]);
      mockDb.executeTakeFirst.mockResolvedValueOnce({ oldest: null, newest: null });

      const stats = await deadLetterQueueService.getStatistics();

      expect(stats.byErrorType['Not Found']).toBe(1);
    });

    it('should categorize other errors', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce({ total: 1 });
      mockDb.execute.mockResolvedValueOnce([]);
      mockDb.execute.mockResolvedValueOnce([
        { error: 'Unknown system error', count: 1 },
      ]);
      mockDb.executeTakeFirst.mockResolvedValueOnce({ oldest: null, newest: null });

      const stats = await deadLetterQueueService.getStatistics();

      expect(stats.byErrorType['Other']).toBe(1);
    });
  });
});
