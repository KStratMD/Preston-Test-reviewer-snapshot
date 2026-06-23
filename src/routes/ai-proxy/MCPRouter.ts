import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../../middleware/asyncHandler';
import { isMCPGatewayEnabled } from '../../config/runtimeFlags';
import type { Logger } from '../../utils/Logger';
import type { GovernanceService } from '../../services/ai/orchestrator/GovernanceService';
import type { MultiAgentOrchestrator } from '../../services/ai/orchestrator/MultiAgentOrchestrator';
import type { AgentExecutionContext, FieldDefinition } from '../../services/ai/orchestrator/interfaces';
import type { SyncCentralOrchestrator } from '../../services/sync/SyncCentralOrchestrator';
import type { SyncCentralService } from '../../services/SyncCentralService';
import type { MCPAggregatorService } from '../../services/mcp/MCPAggregatorService';
import { McpAggregatorError } from '../../services/mcp/MCPAggregatorService';
import type { MCPPolicyService } from '../../services/mcp/MCPPolicyService';
import type { AuditService } from '../../services/ai/orchestrator/AuditService';
import type { CostTrackingService } from '../../services/ai/CostTrackingService';
import type { MCPToolResult } from '../../services/mcp/IMCPAdapter';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../../services/governance/identityContext';

interface MCPRouterDependencies {
  logger: Logger;
  governanceService: GovernanceService;
  orchestrator: MultiAgentOrchestrator;
  syncOrchestrator: SyncCentralOrchestrator;
  syncService: SyncCentralService;
  aggregatorService?: MCPAggregatorService;
  policyService?: MCPPolicyService;
  auditService?: AuditService;
  costTrackingService?: CostTrackingService;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_PROTOCOL_VERSION = '2025-11-25';
const GENERIC_INTERNAL_ERROR_MESSAGE = 'Internal MCP server error';
const mcpTracer = trace.getTracer('integration-hub', '1.0.0');

class McpClientError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'McpClientError';
  }
}

const BASE_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'suitecentral.field_mapping_suggest',
    description: 'Generate governed field mapping suggestions with confidence and reasoning.',
    inputSchema: {
      type: 'object',
      required: ['sourceSystem', 'targetSystem', 'sourceFields', 'targetFields'],
      properties: {
        sourceSystem: { type: 'string' },
        targetSystem: { type: 'string' },
        sourceFields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              description: { type: 'string' },
              required: { type: 'boolean' }
            }
          }
        },
        targetFields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              description: { type: 'string' },
              required: { type: 'boolean' }
            }
          }
        },
        sampleData: {
          type: 'array',
          items: { type: 'object' }
        },
        confidenceThreshold: { type: 'number' }
      }
    }
  },
  {
    name: 'suitecentral.integration_status',
    description: 'Query SyncCentral operation/subscription health and status summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        sourceSystem: { type: 'string' },
        customerId: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'suitecentral.governance_check',
    description: 'Evaluate proposed action/input against governance controls before execution.',
    inputSchema: {
      type: 'object',
      required: ['input'],
      properties: {
        input: { type: 'object' },
        sourceSystem: { type: 'string' },
        targetSystem: { type: 'string' },
        userId: { type: 'string' }
      }
    }
  }
];

const GATEWAY_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'suitecentral.mcp_discover',
    description: 'Discover namespaced external MCP tools exposed through SuiteCentral gateway.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'suitecentral.mcp_call',
    description: 'Proxy a namespaced MCP tool call through SuiteCentral governance and policy controls.',
    inputSchema: {
      type: 'object',
      required: ['tool'],
      properties: {
        tool: { type: 'string' },
        arguments: { type: 'object' }
      }
    }
  }
];

const TOOL_ALIASES: Record<string, string> = {
  field_mapping_suggest: 'suitecentral.field_mapping_suggest',
  integration_status: 'suitecentral.integration_status',
  governance_check: 'suitecentral.governance_check',
  mcp_discover: 'suitecentral.mcp_discover',
  mcp_call: 'suitecentral.mcp_call',
};

