import 'reflect-metadata';
jest.unmock('../../../src/services/TelemetryService');
import { TelemetryService } from '../../../src/services/TelemetryService';

describe('TelemetryService lightweight metrics API', () => {
  const createService = (): TelemetryService => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as any;

    const telemetryStore = {
      getStorageStats: jest.fn(() => ({ totalEvents: 0 })),
      clearOldEvents: jest.fn(async () => 0),
    } as any;

    const telemetryAggregator = {} as any;

    return new TelemetryService(logger, telemetryStore, telemetryAggregator);
  };

  it('records and returns lightweight metrics', () => {
    const service = createService();

    service.recordMetric('metrics_collected', 1, { responseTime: 100 });

    const metrics = service.getMetrics('metrics_collected');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toEqual(
      expect.objectContaining({
        value: 1,
        metadata: { responseTime: 100 },
        timestamp: expect.any(Date),
      }),
    );

    service.shutdown();
  });

  it('returns all lightweight metrics grouped by name', () => {
    const service = createService();

    service.recordMetric('metrics_collected', 1);
    service.recordMetric('monitoring_started', 'ok');

    expect(service.getAllMetrics()).toEqual({
      metrics_collected: [
        expect.objectContaining({
          value: 1,
          timestamp: expect.any(Date),
        }),
      ],
      monitoring_started: [
        expect.objectContaining({
          value: 'ok',
          timestamp: expect.any(Date),
        }),
      ],
    });

    service.shutdown();
  });

  it('clears lightweight metrics on demand and shutdown', () => {
    const service = createService();

    service.recordMetric('metrics_collected', 1);
    service.clearMetrics();
    expect(service.getMetrics('metrics_collected')).toEqual([]);

    service.recordMetric('monitoring_started', 1);
    service.shutdown();
    expect(service.getMetrics('monitoring_started')).toEqual([]);
  });
});
