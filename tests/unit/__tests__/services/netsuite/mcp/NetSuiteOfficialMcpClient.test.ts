import { NetSuiteOfficialMcpClient } from '../../../../../../src/services/netsuite/mcp/NetSuiteOfficialMcpClient';
import type { IMCPTokenProvider } from '../../../../../../src/services/mcp/IMCPTokenProvider';
import type { Logger } from '../../../../../../src/utils/Logger';

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

function createJsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
    text: jest.fn().mockResolvedValue(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  } as unknown as Response;
}

describe('NetSuiteOfficialMcpClient', () => {
  let logger: jest.Mocked<Logger>;
  let tokenProvider: jest.Mocked<IMCPTokenProvider>;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    logger = createMockLogger();
    tokenProvider = {
      tokenType: 'oauth2_pkce',
      getAccessToken: jest.fn().mockResolvedValue('token-123'),
      invalidate: jest.fn(),
    };
    fetchMock = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('parses discovered tools from NetSuite MCP all endpoint', async () => {
    fetchMock.mockResolvedValueOnce(createJsonResponse({
      tools: [
        {
          name: 'ns_getRecord',
          description: 'Read record',
          inputSchema: { type: 'object', properties: { recordType: { type: 'string' } } },
        },
      ],
    }));

    const client = new NetSuiteOfficialMcpClient({
      endpoint: 'https://netsuite.example.com',
      tokenProvider,
      logger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const tools = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'ns_getRecord' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://netsuite.example.com/services/mcp/v1/all',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('dispatches tools/call payload and normalizes tool result', async () => {
    fetchMock.mockResolvedValueOnce(createJsonResponse({
      result: {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { id: '123' },
      },
    }));

    const client = new NetSuiteOfficialMcpClient({
      endpoint: 'https://netsuite.example.com',
      tokenProvider,
      logger,
      suiteAppId: 'suiteapp_42',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.callTool('ns_getRecord', { recordType: 'customer', id: '123' });

    expect(result.content[0].text).toBe('ok');
    expect(result.structuredContent).toMatchObject({ id: '123' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://netsuite.example.com/services/mcp/v1/suiteapp/suiteapp_42',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('invalidates token on unauthorized response', async () => {
    fetchMock.mockResolvedValueOnce(createJsonResponse('Unauthorized', 401));

    const client = new NetSuiteOfficialMcpClient({
      endpoint: 'https://netsuite.example.com',
      tokenProvider,
      logger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.callTool('ns_getRecord', { id: '1' })).rejects.toThrow();
    expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);
  });

  it('uses in-memory cache for listTools until TTL expires', async () => {
    fetchMock.mockResolvedValue(createJsonResponse({
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
    }));

    const client = new NetSuiteOfficialMcpClient({
      endpoint: 'https://netsuite.example.com',
      tokenProvider,
      logger,
      listToolsTtlMs: 60_000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const first = await client.listTools();
    const second = await client.listTools();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens circuit breaker after repeated failures', async () => {
    fetchMock.mockResolvedValue(createJsonResponse('fail', 500));

    const client = new NetSuiteOfficialMcpClient({
      endpoint: 'https://netsuite.example.com',
      tokenProvider,
      logger,
      fetchImpl: fetchMock as unknown as typeof fetch,
      listToolsTtlMs: 0,
    });

    await expect(client.listTools()).rejects.toThrow();
    await expect(client.listTools()).rejects.toThrow();
    await expect(client.listTools()).rejects.toThrow();
    await expect(client.listTools()).rejects.toThrow(/Circuit breaker is OPEN/i);
  });

  it('exposes configured read-only tools and protocol version', () => {
    const client = new NetSuiteOfficialMcpClient({
      endpoint: 'https://netsuite.example.com',
      tokenProvider,
      logger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(client.protocolVersion).toBe('2025-06-18');
    expect(client.readOnlyTools.has('ns_runSavedSearch')).toBe(true);
    expect(client.readOnlyTools.has('ns_createRecord')).toBe(false);
  });
});
