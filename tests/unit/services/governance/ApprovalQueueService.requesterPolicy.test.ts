/**
 * Task B4b — the strict requester policy (decision D-SoD, approved 2026-09-02).
 *
 * A request whose requester was never verified is NEVER approvable. `host_asserted`
 * means the host process asserted the identity and nothing checked it; `unknown`
 * means we do not know. Neither can be approved, and no configuration can make it
 * approvable — that last property is the point of the decision, so it is asserted
 * directly (a spy on the tenant configuration repository) rather than assumed.
 *
 * B4a already records the condition as `sodWeak` without acting on it; this suite
 * is the difference between recording and enforcing. Each test names the behaviour
 * it would catch, so a regression here reads as a trust-model failure, not a typo.
 */
import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { ApprovalQueueService, type ApprovalDecider } from '../../../../src/services/governance/ApprovalQueueService';
import { ApprovalQueueRepository } from '../../../../src/services/governance/ApprovalQueueRepository';
import { SeparationOfDutiesError } from '../../../../src/services/governance/ApprovalQueueErrors';
import { TenantConfigurationRepository } from '../../../../src/database/repositories/TenantConfigurationRepository';
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

describe('ApprovalQueueService requester policy (strict)', () => {
  let db: Kysely<Database>;
  let repo: ApprovalQueueRepository;
  let service: ApprovalQueueService;
  let auditCreate: jest.Mock;

  beforeEach(async () => {
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');

    repo = new ApprovalQueueRepository({ getDatabase: () => db } as never);
    auditCreate = jest.fn().mockResolvedValue({});
    const auditLogs = {
      create: auditCreate,
      insertWithin: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditLogRepository;

    service = new ApprovalQueueService(repo, new Logger('requester-policy-test'), encryption, FINGERPRINT_KEY, auditLogs);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
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

  it.each(['host_asserted', 'unknown'] as const)(
    'refuses to approve a %s requester, whatever the approver looks like',
    async (provenance) => {
      const id = await enqueueFrom('mallory', provenance);
      await expect(service.approve({ tenantId: 't1', id, approver: bob() })).rejects.toMatchObject({
        reason: 'unverified_requester',
      });
    },
  );

  it.each(['squire_verified', 'jwt', 'system'] as const)('approves a verified %s requester', async (provenance) => {
    // squire_verified carries a scope that the approver must match; jwt and
    // system do not, so the approver's scope is irrelevant for them.
    const scope = provenance === 'squire_verified' ? SCOPE_A : null;
    const id = await enqueueFrom('alice', provenance, scope);
    const result = await service.approve({
      tenantId: 't1',
      id,
      approver: bob(provenance === 'squire_verified' ? SCOPE_A : SCOPE_B),
    });
    expect(result.status).toBe('approved');
  });

  it("reads none of TenantConfigurationRepository's eight read methods while deciding", async () => {
    // The decision is "strict, unconditional". If the policy ever consults a
    // setting, one of these spies fires and the guarantee is gone.
    //
    // Codex review finding 4: an earlier version of this test spied only
    // `getBoolean` while its name claimed "reads no configuration". That proved
    // one of six accessors. Every read method on the repository is covered now,
    // and the assertion below names which one fired if it ever does.
    const accessors = [
      'getBoolean',
      'getBooleanStrict',
      'getString',
      'getStringStrict',
      'getInt',
      'getSecretString',
      // Codex round 2: the list claimed "every read method" while omitting
      // these two. A spy list is a claim like any other.
      'resolveStringForRow',
      'resolveBooleanForRow',
    ] as const;
    const spies = accessors.map((name) => [name, jest.spyOn(TenantConfigurationRepository.prototype, name)] as const);

    const id = await enqueueFrom('mallory', 'host_asserted');
    await expect(service.approve({ tenantId: 't1', id, approver: bob() })).rejects.toBeInstanceOf(
      SeparationOfDutiesError,
    );

    const called = spies.filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name);
    expect(called).toEqual([]);
  });

  it('audits the refusal as unverified_requester before throwing', async () => {
    // B4a's point was that host-asserted requests stay visible in the audit log.
    // Enforcing must not make them invisible.
    const id = await enqueueFrom('mallory', 'host_asserted');
    await expect(service.approve({ tenantId: 't1', id, approver: bob() })).rejects.toBeInstanceOf(
      SeparationOfDutiesError,
    );
    const audit = lastAudit();
    expect(audit.action).toBe('governance.approval.decision_rejected');
    expect(audit.result).toBe('failure');
    expect(audit.error_message).toBe('unverified_requester');
    expect((audit.details as { reason: string }).reason).toBe('unverified_requester');
  });

  it('rejects an unverified requester even when the approver is the strongest possible', async () => {
    // Guards against a policy that only fires on some other weakness: this
    // approver is verified, correctly scoped, and not the requester.
    const id = await enqueueFrom('mallory', 'host_asserted', SCOPE_A);
    await expect(
      service.approve({ tenantId: 't1', id, approver: { userId: 'bob', verifiedRoles: ['approver', 'admin'], scope: SCOPE_A } }),
    ).rejects.toMatchObject({ reason: 'unverified_requester' });
  });

  it('leaves the request pending after a refusal, so it is not silently consumed', async () => {
    const id = await enqueueFrom('mallory', 'host_asserted');
    await expect(service.approve({ tenantId: 't1', id, approver: bob() })).rejects.toBeInstanceOf(
      SeparationOfDutiesError,
    );
    const row = await repo.getById('t1', id);
    expect(row?.status).toBe('pending');
  });

  it('still allows REJECTING a host-asserted requester — D-SoD prohibits approval, not refusal', async () => {
    // Codex advisory, 2026-09-04. An earlier version of this suite asserted the
    // opposite, because the gate sat in decide() and caught both verbs. That
    // left unverifiable rows pending with no operator route to clear them, and
    // expireStale() has no production caller, so nothing else would.
    //
    // Refusing a request is not an act of trust in its requester, and reject()
    // already demands a verified approver.
    const id = await enqueueFrom('mallory', 'host_asserted');
    const row = await service.reject({ tenantId: 't1', id, approver: bob(), reason: 'unverifiable origin' });
    expect(row.status).toBe('rejected');
  });

  it('throws if the repository refuses while the service policy somehow did not', async () => {
    // The defence-in-depth branch. It cannot fire through the normal path
    // because enforceRequesterPolicy catches it first, so the only way to cover
    // it — and the only way to know it does not fall through to the success
    // path — is to make the repository answer that way directly.
    const id = await enqueueFrom('alice', 'jwt', null);
    jest
      .spyOn(repo, 'decideWithAudit')
      .mockResolvedValueOnce({ outcome: 'unverified_requester', row: { id } } as never);
    await expect(service.approve({ tenantId: 't1', id, approver: bob(null) })).rejects.toMatchObject({
      reason: 'unverified_requester',
    });
    // Copilot round 4: this path used to throw directly, leaving the MOST
    // surprising refusal — the one the service policy missed — as the only
    // silent one. "Audited, then thrown" has to hold here above all.
    const audit = lastAudit();
    expect(audit).toMatchObject({ action: 'governance.approval.decision_rejected', result: 'failure' });
    expect(audit.error_message).toBe('unverified_requester');
  });

  it('refuses at the REPOSITORY sink too, not only in the service', async () => {
    // Limit (i) from the Codex review: the CAS transition checked status and
    // expiry only, so a caller holding the repository could approve a weak row
    // without passing the service policy. The predicate now lives in the same
    // atomic UPDATE, so there is no window between checking and writing.
    const id = await enqueueFrom('mallory', 'host_asserted');
    const outcome = await repo.decideWithAudit(
      {
        tenantId: 't1',
        id,
        decision: 'approved',
        decidedAt: new Date(Date.now() + 1000).toISOString(),
        decidedByUserId: 'bob',
        decisionReason: null,
      } as never,
      { tenant_id: 't1', user_id: 'bob', action: 'x', resource_type: 'y', resource_id: id, result: 'success', error_message: null, old_values: null, new_values: null, ip_address: null, user_agent: null, details: {} } as never,
      { create: jest.fn(), insertWithin: jest.fn() } as never,
    );
    expect(outcome.outcome).toBe('unverified_requester');
    const after = await repo.getById('t1', id);
    expect(after?.status).toBe('pending');
  });

  it('the repository lets a VERIFIED requester through the same sink', async () => {
    // The control. Without it the test above would pass against a sink that
    // refuses everything.
    const id = await enqueueFrom('alice', 'jwt', null);
    const outcome = await repo.decideWithAudit(
      {
        tenantId: 't1',
        id,
        decision: 'approved',
        decidedAt: new Date(Date.now() + 1000).toISOString(),
        decidedByUserId: 'bob',
        decisionReason: null,
      } as never,
      { tenant_id: 't1', user_id: 'bob', action: 'x', resource_type: 'y', resource_id: id, result: 'success', error_message: null, old_values: null, new_values: null, ip_address: null, user_agent: null, details: {} } as never,
      { create: jest.fn(), insertWithin: jest.fn() } as never,
    );
    expect(outcome.outcome).toBe('updated');
  });
});
