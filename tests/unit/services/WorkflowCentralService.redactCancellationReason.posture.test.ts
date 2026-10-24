import 'reflect-metadata';
import { WorkflowCentralService } from '../../../src/services/WorkflowCentralService';
import type { Logger } from '../../../src/utils/Logger';
import type { DLPService } from '../../../src/services/security/DLPService';
import type { GovernanceService, TenantGovernancePosture } from '../../../src/services/ai/orchestrator/GovernanceService';
import type { PIIFinding } from '../../../src/services/security/DLPService';

const fakeLogger: Pick<Logger, 'info' | 'warn' | 'error'> = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const REDACT_PLACEHOLDER = '[redacted: dlp failed-closed]';

function buildService(
  dlp: Pick<DLPService, 'scanText' | 'redactData'>,
  governance: Pick<GovernanceService, 'getPostureForTenant'>,
): WorkflowCentralService {
  return new WorkflowCentralService(
    fakeLogger as unknown as Logger,
    null as any,
    null as any,
    null as any,
    null as any,
    dlp as unknown as DLPService,
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

describe('WorkflowCentralService — redactCancellationReason per-tenant posture', () => {
  it('returns null if reason is undefined or empty', async () => {
    const service = buildService({} as any, {} as any);
    const result1 = await (service as any).redactCancellationReason(undefined, 'tenant-1', 'inst-1');
    const result2 = await (service as any).redactCancellationReason('', 'tenant-1', 'inst-1');

    expect(result1).toBeNull();
    expect(result2).toBeNull();
  });

  it('bypasses scan completely when allowPII is true', async () => {
    const dlp = {
      scanText: jest.fn(),
      redactData: jest.fn(),
    };
    const governance = mockGovernance({ allowPII: true });
    const service = buildService(dlp, governance);

    const result = await (service as any).redactCancellationReason('Cancellation reason with SSN 000-12-3456', 'tenant-1', 'inst-1');

    expect(dlp.scanText).not.toHaveBeenCalled();
    expect(result).toBe('Cancellation reason with SSN 000-12-3456');
  });

  it('returns reason if scan has no findings', async () => {
    const dlp = {
      scanText: jest.fn().mockResolvedValue({ findings: [] }),
      redactData: jest.fn(),
    };
    const governance = mockGovernance();
    const service = buildService(dlp, governance);

    const result = await (service as any).redactCancellationReason('Clean cancellation reason', 'tenant-1', 'inst-1');

    expect(dlp.scanText).toHaveBeenCalledWith('Clean cancellation reason', expect.objectContaining({ allowPII: false }));
    expect(result).toBe('Clean cancellation reason');
  });

  it('returns placeholder if scanText throws', async () => {
    const dlp = {
      scanText: jest.fn().mockRejectedValue(new Error('DLP service down')),
      redactData: jest.fn(),
    };
    const governance = mockGovernance();
    const service = buildService(dlp, governance);

    const result = await (service as any).redactCancellationReason('SSN 000-12-3456', 'tenant-1', 'inst-1');

    expect(result).toBe(REDACT_PLACEHOLDER);
  });

  it('filters findings using piiTypes allowlist', async () => {
    const findings: PIIFinding[] = [
      { type: 'ssn', value: '000-12-3456', confidence: 1.0, location: { path: '' }, severity: 'high', redactedValue: '[REDACTED]' },
      { type: 'email', value: 'test@example.com', confidence: 1.0, location: { path: '' }, severity: 'medium', redactedValue: '[REDACTED]' }
    ];
    const dlp = {
      scanText: jest.fn().mockResolvedValue({ findings }),
      redactData: jest.fn().mockReturnValue('Cancellation reason with SSN 000-12-3456 and [REDACTED]'),
    };
    const governance = mockGovernance({ piiTypes: ['email'] });
    const service = buildService(dlp, governance);

    const result = await (service as any).redactCancellationReason(
      'Cancellation reason with SSN 000-12-3456 and test@example.com',
      'tenant-1',
      'inst-1'
    );

    expect(dlp.redactData).toHaveBeenCalledWith(
      'Cancellation reason with SSN 000-12-3456 and test@example.com',
      [{ type: 'email', value: 'test@example.com', confidence: 1.0, location: { path: '' }, severity: 'medium', redactedValue: '[REDACTED]' }]
    );
    expect(result).toBe('Cancellation reason with SSN 000-12-3456 and [REDACTED]');
  });

  it('returns reason unmodified if piiTypes filters out all findings', async () => {
    const findings: PIIFinding[] = [
      { type: 'ssn', value: '000-12-3456', confidence: 1.0, location: { path: '' }, severity: 'high', redactedValue: '[REDACTED]' }
    ];
    const dlp = {
      scanText: jest.fn().mockResolvedValue({ findings }),
      redactData: jest.fn(),
    };
    const governance = mockGovernance({ piiTypes: ['email'] });
    const service = buildService(dlp, governance);

    const result = await (service as any).redactCancellationReason(
      'Cancellation reason with SSN 000-12-3456',
      'tenant-1',
      'inst-1'
    );

    expect(dlp.redactData).not.toHaveBeenCalled();
    expect(result).toBe('Cancellation reason with SSN 000-12-3456');
  });

  it('returns placeholder if blockOnDetection is true and findings exist', async () => {
    const findings: PIIFinding[] = [
      { type: 'ssn', value: '000-12-3456', confidence: 1.0, location: { path: '' }, severity: 'high', redactedValue: '[REDACTED]' }
    ];
    const dlp = {
      scanText: jest.fn().mockResolvedValue({ findings }),
      redactData: jest.fn(),
    };
    const governance = mockGovernance({ blockOnDetection: true });
    const service = buildService(dlp, governance);

    const result = await (service as any).redactCancellationReason(
      'SSN 000-12-3456',
      'tenant-1',
      'inst-1'
    );

    expect(result).toBe(REDACT_PLACEHOLDER);
  });

  it('returns placeholder if autoRedact is false and findings exist', async () => {
    const findings: PIIFinding[] = [
      { type: 'ssn', value: '000-12-3456', confidence: 1.0, location: { path: '' }, severity: 'high', redactedValue: '[REDACTED]' }
    ];
    const dlp = {
      scanText: jest.fn().mockResolvedValue({ findings }),
      redactData: jest.fn(),
    };
    const governance = mockGovernance({ autoRedact: false });
    const service = buildService(dlp, governance);

    const result = await (service as any).redactCancellationReason(
      'SSN 000-12-3456',
      'tenant-1',
      'inst-1'
    );

    expect(result).toBe(REDACT_PLACEHOLDER);
  });

  it('returns placeholder if redactData returns undefined', async () => {
    const findings: PIIFinding[] = [
      { type: 'ssn', value: '000-12-3456', confidence: 1.0, location: { path: '' }, severity: 'high', redactedValue: '[REDACTED]' }
    ];
    const dlp = {
      scanText: jest.fn().mockResolvedValue({ findings }),
      redactData: jest.fn().mockReturnValue(undefined),
    };
    const governance = mockGovernance();
    const service = buildService(dlp, governance);

    const result = await (service as any).redactCancellationReason(
      'SSN 000-12-3456',
      'tenant-1',
      'inst-1'
    );

    expect(result).toBe(REDACT_PLACEHOLDER);
  });
});
