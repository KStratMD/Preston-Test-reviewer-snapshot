/**
 * Comprehensive unit tests for IntegrationExecutor
 * Covers: executeSync, syncSingleRecord, testSync, syncRecord (private via executeSync)
 */
import 'reflect-metadata';

// Mock the in-tree uuid wrapper (the npm `uuid` package was removed; src/utils/uuid.ts
// now wraps node:crypto.randomUUID — see PR #714) and p-limit before import.
jest.mock('../../../../src/utils/uuid', () => ({ uuidv4: () => 'test-uuid-1234' }));
jest.mock('p-limit', () => {
  return () => (fn: () => Promise<any>) => fn();
});

import { IntegrationExecutor } from '../../../../src/services/integration/IntegrationExecutor';
import { createMockOwnershipResolver, createMockAuditService } from '../../../governanceTestUtils';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeConnector(overrides: Record<string, any> = {}) {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue([]),
    read: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'new-1' }),
    update: jest.fn().mockResolvedValue({ id: 'updated-1' }),
    testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    id: 'config-1',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Contact',
    targetEntity: 'Customer',
    fieldMappings: [],
    transformationRules: [],
    ...overrides,
  };
}

const mockTransformationEngine = {
  transformRecord: jest.fn().mockImplementation((record: any) => ({
    ...record,
    transformed: true,
  })),
};

const mockConnectorManager = {
  getConnector: jest.fn(),
};

const mockStatusManager = {} as any;
const mockObservability = {
  createScope: jest.fn().mockReturnValue({
    logger: mockLogger,
  }),
};

