/**
 * guardedWrite — end-to-end integration test (PR 13b Stage C, Task 32).
 *
 * Exercises the full enqueue → operator-approve → resume-apply lifecycle
 * with real services wired through inversify:
 *   - real OwnershipResolver (with a fixture manifest injected so the
 *     queue_for_human path can be exercised without touching the live
 *     SOURCE_OF_TRUTH_MANIFEST)
 *   - real ApprovalQueueService + ApprovalResumeWorker + ApprovalResumeRegistry
 *   - real OwnershipResumeHandler (registered as the default handler for
 *     operationType='ownership_write')
 *   - real AuditService writing to the audit_logs table
 *   - mocked IConnector returned by a spied ConnectorManager.getConnector
 *
 * Seven scenarios cover the four conflict policies (allow / queue_for_human
 * pending / reject_with_alert reject / reject_with_alert override) plus the
 * loop-hazard guard and the missing-descriptor failure mode.
 */

import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { DatabaseService } from '../../src/database/DatabaseService';
import {
  setupTestDatabase,
  teardownTestDatabase,
  waitFor,
} from './helpers/syncErrorAssistTestHelpers';
import { guardedWrite } from '../../src/governance/sourceOfTruth/guardedWrite';
import { OwnershipResolver } from '../../src/governance/sourceOfTruth/OwnershipResolver';
import {
  LoopDetectedError,
  MissingWriteDescriptorError,
  OwnershipPendingApprovalError,
  OwnershipViolationError,
} from '../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import type { OwnershipDeclaration } from '../../src/governance/sourceOfTruth/SourceOfTruthManifest';
import { ApprovalQueueService } from '../../src/services/governance/ApprovalQueueService';
import { ApprovalQueueRepository } from '../../src/services/governance/ApprovalQueueRepository';
import { AuditService } from '../../src/services/ai/orchestrator/AuditService';
import type { ConnectorManager } from '../../src/services/integration/ConnectorManager';
import type { IConnector } from '../../src/interfaces/IConnector';
import type { LineageQueryService } from '../../src/services/lineage/LineageQueryService';

// ─────────────────────────────────────────────────────────────────────────────
// Test-fixture manifest. Three entries cover the four scenarios we drive:
//   - customer (queue_for_human) — scenarios 1, 2, 3, 4
//   - payment  (source_wins, knownLoops.netsuite) — scenario 7
//   - invoice  (reject_with_alert) — scenarios 5, 6
// ─────────────────────────────────────────────────────────────────────────────

