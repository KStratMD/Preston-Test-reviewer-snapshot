/**
 * Comprehensive unit tests for ProactiveIssueDetectionService
 * Covers: startMonitoring, stopMonitoring, performIssueDetectionScan,
 *         getSystemHealthStatus, getActiveIssues, getIssuePredictions,
 *         acknowledgeAlert, resolveIssue
 */
import 'reflect-metadata';
import { ProactiveIssueDetectionService } from '../../../../src/services/ai/ProactiveIssueDetectionService';
import type { MonitoringConfiguration } from '../../../../src/services/ai/ProactiveIssueDetectionService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function buildMonitoringConfig(overrides: Partial<MonitoringConfiguration> = {}): MonitoringConfiguration {
  return {
    enableRealTimeMonitoring: true,
    scanInterval: 5,
    alertThresholds: {
      performance: { responseTime: 500, errorRate: 0.05, throughput: 100 },
      capacity: { cpuUtilization: 80, memoryUtilization: 85, diskUtilization: 90 },
      reliability: { availability: 0.995, successRate: 0.98 },
    },
    issueDetectionRules: [],
    predictionSettings: {
      enablePredictiveAnalysis: true,
      predictionHorizon: '24h',
      confidenceThreshold: 0.8,
      mlModelRefreshInterval: 3600,
    },
    escalationPolicies: [],
    ...overrides,
  };
}

