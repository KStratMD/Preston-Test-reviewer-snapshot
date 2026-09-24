import 'reflect-metadata';
import { MCPAggregatorService, McpAggregatorError } from '../../../../../src/services/mcp/MCPAggregatorService';
import type { IMCPAdapter, MCPTool, MCPToolResult } from '../../../../../src/services/mcp/IMCPAdapter';
import type { Logger } from '../../../../../src/utils/Logger';
import type { GovernanceService, TenantGovernancePosture } from '../../../../../src/services/ai/orchestrator/GovernanceService';
import type { DLPService, PIIDetectionResult } from '../../../../../src/services/security/DLPService';
import type { AuditService } from '../../../../../src/services/ai/orchestrator/AuditService';
import type { PIIFinding } from '../../../../../src/services/security/DLPService';

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
  tools?: MCPTool[];
  callToolResult?: MCPToolResult;
}): IMCPAdapter {
  const tools = config.tools || [];
  return {
    systemName: config.systemName,
    protocolVersion: '2025-11-25',
    readOnlyTools: new Set(tools.map(tool => tool.name)),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue(tools),
    callTool: jest.fn().mockResolvedValue(config.callToolResult || {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    }),
    getHealth: jest.fn().mockResolvedValue({ connected: true, latencyMs: 5 }),
  };
}

