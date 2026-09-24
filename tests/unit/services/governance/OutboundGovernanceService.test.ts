/**
 * OutboundGovernanceService — Unit Tests (PR 2A)
 *
 * 11 scenarios from the A-Grade remediation plan.
 */

import 'reflect-metadata';
import { OutboundGovernanceService } from '../../../../src/services/governance/OutboundGovernanceService';
import type { OutboundContext } from '../../../../src/services/governance/OutboundGovernanceService';
import type { DLPService, PIIDetectionResult, PIIFinding } from '../../../../src/services/security/DLPService';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeFinding(overrides: Partial<PIIFinding> = {}): PIIFinding {
  return {
    type: 'email', field: 'user.email', value: 'test@example.com',
    confidence: 0.85, location: { path: 'user.email' },
    severity: 'medium', redactedValue: 't***@example.com', ...overrides,
  };
}

function makeClean(): PIIDetectionResult {
  return { detected: false, piiTypes: [], findings: [], riskLevel: 'low', recommendation: '' };
}

function makeResult(findings: PIIFinding[], redactedData?: unknown): PIIDetectionResult {
  return {
    detected: findings.length > 0, piiTypes: [...new Set(findings.map(f => f.type))],
    findings, riskLevel: 'high', recommendation: 'PII detected', redactedData,
  };
}

function mockDLP(result: PIIDetectionResult): DLPService {
  return {
    scanForPII: jest.fn().mockResolvedValue(result),
    scanText: jest.fn(),
    getRegisteredPatterns: jest.fn().mockReturnValue([]),
    redactData: jest.fn().mockImplementation(() => result.redactedData),
  } as unknown as DLPService;
}

function mockGov(posture: any = {}) {
  return {
    getPostureForTenant: jest.fn().mockResolvedValue({
      allowPII: false,
      blockOnDetection: false,
      autoRedact: true,
      piiTypes: [],
      ...posture,
    }),
  } as any;
}

function ctx(o: Partial<OutboundContext> = {}): OutboundContext {
  return { tenantId: 't1', userId: 'u1', destination: 'ai_provider', destinationDetail: 'openai', operationType: 'execute', ...o };
}


