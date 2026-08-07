/**
 * FlowExecutor — guardedWrite unification (PR 13b Stage C).
 *
 * Verifies that the migrated FlowExecutor.dispatch produces the spec-contracted
 * FlowBlockedResult shapes for the three WriteBlockedError subclasses thrown by
 * guardedWrite:
 *
 *   - OwnershipViolationError → `{reason: 'ownership', ownership.conflictPolicy: 'reject_with_alert'}`
 *   - OwnershipBlockedError   → `{reason: 'ownership', ownership.conflictPolicy: 'source_wins'}`
 *   - LoopDetectedError       → `{reason: 'loop', loop: {breakingCondition, callerSystem, targetSystem, correlationId}}`
 *
 * Narrower than the end-to-end test in `guardedWrite.endToEnd.test.ts`: we mock
 * OwnershipResolver + auditService + approvalQueue so only the error → FlowBlockedResult
 * mapping at `src/flows/templates/FlowExecutor.ts:456-499` is exercised.
 */

import 'reflect-metadata';
import { FlowExecutor } from '../../src/flows/templates/FlowExecutor';
import { OwnershipResolver } from '../../src/governance/sourceOfTruth/OwnershipResolver';
import {
  OwnershipViolationError,
  OwnershipBlockedError,
  LoopDetectedError,
  QueueForHumanNotYetSafeError,
} from '../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import type { OutboundGovernanceService } from '../../src/services/governance/OutboundGovernanceService';
import type { ApprovalQueueService } from '../../src/services/governance/ApprovalQueueService';
import type { AuditService } from '../../src/services/ai/orchestrator/AuditService';
import type { FlowTemplate, FlowContext } from '../../src/flows/templates/FlowTemplate';
import type { IConnector } from '../../src/interfaces/IConnector';
import type { Logger } from '../../src/utils/Logger';

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
    id: 'ownership-unification-test-v1',
    category: 'master_data_sync',
    version: '1.0.0',
    // payment owner = stripe; using netsuite as caller surfaces a non-owner write
    // for source_wins. customer owner = netsuite; using hubspot as caller surfaces
    // reject_with_alert. Loop scenarios reuse the payment manifest's known loop.
    source: { system: 'netsuite', eventType: 'created' },
    target: { system: 'stripe', recordType: 'Payment', canonicalEntity: 'payment', operation: 'create' },
    description: 'unification fixture',
    governanceCallouts: [],
    transform: async (e) => ({ id: e.id }),
    riskClassification: () => 'low',
    retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotencyKey: (e) => String((e as { id: string }).id) },
  };
}

