import { canonicalizeJson, parseLosslessJson } from '../../../../src/database/transfer/losslessJson';

describe('lossless JSON', () => {
  it('sorts keys and preserves arbitrary precision numeric literals', () => {
    expect(canonicalizeJson('{"z":1.2300,"a":9007199254740993,"nested":{"b":2,"a":1}}')).toBe('{"a":9007199254740993,"nested":{"a":1,"b":2},"z":1.23}');
  });

  it('rejects prototype-shaped keys and U+0000', () => {
    expect(() => parseLosslessJson('{"__proto__":1}')).toThrow();
    expect(() => canonicalizeJson('{"a\\u0000b":"ok"}')).toThrow(/U\+0000/);
  });
});
