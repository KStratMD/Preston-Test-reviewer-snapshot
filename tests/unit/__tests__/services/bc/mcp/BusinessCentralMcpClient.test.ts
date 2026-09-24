import { BusinessCentralMcpClient } from '../../../../../../src/services/bc/mcp/BusinessCentralMcpClient';
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

describe('BusinessCentralMcpClient', () => {
  let logger: jest.Mocked<Logger>;
  let tokenProvider: jest.Mocked<IMCPTokenProvider>;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    logger = createMockLogger();
    tokenProvider = {
      tokenType: 'oauth2_client_credentials',
      getAccessToken: jest.fn().mockResolvedValue('bc-token'),
      invalidate: jest.fn(),
    };
    fetchMock = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('lists static tools in static mode', async () => {
    const client = new BusinessCentralMcpClient({
      endpoint: 'https://bc.example.com/mcp',
      tokenProvider,
      logger,
      mode: 'static',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const tools = await client.listTools();

    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'bc_getCompanies',
      'bc_getCustomers',
      'bc_getItems',
    ]));
  });

  it('lists dynamic meta-tools in dynamic mode', async () => {
    const client = new BusinessCentralMcpClient({
      endpoint: 'https://bc.example.com/mcp',
      tokenProvider,
      logger,
      mode: 'dynamic',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const tools = await client.listTools();

    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'bc_actions_search',
      'bc_actions_describe',
      'bc_actions_invoke',
    ]));
    expect(client.readOnlyTools.has('bc_actions_search')).toBe(true);
    expect(client.readOnlyTools.has('bc_actions_describe')).toBe(true);
    expect(client.readOnlyTools.has('bc_actions_invoke')).toBe(false);
  });

  it('supports dynamic flow for search -> describe -> invoke', async () => {
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ result: { content: [{ type: 'text', text: 'search-ok' }] } }))
      .mockResolvedValueOnce(createJsonResponse({ result: { content: [{ type: 'text', text: 'describe-ok' }] } }))
      .mockResolvedValueOnce(createJsonResponse({ result: { content: [{ type: 'text', text: 'invoke-ok' }] } }));

    const client = new BusinessCentralMcpClient({
      endpoint: 'https://bc.example.com/mcp',
      tokenProvider,
      logger,
      mode: 'dynamic',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const search = await client.callTool('bc_actions_search', { query: 'sales' });
    const describe = await client.callTool('bc_actions_describe', { actionId: 'sales.post' });
    const invoke = await client.callTool('bc_actions_invoke', { actionId: 'sales.post', payload: { id: '123' } });

    expect(search.content[0].text).toBe('search-ok');
    expect(describe.content[0].text).toBe('describe-ok');
    expect(invoke.content[0].text).toBe('invoke-ok');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://bc.example.com/mcp/actions/search',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://bc.example.com/mcp/actions/describe',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://bc.example.com/mcp/actions/invoke',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('logs preview warning on connect', async () => {
    const client = new BusinessCentralMcpClient({
      endpoint: 'https://bc.example.com/mcp',
      tokenProvider,
      logger,
      mode: 'dynamic',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.connect();

    expect(logger.warn).toHaveBeenCalledWith(
      'Business Central MCP adapter is in preview mode',
      expect.objectContaining({ mode: 'dynamic' })
    );
  });

  it('gates behavior when feature flag disabled', async () => {
    const client = new BusinessCentralMcpClient({
      endpoint: 'https://bc.example.com/mcp',
      tokenProvider,
      logger,
      mode: 'dynamic',
      enabled: false,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.connect();
    const tools = await client.listTools();

    expect(tools).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Business Central MCP adapter disabled by feature flag',
      expect.any(Object)
    );

    await expect(client.callTool('bc_actions_search', { query: 'x' })).rejects.toThrow('disabled');
  });

  it('reports protocol version negotiation status', () => {
    const client = new BusinessCentralMcpClient({
      endpoint: 'https://bc.example.com/mcp',
      tokenProvider,
      logger,
      protocolVersion: '2025-11-25',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(client.negotiateProtocolVersion('2025-11-25')).toMatchObject({ compatible: true });
    expect(client.negotiateProtocolVersion('2025-06-18')).toMatchObject({ compatible: false });
  });
});
