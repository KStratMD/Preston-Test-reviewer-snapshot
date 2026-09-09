import { canonicalize, detectUuidCollisions } from '../../../../src/database/transfer/canonicalize';

describe('canonicalize transfer values', () => {
  it('canonicalizes scalar kinds and preserves null', () => {
    expect(canonicalize(null, 'text')).toEqual({ type: 'null' });
    expect(canonicalize('550E8400-E29B-41D4-A716-446655440000', 'uuid')).toEqual({ type: 'uuid', value: '550e8400-e29b-41d4-a716-446655440000' });
    expect(canonicalize(1, 'boolean')).toEqual({ type: 'boolean', value: true });
    expect(canonicalize('0012', 'integer')).toEqual({ type: 'integer', value: '12' });
    expect(canonicalize('192.168.1.0/24', 'inet')).toEqual({ type: 'inet', value: '192.168.1.0/24' });
    expect(canonicalize('2024-02-29', 'date')).toEqual({ type: 'date', value: '2024-02-29' });
    expect(canonicalize('2024-02-29T12:34:56.12+02:00', 'instant_utc')).toEqual({ type: 'instant_utc', value: '2024-02-29T10:34:56.120000Z' });
    expect(canonicalize('2024-02-29 12:34:56.12', 'naive_timestamp')).toEqual({ type: 'naive_timestamp', value: '2024-02-29T12:34:56.120000' });
    expect(canonicalize('2024-02-29T12:34:56.12Z', 'naive_timestamp', { timestampPolicy: 'utc_z_to_naive' })).toEqual({ type: 'naive_timestamp', value: '2024-02-29T12:34:56.120000' });
    expect(canonicalize('0199-02-28T23:30:00+02:00', 'instant_utc')).toEqual({ type: 'instant_utc', value: '0199-02-28T21:30:00.000000Z' });
    expect(canonicalize('550e8400-e29b-71d4-a716-446655440000', 'uuid')).toEqual({ type: 'uuid', value: '550e8400-e29b-71d4-a716-446655440000' });
    expect(canonicalize('1.2300e+3', 'decimal')).toEqual({ type: 'decimal', value: '1230' });
    expect(canonicalize('1.23e-3', 'decimal')).toEqual({ type: 'decimal', value: '0.00123' });
    expect(canonicalize('["read","write"]', 'text_array')).toEqual({ type: 'text_array', value: '["read","write"]' });
    expect(canonicalize('0.85', 'decimal', { precision: 5, scale: 2 })).toEqual({ type: 'decimal', value: '0.85' });
    expect(canonicalize('0.000123', 'decimal', { precision: 10, scale: 6 })).toEqual({ type: 'decimal', value: '0.000123' });
    expect(canonicalize('-0.75', 'decimal', { precision: 5, scale: 2 })).toEqual({ type: 'decimal', value: '-0.75' });
  });

  it('rejects lossy or unsafe representations', () => {
    expect(() => canonicalize('2023-02-29', 'date')).toThrow();
    expect(() => canonicalize('2024-02-29T12:34:56Z', 'naive_timestamp')).toThrow();
    expect(() => canonicalize(1.234, 'decimal', { scale: 2 })).toThrow(/rounding/);
    expect(() => canonicalize(1.1, 'float32')).toThrow(/Float32/);
    expect(() => canonicalize('bad\u0000text', 'text')).toThrow(/U\+0000/);
    expect(() => canonicalize('["bad\\u0000permission"]', 'text_array')).toThrow(/U\+0000/);
    expect(canonicalize('2026-01-05 10:30:00+00', 'instant_utc')).toEqual({ type: 'instant_utc', value: '2026-01-05T10:30:00.000000Z' });
  });

  it('detects UUID collisions after canonicalization', () => {
    expect(() => detectUuidCollisions([
      { table: 'a', column: 'id', value: '550e8400-e29b-41d4-a716-446655440000' },
      { table: 'b', column: 'id', value: '550E8400-E29B-41D4-A716-446655440000' },
    ])).toThrow(/UUID collision/);
  });
});
