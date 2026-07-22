import express from 'express';
import request from 'supertest';
import { createMCPRouter } from '../../../../src/routes/ai-proxy/MCPRouter';
import type { Logger } from '../../../../src/utils/Logger';
import type { GovernanceService, GovernanceResult } from '../../../../src/services/ai/orchestrator/GovernanceService';
import type { MultiAgentOrchestrator } from '../../../../src/services/ai/orchestrator/MultiAgentOrchestrator';
import type { SyncCentralOrchestrator } from '../../../../src/services/sync/SyncCentralOrchestrator';
import type { SyncCentralService } from '../../../../src/services/SyncCentralService';
import type { MCPAggregatorService } from '../../../../src/services/mcp/MCPAggregatorService';
import type { MCPPolicyService } from '../../../../src/services/mcp/MCPPolicyService';
import type { AuditService } from '../../../../src/services/ai/orchestrator/AuditService';
import type { CostTrackingService } from '../../../../src/services/ai/CostTrackingService';

function buildGovernanceResult(overrides: Partial<GovernanceResult> = {}): GovernanceResult {
  return {
    approved: true,
    flags: [],
    riskLevel: 'low',
    complianceChecks: [],
    ...overrides,
  };
}

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

async function setupRouter(options?: {
  gatewayEnabled?: boolean;
  aggregatorService?: { discoverAll: jest.Mock; callTool: jest.Mock; getProtocolMismatches: jest.Mock };
  policyService?: { evaluateToolAccess: jest.Mock };
  governanceService?: { validateInput: jest.Mock };
}) {
  process.env.MCP_GATEWAY_ENABLED = options?.gatewayEnabled ? '1' : '0';

  const logger = createMockLogger();
  const governanceService = options?.governanceService || {
    validateInput: jest.fn().mockResolvedValue(buildGovernanceResult()),
  };
  const orchestrator = {
    executeAgent: jest.fn().mockResolvedValue({
      success: true,
      confidence: 0.9,
      reasoning: 'Mapped based on semantic similarity',
      data: { mappings: [{ sourceField: 'name', targetField: 'company_name' }] },
      executionTime: 12,
    }),
  };
  const syncOrchestrator = {
    getOperations: jest.fn().mockResolvedValue([]),
  };
  const syncService = {
    getSubscriptions: jest.fn().mockResolvedValue({ subscriptions: [], totalCount: 0 }),
  };
  const aggregatorService = options?.aggregatorService || {
    discoverAll: jest.fn().mockResolvedValue({
      tools: [{ name: 'netsuite.ns_getRecord' }],
      systems: [{ system: 'netsuite', status: 'available', toolCount: 1 }],
      protocolVersions: { netsuite: '2025-06-18' },
    }),
    callTool: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'proxied' }],
      structuredContent: { proxied: true },
    }),
    getProtocolMismatches: jest.fn().mockReturnValue([]),
  };
  const policyService = options?.policyService || {
    evaluateToolAccess: jest.fn().mockReturnValue({ allowed: true, reason: 'allowlist_match:netsuite.*' }),
  };
  const auditService = {
    logGovernanceCheck: jest.fn().mockResolvedValue('audit-1'),
  };
  const costTrackingService = {
    recordCost: jest.fn().mockResolvedValue(undefined),
  };

  const router = await createMCPRouter({
    logger,
    governanceService: governanceService as unknown as GovernanceService,
    orchestrator: orchestrator as unknown as MultiAgentOrchestrator,
    syncOrchestrator: syncOrchestrator as unknown as SyncCentralOrchestrator,
    syncService: syncService as unknown as SyncCentralService,
    aggregatorService: aggregatorService as unknown as MCPAggregatorService,
    policyService: policyService as unknown as MCPPolicyService,
    auditService: auditService as unknown as AuditService,
    costTrackingService: costTrackingService as unknown as CostTrackingService,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 'user-123',
      username: 'demo-user',
      tenantId: 'tenant-abc',
      roles: ['user'],
      permissions: [],
    } as any;
    next();
  });
  app.use('/api/ai/proxy/mcp', router);

  return {
    app,
    logger,
    governanceService,
    orchestrator,
    syncOrchestrator,
    syncService,
    aggregatorService,
    policyService,
    auditService,
    costTrackingService,
  };
}