const fixtureManifest: OwnershipDeclaration[] = [
  {
    entity: 'customer',
    owner: 'netsuite',
    consumers: ['salesforce'],
    conflictPolicy: 'queue_for_human',
    conflictPolicyRationale: 'PR 13b end-to-end fixture',
  },
  {
    entity: 'payment',
    owner: 'stripe',
    consumers: ['netsuite'],
    conflictPolicy: 'source_wins',
    conflictPolicyRationale: 'PR 13b loop fixture',
    knownLoops: [
      {
        counterpart: 'netsuite',
        windowMs: 60_000,
        breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      },
    ],
  },
  {
    entity: 'invoice',
    owner: 'netsuite',
    consumers: ['business_central'],
    conflictPolicy: 'reject_with_alert',
    conflictPolicyRationale: 'PR 13b reject_with_alert fixture',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Mock connector + ConnectorManager.getConnector spy
// ─────────────────────────────────────────────────────────────────────────────

interface MockConnector {
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  bulkCreate: jest.Mock;
  bulkUpdate: jest.Mock;
  bulkDelete: jest.Mock;
}

function makeMockConnector(): MockConnector {
  return {
    create: jest.fn().mockResolvedValue({ id: 'created-1' }),
    update: jest.fn().mockResolvedValue({ id: 'updated-1' }),
    delete: jest.fn().mockResolvedValue(true),
    bulkCreate: jest.fn().mockResolvedValue({ success: true }),
    bulkUpdate: jest.fn().mockResolvedValue({ success: true }),
    bulkDelete: jest.fn().mockResolvedValue({ success: true }),
  };
}

describe('guardedWrite — end-to-end lifecycle (PR 13b Stage C)', () => {
  let resolver: OwnershipResolver;
  let approvalQueue: ApprovalQueueService;
  let approvalRepo: ApprovalQueueRepository;
  let auditService: AuditService;
  let dbService: DatabaseService;
  let mockConnector: MockConnector;

  const TENANT = 'tenant-e2e';

  beforeAll(async () => {
    container.snapshot();
    await setupTestDatabase();

    // Build a mock ConnectorManager stub for the OwnershipResumeHandler to
    // call. Rebind TYPES.ConnectorManager to a constant-value stub BEFORE any
    // consumer resolves the original singleton — the handler is .inSingletonScope()
    // and stores the manager reference at construction time, so a post-hoc
    // jest.spyOn against the original singleton would NOT intercept the
    // handler's calls.
    mockConnector = makeMockConnector();
    const stubConnectorManager = {
      getConnector: jest.fn(async () => mockConnector as unknown as IConnector),
    } as unknown as ConnectorManager;
    container.rebind<ConnectorManager>(TYPES.ConnectorManager).toConstantValue(
      stubConnectorManager,
    );

    resolver = await container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
    approvalQueue = await container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
    approvalRepo = await container.getAsync<ApprovalQueueRepository>(TYPES.ApprovalQueueRepository);
    auditService = await container.getAsync<AuditService>(TYPES.AuditService);
    dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);

    // Ensure the OwnershipResumeHandler is bound + registered with the
    // ApprovalResumeRegistry. The async-bound factory in inversify.config.ts
    // performs `registry.setDefault('ownership_write', handler)` as a side
    // effect of resolution; it also resolves TYPES.ConnectorManager which now
    // returns our rebound stub.
    await container.getAsync(TYPES.OwnershipResumeHandler);

    // Inject the fixture manifest. This mirrors the pattern used by
    // OwnershipResolver.queueRequired.test.ts and is necessary because
    // the live SOURCE_OF_TRUTH_MANIFEST doesn't currently include a
    // queue_for_human entry (the live customer entry is reject_with_alert).
    (resolver as unknown as { manifest: OwnershipDeclaration[] }).manifest =
      fixtureManifest;
  });

  afterAll(async () => {
    // No need to restore the spy — container.restore() pops the rebind below.
    await teardownTestDatabase();
    container.restore();
  });

  beforeEach(async () => {
    // Reset connector mocks + clear DB rows between scenarios.
    mockConnector.create.mockClear();
    mockConnector.update.mockClear();
    mockConnector.delete.mockClear();
    mockConnector.bulkCreate.mockClear();
    mockConnector.bulkUpdate.mockClear();
    mockConnector.bulkDelete.mockClear();
    const db = dbService.getDatabase();
    await sql`DELETE FROM governance_approvals`.execute(db);
    await sql`DELETE FROM audit_logs`.execute(db);
  });

  // Helper — query audit rows for our correlationId (sessionId in the
  // audit-row shape). The AuditService stores sessionId on the resource_id
  // column for governance_check events.
  async function auditRowsFor(correlationId: string) {
    return dbService
      .getDatabase()
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_id', '=', correlationId)
      .execute();
  }

  // Helper — query governance_approvals rows for our tenant.
  async function approvalsFor(tenantId: string) {
    return dbService
      .getDatabase()
      .selectFrom('governance_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
  }

  // ───────────────────────────────────────────────────────────────────
  // Scenario 1 — owner write under queue_for_human bypasses the queue
  // ───────────────────────────────────────────────────────────────────

  it('owner write passes guardedWrite without queue (queue_for_human, owner=netsuite)', async () => {
    const correlationId = `cor-${randomUUID()}`;
    const result = await guardedWrite(
      {
        context: {
          tenantId: TENANT,
          callerSystem: 'netsuite',
          targetSystem: 'netsuite',
          entity: 'customer',
          recordId: 'cust-1',
          correlationId,
          requesterUserId: 'system',
          operation: 'create',
        },
        do: async () => mockConnector.create('Customer', { id: 'cust-1' }),
      },
      {
        ownershipResolver: resolver,
        auditService,
        approvalQueueService: approvalQueue,
      },
    );

    expect(result).toEqual({ id: 'created-1' });
    expect(mockConnector.create).toHaveBeenCalledTimes(1);

    // No queue row was created.
    const approvals = await approvalsFor(TENANT);
    expect(approvals).toHaveLength(0);

    // 2 audit rows (decision + outcome) for this correlationId.
    const audits = await auditRowsFor(correlationId);
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      expect(row.action).toBe('validate_ownership');
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 2 — non-owner write under queue_for_human is LIVE (PR 13c-2)
  // ───────────────────────────────────────────────────────────────────
  //
  // PR 13c-2 Task 3 lifted the PR 13b fail-closed by encrypting args before
  // persisting into governance_approvals.write_descriptor. Scenarios 2-4
  // exercise the live enqueue → operator-approve → resume-dispatch lifecycle.
  // The encrypted-args invariant is covered by the unit tests; here we assert
  // the lifecycle wiring end-to-end against the real DB + real services.

  it('non-owner write under queue_for_human enqueues encrypted descriptor and throws OwnershipPendingApprovalError', async () => {
    const correlationId = `cor-${randomUUID()}`;
    let pendingErr: unknown;
    try {
      await guardedWrite(
        {
          context: {
            tenantId: TENANT,
            callerSystem: 'salesforce',
            targetSystem: 'netsuite',
            entity: 'customer',
            recordId: 'cust-q2',
            correlationId,
            requesterUserId: 'sf-bot',
            operation: 'update',
          },
          do: async () => mockConnector.update('Customer', 'cust-q2', { name: 'Confidential' }),
          resume: {
            targetSystemId: 'netsuite',
            operation: 'update',
            entityType: 'Customer',
            args: { id: 'cust-q2', data: { name: 'Confidential' } },
          },
        },
        {
          ownershipResolver: resolver,
          auditService,
          approvalQueueService: approvalQueue,
        },
      );
    } catch (err) {
      pendingErr = err;
    }
    expect(pendingErr).toBeInstanceOf(OwnershipPendingApprovalError);

    // One queue row written, operationType=ownership_write.
    const approvals = await approvalsFor(TENANT);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].operation_type).toBe('ownership_write');
    expect(approvals[0].status).toBe('pending');
    // The persisted write_descriptor must contain the encrypted envelope —
    // NOT the plaintext value 'Confidential' that lived in args.data.name.
    const persisted = approvals[0].write_descriptor as string;
    expect(typeof persisted).toBe('string');
    expect(persisted).not.toContain('Confidential');
    // Manifest vocabulary stays plaintext for queryability.
    expect(persisted).toContain('netsuite');

    // 1 audit row (decision only — outcome row fires only after operator
    // approval lands and the resume handler dispatches).
    const audits = await auditRowsFor(correlationId);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('validate_ownership');

    // Connector NOT called yet — queue is pending.
    expect(mockConnector.update).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 3 — queue path without resume descriptor is a programming error
  // ───────────────────────────────────────────────────────────────────

  it('non-owner write under queue_for_human WITHOUT resume → MissingWriteDescriptorError', async () => {
    const correlationId = `cor-${randomUUID()}`;
    await expect(
      guardedWrite(
        {
          context: {
            tenantId: TENANT,
            callerSystem: 'salesforce',
            targetSystem: 'netsuite',
            entity: 'customer',
            recordId: 'cust-q3',
            correlationId,
            requesterUserId: 'sf-bot',
            operation: 'create',
          },
          do: async () => mockConnector.create('Customer', { name: 'X' }),
          // resume intentionally omitted — queue path requires it now
        },
        {
          ownershipResolver: resolver,
          auditService,
          approvalQueueService: approvalQueue,
        },
      ),
    ).rejects.toBeInstanceOf(MissingWriteDescriptorError);

    // No queue row, no connector call. The decision audit row STILL fires
    // because it's emitted BEFORE the missing-descriptor throw.
    const approvals = await approvalsFor(TENANT);
    expect(approvals).toHaveLength(0);
    expect(mockConnector.create).not.toHaveBeenCalled();
    const audits = await auditRowsFor(correlationId);
    expect(audits).toHaveLength(1);
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 4 — operator approval triggers OwnershipResumeHandler dispatch
  // ───────────────────────────────────────────────────────────────────
  //
  // Un-skipped under PR 13c-2: the queue lift makes the enqueue → approve →
  // resume lifecycle live, so this scenario now exercises the full chain
  // against the real DB + ApprovalResumeWorker + OwnershipResumeHandler.

  it('operator approves queued row, OwnershipResumeHandler.apply() dispatches the write', async () => {
    const correlationId = `cor-${randomUUID()}`;
    // 1. Enqueue (mirrors Scenario 2, fresh correlationId).
    let pendingErr: unknown;
    try {
      await guardedWrite(
        {
          context: {
            tenantId: TENANT,
            callerSystem: 'salesforce',
            targetSystem: 'netsuite',
            entity: 'customer',
            recordId: 'cust-resume',
            correlationId,
            requesterUserId: 'sf-bot',
            operation: 'update',
          },
          do: async () => mockConnector.update('Customer', 'cust-resume', { name: 'Z' }),
          resume: {
            targetSystemId: 'netsuite',
            operation: 'update',
            entityType: 'Customer',
            args: { id: 'cust-resume', data: { name: 'Z' } },
          },
        },
        {
          ownershipResolver: resolver,
          auditService,
          approvalQueueService: approvalQueue,
        },
      );
    } catch (err) {
      pendingErr = err;
    }
    expect(pendingErr).toBeInstanceOf(OwnershipPendingApprovalError);
    const queueId = (pendingErr as OwnershipPendingApprovalError).queueId;

    // 2. Approve. ApprovalQueueService.approve() does CAS + fires the resume
    // worker fire-and-forget (`void this.fireResumeAsync(row)`). We poll for
    // connector.update to be called, then assert the audit + status flips.
    const decided = await approvalQueue.approve({
      tenantId: TENANT,
      id: queueId,
      approverUserId: 'operator-1',
      reason: 'approved by integration test',
    });
    expect(decided.status).toBe('approved');

    // Poll until the fire-and-forget resume completes (connector.update called).
    await waitFor(() => mockConnector.update.mock.calls.length === 1);

    // Connector called with the original descriptor args.
    expect(mockConnector.update).toHaveBeenCalledTimes(1);
    expect(mockConnector.update).toHaveBeenCalledWith('Customer', 'cust-resume', {
      name: 'Z',
    });

    // The row should now be marked approved + applyIdempotencyKey set.
    await waitFor(async () => {
      const row = await approvalRepo.getById(TENANT, queueId);
      return row !== null && row.status === 'approved' && row.applyIdempotencyKey !== null;
    });

    // The OwnershipResumeHandler emits a resume-time audit row keyed by
    // approval.id (the worker passes approval.id as sessionId). It carries
    // checkType='ownership', approved=true, flags=['resume_from_queue'].
    await waitFor(async () => {
      const rows = await dbService
        .getDatabase()
        .selectFrom('audit_logs')
        .selectAll()
        .where('resource_id', '=', queueId)
        .execute();
      return rows.length >= 1;
    });
    const resumeAudits = await dbService
      .getDatabase()
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_id', '=', queueId)
      .execute();
    expect(resumeAudits.length).toBeGreaterThanOrEqual(1);
    const resumeRow = resumeAudits[0];
    expect(resumeRow.action).toBe('validate_ownership');
    expect(resumeRow.result).toBe('success');
    // Inspect persisted details JSON. Per AuditPersistenceMapper, the envelope
    // shape is {schemaVersion, source, sessionId, event, context, outcome, ...}
    // — flags supplied to logGovernanceCheck land on outcome.governanceFlags,
    // and the ownership block sits inside event.details.ownership.
    const persistedDetails = JSON.parse(resumeRow.details as string);
    expect(persistedDetails.outcome.governanceFlags).toContain('resume_from_queue');
    expect(persistedDetails.event.details.ownership.resumeFromQueue).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 5 — reject_with_alert + non-owner → OwnershipViolationError
  // ───────────────────────────────────────────────────────────────────

  it('reject_with_alert + non-owner caller throws OwnershipViolationError', async () => {
    const correlationId = `cor-${randomUUID()}`;
    await expect(
      guardedWrite(
        {
          context: {
            tenantId: TENANT,
            callerSystem: 'business_central',
            targetSystem: 'netsuite',
            entity: 'invoice',
            recordId: 'inv-r5',
            correlationId,
            requesterUserId: 'bc-bot',
            operation: 'create',
          },
          do: async () => mockConnector.create('Invoice', { id: 'inv-r5' }),
        },
        {
          ownershipResolver: resolver,
          auditService,
          approvalQueueService: approvalQueue,
        },
      ),
    ).rejects.toBeInstanceOf(OwnershipViolationError);

    // No queue row (reject_with_alert never enqueues).
    const approvals = await approvalsFor(TENANT);
    expect(approvals).toHaveLength(0);

    // Connector NOT called.
    expect(mockConnector.create).not.toHaveBeenCalled();

    // Copilot R1 (PR 13b) cluster-A2 changed the reject_with_alert (no
    // override) contract: guardedWrite now emits exactly one
    // `governance_check` audit row with `approved=false` and
    // `flags=['ownership_violation_rejected']` BEFORE re-throwing
    // OwnershipViolationError, so the /api/governance/ownership-rejections
    // dashboard can surface the row. Previously the resolver-side throw
    // bypassed the audit emission and the dashboard never saw rejected
    // writes.
    const audits = await auditRowsFor(correlationId);
    expect(audits).toHaveLength(1);
    const auditRow = audits[0];
    expect(auditRow.action).toBe('validate_ownership');
    expect(auditRow.result).toBe('failure');
    const auditDetails = JSON.parse(auditRow.details as string) as {
      event: { details: { approved: boolean; ownership: Record<string, unknown> } };
      outcome: { governanceFlags: string[] };
    };
    expect(auditDetails.event.details.approved).toBe(false);
    expect(auditDetails.outcome.governanceFlags).toEqual(['ownership_violation_rejected']);
    expect(auditDetails.event.details.ownership).toMatchObject({
      entity: 'invoice',
      declaredOwner: 'netsuite',
      callerSystem: 'business_central',
      targetSystem: 'netsuite',
      operation: 'create',
      policy: 'reject_with_alert',
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 6 — reject_with_alert + operator override → 3-row audit
  // ───────────────────────────────────────────────────────────────────

  it('reject_with_alert + operator_action + override permitted → write proceeds + 3-row audit', async () => {
    const correlationId = `cor-${randomUUID()}`;
    const result = await guardedWrite(
      {
        context: {
          tenantId: TENANT,
          callerSystem: 'operator_action',
          targetSystem: 'netsuite',
          entity: 'invoice',
          recordId: 'inv-r6',
          correlationId,
          requesterUserId: 'op-1',
          operation: 'create',
        },
        do: async () => mockConnector.create('Invoice', { id: 'inv-r6' }),
        override: { permitted: true, reason: 'urgent backfill from finance' },
      },
      {
        ownershipResolver: resolver,
        auditService,
        approvalQueueService: approvalQueue,
      },
    );

    expect(result).toEqual({ id: 'created-1' });
    expect(mockConnector.create).toHaveBeenCalledTimes(1);

    // Decision → override → outcome = 3 audit rows.
    const audits = await auditRowsFor(correlationId);
    expect(audits).toHaveLength(3);

    // AuditPersistenceMapper builds the persisted details envelope as
    // {schemaVersion, source, sessionId, event, context, outcome, ...}.
    // The flags supplied to logGovernanceCheck land on outcome.governanceFlags
    // (NOT details.flags), so look there. Outcome row carries flags:
    // ['write_succeeded', 'governance_override'].
    const outcomeRow = audits.find((r) => {
      const d = JSON.parse(r.details as string);
      const flags = d.outcome?.governanceFlags ?? [];
      return Array.isArray(flags) && flags.includes('write_succeeded');
    });
    expect(outcomeRow).toBeDefined();
    const outcomeDetails = JSON.parse(outcomeRow!.details as string);
    expect(outcomeDetails.outcome.governanceFlags).toEqual(
      expect.arrayContaining(['write_succeeded', 'governance_override']),
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 7 — source_wins + SourceSystem caller + loop hazard
  // ───────────────────────────────────────────────────────────────────

  it('source_wins + SourceSystem caller + loop hazard → throws LoopDetectedError', async () => {
    const correlationId = `cor-${randomUUID()}`;

    // Stub findRecentReciprocalActivity for this single call so detectLoop
    // returns loopDetected=true. The fixture manifest's payment entry has
    // knownLoops counterpart=netsuite, so detectLoop will only consult the
    // lineage if the relevant-loops filter matches — calling with
    // targetSystem='netsuite' triggers the filter.
    const lineage = await container.getAsync<LineageQueryService>(TYPES.LineageQueryService);
    const lineageSpy = jest
      .spyOn(lineage, 'findRecentReciprocalActivity')
      .mockResolvedValueOnce([
        { chainId: 'chain-loop-1', occurredAt: new Date().toISOString() },
      ]);

    try {
      // payment owner=stripe. Use stripe as caller so it's a SourceSystem.
      // But then validateWrite allows the write (caller=owner). Loop detection
      // ALSO requires the targetSystem to match a knownLoops counterpart, which
      // is netsuite — so we must target netsuite. But then caller=stripe → owner
      // ≠ caller for payment-on-netsuite. Hmm — payment owner is stripe per the
      // fixture, but we're writing TO netsuite; the resolver would treat this
      // as a non-owner write (stripe writing payment-to-netsuite is fine —
      // stripe IS the owner). Wait: validateWrite checks `callerSystem ===
      // effectiveOwner` first. caller='stripe', owner='stripe' → allowed=true.
      // Then guardedWrite reaches detectLoop with targetSystem='netsuite' which
      // matches the knownLoops.counterpart. ✓
      await guardedWrite(
        {
          context: {
            tenantId: TENANT,
            callerSystem: 'stripe',
            targetSystem: 'netsuite',
            entity: 'payment',
            recordId: 'pay-r7',
            correlationId,
            requesterUserId: 'sys',
            operation: 'create',
          },
          do: async () => mockConnector.create('Payment', { id: 'pay-r7' }),
        },
        {
          ownershipResolver: resolver,
          auditService,
          approvalQueueService: approvalQueue,
        },
      );
      throw new Error('expected LoopDetectedError to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LoopDetectedError);
      const loopErr = err as LoopDetectedError;
      expect(loopErr.detail.callerSystem).toBe('stripe');
      expect(loopErr.detail.targetSystem).toBe('netsuite');
      expect(loopErr.detail.entity).toBe('payment');
      expect(loopErr.detail.breakingCondition).toBe(
        'audit_logs.action != "sync_back_from_erp"',
      );
    }

    // Connector NOT called.
    expect(mockConnector.create).not.toHaveBeenCalled();

    // Two audit rows: decision (approved=true from ownership-allow) +
    // loop_detection (approved=false). The loop-detection row carries
    // checkType=loop_detection inside event.details (per
    // AuditPersistenceMapper.buildPersistedAIAuditDetails envelope) and a
    // loopBreakingCondition under event.details.ownership.
    //
    // The action column is the most reliable discriminator: the loop_detection
    // row's `action` is `validate_loop_detection` (logGovernanceCheck
    // formats `validate_${checkType}`). The decision row's action is
    // `validate_ownership`.
    const audits = await auditRowsFor(correlationId);
    expect(audits).toHaveLength(2);
    const loopRow = audits.find((r) => r.action === 'validate_loop_detection');
    expect(loopRow).toBeDefined();
    expect(loopRow!.result).toBe('failure');
    const loopDetails = JSON.parse(loopRow!.details as string);
    expect(loopDetails.event.details.checkType).toBe('loop_detection');
    expect(loopDetails.event.details.approved).toBe(false);
    expect(loopDetails.event.details.ownership.loopBreakingCondition).toBe(
      'audit_logs.action != "sync_back_from_erp"',
    );

    lineageSpy.mockRestore();
  });
});
