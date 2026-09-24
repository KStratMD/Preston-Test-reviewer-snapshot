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
import { SYSTEM_IDENTITY, DEMO_ACTOR_ID } from '../../services/governance/identityContext';
import { verifiedUserId, verifiedIdentity } from '../utils/verifiedIdentity';
import { isAnonymousRequest } from '../../middleware/aiProxyPolicyGate';
import { buildRuleBasedDemoMappings } from '../../services/ai/demoMappingFixture';
import { isPlatformAdminActor } from '../../middleware/verifiedAdmin';

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

/**
 * F2: the tool surface advertised to ANONYMOUS demo sessions, independent of
 * live-gateway configuration — mcp_discover is fixture-backed for them, and
 * mcp_call is refused, so it is not advertised.
 */
const ANONYMOUS_DEMO_MCP_TOOLS: readonly McpToolDefinition[] = [
  ...BASE_MCP_TOOLS,
  ...GATEWAY_MCP_TOOLS.filter((tool) => tool.name === 'suitecentral.mcp_discover'),
];

function toolsForRequest(req: Request, gatewayEnabled: boolean): readonly McpToolDefinition[] {
  if (isAnonymousRequest(req)) return ANONYMOUS_DEMO_MCP_TOOLS;
  return gatewayEnabled ? [...BASE_MCP_TOOLS, ...GATEWAY_MCP_TOOLS] : BASE_MCP_TOOLS;
}

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

  router.get('/tools', asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools: toolsForRequest(req, gatewayEnabled),
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
            tools: toolsForRequest(req, gatewayEnabled),
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

      // F2 zero-spend ruling: anonymous sessions get a deterministic
      // rule-based mapping — the orchestrator (and any provider) is never
      // invoked without identity.
      if (isAnonymousRequest(req)) {
        return buildAnonymousDemoMappingResult(sourceFields, targetFields);
      }

      // F6: identity from the VERIFIED req.user only — body-supplied
      // `args.userId` is attacker-controlled and is not trusted for audit
      // attribution. Anonymous callers are diverted above
      // (buildAnonymousDemoMappingResult) and never reach here, so there is no
      // longer a SYSTEM_IDENTITY fallback: a null identity means the router was
      // mounted without its policy gate, and is refused as a tool error.
      const userId = verifiedUserId(req);
      if (userId === null) {
        return {
          content: [{ type: 'text', text: 'Authentication required: identity_required' }],
          structuredContent: { error: 'identity_required' },
          isError: true,
        };
      }
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
      // F2 ruling: anonymous sessions get a static demo fixture — the shared
      // SyncCentralOrchestrator operation map and the tenant subscription
      // store are NEVER read anonymously. A deployment flag is not a
      // data-isolation boundary; the fixture is.
      if (isAnonymousRequest(req)) {
        return DEMO_INTEGRATION_STATUS_FIXTURE();
      }

      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 25;
      const status = typeof args.status === 'string' ? args.status : undefined;
      const sourceSystem = typeof args.sourceSystem === 'string' ? args.sourceSystem : undefined;
      const customerId = typeof args.customerId === 'string' ? args.customerId : undefined;
      // F6: identity from the VERIFIED req.user only. Anonymous callers no
      // longer receive SYSTEM_IDENTITY.userId — they are diverted to fixtures
      // or DEMO_ACTOR_ID before reaching here, so a null identity means a
      // mount regression and is refused as a tool error.
      const identity = verifiedIdentity(req);
      if (identity === null) {
        return {
          content: [{ type: 'text', text: 'Authentication required: identity_required' }],
          structuredContent: { error: 'identity_required' },
          isError: true,
        };
      }
      const { userId, tenantId: mcpTenantId } = identity;
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

      // v4 (Codex v3 finding 2): SyncOperation carries no tenantId, so the
      // raw global operation map cannot be tenant-filtered — it is
      // platform-admin-only. Ordinary tenants get their own subscriptions
      // (already scoped by mcpTenantId) and an explicit withheld marker.
      // Real tenant ownership on operations is a schema change deferred
      // past F2.
      const callerIsPlatformAdmin = isPlatformAdminActor(req.user);

      let operations: Awaited<ReturnType<typeof syncOrchestrator.getOperations>> | undefined;
      let subscriptions: Awaited<ReturnType<typeof syncService.getSubscriptions>>;
      try {
        [operations, subscriptions] = await Promise.all([
          callerIsPlatformAdmin
            ? syncOrchestrator.getOperations({ status, sourceSystem })
            : Promise.resolve(undefined),
          syncService.getSubscriptions(mcpTenantId, { customerId, status: status ? [status] : undefined, limit, offset: 0 })
        ]);
      } catch {
        throw new McpClientError(-32603, 'Failed to fetch integration status');
      }

      const subscriptionSummary = {
        totalCount: subscriptions.totalCount,
        pageCount: subscriptions.subscriptions.length,
        active: subscriptions.subscriptions.filter(s => s.status === 'active').length,
        suspended: subscriptions.subscriptions.filter(s => s.status === 'suspended').length,
        cancelled: subscriptions.subscriptions.filter(s => s.status === 'cancelled').length,
        pending: subscriptions.subscriptions.filter(s => s.status === 'pending').length,
      };

      if (operations === undefined) {
        return {
          content: [{
            type: 'text',
            text: `Subscriptions: ${subscriptionSummary.totalCount} total (${subscriptionSummary.active} active on current page). Global operations withheld (platform-admin only).`
          }],
          structuredContent: {
            operationsWithheld: true,
            subscriptionSummary,
            subscriptions: subscriptions.subscriptions.slice(0, limit),
            governance: preCheck,
          }
        };
      }

      const operationSummary = {
        total: operations.length,
        active: operations.filter(op => op.status === 'active').length,
        paused: operations.filter(op => op.status === 'paused').length,
        error: operations.filter(op => op.status === 'error').length,
        pending: operations.filter(op => op.status === 'pending').length,
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

      // F2 (decision 10): attribution-only demo actor; never a tenant identity.
      // Authenticated callers keep C5's verified-source identity extraction.
      const userId = isAnonymousRequest(req)
        ? DEMO_ACTOR_ID
        : verifiedUserId(req);
      if (userId === null) {
        return {
          content: [{ type: 'text', text: 'Authentication required: identity_required' }],
          structuredContent: { error: 'identity_required' },
          isError: true,
        };
      }
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
      // F2 ruling: anonymous sessions get a static demo inventory — live
      // adapter/tool discovery requires authentication.
      if (isAnonymousRequest(req)) {
        return DEMO_MCP_DISCOVER_FIXTURE();
      }

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
      // F2 ruling: arbitrary external ERP-tool dispatch requires identity.
      if (isAnonymousRequest(req)) {
        throw new McpClientError(-32001, 'Authentication required: suitecentral.mcp_call is not available to anonymous sessions');
      }

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
            tenantId,
            sessionId: context.sessionId,
            checkType: 'input',
            approved: false,
            reason: governance.reason,
            riskLevel: governance.riskLevel,
            flags: governance.flags,
            userId: tenantId,
          }).catch(error => {
            logger.warn('Failed to persist MCP governance audit row', {
              tool: requestedTool,
              approved: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });

          throw new McpClientError(-32602, `Governance blocked request: ${governance.reason || 'policy violation'}`);
        }

        let routerPolicyDecision: Awaited<ReturnType<MCPPolicyService['evaluateToolAccess']>> | undefined;
        if (policyService) {
          routerPolicyDecision = await policyService.evaluateToolAccess(tenantId, parsedTarget.systemName, parsedTarget.toolName);
          span.setAttribute('mcp.policy.allowed', routerPolicyDecision.allowed);
          span.setAttribute('mcp.policy.reason', routerPolicyDecision.reason);
          if (!routerPolicyDecision.allowed) {
            void auditService?.logGovernanceCheck({
              tenantId,
              sessionId: context.sessionId,
              checkType: 'input',
              approved: false,
              reason: routerPolicyDecision.reason,
              riskLevel: 'high',
              flags: ['mcp_policy_blocked'],
              userId: tenantId,
            }).catch(error => {
              logger.warn('Failed to persist MCP governance audit row', {
                tool: requestedTool,
                approved: false,
                error: error instanceof Error ? error.message : String(error),
              });
            });

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
          tenantId,
          sessionId: context.sessionId,
          checkType: 'input',
          approved: true,
          riskLevel: governance.riskLevel,
          flags: governance.flags,
          userId: tenantId,
        }).catch(error => {
          logger.warn('Failed to persist MCP governance audit row', {
            tool: requestedTool,
            approved: true,
            error: error instanceof Error ? error.message : String(error),
          });
        });

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

/**
 * F1 (design D4) + F2 (design D5-F2): canonical whole-source order
 * req.auth → req.user.tenantId → req.tenantContext. The user.id fallback
 * (F1), the admin x-tenant-id/x-organization-id header fallback (F2), and
 * the terminal 'default' bucket (F2) are all DELETED — the header and
 * default paths became unreachable behind mountAiProxyRoutes (tenant-less
 * tokens 403 at the fail-closed kill switch; anonymous sessions cannot
 * invoke mcp_call, the only getTenantId caller), so resolution now fails
 * closed instead of minting a shared pseudo-tenant.
 */
function getTenantId(req: Request): string {
  if (typeof req.auth?.tenantId === 'string' && req.auth.tenantId.trim().length > 0) {
    return req.auth.tenantId.trim();
  }

  const user = req.user as (Request['user'] & { tenantId?: string }) | undefined;
  if (typeof user?.tenantId === 'string' && user.tenantId.trim().length > 0) {
    return user.tenantId.trim();
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

  // F2: fail closed. Post-gate an authenticated request always carries a
  // tenant (tenant-less tokens 403 at the kill switch), and anonymous
  // sessions never reach the tools that call getTenantId (mcp_call is
  // refused). Reaching this line means a wiring bug — refuse rather than
  // inventing a bucket.
  throw new McpClientError(-32001, 'tenant_required: no verified tenant in request context');
}

/** F2: static anonymous-demo responses (decision-6 ruling). Shapes mirror the real handlers. */
function DEMO_INTEGRATION_STATUS_FIXTURE() {
  const operations = [
    { id: 'demo-op-1', status: 'active', sourceSystem: 'salesforce', targetSystem: 'netsuite', entity: 'Customer' },
    { id: 'demo-op-2', status: 'active', sourceSystem: 'shopify', targetSystem: 'business_central', entity: 'Order' },
    { id: 'demo-op-3', status: 'paused', sourceSystem: 'hubspot', targetSystem: 'netsuite', entity: 'Contact' },
  ];
  const subscriptions = [
    { id: 'demo-sub-1', status: 'active', customerId: 'demo-customer-1' },
    { id: 'demo-sub-2', status: 'active', customerId: 'demo-customer-2' },
  ];
  // Summaries are DERIVED from the arrays (not hard-coded) so the fixture
  // stays self-consistent if the demo rows change (Copilot R5).
  const countBy = (rows: { status: string }[], status: string) => rows.filter((r) => r.status === status).length;
  const operationSummary = {
    total: operations.length,
    active: countBy(operations, 'active'),
    paused: countBy(operations, 'paused'),
    error: countBy(operations, 'error'),
    pending: countBy(operations, 'pending'),
  };
  const subscriptionSummary = {
    totalCount: subscriptions.length,
    pageCount: subscriptions.length,
    active: countBy(subscriptions, 'active'),
    suspended: countBy(subscriptions, 'suspended'),
    cancelled: countBy(subscriptions, 'cancelled'),
    pending: countBy(subscriptions, 'pending'),
  };
  return {
    content: [{
      type: 'text',
      text: `Operations: ${operationSummary.total} total (${operationSummary.active} active). Subscriptions: ${subscriptionSummary.totalCount} total (${subscriptionSummary.active} active on current page). [demo fixture]`,
    }],
    structuredContent: {
      demoFixture: true,
      operationSummary,
      subscriptionSummary,
      operations,
      subscriptions,
    },
  };
}

function DEMO_MCP_DISCOVER_FIXTURE() {
  return {
    content: [{ type: 'text', text: 'Discovered 2 external tools across 1 adapter(s). [demo fixture]' }],
    structuredContent: {
      demoFixture: true,
      tools: [{ name: 'netsuite.ns_getRecord' }, { name: 'netsuite.ns_searchRecords' }],
      systems: [{ system: 'netsuite', status: 'available', toolCount: 2 }],
      protocolVersions: { netsuite: MCP_PROTOCOL_VERSION },
      protocolMismatches: [] as { system: string; expectedVersion: string; adapterVersion: string }[],
    },
    protocolVersions: { netsuite: MCP_PROTOCOL_VERSION },
  };
}

/** F2 zero-spend: deterministic name-similarity mapping for anonymous demo calls. */
function buildAnonymousDemoMappingResult(sourceFields: FieldDefinition[], targetFields: FieldDefinition[]) {
  const mappings = buildRuleBasedDemoMappings(sourceFields, targetFields);
  const confidence = mappings.length > 0
    ? mappings.reduce((sum, mapping) => sum + mapping.confidence, 0) / mappings.length
    : 0;
  return {
    content: [{ type: 'text', text: `Generated ${mappings.length} mappings with confidence ${(confidence * 100).toFixed(1)}% [demo fixture — rule-based]` }],
    structuredContent: {
      demoFixture: true,
      success: true,
      confidence,
      reasoning: ['anonymous demo session: rule-based name-similarity mapping; no AI provider invoked'],
      data: { mappings },
    },
  };
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
