import { QueueService, type BatchProcessingJob } from '../services/QueueService';
import type { Logger } from '../utils/Logger';

// Mock BullMQ
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'job-123' }),
    getJob: jest.fn(),
    getWaiting: jest.fn().mockResolvedValue([]),
    getActive: jest.fn().mockResolvedValue([]),
    getCompleted: jest.fn().mockResolvedValue([]),
    getFailed: jest.fn().mockResolvedValue([]),
    getDelayed: jest.fn().mockResolvedValue([]),
    isPaused: jest.fn().mockResolvedValue(false),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    clean: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  QueueEvents: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('QueueService', () => {
  let queueService: QueueService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
      setCorrelationId: jest.fn().mockReturnThis(),
      withCorrelationId: jest.fn().mockReturnThis(),
      getCorrelationId: jest.fn().mockReturnValue('test-correlation-id'),
    } as unknown as jest.Mocked<Logger>;

    queueService = new QueueService(mockLogger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initializeQueue', () => {
    it('should initialize a queue successfully', async () => {
      await queueService.initializeQueue('test-queue');

      expect(mockLogger.info).toHaveBeenCalledWith('Queue initialized', {
        queueName: 'test-queue',
        hasProcessor: false,
      });
    });

    it('should initialize a queue with processor', async () => {
      const mockProcessor = jest.fn().mockResolvedValue(undefined);

      await queueService.initializeQueue('test-queue', mockProcessor);

      expect(mockLogger.info).toHaveBeenCalledWith('Queue initialized', {
        queueName: 'test-queue',
        hasProcessor: true,
      });
    });

    it('should handle initialization errors', async () => {
      const error = new Error('Initialization failed');
      jest.mocked(require('bullmq').Queue).mockImplementationOnce(() => {
        throw error;
      });

      await expect(queueService.initializeQueue('test-queue')).rejects.toThrow('Initialization failed');

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to initialize queue', {
        queueName: 'test-queue',
        error: 'Initialization failed',
      });
    });
  });

  describe('addBatchJob', () => {
    beforeEach(async () => {
      await queueService.initializeQueue('test-queue');
    });

    it('should add a batch job successfully', async () => {
      const batchJob: BatchProcessingJob = {
        integrationId: 'test-integration',
        records: [{ id: '1', fields: { name: 'Test' } }],
        batchSize: 100,
        options: {
          priority: 1,
          delay: 0,
          attempts: 3,
        },
      };

      const jobId = await queueService.addBatchJob('test-queue', 'test-job', batchJob);

      expect(jobId).toBe('job-123');
      expect(mockLogger.info).toHaveBeenCalledWith('Batch job added to queue', {
        queueName: 'test-queue',
        jobName: 'test-job',
        jobId: 'job-123',
        integrationId: 'test-integration',
        recordCount: 1,
        batchSize: 100,
      });
    });

    it('should throw error for uninitialized queue', async () => {
      const batchJob: BatchProcessingJob = {
        integrationId: 'test-integration',
        records: [],
        batchSize: 100,
      };

      await expect(queueService.addBatchJob('non-existent-queue', 'test-job', batchJob)).rejects.toThrow(
        'Queue non-existent-queue not initialized',
      );
    });
  });

  describe('getJobProgress', () => {
    beforeEach(async () => {
      await queueService.initializeQueue('test-queue');
    });

    it('should return job progress', async () => {
      const mockJob = {
        id: 'job-123',
        progress: {
          total: 100,
          processed: 50,
          failed: 5,
          percentage: 50,
        },
      };

      const mockQueue = {
        getJob: jest.fn().mockResolvedValue(mockJob),
      };
      (queueService as any).queues.set('test-queue', mockQueue);

      const progress = await queueService.getJobProgress('test-queue', 'job-123');

      expect(progress).toEqual({
        total: 100,
        processed: 50,
        failed: 5,
        percentage: 50,
      });
    });

    it('should return null for non-existent job', async () => {
      const mockQueue = {
        getJob: jest.fn().mockResolvedValue(null),
      };
      (queueService as any).queues.set('test-queue', mockQueue);

      const progress = await queueService.getJobProgress('test-queue', 'non-existent');

      expect(progress).toBeNull();
    });
  });

  describe('getQueueMetrics', () => {
    beforeEach(async () => {
      await queueService.initializeQueue('test-queue');
    });

    it('should return queue metrics', async () => {
      const metrics = await queueService.getQueueMetrics('test-queue');

      expect(metrics).toEqual({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
      });
    });
  });

  describe('queue management', () => {
    beforeEach(async () => {
      await queueService.initializeQueue('test-queue');
    });

    it('should pause a queue', async () => {
      await queueService.pauseQueue('test-queue');

      expect(mockLogger.info).toHaveBeenCalledWith('Queue paused', {
        queueName: 'test-queue',
      });
    });

    it('should resume a queue', async () => {
      await queueService.resumeQueue('test-queue');

      expect(mockLogger.info).toHaveBeenCalledWith('Queue resumed', {
        queueName: 'test-queue',
      });
    });

    it('should retry failed jobs', async () => {
      const mockFailedJobs = [
        { retry: jest.fn().mockResolvedValue(undefined) },
        { retry: jest.fn().mockResolvedValue(undefined) },
      ];

      const mockQueue = {
        getFailed: jest.fn().mockResolvedValue(mockFailedJobs),
      };
      (queueService as any).queues.set('test-queue', mockQueue);

      const retriedCount = await queueService.retryFailedJobs('test-queue');

      expect(retriedCount).toBe(2);
      expect(mockLogger.info).toHaveBeenCalledWith('Failed jobs retried', {
        queueName: 'test-queue',
        retriedCount: 2,
      });
    });

    it('should clean queue', async () => {
      await queueService.cleanQueue('test-queue', 86400000); // 24 hours

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Queue cleaned',
        {
          queueName: 'test-queue',
          grace: 86400000,
        },
      );
    });
  });

  describe('shutdown', () => {
    it('should shutdown all queues and workers', async () => {
      await queueService.initializeQueue('test-queue-1');
      await queueService.initializeQueue('test-queue-2', jest.fn());

      await queueService.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith('Queue service shutdown completed');
    });

    it('should handle shutdown errors', async () => {
      const error = new Error('Shutdown failed');
      const mockWorker = {
        close: jest.fn().mockRejectedValue(error),
      };
      (queueService as any).workers.set('test-queue', mockWorker);

      await expect(queueService.shutdown()).rejects.toThrow('Shutdown failed');
    });
  });
});