export async function createMCPRouter(deps: MCPRouterDependencies): Promise<Router> {
  const router = Router();
  const {
    logger,
    governanceService,
    orchestrator,
    syncOrchestrator,
    syncService,
    aggregatorService,
    policyService,
    auditService,
    costTrackingService,
  } = deps;

  const gatewayRequested = isMCPGatewayEnabled();
  const gatewayEnabled = gatewayRequested && Boolean(aggregatorService);

  if (gatewayRequested && !gatewayEnabled) {
    logger.warn('MCP gateway requested but aggregator service is unavailable. Gateway features disabled.');
  }

  router.get('/tools', asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      success: true,
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools: gatewayEnabled ? [...BASE_MCP_TOOLS, ...GATEWAY_MCP_TOOLS] : BASE_MCP_TOOLS,
      timestamp: new Date().toISOString()
    });
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body || {}) as JsonRpcRequest;
    const id = body.id ?? null;

    if (body.jsonrpc !== '2.0') {
      return res.json(jsonRpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0"'));
    }

    if (!body.method || typeof body.method !== 'string') {
      return res.json(jsonRpcError(id, -32600, 'Invalid Request: method is required'));
    }

    try {
      switch (body.method) {
        case 'initialize': {
          return res.json(jsonRpcResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            serverInfo: {
              name: 'suitecentral-mcp-server',
              version: gatewayEnabled ? '1.1.0' : '1.0.0'
            },
            capabilities: {
              tools: { listChanged: gatewayEnabled }
            }
          }));
        }

        case 'tools/list': {
          return res.json(jsonRpcResult(id, {
            tools: gatewayEnabled ? [...BASE_MCP_TOOLS, ...GATEWAY_MCP_TOOLS] : BASE_MCP_TOOLS,
          }));
        }

        case 'tools/call': {
          const params = (body.params || {}) as Record<string, unknown>;
          const toolName = typeof params.name === 'string' ? params.name : '';
          const args = (params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {}) as Record<string, unknown>;

          if (!toolName) {
            return res.json(jsonRpcError(id, -32602, 'Invalid params: name is required'));
          }

          const normalizedToolName = normalizeToolName(toolName);
          const toolResult = await executeTool({
            toolName: normalizedToolName,
            args,
            req,
            gatewayEnabled,
            logger,
            governanceService,
            orchestrator,
            syncOrchestrator,
            syncService,
            aggregatorService,
            policyService,
            auditService,
            costTrackingService,
          });

          return res.json(jsonRpcResult(id, toolResult));
        }

        default:
          return res.json(jsonRpcError(id, -32601, `Method not found: ${body.method}`));
      }
    } catch (error) {
      const rpcError = mapJsonRpcError(error);
      logger.error('MCP request failed', undefined, {
        method: body.method,
        error: error instanceof Error ? error.message : String(error)
      });

      return res.json(jsonRpcError(id, rpcError.code, rpcError.message));
    }
  }));

  return router;
}

