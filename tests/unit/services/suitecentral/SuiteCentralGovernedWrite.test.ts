import { governedBulkImport, governedWrite, governedSetupWebhook, governedRemoveWebhook } from '../../../../src/services/suitecentral/controlPlane/suiteCentralGovernedWrite';
import { SuiteCentralDestinationRejectedError } from '../../../../src/services/suitecentral/controlPlane/errors';
import type { SuiteCentralControlPlaneContext } from '../../../../src/services/suitecentral/controlPlane/domain';
import type { DataRecord } from '../../../../src/types';
import type { OutboundDecision } from '../../../../src/services/governance/OutboundGovernanceService';

const context: SuiteCentralControlPlaneContext = {
  actorUserId: 'user-1',
  targetTenantId: 'tenant-a',
  accessMode: 'tenant_admin',
  correlationId: 'corr-1',
};

const records = [{ id: 'r1', fields: { name: 'Acme' } }] as unknown as DataRecord[];

/**
 * Build an approved-by-default OutboundDecision typed to the ACTUAL payload the
 * governed call scans (records[] for bulk, a single record for create/update, a
 * `{ id }` / `{ webhookId }` descriptor for delete/remove) — no lossy casts, so
 * the test reflects the real fail-closed contract.
 */
function decision<T>(redactedPayload: T, overrides: Partial<OutboundDecision<T>> = {}): OutboundDecision<T> {
  return {
    approved: true,
    approvalRequired: false,
    redactedPayload,
    findings: [],
    riskLevel: 'none',
    auditMetadata: { scanDurationMs: 1, findingsCount: 0, redacted: false, blocked: false },
    ...overrides,
  };
}

const blockedAudit = { scanDurationMs: 1, findingsCount: 1, redacted: false, blocked: true };

describe('governedBulkImport', () => {
  it('routes records through validateConnectorWrite and imports the redacted payload on approval', async () => {
    const redacted = [{ id: 'r1', fields: { name: '[REDACTED]' } }] as unknown as DataRecord[];
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision(redacted)),
    };
    const connector = { bulkImport: jest.fn(async () => 'op-123') };

    const result = await governedBulkImport({ outboundGovernance }, connector, context, 'customers', records);

    expect(result).toBe('op-123');
    expect(outboundGovernance.validateConnectorWrite).toHaveBeenCalledWith(
      records,
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'user-1',
        destination: 'connector_write',
        destinationDetail: 'suitecentral.bulk_import.customers',
        operationType: 'write',
        resourceType: 'customers',
      }),
    );
    // The connector receives the REDACTED payload, never the raw records.
    expect(connector.bulkImport).toHaveBeenCalledWith('customers', redacted);
  });

  it('fails closed (throws, no import) when the decision is blocked', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision(records, { approved: false, redactedPayload: undefined, auditMetadata: blockedAudit })),
    };
    const connector = { bulkImport: jest.fn() };

    await expect(governedBulkImport({ outboundGovernance }, connector, context, 'customers', records))
      .rejects.toBeInstanceOf(SuiteCentralDestinationRejectedError);
    expect(connector.bulkImport).not.toHaveBeenCalled();
  });

  it('fails closed when redactedPayload is undefined even if approved is true', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision(records, { approved: true, redactedPayload: undefined })),
    };
    const connector = { bulkImport: jest.fn() };

    await expect(governedBulkImport({ outboundGovernance }, connector, context, 'customers', records))
      .rejects.toBeInstanceOf(SuiteCentralDestinationRejectedError);
    expect(connector.bulkImport).not.toHaveBeenCalled();
  });
});

