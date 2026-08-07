import { computeNextRunAt } from '../../../../src/services/reconciliationCenter/cadence';

describe('computeNextRunAt', () => {
  it('advances one whole step when the prior time is exactly due', () => {
    expect(computeNextRunAt('2026-05-29T05:00:00.000Z', '2026-05-29T05:00:00.000Z', 'hourly'))
      .toBe('2026-05-29T06:00:00.000Z');
  });

  it('skips catch-up: a stale schedule lands on the next future boundary, not now + step', () => {
    // prior boundary 00:00, now 05:30, hourly → next future boundary is 06:00
    expect(computeNextRunAt('2026-05-29T00:00:00.000Z', '2026-05-29T05:30:00.000Z', 'hourly'))
      .toBe('2026-05-29T06:00:00.000Z');
  });

  it('handles daily and weekly cadences from the prior scheduled time', () => {
    expect(computeNextRunAt('2026-05-29T00:00:00.000Z', '2026-05-29T12:00:00.000Z', 'daily'))
      .toBe('2026-05-30T00:00:00.000Z');
    expect(computeNextRunAt('2026-05-01T00:00:00.000Z', '2026-05-20T00:00:00.000Z', 'weekly'))
      .toBe('2026-05-22T00:00:00.000Z');
  });

  it('accepts Date inputs (Postgres TIMESTAMP reads may arrive as Date, not string)', () => {
    expect(computeNextRunAt(new Date('2026-05-29T00:00:00.000Z'), new Date('2026-05-29T05:30:00.000Z'), 'hourly'))
      .toBe('2026-05-29T06:00:00.000Z');
  });

  it('throws on an unparseable date', () => {
    expect(() => computeNextRunAt('not-a-date', '2026-05-29T00:00:00.000Z', 'hourly')).toThrow();
  });
});
