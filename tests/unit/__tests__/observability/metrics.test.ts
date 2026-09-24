import { Metered } from '../../observability/metrics';

// Stub timer for deterministic duration
const createStubTimer = (ms: number) => ({ end: () => ms });

describe('Metered decorator', () => {
  class TestClass {
    // Injected by test
    public metricsService: { createTimer: () => { end: () => number }; recordCustomMetric: jest.Mock };

    constructor(ms: any) {
      this.metricsService = ms;
    }

    @Metered('test_operation')
    async ok(): Promise<number> {
      return 7;
    }

    @Metered('test_operation_fail')
    async boom(): Promise<void> {
      throw new Error('boom');
    }
  }

  it('records duration and counter on success', async () => {
    const recordCustomMetric = jest.fn();
    const obj = new TestClass({ createTimer: () => createStubTimer(42), recordCustomMetric });

    const out = await obj.ok();
    expect(out).toBe(7);

    // duration histogram
    expect(recordCustomMetric).toHaveBeenCalledWith(
      'test_operation_duration_ms',
      expect.any(Number),
      expect.objectContaining({ method: 'ok', status: 'success' }),
      'histogram',
    );
    // calls counter
    expect(recordCustomMetric).toHaveBeenCalledWith(
      'test_operation_calls_total',
      1,
      expect.objectContaining({ method: 'ok', status: 'success' }),
      'counter',
    );
  });

  it('records duration and counter on failure and rethrows', async () => {
    const recordCustomMetric = jest.fn();
    const obj = new TestClass({ createTimer: () => createStubTimer(21), recordCustomMetric });

    await expect(obj.boom()).rejects.toThrow('boom');

    expect(recordCustomMetric).toHaveBeenCalledWith(
      'test_operation_fail_duration_ms',
      expect.any(Number),
      expect.objectContaining({ method: 'boom', status: 'failure' }),
      'histogram',
    );
    expect(recordCustomMetric).toHaveBeenCalledWith(
      'test_operation_fail_calls_total',
      1,
      expect.objectContaining({ method: 'boom', status: 'failure' }),
      'counter',
    );
  });
});

describe('MetricsService custom metrics', () => {
  it('no-ops when custom metrics disabled', () => {
    const counters: any[] = [];
    const histograms: any[] = [];
    const updowns: any[] = [];

    jest.isolateModules(() => {
      jest.doMock('@opentelemetry/api', () => ({
        metrics: {
          getMeter: () => ({
            createCounter: (name: string) => ({
              add: (v: number, labels?: any) => counters.push({ name, v, labels }),
            }),
            createHistogram: (name: string) => ({
              record: (v: number, labels?: any) => histograms.push({ name, v, labels }),
            }),
            createUpDownCounter: (name: string) => ({
              add: (v: number, labels?: any) => updowns.push({ name, v, labels }),
            }),
          }),
        },
      }));
      const { MetricsService } = require('../../observability/metrics');
      const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), child: jest.fn().mockReturnThis() } as any;
      const svc = new MetricsService({ serviceName: 'svc', enableCustomMetrics: false }, logger);
      svc.recordCustomMetric('x', 1, {}, 'counter');
    });

    const totalAdds = counters.filter(c => c.name.includes('_custom_')).length +
      histograms.filter(h => h.name.includes('_custom_')).length +
      updowns.filter(g => g.name.includes('_custom_')).length;
    expect(totalAdds).toBe(0);
  });

  it('records counter, gauge and histogram when enabled', () => {
    const counters: any[] = [];
    const histograms: any[] = [];
    const updowns: any[] = [];

    jest.isolateModules(() => {
      jest.doMock('@opentelemetry/api', () => ({
        metrics: {
          getMeter: () => ({
            createCounter: (name: string) => ({
              add: (v: number, labels?: any) => counters.push({ name, v, labels }),
            }),
            createHistogram: (name: string) => ({
              record: (v: number, labels?: any) => histograms.push({ name, v, labels }),
            }),
            createUpDownCounter: (name: string) => ({
              add: (v: number, labels?: any) => updowns.push({ name, v, labels }),
            }),
          }),
        },
      }));
      const { MetricsService } = require('../../observability/metrics');
      const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), child: jest.fn().mockReturnThis() } as any;
      const svc = new MetricsService({ serviceName: 'svc', enableCustomMetrics: true, metricsPrefix: 'test' }, logger);
      svc.recordCustomMetric('alpha', 3, { a: '1' }, 'counter');
      svc.recordCustomMetric('beta', -2, { b: '2' }, 'gauge');
      svc.recordCustomMetric('gamma', 7, { c: '3' }, 'histogram');
    });

    const isCounter = (c: any) => c.name === 'test_custom_alpha' && c.v === 3;
    const isGauge = (g: any) => g.name === 'test_custom_beta' && g.v === -2;
    const isHist = (h: any) => h.name === 'test_custom_gamma' && h.v === 7;
    expect(counters.some(isCounter)).toBe(true);
    expect(updowns.some(isGauge)).toBe(true);
    expect(histograms.some(isHist)).toBe(true);
  });
});