async function executeTool(params: {
  toolName: string;
  args: Record<string, unknown>;
  req: Request;
  gatewayEnabled: boolean;
  logger: Logger;
  governanceService: GovernanceService;
  orchestrator: MultiAgentOrchestrator;
  syncOrchestrator: SyncCentralOrchestrator;
  syncService: SyncCentralService;
  aggregatorService?: MCPAggregatorService;
  policyService?: MCPPolicyService;
  auditService?: AuditService;
  costTrackingService?: CostTrackingService;
}): Promise<Record<string, unknown>> {
  const {
    toolName,
    args,
    req,
    gatewayEnabled,
    logger,
    governanceService,
    orchestrator,
    syncOrchestrator,
    syncService,
    aggregatorService,
    policyService,
    auditService,
    costTrackingService,
  } = params;

  switch (toolName) {
    case 'suitecentral.field_mapping_suggest': {
      const sourceSystem = String(args.sourceSystem || 'unknown');
      const targetSystem = String(args.targetSystem || 'unknown');
      const sourceFields = normalizeFields(args.sourceFields);
      const targetFields = normalizeFields(args.targetFields);
      const sampleData = Array.isArray(args.sampleData) ? args.sampleData : [];

      if (sourceFields.length === 0 || targetFields.length === 0) {
        throw new McpClientError(-32602, 'Invalid params: sourceFields and targetFields must be non-empty arrays');
      }

      // C5: identity from verified sources only — body-supplied `args.userId`
      // is attacker-controlled and is no longer trusted for audit attribution.
      // Anonymous callers receive SYSTEM_IDENTITY.userId ('__system__'), which
      // is the same audit-attribution token every other AI proxy route writes
      // for the unauthenticated case. The legacy 'mcp-client' default is dropped
      // intentionally — preserving it would leave one route in the AI proxy
      // family attributing anonymous calls to a fabricated identity, defeating
      // the consistent-audit-trail goal of this PR.
      const { userId } = extractIdentityContext(req);
      const context = buildMcpContext({
        userId,
        sourceSystem,
        targetSystem,
        businessProcess: 'mcp_field_mapping'
      });

      const preCheck = await governanceService.validateInput({
        sourceSystem,
        targetSystem,
        sourceFields,
        targetFields,
        sampleData
      }, context);

      if (!preCheck.approved) {
        return {
          content: [{ type: 'text', text: `Governance blocked request: ${preCheck.reason || 'policy violation'}` }],
          structuredContent: {
            blocked: true,
            governance: preCheck
          },
          isError: true
        };
      }

      const agentResult = await orchestrator.executeAgent('field-mapping', context, {
        sourceFields,
        targetFields,
        sampleData,
        validationRules: []
      });

      return {
        content: [{
          type: 'text',
          text: `Generated ${(agentResult.data as any)?.mappings?.length || 0} mappings with confidence ${(agentResult.confidence * 100).toFixed(1)}%`
        }],
        structuredContent: {
          success: agentResult.success,
          confidence: agentResult.confidence,
          reasoning: agentResult.reasoning,
          data: agentResult.data,
          governance: preCheck
        }
      };
    }

    case 'suitecentral.integration_status': {
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 25;
      const status = typeof args.status === 'string' ? args.status : undefined;
      const sourceSystem = typeof args.sourceSystem === 'string' ? args.sourceSystem : undefined;
      const customerId = typeof args.customerId === 'string' ? args.customerId : undefined;
      // C5: identity from verified sources only — anonymous callers
      // receive SYSTEM_IDENTITY.userId for consistent audit attribution.
      const { userId, tenantId: mcpTenantId } = extractIdentityContext(req);
      const context = buildMcpContext({
        userId,
        sourceSystem: sourceSystem || 'mcp',
        targetSystem: 'sync',
        businessProcess: 'mcp_integration_status'
      });

      const preCheck = await governanceService.validateInput({
        status,
        sourceSystem,
        customerId,
        limit,
      }, context);

      if (!preCheck.approved) {
        return {
          content: [{ type: 'text', text: `Governance blocked request: ${preCheck.reason || 'policy violation'}` }],
          structuredContent: {
            blocked: true,
            governance: preCheck
          },
          isError: true
        };
      }

      let operations: Awaited<ReturnType<typeof syncOrchestrator.getOperations>>;
      let subscriptions: Awaited<ReturnType<typeof syncService.getSubscriptions>>;
      try {
        [operations, subscriptions] = await Promise.all([
          syncOrchestrator.getOperations({ status, sourceSystem }),
          syncService.getSubscriptions(mcpTenantId, { customerId, status: status ? [status] : undefined, limit, offset: 0 })
        ]);
      } catch {
        throw new McpClientError(-32603, 'Failed to fetch integration status');
      }

      const operationSummary = {
        total: operations.length,
        active: operations.filter(op => op.status === 'active').length,
        paused: operations.filter(op => op.status === 'paused').length,
        error: operations.filter(op => op.status === 'error').length,
        pending: operations.filter(op => op.status === 'pending').length,
      };

      const subscriptionSummary = {
        totalCount: subscriptions.totalCount,
        pageCount: subscriptions.subscriptions.length,
        active: subscriptions.subscriptions.filter(s => s.status === 'active').length,
        suspended: subscriptions.subscriptions.filter(s => s.status === 'suspended').length,
        cancelled: subscriptions.subscriptions.filter(s => s.status === 'cancelled').length,
        pending: subscriptions.subscriptions.filter(s => s.status === 'pending').length,
      };

      return {
        content: [{
          type: 'text',
          text: `Operations: ${operationSummary.total} total (${operationSummary.active} active). Subscriptions: ${subscriptionSummary.totalCount} total (${subscriptionSummary.active} active on current page).`
        }],
        structuredContent: {
          operationSummary,
          subscriptionSummary,
          operations: operations.slice(0, limit),
          subscriptions: subscriptions.subscriptions.slice(0, limit),
          governance: preCheck,
        }
      };
    }

    case 'suitecentral.governance_check': {
      const input = (args.input && typeof args.input === 'object')
        ? args.input
        : {};

      // C5: identity from verified sources only — anonymous callers
      // receive SYSTEM_IDENTITY.userId for consistent audit attribution.
      const { userId } = extractIdentityContext(req);
      const context = buildMcpContext({
        userId,
        sourceSystem: String(args.sourceSystem || 'mcp'),
        targetSystem: String(args.targetSystem || 'mcp'),
        businessProcess: 'mcp_governance_check'
      });

      const check = await governanceService.validateInput(input, context);

      return {
        content: [{
          type: 'text',
          text: check.approved
            ? `Governance check approved (risk: ${check.riskLevel})`
            : `Governance check blocked: ${check.reason || 'policy violation'}`
        }],
        structuredContent: {
          approved: check.approved,
          reason: check.reason,
          riskLevel: check.riskLevel,
          flags: check.flags,
          complianceChecks: check.complianceChecks,
        },
        isError: !check.approved
      };
    }

    case 'suitecentral.mcp_discover': {
      if (!gatewayEnabled || !aggregatorService) {
        throw new McpClientError(-32601, 'Unknown or unsupported tool: suitecentral.mcp_discover');
      }

      const discovery = await aggregatorService.discoverAll();
      const mismatches = aggregatorService.getProtocolMismatches(MCP_PROTOCOL_VERSION);

      return {
        content: [{
          type: 'text',
          text: `Discovered ${discovery.tools.length} external tools across ${discovery.systems.length} adapter(s).`
        }],
        structuredContent: {
          tools: discovery.tools,
          systems: discovery.systems,
          protocolVersions: discovery.protocolVersions,
          protocolMismatches: mismatches,
        },
        protocolVersions: discovery.protocolVersions,
      };
    }

    case 'suitecentral.mcp_call': {
      if (!gatewayEnabled || !aggregatorService) {
        throw new McpClientError(-32601, 'Unknown or unsupported tool: suitecentral.mcp_call');
      }

      const requestedTool = typeof args.tool === 'string'
        ? args.tool
        : (typeof args.name === 'string' ? args.name : '');
      const requestedArgs = (args.arguments && typeof args.arguments === 'object')
        ? args.arguments as Record<string, unknown>
        : {};

      if (!requestedTool) {
        throw new McpClientError(-32602, 'Invalid params: tool is required');
      }

      const tenantId = getTenantId(req);
      const parsedTarget = parseNamespacedTool(requestedTool);
      const context = buildMcpContext({
        userId: tenantId,
        sourceSystem: 'suitecentral',
        targetSystem: parsedTarget.systemName,
        businessProcess: 'mcp_proxy_tool_call'
      });
      const span = mcpTracer.startSpan('mcp.proxy.call', {
        attributes: {
          'mcp.tool': requestedTool,
          'mcp.system': parsedTarget.systemName,
          'mcp.tenant_id': tenantId,
        },
      });

      try {
        const governance = await governanceService.validateInput({
          tool: requestedTool,
          arguments: requestedArgs,
        }, context);
        span.setAttribute('mcp.governance.approved', governance.approved);

        if (!governance.approved) {
          void auditService?.logGovernanceCheck({
            sessionId: context.sessionId,
            checkType: 'input',
            approved: false,
            reason: governance.reason,
            riskLevel: governance.riskLevel,
            flags: governance.flags,
            userId: tenantId,
          }).catch((): undefined => undefined);

          throw new McpClientError(-32602, `Governance blocked request: ${governance.reason || 'policy violation'}`);
        }

        let routerPolicyDecision: Awaited<ReturnType<typeof policyService.evaluateToolAccess>> | undefined;
        if (policyService) {
          routerPolicyDecision = await policyService.evaluateToolAccess(tenantId, parsedTarget.systemName, parsedTarget.toolName);
          span.setAttribute('mcp.policy.allowed', routerPolicyDecision.allowed);
          span.setAttribute('mcp.policy.reason', routerPolicyDecision.reason);
          if (!routerPolicyDecision.allowed) {
            void auditService?.logGovernanceCheck({
              sessionId: context.sessionId,
              checkType: 'input',
              approved: false,
              reason: routerPolicyDecision.reason,
              riskLevel: 'high',
              flags: ['mcp_policy_blocked'],
              userId: tenantId,
            }).catch((): undefined => undefined);

            throw new McpClientError(-32602, `Policy blocked tool ${requestedTool}: ${routerPolicyDecision.reason}`);
          }
        }

        const startedAt = Date.now();
        const result = await aggregatorService.callTool(requestedTool, requestedArgs, {
          tenantId,
          userId: tenantId,
          sessionId: context.sessionId,
          prevalidated: true,
          policyDecision: routerPolicyDecision,
        });
        const latencyMs = Date.now() - startedAt;
        span.setAttribute('mcp.latency_ms', latencyMs);

        if (costTrackingService) {
          void costTrackingService.recordCost({
            sessionId: context.sessionId,
            providerId: parsedTarget.systemName,
            requestId: `${context.sessionId}:${requestedTool}`,
            tokensUsed: 0,
            cost: 0,
            operation: 'mcp_proxy',
            sourceSystem: 'suitecentral',
            targetSystem: parsedTarget.systemName,
            userId: tenantId,
            responseTime: latencyMs,
            // tenantId already extracted via getTenantId(req) above
            tenantId: tenantId ?? SYSTEM_IDENTITY.tenantId,
            // MCP proxy records zero cost — no provider usage block
            costSource: 'estimated',
          }).catch(error => {
            logger.warn('Failed to record MCP proxy cost', {
              tool: requestedTool,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }

        void auditService?.logGovernanceCheck({
          sessionId: context.sessionId,
          checkType: 'input',
          approved: true,
          riskLevel: governance.riskLevel,
          flags: governance.flags,
          userId: tenantId,
        }).catch((): undefined => undefined);

        const piiDetected = Boolean(result.structuredContent?.pii && (result.structuredContent.pii as Record<string, unknown>).detected);
        const piiFindingsCount = Number(
          (result.structuredContent?.pii as Record<string, unknown> | undefined)?.findingsCount || 0
        );
        span.setAttribute('mcp.pii.detected', piiDetected);
        span.setAttribute('mcp.pii.findings_count', piiFindingsCount);
        span.setStatus({ code: SpanStatusCode.OK });

        return toJsonRecord({
          ...result,
          structuredContent: {
            ...(result.structuredContent || {}),
            governance,
            tenantId,
            latencyMs,
          },
        });
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    }

    default:
      throw new McpClientError(-32601, `Unknown or unsupported tool: ${toolName}`);
  }
}

function toJsonRecord(value: MCPToolResult | Record<string, unknown>): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();
  return TOOL_ALIASES[normalized] || normalized;
}

function parseNamespacedTool(name: string): { systemName: string; toolName: string } {
  const separatorIndex = name.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === name.length - 1) {
    throw new McpClientError(-32602, 'Invalid params: expected namespaced tool format "system.tool"');
  }

  return {
    systemName: name.slice(0, separatorIndex),
    toolName: name.slice(separatorIndex + 1),
  };
}

function normalizeFields(value: unknown): FieldDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(v => v && typeof v === 'object')
    .map(v => {
      const field = v as Record<string, unknown>;
      return {
        name: String(field.name || '').trim(),
        type: String(field.type || 'string'),
        description: typeof field.description === 'string' ? field.description : undefined,
        required: typeof field.required === 'boolean' ? field.required : undefined,
      } as FieldDefinition;
    })
    .filter(f => f.name.length > 0);
}

function buildMcpContext(input: {
  userId: string;
  sourceSystem: string;
  targetSystem: string;
  businessProcess: string;
}): AgentExecutionContext {
  const sessionId = `mcp_${randomUUID()}`;

  return {
    sessionId,
    userId: input.userId,
    sourceSystem: input.sourceSystem,
    targetSystem: input.targetSystem,
    businessProcess: input.businessProcess,
    correlationId: sessionId,
    timestamp: new Date(),
    confidenceThreshold: 0.5,
    maxExecutionTime: 30000,
    metadata: {
      source: 'mcp',
      protocolVersion: MCP_PROTOCOL_VERSION,
    }
  };
}

function isAdminTenantHeaderTrusted(req: Request): boolean {
  const user = req.user as (Request['user'] & {
    roles?: string[];
    permissions?: string[];
  }) | undefined;

  const userRoles = Array.isArray(user?.roles) ? user.roles : [];
  const userPermissions = Array.isArray(user?.permissions) ? user.permissions : [];
  const authPermissions = Array.isArray(req.auth?.permissions) ? req.auth.permissions : [];

  return userRoles.includes('admin') || userPermissions.includes('*') || authPermissions.includes('*');
}

function getTenantId(req: Request): string {
  if (typeof req.auth?.tenantId === 'string' && req.auth.tenantId.trim().length > 0) {
    return req.auth.tenantId.trim();
  }

  const tenantContext = (req as Request & {
    tenantContext?: {
      tenantId?: string;
      organizationId?: string;
    };
  }).tenantContext;

  if (tenantContext?.tenantId) {
    return tenantContext.tenantId;
  }

  if (tenantContext?.organizationId) {
    return tenantContext.organizationId;
  }

  const user = req.user as (Request['user'] & { tenantId?: string }) | undefined;
  if (typeof user?.tenantId === 'string' && user.tenantId.trim().length > 0) {
    return user.tenantId.trim();
  }

  const userId = req.user?.id;
  if (typeof userId === 'string' && userId.trim().length > 0) {
    return userId.trim();
  }

  if (typeof userId === 'number') {
    return String(userId);
  }

  // Headers are only trusted as an admin/service fallback when verified tenant context is unavailable.
  if (isAdminTenantHeaderTrusted(req)) {
    // allow-identity-header-read: admin-role-gated fallback inside getTenantId, only reached after req.auth / req.tenantContext / req.user are exhausted
    const headerTenant = req.headers['x-tenant-id'];
    if (typeof headerTenant === 'string' && headerTenant.trim().length > 0) {
      return headerTenant.trim();
    }

    // allow-identity-header-read: parallel admin-gated fallback when x-tenant-id is absent (same admin-role check above)
    const headerOrg = req.headers['x-organization-id'];
    if (typeof headerOrg === 'string' && headerOrg.trim().length > 0) {
      return headerOrg.trim();
    }
  }

  return 'default';
}

function mapJsonRpcError(error: unknown): { code: number; message: string } {
  if (error instanceof McpClientError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof McpAggregatorError) {
    return { code: error.code, message: error.message };
  }

  return { code: -32603, message: GENERIC_INTERNAL_ERROR_MESSAGE };
}

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  };
}
