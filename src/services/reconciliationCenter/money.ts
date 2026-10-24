/**
 * ISO-4217 minor-unit (decimal-place) handling for reconciliation amount
 * comparison. Amounts are compared in integer minor units to avoid raw
 * floating-point equality. v1 ships a small exponent map + a 2-decimal default;
 * the strict-extraction handler fails the run on missing/unparseable amounts
 * rather than mis-scaling, so an unlisted exotic currency degrades safely.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'TND', 'IQD', 'JOD', 'LYD']);

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function toMinorUnits(amountMajor: number, currency: string): number {
  return Math.round(amountMajor * 10 ** currencyExponent(currency));
}
