import { hasDbUrlCredentials, pgSslConfig } from '../../../src/utils/dbUrlHelper';

describe('hasDbUrlCredentials', () => {
  it('returns true for URL with user and password', () => {
    expect(hasDbUrlCredentials('postgresql://user:pass@host/db')).toBe(true);
  });

  it('returns false for URL without credentials', () => {
    expect(hasDbUrlCredentials('postgresql://host/db')).toBe(false);
  });

  it('returns false for URL with username but no password', () => {
    expect(hasDbUrlCredentials('postgresql://user@host/db')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasDbUrlCredentials(undefined)).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(hasDbUrlCredentials('not-a-url')).toBe(false);
  });

  it('returns true for URL-encoded credentials', () => {
    expect(hasDbUrlCredentials('postgresql://user:p%40ss@host/db')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(hasDbUrlCredentials('')).toBe(false);
  });
});

describe('pgSslConfig', () => {
  it('returns false for disable in any environment', () => {
    expect(pgSslConfig('disable', 'production')).toBe(false);
    expect(pgSslConfig('disable', 'development')).toBe(false);
  });

  it('returns rejectUnauthorized true for verify-full', () => {
    expect(pgSslConfig('verify-full', 'production')).toEqual({ rejectUnauthorized: true });
    expect(pgSslConfig('verify-full', 'development')).toEqual({ rejectUnauthorized: true });
  });

  it('returns rejectUnauthorized true for verify-ca', () => {
    expect(pgSslConfig('verify-ca', 'production')).toEqual({ rejectUnauthorized: true });
    expect(pgSslConfig('verify-ca', 'development')).toEqual({ rejectUnauthorized: true });
  });

  it('returns rejectUnauthorized false for require in any environment', () => {
    expect(pgSslConfig('require', 'production')).toEqual({ rejectUnauthorized: false });
    expect(pgSslConfig('require', 'development')).toEqual({ rejectUnauthorized: false });
  });

  it('returns false for prefer in development (no forced TLS)', () => {
    expect(pgSslConfig('prefer', 'development')).toBe(false);
  });

  it('returns ssl with cert validation for prefer in production', () => {
    expect(pgSslConfig('prefer', 'production')).toEqual({ rejectUnauthorized: true });
  });

  it('returns false for allow in development', () => {
    expect(pgSslConfig('allow', 'development')).toBe(false);
  });

  it('returns ssl with cert validation for allow in production', () => {
    expect(pgSslConfig('allow', 'production')).toEqual({ rejectUnauthorized: true });
  });
});