describe('OutboundGovernanceService', () => {
  // 1. No PII → approved
  it('approves payload with no PII', async () => {
    const svc = new OutboundGovernanceService(mockDLP(makeClean()), mockLogger() as any, mockGov());
    const d = await svc.validateAIProviderRequest({ msg: 'hi' }, ctx());
    expect(d.approved).toBe(true);
    expect(d.riskLevel).toBe('none');
    expect(d.auditMetadata.blocked).toBe(false);
  });

  // 2. Low-risk PII (email) → approved with redaction
  it('approves and redacts low-risk PII (email)', async () => {
    const f = makeFinding({ type: 'email' });
    const red = { user: { email: 't***@example.com' } };
    const svc = new OutboundGovernanceService(mockDLP(makeResult([f], red)), mockLogger() as any, mockGov());
    const d = await svc.validateAIProviderRequest({ user: { email: 'test@example.com' } }, ctx());
    expect(d.approved).toBe(true);
    expect(d.riskLevel).toBe('low');
    expect(d.redactedPayload).toEqual(red);
    expect(d.auditMetadata.redacted).toBe(true);
  });

  // 3. Medium-risk PII (email + phone) → approved with redaction
  it('approves and redacts medium-risk PII (email + phone)', async () => {
    const fs = [makeFinding({ type: 'email' }), makeFinding({ type: 'phone', value: '555-1234' })];
    const red = { contact: { email: 'r', phone: 'r' } };
    const svc = new OutboundGovernanceService(mockDLP(makeResult(fs, red)), mockLogger() as any, mockGov());
    const d = await svc.validateConnectorWrite({ contact: { email: 'a', phone: 'b' } }, ctx({ destination: 'connector_write' }));
    expect(d.approved).toBe(true);
    expect(d.riskLevel).toBe('medium');
    expect(d.findings).toContain('email');
    expect(d.findings).toContain('phone');
  });

  // 4. High-risk PII (SSN), explicit block mode → blocked.
  // PR 3B flipped the default from 'block' to 'queue'; tests that previously
  // implicitly tested block-mode-as-default now pass the option explicitly so
  // both paths are covered.
  it('blocks high-risk PII (SSN) when approvalMode is explicitly set to block', async () => {
    const f = makeFinding({ type: 'ssn', severity: 'critical', value: '123-45-6789' });
    const redacted = { ssn: '***-**-****' };
    const svc = new OutboundGovernanceService(
      mockDLP(makeResult([f], redacted)),
      mockLogger() as any,
      mockGov(),
      { approvalMode: 'block' },
    );
    const d = await svc.validateAIProviderRequest({ ssn: '123-45-6789' }, ctx());
    expect(d.approved).toBe(false);
    expect(d.approvalRequired).toBe(false);
    expect(d.riskLevel).toBe('high');
    expect(d.auditMetadata.blocked).toBe(true);
    // Blocked decisions still carry redactedPayload for audit-safe logging (PR 4A2)
    expect(d.redactedPayload).toEqual(redacted);
  });

  // 4b. High-risk PII, default queue mode (post-PR-3B) → approvalRequired.
  it('sets approvalRequired for high-risk PII under default queue mode (PR 3B default)', async () => {
    const f = makeFinding({ type: 'credit_card', severity: 'critical' });
    // No config arg — exercising the new default.
    const svc = new OutboundGovernanceService(mockDLP(makeResult([f], {})), mockLogger() as any, mockGov());
    const d = await svc.validateConnectorWrite({ card: '4111' }, ctx({ destination: 'connector_write' }));
    expect(d.approved).toBe(false);
    expect(d.approvalRequired).toBe(true);
    expect(d.auditMetadata.blocked).toBe(false);
  });

  // 5. Strict mode → blocks any PII
  it('blocks any PII in strict mode', async () => {
    const f = makeFinding({ type: 'email' });
    const svc = new OutboundGovernanceService(mockDLP(makeResult([f], {})), mockLogger() as any, mockGov(), { strictMode: true });
    const d = await svc.validateAIProviderRequest({ email: 'a@b.c' }, ctx());
    expect(d.approved).toBe(false);
    expect(d.auditMetadata.blocked).toBe(true);
  });

  // 6. Oversized payload → blocked, DLP not called
  it('blocks oversized payloads without calling DLP', async () => {
    const dlp = mockDLP(makeClean());
    const svc = new OutboundGovernanceService(dlp, mockLogger() as any, mockGov(), { maxPayloadBytes: 50 });
    const d = await svc.validateAIProviderRequest({ data: 'x'.repeat(200) }, ctx());
    expect(d.approved).toBe(false);
    expect(d.auditMetadata.blocked).toBe(true);
    expect(dlp.scanForPII).not.toHaveBeenCalled();
  });

  // 7. Scanner failure → fail-safe block
  it('fail-safe blocks when DLP scanner throws', async () => {
    const dlp = { scanForPII: jest.fn().mockRejectedValue(new Error('boom')), scanText: jest.fn(), getRegisteredPatterns: jest.fn().mockReturnValue([]) } as unknown as DLPService;
    const logger = mockLogger();
    const svc = new OutboundGovernanceService(dlp, logger as any, mockGov());
    const d = await svc.validateAIProviderRequest({ msg: 'x' }, ctx());
    expect(d.approved).toBe(false);
    expect(d.auditMetadata.blocked).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  // 7b. Scanner caught error internally and resolved with scanFailed:true → fail-safe block
  // DLPService.scanForPII swallows internal errors and returns
  // {detected:false, scanFailed:true} — that path must also block, NOT fast-path approve.
  it('fail-safe blocks when DLP scanner resolves with scanFailed:true', async () => {
    const silentFailure: PIIDetectionResult = {
      detected: false, piiTypes: [], findings: [], riskLevel: 'low',
      recommendation: 'Scan failed - manual review recommended', scanFailed: true,
    };
    const logger = mockLogger();
    const svc = new OutboundGovernanceService(mockDLP(silentFailure), logger as any, mockGov());
    const d = await svc.validateAIProviderRequest({ msg: 'x' }, ctx());
    expect(d.approved).toBe(false);
    expect(d.approvalRequired).toBe(false);
    expect(d.riskLevel).toBe('high');
    expect(d.auditMetadata.blocked).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  // 8. Audit-log destination → redacted
  it('redacts PII in audit-log payloads', async () => {
    const f = makeFinding({ type: 'email', field: 'details.email' });
    const red = { details: { email: 'r' } };
    const svc = new OutboundGovernanceService(mockDLP(makeResult([f], red)), mockLogger() as any, mockGov());
    const d = await svc.validateAuditLogPayload({ details: { email: 'a@b.c' } }, ctx({ destination: 'audit_log', destinationDetail: 'audit_logs.details' }));
    expect(d.approved).toBe(true);
    expect(d.redactedPayload).toEqual(red);
  });

  // 9. AI provider messages → redacted
  it('redacts PII in AI provider messages', async () => {
    const f = makeFinding({ type: 'email', field: 'messages[0].content' });
    const red = { messages: [{ content: 'redacted' }] };
    const svc = new OutboundGovernanceService(mockDLP(makeResult([f], red)), mockLogger() as any, mockGov());
    const d = await svc.validateAIProviderRequest({ messages: [{ content: 'user@x.com' }] }, ctx());
    expect(d.approved).toBe(true);
    expect(d.redactedPayload).toEqual(red);
  });

  // 10. Connector write nested PII → redacted
  it('redacts PII in nested connector write fields', async () => {
    const f = makeFinding({ type: 'email', field: 'customer.contacts[0].email' });
    const red = { customer: { contacts: [{ email: 'r' }] } };
    const svc = new OutboundGovernanceService(mockDLP(makeResult([f], red)), mockLogger() as any, mockGov());
    const d = await svc.validateConnectorWrite({ customer: { contacts: [{ email: 'a@b.c' }] } }, ctx({ destination: 'connector_write' }));
    expect(d.approved).toBe(true);
    expect(d.redactedPayload).toEqual(red);
  });

  // 11. Risk classification matrix — exercises destination-specific methods
  describe('risk classification matrix', () => {
    const cases: [string, OutboundContext['destination'], 'low' | 'medium' | 'high'][] = [
      ['email', 'ai_provider', 'low'],
      ['phone', 'ai_provider', 'medium'],
      ['ssn', 'ai_provider', 'high'],
      ['credit_card', 'connector_write', 'high'],
      ['name', 'connector_write', 'medium'],
      ['ip_address', 'audit_log', 'low'],
      ['bank_account', 'ai_provider', 'high'],
      ['medical_record_number', 'connector_write', 'high'],
      ['date_of_birth', 'audit_log', 'medium'],
      ['passport', 'ai_provider', 'high'],
      ['drivers_license', 'connector_write', 'high'],
      ['api_key', 'ai_provider', 'high'],
      ['jwt_token', 'connector_write', 'high'],
    ];

    it.each(cases)('%s at %s → %s risk', async (piiType, dest, expected) => {
      const f = makeFinding({ type: piiType as any });
      const svc = new OutboundGovernanceService(mockDLP(makeResult([f], {})), mockLogger() as any, mockGov(), { approvalMode: 'queue' });
      const c = ctx({ destination: dest, destinationDetail: 'test' });

      // Call the destination-specific method so the context flows through correctly
      let d;
      if (dest === 'ai_provider') {
        d = await svc.validateAIProviderRequest({ x: 1 }, c);
      } else if (dest === 'connector_write') {
        d = await svc.validateConnectorWrite({ x: 1 }, c);
      } else {
        d = await svc.validateAuditLogPayload({ x: 1 }, c);
      }
      expect(d.riskLevel).toBe(expected);
    });
  });
});
