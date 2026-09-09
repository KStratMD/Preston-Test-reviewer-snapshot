import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import {
  ApprovalQueueRepository,
  PENDING_OWNERSHIP_FINGERPRINT_INDEX,
  isPendingOwnershipFingerprintConflict,
} from '../../../../src/services/governance/ApprovalQueueRepository';
import {
  ApprovalQueueService,
  APPROVAL_ENQUEUE_NO_CONVERGENCE,
  type EnqueueArgs,
} from '../../../../src/services/governance/ApprovalQueueService';
import { parseApprovalFingerprintKey } from '../../../../src/services/governance/approvalFingerprint';
import { EncryptionService } from '../../../../src/services/security/EncryptionService';
import { Logger } from '../../../../src/utils/Logger';
import type { WriteDescriptor } from '../../../../src/governance/sourceOfTruth/guardedWrite';

/**
 * A8.3 — the bounded insert-conflict protocol, exercised against a REAL
 * database.
 *
 * These cannot be written against a mock repository: the whole mechanism is
 * driven by a partial unique index rejecting an INSERT, and a stub that
 * "returns a conflict" would be asserting my own idea of what the engine does
 * rather than what it does. The migration suite proves the index; this proves
 * the service's response to it.
 */

const FINGERPRINT_KEY = parseApprovalFingerprintKey('2b'.repeat(32));
const ENCRYPTION_KEY = '3'.repeat(64);

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

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

function enqueueArgs(overrides: Partial<EnqueueArgs> = {}, desc = descriptor()): EnqueueArgs {
  return {
    tenantId: 'tenant-a',
    requesterUserId: 'user-1',
    operationType: 'ownership_write',
    resourceType: 'contacts',
    resourceId: 'rec-1',
    reason: {
      kind: 'ownership',
      entity: 'contacts',
      declaredOwner: 'salesforce',
      callerSystem: 'netsuite',
      conflictPolicy: 'queue_for_human',
      writeDescriptor: desc,
    },
    ...overrides,
  } as EnqueueArgs;
}

