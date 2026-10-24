export type MCPTokenType = 'oauth2_pkce' | 'oauth2_client_credentials' | 'api_key';

export interface IMCPTokenProvider {
  readonly tokenType: MCPTokenType;
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

interface OAuth2ClientCredentialsTokenProviderOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  audience?: string;
  fetchImpl?: typeof fetch;
  cacheSkewMs?: number;
}

/**
 * Simple token provider for env/static token wiring.
 * Concrete adapters can replace this with OAuth refresh-capable providers.
 */
export class StaticMCPTokenProvider implements IMCPTokenProvider {
  private token: string;

  constructor(
    public readonly tokenType: MCPTokenType,
    token: string
  ) {
    this.token = token;
  }

  async getAccessToken(): Promise<string> {
    return this.token;
  }

  invalidate(): void {
    this.token = '';
  }

  setToken(token: string): void {
    this.token = token;
  }
}

/**
 * OAuth2 client-credentials token provider with in-memory token caching.
 */
export class OAuth2ClientCredentialsMCPTokenProvider implements IMCPTokenProvider {
  readonly tokenType: MCPTokenType = 'oauth2_client_credentials';

  private readonly tokenEndpoint: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scope?: string;
  private readonly audience?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheSkewMs: number;
  private cachedToken?: {
    accessToken: string;
    expiresAtMs: number;
  };

  constructor(options: OAuth2ClientCredentialsTokenProviderOptions) {
    this.tokenEndpoint = options.tokenEndpoint;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scope = options.scope;
    this.audience = options.audience;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheSkewMs = options.cacheSkewMs ?? 30_000;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now + this.cacheSkewMs < this.cachedToken.expiresAtMs) {
      return this.cachedToken.accessToken;
    }

    if (!this.clientId || !this.clientSecret || !this.tokenEndpoint) {
      throw new Error('OAuth2 client-credentials token provider is not fully configured');
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', this.clientId);
    body.set('client_secret', this.clientSecret);
    if (this.scope && this.scope.trim().length > 0) {
      body.set('scope', this.scope.trim());
    }
    if (this.audience && this.audience.trim().length > 0) {
      body.set('audience', this.audience.trim());
    }

    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const details = await this.safeReadText(response);
      throw new Error(details || `OAuth token request failed with status ${response.status}`);
    }

    const payload = await this.safeReadJson(response);
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    if (!accessToken) {
      throw new Error('OAuth token response did not include access_token');
    }

    const expiresInSec = this.parseExpiresInSeconds(payload.expires_in);
    this.cachedToken = {
      accessToken,
      expiresAtMs: now + (expiresInSec * 1000),
    };

    return accessToken;
  }

  invalidate(): void {
    this.cachedToken = undefined;
  }

  private parseExpiresInSeconds(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return 3600;
  }

  private async safeReadJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const payload = await response.json();
      return payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}
