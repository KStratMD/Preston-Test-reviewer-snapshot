/**
 * DataMigrationAccelerator Tests
 * Tests for bulk data migration with progress tracking and quality assurance
 */

import 'reflect-metadata';
import { DataMigrationAccelerator, MigrationPlan, MigrationPhase, FieldMapping } from '../../../src/services/DataMigrationAccelerator';

// Mock CryptoUtils
jest.mock('../../../src/utils/crypto', () => ({
  CryptoUtils: {
    generateUUID: jest.fn().mockImplementation(() => `uuid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`),
  },
}));

describe('DataMigrationAccelerator', () => {
  let service: DataMigrationAccelerator;
  let mockLogger: any;
  let mockAuthService: any;
  let mockTransformationEngine: any;
  let mockTelemetryService: any;

  beforeEach(() => {
    jest.useFakeTimers();

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockAuthService = {
      authenticate: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    };

    mockTransformationEngine = {
      transform: jest.fn().mockResolvedValue({ success: true }),
    };

    mockTelemetryService = {
      recordEvent: jest.fn().mockResolvedValue(undefined),
    };

    service = new DataMigrationAccelerator(
      mockLogger,
      mockAuthService,
      mockTransformationEngine,
      mockTelemetryService
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createMockPhase = (id: string, order: number, overrides?: Partial<MigrationPhase>): MigrationPhase => ({
    id,
    name: `Phase ${id}`,
    description: `Description for ${id}`,
    order,
    status: 'pending',
    entityType: 'customer',
    parallelizable: false,
    batchSize: 100,
    estimatedRecords: 1000,
    processedRecords: 0,
    configuration: {},
    ...overrides,
  });

  const createMockMapping = (source: string, target: string): FieldMapping => ({
    sourceField: source,
    targetField: target,
    transformationType: 'direct',
    isRequired: true,
  });

  const createMockPlanData = (overrides?: Partial<MigrationPlan>) => ({
    name: 'Test Migration',
    description: 'Test migration description',
    sourceSystem: 'salesforce',
    targetSystem: 'netsuite',
    status: 'draft' as const,
    phases: [createMockPhase('phase-1', 1)],
    mappings: [createMockMapping('name', 'companyname')],
    validationRules: [],
    ...overrides,
  });

  describe('constructor', () => {
    it('should log initialization', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('DataMigrationAccelerator initialized');
    });
  });

  describe('createMigrationPlan', () => {
    it('should create a new migration plan with generated fields', async () => {
      const planData = createMockPlanData();

      const plan = await service.createMigrationPlan(planData);

      expect(plan.id).toBeDefined();
      expect(plan.createdAt).toBeInstanceOf(Date);
      expect(plan.updatedAt).toBeInstanceOf(Date);
      expect(plan.processedRecords).toBe(0);
      expect(plan.successfulRecords).toBe(0);
      expect(plan.failedRecords).toBe(0);
    });

    it('should store the plan and log creation', async () => {
      const planData = createMockPlanData();

      const plan = await service.createMigrationPlan(planData);

      expect(mockLogger.info).toHaveBeenCalledWith('Migration plan created', expect.objectContaining({
        planId: plan.id,
        name: 'Test Migration',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
      }));
    });

    it('should record telemetry event', async () => {
      const planData = createMockPlanData();

      await service.createMigrationPlan(planData);

      expect(mockTelemetryService.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'MigrationJobStarted',
      }));
    });

    it('should validate required fields', async () => {
      const invalidPlan = createMockPlanData({ name: '' });

      await expect(service.createMigrationPlan(invalidPlan)).rejects.toThrow(
        'Migration plan must have name, sourceSystem, and targetSystem'
      );
    });

    it('should validate at least one phase exists', async () => {
      const invalidPlan = createMockPlanData({ phases: [] });

      await expect(service.createMigrationPlan(invalidPlan)).rejects.toThrow(
        'Migration plan must have at least one phase'
      );
    });

    it('should validate phase dependencies', async () => {
      const invalidPlan = createMockPlanData({
        phases: [
          createMockPhase('phase-1', 1, { dependsOn: ['non-existent'] }),
        ],
      });

      await expect(service.createMigrationPlan(invalidPlan)).rejects.toThrow(
        'Phase phase-1 depends on non-existent phase non-existent'
      );
    });

    it('should validate field mappings', async () => {
      const invalidPlan = createMockPlanData({
        mappings: [{ sourceField: '', targetField: 'target', transformationType: 'direct', isRequired: true }],
      });

      await expect(service.createMigrationPlan(invalidPlan)).rejects.toThrow(
        'All field mappings must have sourceField and targetField'
      );
    });

    it('should log and rethrow errors', async () => {
      const invalidPlan = createMockPlanData({ phases: [] });

      await expect(service.createMigrationPlan(invalidPlan)).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to create migration plan', expect.any(Object));
    });
  });

  describe('getMigrationPlan', () => {
    it('should return plan by ID', async () => {
      const planData = createMockPlanData();
      const created = await service.createMigrationPlan(planData);

      const retrieved = await service.getMigrationPlan(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return null for non-existent plan', async () => {
      const result = await service.getMigrationPlan('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('listMigrationPlans', () => {
    it('should return all plans', async () => {
      await service.createMigrationPlan(createMockPlanData({ name: 'Plan 1' }));
      await service.createMigrationPlan(createMockPlanData({ name: 'Plan 2' }));

      const plans = await service.listMigrationPlans();

      expect(plans.length).toBe(2);
    });

    it('should return empty array when no plans', async () => {
      const plans = await service.listMigrationPlans();
      expect(plans).toEqual([]);
    });
  });

  describe('updateMigrationPlan', () => {
    it('should update plan fields', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData());

      const updated = await service.updateMigrationPlan(plan.id, { name: 'Updated Name' });

      expect(updated.name).toBe('Updated Name');
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(plan.createdAt.getTime());
    });

    it('should throw for non-existent plan', async () => {
      await expect(service.updateMigrationPlan('non-existent', { name: 'New' })).rejects.toThrow(
        'Migration plan non-existent not found'
      );
    });

    it('should re-validate after update', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData());

      await expect(service.updateMigrationPlan(plan.id, { phases: [] })).rejects.toThrow(
        'Migration plan must have at least one phase'
      );
    });

    it('should log update', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData());

      await service.updateMigrationPlan(plan.id, { name: 'Updated' });

      expect(mockLogger.info).toHaveBeenCalledWith('Migration plan updated', expect.objectContaining({
        planId: plan.id,
      }));
    });
  });

  describe('startMigration', () => {
    it('should start migration for ready plan', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));

      const progress = await service.startMigration(plan.id);

      expect(progress.status).toBe('running');
      expect(progress.planId).toBe(plan.id);
      expect(progress.startTime).toBeInstanceOf(Date);
    });

    it('should initialize progress tracking', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));

      const progress = await service.startMigration(plan.id);

      expect(progress.overallProgress).toBe(0);
      expect(progress.phaseProgress).toBe(0);
      expect(progress.recordsPerSecond).toBe(0);
      expect(progress.errors).toEqual([]);
      expect(progress.warnings).toEqual([]);
    });

    it('should throw for non-existent plan', async () => {
      await expect(service.startMigration('non-existent')).rejects.toThrow(
        'Migration plan non-existent not found'
      );
    });

    it('should throw for non-ready plan', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'draft' }));

      await expect(service.startMigration(plan.id)).rejects.toThrow(
        `Migration plan ${plan.id} is not ready to start`
      );
    });

    it('should record telemetry event', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      mockTelemetryService.recordEvent.mockClear();

      await service.startMigration(plan.id);

      expect(mockTelemetryService.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'MigrationJobStarted',
        jobId: plan.id,
      }));
    });

    it('should log and rethrow errors', async () => {
      await expect(service.startMigration('non-existent')).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to start migration', expect.any(Object));
    });
  });

  describe('getMigrationProgress', () => {
    it('should return progress for active migration', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);

      const progress = await service.getMigrationProgress(plan.id);

      expect(progress).toBeDefined();
      expect(progress?.planId).toBe(plan.id);
    });

    it('should return null for non-active migration', async () => {
      const result = await service.getMigrationProgress('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('pauseMigration', () => {
    it('should pause active migration', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);

      await service.pauseMigration(plan.id);

      const progress = await service.getMigrationProgress(plan.id);
      expect(progress?.status).toBe('paused');
    });

    it('should update plan status', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);

      await service.pauseMigration(plan.id);

      const updatedPlan = await service.getMigrationPlan(plan.id);
      expect(updatedPlan?.status).toBe('paused');
    });

    it('should throw for non-active migration', async () => {
      await expect(service.pauseMigration('non-existent')).rejects.toThrow(
        'Active migration non-existent not found'
      );
    });

    it('should log pause', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);

      await service.pauseMigration(plan.id);

      expect(mockLogger.info).toHaveBeenCalledWith('Migration paused', { planId: plan.id });
    });
  });

  describe('resumeMigration', () => {
    it('should resume paused migration', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);
      await service.pauseMigration(plan.id);

      await service.resumeMigration(plan.id);

      const progress = await service.getMigrationProgress(plan.id);
      expect(progress?.status).toBe('running');
    });

    it('should throw for non-active migration', async () => {
      await expect(service.resumeMigration('non-existent')).rejects.toThrow(
        'Active migration non-existent not found'
      );
    });

    it('should log resume', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);
      await service.pauseMigration(plan.id);

      await service.resumeMigration(plan.id);

      expect(mockLogger.info).toHaveBeenCalledWith('Migration resumed', { planId: plan.id });
    });
  });

  describe('stopMigration', () => {
    it('should stop active migration', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);

      await service.stopMigration(plan.id);

      const progress = await service.getMigrationProgress(plan.id);
      expect(progress).toBeNull(); // Removed from active migrations
    });

    it('should update plan status to failed', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);

      await service.stopMigration(plan.id);

      const updatedPlan = await service.getMigrationPlan(plan.id);
      expect(updatedPlan?.status).toBe('failed');
    });

    it('should throw for non-active migration', async () => {
      await expect(service.stopMigration('non-existent')).rejects.toThrow(
        'Active migration non-existent not found'
      );
    });

    it('should log stop', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({ status: 'ready' }));
      await service.startMigration(plan.id);

      await service.stopMigration(plan.id);

      expect(mockLogger.info).toHaveBeenCalledWith('Migration stopped', { planId: plan.id });
    });
  });

  describe('generateDataQualityReport', () => {
    it('should generate report for plan', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData());

      const report = await service.generateDataQualityReport(plan.id);

      expect(report.planId).toBe(plan.id);
      expect(report.timestamp).toBeInstanceOf(Date);
      expect(report.metrics).toBeDefined();
      expect(report.issues).toBeInstanceOf(Array);
      expect(report.recommendations).toBeInstanceOf(Array);
    });

    it('should calculate metrics based on progress', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData({
        status: 'ready',
        totalRecords: 1000,
      }));
      await service.startMigration(plan.id);

      const report = await service.generateDataQualityReport(plan.id);

      expect(report.metrics.completeness).toBeDefined();
      expect(report.metrics.accuracy).toBeDefined();
      expect(report.metrics.consistency).toBeDefined();
      expect(report.metrics.validity).toBeDefined();
      expect(report.metrics.uniqueness).toBeDefined();
    });

    it('should throw for non-existent plan', async () => {
      await expect(service.generateDataQualityReport('non-existent')).rejects.toThrow(
        'Migration plan non-existent not found'
      );
    });

    it('should generate recommendations based on metrics', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData());

      const report = await service.generateDataQualityReport(plan.id);

      expect(report.recommendations).toBeDefined();
    });

    it('should log report generation', async () => {
      const plan = await service.createMigrationPlan(createMockPlanData());

      await service.generateDataQualityReport(plan.id);

      expect(mockLogger.info).toHaveBeenCalledWith('Data quality report generated', expect.objectContaining({
        planId: plan.id,
      }));
    });
  });

  describe('phase sorting and dependencies', () => {
    it('should sort phases by order', async () => {
      const planData = createMockPlanData({
        status: 'ready',
        phases: [
          createMockPhase('phase-3', 3, { estimatedRecords: 10 }),
          createMockPhase('phase-1', 1, { estimatedRecords: 10 }),
          createMockPhase('phase-2', 2, { estimatedRecords: 10 }),
        ],
      });

      const plan = await service.createMigrationPlan(planData);
      await service.startMigration(plan.id);

      // Let execution start
      jest.advanceTimersByTime(100);

      const progress = await service.getMigrationProgress(plan.id);
      // First phase should be phase-1
      expect(progress?.currentPhase).toBe('Phase phase-1');
    });

    it('should respect phase dependencies', async () => {
      const planData = createMockPlanData({
        status: 'ready',
        phases: [
          createMockPhase('phase-2', 2, { dependsOn: ['phase-1'], estimatedRecords: 10 }),
          createMockPhase('phase-1', 1, { estimatedRecords: 10 }),
        ],
      });

      const plan = await service.createMigrationPlan(planData);

      // This should not throw - dependencies are valid
      await service.startMigration(plan.id);
    });

    it('should detect circular dependencies', async () => {
      // Note: The service validates dependencies exist, but circular deps are detected at runtime
      const planData = createMockPlanData({
        status: 'ready',
        phases: [
          createMockPhase('phase-1', 1, { dependsOn: ['phase-2'], estimatedRecords: 10 }),
          createMockPhase('phase-2', 2, { dependsOn: ['phase-1'], estimatedRecords: 10 }),
        ],
      });

      const plan = await service.createMigrationPlan(planData);

      // Start migration - will fail during execution due to circular dependency
      await service.startMigration(plan.id);

      // Let execution attempt to run
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      const progress = await service.getMigrationProgress(plan.id);
      expect(progress?.status).toBe('failed');
    });
  });
});
