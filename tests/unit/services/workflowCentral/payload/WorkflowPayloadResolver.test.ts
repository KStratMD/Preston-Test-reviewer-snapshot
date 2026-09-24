import 'reflect-metadata';
import { WorkflowPayloadResolver } from '../../../../../src/services/workflowCentral/payload/WorkflowPayloadResolver';
import type { ResolutionOutcome } from '../../../../../src/services/workflowCentral/payload/WorkflowPayloadResolver';
import { WorkflowPayloadCache } from '../../../../../src/services/workflowCentral/payload/WorkflowPayloadCache';
import type { ConnectorManager } from '../../../../../src/services/integration/ConnectorManager';
import type { DLPService, PIIDetectionResult } from '../../../../../src/services/security/DLPService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { IConnector } from '../../../../../src/interfaces/IConnector';
import type { GovernanceService } from '../../../../../src/services/ai/orchestrator/GovernanceService';

const fakeLogger: Pick<Logger, 'info' | 'warn' | 'error'> = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function buildDlp(result: Partial<PIIDetectionResult> = {}): Pick<DLPService, 'scanForPII' | 'redactData'> {
  const fullResult: PIIDetectionResult = {
    detected: false,
    findings: [],
    piiTypes: [],
    riskLevel: 'low',
    recommendation: 'No PII detected — payload safe to surface.',
    redactedData: undefined,
    ...result,
  };
  return {
    scanForPII: jest.fn().mockResolvedValue(fullResult),
    redactData: jest.fn().mockImplementation((payload) => fullResult.redactedData ?? (fullResult.findings.length > 0 ? undefined : payload)),
  };
}

function buildConnectors(connector: Pick<IConnector, 'read'>): Pick<ConnectorManager, 'getConnector'> {
  return { getConnector: jest.fn().mockResolvedValue(connector) };
}

function mockGovernance(): Pick<GovernanceService, 'getPostureForTenant'> {
  return {
    getPostureForTenant: jest.fn().mockResolvedValue({
      allowPII: false,
      blockOnDetection: false,
      autoRedact: true,
      piiTypes: [],
    }),
  };
}

function buildResolver(
  connectors: Pick<ConnectorManager, 'getConnector'>,
  dlp: Pick<DLPService, 'scanForPII' | 'redactData'>,
  cache: WorkflowPayloadCache = new WorkflowPayloadCache({ ttlMs: 0 }),
): WorkflowPayloadResolver {
  const gov = mockGovernance();
  return new WorkflowPayloadResolver(
    connectors as unknown as ConnectorManager,
    dlp as unknown as DLPService,
    fakeLogger as unknown as Logger,
    cache,
    gov as unknown as GovernanceService,
  );
}

