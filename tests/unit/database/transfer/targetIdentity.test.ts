import { parseTargetIdentity, targetFingerprint } from '../../../../src/database/transfer/targetIdentity';

describe('PostgreSQL target identity', () => {
  it('fingerprints only normalized non-secret target coordinates', () => {
    const one = parseTargetIdentity('postgres://user:secret@DB.EXAMPLE:5432/app');
    const two = parseTargetIdentity('postgresql://other:changed@db.example/app');
    expect(one.fingerprint).toBe(two.fingerprint);
    expect(one.fingerprint).toBe(targetFingerprint('postgres://user:secret@db.example:5432/app'));
    expect(JSON.stringify(one)).not.toContain('secret');
  });

  it('rejects ambiguous or session-overridden targets', () => {
    expect(() => parseTargetIdentity('sqlite://user:secret@host/app')).toThrow(/PostgreSQL scheme/);
    expect(() => parseTargetIdentity('postgres://user@host/app')).toThrow(/user.*password/i);
    expect(() => parseTargetIdentity('postgres://user:secret@host/app?options=-c%20search_path%3Dpublic')).toThrow(/session-option/i);
    for (const key of ['search_path', 'currentschema', 'timezone', 'statement_timeout', 'lock_timeout', 'application_name']) {
      expect(() => parseTargetIdentity(`postgres://user:secret@host/app?${key}=blocked`)).toThrow(/session-option/i);
    }
  });
});
