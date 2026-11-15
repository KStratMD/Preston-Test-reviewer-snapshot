import {
  CpuUsageDeltaCalculator,
  type ProcessResourceSnapshot,
} from '../../../src/performance/ProcessResourceSampler';

function snapshot(
  monotonicNs: bigint,
  user: number,
  system: number,
): ProcessResourceSnapshot {
  return {
    monotonicNs,
    cpu: { user, system },
    memory: {
      heapUsed: 100,
      heapTotal: 200,
      external: 300,
      rss: 400,
      arrayBuffers: 0,
    },
    uptimeSeconds: Number(monotonicNs) / 1_000_000_000,
  };
}

describe('CpuUsageDeltaCalculator', () => {
  it('returns unavailable for the first sample, then calculates delta CPU percentage', () => {
    const calculator = new CpuUsageDeltaCalculator();

    expect(calculator.calculate(snapshot(1_000_000_000n, 100_000, 50_000))).toBeUndefined();
    expect(calculator.calculate(snapshot(2_000_000_000n, 300_000, 150_000))).toBe(30);
  });

  it('returns unavailable for zero or negative elapsed time and warms up from the latest sample', () => {
    const calculator = new CpuUsageDeltaCalculator();

    calculator.calculate(snapshot(2_000_000_000n, 100_000, 50_000));
    expect(calculator.calculate(snapshot(2_000_000_000n, 200_000, 100_000))).toBeUndefined();
    expect(calculator.calculate(snapshot(1_000_000_000n, 300_000, 150_000))).toBeUndefined();
    expect(calculator.calculate(snapshot(2_000_000_000n, 500_000, 250_000))).toBe(30);
  });

  it('resets warm-up after CPU counter regression', () => {
    const calculator = new CpuUsageDeltaCalculator();

    calculator.calculate(snapshot(1_000_000_000n, 300_000, 150_000));
    expect(calculator.calculate(snapshot(2_000_000_000n, 200_000, 100_000))).toBeUndefined();
    expect(calculator.calculate(snapshot(3_000_000_000n, 400_000, 200_000))).toBe(30);
  });

  it('bounds CPU percentage to the monitor contract', () => {
    const calculator = new CpuUsageDeltaCalculator();

    calculator.calculate(snapshot(1_000_000_000n, 0, 0));
    expect(calculator.calculate(snapshot(2_000_000_000n, 2_000_000, 0))).toBe(100);
  });
});
