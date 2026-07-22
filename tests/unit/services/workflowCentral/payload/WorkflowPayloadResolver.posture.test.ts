import 'reflect-metadata';
import { WorkflowPayloadResolver } from '../../../../../src/services/workflowCentral/payload/WorkflowPayloadResolver';
import type { ResolutionOutcome } from '../../../../../src/services/workflowCentral/payload/WorkflowPayloadResolver';
import { WorkflowPayloadCache } from '../../../../../src/services/workflowCentral/payload/WorkflowPayloadCache';
import type { ConnectorManager } from '../../../../../src/services/integration/ConnectorManager';
import type { DLPService, PIIDetectionResult } from '../../../../../src/services/security/DLPService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { IConnector } from '../../../../../src/interfaces/IConnector';
import type { GovernanceService, TenantGovernancePosture } from '../../../../../src/services/ai/orchestrator/GovernanceService';
import type { PIIFinding } from '../../../../../src/services/security/DLPService';

const fakeLogger: Pick<Logger, 'info' | 'warn' | 'error'> = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function buildDlp(
  scanResult: Partial<PIIDetectionResult> = {},
  redactedReturn?: any
): Pick<DLPService, 'scanForPII' | 'redactData'> {
  const fullResult: PIIDetectionResult = {
    detected: false,
    findings: [],
    piiTypes: [],
    riskLevel: 'low',
    recommendation: 'No PII detected',
    redactedData: undefined,
    ...scanResult,
  };
  return {
    scanForPII: jest.fn().mockResolvedValue(fullResult),
    redactData: jest.fn().mockReturnValue(redactedReturn),
  };
}

function buildConnectors(connector: Pick<IConnector, 'read'>): Pick<ConnectorManager, 'getConnector'> {
  return { getConnector: jest.fn().mockResolvedValue(connector) };
}

function buildResolver(
  connectors: Pick<ConnectorManager, 'getConnector'>,
  dlp: Pick<DLPService, 'scanForPII' | 'redactData'>,
  governance: Pick<GovernanceService, 'getPostureForTenant'>,
  cache: WorkflowPayloadCache = new WorkflowPayloadCache({ ttlMs: 0 }),
): WorkflowPayloadResolver {
  return new WorkflowPayloadResolver(
    connectors as unknown as ConnectorManager,
    dlp as unknown as DLPService,
    fakeLogger as unknown as Logger,
    cache,
    governance as unknown as GovernanceService,
  );
}

function mockGovernance(posture: Partial<TenantGovernancePosture> = {}): Pick<GovernanceService, 'getPostureForTenant'> {
  const fullPosture: TenantGovernancePosture = {
    allowPII: false,
    blockOnDetection: false,
    autoRedact: true,
    piiTypes: [],
    ...posture,
  };
  return {
    getPostureForTenant: jest.fn().mockResolvedValue(fullPosture),
  };
}