describe('MCPRouter', () => {
  const originalGateway = process.env.MCP_GATEWAY_ENABLED;

  afterEach(() => {
    if (typeof originalGateway === 'undefined') {
      delete process.env.MCP_GATEWAY_ENABLED;
    } else {
      process.env.MCP_GATEWAY_ENABLED = originalGateway;
    }
    jest.clearAllMocks();
  });

  it('returns MCP tools metadata from GET /tools (gateway disabled)', async () => {
    const { app } = await setupRouter({ gatewayEnabled: false });

    const res = await request(app).get('/api/ai/proxy/mcp/tools').expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.protocolVersion).toBe('2025-11-25');
    expect(Array.isArray(res.body.tools)).toBe(true);
    expect(res.body.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining([
      'suitecentral.field_mapping_suggest',
      'suitecentral.integration_status',
      'suitecentral.governance_check',
    ]));
    expect(res.body.tools.map((t: { name: string }) => t.name)).not.toContain('suitecentral.mcp_discover');
  });

  it('handles JSON-RPC initialize', async () => {
    const { app } = await setupRouter({ gatewayEnabled: false });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      })
      .expect(200);

    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe(1);
    expect(res.body.result.protocolVersion).toBe('2025-11-25');
    expect(res.body.result.serverInfo.name).toBe('suitecentral-mcp-server');
  });

  it('rejects invalid JSON-RPC version', async () => {
    const { app } = await setupRouter({ gatewayEnabled: false });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '1.0',
        id: 'bad-1',
        method: 'initialize',
      })
      .expect(200);

    expect(res.body.error.code).toBe(-32600);
    expect(res.body.error.message).toContain('jsonrpc must be "2.0"');
  });

  it('returns tools/list over JSON-RPC', async () => {
    const { app } = await setupRouter({ gatewayEnabled: false });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'tools-list-1',
        method: 'tools/list',
      })
      .expect(200);

    expect(Array.isArray(res.body.result.tools)).toBe(true);
    expect(res.body.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining([
      'suitecentral.field_mapping_suggest',
      'suitecentral.integration_status',
      'suitecentral.governance_check',
    ]));
  });

  it('returns an error when tools/call name is missing', async () => {
    const { app } = await setupRouter({ gatewayEnabled: false });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'missing-name-1',
        method: 'tools/call',
        params: {
          arguments: {},
        },
      })
      .expect(200);

    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('name is required');
  });

  it('executes field_mapping_suggest and returns structured result', async () => {
    const { app, governanceService, orchestrator } = await setupRouter({ gatewayEnabled: false });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'fm-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.field_mapping_suggest',
          arguments: {
            userId: 'user-123',
            sourceSystem: 'salesforce',
            targetSystem: 'netsuite',
            sourceFields: [{ name: 'name', type: 'string' }],
            targetFields: [{ name: 'company_name', type: 'string' }],
            sampleData: [{ name: 'Acme' }],
          },
        },
      })
      .expect(200);

    expect(governanceService.validateInput).toHaveBeenCalledTimes(1);
    expect(orchestrator.executeAgent).toHaveBeenCalledWith(
      'field-mapping',
      expect.objectContaining({
        userId: 'user-123',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
        businessProcess: 'mcp_field_mapping',
        sessionId: expect.stringMatching(/^mcp_/),
      }),
      expect.objectContaining({
        sourceFields: [{ name: 'name', type: 'string' }],
        targetFields: [{ name: 'company_name', type: 'string' }],
        sampleData: [{ name: 'Acme' }],
      })
    );
    expect(res.body.result.structuredContent.success).toBe(true);
    expect(res.body.result.content[0].text).toContain('Generated 1 mappings');
  });

  it('accepts bare tool names for backward compatibility', async () => {
    const { app, orchestrator } = await setupRouter({ gatewayEnabled: false });

    await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'fm-compat-1',
        method: 'tools/call',
        params: {
          name: 'field_mapping_suggest',
          arguments: {
            sourceSystem: 'salesforce',
            targetSystem: 'netsuite',
            sourceFields: [{ name: 'name', type: 'string' }],
            targetFields: [{ name: 'company_name', type: 'string' }],
          },
        },
      })
      .expect(200);

    expect(orchestrator.executeAgent).toHaveBeenCalledTimes(1);
  });

  it('executes integration_status and returns operation/subscription summaries', async () => {
    const { app, syncOrchestrator, syncService } = await setupRouter({ gatewayEnabled: false });

    syncOrchestrator.getOperations.mockResolvedValueOnce([
      { id: 'op-1', status: 'active' },
      { id: 'op-2', status: 'active' },
      { id: 'op-3', status: 'paused' },
      { id: 'op-4', status: 'error' },
    ]);
    syncService.getSubscriptions.mockResolvedValueOnce({
      totalCount: 3,
      subscriptions: [
        { id: 'sub-1', status: 'active' },
        { id: 'sub-2', status: 'suspended' },
        { id: 'sub-3', status: 'cancelled' },
      ],
    });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'status-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.integration_status',
          arguments: {
            status: 'active',
            customerId: 'cust-1',
            limit: 2,
          },
        },
      })
      .expect(200);

    expect(syncOrchestrator.getOperations).toHaveBeenCalledWith({ status: 'active', sourceSystem: undefined });
    expect(syncService.getSubscriptions).toHaveBeenCalledWith(
      expect.any(String), // tenantId (SYSTEM_IDENTITY in unauthenticated test context)
      {
        customerId: 'cust-1',
        status: ['active'],
        limit: 2,
        offset: 0,
      }
    );
    expect(res.body.result.structuredContent.operationSummary).toMatchObject({ total: 4, active: 2, paused: 1, error: 1 });
    expect(res.body.result.structuredContent.subscriptionSummary).toMatchObject({ totalCount: 3, pageCount: 3, active: 1 });
    expect(res.body.result.structuredContent.operations).toHaveLength(2);
    expect(res.body.result.structuredContent.subscriptions).toHaveLength(2);
  });

  it('returns method-not-found for unknown method', async () => {
    const { app } = await setupRouter({ gatewayEnabled: false });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'unknown-method-1',
        method: 'ping',
      })
      .expect(200);

    expect(res.body.error.code).toBe(-32601);
    expect(res.body.error.message).toContain('Method not found');
  });

  it('returns method-not-found for mcp_discover when gateway disabled', async () => {
    const { app } = await setupRouter({ gatewayEnabled: false });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'discover-disabled-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.mcp_discover',
          arguments: {},
        },
      })
      .expect(200);

    expect(res.body.error.code).toBe(-32601);
  });

  it('exposes discover tool and returns namespaced tools when gateway enabled', async () => {
    const { app, aggregatorService } = await setupRouter({ gatewayEnabled: true });

    const toolsRes = await request(app).get('/api/ai/proxy/mcp/tools').expect(200);
    expect(toolsRes.body.tools.map((t: { name: string }) => t.name)).toContain('suitecentral.mcp_discover');

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'discover-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.mcp_discover',
          arguments: {},
        },
      })
      .expect(200);

    expect(aggregatorService.discoverAll).toHaveBeenCalledTimes(1);
    expect(res.body.result.structuredContent.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'netsuite.ns_getRecord' }),
    ]));
  });

  it('proxies suitecentral.mcp_call through aggregator with policy and cost hooks', async () => {
    const { app, aggregatorService, policyService, costTrackingService, auditService } = await setupRouter({ gatewayEnabled: true });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .set('x-tenant-id', 'tenant-abc')
      .send({
        jsonrpc: '2.0',
        id: 'proxy-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.mcp_call',
          arguments: {
            tool: 'netsuite.ns_getRecord',
            arguments: { recordType: 'customer', id: '123' },
          },
        },
      })
      .expect(200);

    expect(policyService.evaluateToolAccess).toHaveBeenCalledWith('tenant-abc', 'netsuite', 'ns_getRecord');
    expect(aggregatorService.callTool).toHaveBeenCalledWith(
      'netsuite.ns_getRecord',
      { recordType: 'customer', id: '123' },
      expect.objectContaining({
        tenantId: 'tenant-abc',
        prevalidated: true,
      })
    );
    expect(costTrackingService.recordCost).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'mcp_proxy',
      providerId: 'netsuite',
    }));
    expect(res.body.result.content[0].text).toBe('proxied');
    expect(auditService.logGovernanceCheck).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-abc', approved: true })
    );
  });

  it('attributes the governance-blocked audit row to the tenant and logs (not swallows) a persistence failure', async () => {
    const governanceService = {
      validateInput: jest.fn().mockResolvedValue(
        buildGovernanceResult({ approved: false, reason: 'blocked_field', riskLevel: 'high', flags: ['pii_detected'] })
      ),
    };

    const { app, auditService, logger } = await setupRouter({ gatewayEnabled: true, governanceService });
    (auditService.logGovernanceCheck as jest.Mock).mockRejectedValueOnce(new Error('db unavailable'));

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .set('x-tenant-id', 'tenant-abc')
      .send({
        jsonrpc: '2.0',
        id: 'proxy-governance-block-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.mcp_call',
          arguments: {
            tool: 'netsuite.ns_getRecord',
            arguments: { id: '123' },
          },
        },
      })
      .expect(200);

    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('blocked_field');

    expect(auditService.logGovernanceCheck).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-abc', approved: false, reason: 'blocked_field' })
    );

    // Persistence failure must be logged, not swallowed silently.
    // Flush the .catch() microtask before asserting on the warn call.
    await new Promise<void>(resolve => process.nextTick(resolve));
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to persist MCP governance audit row',
      expect.objectContaining({ tool: 'netsuite.ns_getRecord', approved: false, error: 'db unavailable' })
    );
  });

  it('returns -32602 when policy blocks proxied tool', async () => {
    const policyService = {
      evaluateToolAccess: jest.fn().mockReturnValue({
        allowed: false,
        reason: 'external_tool_not_allowlisted',
      }),
    };

    const { app, aggregatorService, auditService } = await setupRouter({
      gatewayEnabled: true,
      policyService,
    });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .set('x-tenant-id', 'tenant-abc')
      .send({
        jsonrpc: '2.0',
        id: 'proxy-block-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.mcp_call',
          arguments: {
            tool: 'netsuite.ns_getRecord',
            arguments: { id: '123' },
          },
        },
      })
      .expect(200);

    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('Policy blocked tool');
    expect(aggregatorService.callTool).not.toHaveBeenCalled();
    expect(auditService.logGovernanceCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-abc',
        approved: false,
        riskLevel: 'high',
        flags: ['mcp_policy_blocked'],
      })
    );
  });

  it('ignores spoofed tenant headers for non-admin proxied calls', async () => {
    const { app, policyService } = await setupRouter({ gatewayEnabled: true });

    await request(app)
      .post('/api/ai/proxy/mcp')
      .set('x-tenant-id', 'tenant-spoofed')
      .send({
        jsonrpc: '2.0',
        id: 'proxy-tenant-spoof-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.mcp_call',
          arguments: {
            tool: 'netsuite.ns_getRecord',
            arguments: { id: '123' },
          },
        },
      })
      .expect(200);

    expect(policyService.evaluateToolAccess).toHaveBeenCalledWith('tenant-abc', 'netsuite', 'ns_getRecord');
  });

  it('enforces tenant kill switch policy decisions for proxied calls', async () => {
    const policyService = {
      evaluateToolAccess: jest.fn().mockReturnValue({
        allowed: false,
        reason: 'tenant_disabled:tenant-abc',
      }),
    };

    const { app, aggregatorService } = await setupRouter({
      gatewayEnabled: true,
      policyService,
    });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .set('x-tenant-id', 'tenant-abc')
      .send({
        jsonrpc: '2.0',
        id: 'proxy-kill-switch-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.mcp_call',
          arguments: {
            tool: 'netsuite.ns_getRecord',
            arguments: { id: '123' },
          },
        },
      })
      .expect(200);

    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('tenant_disabled:tenant-abc');
    expect(aggregatorService.callTool).not.toHaveBeenCalled();
  });

  it('returns -32602 when mcp_call missing tool argument', async () => {
    const { app } = await setupRouter({ gatewayEnabled: true });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .send({
        jsonrpc: '2.0',
        id: 'proxy-missing-tool-1',
        method: 'tools/call',
        params: {
          name: 'suitecentral.mcp_call',
          arguments: {},
        },
      })
      .expect(200);

    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('tool is required');
  });
});