describe('ApprovalQueueService.enqueue — ownership idempotency (A8.3)', () => {
  let db: Kysely<Database>;
  let repo: ApprovalQueueRepository;
  let encryption: EncryptionService;
  let previousKey: string | undefined;

  beforeAll(() => {
    previousKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
    process.env.AI_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
    encryption = new EncryptionService();
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    else process.env.AI_CONFIG_ENCRYPTION_KEY = previousKey;
  });

  beforeEach(async () => {
    db = makeDb();
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');
    repo = new ApprovalQueueRepository({ getDatabase: () => db } as never);
  });

  afterEach(async () => {
    await db.destroy();
  });

  function makeService(ttlMs?: number, logger?: Logger): ApprovalQueueService {
    return new ApprovalQueueService(
      repo,
      logger ?? new Logger('a8-idempotency-test'),
      encryption,
      FINGERPRINT_KEY,
      // The audit writer is the fifth positional parameter; the config is the
      // sixth. Passing the config in slot five silently reverted the TTL to the
      // 24h default, so a service built to expire immediately did not.
      { create: jest.fn().mockResolvedValue({}), insertWithin: jest.fn().mockResolvedValue(undefined) } as never,
      ttlMs === undefined ? undefined : { defaultTtlMs: ttlMs },
    );
  }

  async function rowCount(): Promise<number> {
    const r = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM governance_approvals`.execute(db);
    return Number(r.rows[0]!.c);
  }

  it('collapses a sequential duplicate onto the existing pending approval', async () => {
    const svc = makeService();
    const first = await svc.enqueue(enqueueArgs());
    const second = await svc.enqueue(enqueueArgs());

    expect(second).toBe(first);
    expect(await rowCount()).toBe(1);
  });

  it('collapses duplicates even though the descriptor encrypts differently each time', async () => {
    // The reason the fingerprint is computed BEFORE encryption. AES-256-GCM
    // uses a random IV, so identical input yields different ciphertext on
    // every call; fingerprinting the sealed form would dedupe nothing and this
    // test would see two rows.
    const svc = makeService();
    const first = await svc.enqueue(enqueueArgs());
    const second = await svc.enqueue(enqueueArgs());
    expect(second).toBe(first);

    const stored = await sql<{ write_descriptor: string }>`
      SELECT write_descriptor FROM governance_approvals
    `.execute(db);
    expect(stored.rows).toHaveLength(1);
    // Sanity: the encryption really is nondeterministic, so the collapse above
    // cannot be explained by the ciphertext happening to match.
    expect(await encryptDescriptorTwice(encryption)).toBe('different');
  });

  it('collapses overlapping duplicate enqueues onto one approval', async () => {
    // Codex R4: deliberately NOT called a concurrency test. better-sqlite3 is
    // synchronous and Kysely serializes access to it, so `Promise.all` here
    // interleaves nothing — it is repeated dispatch, not contention. The real
    // concurrency proof lives in the Postgres integration profile
    // (tests/integration/postgres/approvalEnqueueConcurrency.test.ts); this
    // case only pins that repeated dispatch converges.
    const svc = makeService();
    const ids = await Promise.all([
      svc.enqueue(enqueueArgs()),
      svc.enqueue(enqueueArgs()),
      svc.enqueue(enqueueArgs()),
    ]);

    expect(new Set(ids).size).toBe(1);
    expect(await rowCount()).toBe(1);
  });

  it('dedupes on the DESCRIPTOR, ignoring wrapper fields that are never persisted', async () => {
    // Copilot review on #1131. `reason.callerSystem` and `reason.entity` live
    // on the enqueue wrapper and are stored nowhere — only the descriptor is
    // persisted and replayed. Reading them into the fingerprint meant two
    // calls that persist IDENTICALLY could fingerprint differently, silently
    // disabling dedupe. `enqueue` is independently callable, so a mismatched
    // wrapper is reachable rather than theoretical.
    const svc = makeService();
    const shared = descriptor();

    const first = await svc.enqueue(enqueueArgs({}, shared));
    const mismatchedWrapper = enqueueArgs({}, shared);
    (mismatchedWrapper.reason as { callerSystem: string }).callerSystem = 'shopify';
    (mismatchedWrapper.reason as { entity: string }).entity = 'accounts';
    const second = await svc.enqueue(mismatchedWrapper);

    expect(second).toBe(first);
    expect(await rowCount()).toBe(1);
  });

  it('logs the descriptor\'s systems, not the wrapper\'s, so logs match the row', async () => {
    // Copilot R6. The fingerprint and the persisted row come from
    // ownership.*; logging the wrapper's copies would make the log disagree
    // with the row exactly when a mismatched wrapper is what someone is trying
    // to diagnose.
    const logger = new Logger('a8-log-fidelity-test');
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const svc = makeService(undefined, logger);

    const args = enqueueArgs();
    (args.reason as { callerSystem: string }).callerSystem = 'shopify';
    (args.reason as { declaredOwner: string }).declaredOwner = 'netsuite';
    await svc.enqueue(args);

    expect(info).toHaveBeenCalledWith(
      'ownership approval queued',
      expect.objectContaining({ callerSystem: 'netsuite', declaredOwner: 'salesforce' }),
    );
  });

  it('does NOT collapse two materially different descriptors', async () => {
    const svc = makeService();
    const first = await svc.enqueue(enqueueArgs({}, descriptor({ args: { firstName: 'Ada' } })));
    const second = await svc.enqueue(enqueueArgs({}, descriptor({ args: { firstName: 'Grace' } })));

    expect(second).not.toBe(first);
    expect(await rowCount()).toBe(2);
  });

  it('does NOT collapse unrelated creates that share resourceId "new"', async () => {
    // Every create arrives with the same placeholder resource id. Keying on
    // (tenant, resource) alone would merge unrelated creates into one approval
    // and silently discard real work.
    const svc = makeService();
    const first = await svc.enqueue(
      enqueueArgs({ resourceId: 'new' }, descriptor({ operation: 'create', args: { email: 'ada@example.com' } })),
    );
    const second = await svc.enqueue(
      enqueueArgs({ resourceId: 'new' }, descriptor({ operation: 'create', args: { email: 'grace@example.com' } })),
    );

    expect(second).not.toBe(first);
    expect(await rowCount()).toBe(2);
  });

  it('does NOT collapse identical intent across different tenants', async () => {
    const svc = makeService();
    const first = await svc.enqueue(enqueueArgs({ tenantId: 'tenant-a' }));
    const second = await svc.enqueue(enqueueArgs({ tenantId: 'tenant-b' }));

    expect(second).not.toBe(first);
    expect(await rowCount()).toBe(2);
  });

  it('supersedes a stale unreaped blocker and issues a new approval', async () => {
    // The partial index cannot express `expires_at > now`, so a pending row
    // past its TTL keeps occupying the slot until the sweep reaches it. The
    // protocol expires it under a CAS and retries — without that, an
    // already-dead approval would block the intent indefinitely.
    const expiredImmediately = makeService(-1000);
    const stale = await expiredImmediately.enqueue(enqueueArgs());

    const svc = makeService();
    const fresh = await svc.enqueue(enqueueArgs());

    expect(fresh).not.toBe(stale);
    expect(await rowCount()).toBe(2);

    const statuses = await sql<{ id: string; status: string }>`
      SELECT id, status FROM governance_approvals ORDER BY id
    `.execute(db);
    const byId = new Map(statuses.rows.map((r) => [r.id, r.status]));
    expect(byId.get(stale)).toBe('expired');
    expect(byId.get(fresh)).toBe('pending');
  });

  it.each(['approved', 'rejected', 'expired'])(
    'lets a new approval through when the previous one is %s',
    async (terminal) => {
      const svc = makeService();
      const first = await svc.enqueue(enqueueArgs());
      await sql`UPDATE governance_approvals SET status = ${terminal} WHERE id = ${first}`.execute(db);

      const second = await svc.enqueue(enqueueArgs());
      expect(second).not.toBe(first);
      expect(await rowCount()).toBe(2);
    },
  );

  it('retries when the blocker vanishes between the failed insert and the lookup', async () => {
    // Codex R4 listed this interleaving as untested. The blocker was decided
    // or swept in the gap, so the dedupe slot is free again — reporting a
    // conflict that no longer exists would refuse a write for no reason.
    const svc = makeService();
    const first = await svc.enqueue(enqueueArgs());
    await sql`DELETE FROM governance_approvals WHERE id = ${first}`.execute(db);

    // Insert conflicts once against a row that is gone by lookup time.
    const realInsert = repo.insertPending.bind(repo);
    const conflict = Object.assign(
      new Error(
        'UNIQUE constraint failed: governance_approvals.tenant_id, governance_approvals.request_fingerprint',
      ),
      { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    );
    jest
      .spyOn(repo, 'insertPending')
      .mockRejectedValueOnce(conflict)
      .mockImplementation(realInsert);

    const second = await svc.enqueue(enqueueArgs());
    expect(second).not.toBe(first);
    expect(await rowCount()).toBe(1);
  });

  it('still succeeds when the blocker vanishes on what used to be the FINAL attempt', async () => {
    // Copilot review on #1131. With the previous insert-count bound, two
    // consecutive vanished blockers exhausted the loop and threw
    // APPROVAL_ENQUEUE_NO_CONVERGENCE even though the dedupe slot was free —
    // refusing a legitimate write for a conflict that no longer existed.
    // Bounding RESOLUTIONS instead guarantees an insert after the last one.
    const svc = makeService();
    const realInsert = repo.insertPending.bind(repo);
    const conflict = () =>
      Object.assign(
        new Error(
          'UNIQUE constraint failed: governance_approvals.tenant_id, governance_approvals.request_fingerprint',
        ),
        { code: 'SQLITE_CONSTRAINT_UNIQUE' },
      );

    jest
      .spyOn(repo, 'insertPending')
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockImplementation(realInsert);
    // Both lookups find nothing: the blocker was decided or swept each time.
    jest.spyOn(repo, 'findPendingOwnershipByFingerprint').mockResolvedValue(null);

    const id = await svc.enqueue(enqueueArgs());
    expect(id).toBeTruthy();
    expect(await rowCount()).toBe(1);
  });

  it('propagates a non-conflict database failure instead of returning some other approval', async () => {
    // Treating every insert failure as a dedupe hit would return an unrelated
    // approval id as if the caller's write had been queued.
    const svc = makeService();
    const boom = new Error('disk I/O error');
    jest.spyOn(repo, 'insertPending').mockRejectedValueOnce(boom);

    await expect(svc.enqueue(enqueueArgs())).rejects.toThrow('disk I/O error');
    expect(await rowCount()).toBe(0);
  });

  it('fails loudly rather than looping when the blocker cannot be cleared', async () => {
    // A live blocker that keeps being refreshed must not spin. Simulated by
    // making the CAS-expire a no-op while the blocker stays stale.
    const expiredImmediately = makeService(-1000);
    await expiredImmediately.enqueue(enqueueArgs());
    jest.spyOn(repo, 'expirePendingFingerprintIfStale').mockResolvedValue(false);

    const svc = makeService();
    await expect(svc.enqueue(enqueueArgs())).rejects.toThrow(APPROVAL_ENQUEUE_NO_CONVERGENCE);
  });
});

describe('isPendingOwnershipFingerprintConflict', () => {
  // Both shapes were captured from the real drivers rather than invented; these
  // pin them so a driver upgrade that changes either one fails here rather than
  // by silently turning every duplicate enqueue into an unhandled error.
  it('recognizes the Postgres shape: SQLSTATE 23505 plus the index name', () => {
    expect(
      isPendingOwnershipFingerprintConflict(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: PENDING_OWNERSHIP_FINGERPRINT_INDEX,
        }),
      ),
    ).toBe(true);
  });

  it('recognizes the better-sqlite3 shape, which names COLUMNS and has no constraint field', () => {
    expect(
      isPendingOwnershipFingerprintConflict(
        Object.assign(
          new Error(
            'UNIQUE constraint failed: governance_approvals.tenant_id, governance_approvals.request_fingerprint',
          ),
          { code: 'SQLITE_CONSTRAINT_UNIQUE' },
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ['a different Postgres constraint', { code: '23505', constraint: 'governance_approvals_pkey' }],
    ['a Postgres unique violation with no constraint name', { code: '23505' }],
    ['a different SQLite unique index', {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: governance_approvals.id',
    }],
    ['a SQLite NOT NULL violation', { code: 'SQLITE_CONSTRAINT_NOTNULL' }],
    ['an unrelated error', { code: 'ECONNRESET' }],
    ['a plain error', {}],
  ])('does NOT treat %s as a dedupe conflict', (_label, shape) => {
    // A false positive here returns some unrelated approval's id as though the
    // caller's governed write had been queued.
    const error = Object.assign(new Error((shape as { message?: string }).message ?? 'boom'), shape);
    expect(isPendingOwnershipFingerprintConflict(error)).toBe(false);
  });

  it.each([[null], [undefined], ['a string'], [42]])(
    'returns false for the non-object value %p rather than throwing',
    (value) => {
      expect(isPendingOwnershipFingerprintConflict(value)).toBe(false);
    },
  );
});

/** Proves EncryptionService is nondeterministic for identical plaintext. */
async function encryptDescriptorTwice(encryption: EncryptionService): Promise<string> {
  const { encryptDescriptor } = await import('../../../../src/services/governance/writeDescriptorEncryption');
  const one = JSON.stringify(await encryptDescriptor(descriptor(), encryption));
  const two = JSON.stringify(await encryptDescriptor(descriptor(), encryption));
  return one === two ? 'identical' : 'different';
}
