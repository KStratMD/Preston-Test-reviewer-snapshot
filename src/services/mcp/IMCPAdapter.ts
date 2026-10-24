export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolResult {
  content: {
    type: string;
    text?: string;
    data?: unknown;
  }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface MCPHealthStatus {
  connected: boolean;
  latencyMs: number;
}

export interface IMCPAdapter {
  readonly systemName: string;
  readonly protocolVersion: string;
  readonly readOnlyTools: Set<string>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  getHealth(): Promise<MCPHealthStatus>;
}