describe('WorkflowPayloadResolver — Per-Tenant Posture Integration', () => {
  const sampleRecord = { name: 'Alice', ssn: '111-22-3333', email: 'alice@example.com' };

  it('bypasses scan completely when allowPII is true', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const dlp = buildDlp({ detected: true });
    const governance = mockGovernance({ allowPII: true });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '1' }],
      'tenant-A',
    );

    expect(dlp.scanForPII).not.toHaveBeenCalled();
    expect(outcomes[0].status).toBe('resolved');
    expect(outcomes[0].fields).toEqual(sampleRecord);
  });

  it('fails with 403 when blockOnDetection is true and findings are present', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const findings: PIIFinding[] = [{
      type: 'ssn', value: '111-22-3333', confidence: 1.0, location: { path: 'ssn' }, severity: 'high', redactedValue: '[REDACTED]'
    }];
    const dlp = buildDlp({ detected: true, findings });
    const governance = mockGovernance({ blockOnDetection: true });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.statusCode).toBe(403);
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_DLP_BLOCKED');
  });

  it('fails with 403 when autoRedact is false and findings are present', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const findings: PIIFinding[] = [{
      type: 'ssn', value: '111-22-3333', confidence: 1.0, location: { path: 'ssn' }, severity: 'high', redactedValue: '[REDACTED]'
    }];
    const dlp = buildDlp({ detected: true, findings });
    const governance = mockGovernance({ autoRedact: false });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.statusCode).toBe(403);
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_DLP_BLOCKED');
  });

  it('filters findings by piiTypes allowlist', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const findings: PIIFinding[] = [
      { type: 'ssn', value: '111-22-3333', confidence: 1.0, location: { path: 'ssn' }, severity: 'high', redactedValue: '[REDACTED]' },
      { type: 'email', value: 'alice@example.com', confidence: 1.0, location: { path: 'email' }, severity: 'medium', redactedValue: '[REDACTED]' }
    ];
    const dlp = buildDlp({ detected: true, findings }, { name: 'Alice', ssn: '111-22-3333', email: '[REDACTED]' });
    const governance = mockGovernance({ piiTypes: ['email'] }); // only enforce on email
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '1' }],
      'tenant-A',
    );

    expect(dlp.redactData).toHaveBeenCalledWith(sampleRecord, [{
      type: 'email', value: 'alice@example.com', confidence: 1.0, location: { path: 'email' }, severity: 'medium', redactedValue: '[REDACTED]'
    }]);
    expect(outcomes[0].status).toBe('resolved');
    expect(outcomes[0].fields).toEqual({ name: 'Alice', ssn: '111-22-3333', email: '[REDACTED]' });
  });

  it('bypasses enforcement completely if piiTypes filters out all findings', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const findings: PIIFinding[] = [
      { type: 'ssn', value: '111-22-3333', confidence: 1.0, location: { path: 'ssn' }, severity: 'high', redactedValue: '[REDACTED]' }
    ];
    const dlp = buildDlp({ detected: true, findings });
    const governance = mockGovernance({ piiTypes: ['email'] }); // no findings are email
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '1' }],
      'tenant-A',
    );

    expect(dlp.redactData).not.toHaveBeenCalled();
    expect(outcomes[0].status).toBe('resolved');
    expect(outcomes[0].fields).toEqual(sampleRecord);
  });

  it('fails with 500 when DLP redaction fails (returns undefined)', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const findings: PIIFinding[] = [
      { type: 'ssn', value: '111-22-3333', confidence: 1.0, location: { path: 'ssn' }, severity: 'high', redactedValue: '[REDACTED]' }
    ];
    const dlp = buildDlp({ detected: true, findings }, undefined); // redactData returns undefined
    const governance = mockGovernance();
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.statusCode).toBe(500);
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_DLP_SCAN_FAILED');
  });

  it('fails with 500 when scanFailed is true', async () => {
    const fakeConnector: Pick<IConnector, 'read'> = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const dlp = buildDlp({ scanFailed: true });
    const governance = mockGovernance();
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance);

    const outcomes = await resolver.resolve(
      [{ system: 'netsuite', recordType: 'vendor', recordId: '1' }],
      'tenant-A',
    );

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error?.statusCode).toBe(500);
    expect(outcomes[0].error?.code).toBe('PAYLOAD_REF_DLP_SCAN_FAILED');
  });

  // Codex pre-merge HIGH: caching raw payloads under allowPII=true means a
  // tenant flipping posture to allowPII=false would keep serving the cached
  // raw PII until TTL expiry — turning a policy tightening into a delayed
  // leak. Fix re-resolves on every call for allowPII tenants.
  it('does NOT cache raw payloads when allowPII is true (re-resolves on each call)', async () => {
    const fakeConnector = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const dlp = buildDlp({ detected: true });
    const governance = mockGovernance({ allowPII: true });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance);
    const ref = { system: 'netsuite', recordType: 'vendor', recordId: '1' } as const;

    // First resolve — connector hit once
    const o1 = await resolver.resolve([ref], 'tenant-A');
    expect(o1[0].status).toBe('resolved');
    expect(o1[0].fields).toEqual(sampleRecord);
    expect(fakeConnector.read).toHaveBeenCalledTimes(1);

    // Second resolve — connector hit AGAIN (no cache reuse)
    const o2 = await resolver.resolve([ref], 'tenant-A');
    expect(o2[0].status).toBe('resolved');
    expect(o2[0].fields).toEqual(sampleRecord);
    expect(fakeConnector.read).toHaveBeenCalledTimes(2);
  });

  it('still caches redacted payloads when allowPII is false (only allowPII path skips cache)', async () => {
    const fakeConnector = {
      read: jest.fn().mockResolvedValue(sampleRecord),
    };
    const dlp = buildDlp({ detected: false, findings: [] });
    const governance = mockGovernance({ allowPII: false });
    // Use a real TTL — buildResolver defaults to ttlMs:0 which evicts on get;
    // cache-hit assertions need a working cache.
    const cache = new WorkflowPayloadCache({ ttlMs: 60_000 });
    const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance, cache);
    const ref = { system: 'netsuite', recordType: 'vendor', recordId: '1' } as const;

    // First resolve — connector hit once
    const o1 = await resolver.resolve([ref], 'tenant-B');
    expect(o1[0].status).toBe('resolved');
    expect(fakeConnector.read).toHaveBeenCalledTimes(1);

    // Second resolve — cache hit, connector NOT re-hit
    const o2 = await resolver.resolve([ref], 'tenant-B');
    expect(o2[0].status).toBe('resolved');
    expect(fakeConnector.read).toHaveBeenCalledTimes(1);
  });

  // Copilot R5: posture-aware cache. Any change to allowPII/blockOnDetection/
  // autoRedact/piiTypes between two resolve calls MUST invalidate the cached
  // entry, since the safe payload was computed under the old posture and may
  // surface PII the new posture would have caught.
  describe('posture-fingerprint cache invalidation (Copilot R5)', () => {
    it('invalidates cache when piiTypes changes (tightening adds enforcement)', async () => {
      const fakeConnector = {
        read: jest.fn().mockResolvedValue(sampleRecord),
      };
      const dlp = buildDlp({ detected: false, findings: [] });
      // Use a stub that returns DIFFERENT posture on each call to simulate a
      // policy update between resolves.
      let callCount = 0;
      const governance = {
        getPostureForTenant: jest.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({
            allowPII: false,
            blockOnDetection: false,
            autoRedact: true,
            piiTypes: callCount === 1 ? ['email'] : ['email', 'ssn'],  // tightened
          });
        }),
      } as unknown as GovernanceService;
      // Real TTL — assertions test cache-hit/miss invalidation behavior, not the eviction-on-TTL path.
      const cache = new WorkflowPayloadCache({ ttlMs: 60_000 });
      const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance, cache);
      const ref = { system: 'netsuite', recordType: 'vendor', recordId: '1' } as const;

      // First resolve — connector hit, entry cached under fingerprint(['email'])
      await resolver.resolve([ref], 'tenant-C');
      expect(fakeConnector.read).toHaveBeenCalledTimes(1);

      // Second resolve — posture now ['email', 'ssn']; fingerprint differs;
      // cache miss → connector re-hit
      await resolver.resolve([ref], 'tenant-C');
      expect(fakeConnector.read).toHaveBeenCalledTimes(2);
    });

    it('invalidates cache when autoRedact toggles', async () => {
      const fakeConnector = {
        read: jest.fn().mockResolvedValue(sampleRecord),
      };
      const dlp = buildDlp({ detected: false, findings: [] });
      let callCount = 0;
      const governance = {
        getPostureForTenant: jest.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({
            allowPII: false,
            blockOnDetection: false,
            autoRedact: callCount === 1,  // true first call, false second
            piiTypes: [],
          });
        }),
      } as unknown as GovernanceService;
      const cache = new WorkflowPayloadCache({ ttlMs: 60_000 });
      const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance, cache);
      const ref = { system: 'netsuite', recordType: 'vendor', recordId: '1' } as const;

      await resolver.resolve([ref], 'tenant-D');
      expect(fakeConnector.read).toHaveBeenCalledTimes(1);

      await resolver.resolve([ref], 'tenant-D');
      expect(fakeConnector.read).toHaveBeenCalledTimes(2);
    });

    it('cache hit when posture is unchanged across resolves', async () => {
      const fakeConnector = {
        read: jest.fn().mockResolvedValue(sampleRecord),
      };
      const dlp = buildDlp({ detected: false, findings: [] });
      const governance = mockGovernance({
        allowPII: false,
        blockOnDetection: false,
        autoRedact: true,
        piiTypes: ['email'],
      });
      const cache = new WorkflowPayloadCache({ ttlMs: 60_000 });
      const resolver = buildResolver(buildConnectors(fakeConnector), dlp, governance, cache);
      const ref = { system: 'netsuite', recordType: 'vendor', recordId: '1' } as const;

      // First resolve — connector hit, entry cached
      await resolver.resolve([ref], 'tenant-E');
      expect(fakeConnector.read).toHaveBeenCalledTimes(1);

      // Second resolve — same posture (mockGovernance returns same object) →
      // fingerprint matches → cache HIT, no second connector call
      await resolver.resolve([ref], 'tenant-E');
      expect(fakeConnector.read).toHaveBeenCalledTimes(1);
    });
  });
});
