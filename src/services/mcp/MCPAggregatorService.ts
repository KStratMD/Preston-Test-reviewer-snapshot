import { randomUUID } from 'crypto';
import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { GovernanceService } from '../ai/orchestrator/GovernanceService';
import type { AgentExecutionContext } from '../ai/orchestrator/interfaces';
import type { AuditService } from '../ai/orchestrator/AuditService';
import type { DLPService } from '../security/DLPService';
import type { IMCPAdapter, MCPTool, MCPToolResult } from './IMCPAdapter';
import type { MCPPolicyDecision, MCPPolicyService } from './MCPPolicyService';
import { classifyFindingsRisk } from '../security/findingsRiskClassifier';

export interface NamespacedTool extends MCPTool {
  system: string;
  originalName: string;
  readOnly: boolean;
}

export interface AdapterDiscoveryStatus {
  system: string;
  status: 'available' | 'unavailable';
  toolCount?: number;
  error?: string;
}

export interface MCPDiscoveryResult {
  tools: NamespacedTool[];
  systems: AdapterDiscoveryStatus[];
  protocolVersions: Record<string, string>;
}

export interface MCPCallContext {
  tenantId: string;
  userId?: string;
  sessionId?: string;
  allowWriteTools?: boolean;
  /** When true, skip both governance AND policy checks (caller already performed them). */
  prevalidated?: boolean;
  /** Policy decision from the caller — attached to the result when prevalidated. */
  policyDecision?: MCPPolicyDecision;
}

export class McpAggregatorError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'McpAggregatorError';
  }
}

