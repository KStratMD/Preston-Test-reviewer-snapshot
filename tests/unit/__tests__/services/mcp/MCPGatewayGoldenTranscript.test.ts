import { MCPAggregatorService } from '../../../../../src/services/mcp/MCPAggregatorService';
import type { IMCPAdapter, MCPToolResult } from '../../../../../src/services/mcp/IMCPAdapter';
import type { Logger } from '../../../../../src/utils/Logger';
import type { GovernanceService } from '../../../../../src/services/ai/orchestrator/GovernanceService';
import type { DLPService } from '../../../../../src/services/security/DLPService';

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

describe('MCPGateway Golden Transcripts', () => {
  it('produces deterministic redaction transcript output for proxied reads', async () => {
    const logger = createMockLogger();

    const governanceService = {
      validateInput: jest.fn().mockResolvedValue({
        approved: true,
        flags: [],
        riskLevel: 'low',
        complianceChecks: [],
      }),
      getPostureForTenant: jest.fn().mockResolvedValue({
        allowPII: false,
        blockOnDetection: false,
        autoRedact: true,
        piiTypes: [],
      }),
    } as unknown as GovernanceService;

    const dlpService = {
      scanForPII: jest.fn().mockResolvedValue({
        detected: true,
        piiTypes: ['email'],
        findings: [
          {
            type: 'email',
            value: 'alice@example.com',
            confidence: 0.99,
            location: { path: 'content[0].text' },
            severity: 'medium',
            redactedValue: 'a***@example.com',
          },
        ],
        riskLevel: 'medium',
        recommendation: 'redact',
        redactedData: {
          content: [{ type: 'text', text: 'customer email: a***@example.com' }],
          structuredContent: { source: 'adapter', safe: true },
        },
      }),
      redactData: jest.fn().mockReturnValue({
        content: [{ type: 'text', text: 'customer email: a***@example.com' }],
        structuredContent: { source: 'adapter', safe: true },
      }),
    } as unknown as DLPService;

    const policyService = {
      evaluateToolAccess: jest.fn().mockResolvedValue({
        allowed: true,
        reason: 'db_allow:10',
        matchedAllowPattern: 'netsuite.ns_getRecord',
      }),
    };

    const adapter: IMCPAdapter = {
      systemName: 'netsuite',
      protocolVersion: '2025-06-18',
      readOnlyTools: new Set(['ns_getRecord']),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      listTools: jest.fn().mockResolvedValue([
        { name: 'ns_getRecord', description: 'Read record', inputSchema: {} },
      ]),
      callTool: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'customer email: alice@example.com' }],
        structuredContent: { source: 'adapter', safe: false },
      } as MCPToolResult),
      getHealth: jest.fn().mockResolvedValue({ connected: true, latencyMs: 3 }),
    };

    const service = new MCPAggregatorService(
      logger,
      governanceService,
      dlpService,
      policyService as any,
      undefined,
      [adapter]
    );

    const result = await service.callTool('netsuite.ns_getRecord', { id: '123' }, {
      tenantId: 'tenant-golden',
      sessionId: 'mcp_transcript_1',
      prevalidated: true,
      policyDecision: {
        allowed: true,
        reason: 'db_allow:10',
        matchedAllowPattern: 'netsuite.ns_getRecord',
      },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'customer email: a***@example.com' }],
      structuredContent: {
        source: 'adapter',
        safe: true,
        policy: {
          allowed: true,
          reason: 'db_allow:10',
          matchedAllowPattern: 'netsuite.ns_getRecord',
        },
        pii: {
          detected: true,
          riskLevel: 'low',
          findingsCount: 1,
          detectedCount: 1,
        },
      },
    });
  });

  it('produces deterministic governance-block transcript for rejected inputs', async () => {
    const logger = createMockLogger();

    const governanceService = {
      validateInput: jest.fn().mockResolvedValue({
        approved: false,
        reason: 'policy_violation',
        flags: ['policy_violation'],
        riskLevel: 'high',
        complianceChecks: [],
      }),
      getPostureForTenant: jest.fn().mockResolvedValue({
        allowPII: false,
        blockOnDetection: false,
        autoRedact: true,
        piiTypes: [],
      }),
    } as unknown as GovernanceService;

    const dlpService = {
      scanForPII: jest.fn(),
      redactData: jest.fn(),
    } as unknown as DLPService;

    const adapter: IMCPAdapter = {
      systemName: 'netsuite',
      protocolVersion: '2025-06-18',
      readOnlyTools: new Set(['ns_getRecord']),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      listTools: jest.fn().mockResolvedValue([]),
      callTool: jest.fn(),
      getHealth: jest.fn().mockResolvedValue({ connected: true, latencyMs: 2 }),
    };

    const service = new MCPAggregatorService(
      logger,
      governanceService,
      dlpService,
      undefined,
      undefined,
      [adapter]
    );

    await expect(service.callTool('netsuite.ns_getRecord', { id: '123' }, {
      tenantId: 'tenant-golden',
      sessionId: 'mcp_transcript_2',
      prevalidated: false,
    })).rejects.toMatchObject({
      code: -32602,
      message: 'Governance blocked request: policy_violation',
    });
  });
});
