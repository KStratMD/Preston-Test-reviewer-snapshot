import { SuiteCentralAuditWriter } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralAuditWriter';
import type { Logger } from '../../../../src/utils/Logger';
import type { SuiteCentralControlPlaneContext } from '../../../../src/services/suitecentral/controlPlane/domain';

const SECRET = 'super-secret-value';
// resource_id always holds one of OUR generated uuids in production; a non-uuid
// fixture would exercise the digest path instead of the real one.
const ENV_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const context: SuiteCentralControlPlaneContext = {
  actorUserId: 'user-1',
  targetTenantId: 'tenant-a',
  accessMode: 'tenant_admin',
  correlationId: 'corr-1',
};

/** Approve everything, echoing the payload back untouched. */
function approvingDecision<T>(payload: T) {
  return {
    approved: true,
    approvalRequired: false,
    redactedPayload: payload,
    findings: [],
    auditMetadata: { blocked: false },
  };
}

describe('SuiteCentralAuditWriter', () => {
  let auditLogRepository: { create: jest.Mock };
  let outboundGovernance: { validateAuditLogPayload: jest.Mock };
  let logger: Logger;
  let writer: SuiteCentralAuditWriter;

  beforeEach(() => {
    auditLogRepository = { create: jest.fn(async (row: unknown) => row) };
    outboundGovernance = {
      validateAuditLogPayload: jest.fn(async (payload: unknown) => approvingDecision(payload)),
    };
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    writer = new SuiteCentralAuditWriter(auditLogRepository, outboundGovernance, logger);
  });

  it('routes details through outbound governance BEFORE persisting the row', async () => {
    const order: string[] = [];
    outboundGovernance.validateAuditLogPayload.mockImplementation(async (payload: unknown) => {
      order.push('governance');
      return approvingDecision(payload);
    });
    auditLogRepository.create.mockImplementation(async (row: unknown) => {
      order.push('persist');
      return row;
    });

    await writer.attempt(context, 'environment.create', 'environment', ENV_ID, { name: 'prod' });

    expect(order).toEqual(['governance', 'persist']);
    expect(outboundGovernance.validateAuditLogPayload).toHaveBeenCalledWith(
      { name: 'prod' },
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'user-1',
        destination: 'audit_log',
        destinationDetail: 'audit_logs.details',
        operationType: 'write',
        resourceType: 'environment',
        resourceId: ENV_ID,
      }),
    );
  });

  it('persists identity, correlation, and access mode with an explicit id and timestamp', async () => {
    await writer.attempt(context, 'environment.create', 'environment', ENV_ID, { name: 'prod' });

    const row = auditLogRepository.create.mock.calls[0][0];
    expect(row).toMatchObject({
      tenant_id: 'tenant-a',
      user_id: 'user-1',
      action: 'suitecentral.environment.create.attempt',
      resource_type: 'environment',
      resource_id: ENV_ID,
      result: 'success',
    });
    // The portable audit_logs schema is not relied on to generate these.
    expect(typeof row.id).toBe('string');
    expect(row.id.length).toBeGreaterThan(0);
    expect(() => new Date(row.created_at as string).toISOString()).not.toThrow();
    // Access mode + correlation id travel in details.
    expect(row.details).toMatchObject({ accessMode: 'tenant_admin', correlationId: 'corr-1' });
  });

  it('records success with a duration and failure with a stable code', async () => {
    await writer.success(context, 'connection.test', 'environment', ENV_ID, { ok: true }, 42);
    await writer.failure(context, 'connection.test', 'environment', ENV_ID, 'upstream_unavailable', 7);

    const [successRow] = auditLogRepository.create.mock.calls[0];
    const [failureRow] = auditLogRepository.create.mock.calls[1];

    expect(successRow).toMatchObject({
      action: 'suitecentral.connection.test.success',
      result: 'success',
      duration_ms: 42,
      error_message: null,
    });
    expect(failureRow).toMatchObject({
      action: 'suitecentral.connection.test.failure',
      result: 'failure',
      duration_ms: 7,
      error_message: 'upstream_unavailable',
    });
  });

  it('omits details entirely when governance blocks the payload', async () => {
    outboundGovernance.validateAuditLogPayload.mockResolvedValue({
      approved: false,
      approvalRequired: false,
      redactedPayload: undefined,
      findings: ['ssn'],
      auditMetadata: { blocked: true },
    });

    await writer.attempt(context, 'environment.create', 'environment', ENV_ID, { note: 'sensitive' });

    const row = auditLogRepository.create.mock.calls[0][0];
    expect(row.details).toMatchObject({ omittedByOutboundGovernance: true });
    expect(JSON.stringify(row.details)).not.toContain('sensitive');
  });

  it('persists the redacted payload, never the raw details', async () => {
    outboundGovernance.validateAuditLogPayload.mockResolvedValue({
      approved: true,
      approvalRequired: false,
      redactedPayload: { note: '[REDACTED]' },
      findings: ['email'],
      auditMetadata: { blocked: false },
    });

    await writer.attempt(context, 'environment.create', 'environment', ENV_ID, {
      note: 'person@example.com',
    });

    const row = auditLogRepository.create.mock.calls[0][0];
    expect(JSON.stringify(row.details)).not.toContain('person@example.com');
    expect(row.details).toMatchObject({ note: '[REDACTED]' });
  });

  it.each(['clientSecret', 'apiToken', 'password', 'authHeader', 'CLIENT_SECRET'])(
    'refuses to persist a detail key that looks secret-bearing: %s',
    async (key) => {
      await expect(
        writer.attempt(context, 'credential.create', 'credential', 'cred-1', { [key]: SECRET }),
      ).rejects.toThrow(/forbidden_detail_key/);

      expect(auditLogRepository.create).not.toHaveBeenCalled();
      expect(outboundGovernance.validateAuditLogPayload).not.toHaveBeenCalled();
    },
  );

  // The writer's contract is a key-NAME guard plus governance. It cannot detect a
  // secret hidden under an innocuous key (`{ note: '<secret>' }`) — that guarantee
  // belongs to the service, which must never hand secret material to the writer at
  // all. What the writer must guarantee is that a rejected key leaks nowhere: not
  // through the throw, the logger, governance, or the row.
  it('leaks a rejected key\'s value nowhere — not the error, the logger, or any backend', async () => {
    const error = await writer
      .attempt(context, 'credential.create', 'credential', 'cred-1', { clientSecret: SECRET })
      .catch((e: unknown) => e as Error);

    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(SECRET);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify((logger.debug as jest.Mock).mock.calls)).not.toContain(SECRET);
    expect(auditLogRepository.create).not.toHaveBeenCalled();
    expect(outboundGovernance.validateAuditLogPayload).not.toHaveBeenCalled();
  });

  it('digests a resource id that is not one of our generated uuids', async () => {
    // Several operations audit the attempt BEFORE the ownership check that would
    // reject a bogus id, and resource_id is not DLP-scanned — so caller text would
    // land verbatim in a durable, ungoverned column.
    await writer.attempt(context, 'monitoring.alert.resolve', 'alert', `hostile ${SECRET}`, {});

    const row = auditLogRepository.create.mock.calls[0][0];
    expect(row.resource_id).toMatch(/^digest:[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    // Governance context must not carry it either.
    expect(JSON.stringify(outboundGovernance.validateAuditLogPayload.mock.calls)).not.toContain(SECRET);
  });

  it('does not log the raw resource id when governance omits the details', async () => {
    // Sanitizing the durable column but logging the raw value would just move the
    // leak from the row to the log.
    outboundGovernance.validateAuditLogPayload.mockResolvedValue({
      approved: false,
      approvalRequired: false,
      redactedPayload: undefined,
      findings: ['ssn'],
      auditMetadata: { blocked: true },
    });

    await writer.attempt(context, 'monitoring.alert.resolve', 'alert', `hostile ${SECRET}`, {});

    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(SECRET);
  });

  it('keeps a generated uuid resource id verbatim so rows stay correlatable', async () => {
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    await writer.attempt(context, 'environment.create', 'environment', uuid, { name: 'prod' });

    expect(auditLogRepository.create.mock.calls[0][0].resource_id).toBe(uuid);
  });

  it('substitutes a correlation id that governance never scanned', async () => {
    // correlationId is merged AFTER the DLP scan so it survives redaction — which
    // means an unvetted one (it originates from a caller header) would be a
    // governance bypass into a durable row.
    const hostile = { ...context, correlationId: `x ${SECRET} <script>` };

    await writer.attempt(hostile, 'environment.create', 'environment', ENV_ID, { name: 'prod' });

    const row = auditLogRepository.create.mock.calls[0][0];
    expect(row.details).toMatchObject({ correlationId: 'invalid_correlation_id' });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('does not persist an access mode outside the domain', async () => {
    const hostile = { ...context, accessMode: 'root' as never };

    await writer.attempt(hostile, 'environment.create', 'environment', ENV_ID, { name: 'prod' });

    expect(auditLogRepository.create.mock.calls[0][0].details).toMatchObject({ accessMode: 'unknown' });
  });

  it('refuses a nested value that could hide a secret under an uninspected key', async () => {
    await expect(
      writer.attempt(context, 'credential.create', 'credential', 'cred-1', {
        // No forbidden key at the root — a key-name check alone would pass this.
        meta: { clientSecret: SECRET },
      } as never),
    ).rejects.toThrow(/non_primitive_detail_value/);

    expect(auditLogRepository.create).not.toHaveBeenCalled();
    expect(JSON.stringify(auditLogRepository.create.mock.calls)).not.toContain(SECRET);
  });

  it('refuses an undefined detail value rather than silently dropping the key', async () => {
    // JSON.stringify drops undefined-valued keys, so this would not fail loudly —
    // the field would just be absent from the row while the caller believed it was
    // recorded. `null` remains valid and distinct.
    await expect(
      writer.attempt(context, 'environment.create', 'environment', ENV_ID, {
        name: 'prod',
        apiVersion: undefined as never,
      }),
    ).rejects.toThrow(/undefined_detail_value/);

    expect(auditLogRepository.create).not.toHaveBeenCalled();
  });

  it('still accepts null as an explicit, recordable value', async () => {
    await writer.attempt(context, 'environment.create', 'environment', ENV_ID, { apiVersion: null });

    expect(auditLogRepository.create.mock.calls[0][0].details).toMatchObject({ apiVersion: null });
  });

  it('refuses a symbol-keyed detail that Object.keys cannot see', async () => {
    const details = { clientId: 'client-abc' } as Record<string, unknown>;
    (details as Record<symbol, unknown>)[Symbol('clientSecret')] = SECRET;

    await expect(
      writer.attempt(context, 'credential.create', 'credential', 'cred-1', details as never),
    ).rejects.toThrow(/symbol_detail_key/);

    expect(auditLogRepository.create).not.toHaveBeenCalled();
  });

  it('propagates a persistence failure so the caller can fail closed', async () => {
    auditLogRepository.create.mockRejectedValue(new Error('db down'));

    await expect(
      writer.attempt(context, 'environment.create', 'environment', ENV_ID, { name: 'prod' }),
    ).rejects.toThrow();
  });
});