@injectable()
export class MCPAggregatorService {
  private readonly adapters = new Map<string, IMCPAdapter>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.GovernanceService) private readonly governanceService: GovernanceService,
    @inject(TYPES.DLPService) private readonly dlpService: DLPService,
    @optional() @inject(TYPES.MCPPolicyService) private readonly policyService?: MCPPolicyService,
    @optional() @inject(TYPES.AuditService) private readonly auditService?: AuditService,
    adapters: IMCPAdapter[] = []
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.systemName, adapter);
    }
  }

  registerAdapter(adapter: IMCPAdapter): void {
    this.adapters.set(adapter.systemName, adapter);
  }

  getVersionMatrix(): Record<string, string> {
    const versionMatrix: Record<string, string> = {};
    for (const adapter of this.adapters.values()) {
      versionMatrix[adapter.systemName] = adapter.protocolVersion;
    }
    return versionMatrix;
  }

  getProtocolMismatches(expectedVersion: string): {
    system: string;
    expectedVersion: string;
    adapterVersion: string;
  }[] {
    return Array.from(this.adapters.values())
      .filter(adapter => adapter.protocolVersion !== expectedVersion)
      .map(adapter => ({
        system: adapter.systemName,
        expectedVersion,
        adapterVersion: adapter.protocolVersion,
      }));
  }

  async discoverAll(): Promise<MCPDiscoveryResult> {
    const tools: NamespacedTool[] = [];
    const systems: AdapterDiscoveryStatus[] = [];

    await Promise.all(Array.from(this.adapters.values()).map(async adapter => {
      try {
        const adapterTools = await adapter.listTools();
        const namespaced = adapterTools.map(tool => ({
          ...tool,
          system: adapter.systemName,
          originalName: tool.name,
          name: `${adapter.systemName}.${tool.name}`,
          readOnly: adapter.readOnlyTools.has(tool.name),
        }));

        tools.push(...namespaced);
        systems.push({
          system: adapter.systemName,
          status: 'available',
          toolCount: adapterTools.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        systems.push({
          system: adapter.systemName,
          status: 'unavailable',
          error: message,
        });
        this.logger.warn('MCP adapter discovery unavailable', {
          system: adapter.systemName,
          error: message,
        });
      }
    }));

    return {
      tools,
      systems,
      protocolVersions: this.getVersionMatrix(),
    };
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    context: MCPCallContext
  ): Promise<MCPToolResult> {
    const parsed = this.parseNamespacedToolName(namespacedName);
    const adapter = this.adapters.get(parsed.systemName);

    if (!adapter) {
      throw new McpAggregatorError(-32601, `Unknown adapter system: ${parsed.systemName}`);
    }
    const requestSessionId = context.sessionId || `mcp_${randomUUID()}`;

    let policyDecision: MCPPolicyDecision | undefined;
    if (context.prevalidated) {
      // Caller already evaluated policy — reuse their decision for result metadata.
      policyDecision = context.policyDecision;
      // Defensive fallback: prevalidated callers should still never bypass write/read controls.
      if (!policyDecision && this.policyService) {
        policyDecision = await this.policyService.evaluateToolAccess(
          context.tenantId,
          parsed.systemName,
          parsed.toolName
        );
      }

      if (policyDecision && !policyDecision.allowed) {
        throw new McpAggregatorError(-32602, `Policy blocked tool call: ${policyDecision.reason}`, {
          system: parsed.systemName,
          tool: parsed.toolName,
          tenantId: context.tenantId,
        });
      }

      if (!policyDecision && !context.allowWriteTools && !adapter.readOnlyTools.has(parsed.toolName)) {
        throw new McpAggregatorError(-32602, 'write_tools_disabled', {
          system: parsed.systemName,
          tool: parsed.toolName,
        });
      }
    } else if (this.policyService) {
      policyDecision = await this.policyService.evaluateToolAccess(
        context.tenantId,
        parsed.systemName,
        parsed.toolName
      );

      if (!policyDecision.allowed) {
        throw new McpAggregatorError(-32602, `Policy blocked tool call: ${policyDecision.reason}`, {
          system: parsed.systemName,
          tool: parsed.toolName,
          tenantId: context.tenantId,
        });
      }
    } else if (!context.allowWriteTools && !adapter.readOnlyTools.has(parsed.toolName)) {
      throw new McpAggregatorError(-32602, 'write_tools_disabled', {
        system: parsed.systemName,
        tool: parsed.toolName,
      });
    }

    if (!context.prevalidated) {
      const governance = await this.governanceService.validateInput(
        {
          tool: namespacedName,
          arguments: args,
        },
        this.buildContext(context, parsed.systemName, requestSessionId)
      );

      if (!governance.approved) {
        throw new McpAggregatorError(-32602, `Governance blocked request: ${governance.reason || 'policy violation'}`);
      }
    }

    try {
      const toolResult = await adapter.callTool(parsed.toolName, args);
      const posture = await this.governanceService.getPostureForTenant(context.tenantId);

      // D4: posture.allowPII bypasses scan but preserves the structuredContent.pii envelope
      if (posture.allowPII) {
        const normalized = this.normalizeToolResult(toolResult);
        normalized.structuredContent = {
          ...(normalized.structuredContent || {}),
          policy: policyDecision,
          pii: { detected: false, riskLevel: 'none', findingsCount: 0, bypassReason: 'tenant_allow_pii' },
        };
        this.recordAudit(context, namespacedName, false, requestSessionId);
        return normalized;
      }

      // Keep direct scanForPII to preserve audit shape (scoping memo top risk #2).
      // Hardcoded scan policy stays — posture filtering happens at the decision layer
      // over the returned findings, NOT at the scan-policy layer.
      const piiScan = await this.dlpService.scanForPII(toolResult, {
        allowPII: false, piiTypes: [], autoRedact: false, blockOnDetection: false,
      });
      if (piiScan.scanFailed) {
        this.recordAudit(context, namespacedName, true, requestSessionId);
        throw new McpAggregatorError(-32603, 'DLP scan failed; refusing to surface unscanned tool result');
      }
      // autoRedact:false above — we want raw findings so we can narrow by posture.piiTypes
      // before deciding what to redact. The pre-C3.1b path used autoRedact:true which
      // produced a redactedData covering all findings; that would over-redact when the
      // tenant has narrowed posture.piiTypes.

      const relevantFindings = posture.piiTypes.length === 0
        ? piiScan.findings
        : piiScan.findings.filter(f => posture.piiTypes.includes(f.type));

      if (relevantFindings.length > 0 && posture.blockOnDetection) {
        this.recordAudit(context, namespacedName, true, requestSessionId);
        throw new McpAggregatorError(-32602, 'Governance blocked tool result: posture.blockOnDetection');
      }
      if (relevantFindings.length > 0 && !posture.autoRedact) {
        // Fail-safe: PII detected, redaction disabled, no block configured → refuse
        // rather than surfacing raw PII downstream to the agent.
        this.recordAudit(context, namespacedName, true, requestSessionId);
        throw new McpAggregatorError(-32602, 'Governance blocked tool result: PII detected, posture.autoRedact=false');
      }

      let safeResult = toolResult;
      if (relevantFindings.length > 0) {
        const redacted = this.dlpService.redactData(toolResult, relevantFindings) as MCPToolResult | undefined;
        if (redacted === undefined) {
          this.recordAudit(context, namespacedName, true, requestSessionId);
          throw new McpAggregatorError(-32603, 'DLP redaction produced no output; refusing to surface raw tool result');
        }
        safeResult = redacted;
      }
      const normalized = this.normalizeToolResult(safeResult);

      // classifyRisk on the FILTERED findings, not the raw scan
      const riskLevel = relevantFindings.length === 0
        ? 'none'
        : classifyFindingsRisk(relevantFindings);

      normalized.structuredContent = {
        ...(normalized.structuredContent || {}),
        policy: policyDecision,
        pii: {
          detected: relevantFindings.length > 0,
          riskLevel,
          findingsCount: relevantFindings.length,
          // Audit-visibility for posture narrowing — see D2.
          detectedCount: piiScan.findings.length,
          ...(piiScan.findings.length > 0 && relevantFindings.length === 0
            ? { bypassReason: 'posture_pii_types_filtered_all' }
            : {}),
        },
      };

      this.recordAudit(context, namespacedName, relevantFindings.length > 0, requestSessionId);

      return normalized;
    } catch (error) {
      if (error instanceof McpAggregatorError) {
        throw error;
      }

      throw new McpAggregatorError(-32603, error instanceof Error ? error.message : String(error));
    }
  }

  private parseNamespacedToolName(name: string): { systemName: string; toolName: string } {
    if (!name || !name.trim()) {
      throw new McpAggregatorError(-32602, 'Invalid params: tool name is required');
    }

    const separatorIndex = name.indexOf('.');
    if (separatorIndex <= 0 || separatorIndex === name.length - 1) {
      throw new McpAggregatorError(-32602, 'Invalid params: expected namespaced tool format "system.tool"');
    }

    return {
      systemName: name.slice(0, separatorIndex),
      toolName: name.slice(separatorIndex + 1),
    };
  }

  private buildContext(context: MCPCallContext, targetSystem: string, sessionId: string): AgentExecutionContext {
    return {
      sessionId,
      userId: context.userId || context.tenantId,
      sourceSystem: 'mcp',
      targetSystem,
      businessProcess: 'mcp_gateway_proxy',
      correlationId: sessionId,
      timestamp: new Date(),
      confidenceThreshold: 0.5,
      maxExecutionTime: 30000,
      metadata: {
        source: 'mcp_aggregator',
      },
    };
  }

  private normalizeToolResult(result: MCPToolResult): MCPToolResult {
    const content = Array.isArray(result.content)
      ? result.content
      : [{ type: 'text', text: JSON.stringify(result) }];

    return {
      ...result,
      content,
      structuredContent: result.structuredContent && typeof result.structuredContent === 'object'
        ? result.structuredContent
        : undefined,
    };
  }

  private recordAudit(
    context: MCPCallContext,
    namespacedTool: string,
    piiDetected: boolean,
    sessionId: string
  ): void {
    if (!this.auditService) {
      return;
    }

    const lower = namespacedTool.toLowerCase();
    const action = /create|update|delete|write|invoke/.test(lower) ? 'write' : 'read';

    void this.auditService.logDataAccess({
      tenantId: context.tenantId,
      sessionId,
      userId: context.userId,
      dataType: 'mcp_tool_result',
      action,
      resource: namespacedTool,
      dataClassification: piiDetected ? 'restricted' : 'internal',
    }).catch(error => {
      this.logger.warn('Failed to write MCP audit record', {
        tool: namespacedTool,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
