import 'reflect-metadata';
import { FlowExecutor } from '../../../../src/flows/templates/FlowExecutor';
import { OwnershipResolver } from '../../../../src/governance/sourceOfTruth/OwnershipResolver';
import { OwnershipViolationError, OwnershipBlockedError } from '../../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import type { OutboundGovernanceService } from '../../../../src/services/governance/OutboundGovernanceService';
import type { ApprovalQueueService } from '../../../../src/services/governance/ApprovalQueueService';
import type { AuditService } from '../../../../src/services/ai/orchestrator/AuditService';
import type { FlowTemplate, FlowContext } from '../../../../src/flows/templates/FlowTemplate';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import type { Logger } from '../../../../src/utils/Logger';

function silentLogger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
}

function stubConnector(): jest.Mocked<IConnector> {
  return {
    systemType: 'NetSuite',
    initialize: jest.fn().mockResolvedValue(undefined),
    isInitialized: jest.fn().mockReturnValue(true),
    testConnection: jest.fn().mockResolvedValue({ success: true }),
    create: jest.fn().mockResolvedValue({ id: 'ns-1' }),
    read: jest.fn(),
    update: jest.fn().mockResolvedValue({ id: 'ns-1' }),
    delete: jest.fn().mockResolvedValue(true),
    list: jest.fn(),
    search: jest.fn(),
    getEntityTypes: jest.fn(),
    getFieldMappings: jest.fn(),
    syncBatch: jest.fn(),
  } as unknown as jest.Mocked<IConnector>;
}

function stubTemplate(): FlowTemplate<{ id: string }, Record<string, unknown>> {
  return {
    id: 'ownership-test-v1',
    category: 'master_data_sync',
    version: '1.0.0',
    source: { system: 'hubspot', eventType: 'created' },
    target: { system: 'netsuite', recordType: 'Customer', canonicalEntity: 'customer', operation: 'create' },
    description: 'fixture',
    governanceCallouts: [],
    transform: async (e) => ({ id: e.id }),
    riskClassification: () => 'low',
    retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotencyKey: (e) => String((e as { id: string }).id) },
  };
}

describe('FlowExecutor — ownership pre-flight', () => {
  let outboundGovernance: jest.Mocked<OutboundGovernanceService>;
  let approvalQueue: jest.Mocked<ApprovalQueueService>;
  let auditService: jest.Mocked<Pick<AuditService, 'logGovernanceCheck'>>;
  let ownershipResolver: jest.Mocked<Pick<OwnershipResolver, 'validateWrite' | 'ownerFor' | 'detectLoop'>>;
  let executor: FlowExecutor;
  let connector: jest.Mocked<IConnector>;
  let ctx: FlowContext;

  beforeEach(() => {
    outboundGovernance = {
      validateConnectorWrite: jest.fn().mockResolvedValue({
        approved: true,
        approvalRequired: false,
        redactedPayload: null as unknown,
        findings: [] as string[],
      }),
    } as unknown as jest.Mocked<OutboundGovernanceService>;
    approvalQueue = { enqueue: jest.fn() } as unknown as jest.Mocked<ApprovalQueueService>;
    auditService = {
      logGovernanceCheck: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Pick<AuditService, 'logGovernanceCheck'>>;
    // Cast the whole object to dodge per-method jest.fn() inference — the
    // declared `jest.Mocked<Pick<OwnershipResolver, ...>>` shape requires
    // exact arg/return narrowing that bare `jest.fn()` doesn't satisfy.
    ownershipResolver = {
      validateWrite: jest.fn(),
      ownerFor: jest.fn(),
      detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
    } as unknown as jest.Mocked<Pick<OwnershipResolver, 'validateWrite' | 'ownerFor' | 'detectLoop'>>;
    executor = new FlowExecutor(
      silentLogger(),
      outboundGovernance,
      approvalQueue,
      ownershipResolver as unknown as OwnershipResolver,
      auditService as unknown as AuditService,
    );
    connector = stubConnector();
    ctx = {
      tenantId: 't-1',
      correlationId: 'corr-1',
      connector,
    };
  });

  it('source_wins block: guardedWrite blocks at dispatch — no connector call, no enqueue, returns blocked/ownership', async () => {
    ownershipResolver.validateWrite.mockResolvedValue({
      allowed: false,
      reason: 'non_owner_write',
      policy: 'source_wins',
      declaredOwner: 'netsuite',
    });

    const result = await executor.execute(stubTemplate(), { id: 'e-1' }, ctx);

    expect(connector.create).not.toHaveBeenCalled();
    expect(approvalQueue.enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'blocked',
      reason: 'ownership',
      findings: [expect.stringContaining('source_wins')],
      ownership: {
        entity: 'customer',
        declaredOwner: 'netsuite',
        callerSystem: 'hubspot',
        conflictPolicy: 'source_wins',
        correlationId: 'corr-1',
      },
    });
  });

  it('reject_with_alert throw: guardedWrite blocks at dispatch — no connector call, no enqueue, returns blocked/ownership', async () => {
    ownershipResolver.validateWrite.mockRejectedValue(new OwnershipViolationError({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'hubspot',
      conflictPolicy: 'reject_with_alert',
      correlationId: 'corr-1',
    }));

    const result = await executor.execute(stubTemplate(), { id: 'e-2' }, ctx);

    expect(connector.create).not.toHaveBeenCalled();
    expect(approvalQueue.enqueue).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked' && result.reason === 'ownership') {
      expect(result.ownership).toEqual({
        entity: 'customer',
        declaredOwner: 'netsuite',
        callerSystem: 'hubspot',
        conflictPolicy: 'reject_with_alert',
        correlationId: 'corr-1',
      });
    } else {
      fail('expected blocked/ownership result');
    }
  });

  it('owner write: ownership passes, proceeds to validateConnectorWrite', async () => {
    ownershipResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'netsuite' });

    // Make the source SAME as the target to model "owner writing to itself"
    const template = stubTemplate();
    template.source.system = 'netsuite';
    await executor.execute(template, { id: 'e-3' }, ctx);

    expect(ownershipResolver.validateWrite).toHaveBeenCalledTimes(1);
    expect(outboundGovernance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    expect(connector.create).toHaveBeenCalledTimes(1);
  });
});
