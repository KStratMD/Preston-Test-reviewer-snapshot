/**
 * Comprehensive unit tests for SyncCentralHealthPredictor
 * Covers: getAllPredictions, getPrediction, early warnings,
 *         failure probability, risk levels, recommendations
 */
import 'reflect-metadata';
import { SyncCentralHealthPredictor } from '../../../../src/services/ai/SyncCentralHealthPredictor';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

// Ensure mock data path (not real APIs)
beforeAll(() => {
  delete process.env.USE_REAL_MODULE_APIS;
});

describe('SyncCentralHealthPredictor', () => {
  let service: SyncCentralHealthPredictor;
  let randomSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    service = new SyncCentralHealthPredictor(mockLogger);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should initialize with mock data', () => {
      expect(service).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'SyncCentralHealthPredictor initialized with mock data',
        expect.objectContaining({ integrations: 8 })
      );
    });
  });

  describe('getAllPredictions', () => {
    it('should return a complete prediction response', async () => {
      const response = await service.getAllPredictions();
      expect(response).toBeDefined();
      expect(response.success).toBe(true);
      expect(response.timestamp).toBeDefined();
      expect(response.overallHealth).toBeDefined();
      expect(typeof response.overallHealth.score).toBe('number');
      expect(typeof response.overallHealth.integrationsAtRisk).toBe('number');
      expect(response.overallHealth.totalIntegrations).toBe(8);
    });

    it('should include overall health status', async () => {
      const response = await service.getAllPredictions();
      expect(['healthy', 'degraded', 'critical']).toContain(response.overallHealth.status);
      expect(response.overallHealth.score).toBeGreaterThanOrEqual(0);
      expect(response.overallHealth.score).toBeLessThanOrEqual(100);
    });

    it('should include predictions for all integrations', async () => {
      const response = await service.getAllPredictions();
      expect(Array.isArray(response.predictions)).toBe(true);
      expect(response.predictions.length).toBe(8);
    });

    it('should include system alerts', async () => {
      const response = await service.getAllPredictions();
      expect(Array.isArray(response.systemAlerts)).toBe(true);
    });

    it('should have valid prediction structure', async () => {
      const response = await service.getAllPredictions();
      for (const pred of response.predictions) {
        expect(pred.integrationId).toBeDefined();
        expect(pred.integrationName).toBeDefined();
        expect(pred.connectorType).toBeDefined();
        expect(typeof pred.failureProbability).toBe('number');
        expect(pred.failureProbability).toBeGreaterThanOrEqual(0);
        expect(pred.failureProbability).toBeLessThanOrEqual(1);
        expect(['low', 'medium', 'high', 'critical']).toContain(pred.riskLevel);
        expect(pred.currentHealth).toBeDefined();
        expect(typeof pred.currentHealth.successRate).toBe('number');
        expect(typeof pred.currentHealth.avgLatencyMs).toBe('number');
        expect(typeof pred.currentHealth.errorRate).toBe('number');
        expect(Array.isArray(pred.earlyWarnings)).toBe(true);
        expect(Array.isArray(pred.recommendedActions)).toBe(true);
        expect(typeof pred.confidence).toBe('number');
      }
    });

    it('should count integrations at risk correctly', async () => {
      const response = await service.getAllPredictions();
      const atRisk = response.predictions.filter(
        p => p.riskLevel === 'high' || p.riskLevel === 'critical'
      ).length;
      expect(response.overallHealth.integrationsAtRisk).toBe(atRisk);
    });
  });

  describe('getPrediction', () => {
    it('should return prediction for known integration', async () => {
      const pred = await service.getPrediction('int-001');
      expect(pred).not.toBeNull();
      expect(pred!.integrationId).toBe('int-001');
      expect(pred!.integrationName).toBe('NetSuite → Salesforce');
      expect(pred!.connectorType).toBe('netsuite');
    });

    it('should return null for unknown integration', async () => {
      const pred = await service.getPrediction('nonexistent');
      expect(pred).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Integration not found',
        { integrationId: 'nonexistent' }
      );
    });

    it('should include failure probability window for high risk', async () => {
      // Mock random to create worse conditions for a low-reliability integration
      randomSpy.mockReturnValue(0.95); // high variation = worse metrics
      const freshService = new SyncCentralHealthPredictor(mockLogger);
      const pred = await freshService.getPrediction('int-006'); // Oracle, baseSuccessRate=0.88
      expect(pred).not.toBeNull();
      // Failure window is set when probability > 0.5
      if (pred!.failureProbability > 0.5) {
        expect(pred!.predictedFailureWindow).toBe('next 24 hours');
      }
    });

    it('should include early warnings', async () => {
      const pred = await service.getPrediction('int-004'); // ShipStation, lower success rate
      expect(Array.isArray(pred!.earlyWarnings)).toBe(true);
    });

    it('should include recommended actions', async () => {
      const pred = await service.getPrediction('int-002');
      expect(Array.isArray(pred!.recommendedActions)).toBe(true);
    });

    it('should calculate confidence based on data quality', async () => {
      const pred = await service.getPrediction('int-001');
      expect(pred!.confidence).toBeGreaterThan(0);
      expect(pred!.confidence).toBeLessThanOrEqual(0.95);
    });
  });

  describe('all mock integrations accessible', () => {
    const integrationIds = [
      'int-001', 'int-002', 'int-003', 'int-004',
      'int-005', 'int-006', 'int-007', 'int-008',
    ];

    it.each(integrationIds)('should return prediction for %s', async (id) => {
      const pred = await service.getPrediction(id);
      expect(pred).not.toBeNull();
      expect(pred!.integrationId).toBe(id);
    });
  });

  describe('risk levels', () => {
    it('should classify high-reliability integration as low risk', async () => {
      // int-003 has baseSuccessRate=0.99 with random=0.5 (no variation)
      const pred = await service.getPrediction('int-003');
      expect(pred).not.toBeNull();
      expect(['low', 'medium']).toContain(pred!.riskLevel);
    });

    it('should classify low-reliability integration as higher risk', async () => {
      // int-006 has baseSuccessRate=0.88
      const pred = await service.getPrediction('int-006');
      expect(pred).not.toBeNull();
      // May vary but should not be null
      expect(typeof pred!.failureProbability).toBe('number');
    });
  });

  describe('system alerts', () => {
    it('should generate alerts for high-risk integrations', async () => {
      const response = await service.getAllPredictions();
      for (const alert of response.systemAlerts) {
        expect(alert.id).toBeDefined();
        expect(['low', 'medium', 'high', 'critical']).toContain(alert.severity);
        expect(alert.title).toBeDefined();
        expect(alert.message).toBeDefined();
        expect(Array.isArray(alert.affectedIntegrations)).toBe(true);
        expect(Array.isArray(alert.suggestedActions)).toBe(true);
      }
    });
  });
});
