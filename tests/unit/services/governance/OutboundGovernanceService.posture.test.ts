import 'reflect-metadata';
import { OutboundGovernanceService } from '../../../../src/services/governance/OutboundGovernanceService';
import type { OutboundContext } from '../../../../src/services/governance/OutboundGovernanceService';
import type { DLPService, PIIDetectionResult, PIIFinding } from '../../../../src/services/security/DLPService';
import type { GovernanceService } from '../../../../src/services/ai/orchestrator/GovernanceService';

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
  } as unknown as GovernanceService;
}

function ctx(o: Partial<OutboundContext> = {}): OutboundContext {
  return { tenantId: 't1', userId: 'u1', destination: 'ai_provider', destinationDetail: 'openai', operationType: 'execute', ...o };
}

describe('OutboundGovernanceService - Per-Tenant Posture Matrix', () => {
  // Case 1: allowPII = true → bypass scan enforcement consequences (scan-and-flag only)
  it('Matrix Case 1: allowPII = true → scan-and-flag only, approves raw payload', async () => {
    const f = makeFinding({ type: 'email' });
    const dlp = mockDLP(makeResult([f], { user: { email: 't***@example.com' } }));
    const gov = mockGov({ allowPII: true });
    const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

    const d = await svc.validateAIProviderRequest({ user: { email: 'test@example.com' } }, ctx());
    expect(d.approved).toBe(true);
    expect(d.approvalRequired).toBe(false);
    expect(d.riskLevel).toBe('low'); // observed from classifyFindingsRisk(findings)
    expect(d.findings).toContain('email');
    expect(d.redactedPayload).toEqual({ user: { email: 'test@example.com' } }); // returns raw payload
    expect(d.auditMetadata.redacted).toBe(false);
    expect(d.auditMetadata.postureBypass).toBe('allow_pii');
  });

  // Case 2: allowPII = false, blockOnDetection = false, autoRedact = true, piiTypes = [] (all types enforced), no findings
  it('Matrix Case 2: no findings → approved, raw passthrough', async () => {
    const dlp = mockDLP(makeClean());
    const gov = mockGov({ allowPII: false, blockOnDetection: false, autoRedact: true, piiTypes: [] });
    const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

    const d = await svc.validateAIProviderRequest({ msg: 'hello' }, ctx());
    expect(d.approved).toBe(true);
    expect(d.approvalRequired).toBe(false);
    expect(d.riskLevel).toBe('none');
    expect(d.findings).toEqual([]);
    expect(d.redactedPayload).toEqual({ msg: 'hello' });
    expect(d.auditMetadata.redacted).toBe(false);
    expect(d.auditMetadata.blocked).toBe(false);
  });

  // Case 3: allowPII = false, blockOnDetection = false, autoRedact = true, piiTypes = [], findings present
  it('Matrix Case 3: findings present + autoRedact=true → approved, redacted payload returned', async () => {
    const f = makeFinding({ type: 'email' });
    const red = { user: { email: 't***@example.com' } };
    const dlp = mockDLP(makeResult([f], red));
    const gov = mockGov({ allowPII: false, blockOnDetection: false, autoRedact: true, piiTypes: [] });
    const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

    const d = await svc.validateAIProviderRequest({ user: { email: 'test@example.com' } }, ctx());
    expect(d.approved).toBe(true);
    expect(d.approvalRequired).toBe(false);
    expect(d.riskLevel).toBe('low');
    expect(d.findings).toContain('email');
    expect(d.redactedPayload).toEqual(red);
    expect(d.auditMetadata.redacted).toBe(true);
    expect(d.auditMetadata.blocked).toBe(false);
  });

  // Case 4: allowPII = false, blockOnDetection = true, autoRedact = true, piiTypes = [], findings present
  it('Matrix Case 4: blockOnDetection = true → blocked, redactedPayload retained', async () => {
    const f = makeFinding({ type: 'email' });
    const red = { user: { email: 't***@example.com' } };
    const dlp = mockDLP(makeResult([f], red));
    const gov = mockGov({ allowPII: false, blockOnDetection: true, autoRedact: true, piiTypes: [] });
    const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

    const d = await svc.validateAIProviderRequest({ user: { email: 'test@example.com' } }, ctx());
    expect(d.approved).toBe(false);
    expect(d.approvalRequired).toBe(false);
    expect(d.auditMetadata.blocked).toBe(true);
    expect(d.redactedPayload).toEqual(red); // Retains redacted payload for block consumers
  });

  // Case 5: allowPII = false, blockOnDetection = false, autoRedact = false, piiTypes = [], findings present
  it('Matrix Case 5: autoRedact = false → fail-safe block (cannot approve raw PII)', async () => {
    const f = makeFinding({ type: 'email' });
    const dlp = mockDLP(makeResult([f], undefined)); // no redacted payload since autoRedact = false
    const gov = mockGov({ allowPII: false, blockOnDetection: false, autoRedact: false, piiTypes: [] });
    const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

    const d = await svc.validateAIProviderRequest({ user: { email: 'test@example.com' } }, ctx());
    expect(d.approved).toBe(false);
    expect(d.approvalRequired).toBe(false);
    expect(d.auditMetadata.blocked).toBe(true);
    expect(d.redactedPayload).toBeUndefined();
  });

  // Case 6: allowPII = false, blockOnDetection = false, autoRedact = true, piiTypes = [email], email + phone findings
  it('Matrix Case 6: piiTypes allowlist filters findings (redacts email, preserves phone)', async () => {
    const emailFinding = makeFinding({ type: 'email', value: 'test@example.com', field: 'email', redactedValue: 't***@example.com' });
    const phoneFinding = makeFinding({ type: 'phone', value: '555-1234', field: 'phone', severity: 'medium', redactedValue: '555-****' });
    const dlpResult = makeResult([emailFinding, phoneFinding]);
    const dlp = mockDLP(dlpResult);

    // Mock redactData to only redact email based on the relevant findings passed to it.
    dlp.redactData = jest.fn().mockImplementation((payload, relevant) => {
      const copy = { ...payload };
      for (const r of relevant) {
        if (r.type === 'email') {
          copy.email = 't***@example.com';
        } else if (r.type === 'phone') {
          copy.phone = '555-****';
        }
      }
      return copy;
    });

    const gov = mockGov({ allowPII: false, blockOnDetection: false, autoRedact: true, piiTypes: ['email'] });
    const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

    const d = await svc.validateAIProviderRequest({ email: 'test@example.com', phone: '555-1234' }, ctx());
    expect(d.approved).toBe(true);
    expect(d.approvalRequired).toBe(false);
    expect(d.riskLevel).toBe('low'); // Since phone is filtered out, risk is low (email) rather than medium (phone)
    expect(d.findings).toEqual(['email']); // relevant findings only
    expect(d.redactedPayload).toEqual({ email: 't***@example.com', phone: '555-1234' }); // phone is untouched
    expect(d.auditMetadata.detectedCount).toBe(2);
    expect(d.auditMetadata.findingsCount).toBe(1);
    expect(d.auditMetadata.redacted).toBe(true);
  });

  // Case 7: allowPII = false, blockOnDetection = false, autoRedact = true, piiTypes = [email], phone finding only
  it('Matrix Case 7: phone finding filtered out entirely → passthrough', async () => {
    const f = makeFinding({ type: 'phone', severity: 'medium' });
    const dlp = mockDLP(makeResult([f], undefined));
    const gov = mockGov({ allowPII: false, blockOnDetection: false, autoRedact: true, piiTypes: ['email'] });
    const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

    const d = await svc.validateAIProviderRequest({ phone: '555-1234' }, ctx());
    expect(d.approved).toBe(true);
    expect(d.approvalRequired).toBe(false);
    expect(d.riskLevel).toBe('none');
    expect(d.findings).toEqual([]);
    expect(d.redactedPayload).toEqual({ phone: '555-1234' });
    expect(d.auditMetadata.detectedCount).toBe(1);
    expect(d.auditMetadata.findingsCount).toBe(0);
    expect(d.auditMetadata.postureBypass).toBe('posture_pii_types_filtered_all');
  });

  // Case 8: scanFailed = true → fail-safe block
  it('Matrix Case 8: scanFailed = true → fail-safe block', async () => {
    const silentFailure: PIIDetectionResult = {
      detected: false, piiTypes: [], findings: [], riskLevel: 'low',
      recommendation: 'Scan failed', scanFailed: true,
    };
    const gov = mockGov();
    const svc = new OutboundGovernanceService(mockDLP(silentFailure), mockLogger() as any, gov);

    const d = await svc.validateAIProviderRequest({ msg: 'hello' }, ctx());
    expect(d.approved).toBe(false);
    expect(d.approvalRequired).toBe(false);
    expect(d.auditMetadata.blocked).toBe(true);
    expect(d.redactedPayload).toBeUndefined();
  });

  // Queue vs Block split for high-risk findings
  describe('Queue vs Block split for high-risk findings', () => {
    it('under approvalMode = queue, high-risk findings set approvalRequired = true', async () => {
      const f = makeFinding({ type: 'ssn', severity: 'critical' });
      const red = { ssn: '***-**-****' };
      const dlp = mockDLP(makeResult([f], red));
      const gov = mockGov();
      const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov, { approvalMode: 'queue' });

      const d = await svc.validateAIProviderRequest({ ssn: '123-45-6789' }, ctx());
      expect(d.approved).toBe(false);
      expect(d.approvalRequired).toBe(true);
      expect(d.auditMetadata.blocked).toBe(false);
      expect(d.redactedPayload).toEqual(red);
    });

    it('under approvalMode = block, high-risk findings set blocked = true, approvalRequired = false', async () => {
      const f = makeFinding({ type: 'ssn', severity: 'critical' });
      const red = { ssn: '***-**-****' };
      const dlp = mockDLP(makeResult([f], red));
      const gov = mockGov();
      const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov, { approvalMode: 'block' });

      const d = await svc.validateAIProviderRequest({ ssn: '123-45-6789' }, ctx());
      expect(d.approved).toBe(false);
      expect(d.approvalRequired).toBe(false);
      expect(d.auditMetadata.blocked).toBe(true);
      expect(d.redactedPayload).toEqual(red);
    });
  });

  // Copilot R2: allowPII MUST NOT bypass redaction on audit_log destination —
  // audit log details would otherwise become a PII exfiltration channel.
  describe('allowPII audit-log carveout (Copilot R2)', () => {
    it('allowPII=true + destination=audit_log → redacts (no scan-and-flag bypass)', async () => {
      const f = makeFinding({ type: 'email' });
      const red = { details: { email: 't***@example.com' } };
      const dlp = mockDLP(makeResult([f], red));
      const gov = mockGov({ allowPII: true, autoRedact: true });
      const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

      const d = await svc.validateAuditLogPayload(
        { details: { email: 'test@example.com' } },
        ctx({ destination: 'audit_log', destinationDetail: 'audit_logs.details' }),
      );

      // Must NOT take the allowPII scan-and-flag fast-path
      expect(d.auditMetadata.postureBypass).toBeUndefined();
      // Must redact normally — raw email never lands in audit_log details
      expect(d.approved).toBe(true);
      expect(d.redactedPayload).toEqual(red);
      expect(d.auditMetadata.redacted).toBe(true);
    });

    it('allowPII=true + destination=ai_provider → still scan-and-flag bypass (carveout is audit_log-only)', async () => {
      const f = makeFinding({ type: 'email' });
      const dlp = mockDLP(makeResult([f], { user: { email: 't***@example.com' } }));
      const gov = mockGov({ allowPII: true });
      const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

      const d = await svc.validateAIProviderRequest({ user: { email: 'test@example.com' } }, ctx());

      // Confirms the audit_log carveout doesn't accidentally suppress the bypass for non-audit destinations
      expect(d.auditMetadata.postureBypass).toBe('allow_pii');
      expect(d.redactedPayload).toEqual({ user: { email: 'test@example.com' } });
    });

    it('allowPII=true + destination=connector_write → still scan-and-flag bypass', async () => {
      const f = makeFinding({ type: 'email' });
      const dlp = mockDLP(makeResult([f], { customer: { email: 't***@example.com' } }));
      const gov = mockGov({ allowPII: true });
      const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

      const d = await svc.validateConnectorWrite(
        { customer: { email: 'test@example.com' } },
        ctx({ destination: 'connector_write', destinationDetail: 'netsuite.create' }),
      );

      expect(d.auditMetadata.postureBypass).toBe('allow_pii');
      expect(d.redactedPayload).toEqual({ customer: { email: 'test@example.com' } });
    });

    // Codex pre-merge HIGH: posture.piiTypes allowlist narrows enforcement at
    // line 343 BEFORE the audit_log carveout applies, so a non-allowlisted
    // finding (e.g. phone when piiTypes=['email']) on audit_log destination
    // would fall into the "no PII fast-path" and return raw payload. Audit
    // logs must redact ALL findings regardless of piiTypes narrowing.
    it('audit_log + piiTypes=["email"] + phone finding → redacts phone (no narrow-to-zero bypass)', async () => {
      const f = makeFinding({ type: 'phone' });
      const red = { details: { phone: 'XXX-XXX-XXXX' } };
      const dlp = mockDLP(makeResult([f], red));
      const gov = mockGov({ allowPII: false, autoRedact: true, piiTypes: ['email'] });
      const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

      const d = await svc.validateAuditLogPayload(
        { details: { phone: '555-1234' } },
        ctx({ destination: 'audit_log', destinationDetail: 'audit_logs.details' }),
      );

      // Phone must NOT be filtered out by piiTypes=['email'] on audit_log
      expect(d.approved).toBe(true);
      expect(d.auditMetadata.findingsCount).toBe(1);
      expect(d.auditMetadata.redacted).toBe(true);
      expect(d.redactedPayload).toEqual(red);
    });

    it('audit_log + allowPII=true + piiTypes=["email"] + phone finding → still redacts (carveout + piiTypes bypass both apply)', async () => {
      const f = makeFinding({ type: 'phone' });
      const red = { details: { phone: 'XXX-XXX-XXXX' } };
      const dlp = mockDLP(makeResult([f], red));
      const gov = mockGov({ allowPII: true, autoRedact: true, piiTypes: ['email'] });
      const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

      const d = await svc.validateAuditLogPayload(
        { details: { phone: '555-1234' } },
        ctx({ destination: 'audit_log', destinationDetail: 'audit_logs.details' }),
      );

      // allowPII bypass blocked by ctx.destination !== 'audit_log' check;
      // piiTypes narrowing also bypassed on audit_log — phone gets redacted.
      expect(d.auditMetadata.postureBypass).toBeUndefined();
      expect(d.approved).toBe(true);
      expect(d.auditMetadata.findingsCount).toBe(1);
      expect(d.auditMetadata.redacted).toBe(true);
      expect(d.redactedPayload).toEqual(red);
    });

    it('non-audit_log destination still honors piiTypes narrowing', async () => {
      const f = makeFinding({ type: 'phone' });
      const dlp = mockDLP(makeResult([f], { customer: { phone: 'XXX-XXX-XXXX' } }));
      const gov = mockGov({ allowPII: false, autoRedact: true, piiTypes: ['email'] });
      const svc = new OutboundGovernanceService(dlp, mockLogger() as any, gov);

      const d = await svc.validateConnectorWrite(
        { customer: { phone: '555-1234' } },
        ctx({ destination: 'connector_write', destinationDetail: 'netsuite.create' }),
      );

      // Confirms the audit_log carveout doesn't accidentally over-apply: on
      // connector_write, phone (not in piiTypes=['email']) IS filtered out
      // → no PII fast-path → raw payload returned. Regression net.
      expect(d.approved).toBe(true);
      expect(d.auditMetadata.findingsCount).toBe(0);
      expect(d.auditMetadata.detectedCount).toBe(1);
      expect(d.auditMetadata.redacted).toBe(false);
      expect(d.auditMetadata.postureBypass).toBe('posture_pii_types_filtered_all');
    });
  });
});
