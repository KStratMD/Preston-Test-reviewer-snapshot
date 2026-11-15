import { sql } from 'kysely';
import { Logger } from '../../../src/utils/Logger';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { ApprovalQueueRepository } from '../../../src/services/governance/ApprovalQueueRepository';
import {
  ApprovalQueueService,
  type EnqueueArgs,
} from '../../../src/services/governance/ApprovalQueueService';
import { parseApprovalFingerprintKey } from '../../../src/services/governance/approvalFingerprint';
import { EncryptionService } from '../../../src/services/security/EncryptionService';
import type { WriteDescriptor } from '../../../src/governance/sourceOfTruth/guardedWrite';

/**
 * A8.3 under REAL concurrency.
 *
 * Codex R4: the SQLite version of these assertions cannot prove what it looks
 * like it proves. better-sqlite3 is synchronous and Kysely serializes access,
 * so `Promise.all` over three enqueues is repeated dispatch, not contention —
 * no two callers are ever inside the protocol at once. Postgres has a real
 * connection pool, so the insert conflict, the blocker lookup and the
 * CAS-expire genuinely interleave here.
 *
 * The invariant under test is the one that matters operationally: for a given
 * (tenant, intent) there is never more than ONE pending approval, and no
 * caller ever receives an id belonging to a different intent.
 */

const FINGERPRINT_KEY = parseApprovalFingerprintKey('4c'.repeat(32));
const ENCRYPTION_KEY = '5'.repeat(64);

function descriptor(overrides: Partial<WriteDescriptor> = {}): WriteDescriptor {
  return {
    targetSystemId: 'salesforce',
    operation: 'update',
    entityType: 'Contact',
    args: { firstName: 'Ada', lastName: 'Lovelace' },
    ownership: {
      entity: 'contacts',
      declaredOwner: 'salesforce',
      callerSystem: 'netsuite',
      targetSystem: 'salesforce',
    },
    ...overrides,
  } as WriteDescriptor;
}

function enqueueArgs(tenantId: string, desc = descriptor()): EnqueueArgs {
  return {
    tenantId,
    requesterUserId: 'user-1',
    operationType: 'ownership_write',
    resourceType: 'contacts',
    resourceId: 'new',
    reason: {
      kind: 'ownership',
      entity: 'contacts',
      declaredOwner: 'salesforce',
      callerSystem: 'netsuite',
      conflictPolicy: 'queue_for_human',
      writeDescriptor: desc,
    },
  } as EnqueueArgs;
}

describe('ownership enqueue idempotency under real Postgres concurrency (A8.3)', () => {
  let db: DatabaseService;
  let repo: ApprovalQueueRepository;
  let encryption: EncryptionService;
  let previousKey: string | undefined;

  // Copilot R7: this suite deliberately does NOT clean governance_approvals
  // between tests — the rows are part of what each case asserts about — so
  // pendingCount() is only meaningful if every test gets a tenant id no other
  // test can produce. A monotonic counter makes that a guarantee rather than a
  // probability; relying on Math.random() alone means an occasional collision
  // silently folds a previous test's rows into this one's count, and an
  // intermittently failing concurrency test is one that gets re-run until it
  // passes and then stops being read.
  let tenantSeq = 0;
  const tenant = (): string => {
    tenantSeq += 1;
    return `t-${tenantSeq}-${Math.random().toString(36).slice(2, 10)}`;
  };

  beforeAll(async () => {
    previousKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
    process.env.AI_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
    encryption = new EncryptionService();

    db = new DatabaseService(new Logger('a8-concurrency'));
    await db.initialize();
    repo = new ApprovalQueueRepository(db);
  });

  afterAll(async () => {
    await db.shutdown();
    if (previousKey === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    else process.env.AI_CONFIG_ENCRYPTION_KEY = previousKey;
  });

  function makeService(ttlMs?: number): ApprovalQueueService {
    return new ApprovalQueueService(
      repo,
      new Logger('a8-concurrency'),
      encryption,
      FINGERPRINT_KEY,
      // Fifth positional parameter is the audit writer; the config is sixth.
      // This suite runs only in the postgres profile, so a config passed in
      // slot five would have reverted the TTL to the 24h default without any
      // default-profile run noticing.
      { create: jest.fn().mockResolvedValue({}), insertWithin: jest.fn().mockResolvedValue(undefined) } as never,
      ttlMs === undefined ? undefined : { defaultTtlMs: ttlMs },
    );
  }

  async function pendingCount(tenantId: string): Promise<number> {
    const r = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count FROM governance_approvals
      WHERE tenant_id = ${tenantId} AND status = 'pending'
    `.execute(db.getDatabase());
    return Number(r.rows[0].count);
  }

  it('leaves exactly one pending approval when 8 identical enqueues race', async () => {
    const tenantId = tenant();
    const svc = makeService();

    const ids = await Promise.all(
      Array.from({ length: 8 }, () => svc.enqueue(enqueueArgs(tenantId))),
    );

    // Every caller must receive the SAME id, and the table must hold one row.
    expect(new Set(ids).size).toBe(1);
    expect(await pendingCount(tenantId)).toBe(1);
  });

  it('keeps materially different intents distinct when they race together', async () => {
    // The dangerous direction: contention must not cause one intent to be
    // absorbed into another's approval, which would silently discard a write.
    const tenantId = tenant();
    const svc = makeService();

    const emails = ['ada@example.com', 'grace@example.com', 'alan@example.com', 'edsger@example.com'];
    const ids = await Promise.all(
      emails.flatMap((email) => [
        svc.enqueue(enqueueArgs(tenantId, descriptor({ operation: 'create', args: { email } }))),
        svc.enqueue(enqueueArgs(tenantId, descriptor({ operation: 'create', args: { email } }))),
      ]),
    );

    // Eight calls, four distinct intents, each duplicated once.
    expect(new Set(ids).size).toBe(emails.length);
    expect(await pendingCount(tenantId)).toBe(emails.length);
  });

  it('does not let a racing tenant see another tenant\'s approval id', async () => {
    const tenantA = tenant();
    const tenantB = tenant();
    const svc = makeService();

    const [a1, b1, a2, b2] = await Promise.all([
      svc.enqueue(enqueueArgs(tenantA)),
      svc.enqueue(enqueueArgs(tenantB)),
      svc.enqueue(enqueueArgs(tenantA)),
      svc.enqueue(enqueueArgs(tenantB)),
    ]);

    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).not.toBe(b1);
    expect(await pendingCount(tenantA)).toBe(1);
    expect(await pendingCount(tenantB)).toBe(1);
  });

  it('supersedes a stale blocker under contention without duplicating', async () => {
    // Several callers race to clear one stale row. At most one may win the
    // CAS; the rest must converge on whatever replacement exists rather than
    // each inserting their own.
    const tenantId = tenant();
    await makeService(-1000).enqueue(enqueueArgs(tenantId));

    const svc = makeService();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => svc.enqueue(enqueueArgs(tenantId))),
    );

    expect(new Set(ids).size).toBe(1);
    expect(await pendingCount(tenantId)).toBe(1);
  });
});
