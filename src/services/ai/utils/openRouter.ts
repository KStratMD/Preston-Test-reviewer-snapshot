const OPENROUTER_HOST_PATTERN = /(^|\.)openrouter\.ai$/i;
const ABSOLUTE_URL_SCHEME_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
const LOCAL_BASE_URL_PATTERN = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::|\/|$)/i;

function ensureAbsoluteBaseUrl(rawBaseUrl: string): string {
  const candidate = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!candidate) {
    return 'https://openrouter.ai/api/v1';
  }

  if (ABSOLUTE_URL_SCHEME_PATTERN.test(candidate)) {
    return candidate;
  }

  const withoutLeadingSlashes = candidate.replace(/^\/+/, '');
  const defaultScheme = LOCAL_BASE_URL_PATTERN.test(withoutLeadingSlashes)
    ? 'http://'
    : 'https://';
  return `${defaultScheme}${withoutLeadingSlashes}`;
}

export function isOfficialOpenRouterBaseUrl(rawBaseUrl: string): boolean {
  const candidate = ensureAbsoluteBaseUrl(rawBaseUrl);

  try {
    return OPENROUTER_HOST_PATTERN.test(new URL(candidate).hostname);
  } catch {
    const withoutScheme = candidate.replace(/^[a-z]+:\/\//i, '');
    const authority = withoutScheme.split('/')[0] || '';
    const hostCandidate = authority.split('@').pop()?.split(':')[0] || '';
    return OPENROUTER_HOST_PATTERN.test(hostCandidate);
  }
}

export function normalizeOpenRouterBaseUrl(rawBaseUrl?: string): string {
  const fallbackBaseUrl = 'https://openrouter.ai/api/v1';
  const candidate = ensureAbsoluteBaseUrl(rawBaseUrl || fallbackBaseUrl);

  try {
    const url = new URL(candidate);
    const normalizedPath = url.pathname.replace(/\/+$/, '');
    const isOpenRouterHost = OPENROUTER_HOST_PATTERN.test(url.hostname);

    if (isOpenRouterHost) {
      if (!normalizedPath || normalizedPath === '/' || normalizedPath === '/v1') {
        url.pathname = '/api/v1';
      }
    } else if (!normalizedPath || normalizedPath === '/') {
      url.pathname = '/v1';
    }

    return url.toString().replace(/\/+$/, '');
  } catch {
    if (isOfficialOpenRouterBaseUrl(candidate)) {
      if (candidate.endsWith('/v1')) {
        return `${candidate.slice(0, -3)}/api/v1`;
      }
      return candidate.endsWith('/api/v1') ? candidate : `${candidate}/api/v1`;
    }

    return candidate.endsWith('/v1') ? candidate : `${candidate}/v1`;
  }
}

export function normalizePositiveInteger(
  value: number | string | undefined,
  fallback?: number,
): number | undefined {
  const numericValue = typeof value === 'string' ? Number(value) : value;

  if (typeof numericValue !== 'number' || !Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.floor(numericValue);
}
