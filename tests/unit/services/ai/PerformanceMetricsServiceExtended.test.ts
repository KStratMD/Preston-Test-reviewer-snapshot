/**
 * Comprehensive tests for PerformanceMetricsService
 * Covers: analyzePerformance with all metric types and defaults
 */

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../../src/utils/Logger', () => ({
  logger: mockLogger,
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { PerformanceMetricsService } from '../../../../src/services/ai/orchestrator/agents/optimization/PerformanceMetricsService';

describe('PerformanceMetricsService', () => {
  let service: PerformanceMetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (PerformanceMetricsService as any)(mockLogger);
  });

  const makeMetric = (overrides: Record<string, any> = {}) => ({
    name: 'Test Metric',
    currentValue: 50,
    targetValue: 100,
    unit: 'units',
    trend: 'stable' as const,
    ...overrides,
  });

  describe('analyzePerformance', () => {
    it('should return full performance analysis structure', async () => {
      const metrics = [makeMetric()];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.throughput).toBeDefined();
      expect(result.utilization).toBeDefined();
      expect(result.efficiency).toBeDefined();
      expect(result.waitTime).toBeDefined();
      expect(result.processingTime).toBeDefined();
      expect(result.setupTime).toBeDefined();
      expect(result.metrics).toBeDefined();
    });

    it('should use throughput metric when available', async () => {
      const metrics = [makeMetric({ name: 'System Throughput', currentValue: 200 })];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.throughput).toBe(200);
    });

    it('should default throughput to 50 when no throughput metric', async () => {
      const metrics = [makeMetric({ name: 'Other Metric' })];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.throughput).toBe(50);
    });

    it('should use utilization metric when available', async () => {
      const metrics = [makeMetric({ name: 'Resource Utilization', currentValue: 85 })];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.utilization).toBeCloseTo(0.85, 2);
    });

    it('should default utilization to 0.75', async () => {
      const metrics = [makeMetric({ name: 'Other' })];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.utilization).toBe(0.75);
    });

    it('should use efficiency metric when available', async () => {
      const metrics = [makeMetric({ name: 'Process Efficiency', currentValue: 92 })];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.efficiency).toBeCloseTo(0.92, 2);
    });

    it('should default efficiency to 0.8', async () => {
      const result = await service.analyzePerformance([makeMetric({ name: 'Other' })] as any[]);
      expect(result.efficiency).toBe(0.8);
    });

    it('should use wait time metric when available', async () => {
      const metrics = [makeMetric({ name: 'Average Wait Time', currentValue: 15 })];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.waitTime).toBe(15);
    });

    it('should default wait time to 5', async () => {
      const result = await service.analyzePerformance([makeMetric({ name: 'Other' })] as any[]);
      expect(result.waitTime).toBe(5);
    });

    it('should use processing time metric when available', async () => {
      const metrics = [makeMetric({ name: 'Data Processing Time', currentValue: 45 })];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.processingTime).toBe(45);
    });

    it('should default processing time to 30', async () => {
      const result = await service.analyzePerformance([makeMetric({ name: 'Other' })] as any[]);
      expect(result.processingTime).toBe(30);
    });

    it('should use setup time metric when available', async () => {
      const metrics = [makeMetric({ name: 'Setup Duration', currentValue: 20 })];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.setupTime).toBe(20);
    });

    it('should default setup time to 10', async () => {
      const result = await service.analyzePerformance([makeMetric({ name: 'Other' })] as any[]);
      expect(result.setupTime).toBe(10);
    });

    it('should map metrics to ProcessMetric format', async () => {
      const metrics = [
        makeMetric({ name: 'Metric A', currentValue: 75, targetValue: 100, unit: 'ops', trend: 'improving' }),
      ];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.metrics.length).toBe(1);
      expect(result.metrics[0].name).toBe('Metric A');
      expect(result.metrics[0].current).toBe(75);
      expect(result.metrics[0].target).toBe(100);
      expect(result.metrics[0].unit).toBe('ops');
      expect(result.metrics[0].trend).toBe('improving');
      expect(result.metrics[0].variance).toBeCloseTo(0.25, 2);
    });

    it('should calculate variance correctly', async () => {
      const metrics = [makeMetric({ currentValue: 80, targetValue: 100 })];
      const result = await service.analyzePerformance(metrics as any[]);
      // |80 - 100| / 100 = 0.2
      expect(result.metrics[0].variance).toBeCloseTo(0.2, 2);
    });

    it('should handle multiple metrics', async () => {
      const metrics = [
        makeMetric({ name: 'Throughput', currentValue: 100 }),
        makeMetric({ name: 'Utilization', currentValue: 90 }),
        makeMetric({ name: 'Wait Time', currentValue: 3 }),
      ];
      const result = await service.analyzePerformance(metrics as any[]);
      expect(result.metrics.length).toBe(3);
      expect(result.throughput).toBe(100);
      expect(result.utilization).toBeCloseTo(0.9, 2);
      expect(result.waitTime).toBe(3);
    });

    it('should handle empty metrics array', async () => {
      const result = await service.analyzePerformance([]);
      expect(result.metrics).toEqual([]);
      expect(result.throughput).toBe(50); // default
      expect(result.utilization).toBe(0.75); // default
    });

    it('should log start and completion', async () => {
      await service.analyzePerformance([makeMetric()] as any[]);
      expect(mockLogger.info).toHaveBeenCalledWith('Analyzing performance metrics', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Performance analysis completed', expect.any(Object));
    });
  });
});
