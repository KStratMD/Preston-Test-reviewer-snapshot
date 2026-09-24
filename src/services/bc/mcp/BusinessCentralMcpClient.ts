import { injectable } from 'inversify';
import type { Logger } from '../../../utils/Logger';
import type {
  IMCPAdapter,
  MCPHealthStatus,
  MCPTool,
  MCPToolResult,
} from '../../mcp/IMCPAdapter';
import type { IMCPTokenProvider } from '../../mcp/IMCPTokenProvider';

export type BusinessCentralMcpMode = 'static' | 'dynamic';

interface BusinessCentralMcpClientOptions {
  endpoint: string;
  tokenProvider: IMCPTokenProvider;
  logger: Logger;
  mode?: BusinessCentralMcpMode;
  enabled?: boolean;
  protocolVersion?: string;
  fetchImpl?: typeof fetch;
}

const BC_STATIC_TOOLS: MCPTool[] = [
  {
    name: 'bc_getCompanies',
    description: 'List Business Central companies in the tenant.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'bc_getCustomers',
    description: 'Retrieve customers from Business Central.',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number' },
        filter: { type: 'string' },
      },
    },
  },
  {
    name: 'bc_getItems',
    description: 'Retrieve item catalog entries from Business Central.',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number' },
        filter: { type: 'string' },
      },
    },
  },
];

const BC_DYNAMIC_META_TOOLS: MCPTool[] = [
  {
    name: 'bc_actions_search',
    description: 'Search available Business Central actions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    },
  },
  {
    name: 'bc_actions_describe',
    description: 'Describe Business Central action metadata.',
    inputSchema: {
      type: 'object',
      required: ['actionId'],
      properties: {
        actionId: { type: 'string' },
      },
    },
  },
  {
    name: 'bc_actions_invoke',
    description: 'Invoke a Business Central action by actionId.',
    inputSchema: {
      type: 'object',
      required: ['actionId'],
      properties: {
        actionId: { type: 'string' },
        payload: { type: 'object' },
      },
    },
  },
];

@injectable()
export class BusinessCentralMcpClient implements IMCPAdapter {
  readonly systemName = 'bc';
  readonly protocolVersion: string;
  readonly readOnlyTools: Set<string>;

  private readonly endpoint: string;
  private readonly tokenProvider: IMCPTokenProvider;
  private readonly logger: Logger;
  private readonly mode: BusinessCentralMcpMode;
  private readonly enabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private connected = false;

  constructor(options: BusinessCentralMcpClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.tokenProvider = options.tokenProvider;
    this.logger = options.logger;
    this.mode = options.mode ?? 'dynamic';
    this.enabled = options.enabled ?? true;
    this.protocolVersion = options.protocolVersion ?? '2025-11-25';
    this.fetchImpl = options.fetchImpl ?? fetch;

    const readOnlyNames = this.mode === 'dynamic'
      ? [
          ...BC_STATIC_TOOLS.map(tool => tool.name),
          'bc_actions_search',
          'bc_actions_describe',
        ]
      : BC_STATIC_TOOLS.map(tool => tool.name);

    this.readOnlyTools = new Set(readOnlyNames);
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Business Central MCP adapter disabled by feature flag', {
        endpoint: this.endpoint,
      });
      this.connected = false;
      return;
    }

    this.logger.warn('Business Central MCP adapter is in preview mode', {
      endpoint: this.endpoint,
      mode: this.mode,
      protocolVersion: this.protocolVersion,
    });

    await this.listTools();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.enabled) {
      return [];
    }

    this.connected = true;

    if (this.mode === 'static') {
      return BC_STATIC_TOOLS;
    }

    return BC_DYNAMIC_META_TOOLS;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.enabled) {
      throw new Error('Business Central MCP adapter is disabled');
    }

    if (!name || !name.trim()) {
      throw new Error('Tool name is required');
    }

    const path = this.resolvePath(name);
    const payload = await this.requestJson(path, {
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    });

    this.connected = true;
    return this.normalizeToolResult(payload.result ?? payload);
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

  negotiateProtocolVersion(requestedVersion?: string): {
    adapterVersion: string;
    requestedVersion?: string;
    compatible: boolean;
  } {
    return {
      adapterVersion: this.protocolVersion,
      requestedVersion,
      compatible: !requestedVersion || requestedVersion === this.protocolVersion,
    };
  }

  private resolvePath(name: string): string {
    switch (name) {
      case 'bc_actions_search':
        return '/actions/search';
      case 'bc_actions_describe':
        return '/actions/describe';
      case 'bc_actions_invoke':
        return '/actions/invoke';
      default:
        return '/tools/call';
    }
  }

  private async requestJson(
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const token = await this.tokenProvider.getAccessToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.tokenProvider.invalidate();
      }
      const details = await this.safeReadText(response);
      throw new Error(details || `Business Central MCP request failed (${response.status})`);
    }

    return this.safeReadJson(response);
  }

  private async safeReadJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const payload = await response.json();
      return payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : { value: payload };
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
    };
  }
}
