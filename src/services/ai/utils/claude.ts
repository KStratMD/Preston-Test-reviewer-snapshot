const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com/v1';

export type ClaudeAuthMode = 'auto' | 'anthropic' | 'bearer';

export function normalizeClaudeBaseUrl(rawBaseUrl?: string): string {
  return (rawBaseUrl || DEFAULT_CLAUDE_BASE_URL).trim().replace(/\/+$/, '');
}

export function usesAnthropicDirectEndpoint(rawBaseUrl?: string): boolean {
  try {
    const hostname = new URL(normalizeClaudeBaseUrl(rawBaseUrl)).hostname;
    return hostname === 'api.anthropic.com';
  } catch {
    return true;
  }
}

export function resolveClaudeAuthMode(
  baseURL?: string,
  authMode: ClaudeAuthMode = 'auto',
): Exclude<ClaudeAuthMode, 'auto'> {
  if (authMode === 'anthropic' || authMode === 'bearer') {
    return authMode;
  }

  return usesAnthropicDirectEndpoint(baseURL) ? 'anthropic' : 'bearer';
}

export function buildClaudeHeaders(
  apiKey: string,
  options?: {
    baseURL?: string;
    authMode?: ClaudeAuthMode;
  },
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (resolveClaudeAuthMode(options?.baseURL, options?.authMode) === 'anthropic') {
    headers['x-api-key'] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}