describe('MCPAggregatorService — Per-Tenant Posture Integration', () => {
  let logger: jest.Mocked<Logger>;
  let auditService: jest.Mocked<Pick<AuditService, 'logDataAccess'>>;
  let governanceService: jest.Mocked<Pick<GovernanceService, 'validateInput' | 'getPostureForTenant'>>;
  let dlpService: jest.Mocked<Pick<DLPService, 'scanForPII' | 'redactData'>>;

  const mockPosture = (posture: Partial<TenantGovernancePosture> = {}): TenantGovernancePosture => ({
    allowPII: false,
    blockOnDetection: false,
    autoRedact: true,
    piiTypes: [],
    ...posture,
  });

  const toolResultRaw: MCPToolResult = {
    content: [{ type: 'text', text: 'raw data with SSN: 000-12-3456 and email: test@example.com' }],
    structuredContent: { ok: true },
  };

  const findings: PIIFinding[] = [
    { type: 'ssn', value: '000-12-3456', confidence: 1.0, location: { path: '' }, severity: 'high', redactedValue: '[REDACTED]' },
    { type: 'email', value: 'test@example.com', confidence: 1.0, location: { path: '' }, severity: 'medium', redactedValue: '[REDACTED]' }
  ];

  beforeEach(() => {
    logger = createMockLogger();
    auditService = {
      logDataAccess: jest.fn().mockResolvedValue('audit-1'),
    };
    governanceService = {
      validateInput: jest.fn().mockResolvedValue({
        approved: true,
        flags: [],
        riskLevel: 'low',
        complianceChecks: [],
      }),
      getPostureForTenant: jest.fn().mockResolvedValue(mockPosture()),
    };
    dlpService = {
      scanForPII: jest.fn().mockResolvedValue({
        detected: false,
        piiTypes: [],
        findings: [],
        riskLevel: 'low',
        recommendation: 'none',
        redactedData: undefined,
      }),
      redactData: jest.fn(),
    };
  });

  it('bypasses scan completely when allowPII is true, preserving the envelope with bypassReason', async () => {
    governanceService.getPostureForTenant.mockResolvedValueOnce(mockPosture({ allowPII: true }));
    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      callToolResult: toolResultRaw,
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    const result = await service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' });

    expect(dlpService.scanForPII).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      pii: {
        detected: false,
        riskLevel: 'none',
        findingsCount: 0,
        bypassReason: 'tenant_allow_pii',
      },
    });
    expect(auditService.logDataAccess).toHaveBeenCalled();
  });

  it('fails with -32602 McpAggregatorError when blockOnDetection is true and relevant findings exist', async () => {
    governanceService.getPostureForTenant.mockResolvedValueOnce(mockPosture({ blockOnDetection: true }));
    dlpService.scanForPII.mockResolvedValueOnce({
      detected: true,
      findings,
      piiTypes: ['ssn', 'email'],
      riskLevel: 'high',
      recommendation: 'none',
      redactedData: undefined,
    });

    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      callToolResult: toolResultRaw,
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(
      service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' })
    ).rejects.toThrow(new McpAggregatorError(-32602, 'Governance blocked tool result: posture.blockOnDetection'));

    expect(auditService.logDataAccess).toHaveBeenCalled();
  });

  it('fails with -32602 when autoRedact is false and relevant findings exist', async () => {
    governanceService.getPostureForTenant.mockResolvedValueOnce(mockPosture({ autoRedact: false }));
    dlpService.scanForPII.mockResolvedValueOnce({
      detected: true,
      findings,
      piiTypes: ['ssn', 'email'],
      riskLevel: 'high',
      recommendation: 'none',
      redactedData: undefined,
    });

    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      callToolResult: toolResultRaw,
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(
      service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' })
    ).rejects.toThrow(
      new McpAggregatorError(-32602, 'Governance blocked tool result: PII detected, posture.autoRedact=false')
    );

    expect(auditService.logDataAccess).toHaveBeenCalled();
  });

  it('redacts content using filtered findings when piiTypes is specified', async () => {
    governanceService.getPostureForTenant.mockResolvedValueOnce(mockPosture({ piiTypes: ['email'] }));
    dlpService.scanForPII.mockResolvedValueOnce({
      detected: true,
      findings,
      piiTypes: ['ssn', 'email'],
      riskLevel: 'high',
      recommendation: 'none',
      redactedData: undefined,
    });
    dlpService.redactData.mockReturnValueOnce({
      content: [{ type: 'text', text: 'raw data with SSN: 000-12-3456 and email: [REDACTED]' }],
      structuredContent: { ok: true },
    });

    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      callToolResult: toolResultRaw,
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    const result = await service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' });

    expect(dlpService.redactData).toHaveBeenCalledWith(toolResultRaw, [
      { type: 'email', value: 'test@example.com', confidence: 1.0, location: { path: '' }, severity: 'medium', redactedValue: '[REDACTED]' }
    ]);
    expect(result.content[0].text).toContain('[REDACTED]');
    expect(result.content[0].text).toContain('000-12-3456'); // SSN untouched because it was filtered out of relevantFindings
    expect(result.structuredContent?.pii).toMatchObject({
      detected: true,
      riskLevel: 'low',
      findingsCount: 1,
      detectedCount: 2,
    });
  });

  it('bypasses enforcement and sets filtered_all bypassReason when piiTypes filters out all findings', async () => {
    governanceService.getPostureForTenant.mockResolvedValueOnce(mockPosture({ piiTypes: ['drivers_license'] }));
    dlpService.scanForPII.mockResolvedValueOnce({
      detected: true,
      findings,
      piiTypes: ['ssn', 'email'],
      riskLevel: 'high',
      recommendation: 'none',
      redactedData: undefined,
    });

    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      callToolResult: toolResultRaw,
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    const result = await service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' });

    expect(dlpService.redactData).not.toHaveBeenCalled();
    expect(result.structuredContent?.pii).toMatchObject({
      detected: false,
      riskLevel: 'none',
      findingsCount: 0,
      detectedCount: 2,
      bypassReason: 'posture_pii_types_filtered_all',
    });
  });

  it('fails with -32603 when redactData returns undefined', async () => {
    governanceService.getPostureForTenant.mockResolvedValueOnce(mockPosture());
    dlpService.scanForPII.mockResolvedValueOnce({
      detected: true,
      findings: [findings[0]],
      piiTypes: ['ssn'],
      riskLevel: 'high',
      recommendation: 'none',
      redactedData: undefined,
    });
    dlpService.redactData.mockReturnValueOnce(undefined);

    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      callToolResult: toolResultRaw,
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(
      service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' })
    ).rejects.toThrow(
      new McpAggregatorError(-32603, 'DLP redaction produced no output; refusing to surface raw tool result')
    );
  });

  it('fails with -32603 when scanForPII reports scanFailed: true', async () => {
    governanceService.getPostureForTenant.mockResolvedValueOnce(mockPosture());
    dlpService.scanForPII.mockResolvedValueOnce({
      detected: false,
      findings: [],
      piiTypes: [],
      riskLevel: 'none',
      recommendation: 'none',
      redactedData: undefined,
      scanFailed: true,
    });

    const adapter = createAdapter({
      systemName: 'netsuite',
      tools: [{ name: 'ns_getRecord', description: 'Read', inputSchema: {} }],
      callToolResult: toolResultRaw,
    });

    const service = new MCPAggregatorService(
      logger,
      governanceService as unknown as GovernanceService,
      dlpService as unknown as DLPService,
      undefined,
      auditService as unknown as AuditService,
      [adapter]
    );

    await expect(
      service.callTool('netsuite.ns_getRecord', {}, { tenantId: 'tenant-a' })
    ).rejects.toThrow(
      new McpAggregatorError(-32603, 'DLP scan failed; refusing to surface unscanned tool result')
    );
    expect(auditService.logDataAccess).toHaveBeenCalled();
  });
});