describe('IntegrationExecutor', () => {
  let executor: IntegrationExecutor;
  let sourceConnector: any;
  let targetConnector: any;

  beforeEach(() => {
    jest.clearAllMocks();

    sourceConnector = makeConnector();
    targetConnector = makeConnector();

    // getConnector returns source for first call, target for second
    mockConnectorManager.getConnector
      .mockResolvedValueOnce(sourceConnector)
      .mockResolvedValueOnce(targetConnector);

    executor = new IntegrationExecutor(
      mockLogger,
      mockTransformationEngine as any,
      mockConnectorManager as any,
      mockStatusManager,
      mockObservability as any,
      createMockOwnershipResolver() as any,
      createMockAuditService() as any,
      { enqueue: jest.fn().mockResolvedValue('noop-queue-id') } as any,
    );
  });

  describe('executeSync', () => {
    it('should return success when no source records', async () => {
      sourceConnector.list.mockResolvedValue([]);
      const result = await executor.executeSync(makeConfig());
      expect(result.status).toBe('success');
      expect(result.success).toBe(true);
      expect(result.recordsProcessed).toBe(0);
    });

    it('should sync records successfully', async () => {
      sourceConnector.list.mockResolvedValue([
        { id: 'r1', fields: { name: 'Test' } },
        { id: 'r2', fields: { name: 'Test2' } },
      ]);
      targetConnector.read.mockResolvedValue(null); // Records don't exist in target

      const result = await executor.executeSync(makeConfig());
      expect(result.status).toBe('success');
      expect(result.recordsProcessed).toBe(2);
      expect(result.recordsSuccessful).toBe(2);
      expect(result.recordsFailed).toBe(0);
    });

    it('should update existing records', async () => {
      sourceConnector.list.mockResolvedValue([
        { id: 'r1', fields: { name: 'Test' } },
      ]);
      targetConnector.read.mockResolvedValue({ id: 'r1', fields: {} }); // Exists

      const result = await executor.executeSync(makeConfig());
      expect(result.status).toBe('success');
      expect(targetConnector.update).toHaveBeenCalled();
    });

    it('should create new records', async () => {
      sourceConnector.list.mockResolvedValue([
        { id: 'r1', fields: { name: 'Test' } },
      ]);
      targetConnector.read.mockResolvedValue(null); // Doesn't exist

      const result = await executor.executeSync(makeConfig());
      expect(result.status).toBe('success');
      expect(targetConnector.create).toHaveBeenCalled();
    });

    it('should handle partial failures', async () => {
      sourceConnector.list.mockResolvedValue([
        { id: 'r1', fields: { name: 'Test' } },
        { id: 'r2', fields: { name: 'Test2' } },
      ]);
      targetConnector.read.mockResolvedValue(null);
      targetConnector.create
        .mockResolvedValueOnce({ id: 'r1' })
        .mockRejectedValueOnce(new Error('Write failed'));

      const result = await executor.executeSync(makeConfig());
      expect(result.status).toBe('partial');
      expect(result.recordsSuccessful).toBe(1);
      expect(result.recordsFailed).toBe(1);
      expect(result.errors.length).toBe(1);
    });

    it('should handle total failure', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector.mockRejectedValue(new Error('Connector init failed'));

      const result = await executor.executeSync(makeConfig());
      expect(result.status).toBe('failed');
      expect(result.success).toBe(false);
      expect(result.errors.length).toBe(1);
    });

    it('should skip write in dry run mode', async () => {
      sourceConnector.list.mockResolvedValue([
        { id: 'r1', fields: { name: 'Test' } },
      ]);

      // Re-setup connectors since they were consumed by beforeEach
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector
        .mockResolvedValueOnce(sourceConnector)
        .mockResolvedValueOnce(targetConnector);

      const result = await executor.executeSync(makeConfig(), { dryRun: true });
      expect(result.status).toBe('success');
      expect(targetConnector.create).not.toHaveBeenCalled();
      expect(targetConnector.update).not.toHaveBeenCalled();
    });

    it('should handle object-type source/target system', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector
        .mockResolvedValueOnce(sourceConnector)
        .mockResolvedValueOnce(targetConnector);
      sourceConnector.list.mockResolvedValue([]);

      const config = makeConfig({
        sourceSystem: { type: 'Salesforce' },
        targetSystem: { type: 'NetSuite' },
      });

      const result = await executor.executeSync(config);
      expect(result.status).toBe('success');
      expect(mockConnectorManager.getConnector).toHaveBeenCalledWith(
        'Salesforce',
        expect.any(String)
      );
    });
  });

  describe('syncSingleRecord', () => {
    it('should sync a single record successfully', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector
        .mockResolvedValueOnce(sourceConnector)
        .mockResolvedValueOnce(targetConnector);

      sourceConnector.read.mockResolvedValue({ id: 'r1', fields: { name: 'Test' } });
      targetConnector.read.mockResolvedValue(null);

      const result = await executor.syncSingleRecord(makeConfig(), 'r1');
      expect(result.status).toBe('success');
      expect(result.recordsProcessed).toBe(1);
      expect(result.recordsSuccessful).toBe(1);
    });

    it('should fail when record not found', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector
        .mockResolvedValueOnce(sourceConnector)
        .mockResolvedValueOnce(targetConnector);

      sourceConnector.read.mockResolvedValue(null);

      const result = await executor.syncSingleRecord(makeConfig(), 'r1');
      expect(result.status).toBe('failed');
      expect(result.errors[0]).toContain('not found');
    });

    it('should handle sync error', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector
        .mockResolvedValueOnce(sourceConnector)
        .mockResolvedValueOnce(targetConnector);

      sourceConnector.read.mockResolvedValue({ id: 'r1', fields: {} });
      targetConnector.read.mockResolvedValue(null);
      targetConnector.create.mockRejectedValue(new Error('Write error'));

      const result = await executor.syncSingleRecord(makeConfig(), 'r1');
      expect(result.status).toBe('failed');
      expect(result.recordsFailed).toBe(1);
    });
  });

  describe('syncRecord existence-check error discrimination', () => {
    it('fails the sync (does NOT create) when target read throws a non-404 error', async () => {
      sourceConnector.list.mockResolvedValue([{ id: 'rec-1', name: 'Ada' }]);
      targetConnector.read.mockRejectedValue(
        new Error('Request failed with status code 401'),
      );

      const result = await executor.executeSync(makeConfig() as any);

      expect(targetConnector.create).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toMatch(/401/);
    });

    it('takes the create branch when target read throws a 404-shaped error', async () => {
      sourceConnector.list.mockResolvedValue([{ id: 'rec-1', name: 'Ada' }]);
      targetConnector.read.mockRejectedValue(
        new Error('Request failed with status code 404'),
      );

      const result = await executor.executeSync(makeConfig() as any);

      expect(targetConnector.create).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it('takes the create branch when target read resolves null (base-contract not-found)', async () => {
      sourceConnector.list.mockResolvedValue([{ id: 'rec-1', name: 'Ada' }]);
      targetConnector.read.mockResolvedValue(null);

      const result = await executor.executeSync(makeConfig() as any);

      expect(targetConnector.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('isNotFoundReadError', () => {
    const { isNotFoundReadError } = jest.requireActual(
      '../../../../src/services/integration/IntegrationExecutor',
    );

    it.each([
      [{ response: { status: 404 } }, true],
      [{ status: 404 }, true],
      [{ statusCode: 404 }, true],
      [new Error('Customer not found'), true],
      [new Error('Request failed with status code 404'), true],
      [{ response: { status: 401 } }, false],
      [{ statusCode: 500 }, false],
      [new Error('Request failed with status code 429'), false],
      [new Error('ECONNRESET'), false],
      [null, false],
      [undefined, false],
    ])('%p → %p', (input, expected) => {
      expect(isNotFoundReadError(input)).toBe(expected);
    });
  });

  describe('testSync', () => {
    it('should test connectivity and transformations', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector
        .mockResolvedValueOnce(sourceConnector)
        .mockResolvedValueOnce(targetConnector);

      sourceConnector.testConnection.mockResolvedValue({ isConnected: true });
      targetConnector.testConnection.mockResolvedValue({ isConnected: true });
      sourceConnector.list.mockResolvedValue([
        { id: 'r1', fields: { name: 'Test' } },
      ]);

      const result = await executor.testSync(makeConfig());
      expect(result.canConnect).toBe(true);
      expect(result.sampleRecords.length).toBe(1);
      expect(result.transformationPreview.length).toBe(1);
      expect(result.errors.length).toBe(0);
    });

    it('should report connection failure', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector
        .mockResolvedValueOnce(sourceConnector)
        .mockResolvedValueOnce(targetConnector);

      sourceConnector.testConnection.mockResolvedValue({
        isConnected: false,
        errorMessage: 'Auth failed',
      });
      targetConnector.testConnection.mockResolvedValue({ isConnected: true });

      const result = await executor.testSync(makeConfig());
      expect(result.canConnect).toBe(false);
      expect(result.errors.some((e: string) => e.includes('Source system'))).toBe(true);
    });

    it('should handle transformation errors', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector
        .mockResolvedValueOnce(sourceConnector)
        .mockResolvedValueOnce(targetConnector);

      sourceConnector.testConnection.mockResolvedValue({ isConnected: true });
      targetConnector.testConnection.mockResolvedValue({ isConnected: true });
      sourceConnector.list.mockResolvedValue([
        { id: 'r1', fields: { name: 'Test' } },
      ]);
      mockTransformationEngine.transformRecord.mockRejectedValueOnce(
        new Error('Transform error')
      );

      const result = await executor.testSync(makeConfig());
      expect(result.errors.length).toBe(1);
      expect(result.validationResults[0].isValid).toBe(false);
    });

    it('should handle total test failure', async () => {
      mockConnectorManager.getConnector.mockReset();
      mockConnectorManager.getConnector.mockRejectedValue(new Error('Init error'));

      const result = await executor.testSync(makeConfig());
      expect(result.canConnect).toBe(false);
      expect(result.errors.length).toBe(1);
    });
  });
});
