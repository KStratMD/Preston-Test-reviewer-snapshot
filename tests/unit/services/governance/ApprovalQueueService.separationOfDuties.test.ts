/**
 * Separation of duties on the approval decision.
 *
 * Three things must be true before a decision is recorded: the approver holds
 * a VERIFIED approver or admin grant, the approver is not the requester, and —
 * when the request came from a platform account — the approver is verified for
 * that same account.
 *
 * "Verified" is doing the work. Before the grant split, a host asserting
 * `["admin","approver"]` in the bootstrap body authorized itself (measured
 * 2026-09-03), so a role the caller merely claims is not a role at all here.
 * The deprecated `approverUserId` path is exercised deliberately: it carries no
 * proof, so it must be refused rather than quietly admitted as a way around
 * the gate.
 *
 * Every refusal is audited before it is thrown. A refused decision that leaves
 * no trace is indistinguishable from one that was never attempted, and an
 * attacker probing the gate should leave the same record as an operator who
 * mis-clicked.
 */
import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import {
  ApprovalQueueService,
  SeparationOfDutiesError,
  type ApprovalDecider,
} from '../../../../src/services/governance/ApprovalQueueService';
import { ApprovalQueueRepository } from '../../../../src/services/governance/ApprovalQueueRepository';
import { ApprovalNotFoundError, InvalidDecisionError } from '../../../../src/services/governance/ApprovalQueueErrors';
import type { AuditLogRepository } from '../../../../src/database/repositories/AuditLogRepository';
import { Logger } from '../../../../src/utils/Logger';
import type { EncryptionService } from '../../../../src/services/security/EncryptionService';
import type { OutboundDecision } from '../../../../src/services/governance/OutboundGovernanceService';

const FINGERPRINT_KEY = Buffer.alloc(32, 7);
const SCOPE_A = { platform: 'netsuite', platformAccountId: 'a1' };
const SCOPE_B = { platform: 'netsuite', platformAccountId: 'a2' };

const encryption = {
  encryptForStorage: async (v: string) => `enc:${v}`,
  decryptFromStorage: async (v: string) => v.replace(/^enc:/, ''),
} as unknown as EncryptionService;

function fakeDecision(): OutboundDecision {
  return {
    approvalRequired: true,
    riskLevel: 'high',
    redactedPayload: { field: '[REDACTED]' },
    findings: ['email'],
    auditMetadata: { redacted: true },
  } as unknown as OutboundDecision;
}

/** A verified approver who is not the requester. */
const bob = (scope: typeof SCOPE_A | null = SCOPE_A): ApprovalDecider => ({
  userId: 'bob',
  verifiedRoles: ['approver'],
  scope,
});

