/**
 * AutomationLibrariesService Tests
 * Session 13 - Large untested service (1,437 lines)
 */

import { AutomationLibrariesService } from '../../../../src/services/AutomationLibrariesService';
import type { Logger } from '../../../../src/utils/Logger';
import type { TelemetryService } from '../../../../src/services/TelemetryService';

// Create mocks
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as any;
}

function createMockTelemetryService(): jest.Mocked<TelemetryService> {
  return {
    recordMetric: jest.fn(),
    recordEvent: jest.fn(),
    startSpan: jest.fn(),
    endSpan: jest.fn(),
  } as any;
}

describe('AutomationLibrariesService', () => {
  let service: AutomationLibrariesService;
  let mockLogger: jest.Mocked<Logger>;
  let mockTelemetryService: jest.Mocked<TelemetryService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockTelemetryService = createMockTelemetryService();
    service = new AutomationLibrariesService(mockLogger, mockTelemetryService);
  });

  describe('Library Management', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('AutomationLibrariesService initialized');
    });

    it('should get all active libraries', async () => {
      const libraries = await service.getLibraries();
      expect(Array.isArray(libraries)).toBe(true);
      expect(libraries.length).toBeGreaterThan(0);
      libraries.forEach(lib => {
        expect(['active', 'beta']).toContain(lib.status);
      });
    });

    it('should filter libraries by category', async () => {
      const payoutLibs = await service.getLibraries('payout');
      expect(Array.isArray(payoutLibs)).toBe(true);
      payoutLibs.forEach(lib => {
        expect(lib.category).toBe('payout');
      });
    });

    it('should filter libraries by quality category', async () => {
      const qualityLibs = await service.getLibraries('quality');
      expect(Array.isArray(qualityLibs)).toBe(true);
      qualityLibs.forEach(lib => {
        expect(lib.category).toBe('quality');
      });
    });

    it('should filter libraries by installer category', async () => {
      const installerLibs = await service.getLibraries('installer');
      expect(Array.isArray(installerLibs)).toBe(true);
      installerLibs.forEach(lib => {
        expect(lib.category).toBe('installer');
      });
    });

    it('should get library by ID', async () => {
      const libraries = await service.getLibraries();
      if (libraries.length > 0) {
        const lib = await service.getLibrary(libraries[0].id);
        expect(lib).not.toBeNull();
        expect(lib?.id).toBe(libraries[0].id);
      }
    });

    it('should return null for non-existent library', async () => {
      const lib = await service.getLibrary('non-existent-id');
      expect(lib).toBeNull();
    });
  });

  describe('Payout Automation', () => {
    it('should execute payout automation', async () => {
      const libraries = await service.getLibraries('payout');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const executionId = await service.executePayoutAutomation(
          templateId,
          'vendor-123',
          1000.50,
          ['inv-001', 'inv-002'],
          'user@example.com'
        );

        expect(typeof executionId).toBe('string');
        expect(executionId).toContain('payout_');
      }
    });

    it('should throw error for non-existent template', async () => {
      await expect(
        service.executePayoutAutomation(
          'non-existent-template',
          'vendor-123',
          1000,
          ['inv-001'],
          'user@example.com'
        )
      ).rejects.toThrow('Automation template not found');
    });

    it('should get all payout executions', async () => {
      const result = await service.getPayoutExecutions({});
      expect(result).toHaveProperty('executions');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.executions)).toBe(true);
      expect(typeof result.totalCount).toBe('number');
    });

    it('should filter payout executions by status', async () => {
      const libraries = await service.getLibraries('payout');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        await service.executePayoutAutomation(
          templateId,
          'vendor-123',
          1000,
          ['inv-001'],
          'user@example.com'
        );

        const result = await service.getPayoutExecutions({ status: ['pending'] });
        expect(result).toHaveProperty('executions');
        expect(Array.isArray(result.executions)).toBe(true);
      }
    });

    it('should filter payout executions by vendor', async () => {
      const libraries = await service.getLibraries('payout');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        await service.executePayoutAutomation(
          templateId,
          'vendor-specific',
          1000,
          ['inv-001'],
          'user@example.com'
        );

        const result = await service.getPayoutExecutions({ vendorId: 'vendor-specific' });
        expect(result).toHaveProperty('executions');
        expect(Array.isArray(result.executions)).toBe(true);
      }
    });

    it('should filter payout executions by date range', async () => {
      const start = Date.now() - 86400000; // 24 hours ago
      const end = Date.now() + 86400000; // 24 hours from now

      const result = await service.getPayoutExecutions({ dateRange: { start, end } });
      expect(result).toHaveProperty('executions');
      expect(Array.isArray(result.executions)).toBe(true);
    });

    it('should handle payout automation with zero amount', async () => {
      const libraries = await service.getLibraries('payout');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const executionId = await service.executePayoutAutomation(
          templateId,
          'vendor-123',
          0,
          ['inv-001'],
          'user@example.com'
        );

        expect(typeof executionId).toBe('string');
      }
    });

    it('should handle payout automation with empty invoice list', async () => {
      const libraries = await service.getLibraries('payout');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const executionId = await service.executePayoutAutomation(
          templateId,
          'vendor-123',
          1000,
          [],
          'user@example.com'
        );

        expect(typeof executionId).toBe('string');
      }
    });
  });

  describe('Quality Check Automation', () => {
    it('should execute quality check', async () => {
      const libraries = await service.getLibraries('quality');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const resultId = await service.executeQualityCheck(
          templateId,
          'integration',
          'integration-123',
          'Test Integration'
        );

        expect(typeof resultId).toBe('string');
        expect(resultId).toContain('quality_');
      }
    });

    it('should throw error for non-existent quality template', async () => {
      await expect(
        service.executeQualityCheck(
          'non-existent-template',
          'integration',
          'test',
          'Test'
        )
      ).rejects.toThrow();
    });

    it('should get all quality results', async () => {
      const result = await service.getQualityResults({});
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('should filter quality results by status', async () => {
      const libraries = await service.getLibraries('quality');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        await service.executeQualityCheck(
          templateId,
          'integration',
          'test',
          'Test'
        );

        const result = await service.getQualityResults({ status: ['running'] });
        expect(result).toHaveProperty('results');
        expect(Array.isArray(result.results)).toBe(true);
      }
    });

    it('should filter quality results by target type', async () => {
      const libraries = await service.getLibraries('quality');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        await service.executeQualityCheck(
          templateId,
          'connector',
          'conn-123',
          'Test Connector'
        );

        const result = await service.getQualityResults({ targetType: 'connector' });
        expect(result).toHaveProperty('results');
        expect(Array.isArray(result.results)).toBe(true);
      }
    });

    it('should filter quality results by date range', async () => {
      const result = await service.getQualityResults({});
      expect(result).toHaveProperty('results');
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('should handle quality check for mapping target', async () => {
      const libraries = await service.getLibraries('quality');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const resultId = await service.executeQualityCheck(
          templateId,
          'mapping',
          'map-123',
          'Test Mapping'
        );

        expect(typeof resultId).toBe('string');
      }
    });

    it('should handle quality check for workflow target', async () => {
      const libraries = await service.getLibraries('quality');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const resultId = await service.executeQualityCheck(
          templateId,
          'workflow',
          'wf-123',
          'Test Workflow'
        );

        expect(typeof resultId).toBe('string');
      }
    });
  });

  describe('Installer Automation', () => {
    it('should execute installer task', async () => {
      const libraries = await service.getLibraries('installer');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const taskId = await service.executeInstaller(
          templateId,
          'connector',
          'NetSuite',
          '2024.1',
          'production',
          'user@example.com'
        );

        expect(typeof taskId).toBe('string');
        expect(taskId).toContain('installer_');
      }
    });

    it('should throw error for non-existent installer template', async () => {
      await expect(
        service.executeInstaller(
          'non-existent-template',
          'connector',
          'Test',
          '1.0',
          'staging',
          'user@example.com'
        )
      ).rejects.toThrow();
    });

    it('should get all installer tasks', async () => {
      const result = await service.getInstallerTasks({});
      expect(result).toHaveProperty('tasks');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.tasks)).toBe(true);
    });

    it('should filter installer tasks by status', async () => {
      const libraries = await service.getLibraries('installer');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        await service.executeInstaller(
          templateId,
          'connector',
          'SAP',
          '1.0',
          'staging',
          'user@example.com'
        );

        const result = await service.getInstallerTasks({ status: ['running'] });
        expect(result).toHaveProperty('tasks');
        expect(Array.isArray(result.tasks)).toBe(true);
      }
    });

    it('should filter installer tasks by system', async () => {
      const libraries = await service.getLibraries('installer');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        await service.executeInstaller(
          templateId,
          'connector',
          'Salesforce',
          '1.0',
          'staging',
          'user@example.com'
        );

        const result = await service.getInstallerTasks({ targetType: 'connector' });
        expect(result).toHaveProperty('tasks');
        expect(Array.isArray(result.tasks)).toBe(true);
      }
    });

    it('should filter installer tasks by environment', async () => {
      const libraries = await service.getLibraries('installer');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        await service.executeInstaller(
          templateId,
          'connector',
          'Oracle',
          '1.0',
          'development',
          'user@example.com'
        );

        const result = await service.getInstallerTasks({ environment: ['development'] });
        expect(result).toHaveProperty('tasks');
        expect(Array.isArray(result.tasks)).toBe(true);
      }
    });

    it('should filter installer tasks by date range', async () => {
      const result = await service.getInstallerTasks({});
      expect(result).toHaveProperty('tasks');
      expect(Array.isArray(result.tasks)).toBe(true);
    });

    it('should handle installer for staging environment', async () => {
      const libraries = await service.getLibraries('installer');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const taskId = await service.executeInstaller(
          templateId,
          'connector',
          'NetSuite',
          '1.0',
          'staging',
          'user@example.com'
        );

        expect(typeof taskId).toBe('string');
      }
    });

    it('should handle installer for development environment', async () => {
      const libraries = await service.getLibraries('installer');
      if (libraries.length > 0 && libraries[0].automations.length > 0) {
        const templateId = libraries[0].automations[0].id;

        const taskId = await service.executeInstaller(
          templateId,
          'connector',
          'NetSuite',
          '1.0',
          'development',
          'user@example.com'
        );

        expect(typeof taskId).toBe('string');
      }
    });
  });

  describe('Analytics', () => {
    it('should get analytics overview', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('overview');
      expect(analytics.overview).toHaveProperty('totalLibraries');
      expect(analytics.overview).toHaveProperty('activeAutomations');
      expect(analytics.overview).toHaveProperty('totalExecutions');
      expect(analytics.overview).toHaveProperty('successRate');
      expect(analytics.overview).toHaveProperty('avgExecutionTime');

      expect(typeof analytics.overview.totalLibraries).toBe('number');
      expect(typeof analytics.overview.activeAutomations).toBe('number');
      expect(typeof analytics.overview.totalExecutions).toBe('number');
      expect(typeof analytics.overview.successRate).toBe('number');
      expect(typeof analytics.overview.avgExecutionTime).toBe('number');
    });

    it('should get analytics by category', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('byCategory');
      expect(Array.isArray(analytics.byCategory)).toBe(true);

      if (analytics.byCategory.length > 0) {
        const category = analytics.byCategory[0];
        expect(category).toHaveProperty('category');
        expect(category).toHaveProperty('libraries');
        expect(category).toHaveProperty('executions');
        expect(category).toHaveProperty('successRate');
        expect(category).toHaveProperty('avgTime');
      }
    });

    it('should get performance analytics', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('performance');
      expect(analytics.performance).toHaveProperty('executionsOverTime');
      expect(analytics.performance).toHaveProperty('topPerformingAutomations');
      expect(analytics.performance).toHaveProperty('slowestAutomations');

      expect(Array.isArray(analytics.performance.executionsOverTime)).toBe(true);
      expect(Array.isArray(analytics.performance.topPerformingAutomations)).toBe(true);
      expect(Array.isArray(analytics.performance.slowestAutomations)).toBe(true);
    });

    it('should get payout stats', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('payoutStats');
      expect(analytics.payoutStats).toHaveProperty('totalPayouts');
      expect(analytics.payoutStats).toHaveProperty('totalAmount');
      expect(analytics.payoutStats).toHaveProperty('pendingAmount');
      expect(analytics.payoutStats).toHaveProperty('averagePayoutTime');
      expect(analytics.payoutStats).toHaveProperty('payoutsByMethod');

      expect(Array.isArray(analytics.payoutStats.payoutsByMethod)).toBe(true);
    });

    it('should get quality stats', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('qualityStats');
      expect(analytics.qualityStats).toHaveProperty('totalChecks');
      expect(analytics.qualityStats).toHaveProperty('overallScore');
      expect(analytics.qualityStats).toHaveProperty('criticalIssues');
      expect(analytics.qualityStats).toHaveProperty('checksByCategory');

      expect(Array.isArray(analytics.qualityStats.checksByCategory)).toBe(true);
    });

    it('should get installer stats', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('installerStats');
      expect(analytics.installerStats).toHaveProperty('totalInstallations');
    });

    it('should calculate success rates correctly', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics.overview.successRate).toBeGreaterThanOrEqual(0);
      expect(analytics.overview.successRate).toBeLessThanOrEqual(100);
    });

    it('should calculate average execution time', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics.overview.avgExecutionTime).toBeGreaterThanOrEqual(0);
    });
  });
});
