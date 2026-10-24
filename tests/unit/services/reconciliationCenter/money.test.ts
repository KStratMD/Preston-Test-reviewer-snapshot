import { currencyExponent, toMinorUnits } from '../../../../src/services/reconciliationCenter/money';

describe('money', () => {
  it('uses 2 decimals for common currencies', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(toMinorUnits(120, 'USD')).toBe(12000);
    expect(toMinorUnits(100.01, 'usd')).toBe(10001); // case-insensitive
  });

  it('uses 0 decimals for zero-decimal currencies (JPY)', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(toMinorUnits(100, 'JPY')).toBe(100);
  });

  it('uses 3 decimals for three-decimal currencies (BHD)', () => {
    expect(currencyExponent('BHD')).toBe(3);
    expect(toMinorUnits(1.5, 'BHD')).toBe(1500);
  });

  it('defaults unlisted currencies to 2 decimals', () => {
    expect(currencyExponent('ZZZ')).toBe(2);
    expect(toMinorUnits(9.99, 'ZZZ')).toBe(999);
  });

  it('avoids floating-point drift via rounding', () => {
    expect(toMinorUnits(0.1 + 0.2, 'USD')).toBe(30); // 0.30000000000000004 → 30
  });
});