describe('ProactiveIssueDetectionService', () => {
  let service: ProactiveIssueDetectionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProactiveIssueDetectionService(mockLogger);
  });

  afterEach(() => {
    service.stopMonitoring();
  });

  describe('constructor', () => {
    it('should initialize', () => {
      expect(service).toBeDefined();
    });
  });

  describe('performIssueDetectionScan', () => {
    it('should return a complete scan result', async () => {
      const result = await service.performIssueDetectionScan();
      expect(result).toBeDefined();
      expect(result.scanId).toMatch(/^scan_/);
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.scanType).toBe('triggered');
    });

    it('should include detected issues', async () => {
      const result = await service.performIssueDetectionScan();
      expect(Array.isArray(result.detectedIssues)).toBe(true);
      for (const issue of result.detectedIssues) {
        expect(issue.issueId).toBeDefined();
        expect(issue.type).toBeDefined();
        expect(['low', 'medium', 'high', 'critical', 'emergency']).toContain(issue.severity);
        expect(issue.title).toBeDefined();
        expect(issue.description).toBeDefined();
        expect(Array.isArray(issue.affectedSystems)).toBe(true);
        expect(issue.rootCause).toBeDefined();
        expect(issue.businessImpact).toBeDefined();
        expect(typeof issue.confidence).toBe('number');
      }
    });

    it('should include system health', async () => {
      const result = await service.performIssueDetectionScan();
      expect(result.systemHealth).toBeDefined();
      expect(['excellent', 'good', 'fair', 'poor', 'critical']).toContain(result.systemHealth.overallHealth);
      expect(typeof result.systemHealth.healthScore).toBe('number');
      expect(result.systemHealth.healthScore).toBeGreaterThanOrEqual(0);
      expect(result.systemHealth.healthScore).toBeLessThanOrEqual(100);
      expect(Array.isArray(result.systemHealth.componentHealth)).toBe(true);
      expect(Array.isArray(result.systemHealth.healthTrends)).toBe(true);
      expect(result.systemHealth.healthMetrics).toBeDefined();
    });

    it('should include predictions', async () => {
      const result = await service.performIssueDetectionScan();
      expect(Array.isArray(result.predictions)).toBe(true);
      for (const pred of result.predictions) {
        expect(pred.predictionId).toBeDefined();
        expect(typeof pred.probability).toBe('number');
        expect(typeof pred.confidence).toBe('number');
        expect(Array.isArray(pred.earlyWarningSignals)).toBe(true);
        expect(Array.isArray(pred.preventionActions)).toBe(true);
      }
    });

    it('should include recommendations', async () => {
      const result = await service.performIssueDetectionScan();
      expect(Array.isArray(result.recommendations)).toBe(true);
      for (const rec of result.recommendations) {
        expect(rec.recommendationId).toBeDefined();
        expect(['immediate', 'short-term', 'long-term', 'preventive']).toContain(rec.type);
        expect(['low', 'medium', 'high', 'critical']).toContain(rec.priority);
        expect(rec.title).toBeDefined();
        expect(rec.description).toBeDefined();
        expect(Array.isArray(rec.actions)).toBe(true);
      }
    });

    it('should include alerts', async () => {
      const result = await service.performIssueDetectionScan();
      expect(Array.isArray(result.alerts)).toBe(true);
      for (const alert of result.alerts) {
        expect(alert.alertId).toBeDefined();
        expect(['issue-detected', 'issue-predicted', 'system-degradation', 'threshold-breach']).toContain(alert.type);
        expect(['info', 'warning', 'error', 'critical', 'emergency']).toContain(alert.severity);
        expect(alert.title).toBeDefined();
        expect(alert.message).toBeDefined();
        expect(typeof alert.actionRequired).toBe('boolean');
      }
    });

    it('should include metadata', async () => {
      const result = await service.performIssueDetectionScan();
      expect(result.metadata).toBeDefined();
      expect(typeof result.metadata.scanDuration).toBe('number');
      expect(typeof result.metadata.dataPointsAnalyzed).toBe('number');
      expect(typeof result.metadata.rulesApplied).toBe('number');
      expect(Array.isArray(result.metadata.mlModelsUsed)).toBe(true);
      expect(typeof result.metadata.confidence).toBe('number');
      expect(result.metadata.version).toBeDefined();
    });

    it('should accept scan type parameter', async () => {
      const result = await service.performIssueDetectionScan('real-time');
      expect(result.scanType).toBe('real-time');
    });

    it('should accept scheduled scan type', async () => {
      const result = await service.performIssueDetectionScan('scheduled');
      expect(result.scanType).toBe('scheduled');
    });

    it('should log scan completion', async () => {
      await service.performIssueDetectionScan();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Issue detection scan completed',
        expect.objectContaining({
          issuesDetected: expect.any(Number),
          predictionsGenerated: expect.any(Number),
          alertsGenerated: expect.any(Number),
        })
      );
    });
  });

  describe('getSystemHealthStatus', () => {
    it('should return system health', async () => {
      const health = await service.getSystemHealthStatus();
      expect(health).toBeDefined();
      expect(['excellent', 'good', 'fair', 'poor', 'critical']).toContain(health.overallHealth);
      expect(typeof health.healthScore).toBe('number');
      expect(health.healthMetrics).toBeDefined();
      expect(typeof health.healthMetrics.availability).toBe('number');
      expect(typeof health.healthMetrics.performance).toBe('number');
      expect(typeof health.healthMetrics.reliability).toBe('number');
      expect(typeof health.healthMetrics.capacity).toBe('number');
      expect(typeof health.healthMetrics.security).toBe('number');
      expect(typeof health.healthMetrics.dataQuality).toBe('number');
    });

    it('should include component health', async () => {
      const health = await service.getSystemHealthStatus();
      expect(Array.isArray(health.componentHealth)).toBe(true);
      for (const comp of health.componentHealth) {
        expect(comp.component).toBeDefined();
        expect(['excellent', 'good', 'fair', 'poor', 'critical']).toContain(comp.health);
        expect(typeof comp.score).toBe('number');
        expect(Array.isArray(comp.issues)).toBe(true);
        expect(Array.isArray(comp.dependencies)).toBe(true);
      }
    });
  });

  describe('getActiveIssues', () => {
    it('should return empty initially', () => {
      const issues = service.getActiveIssues();
      expect(Array.isArray(issues)).toBe(true);
      expect(issues.length).toBe(0);
    });

    it('should return issues after scan', async () => {
      await service.performIssueDetectionScan();
      const issues = service.getActiveIssues();
      expect(Array.isArray(issues)).toBe(true);
      // After a scan, issues should be populated
      expect(issues.length).toBeGreaterThan(0);
    });

    it('should exclude resolved issues', async () => {
      await service.performIssueDetectionScan();
      const issuesBefore = service.getActiveIssues();
      if (issuesBefore.length > 0) {
        await service.resolveIssue(issuesBefore[0].issueId, 'admin', 'fixed');
        const issuesAfter = service.getActiveIssues();
        expect(issuesAfter.length).toBe(issuesBefore.length - 1);
      }
    });
  });

  describe('getIssuePredictions', () => {
    it('should return empty initially', () => {
      const preds = service.getIssuePredictions();
      expect(Array.isArray(preds)).toBe(true);
      expect(preds.length).toBe(0);
    });

    it('should return predictions after scan', async () => {
      await service.performIssueDetectionScan();
      const preds = service.getIssuePredictions();
      expect(Array.isArray(preds)).toBe(true);
    });
  });

  describe('acknowledgeAlert', () => {
    it('should log acknowledgement', async () => {
      await service.acknowledgeAlert('alert-123', 'admin');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Alert acknowledged',
        { alertId: 'alert-123', acknowledgedBy: 'admin' }
      );
    });
  });

  describe('resolveIssue', () => {
    it('should mark issue as resolved', async () => {
      await service.performIssueDetectionScan();
      const issues = service.getActiveIssues();
      if (issues.length > 0) {
        const issueId = issues[0].issueId;
        await service.resolveIssue(issueId, 'admin', 'Applied hotfix');
        expect(mockLogger.info).toHaveBeenCalledWith(
          'Issue resolved',
          { issueId, resolvedBy: 'admin', resolution: 'Applied hotfix' }
        );
      }
    });

    it('should handle resolving nonexistent issue gracefully', async () => {
      await service.resolveIssue('nonexistent', 'admin', 'n/a');
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('startMonitoring / stopMonitoring', () => {
    it('should start monitoring', async () => {
      const config = buildMonitoringConfig({ scanInterval: 999 });
      await service.startMonitoring(config);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting proactive issue detection monitoring',
        expect.objectContaining({ scanInterval: 999 })
      );
    });

    it('should warn if already monitoring', async () => {
      const config = buildMonitoringConfig();
      await service.startMonitoring(config);
      await service.startMonitoring(config);
      expect(mockLogger.warn).toHaveBeenCalledWith('Monitoring already active');
    });

    it('should stop monitoring', async () => {
      const config = buildMonitoringConfig();
      await service.startMonitoring(config);
      service.stopMonitoring();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Stopping proactive issue detection monitoring'
      );
    });

    it('should not log when stopping if not active', () => {
      service.stopMonitoring();
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'Stopping proactive issue detection monitoring'
      );
    });
  });
});
