import { hasUnsafeHttpPath } from '../../../../src/services/suitecentral/controlPlane/httpPathSafety';

describe('hasUnsafeHttpPath', () => {
  it.each([
    '/../admin',
    '/v1/../../secret',
    '/a\\b',
    '/%2e%2e/admin',
    '/a%2fb',
    '/a%5cb',
    '/%252e%252e/admin',
    '/%25%32%65/x',
    '/%zz',
  ])('flags unsafe path %s', (path) => {
    expect(hasUnsafeHttpPath(path)).toBe(true);
  });

  it.each([
    '',
    '/',
    '/v1/hooks/receive',
    '/v1/hooks/receive/',
    '/customers/123',
    '/a.b/c-d_e',
  ])('accepts safe path %s', (path) => {
    expect(hasUnsafeHttpPath(path)).toBe(false);
  });
});
