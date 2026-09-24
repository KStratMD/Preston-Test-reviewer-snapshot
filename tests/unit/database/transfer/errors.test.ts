import { TransferError, safeErrorCode } from '../../../../src/database/transfer/errors';

describe('database transfer errors', () => {
  it('serializes only safe phase/code/location metadata', () => {
    const error = new TransferError(
      'import',
      'ROW_DECODE_FAILED',
      { table: 'audit_logs', column: 'payload' },
      new Error('postgres://user:secret@example.test/db row=customer-secret'),
    );

    const serialized = JSON.stringify(error);
    expect(serialized).toContain('ROW_DECODE_FAILED');
    expect(serialized).toContain('audit_logs');
    expect(serialized).toContain('payload');
    expect(serialized).not.toContain('postgres://');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('customer-secret');
  });

  it('normalizes unknown thrown values without exposing their text', () => {
    expect(safeErrorCode(new Error('credentials=secret'))).toBe('ERROR');
    expect(safeErrorCode('credentials=secret')).toBe('NON_ERROR_THROWN');
    expect(safeErrorCode(undefined)).toBe('UNKNOWN');
  });
});