describe('WorkflowPayloadResolver — happy path', () => {
  it('returns ResolutionOutcome[] with fields from connector.read filtered to fieldsOfInterest', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue({
        name: 'Acme', tax_id: '12-3456789', balance: 50000, internal_id: '12345',
      }),
    };
    const connectors = buildConnectors(fakeConnector);
    const dlp = buildDlp();
    const resolver = buildResolver(connectors, dlp);

    const outcomes: ResolutionOutcome[] = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '12345', fieldsOfInterest: ['name', 'tax_id'] }],
      'tenant-A',
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('resolved');
    // balance + internal_id filtered out client-side
    expect(outcomes[0].fields).toEqual({ name: 'Acme', tax_id: '12-3456789' });
    expect(outcomes[0].resolvedAt).toEqual(expect.any(String));
    expect(connectors.getConnector).toHaveBeenCalledWith('netsuite', 'netsuite_tenant-A');
    expect(fakeConnector.read).toHaveBeenCalledWith('vendor', '12345');
  });

  it('returns all fields when fieldsOfInterest is undefined', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue({ name: 'Acme', tax_id: '12-3456789' }),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '12345' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('resolved');
    expect(outcomes[0].fields).toEqual({ name: 'Acme', tax_id: '12-3456789' });
  });

  it('returns all fields when fieldsOfInterest is an empty array', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue({ name: 'Acme', tax_id: '12-3456789' }),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '12345', fieldsOfInterest: [] }],
      'tenant-A',
    );

    expect(outcomes[0].fields).toEqual({ name: 'Acme', tax_id: '12-3456789' });
  });

  it('invokes DLP scanForPII with autoRedact:false on each resolved record and redacts findings', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue({ name: 'Acme', cardNumber: '4111-1111-1111-1111' }),
    };
    const dlp = buildDlp({
      detected: true,
      findings: [{ type: 'credit_card', value: '4111-1111-1111-1111', confidence: 1.0, location: { path: 'cardNumber' }, severity: 'high', redactedValue: '****-****-****-1111' }],
      redactedData: { name: 'Acme', cardNumber: '****-****-****-1111' }
    });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '12345' }],
      'tenant-A',
    );

    expect(dlp.scanForPII).toHaveBeenCalledWith(
      { name: 'Acme', cardNumber: '4111-1111-1111-1111' },
      expect.objectContaining({ autoRedact: false, blockOnDetection: false }),
    );
    expect(outcomes[0].status).toBe('resolved');
    expect(outcomes[0].fields).toEqual({ name: 'Acme', cardNumber: '****-****-****-1111' });
  });

  it('uses original projected fields when DLP returns no redactedData (no PII detected)', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue({ name: 'Acme', tax_id: '12-3456789' }),
    };
    const dlp = buildDlp({ detected: false, redactedData: undefined });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '12345' }],
      'tenant-A',
    );

    expect(outcomes[0].fields).toEqual({ name: 'Acme', tax_id: '12-3456789' });
  });

  it('selects per-tenant connector using `${system}_${tenantId}` convention', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue({ name: 'Acme' }),
    };
    const connectors = buildConnectors(fakeConnector);
    const resolver = buildResolver(connectors, buildDlp());

    await resolver.resolve(
      [{ system: 'businesscentral', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-Z',
    );

    expect(connectors.getConnector).toHaveBeenCalledWith('businesscentral', 'businesscentral_tenant-Z');
  });

  it('resolves multiple refs with partial-success — both outcomes present', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn()
        .mockResolvedValueOnce({ name: 'Acme', tax_id: '11-1111111' })
        .mockResolvedValueOnce({ name: 'BetaCorp', tax_id: '22-2222222' }),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [
        { system: 'netsuite', recordType: 'vendor', recordId: 'V-1' },
        { system: 'netsuite', recordType: 'vendor', recordId: 'V-2' },
      ],
      'tenant-A',
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe('resolved');
    expect(outcomes[0].fields).toEqual({ name: 'Acme', tax_id: '11-1111111' });
    expect(outcomes[1].status).toBe('resolved');
    expect(outcomes[1].fields).toEqual({ name: 'BetaCorp', tax_id: '22-2222222' });
  });

  it('returns empty outcomes for empty refs array (no-op)', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = { read: jest.fn() };
    const connectors = buildConnectors(fakeConnector);
    const resolver = buildResolver(connectors, buildDlp());

    const outcomes = await resolver.resolve([], 'tenant-A');

    expect(outcomes).toEqual([]);
    expect(connectors.getConnector).not.toHaveBeenCalled();
    expect(fakeConnector.read).not.toHaveBeenCalled();
  });

  it('returns PAYLOAD_REF_RECORD_NOT_FOUND outcome when connector.read returns null', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue(null),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-missing' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_RECORD_NOT_FOUND');
    expect(outcomes[0].error?.statusCode).toBe(404);
    expect(outcomes[0].fields).toBeUndefined();
  });

  it('maps connector statusCode 404 → PAYLOAD_REF_RECORD_NOT_FOUND outcome', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 })),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_RECORD_NOT_FOUND');
    expect(outcomes[0].error?.statusCode).toBe(404);
  });

  it('maps connector statusCode 401 → PAYLOAD_REF_AUTH_EXPIRED outcome', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 })),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_AUTH_EXPIRED');
    expect(outcomes[0].error?.statusCode).toBe(401);
  });

  it('maps connector statusCode 403 → PAYLOAD_REF_FORBIDDEN outcome (NOT collapsed to AUTH_EXPIRED — Copilot R1)', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockRejectedValue(Object.assign(new Error('forbidden — record outside tenant scope'), { statusCode: 403 })),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    // CRITICAL: 403 is NOT auth-expired — it's a permission/scope gap. Operator
    // UI should surface a "permission" message, not a re-auth prompt.
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_FORBIDDEN');
    expect(outcomes[0].error?.statusCode).toBe(403);
    expect(outcomes[0].error?.code).not.toBe('PAYLOAD_REF_AUTH_EXPIRED');
  });

  it('maps connector statusCode 503 → PAYLOAD_REF_CONNECTOR_UNAVAILABLE outcome', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockRejectedValue(Object.assign(new Error('service unavailable'), { statusCode: 503 })),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-A',
    );

    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_CONNECTOR_UNAVAILABLE');
    expect(outcomes[0].error?.statusCode).toBe(503);
  });

  it.each([
    ['ECONNREFUSED'],
    ['ETIMEDOUT'],
    ['ENOTFOUND'],
    ['ECONNRESET'],
  ])('maps network code %s → PAYLOAD_REF_CONNECTOR_UNAVAILABLE outcome', async (errCode) => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockRejectedValue(Object.assign(new Error('network failure'), { code: errCode })),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-A',
    );

    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_CONNECTOR_UNAVAILABLE');
    expect(outcomes[0].error?.statusCode).toBe(503);
  });

  it('maps PayloadRefError thrown by connector via instanceof discrimination', async () => {
    // Hypothetical: a future connector wraps its failures in PayloadRefError
    // subclasses. The resolver should pass the typed shape through to the
    // outcome rather than re-translating it.
    const { PayloadRefAuthExpiredError } = await import('../../../../../src/services/workflowCentral/payload/errors');
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockRejectedValue(new PayloadRefAuthExpiredError('token expired', { system: 'netsuite' })),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_AUTH_EXPIRED');
    expect(outcomes[0].error?.statusCode).toBe(401);
  });

  it('falls back to PAYLOAD_REF_CONNECTOR_UNAVAILABLE for untyped errors with no statusCode/code', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockRejectedValue(new Error('mystery failure')),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-A',
    );

    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_CONNECTOR_UNAVAILABLE');
    expect(outcomes[0].error?.statusCode).toBe(503);
  });

  it('preserves partial success: ref A resolves, ref B 503s — both outcomes present and discriminated', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn()
        .mockResolvedValueOnce({ name: 'Acme', tax_id: '11-1111111' })
        .mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503 })),
    };
    const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp());

    const outcomes = await resolver.resolve(
      [
        { system: 'netsuite', recordType: 'vendor', recordId: 'V-1' },
        { system: 'netsuite', recordType: 'vendor', recordId: 'V-2' },
      ],
      'tenant-A',
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe('resolved');
    expect(outcomes[0].fields).toEqual({ name: 'Acme', tax_id: '11-1111111' });
    expect(outcomes[1].status).toBe('failed');
    expect(outcomes[1].error?.code).toBe('PAYLOAD_REF_CONNECTOR_UNAVAILABLE');
  });

  describe('cache integration', () => {
    it('second resolve of same ref within TTL hits cache — connector called once', async () => {
      const fakeConnector: Pick<IConnector, 'read'> = {
        read: jest.fn().mockResolvedValue({ name: 'Acme', tax_id: '12-3456789' }),
      };
      const cache = new WorkflowPayloadCache({ ttlMs: 30_000 });
      const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp(), cache);

      const ref = { system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-1' };
      const outcomes1 = await resolver.resolve([ref], 'tenant-A');
      const outcomes2 = await resolver.resolve([ref], 'tenant-A');

      expect(fakeConnector.read).toHaveBeenCalledTimes(1);
      expect(outcomes1[0].status).toBe('resolved');
      expect(outcomes2[0].status).toBe('resolved');
      expect(outcomes2[0].fields).toEqual({ name: 'Acme', tax_id: '12-3456789' });
    });

    it('failures are NOT cached — retry hits connector again', async () => {
      const fakeConnector: Pick<IConnector, 'read'> = {
        read: jest.fn()
          .mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503 }))
          .mockResolvedValueOnce({ name: 'Acme' }),
      };
      const cache = new WorkflowPayloadCache({ ttlMs: 30_000 });
      const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp(), cache);

      const ref = { system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-1' };
      const outcomes1 = await resolver.resolve([ref], 'tenant-A');
      const outcomes2 = await resolver.resolve([ref], 'tenant-A');

      expect(fakeConnector.read).toHaveBeenCalledTimes(2);
      expect(outcomes1[0].status).toBe('failed');
      expect(outcomes2[0].status).toBe('resolved');
    });

    it('different tenants do NOT share cache (isolation enforced through resolver)', async () => {
      const fakeConnector: Pick<IConnector, 'read'> = {
        read: jest.fn()
          .mockResolvedValueOnce({ name: 'AcmeA' })
          .mockResolvedValueOnce({ name: 'AcmeB' }),
      };
      const cache = new WorkflowPayloadCache({ ttlMs: 30_000 });
      const resolver = buildResolver(buildConnectors(fakeConnector), buildDlp(), cache);

      const ref = { system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-1' };
      const outcomesA = await resolver.resolve([ref], 'tenant-A');
      const outcomesB = await resolver.resolve([ref], 'tenant-B');

      expect(fakeConnector.read).toHaveBeenCalledTimes(2);
      expect(outcomesA[0].fields).toEqual({ name: 'AcmeA' });
      expect(outcomesB[0].fields).toEqual({ name: 'AcmeB' });
    });
  });

  it('fail-closed when DLP detects PII but produces no redactedData (Copilot R4)', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue({ ssn: '123-45-6789', email: 'leak@example.com' }),
    };
    // Simulate redactor failure: detected=true, findings present, but redactedData stays undefined.
    const dlp = buildDlp({
      detected: true,
      findings: [{ type: 'ssn', value: '123-45-6789', confidence: 0.95, location: { path: 'ssn' }, severity: 'high', redactedValue: '***-**-****' }],
      piiTypes: ['ssn'],
      riskLevel: 'high',
      recommendation: 'Redact before surfacing.',
      redactedData: undefined,
    });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'employee', recordId: 'E-1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_DLP_SCAN_FAILED');
    expect(outcomes[0].error?.statusCode).toBe(500);
    // CRITICAL: raw PII MUST NOT leak via fields
    expect(outcomes[0].fields).toBeUndefined();
    // Serialized check — no PII string anywhere in the outcome
    const serialized = JSON.stringify(outcomes[0]);
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('leak@example.com');
  });

  it('returns PAYLOAD_REF_DLP_SCAN_FAILED outcome when DLP returns scanFailed:true (fail-closed)', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue({ name: 'Acme', secret: 'hidden' }),
    };
    const dlp = buildDlp({ scanFailed: true, redactedData: undefined });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_DLP_SCAN_FAILED');
    expect(outcomes[0].error?.statusCode).toBe(500);
    // Critical: unscanned payload MUST NOT leak as fields
    expect(outcomes[0].fields).toBeUndefined();
  });
});
