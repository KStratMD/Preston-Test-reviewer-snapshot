import { DeadLetterQueueService } from '../DeadLetterQueueService';
import { Logger } from '../../utils/Logger';
import { DatabaseService } from '../../database/DatabaseService';
import { Queue, Job } from 'bullmq';
import Redis from 'ioredis';

// --- Correct Mocking Strategy ---

// 1. Create mock functions for the methods we need to control/spy on.
const mockQueueAdd = jest.fn();
const mockQueueClose = jest.fn();
const mockRedisDisconnect = jest.fn();

// 2. Mock the entire modules, returning a mock implementation of the classes.
jest.mock('bullmq', () => ({
  __esModule: true,
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: mockQueueClose,
  })),
}));

jest.mock('ioredis', () => {
    // The default export is the Redis class.
    return jest.fn().mockImplementation(() => ({
        disconnect: mockRedisDisconnect,
    }));
});

// 3. Cast the imported modules for type safety in tests.
const MockedQueue = Queue as jest.Mock;
const MockedRedis = Redis as jest.Mock;

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

// The database mock needs to be mutable so we can reset it in beforeEach.
let mockDbQuery: any;
const mockSelectFrom = jest.fn(() => mockDbQuery);
const mockUpdateTable = jest.fn(() => mockDbQuery);
const mockInsertInto = jest.fn(() => mockDbQuery);
const mockDeleteFrom = jest.fn(() => mockDbQuery);

const mockDatabaseService = {
    getDatabase: jest.fn(() => ({
        selectFrom: mockSelectFrom,
        updateTable: mockUpdateTable,
        insertInto: mockInsertInto,
        deleteFrom: mockDeleteFrom,
    })),
} as unknown as jest.Mocked<DatabaseService>;


describe('DeadLetterQueueService', () => {
  let service: DeadLetterQueueService;

  beforeEach(() => {
    // Reset all mock function calls and implementations before each test.
    jest.clearAllMocks();
    
    // Re-create the mock query builder for each test to ensure isolation.
    mockDbQuery = {
      selectAll: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([]),
      executeTakeFirst: jest.fn().mockResolvedValue(null),
    };

    service = new DeadLetterQueueService(mockLogger, mockDatabaseService);
  });

  describe('initialize and shutdown', () => {
    it('should initialize the queue and connection', async () => {
      await service.initialize();
      expect(MockedQueue).toHaveBeenCalledWith('dead-letter-queue', expect.any(Object));
      expect(MockedRedis).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('Dead letter queue service initialized');
    });

    it('should shutdown the queue and connection', async () => {
      await service.initialize(); // Need to initialize first to have something to shut down
      await service.shutdown();

      expect(mockQueueClose).toHaveBeenCalledTimes(1);
      expect(mockRedisDisconnect).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('Dead letter queue service shutdown completed');
    });
  });

  describe('sendToDeadLetter', () => {
    it('should throw if not initialized', async () => {
      const job = { id: '1', data: { a: 1 }, attemptsMade: 1 } as Job;
      await expect(service.sendToDeadLetter('q', job, new Error('fail'))).rejects.toThrow('Dead letter queue service not initialized');
    });

    it('should send a job to the DLQ and store it in the database', async () => {
      await service.initialize();
      const job = { id: 'job-1', data: { payload: 'test' }, attemptsMade: 3 } as Job;
      const error = new Error('final failure');

      await service.sendToDeadLetter('original-queue', job, error);

      expect(mockQueueAdd).toHaveBeenCalledWith('dead-letter-record', expect.any(Object), expect.any(Object));
      expect(mockInsertInto).toHaveBeenCalledWith('dead_letter_records');
      expect(mockDbQuery.execute).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('Job sent to dead letter queue', expect.any(Object));
    });
  });

  describe('getDeadLetters', () => {
    it('should build and execute a query for dead letters', async () => {
      const mockRecord = { id: 'dlq-1', original_queue: 'q', job_id: '1', job_data: {}, error: 'err', failure_count: 1, last_attempt_at: new Date(), created_at: new Date() };
      mockDbQuery.execute.mockResolvedValueOnce([mockRecord]);
      mockDbQuery.executeTakeFirst.mockResolvedValueOnce({ total: 1 });

      const result = await service.getDeadLetters({ limit: 10, offset: 0 });
      
      expect(mockSelectFrom).toHaveBeenCalledWith('dead_letter_records as dlr');
      expect(mockDbQuery.limit).toHaveBeenCalledWith(10);
      expect(result.total).toBe(1);
      expect(result.records[0].jobId).toBe('1');
    });
  });

  describe('retryDeadLetter', () => {
    it('should throw if record not found', async () => {
      await service.initialize();
      mockDbQuery.executeTakeFirst.mockResolvedValueOnce(null);
      await expect(service.retryDeadLetter('unknown-id')).rejects.toThrow('Dead letter record not found: unknown-id');
    });

    it('should re-queue a job and update its DB record', async () => {
      await service.initialize();
      const mockRecord = { id: 'dlq-1', original_queue: 'q', job_id: '1', job_data: { a: 1 }, error: 'err' };
      mockDbQuery.executeTakeFirst.mockResolvedValueOnce(mockRecord);

      await service.retryDeadLetter('dlq-1');

      // A new queue instance is created for the retry
      expect(MockedQueue).toHaveBeenCalledWith('q', expect.any(Object));
      expect(mockQueueAdd).toHaveBeenCalledWith('retry-from-dlq', { a: 1 }, expect.any(Object));
      
      expect(mockUpdateTable).toHaveBeenCalledWith('dead_letter_records');
      expect(mockDbQuery.set).toHaveBeenCalledWith(expect.objectContaining({ retried_at: expect.any(Date) }));
      expect(mockDbQuery.where).toHaveBeenCalledWith('id', '=', 'dlq-1');
    });
  });

  describe('getStatistics', () => {
    it('should return aggregated statistics from the database', async () => {
        mockDbQuery.executeTakeFirst
            .mockResolvedValueOnce({ total: 10 })
            .mockResolvedValueOnce({ oldest: new Date(), newest: new Date() });

        mockDbQuery.execute
            .mockResolvedValueOnce([{ original_queue: 'q1', count: 7 }, { original_queue: 'q2', count: 3 }])
            .mockResolvedValueOnce([{ error: 'Timeout', count: 5 }, { error: 'Crash', count: 5 }]);

        const stats = await service.getStatistics();

        expect(stats.totalDeadLetters).toBe(10);
        expect(stats.byQueue.q1).toBe(7);
        expect(stats.byQueue.q2).toBe(3);
        expect(stats.byErrorType['Network/Timeout']).toBe(5);
        expect(stats.byErrorType['Other']).toBe(5);
        expect(stats.oldestRecord).toBeInstanceOf(Date);
    });
  });
});