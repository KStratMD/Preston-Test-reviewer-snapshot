import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import {
  SerializedAssetRetryOperationRepository,
  SERIALIZED_ASSET_RETRY_LEASE_MS,
  SERIALIZED_ASSET_RETRY_HEARTBEAT_MS,
  SERIALIZED_ASSET_RETRY_POLL_MS,
  SERIALIZED_ASSET_RETRY_UNCLAIMABLE_SNAPSHOT,
} from '../../../../src/services/serializedAsset/SerializedAssetRetryOperationRepository';

const TENANT = 'tenant-a';
const CONFIG = 'cfg-1';
const T0 = new Date('2026-08-08T00:00:00.000Z');

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

/** Injected clock — no fake timers, so the lease maths is explicit and readable. */
class TestClock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now = (): Date => this.current;
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe('SerializedAssetRetryOperationRepository', () => {
  let db: Kysely<Database>;
  let clock: TestClock;
  let repo: SerializedAssetRetryOperationRepository;

  beforeEach(async () => {
    db = makeDb();
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');
    clock = new TestClock(T0);
    repo = new SerializedAssetRetryOperationRepository(
      { getDatabase: () => db },
      clock.now,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** Frees the single-active slot, standing in for a concurrent terminal transition. */
  const sqlDeleteAll = async (): Promise<void> => {
    await db.deleteFrom('serialized_asset_retry_operations').execute();
  };

  const reserve = (overrides: { id?: string; tenantId?: string; configurationId?: string } = {}) =>
    repo.reserve({
      id: overrides.id ?? `op-${Math.random().toString(36).slice(2, 10)}`,
      tenantId: overrides.tenantId ?? TENANT,
      configurationId: overrides.configurationId ?? CONFIG,
      requesterUserId: 'user-1',
      correlationId: 'corr-1',
    });

  describe('timing constants', () => {
    it('pins lease, heartbeat and poll so they cannot drift implicitly', () => {
      // The plan fixes these three. A silent change to any one of them alters
      // takeover behaviour in production without failing a single test unless
      // the values themselves are asserted.
      expect(SERIALIZED_ASSET_RETRY_LEASE_MS).toBe(5 * 60_000);
      expect(SERIALIZED_ASSET_RETRY_HEARTBEAT_MS).toBe(30_000);
      expect(SERIALIZED_ASSET_RETRY_POLL_MS).toBe(5_000);
      // The heartbeat must be comfortably inside the lease or a healthy worker
      // would lose its own lease between beats.
      expect(SERIALIZED_ASSET_RETRY_HEARTBEAT_MS * 2).toBeLessThan(SERIALIZED_ASSET_RETRY_LEASE_MS);
    });
  });

  describe('reserve', () => {
    it('creates a durable accepted operation with no owner and token zero', async () => {
      const result = await reserve({ id: 'op-1' });
      expect(result.outcome).toBe('created');
      expect(result.operation).toMatchObject({
        id: 'op-1',
        tenantId: TENANT,
        configurationId: CONFIG,
        status: 'accepted',
        leaseOwner: null,
        fencingToken: 0,
      });
      expect(result.operation.createdAt).toBe(T0.toISOString());
      expect(result.operation.startedAt).toBeNull();
      expect(result.operation.finishedAt).toBeNull();
    });

    it('converges a duplicate reservation onto the existing operation', async () => {
      // Two operators hitting the button, or one retrying, must not start
      // parallel drains of the same backlog.
      const first = await reserve({ id: 'op-1' });
      const second = await reserve({ id: 'op-2' });

      expect(second.outcome).toBe('existing');
      expect(second.operation.id).toBe(first.operation.id);
      expect(await repo.getById(TENANT, 'op-2')).toBeNull();
    });

    it('converges onto a RUNNING operation too, not only an accepted one', async () => {
      const first = await reserve({ id: 'op-1' });
      await repo.claimNext('worker-1');

      const second = await reserve({ id: 'op-2' });
      expect(second.outcome).toBe('existing');
      expect(second.operation.id).toBe(first.operation.id);
      expect(second.operation.status).toBe('running');
    });

    it('allows a fresh reservation once the previous operation is terminal', async () => {
      const first = await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');
      await repo.complete({
        id: first.operation.id,
        leaseOwner: 'worker-1',
        fencingToken: claimed!.fencingToken,
        counters: { read: 1, upserted: 1, deferred: 0, quarantined: 0, failed: 0 },
      });

      const second = await reserve({ id: 'op-2' });
      expect(second.outcome).toBe('created');
      expect(second.operation.id).toBe('op-2');
    });

    it('retries rather than surfacing a conflict that no longer exists', async () => {
      // Copilot review on #1132. The active row can go terminal between the
      // failed insert and the follow-up read, which frees the slot. Rethrowing
      // the unique violation there surfaced a transient 500 for a conflict
      // that had already resolved — and the comment claimed the caller
      // retried, which it did not.
      await reserve({ id: 'op-1' });

      const realFindActive = (repo as unknown as {
        findActive: (t: string, c: string) => Promise<unknown>;
      }).findActive.bind(repo);
      const findActiveSpy = jest
        .spyOn(repo as never, 'findActive' as never)
        // First lookup: the blocker vanished. Afterwards, behave normally.
        .mockImplementationOnce(async () => {
          await sqlDeleteAll();
          return null;
        })
        .mockImplementation(realFindActive as never);

      const second = await reserve({ id: 'op-2' });
      expect(second.outcome).toBe('created');
      expect(second.operation.id).toBe('op-2');
      findActiveSpy.mockRestore();
    });

    it('keeps reservations independent across tenants and configurations', async () => {
      const a = await reserve({ id: 'op-a', tenantId: 'tenant-a' });
      const b = await reserve({ id: 'op-b', tenantId: 'tenant-b' });
      const c = await reserve({ id: 'op-c', configurationId: 'cfg-2' });
      expect(new Set([a.operation.id, b.operation.id, c.operation.id]).size).toBe(3);
    });
  });

  describe('getById', () => {
    it('is tenant-scoped: another tenant cannot see the operation', async () => {
      await reserve({ id: 'op-1' });
      expect(await repo.getById(TENANT, 'op-1')).not.toBeNull();
      expect(await repo.getById('tenant-b', 'op-1')).toBeNull();
    });
  });

  describe('claimNext', () => {
    it('claims an accepted operation, moving it to running with token 1', async () => {
      await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');

      expect(claimed).toMatchObject({
        id: 'op-1',
        status: 'running',
        leaseOwner: 'worker-1',
        fencingToken: 1,
      });
      expect(claimed!.startedAt).toBe(T0.toISOString());
      expect(claimed!.leaseExpiresAt).toBe(
        new Date(T0.getTime() + SERIALIZED_ASSET_RETRY_LEASE_MS).toISOString(),
      );
    });

    it('returns null when there is nothing claimable', async () => {
      expect(await repo.claimNext('worker-1')).toBeNull();
    });

    it('refuses to take over a LIVE running operation', async () => {
      await reserve({ id: 'op-1' });
      await repo.claimNext('worker-1');

      clock.advance(SERIALIZED_ASSET_RETRY_LEASE_MS - 1);
      expect(await repo.claimNext('worker-2')).toBeNull();
    });

    it('takes over a running operation once its lease has expired, incrementing the token', async () => {
      await reserve({ id: 'op-1' });
      const first = await repo.claimNext('worker-1');
      expect(first!.fencingToken).toBe(1);

      clock.advance(SERIALIZED_ASSET_RETRY_LEASE_MS + 1);
      const second = await repo.claimNext('worker-2');

      expect(second).toMatchObject({ id: 'op-1', leaseOwner: 'worker-2', fencingToken: 2 });
    });

    it('cannot steal a claim from an incumbent that heartbeats between the scan and the CAS', async () => {
      // Codex R1 on #1132, and the reason claimObserved exists. A heartbeat
      // renews the lease WITHOUT changing the fencing token, so a CAS keyed
      // only on (status, token) still matched and a healthy owner could be
      // displaced by a worker whose scan saw the pre-heartbeat lease.
      //
      // A sequential test through claimNext CANNOT show this: the scan's own
      // filter would exclude the renewed row, so the assertion would pass
      // whether or not the CAS carried the lease. Driving claimObserved with
      // the stale snapshot is what makes the predicate load-bearing.
      await reserve({ id: 'op-1' });
      const ownerA = await repo.claimNext('worker-A');

      clock.advance(SERIALIZED_ASSET_RETRY_LEASE_MS + 1);

      // What worker B's scan would have seen: lease lapsed, token still 1.
      const staleSnapshot = (await repo.getById(TENANT, 'op-1'))!;
      expect(staleSnapshot.fencingToken).toBe(ownerA!.fencingToken);

      // A is alive after all and renews before B's update lands.
      expect(await repo.heartbeat({
        id: 'op-1',
        leaseOwner: 'worker-A',
        fencingToken: ownerA!.fencingToken,
      })).toBe(true);

      // B's CAS is computed from the pre-heartbeat snapshot and must not win.
      expect(await repo.claimObserved(staleSnapshot, 'worker-B')).toBeNull();

      const after = await repo.getById(TENANT, 'op-1');
      expect(after).toMatchObject({ leaseOwner: 'worker-A', fencingToken: ownerA!.fencingToken });
    });

    it('refuses a snapshot of a live claim rather than stealing it', async () => {
      // Codex round 2: claimObserved is public only so the race above can be
      // driven with a stale snapshot, and that makes it a footgun — the CAS
      // matches the OBSERVED lease, so handing it a CURRENT snapshot of a
      // healthy claim would satisfy that predicate and steal a live operation.
      // It now rejects a snapshot that was not claimable when observed.
      await reserve({ id: 'op-1' });
      const live = await repo.claimNext('worker-A');
      expect(live).not.toBeNull();

      // No time passes, so worker-A's lease is current: this snapshot is not
      // claimable and must be refused outright — not returned as null (which
      // would read as a lost race) and certainly not honoured.
      const liveSnapshot = (await repo.getById(TENANT, 'op-1'))!;
      await expect(repo.claimObserved(liveSnapshot, 'worker-B')).rejects.toThrow(
        SERIALIZED_ASSET_RETRY_UNCLAIMABLE_SNAPSHOT,
      );

      const after = await repo.getById(TENANT, 'op-1');
      expect(after).toMatchObject({ leaseOwner: 'worker-A', fencingToken: live!.fencingToken });
    });

    it('does not claim when the snapshot carries the wrong tenant', async () => {
      // Codex round 3: `id` alone identifies the row, so without tenant in the
      // CAS the UPDATE and the tenant-scoped read below disagree — the claim
      // lands, `getById` returns null for the mismatched tenant, and the
      // operation is silently claimed and never reported, running until its
      // lease lapses with nobody executing it.
      await reserve({ id: 'op-1' });
      const before = (await repo.getById(TENANT, 'op-1'))!;

      const wrongTenant = { ...before, tenantId: 'tenant-b' };

      expect(await repo.claimObserved(wrongTenant, 'worker-B')).toBeNull();

      // The decisive assertion: the row must be UNTOUCHED, not merely
      // unreported. Without the tenant predicate it is `running` at token 1.
      const after = (await repo.getById(TENANT, 'op-1'))!;
      expect(after.status).toBe('accepted');
      expect(after.fencingToken).toBe(before.fencingToken);
      expect(after.leaseOwner).toBeNull();
    });

    it('refuses a snapshot whose lease timestamp does not parse', async () => {
      // Copilot round 3: the claimability check compares instants, not
      // strings. An unparseable value must be refused, not treated as an
      // expired lease that may be taken over.
      await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-A');
      expect(claimed).not.toBeNull();

      // The value must sort BEFORE the current ISO timestamp lexicographically,
      // or the test proves nothing: 'not-a-date' starts with 'n', which already
      // sorts after '2026-…', so a string comparison would refuse it too and
      // the assertion would hold with or without the fix. '!' sorts before any
      // digit, so the old comparison would have read this as a lapsed lease and
      // allowed the takeover.
      const garbled = { ...(await repo.getById(TENANT, 'op-1'))!, leaseExpiresAt: '!!!-not-a-date' };
      expect('!!!-not-a-date' < new Date().toISOString()).toBe(true);

      await expect(repo.claimObserved(garbled, 'worker-B')).rejects.toThrow(
        SERIALIZED_ASSET_RETRY_UNCLAIMABLE_SNAPSHOT,
      );
    });

    it('refuses a snapshot of an operation that has already gone terminal', async () => {
      const reserved = await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');
      await repo.complete({
        id: reserved.operation.id,
        leaseOwner: 'worker-1',
        fencingToken: claimed!.fencingToken,
        counters: { read: 0, upserted: 0, failed: 0, deferred: 0, quarantined: 0 },
      });

      const terminalSnapshot = (await repo.getById(TENANT, 'op-1'))!;
      await expect(repo.claimObserved(terminalSnapshot, 'worker-2')).rejects.toThrow(
        SERIALIZED_ASSET_RETRY_UNCLAIMABLE_SNAPSHOT,
      );
    });

    it('never claims a terminal operation', async () => {
      const reserved = await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');
      await repo.fail({
        id: reserved.operation.id,
        leaseOwner: 'worker-1',
        fencingToken: claimed!.fencingToken,
        errorCode: 'target_write_failed',
        errorClass: 'ConnectorError',
      });

      clock.advance(SERIALIZED_ASSET_RETRY_LEASE_MS * 10);
      expect(await repo.claimNext('worker-2')).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('extends the lease for the current owner and token', async () => {
      await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');

      clock.advance(SERIALIZED_ASSET_RETRY_HEARTBEAT_MS);
      const ok = await repo.heartbeat({
        id: 'op-1',
        leaseOwner: 'worker-1',
        fencingToken: claimed!.fencingToken,
      });

      expect(ok).toBe(true);
      const after = await repo.getById(TENANT, 'op-1');
      expect(after!.leaseExpiresAt).toBe(
        new Date(clock.now().getTime() + SERIALIZED_ASSET_RETRY_LEASE_MS).toISOString(),
      );
      expect(after!.heartbeatAt).toBe(clock.now().toISOString());
    });

    it('refuses a heartbeat carrying the wrong token or owner', async () => {
      await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');

      expect(await repo.heartbeat({ id: 'op-1', leaseOwner: 'worker-1', fencingToken: claimed!.fencingToken + 1 })).toBe(false);
      expect(await repo.heartbeat({ id: 'op-1', leaseOwner: 'worker-2', fencingToken: claimed!.fencingToken })).toBe(false);
    });
  });

  describe('THE STALE-OWNER INVARIANT', () => {
    it('lets a superseded owner change nothing: heartbeat, success and failure all affect zero rows', async () => {
      // The reason fencing tokens exist. Owner A's lease lapses, B takes over,
      // and A wakes up mid-flight still believing it owns the operation. If any
      // of A's writes landed, B's in-progress run would be reported as finished
      // — a drain that is still running would look complete to the operator,
      // and B's eventual result would be lost or overwritten.
      await reserve({ id: 'op-1' });
      const ownerA = await repo.claimNext('worker-A');
      expect(ownerA!.fencingToken).toBe(1);

      clock.advance(SERIALIZED_ASSET_RETRY_LEASE_MS + 1);
      const ownerB = await repo.claimNext('worker-B');
      expect(ownerB!.fencingToken).toBe(2);

      const staleArgs = { id: 'op-1', leaseOwner: 'worker-A', fencingToken: ownerA!.fencingToken };
      expect(await repo.heartbeat(staleArgs)).toBe(false);
      expect(await repo.complete({
        ...staleArgs,
        counters: { read: 99, upserted: 99, deferred: 0, quarantined: 0, failed: 0 },
      })).toBe(false);
      expect(await repo.fail({ ...staleArgs, errorCode: 'stale', errorClass: 'StaleError' })).toBe(false);
      expect(await repo.interrupt(staleArgs)).toBe(false);

      // B still owns a running operation with none of A's values on it.
      const after = await repo.getById(TENANT, 'op-1');
      expect(after).toMatchObject({
        status: 'running',
        leaseOwner: 'worker-B',
        fencingToken: 2,
        unitsRead: null,
        errorCode: null,
      });
    });
  });

  describe('terminal writes', () => {
    it('records sanitized counters on success', async () => {
      await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');
      clock.advance(1000);

      const ok = await repo.complete({
        id: 'op-1',
        leaseOwner: 'worker-1',
        fencingToken: claimed!.fencingToken,
        counters: { read: 10, upserted: 7, deferred: 2, quarantined: 1, failed: 0 },
      });

      expect(ok).toBe(true);
      expect(await repo.getById(TENANT, 'op-1')).toMatchObject({
        status: 'succeeded',
        unitsRead: 10,
        unitsUpserted: 7,
        unitsDeferred: 2,
        unitsQuarantined: 1,
        unitsFailed: 0,
        finishedAt: clock.now().toISOString(),
        errorCode: null,
        errorClass: null,
      });
    });

    it('records a fixed code and class on failure and nothing else', async () => {
      await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');

      await repo.fail({
        id: 'op-1',
        leaseOwner: 'worker-1',
        fencingToken: claimed!.fencingToken,
        errorCode: 'target_write_failed',
        errorClass: 'ConnectorError',
      });

      expect(await repo.getById(TENANT, 'op-1')).toMatchObject({
        status: 'failed',
        errorCode: 'target_write_failed',
        errorClass: 'ConnectorError',
      });
    });

    it('records interrupted for a claim abandoned at shutdown', async () => {
      await reserve({ id: 'op-1' });
      const claimed = await repo.claimNext('worker-1');

      const ok = await repo.interrupt({
        id: 'op-1',
        leaseOwner: 'worker-1',
        fencingToken: claimed!.fencingToken,
      });

      expect(ok).toBe(true);
      expect(await repo.getById(TENANT, 'op-1')).toMatchObject({
        status: 'interrupted',
        finishedAt: clock.now().toISOString(),
      });
    });
  });
});
