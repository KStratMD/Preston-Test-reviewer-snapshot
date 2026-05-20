import { getAIProxyRedirectUrl } from '../../../src/middleware/setup/RouteSetup';

describe('getAIProxyRedirectUrl', () => {
  it.each([
    ['/api/ai/provider?foo=bar', '/api/ai/proxy/provider-config?foo=bar'],
    ['/api/ai/secure/status', '/api/ai/proxy/status'],
    ['/api/ai/secure/mapping/suggestions', '/api/ai/proxy/mapping/suggestions'],
    ['/api/ai/secure/quality/analyze', '/api/ai/proxy/data-quality/analyze'],
    ['/api/ai/secure/providers/health', '/api/ai/proxy/status'],
    ['/api/ai/field-mapping/generate', '/api/ai/proxy/field-mapping/generate'],
    ['/api/ai/quality/assess', '/api/ai/proxy/quality/assess'],
  ])('rewrites %s to %s', (legacyUrl, expectedUrl) => {
    expect(getAIProxyRedirectUrl(legacyUrl)).toBe(expectedUrl);
  });
});
