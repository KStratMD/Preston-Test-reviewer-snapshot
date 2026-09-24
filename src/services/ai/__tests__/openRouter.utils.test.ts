import { isOfficialOpenRouterBaseUrl, normalizeOpenRouterBaseUrl, normalizePositiveInteger } from '../utils/openRouter';

describe('openRouter utils', () => {
  it('normalizes bare OpenRouter host to the canonical api base', () => {
    expect(normalizeOpenRouterBaseUrl('https://openrouter.ai')).toBe('https://openrouter.ai/api/v1');
  });

  it('adds an https scheme for scheme-less OpenRouter hosts', () => {
    expect(normalizeOpenRouterBaseUrl('openrouter.ai')).toBe('https://openrouter.ai/api/v1');
  });

  it('normalizes bare proxy hosts to a v1 api base', () => {
    expect(normalizeOpenRouterBaseUrl('http://localhost:8000')).toBe('http://localhost:8000/v1');
  });

  it('adds an http scheme for scheme-less localhost proxies', () => {
    expect(normalizeOpenRouterBaseUrl('localhost:8000')).toBe('http://localhost:8000/v1');
  });

  it('preserves explicit OpenRouter api paths', () => {
    expect(normalizeOpenRouterBaseUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
  });

  it('normalizes official OpenRouter v1 paths to the canonical api path', () => {
    expect(normalizeOpenRouterBaseUrl('https://api.openrouter.ai/v1')).toBe('https://api.openrouter.ai/api/v1');
  });

  it('uses strict host matching for official OpenRouter detection', () => {
    expect(isOfficialOpenRouterBaseUrl('https://openrouter.ai')).toBe(true);
    expect(isOfficialOpenRouterBaseUrl('https://api.openrouter.ai/v1')).toBe(true);
    expect(isOfficialOpenRouterBaseUrl('https://openrouter.ai-proxy.internal/v1')).toBe(false);
  });

  it('normalizes positive integers and falls back for invalid values', () => {
    expect(normalizePositiveInteger(45000, 30000)).toBe(45000);
    expect(normalizePositiveInteger('123', 30000)).toBe(123);
    expect(normalizePositiveInteger(0, 30000)).toBe(30000);
    expect(normalizePositiveInteger('invalid', 30000)).toBe(30000);
  });
});
