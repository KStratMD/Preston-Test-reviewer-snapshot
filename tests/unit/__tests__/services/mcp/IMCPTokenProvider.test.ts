import {
  OAuth2ClientCredentialsMCPTokenProvider,
  StaticMCPTokenProvider,
} from '../../../../../src/services/mcp/IMCPTokenProvider';

function createJsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
    text: jest.fn().mockResolvedValue(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  } as unknown as Response;
}

describe('IMCPTokenProvider', () => {
  it('StaticMCPTokenProvider returns configured token', async () => {
    const provider = new StaticMCPTokenProvider('api_key', 'static-token');

    await expect(provider.getAccessToken()).resolves.toBe('static-token');
  });

  it('OAuth2 client-credentials provider fetches and caches access tokens', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(createJsonResponse({ access_token: 'token-a', expires_in: 3600 }));

    const provider = new OAuth2ClientCredentialsMCPTokenProvider({
      tokenEndpoint: 'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scope: 'https://api.businesscentral.dynamics.com/.default',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const first = await provider.getAccessToken();
    const second = await provider.getAccessToken();

    expect(first).toBe('token-a');
    expect(second).toBe('token-a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token',
      expect.objectContaining({
        method: 'POST',
      })
    );

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = String(requestInit.body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=client-id');
    expect(body).toContain('client_secret=client-secret');
    expect(body).toContain('scope=https%3A%2F%2Fapi.businesscentral.dynamics.com%2F.default');
  });

  it('OAuth2 provider re-fetches token after invalidate', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(createJsonResponse({ access_token: 'token-a', expires_in: 3600 }))
      .mockResolvedValueOnce(createJsonResponse({ access_token: 'token-b', expires_in: 3600 }));

    const provider = new OAuth2ClientCredentialsMCPTokenProvider({
      tokenEndpoint: 'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.getAccessToken()).resolves.toBe('token-a');
    provider.invalidate();
    await expect(provider.getAccessToken()).resolves.toBe('token-b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('OAuth2 provider fails when token endpoint response has no access token', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(createJsonResponse({ expires_in: 3600 }));

    const provider = new OAuth2ClientCredentialsMCPTokenProvider({
      tokenEndpoint: 'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.getAccessToken()).rejects.toThrow('access_token');
  });
});
