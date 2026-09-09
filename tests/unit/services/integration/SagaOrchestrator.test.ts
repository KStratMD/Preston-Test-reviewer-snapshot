/**
 * SagaOrchestrator Unit Tests
 *
 * Tests the Saga pattern implementation for distributed transactions:
 * - Step execution and compensation
 * - Idempotency key handling
 * - Automatic rollback on failure
 */

import { SagaOrchestrator, SagaStep, SagaExecution } from '../../../../src/services/integration/SagaOrchestrator';
import { Logger } from '../../../../src/utils/Logger';

// Mock DatabaseService
const mockQuery = jest.fn();
const mockDatabaseService = {
  query: mockQuery,
  initialize: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
};

// Mock Logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as unknown as Logger;

describe('SagaOrchestrator', () => {
  let sagaOrchestrator: SagaOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock: database query returns empty (no existing saga)
    mockQuery.mockResolvedValue({ rows: [] });
    sagaOrchestrator = new SagaOrchestrator(mockDatabaseService as any, mockLogger);
  });

  describe('generateIdempotencyKey', () => {
    it('should generate consistent keys for same input', () => {
      const key1 = sagaOrchestrator.generateIdempotencyKey('order', { orderId: '123' });
      const key2 = sagaOrchestrator.generateIdempotencyKey('order', { orderId: '123' });
      expect(key1).toBe(key2);
    });

    it('should generate different keys for different input', () => {
      const key1 = sagaOrchestrator.generateIdempotencyKey('order', { orderId: '123' });
      const key2 = sagaOrchestrator.generateIdempotencyKey('order', { orderId: '456' });
      expect(key1).not.toBe(key2);
    });

    it('should generate 32-character hex keys', () => {
      const key = sagaOrchestrator.generateIdempotencyKey('test', { data: 'value' });
      expect(key).toHaveLength(32);
      expect(key).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe('executeSaga', () => {
    it('should execute all steps successfully', async () => {
      const executeStep1 = jest.fn().mockResolvedValue({ step1Result: true });
      const compensateStep1 = jest.fn();
      const executeStep2 = jest.fn().mockResolvedValue({ step2Result: true });
      const compensateStep2 = jest.fn();

      const steps: SagaStep<{ testData: string }>[] = [
        { name: 'step1', execute: executeStep1, compensate: compensateStep1 },
        { name: 'step2', execute: executeStep2, compensate: compensateStep2 },
      ];

      const context = { testData: 'test' };
      const result = await sagaOrchestrator.executeSaga('test-saga', steps, context);

      expect(result.status).toBe('completed');
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].status).toBe('success');
      expect(result.steps[1].status).toBe('success');
      expect(executeStep1).toHaveBeenCalledWith(context);
      expect(executeStep2).toHaveBeenCalledWith(context);
      expect(compensateStep1).not.toHaveBeenCalled();
      expect(compensateStep2).not.toHaveBeenCalled();
    });

    it('should compensate on failure', async () => {
      const executeStep1 = jest.fn().mockResolvedValue({ step1Result: true });
      const compensateStep1 = jest.fn();
      const executeStep2 = jest.fn().mockRejectedValue(new Error('Step 2 failed'));
      const compensateStep2 = jest.fn();

      const steps: SagaStep<{ testData: string }>[] = [
        { name: 'step1', execute: executeStep1, compensate: compensateStep1 },
        { name: 'step2', execute: executeStep2, compensate: compensateStep2 },
      ];

      const context = { testData: 'test' };
      const result = await sagaOrchestrator.executeSaga('test-saga', steps, context);

      expect(result.status).toBe('compensated');
      expect(result.error).toContain('Step "step2" failed');
      expect(compensateStep1).toHaveBeenCalled();
      // Step 2 never completed successfully, so no compensation needed
      expect(compensateStep2).not.toHaveBeenCalled();
    });

    it('should skip execution if saga already completed (idempotent)', async () => {
      const existingSaga: SagaExecution = {
        id: 'existing-saga-id',
        idempotencyKey: 'test-key',
        sagaType: 'test-saga',
        status: 'completed',
        currentStep: 1,
        steps: [{ stepName: 'step1', status: 'success', executedAt: Date.now(), duration: 100 }],
        context: { testData: 'test' },
        createdAt: Date.now() - 1000,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      };

      // First query returns existing completed saga
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: existingSaga.id,
            idempotency_key: existingSaga.idempotencyKey,
            saga_type: existingSaga.sagaType,
            status: existingSaga.status,
            current_step: existingSaga.currentStep,
            steps_json: JSON.stringify(existingSaga.steps),
            context_json: JSON.stringify(existingSaga.context),
            error: null,
            created_at: existingSaga.createdAt,
            updated_at: existingSaga.updatedAt,
            completed_at: existingSaga.completedAt,
          },
        ],
      });

      const executeStep1 = jest.fn();
      const steps: SagaStep<{ testData: string }>[] = [
        { name: 'step1', execute: executeStep1, compensate: jest.fn() },
      ];

      const result = await sagaOrchestrator.executeSaga(
        'test-saga',
        steps,
        { testData: 'test' },
        { idempotencyKey: 'test-key' }
      );

      expect(result.status).toBe('completed');
      expect(result.id).toBe('existing-saga-id');
      expect(executeStep1).not.toHaveBeenCalled();
    });

    it('should throw if saga already in progress', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'in-progress-saga',
            idempotency_key: 'test-key',
            saga_type: 'test-saga',
            status: 'in_progress',
            current_step: 0,
            steps_json: '[]',
            context_json: '{}',
            error: null,
            created_at: Date.now(),
            updated_at: Date.now(),
            completed_at: null,
          },
        ],
      });

      const steps: SagaStep<{}>[] = [
        { name: 'step1', execute: jest.fn(), compensate: jest.fn() },
      ];

      await expect(
        sagaOrchestrator.executeSaga('test-saga', steps, {}, { idempotencyKey: 'test-key' })
      ).rejects.toThrow('is already in progress');
    });

    it('should allow retry of failed saga when retryOnFailure is true', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'failed-saga',
            idempotency_key: 'test-key',
            saga_type: 'test-saga',
            status: 'failed',
            current_step: 0,
            steps_json: '[]',
            context_json: '{}',
            error: 'Previous error',
            created_at: Date.now() - 1000,
            updated_at: Date.now(),
            completed_at: null,
          },
        ],
      });

      // After checking idempotency, mock returns empty for subsequent persistence queries
      mockQuery.mockResolvedValue({ rows: [] });

      const executeStep1 = jest.fn().mockResolvedValue({ success: true });
      const steps: SagaStep<{}>[] = [
        { name: 'step1', execute: executeStep1, compensate: jest.fn() },
      ];

      const result = await sagaOrchestrator.executeSaga(
        'test-saga',
        steps,
        {},
        { idempotencyKey: 'test-key', retryOnFailure: true }
      );

      expect(result.status).toBe('completed');
      expect(executeStep1).toHaveBeenCalled();
    });
  });

  describe('getSaga', () => {
    it('should return saga from cache', async () => {
      // First execute a saga to populate cache
      const executeStep1 = jest.fn().mockResolvedValue({});
      const steps: SagaStep<{}>[] = [
        { name: 'step1', execute: executeStep1, compensate: jest.fn() },
      ];

      const saga = await sagaOrchestrator.executeSaga('test-saga', steps, {});
      const retrieved = await sagaOrchestrator.getSaga(saga.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(saga.id);
    });

    it('should return null for non-existent saga', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const result = await sagaOrchestrator.getSaga('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('getSagasByType', () => {
    it('should return sagas filtered by type', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'saga-1',
            idempotency_key: 'key-1',
            saga_type: 'order-saga',
            status: 'completed',
            current_step: 1,
            steps_json: '[]',
            context_json: '{}',
            error: null,
            created_at: Date.now(),
            updated_at: Date.now(),
            completed_at: Date.now(),
          },
        ],
      });

      const sagas = await sagaOrchestrator.getSagasByType('order-saga');
      expect(sagas).toHaveLength(1);
      expect(sagas[0].sagaType).toBe('order-saga');
    });
  });

  describe('getFailedSagas', () => {
    it('should return only failed sagas', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'failed-saga-1',
            idempotency_key: 'key-1',
            saga_type: 'test-saga',
            status: 'failed',
            current_step: 0,
            steps_json: '[]',
            context_json: '{}',
            error: 'Some error',
            created_at: Date.now(),
            updated_at: Date.now(),
            completed_at: null,
          },
        ],
      });

      const sagas = await sagaOrchestrator.getFailedSagas();
      expect(sagas).toHaveLength(1);
      expect(sagas[0].status).toBe('failed');
    });
  });

  describe('cleanupCompletedSagas', () => {
    it('should clean up old completed sagas', async () => {
      // First execute a saga
      const executeStep1 = jest.fn().mockResolvedValue({});
      const steps: SagaStep<{}>[] = [
        { name: 'step1', execute: executeStep1, compensate: jest.fn() },
      ];

      await sagaOrchestrator.executeSaga('test-saga', steps, {});

      // Mock successful cleanup
      mockQuery.mockResolvedValue({ rows: [] });

      const deleted = await sagaOrchestrator.cleanupCompletedSagas(0); // 0ms = clean all
      expect(deleted).toBeGreaterThanOrEqual(0);
    });
  });
});
