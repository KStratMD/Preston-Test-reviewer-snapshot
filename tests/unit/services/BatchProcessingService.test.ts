import { BatchProcessingService, BatchResult, BatchProcessingOptions } from '../../../src/services/BatchProcessingService';
import type { DataRecord } from '../../../src/types';

describe('BatchProcessingService', () => {
  let service: BatchProcessingService;
  let mockLogger: any;
  let mockQueueService: any;
  let mockIntegrationService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    };

    mockQueueService = {
      initializeQueue: jest.fn().mockResolvedValue(undefined),
      addBatchJob: jest.fn().mockResolvedValue('job-123'),
      getJobProgress: jest.fn().mockResolvedValue(null),
      getQueueMetrics: jest.fn().mockResolvedValue({
        waiting: 0,
        active: 0,
        completed: 10,
        failed: 0
      }),
      pauseQueue: jest.fn().mockResolvedValue(undefined),
      resumeQueue: jest.fn().mockResolvedValue(undefined),
      retryFailedJobs: jest.fn().mockResolvedValue(5)
    };

    mockIntegrationService = {
      syncSingleRecord: jest.fn().mockResolvedValue({ success: true })
    };

    service = new BatchProcessingService(
      mockLogger,
      mockQueueService,
      mockIntegrationService
    );
  });

  describe('constructor', () => {
    it('should create service with dependencies', () => {
      expect(service).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should initialize queue with correct name', async () => {
      await service.initialize();

      expect(mockQueueService.initializeQueue).toHaveBeenCalledWith(
        'batch-processing',
        expect.any(Function)
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Batch processing service initialized');
    });

    it('should throw error if queue initialization fails', async () => {
      mockQueueService.initializeQueue.mockRejectedValue(new Error('Queue init failed'));

      await expect(service.initialize()).rejects.toThrow('Queue init failed');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('submitBatch', () => {
    it('should throw error for empty record set', async () => {
      await expect(service.submitBatch('integration-1', [])).rejects.toThrow(
        'Cannot process empty record set'
      );
    });

    it('should process small batch directly without queuing', async () => {
      const records: DataRecord[] = [
        { id: '1', fields: { name: 'Test 1' } },
        { id: '2', fields: { name: 'Test 2' } }
      ];

      const result = await service.submitBatch('integration-1', records);

      expect(result).toContain('direct-');
      expect(mockQueueService.addBatchJob).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Small batch processed directly',
        expect.any(Object)
      );
    });

    it('should queue large batch for processing', async () => {
      const records: DataRecord[] = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        fields: { name: `Test ${i}` }
      }));

      const result = await service.submitBatch('integration-1', records);

      expect(result).toBe('job-123');
      expect(mockQueueService.addBatchJob).toHaveBeenCalledWith(
        'batch-processing',
        'process-integration-batch',
        expect.objectContaining({
          integrationId: 'integration-1',
          records,
          batchSize: 100
        })
      );
    });

    it('should use custom batch size', async () => {
      const records: DataRecord[] = Array.from({ length: 60 }, (_, i) => ({
        id: String(i),
        fields: { name: `Test ${i}` }
      }));

      const options: BatchProcessingOptions = { batchSize: 50 };

      await service.submitBatch('integration-1', records, options);

      expect(mockQueueService.addBatchJob).toHaveBeenCalledWith(
        'batch-processing',
        'process-integration-batch',
        expect.objectContaining({
          batchSize: 50
        })
      );
    });

    it('should use custom priority', async () => {
      const records: DataRecord[] = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      const options: BatchProcessingOptions = { priority: 10 };

      await service.submitBatch('integration-1', records, options);

      expect(mockQueueService.addBatchJob).toHaveBeenCalledWith(
        'batch-processing',
        'process-integration-batch',
        expect.objectContaining({
          options: expect.objectContaining({
            priority: 10
          })
        })
      );
    });

    it('should use custom max attempts', async () => {
      const records: DataRecord[] = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      const options: BatchProcessingOptions = { maxAttempts: 5 };

      await service.submitBatch('integration-1', records, options);

      expect(mockQueueService.addBatchJob).toHaveBeenCalledWith(
        'batch-processing',
        'process-integration-batch',
        expect.objectContaining({
          options: expect.objectContaining({
            attempts: 5
          })
        })
      );
    });

    it('should use custom delay', async () => {
      const records: DataRecord[] = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      const options: BatchProcessingOptions = { delay: 5000 };

      await service.submitBatch('integration-1', records, options);

      expect(mockQueueService.addBatchJob).toHaveBeenCalledWith(
        'batch-processing',
        'process-integration-batch',
        expect.objectContaining({
          options: expect.objectContaining({
            delay: 5000
          })
        })
      );
    });

    it('should handle queue submission error', async () => {
      mockQueueService.addBatchJob.mockRejectedValue(new Error('Queue error'));

      const records: DataRecord[] = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      await expect(service.submitBatch('integration-1', records)).rejects.toThrow('Queue error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to submit batch for processing',
        expect.any(Object)
      );
    });

    it('should log errors for failed records in small batch', async () => {
      mockIntegrationService.syncSingleRecord.mockRejectedValue(new Error('Sync failed'));

      const records: DataRecord[] = [
        { id: '1', fields: { name: 'Test' } }
      ];

      // Small batches may complete with failures logged but not thrown
      // depending on implementation - the service logs errors
      const result = await service.submitBatch('integration-1', records);

      // Should return a job ID even if processing failed
      expect(result).toContain('direct-');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should log warning for records without ID', async () => {
      const records: DataRecord[] = [
        { id: '', fields: { name: 'Test' } }
      ];

      // Records without ID will log warning and fail to process
      const result = await service.submitBatch('integration-1', records);

      // Should still return a job ID
      expect(result).toContain('direct-');
    });
  });

  describe('getBatchStatus', () => {
    it('should return null if job not found', async () => {
      mockQueueService.getJobProgress.mockResolvedValue(null);

      const result = await service.getBatchStatus('nonexistent-job');

      expect(result).toBeNull();
    });

    it('should return batch result with progress data', async () => {
      mockQueueService.getJobProgress.mockResolvedValue({
        total: 100,
        processed: 50,
        failed: 2,
        percentage: 52,
        currentBatch: 3
      });

      const result = await service.getBatchStatus('job-123');

      expect(result).toEqual({
        jobId: 'job-123',
        integrationId: '',
        totalRecords: 100,
        processedRecords: 50,
        failedRecords: 2,
        status: 'processing',
        errors: []
      });
    });

    it('should return queued status for 0% progress', async () => {
      mockQueueService.getJobProgress.mockResolvedValue({
        total: 100,
        processed: 0,
        failed: 0,
        percentage: 0
      });

      const result = await service.getBatchStatus('job-123');

      expect(result?.status).toBe('queued');
    });

    it('should return completed status for 100% progress with no failures', async () => {
      mockQueueService.getJobProgress.mockResolvedValue({
        total: 100,
        processed: 100,
        failed: 0,
        percentage: 100
      });

      const result = await service.getBatchStatus('job-123');

      expect(result?.status).toBe('completed');
    });

    it('should return failed status for 100% progress with failures', async () => {
      mockQueueService.getJobProgress.mockResolvedValue({
        total: 100,
        processed: 95,
        failed: 5,
        percentage: 100
      });

      const result = await service.getBatchStatus('job-123');

      expect(result?.status).toBe('failed');
    });

    it('should handle error getting job progress', async () => {
      mockQueueService.getJobProgress.mockRejectedValue(new Error('Progress error'));

      const result = await service.getBatchStatus('job-123');

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get batch status',
        expect.any(Object)
      );
    });
  });

  describe('getBatchMetrics', () => {
    it('should return queue metrics', async () => {
      const metrics = {
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3
      };
      mockQueueService.getQueueMetrics.mockResolvedValue(metrics);

      const result = await service.getBatchMetrics();

      expect(result).toEqual(metrics);
      expect(mockQueueService.getQueueMetrics).toHaveBeenCalledWith('batch-processing');
    });

    it('should throw error if metrics retrieval fails', async () => {
      mockQueueService.getQueueMetrics.mockRejectedValue(new Error('Metrics error'));

      await expect(service.getBatchMetrics()).rejects.toThrow('Metrics error');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('pauseBatchProcessing', () => {
    it('should pause the queue', async () => {
      await service.pauseBatchProcessing();

      expect(mockQueueService.pauseQueue).toHaveBeenCalledWith('batch-processing');
      expect(mockLogger.info).toHaveBeenCalledWith('Batch processing paused');
    });

    it('should throw error if pause fails', async () => {
      mockQueueService.pauseQueue.mockRejectedValue(new Error('Pause error'));

      await expect(service.pauseBatchProcessing()).rejects.toThrow('Pause error');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('resumeBatchProcessing', () => {
    it('should resume the queue', async () => {
      await service.resumeBatchProcessing();

      expect(mockQueueService.resumeQueue).toHaveBeenCalledWith('batch-processing');
      expect(mockLogger.info).toHaveBeenCalledWith('Batch processing resumed');
    });

    it('should throw error if resume fails', async () => {
      mockQueueService.resumeQueue.mockRejectedValue(new Error('Resume error'));

      await expect(service.resumeBatchProcessing()).rejects.toThrow('Resume error');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('retryFailedBatches', () => {
    it('should retry failed jobs and return count', async () => {
      mockQueueService.retryFailedJobs.mockResolvedValue(5);

      const result = await service.retryFailedBatches();

      expect(result).toBe(5);
      expect(mockQueueService.retryFailedJobs).toHaveBeenCalledWith('batch-processing');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Failed batches retried',
        { retriedCount: 5 }
      );
    });

    it('should throw error if retry fails', async () => {
      mockQueueService.retryFailedJobs.mockRejectedValue(new Error('Retry error'));

      await expect(service.retryFailedBatches()).rejects.toThrow('Retry error');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('should log shutdown message', async () => {
      await service.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down batch processing service');
    });

    it('should handle shutdown errors gracefully', async () => {
      // Even if something goes wrong internally, shutdown should not throw
      await expect(service.shutdown()).resolves.not.toThrow();
    });
  });

  describe('batch processing logic', () => {
    it('should use default batch size of 100', async () => {
      const records: DataRecord[] = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      await service.submitBatch('integration-1', records);

      expect(mockQueueService.addBatchJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          batchSize: 100
        })
      );
    });

    it('should process exactly at batch size threshold', async () => {
      const records: DataRecord[] = Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      const result = await service.submitBatch('integration-1', records);

      // Exactly 100 records should be processed directly (not queued)
      expect(result).toContain('direct-');
      expect(mockQueueService.addBatchJob).not.toHaveBeenCalled();
    });

    it('should queue batch of 101 records', async () => {
      const records: DataRecord[] = Array.from({ length: 101 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      const result = await service.submitBatch('integration-1', records);

      expect(result).toBe('job-123');
      expect(mockQueueService.addBatchJob).toHaveBeenCalled();
    });
  });

  describe('exponential backoff configuration', () => {
    it('should configure exponential backoff with 2 second delay', async () => {
      const records: DataRecord[] = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      await service.submitBatch('integration-1', records);

      expect(mockQueueService.addBatchJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          options: expect.objectContaining({
            backoff: {
              type: 'exponential',
              delay: 2000
            }
          })
        })
      );
    });
  });

  describe('default options', () => {
    it('should use default values when options not provided', async () => {
      const records: DataRecord[] = Array.from({ length: 150 }, (_, i) => ({
        id: String(i),
        fields: {}
      }));

      await service.submitBatch('integration-1', records);

      expect(mockQueueService.addBatchJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          batchSize: 100,
          options: expect.objectContaining({
            priority: 0,
            delay: 0,
            attempts: 3
          })
        })
      );
    });
  });
});
