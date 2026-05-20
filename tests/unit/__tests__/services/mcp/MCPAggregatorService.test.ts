import { MCPAggregatorService, McpAggregatorError } from '../../../../../src/services/mcp/MCPAggregatorService';
import type { IMCPAdapter, MCPTool, MCPToolResult } from '../../../../../src/services/mcp/IMCPAdapter';
import type { MCPPolicyService } from '../../../../../src/services/mcp/MCPPolicyService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { GovernanceService } from '../../../../../src/services/ai/orchestrator/GovernanceService';
import type { DLPService } from '../../../../../src/services/security/DLPService';
import type { AuditService } from '../../../../../src/services/ai/orchestrator/AuditService';

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

function createAdapter(config: {
  systemName: string;
  protocolVersion?: string;
  tools?: MCPTool[];
  readOnlyTools?: string[];
  callToolResult?: MCPToolResult;
  listToolsError?: Error;
}): IMCPAdapter {
  const tools = config.tools || [];
  return {
    systemName: config.systemName,
    protocolVersion: config.protocolVersion || '2025-11-25',
    readOnlyTools: new Set(config.readOnlyTools || tools.map(tool => tool.name)),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    listTools: config.listToolsError
      ? jest.fn().mockRejectedValue(config.listToolsError)
      : jest.fn().mockResolvedValue(tools),
    callTool: jest.fn().mockResolvedValue(config.callToolResult || {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    }),
    getHealth: jest.fn().mockResolvedValue({ connected: true, latencyMs: 5 }),
  };
}

describe('MCPAggregatorService', () => {
  let logger: jest.Mocked<Logger>;
  let governanceService: jest.Mocked<Pick<GovernanceService, 'validateInput'>>;
  let dlpService: jest.Mocked<Pick<DLPService, 'scanForPII'>>;
  let auditService: jest.Mocked<Pick<AuditService, 'logDataAccess'>>;

  beforeEach(() => {
    logger = createMockLogger();
    governanceService = {
      validateInput: jest.fn().mockResolvedValue({
        approved: true,
        flags: [],
        riskLevel: 'low',
        complianceChecks: [],
      }),
    };
    dlpService = {
      scanForPII: jest.fn().mockResolvedValue({
        detected: false,
        piiTypes: [],
        findings: [],
        riskLevel: 'low',
        recommendation: 'none',
      }),
    };
    auditService = {
      logDataAccess: jest.fn().mockResolvedValue('audit-1'),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('discovers tools across multiple adapters with namespace prefixes', async () => {
    const nsAdapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
    });
    const bcAdapter = createAdapter({
      systemName: 'bc',
      tools: [{ name: 'bc_actions_search', description: 'Search', inputSchema: {} }],
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [nsAdapter, bcAdapter]
    );

    const discovery = await service.discoverAll();

    expect(discovery.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'netsuite.ns_getRecord',
      'bc.bc_actions_search',
    ]));
    expect(discovery.systems).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: 'netsuite', status: 'available' }),
      expect.objectContaining({ system: 'bc', status: 'available' }),
    ]));
  });

  it('enforces explicit read-only tools when policy service is absent', async () => {
    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      readOnlyTools: ['ns_getRecord'],
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(service.callTool('netsuite.ns_createRecord', {}, { tenantId: 'tenant-a' })).rejects.toMatchObject({
      code: -32602,
      message: 'write_tools_disabled',
    });
  });

  it('blocks tool call when governance rejects input', async () => {
    governanceService.validateInput.mockResolvedValueOnce({
      approved: false,
      reason: 'Policy violation',
      flags: ['policy_violation'],
      riskLevel: 'high',
      complianceChecks: [],
    } as any);

    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('applies DLP redaction metadata to tool output', async () => {
    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      callToolResult: {
        content: [{ type: 'text', text: 'customer email: test@example.com' }],
        structuredContent: { pii: true },
      },
    });

    dlpService.scanForPII.mockResolvedValueOnce({
      detected: true,
      piiTypes: ['email'],
      findings: [
        {
          type: 'email',
          value: 'test@example.com',
          confidence: 0.9,
          location: { path: 'content[0].text' },
          severity: 'medium',
          redactedValue: 't***@example.com',
        },
      ],
      riskLevel: 'medium',
      recommendation: 'redact',
      redactedData: {
        content: [{ type: 'text', text: 'customer email: t***@example.com' }],
        structuredContent: { pii: false },
      },
    } as any);

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    const result = await service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' });

    expect(result.content[0].text).toContain('t***@example.com');
    expect(result.structuredContent).toMatchObject({
      pii: {
        detected: true,
      },
    });
  });

  it('gracefully degrades discoverAll when one adapter is unavailable', async () => {
    const availableAdapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
    });
    const unavailableAdapter = createAdapter({
      systemName: 'bc',
      tools: [],
      listToolsError: new Error('Connection timeout'),
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [availableAdapter, unavailableAdapter]
    );

    const discovery = await service.discoverAll();

    expect(discovery.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['netsuite.ns_getRecord']));
    expect(discovery.systems).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: 'bc', status: 'unavailable' }),
    ]));
  });

  it('returns version matrix and protocol mismatch report', () => {
    const nsAdapter = createAdapter({ systemName: 'netsuite', protocolVersion: '2025-06-18' });
    const bcAdapter = createAdapter({ systemName: 'bc', protocolVersion: '2025-11-25' });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [nsAdapter, bcAdapter]
    );

    expect(service.getVersionMatrix()).toEqual({
      netsuite: '2025-06-18',
      bc: '2025-11-25',
    });

    expect(service.getProtocolMismatches('2025-11-25')).toEqual([
      {
        system: 'netsuite',
        expectedVersion: '2025-11-25',
        adapterVersion: '2025-06-18',
      },
    ]);
  });

  it('supports policy service decisions for external tools', async () => {
    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      readOnlyTools: ['ns_getRecord'],
    });

    const policyService = {
      evaluateToolAccess: jest.fn().mockReturnValue({
        allowed: false,
        reason: 'external_tool_not_allowlisted',
      }),
    } as unknown as MCPPolicyService;

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      policyService,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('Policy blocked tool call'),
    });
  });

  it('enforces denied prevalidated policy decisions', async () => {
    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      readOnlyTools: ['ns_getRecord'],
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(service.callTool(
      'netsuite.ns_getRecord',
      {},
      {
        tenantId: 'tenant-a',
        prevalidated: true,
        policyDecision: {
          allowed: false,
          reason: 'denylist_match:netsuite.ns_getRecord',
        },
      }
    )).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('Policy blocked tool call'),
    });

    expect((adapter.callTool as jest.Mock)).not.toHaveBeenCalled();
  });

  it('applies write guard when prevalidated context has no policy decision', async () => {
    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      readOnlyTools: ['ns_getRecord'],
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(service.callTool(
      'netsuite.ns_createRecord',
      {},
      {
        tenantId: 'tenant-a',
        prevalidated: true,
      }
    )).rejects.toMatchObject({
      code: -32602,
      message: 'write_tools_disabled',
    });

    expect((adapter.callTool as jest.Mock)).not.toHaveBeenCalled();
  });

  it('returns JSON-RPC aligned error codes for invalid params and unknown adapters', async () => {
    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      []
    );

    await expect(service.callTool('invalidToolName', {}, { tenantId: 'tenant-a' })).rejects.toBeInstanceOf(McpAggregatorError);
    await expect(service.callTool('invalidToolName', {}, { tenantId: 'tenant-a' })).rejects.toMatchObject({ code: -32602 });
    await expect(service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' })).rejects.toMatchObject({ code: -32601 });
  });
});
