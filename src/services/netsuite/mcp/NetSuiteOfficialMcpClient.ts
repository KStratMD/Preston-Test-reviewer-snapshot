import { injectable } from 'inversify';
import type { Logger } from '../../../utils/Logger';
import { CircuitBreaker } from '../../../utils/CircuitBreaker';
import { withRetry } from '../../../utils/AdvancedRetryStrategies';
import type {
  IMCPAdapter,
  MCPHealthStatus,
  MCPTool,
  MCPToolResult,
} from '../../mcp/IMCPAdapter';
import type { IMCPTokenProvider } from '../../mcp/IMCPTokenProvider';

interface NetSuiteOfficialMcpClientOptions {
  endpoint: string;
  tokenProvider: IMCPTokenProvider;
  logger: Logger;
  suiteAppId?: string;
  protocolVersion?: string;
  listToolsTtlMs?: number;
  fetchImpl?: typeof fetch;
}

interface ToolCacheEntry {
  tools: MCPTool[];
  expiresAt: number;
}

class MCPHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'MCPHttpError';
  }
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_LIST_TOOLS_TTL_MS = 24 * 60 * 60 * 1000;

const NETSUITE_READ_ONLY_TOOLS = [
  'ns_getRecord',
  'ns_getRecordTypeMetadata',
  'ns_listAllReports',
  'ns_runReport',
  'ns_getSubsidiaries',
  'ns_listSavedSearches',
  'ns_runSavedSearch',
  'ns_runCustomSuiteQL',
] as const;

@injectable()
export class NetSuiteOfficialMcpClient implements IMCPAdapter {
  readonly systemName = 'netsuite';
  readonly protocolVersion: string;
  readonly readOnlyTools = new Set<string>(NETSUITE_READ_ONLY_TOOLS);

  private connected = false;
  private readonly endpoint: string;
  private readonly tokenProvider: IMCPTokenProvider;
  private readonly logger: Logger;
  private readonly suiteAppId?: string;
  private readonly listToolsTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly circuitBreaker: CircuitBreaker;
  private toolsCache?: ToolCacheEntry;

  constructor(options: NetSuiteOfficialMcpClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.tokenProvider = options.tokenProvider;
    this.logger = options.logger;
    this.suiteAppId = options.suiteAppId;
    this.protocolVersion = options.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    this.listToolsTtlMs = options.listToolsTtlMs ?? DEFAULT_LIST_TOOLS_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 15000,
      monitoringPeriod: 60000,
    });
  }

  async connect(): Promise<void> {
    await this.listTools();
    this.connected = true;
    this.logger.info('NetSuite official MCP client connected', {
      endpoint: this.endpoint,
      suiteAppId: this.suiteAppId,
      protocolVersion: this.protocolVersion,
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.logger.info('NetSuite official MCP client disconnected', {
      endpoint: this.endpoint,
    });
  }

  async listTools(): Promise<MCPTool[]> {
    const now = Date.now();
    if (this.toolsCache && this.toolsCache.expiresAt > now) {
      return this.toolsCache.tools;
    }

    const tools = await this.executeWithResilience('netsuite.mcp.listTools', async () => {
      const payload = await this.requestJson('GET', this.discoveryUrl());
      const parsedTools = this.parseToolsResponse(payload);

      this.toolsCache = {
        tools: parsedTools,
        expiresAt: now + this.listToolsTtlMs,
      };

      this.connected = true;
      return parsedTools;
    });

    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!name || !name.trim()) {
      throw new Error('Tool name is required');
    }

    const result = await this.executeWithResilience('netsuite.mcp.callTool', async () => {
      const payload = await this.requestJson('POST', this.executionUrl(), {
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
      });

      this.connected = true;
      return this.normalizeToolResult(payload.result ?? payload);
    });

    return result;
  }

  async getHealth(): Promise<MCPHealthStatus> {
    const start = Date.now();
    try {
      await this.listTools();
      return {
        connected: this.connected,
        latencyMs: Date.now() - start,
      };
    } catch {
      return {
        connected: false,
        latencyMs: Date.now() - start,
      };
    }
  }

  private discoveryUrl(): string {
    return `${this.endpoint}/services/mcp/v1/all`;
  }

  private executionUrl(): string {
    if (this.suiteAppId && this.suiteAppId.trim().length > 0) {
      return `${this.endpoint}/services/mcp/v1/suiteapp/${this.suiteAppId}`;
    }

    return this.discoveryUrl();
  }

  private async executeWithResilience<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.circuitBreaker.execute(() => withRetry(operation, {
      name,
      maxAttempts: 3,
      baseDelay: 200,
      maxDelay: 2000,
      backoffFactor: 2,
      jitter: true,
      strategy: 'exponential',
    }));
  }

  private async requestJson(
    method: 'GET' | 'POST',
    url: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const token = await this.tokenProvider.getAccessToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.tokenProvider.invalidate();
      }

      const details = await this.safeReadText(response);
      throw new MCPHttpError(
        response.status,
        details || `NetSuite MCP request failed with status ${response.status}`
      );
    }

    if (response.status === 204) {
      return {};
    }

    return this.safeReadJson(response);
  }

  private async safeReadJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const payload = await response.json();
      if (payload && typeof payload === 'object') {
        return payload as Record<string, unknown>;
      }
      return { value: payload };
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

  private parseToolsResponse(payload: Record<string, unknown>): MCPTool[] {
    const candidates = this.extractToolsPayload(payload);
    const parsed = candidates
      .filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string')
      .map(item => {
        const tool = item as Record<string, unknown>;
        return {
          name: String(tool.name),
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: this.normalizeInputSchema(tool.inputSchema),
        } as MCPTool;
      });

    if (parsed.length === 0) {
      this.logger.warn('NetSuite MCP discovery returned no tools', {
        endpoint: this.discoveryUrl(),
      });
    }

    return parsed;
  }

  private extractToolsPayload(payload: Record<string, unknown>): unknown[] {
    if (Array.isArray(payload.tools)) {
      return payload.tools;
    }

    const result = payload.result as { tools?: unknown } | undefined;
    if (result && typeof result === 'object' && Array.isArray(result.tools)) {
      return result.tools;
    }

    const data = payload.data as { tools?: unknown } | undefined;
    if (data && typeof data === 'object' && Array.isArray(data.tools)) {
      return data.tools;
    }

    return [];
  }

  private normalizeInputSchema(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return {
      type: 'object',
      properties: {},
    };
  }

  private normalizeToolResult(payload: unknown): MCPToolResult {
    if (payload && typeof payload === 'object') {
      const result = payload as Record<string, unknown>;
      const content = Array.isArray(result.content)
        ? result.content.map((entry: unknown) => {
          if (entry && typeof entry === 'object') {
            return entry as { type: string; text?: string; data?: unknown };
          }

          return { type: 'text', text: String(entry) };
        })
        : [{ type: 'text', text: JSON.stringify(result) }];

      return {
        content,
        structuredContent: (result.structuredContent && typeof result.structuredContent === 'object')
          ? result.structuredContent as Record<string, unknown>
          : undefined,
        isError: Boolean(result.isError),
      };
    }

    return {
      content: [{ type: 'text', text: String(payload) }],
      isError: false,
    };
  }
}
