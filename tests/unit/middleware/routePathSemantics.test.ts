import {
  normalizeRoutePath,
  routePathMatches,
  type RouteMatchMode,
} from '../../../src/middleware/setup/routePathSemantics';

describe('route path semantics', () => {
  it('normalizes leading, repeated, trailing, and case differences', () => {
    expect(normalizeRoutePath('API//Settings/')).toBe('/api/settings');
    expect(normalizeRoutePath('settings')).toBe('/settings');
    expect(normalizeRoutePath('/')).toBe('/');
  });

  it('matches prefixes only at a path-component boundary', () => {
    expect(routePathMatches('/API/settings/users', '/api/settings', 'prefix')).toBe(true);
    expect(routePathMatches('/api/settings-extra', '/api/settings', 'prefix')).toBe(false);
    expect(routePathMatches('/api/settings', '/api/settings', 'prefix')).toBe(true);
  });

  it('keeps exact entries from classifying descendants', () => {
    const mode: RouteMatchMode = 'exact';
    expect(routePathMatches('/api/health/demo', '/api/health/demo', mode)).toBe(true);
    expect(routePathMatches('/api/health/demo/details', '/api/health/demo', mode)).toBe(false);
  });

  it('rejects invalid empty paths', () => {
    expect(() => normalizeRoutePath('   ')).toThrow(/path/i);
  });
});