describe('FlowExecutor — guardedWrite unification (PR 13b Stage C)', () => {
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
    // Connector contract check: template.target.system='stripe' must match
    // connector.systemType case-normalized. Tests targeting payment use a
    // Stripe-shaped stub.
    (connector as unknown as { systemType: string }).systemType = 'stripe';
    ctx = {
      tenantId: 't-1',
      correlationId: 'corr-unify-1',
      connector,
    };
  });

  it('OwnershipViolationError → FlowBlockedResult{reason:"ownership", conflictPolicy:"reject_with_alert"}', async () => {
    // OwnershipResolver throws OwnershipViolationError directly for reject_with_alert.
    // guardedWrite re-throws (no override on hubspot caller); FlowExecutor's catch
    // block at L456 maps to FlowBlockedResult.
    ownershipResolver.validateWrite.mockRejectedValue(
      new OwnershipViolationError({
        entity: 'customer',
        declaredOwner: 'netsuite',
        callerSystem: 'hubspot',
        conflictPolicy: 'reject_with_alert',
        correlationId: 'corr-unify-1',
      }),
    );

    // Customer/reject_with_alert template to match the thrown error's entity.
    const template = stubTemplate();
    template.source.system = 'hubspot';
    template.target = { system: 'netsuite', recordType: 'Customer', canonicalEntity: 'customer', operation: 'create' };
    (connector as unknown as { systemType: string }).systemType = 'netsuite';

    const result = await executor.execute(template, { id: 'e-violation' }, ctx);

    expect(connector.create).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toBe('ownership');
    if (result.reason !== 'ownership') throw new Error('unreachable');
    expect(result.ownership).toEqual({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'hubspot',
      conflictPolicy: 'reject_with_alert',
      correlationId: 'corr-unify-1',
    });
    // The findings array carries the error.message (spec contract).
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain('reject_with_alert');
  });

  it('OwnershipBlockedError → FlowBlockedResult{reason:"ownership", conflictPolicy:"source_wins"}', async () => {
    // guardedWrite throws OwnershipBlockedError on source_wins non-owner write.
    // We simulate by returning {allowed:false, reason:'non_owner_write', policy:'source_wins'}
    // from validateWrite → guardedWrite throws OwnershipBlockedError → FlowExecutor maps.
    ownershipResolver.validateWrite.mockResolvedValue({
      allowed: false,
      reason: 'non_owner_write',
      policy: 'source_wins',
      declaredOwner: 'stripe',
    });

    // payment owner=stripe; netsuite caller writing to stripe = non-owner. Note
    // that FlowExecutor's caller/template inputs feed guardedWrite, which constructs
    // the OwnershipBlockedError with its own detail — the test pins the spec mapping
    // of `detail.policy` → `ownership.conflictPolicy` at FlowExecutor.ts:472-473.
    const template = stubTemplate();
    // Template: caller=netsuite writing to stripe (payment, source_wins).

    const result = await executor.execute(template, { id: 'e-blocked' }, ctx);

    expect(connector.create).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toBe('ownership');
    if (result.reason !== 'ownership') throw new Error('unreachable');
    expect(result.ownership).toEqual({
      entity: 'payment',
      declaredOwner: 'stripe',
      callerSystem: 'netsuite',
      // The FlowExecutor catch at L470-473 maps OwnershipBlockedError.detail.policy
      // (not .conflictPolicy) into the FlowBlockedResult.conflictPolicy field.
      // Pinning that to 'source_wins' proves the mapping is right.
      conflictPolicy: 'source_wins',
      correlationId: 'corr-unify-1',
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain('source_wins');
  });

  it('LoopDetectedError → FlowBlockedResult{reason:"loop", loop:{breakingCondition,callerSystem,targetSystem,correlationId}}', async () => {
    // payment owner=stripe; using stripe (the owner) as caller → validateWrite returns
    // allowed=true. Then guardedWrite calls detectLoop because the caller is a
    // SourceSystem. detectLoop returns loopDetected=true → guardedWrite throws
    // LoopDetectedError → FlowExecutor catch at L478 maps to reason:'loop'.
    ownershipResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'stripe' });
    ownershipResolver.detectLoop.mockResolvedValue({
      loopDetected: true,
      breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
    });

    // payment template; caller = stripe (owner) writing to stripe = self-write that
    // satisfies the allow path AND fires the loop check because stripe ∈ SOURCE_SYSTEMS.
    // Note: the manifest entry payment has knownLoops counterpart=netsuite, but the
    // mocked detectLoop above ignores the manifest and just returns true. That's
    // sufficient to verify FlowExecutor's mapping — the lineage<->manifest correctness
    // is exercised in OwnershipResolver.test.ts and in the e2e test.
    const template = stubTemplate();
    template.source.system = 'stripe';

    const result = await executor.execute(template, { id: 'e-loop' }, ctx);

    expect(connector.create).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toBe('loop');
    if (result.reason !== 'loop') throw new Error('unreachable');
    expect(result.loop).toEqual({
      breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      callerSystem: 'stripe',
      targetSystem: 'stripe',
      correlationId: 'corr-unify-1',
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain('LoopDetected');
  });

  // Copilot R14 on PR #851: QueueForHumanNotYetSafeError is the third
  // ownership-class WriteBlockedError; FlowExecutor's catch must map it
  // to reason:'ownership' with conflictPolicy:'queue_for_human' instead
  // of letting it fall through to status:'failed'.
  it('QueueForHumanNotYetSafeError → FlowBlockedResult{reason:"ownership", conflictPolicy:"queue_for_human"}', async () => {
    ownershipResolver.validateWrite.mockRejectedValue(
      new QueueForHumanNotYetSafeError({
        entity: 'customer',
        declaredOwner: 'netsuite',
        callerSystem: 'hubspot',
        correlationId: 'corr-unify-1',
      }),
    );

    const template = stubTemplate();
    template.source.system = 'hubspot';
    template.target = { system: 'netsuite', recordType: 'Customer', canonicalEntity: 'customer', operation: 'create' };
    (connector as unknown as { systemType: string }).systemType = 'netsuite';

    const result = await executor.execute(template, { id: 'e-queue-failclosed' }, ctx);

    expect(connector.create).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toBe('ownership');
    if (result.reason !== 'ownership') throw new Error('unreachable');
    expect(result.ownership).toEqual({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'hubspot',
      conflictPolicy: 'queue_for_human',
      correlationId: 'corr-unify-1',
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain('QueueForHumanNotYetSafe');
  });
});