describe('ApprovalQueueService separation of duties', () => {
  let db: Kysely<Database>;
  let repo: ApprovalQueueRepository;
  let service: ApprovalQueueService;
  let auditCreate: jest.Mock;
  let decideWithAuditSpy: jest.SpyInstance;

  beforeEach(async () => {
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');

    repo = new ApprovalQueueRepository({ getDatabase: () => db } as never);
    auditCreate = jest.fn().mockResolvedValue({});
    const auditLogs = {
      create: auditCreate,
      insertWithin: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditLogRepository;

    decideWithAuditSpy = jest.spyOn(repo, 'decideWithAudit');
    service = new ApprovalQueueService(repo, new Logger('sod-test'), encryption, FINGERPRINT_KEY, auditLogs);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function enqueueFrom(
    requester: string,
    provenance: 'squire_verified' | 'host_asserted' | 'jwt' | 'system' | 'unknown',
    scope: typeof SCOPE_A | null = SCOPE_A,
  ): Promise<string> {
    return service.enqueue({
      tenantId: 't1',
      requesterUserId: requester,
      requesterProvenance: provenance,
      requesterScope: scope,
      operationType: 'connector_write',
      resourceType: 'customer',
      resourceId: `c-${requester}-${Math.random().toString(36).slice(2, 8)}`,
      reason: { kind: 'governance', decision: fakeDecision() },
    });
  }

  const lastAudit = () => auditCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  // details is an OBJECT, not a pre-stringified string: AuditLogRepository
  // serializes it, and stringifying here would store a JSON string in the
  // Postgres JSONB column rather than an object.
  const lastSuccessDetails = () =>
    (decideWithAuditSpy.mock.calls.at(-1) as [unknown, { details: Record<string, unknown> }])[1].details;

  it('rejects an approver without a verified approver role', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    await expect(
      service.approve({ tenantId: 't1', id, approver: { ...bob(), verifiedRoles: ['viewer'] } }),
    ).rejects.toMatchObject({ reason: 'unverified_approver' });
  });

  it('refuses the deprecated approverUserId path, which carries no proof', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    await expect(service.approve({ tenantId: 't1', id, approverUserId: 'bob' })).rejects.toBeInstanceOf(
      SeparationOfDutiesError,
    );
  });

  it.each([
    ['no decider at all', {}],
    ['an empty approverUserId', { approverUserId: '' }],
    ['a whitespace-only approverUserId', { approverUserId: '   ' }],
    ['an approver with a blank userId', { approver: { userId: '', verifiedRoles: ['approver'], scope: SCOPE_A } }],
    [
      'an approver with a whitespace userId',
      { approver: { userId: ' 	 ', verifiedRoles: ['approver'], scope: SCOPE_A } },
    ],
  ])('refuses %s before writing any audit', async (_label, extra) => {
    const id = await enqueueFrom('alice', 'squire_verified');
    // Caller misuse, not a failed authorization. Every path past this point
    // attributes its row — decision or refusal — to this id, so an
    // unidentifiable actor must not reach them: the audit would read as a real
    // attempt by nobody.
    await expect(service.approve({ tenantId: 't1', id, ...(extra as object) })).rejects.toBeInstanceOf(
      InvalidDecisionError,
    );
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('trims a padded decider id rather than attributing the padding', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    const row = await service.approve({
      tenantId: 't1',
      id,
      approver: { userId: '  bob  ', verifiedRoles: ['approver'], scope: SCOPE_A },
    });
    expect(row.decidedByUserId).toBe('bob');
  });

  it('still refuses self-approval when the padding is what differs', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    // Without the trim, '  alice  ' !== 'alice' and the self-approval check
    // would pass — one person acting as both parties by adding a space.
    await expect(
      service.approve({
        tenantId: 't1',
        id,
        approver: { userId: '  alice  ', verifiedRoles: ['approver'], scope: SCOPE_A },
      }),
    ).rejects.toMatchObject({ reason: 'self_approval' });
  });

  it('rejects self-approval', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    await expect(
      service.approve({
        tenantId: 't1',
        id,
        approver: { userId: 'alice', verifiedRoles: ['approver'], scope: SCOPE_A },
      }),
    ).rejects.toMatchObject({ reason: 'self_approval' });
  });

  it('refuses self-approval when the REQUESTER id was padded, not the approver', async () => {
    // The mirror of the approver-side trim, and the direction that actually
    // matters: requesterUserId is host-controlled — it comes from the embedded
    // bootstrap body — so a requester could enqueue as '  alice  ' and then
    // decide as 'alice'. With only the approver side normalised the comparison
    // is 'alice' !== '  alice  ', the self-approval check passes, and one
    // person acts as both parties.
    const id = await enqueueFrom('  alice  ', 'squire_verified');

    await expect(
      service.approve({
        tenantId: 't1',
        id,
        approver: { userId: 'alice', verifiedRoles: ['approver'], scope: SCOPE_A },
      }),
    ).rejects.toMatchObject({ reason: 'self_approval' });
  });

  it('normalises the requester id on the way in, so stored rows carry no padding', async () => {
    const id = await enqueueFrom('  bob  ', 'squire_verified');
    const row = await repo.getById('t1', id);
    expect(row?.requesterUserId).toBe('bob');
  });

  it('still refuses when a pre-existing row carries padding the write path no longer creates', async () => {
    // Rows written before the enqueue-side trim can still hold padding, so the
    // comparison has to normalise too — the write-side fix alone would leave
    // existing data exploitable.
    const id = await enqueueFrom('carol', 'squire_verified');
    await db.updateTable('governance_approvals').set({ requester_user_id: '  carol  ' }).where('id', '=', id).execute();

    await expect(
      service.approve({
        tenantId: 't1',
        id,
        approver: { userId: 'carol', verifiedRoles: ['approver'], scope: SCOPE_A },
      }),
    ).rejects.toMatchObject({ reason: 'self_approval' });
  });

  it('rejects an approver verified for a different platform account', async () => {
    const id = await enqueueFrom('alice', 'squire_verified', SCOPE_A);
    await expect(service.approve({ tenantId: 't1', id, approver: bob(SCOPE_B) })).rejects.toMatchObject({
      reason: 'scope_mismatch',
    });
  });

  it('rejects an approver with no scope at all against a scoped request', async () => {
    const id = await enqueueFrom('alice', 'squire_verified', SCOPE_A);
    await expect(service.approve({ tenantId: 't1', id, approver: bob(null) })).rejects.toMatchObject({
      reason: 'scope_mismatch',
    });
  });

  it('lets any verified approver in the tenant decide a null-scope (JWT) request', async () => {
    const id = await enqueueFrom('svc', 'jwt', null);
    const row = await service.approve({ tenantId: 't1', id, approver: bob(SCOPE_B) });
    expect(row.status).toBe('approved');
  });

  it('approves a verified requester by a different verified approver and records provenance', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    const row = await service.approve({ tenantId: 't1', id, approver: bob() });

    expect(row.decidedByUserId).toBe('bob');
    expect(lastSuccessDetails()).toMatchObject({
      requesterProvenance: 'squire_verified',
      sodWeak: false,
      decision: 'approved',
    });
  });

  // Task B4b made these two blocking. Until then they asserted that a
  // host-asserted requester was RECORDED as weak and approved anyway, which was
  // the deliberate interim state.
  //
  // What must survive B4b is the visibility B4a existed to provide. It does, but
  // under different fields: the success path records `sodWeak`, while a blocked
  // attempt is recorded by `rejectDecision` as reason `unverified_requester`
  // plus the `requesterProvenance` that triggered it. That is strictly more
  // specific than a boolean, and it is what makes "how often would this fire"
  // answerable now that it does fire. The enforcement itself is asserted in
  // ApprovalQueueService.requesterPolicy.test.ts.
  it.each(['host_asserted', 'unknown'] as const)(
    'blocks a %s requester and records the provenance that caused it (Task B4b)',
    async (provenance) => {
      const id = await enqueueFrom('mallory', provenance);
      await expect(service.approve({ tenantId: 't1', id, approver: bob() })).rejects.toMatchObject({
        reason: 'unverified_requester',
      });
      const audit = lastAudit();
      expect(audit).toMatchObject({ action: 'governance.approval.decision_rejected', result: 'failure' });
      expect(audit.details).toMatchObject({ reason: 'unverified_requester', requesterProvenance: provenance });
    },
  );

  it.each([
    ['approved', 'AlreadyDecidedError'],
    ['rejected', 'AlreadyDecidedError'],
    ['expired', 'ApprovalExpiredError'],
  ])('reports row state, not separation of duties, for a %s row', async (status, expected) => {
    const id = await enqueueFrom('alice', 'squire_verified');
    await db.updateTable('governance_approvals').set({ status }).where('id', '=', id).execute();

    // A terminal row cannot be decided by anyone, so refusing it on the
    // approver's identity would say something untrue about why — and would
    // write a decision_rejected audit for an attempt that was never possible.
    let caught: unknown;
    try {
      // Deliberately a SELF-approval, which would otherwise be refused first.
      await service.approve({
        tenantId: 't1',
        id,
        approver: { userId: 'alice', verifiedRoles: ['approver'], scope: SCOPE_A },
      });
    } catch (e) {
      caught = e;
    }

    expect((caught as Error).constructor.name).toBe(expected);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('audits a refused decision with its reason before throwing', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    await expect(
      service.approve({
        tenantId: 't1',
        id,
        approver: { userId: 'alice', verifiedRoles: ['approver'], scope: SCOPE_A },
      }),
    ).rejects.toBeInstanceOf(SeparationOfDutiesError);

    const audit = lastAudit();
    expect(audit).toMatchObject({
      action: 'governance.approval.decision_rejected',
      result: 'failure',
      error_message: 'self_approval',
      resource_id: id,
    });
    expect(audit.details).toMatchObject({
      reason: 'self_approval',
      requesterProvenance: 'squire_verified',
    });
  });

  it('leaves the row pending when a decision is refused', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    await expect(service.approve({ tenantId: 't1', id, approver: bob(SCOPE_B) })).rejects.toBeInstanceOf(
      SeparationOfDutiesError,
    );

    const row = await repo.getById('t1', id);
    expect(row?.status).toBe('pending');
    expect(row?.decidedByUserId).toBeNull();
  });

  it('applies the same gate to reject as to approve', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    await expect(
      service.reject({
        tenantId: 't1',
        id,
        approver: { userId: 'alice', verifiedRoles: ['approver'], scope: SCOPE_A },
        reason: 'not needed',
      }),
    ).rejects.toMatchObject({ reason: 'self_approval' });
  });

  it('reads a row back through the service', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    const row = await service.getById('t1', id);
    expect(row?.id).toBe(id);
    expect(await service.getById('t1', 'missing')).toBeNull();
  });

  it('fires the resume worker after an approval, without awaiting it', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    const resume = { resume: jest.fn().mockResolvedValue(undefined) };
    service.setResumeWorker(resume as never);

    const row = await service.approve({ tenantId: 't1', id, approver: bob() });
    expect(row.status).toBe('approved');
    // Dispatched asynchronously — the decision does not wait on it, so the
    // assertion has to yield first.
    await new Promise(r => setImmediate(r));
    expect(resume.resume).toHaveBeenCalled();
  });

  it.each([
    ['already_decided', 'AlreadyDecidedError'],
    ['expired', 'ApprovalExpiredError'],
  ])('surfaces a %s row that turned terminal between the pre-read and the CAS', async (outcome, expected) => {
    const id = await enqueueFrom('alice', 'squire_verified');
    const row = await repo.getById('t1', id);

    // The pre-read short-circuit handles rows that were ALREADY terminal. This
    // is the genuine race it cannot cover: the row turns terminal between that
    // read and the compare-and-set. The CAS outcome has to win, or the caller
    // would be told the decision succeeded.
    jest.spyOn(repo, 'decideWithAudit').mockResolvedValueOnce({
      outcome,
      row: { ...row!, status: outcome === 'expired' ? 'expired' : 'approved' },
    } as never);

    let caught: unknown;
    try {
      await service.approve({ tenantId: 't1', id, approver: bob() });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).constructor.name).toBe(expected);
  });

  it('reports a row that vanished between the pre-read and the decision as not found', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');
    // The pre-read finds it, then it disappears before the compare-and-set —
    // the CAS outcome, not the pre-read, decides what the caller is told.
    jest.spyOn(repo, 'decideWithAudit').mockResolvedValueOnce({ outcome: 'not_found' });

    await expect(service.approve({ tenantId: 't1', id, approver: bob() })).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
  });

  it('rolls the decision back when the audit write fails', async () => {
    const id = await enqueueFrom('alice', 'squire_verified');

    // The audit row and the decision share one transaction, so an audit that
    // cannot be written must not leave a decided row behind claiming a
    // decision nobody can account for.
    const failing = {
      create: auditCreate,
      insertWithin: jest.fn().mockRejectedValue(new Error('audit insert failed')),
    } as unknown as AuditLogRepository;
    const svc = new ApprovalQueueService(repo, new Logger('sod-test'), encryption, FINGERPRINT_KEY, failing);

    await expect(svc.approve({ tenantId: 't1', id, approver: bob() })).rejects.toThrow('audit insert failed');

    const row = await repo.getById('t1', id);
    expect(row?.status).toBe('pending');
    expect(row?.decidedByUserId).toBeNull();
  });
});
