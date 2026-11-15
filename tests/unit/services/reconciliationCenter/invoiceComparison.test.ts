import { compareInvoices } from '../../../../src/services/reconciliationCenter/invoiceComparison';
import type { NormalizedInvoice } from '../../../../src/services/reconciliationCenter/invoiceComparison';

const inv = (key: string, major: number, minor: number, currency = 'USD'): NormalizedInvoice =>
  ({ key, amountMajor: major, amountMinorUnits: minor, currency });

const OPTS = { sourceSystem: 'netsuite', targetSystem: 'business_central', toleranceMinorUnits: 0 };

describe('compareInvoices', () => {
  it('emits no discrepancy when matched invoices agree', () => {
    const out = compareInvoices([inv('INV-1', 100, 10000)], [inv('INV-1', 100, 10000)], OPTS);
    expect(out).toEqual([]);
  });

  it('flags missing_in_target for a source-only invoice', () => {
    const out = compareInvoices([inv('INV-1', 100, 10000)], [], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      exceptionType: 'missing_in_target',
      severity: 'high',
      sourceRecordId: 'INV-1',
      sourceSystem: 'netsuite',
      targetSystem: 'business_central',
      amountDelta: null,
      currency: 'USD',
    });
  });

  it('flags missing_in_source for a target-only invoice', () => {
    const out = compareInvoices([], [inv('INV-2', 50, 5000)], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exceptionType: 'missing_in_source', sourceRecordId: 'INV-2' });
  });

  it('does not flag amounts within tolerance', () => {
    const out = compareInvoices([inv('INV-1', 100.0, 10000)], [inv('INV-1', 100.02, 10002)],
      { ...OPTS, toleranceMinorUnits: 5 });
    expect(out).toEqual([]);
  });

  it('does not flag an amount at exactly the tolerance boundary (> not >=)', () => {
    const out = compareInvoices([inv('INV-1', 100.05, 10005)], [inv('INV-1', 100.0, 10000)],
      { ...OPTS, toleranceMinorUnits: 5 });
    expect(out).toEqual([]);
  });

  it('flags amount_mismatch beyond tolerance with a major-unit delta', () => {
    const out = compareInvoices([inv('INV-1', 120, 12000)], [inv('INV-1', 100, 10000)], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exceptionType: 'amount_mismatch', severity: 'medium', sourceRecordId: 'INV-1', amountDelta: 20, currency: 'USD' });
  });

  it('flags amount_mismatch on currency divergence with null delta', () => {
    const out = compareInvoices([inv('INV-1', 100, 10000, 'USD')], [inv('INV-1', 100, 10000, 'EUR')], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exceptionType: 'amount_mismatch', amountDelta: null, severity: 'high' });
    expect(out[0].description).toMatch(/currency/i);
  });

  it('surfaces a duplicate source key as duplicate_key and excludes it from amount matching', () => {
    // Two source invoices share key INV-1 (one would otherwise be silently
    // dropped by a key→invoice map). The matching target invoice must NOT be
    // compared/flagged as a mismatch — the key is ambiguous.
    const out = compareInvoices(
      [inv('INV-1', 120, 12000), inv('INV-1', 100, 10000)],
      [inv('INV-1', 100, 10000)],
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exceptionType: 'duplicate_key', sourceRecordId: 'INV-1', severity: 'high', amountDelta: null, currency: null });
    expect(out[0].description).toMatch(/duplicated/i);
  });

  it('emits duplicate_key first, before unrelated match findings', () => {
    const out = compareInvoices(
      [inv('DUP', 10, 1000), inv('DUP', 10, 1000), inv('A', 50, 5000)],
      [inv('A', 60, 6000)], // A is a real amount mismatch
      OPTS,
    );
    expect(out.map((d) => d.exceptionType)).toEqual(['duplicate_key', 'amount_mismatch']);
    expect(out[0].sourceRecordId).toBe('DUP');
    expect(out[1].sourceRecordId).toBe('A');
  });

  it('detects a duplicate key on the target side too', () => {
    const out = compareInvoices(
      [inv('INV-1', 100, 10000)],
      [inv('INV-1', 100, 10000), inv('INV-1', 100, 10000)],
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exceptionType: 'duplicate_key', sourceRecordId: 'INV-1' });
  });

  it('reports both sides when a key is duplicated in source AND target', () => {
    const out = compareInvoices(
      [inv('INV-1', 100, 10000), inv('INV-1', 100, 10000)],
      [inv('INV-1', 100, 10000), inv('INV-1', 100, 10000)],
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exceptionType: 'duplicate_key', sourceRecordId: 'INV-1' });
    expect(out[0].description).toMatch(/netsuite.*business_central/i);
  });
});
