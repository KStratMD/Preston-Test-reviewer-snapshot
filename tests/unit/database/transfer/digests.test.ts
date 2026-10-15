import { canonicalize } from '../../../../src/database/transfer/canonicalize';
import { digestCanonicalRow, digestCanonicalTable, digestHex } from '../../../../src/database/transfer/digests';

describe('transfer digests', () => {
  it('frames values and is independent of table row order', () => {
    const a = [canonicalize('a|b', 'text'), canonicalize('c', 'text')];
    const b = [canonicalize('a', 'text'), canonicalize('b|c', 'text')];
    expect(digestHex(digestCanonicalRow(a))).not.toBe(digestHex(digestCanonicalRow(b)));
    const rows = [digestCanonicalRow([canonicalize('a', 'text')]), digestCanonicalRow([canonicalize('b', 'text')])];
    expect(digestHex(digestCanonicalTable(rows))).toBe(digestHex(digestCanonicalTable([...rows].reverse())));
  });
});