describe('governedWrite (single-record verbs)', () => {
  const record = { id: 'c1', fields: { name: 'Acme' } } as unknown as DataRecord;
  const redacted = { id: 'c1', fields: { name: '[REDACTED]' } } as unknown as DataRecord;

  function connectorMock() {
    return {
      create: jest.fn(async () => redacted),
      update: jest.fn(async () => redacted),
      delete: jest.fn(async () => true),
    };
  }

  it('create: validates the record and creates with the REDACTED payload', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision(redacted)),
    };
    const connector = connectorMock();

    await governedWrite({ outboundGovernance }, connector, context, {
      operation: 'create',
      entityType: 'customers',
      record,
    });

    expect(outboundGovernance.validateConnectorWrite).toHaveBeenCalledWith(
      record,
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'user-1',
        destination: 'connector_write',
        destinationDetail: 'suitecentral.create.customers',
        operationType: 'write',
        resourceType: 'customers',
      }),
    );
    expect(connector.create).toHaveBeenCalledWith('customers', redacted);
  });

  it('update: validates the record and updates with the REDACTED payload', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision(redacted)),
    };
    const connector = connectorMock();

    await governedWrite({ outboundGovernance }, connector, context, {
      operation: 'update',
      entityType: 'customers',
      id: 'c1',
      record,
    });

    expect(outboundGovernance.validateConnectorWrite).toHaveBeenCalledWith(
      record,
      expect.objectContaining({ destinationDetail: 'suitecentral.update.customers', resourceId: 'c1' }),
    );
    expect(connector.update).toHaveBeenCalledWith('customers', 'c1', redacted);
  });

  it('delete: gates on the id descriptor and deletes only on approval', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision({ id: 'c1' })),
    };
    const connector = connectorMock();

    const result = await governedWrite({ outboundGovernance }, connector, context, {
      operation: 'delete',
      entityType: 'customers',
      id: 'c1',
    });

    expect(result).toBe(true);
    expect(outboundGovernance.validateConnectorWrite).toHaveBeenCalledWith(
      { id: 'c1' },
      expect.objectContaining({ destinationDetail: 'suitecentral.delete.customers', resourceId: 'c1' }),
    );
    expect(connector.delete).toHaveBeenCalledWith('customers', 'c1');
  });

  it('delete: fails closed when governance alters the identifier', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision({ id: '[REDACTED]' })),
    };
    const connector = connectorMock();

    await expect(governedWrite({ outboundGovernance }, connector, context, {
      operation: 'delete',
      entityType: 'customers',
      id: 'c1',
    })).rejects.toBeInstanceOf(SuiteCentralDestinationRejectedError);
    expect(connector.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['blocked', { approved: false, redactedPayload: undefined, auditMetadata: blockedAudit }],
    ['not approved', { approved: false }],
    ['undefined redactedPayload', { approved: true, redactedPayload: undefined }],
  ] as const)('each verb fails closed when the decision is %s', async (_label, overrides) => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision<unknown>({ id: 'c1' }, overrides)),
    };

    for (const op of [
      { operation: 'create', entityType: 'customers', record } as const,
      { operation: 'update', entityType: 'customers', id: 'c1', record } as const,
      { operation: 'delete', entityType: 'customers', id: 'c1' } as const,
    ]) {
      const connector = connectorMock();
      await expect(governedWrite({ outboundGovernance }, connector, context, op))
        .rejects.toBeInstanceOf(SuiteCentralDestinationRejectedError);
      expect(connector.create).not.toHaveBeenCalled();
      expect(connector.update).not.toHaveBeenCalled();
      expect(connector.delete).not.toHaveBeenCalled();
    }
  });
});

describe('governed webhook lifecycle', () => {
  const subscription = { targetUrl: 'https://hooks.example/receive', events: ['customer.updated'] };

  it('setupWebhook: validates the subscription and sets up with the approved payload', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision(subscription)),
    };
    const connector = { setupWebhook: jest.fn(async () => 'wh-1') };

    const result = await governedSetupWebhook({ outboundGovernance }, connector, context, subscription);

    expect(result).toBe('wh-1');
    expect(outboundGovernance.validateConnectorWrite).toHaveBeenCalledWith(
      subscription,
      expect.objectContaining({ destinationDetail: 'suitecentral.webhook.setup', resourceType: 'webhook' }),
    );
    expect(connector.setupWebhook).toHaveBeenCalledWith(subscription.targetUrl, subscription.events);
  });

  it('setupWebhook: fails closed when blocked', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision(subscription, { approved: false, redactedPayload: undefined, auditMetadata: blockedAudit })),
    };
    const connector = { setupWebhook: jest.fn() };
    await expect(governedSetupWebhook({ outboundGovernance }, connector, context, subscription))
      .rejects.toBeInstanceOf(SuiteCentralDestinationRejectedError);
    expect(connector.setupWebhook).not.toHaveBeenCalled();
  });

  it('setupWebhook: refuses a target URL that governance altered', async () => {
    // The target was validated against the allowlist + live DNS before this call,
    // so a redacted target is no longer that validated destination — dispatching
    // it would hand the ERP an unvalidated callback URL. This is the same
    // invariant removeWebhook and delete already enforce on their identifiers.
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () =>
        decision({ targetUrl: 'https://[REDACTED]/receive', events: subscription.events }),
      ),
    };
    const connector = { setupWebhook: jest.fn(async () => 'wh-1') };

    await expect(governedSetupWebhook({ outboundGovernance }, connector, context, subscription))
      .rejects.toBeInstanceOf(SuiteCentralDestinationRejectedError);
    expect(connector.setupWebhook).not.toHaveBeenCalled();
  });

  it('removeWebhook: gates on the id and removes only on approval', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision({ webhookId: 'wh-1' })),
    };
    const connector = { removeWebhook: jest.fn(async () => true) };

    const result = await governedRemoveWebhook({ outboundGovernance }, connector, context, 'wh-1');

    expect(result).toBe(true);
    expect(connector.removeWebhook).toHaveBeenCalledWith('wh-1');
  });

  it('removeWebhook: fails closed when governance alters the id', async () => {
    const outboundGovernance = {
      validateConnectorWrite: jest.fn(async () => decision({ webhookId: 'other' })),
    };
    const connector = { removeWebhook: jest.fn() };
    await expect(governedRemoveWebhook({ outboundGovernance }, connector, context, 'wh-1'))
      .rejects.toBeInstanceOf(SuiteCentralDestinationRejectedError);
    expect(connector.removeWebhook).not.toHaveBeenCalled();
  });
});
