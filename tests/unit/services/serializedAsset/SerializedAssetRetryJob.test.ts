import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import {
  SerializedAssetRetryOperationRepository,
  SERIALIZED_ASSET_RETRY_HEARTBEAT_MS,
  SERIALIZED_ASSET_RETRY_LEASE_MS,
  SERIALIZED_ASSET_RETRY_POLL_MS,
} from '../../../../src/services/serializedAsset/SerializedAssetRetryOperationRepository';
import {
  SerializedAssetRetryJob,
  RETRY_BUSY_CODE,
  RETRY_FAILURE_CODE,
  RETRY_UNKNOWN_ERROR_CLASS,
  SERIALIZED_ASSET_RETRY_STOP_GRACE_MS,
  safeErrorClass,
  toRetryCounters,
  type ForcedRetryExecutor,
} from '../../../../src/services/serializedAsset/SerializedAssetRetryJob';
import type { SyncResult } from '../../../../src/types';

const TENANT = 'tenant-a';
const CONFIG = 'cfg-1';
const T0 = new Date('2026-08-08T00:00:00.000Z');

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const COUNTERS = { read: 5, upserted: 4, deferred: 1, quarantined: 0, failed: 0 };

describe('SerializedAssetRetryJob', () => {
  let db: Kysely<Database>;
  let repo: SerializedAssetRetryOperationRepository;
  let executor: jest.Mocked<ForcedRetryExecutor>;
  let logger: ReturnType<typeof mockLogger>;
  let job: SerializedAssetRetryJob;
  let clockMs: number;

  beforeEach(async () => {
    db = makeDb();
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');
    clockMs = T0.getTime();
    repo = new SerializedAssetRetryOperationRepository(
      { getDatabase: () => db } as never,
      () => new Date(clockMs),
    );
    executor = { run: jest.fn().mockResolvedValue(COUNTERS) };
    logger = mockLogger();
    job = new SerializedAssetRetryJob(repo, executor, logger as never);
  });

  afterEach(async () => {
    // Order matters, and getting it wrong does not fail a test — it crashes
    // the worker with "database connection is not open" from inside a tick
    // that outlived the case. Clear pending timers so no NEW tick can start,
    // stop() to await any tick already in flight, restore real timers so that
    // promise chain can actually settle, then flush the microtask queue before
    // closing the database underneath it.
    jest.clearAllTimers();
    await job.stop();
    jest.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
    await db.destroy();
  });

  const reserve = (id: string, configurationId = CONFIG) =>
    repo.reserve({
      id,
      tenantId: TENANT,
      configurationId,
      requesterUserId: 'user-1',
      correlationId: 'corr-1',
    });

  describe('lifecycle', () => {
    it('is idempotent on double-start: warns and does not create a second interval', () => {
      jest.useFakeTimers();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      job.start();
      job.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('start() called while already running'),
      );
    });

    it('polls on the five-second default', () => {
      jest.useFakeTimers();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      job.start();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), SERIALIZED_ASSET_RETRY_POLL_MS);
    });

    it('stop() is safe when never started', async () => {
      await expect(job.stop()).resolves.toBeUndefined();
    });

    it('runs one tick at a time — a slow drain does not overlap the next interval', async () => {
      jest.useFakeTimers();
      await reserve('op-1');
      await reserve('op-2', 'cfg-2');

      let release: (() => void) | undefined;
      executor.run.mockImplementation(
        () => new Promise((resolve) => { release = () => resolve(COUNTERS); }),
      );

      job.start();
      // advanceTimersByTimeAsync, not advanceTimersByTime: the tick awaits a
      // real promise chain (claimNext -> select -> update -> re-read) and a
      // single `await Promise.resolve()` does not flush enough microtask turns
      // for it to reach the executor. The sync variant leaves the assertion
      // measuring a tick that has not started yet.
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS);
      // Several more intervals fire while the first drain is still running.
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS * 5);

      expect(executor.run).toHaveBeenCalledTimes(1);

      // Let the drain finish and settle before the test ends, or it would run
      // on against a database the teardown has already closed.
      jest.clearAllTimers();
      release?.();
      await job.stop();
    });
  });

  describe('claim and execute', () => {
    it('claims an accepted operation, runs it, and records sanitized counters', async () => {
      const reserved = await reserve('op-1');
      await job.tick();

      expect(executor.run).toHaveBeenCalledWith({
        tenantId: TENANT,
        configurationId: CONFIG,
        requesterUserId: 'user-1',
        correlationId: 'corr-1',
      });
      expect(await repo.getById(TENANT, reserved.operation.id)).toMatchObject({
        status: 'succeeded',
        unitsRead: 5,
        unitsUpserted: 4,
        unitsDeferred: 1,
        unitsQuarantined: 0,
        unitsFailed: 0,
        errorCode: null,
      });
    });

    it('does nothing when there is no claimable work', async () => {
      await job.tick();
      expect(executor.run).not.toHaveBeenCalled();
    });

    it('records a fixed code and the error CLASS on failure, never the message', async () => {
      // The canary: a connector error carrying a serial number must not reach
      // the durable row, because that row is served by the status endpoint.
      class ConnectorError extends Error {}
      executor.run.mockRejectedValue(new ConnectorError('upsert failed for SN-000123 secret=abc'));
      const reserved = await reserve('op-1');

      await job.tick();

      const after = await repo.getById(TENANT, reserved.operation.id);
      expect(after).toMatchObject({
        status: 'failed',
        errorCode: RETRY_FAILURE_CODE,
        errorClass: 'ConnectorError',
      });
      expect(JSON.stringify(after)).not.toContain('SN-000123');
      expect(JSON.stringify(after)).not.toContain('secret=abc');
    });

    it('does not let an executor failure escape the tick', async () => {
      executor.run.mockRejectedValue(new Error('boom'));
      await reserve('op-1');
      await expect(job.tick()).resolves.toBeUndefined();
    });
  });

  describe('shutdown', () => {
    it('marks a claim taken during shutdown as interrupted rather than leaving it running', async () => {
      // Claimed, then the process began stopping before execution started.
      // Without this the row would sit `running` for a full lease period and an
      // operator would see a drain that is not happening.
      const reserved = await reserve('op-1');
      await job.stop();
      await job.tick();

      expect(executor.run).not.toHaveBeenCalled();
      expect(await repo.getById(TENANT, reserved.operation.id)).toMatchObject({
        status: 'interrupted',
      });
    });

    it('stop() awaits an in-flight drain instead of cutting it mid-batch', async () => {
      jest.useFakeTimers();
      await reserve('op-1');

      let release: (() => void) | undefined;
      let finished = false;
      executor.run.mockImplementation(
        () => new Promise((resolve) => {
          release = () => { finished = true; resolve(COUNTERS); };
        }),
      );

      job.start();
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS);
      expect(executor.run).toHaveBeenCalledTimes(1);

      const stopped = job.stop();
      let stopResolved = false;
      void stopped.then(() => { stopResolved = true; });
      await Promise.resolve();
      // stop() must still be waiting: the drain has not been released.
      expect(stopResolved).toBe(false);
      expect(finished).toBe(false);

      release?.();
      await stopped;
      expect(finished).toBe(true);
    });

    it('stop() gives up on a drain that never settles instead of hanging shutdown', async () => {
      // Codex round 2: an unbounded `await this.inflight` makes shutdown hostage
      // to the executor. A connector call with no timeout would hang stop()
      // forever, and with it the whole graceful-shutdown sequence that awaits
      // it. Abandoning the tick is safe — the row is protected by the lease, so
      // the next worker reclaims it exactly as it would after a hard kill.
      jest.useFakeTimers();
      await reserve('op-1');
      // Never resolves, and is never released.
      executor.run.mockImplementation(() => new Promise<never>(() => {}));

      job.start();
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS);
      expect(executor.run).toHaveBeenCalledTimes(1);

      const stopped = job.stop();
      let stopResolved = false;
      void stopped.then(() => { stopResolved = true; });

      // Just short of the grace: still waiting.
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_STOP_GRACE_MS - 1);
      expect(stopResolved).toBe(false);

      // Past the grace: stop() completes without the drain ever settling.
      await jest.advanceTimersByTimeAsync(2);
      await stopped;
      expect(stopResolved).toBe(true);
    });

    it('an abandoned tick settling later cannot clear a restarted job\'s in-flight slot', async () => {
      // Codex round 3. stop() abandons a tick at the grace deadline but that
      // tick keeps running. If its `.finally` cleared `inflight`
      // unconditionally, and the job had since been restarted, it would clear a
      // NEWER tick's handle — after which the one-tick-at-a-time guard passes
      // and two drains overlap. The `.finally` is identity-checked instead.
      jest.useFakeTimers();
      await reserve('op-1');
      await reserve('op-2', 'cfg-2');
      // A THIRD claimable operation is what makes this test load-bearing. With
      // only op-1 and op-2 both leased, a wrongly-cleared slot still finds
      // nothing to claim, so the call-count assertion holds either way — the
      // mutation caught precisely that. op-3 is the bait a spurious third tick
      // would pick up.
      await reserve('op-3', 'cfg-3');

      const releases: Array<() => void> = [];
      executor.run.mockImplementation(
        () => new Promise((resolve) => { releases.push(() => resolve(COUNTERS)); }),
      );

      job.start();
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS);
      expect(executor.run).toHaveBeenCalledTimes(1); // tick A, never released

      // stop() abandons tick A at the grace deadline.
      const stopped = job.stop();
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_STOP_GRACE_MS + 1);
      await stopped;

      // Restart. Tick B claims the other configuration and blocks too.
      job.start();
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS);
      expect(executor.run).toHaveBeenCalledTimes(2);

      // NOW tick A finally settles. Its `.finally` must not clear tick B's slot.
      releases[0]?.();
      await jest.advanceTimersByTimeAsync(0);

      // If the slot had been cleared, this interval would start a third tick
      // while tick B is still running.
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS * 3);
      expect(executor.run).toHaveBeenCalledTimes(2);

      releases[1]?.();
      await job.stop();
    });

    it('stops renewing the lease once shutdown begins, so an abandoned operation can be taken over', async () => {
      // Copilot round 4, and it falsified my own justification for the grace
      // timeout. I had written that abandoning a tick was safe "because the
      // lease lapses and another worker reclaims it, the same path a hard kill
      // takes". A hard kill stops the heartbeat by killing the process. A
      // timed-out graceful stop leaves the process ALIVE, so the heartbeat kept
      // renewing and no replica could ever reclaim the operation — pinned by a
      // worker shutdown had already given up on.
      jest.useFakeTimers();
      const reserved = await reserve('op-1');
      executor.run.mockImplementation(() => new Promise<never>(() => {})); // never settles
      const beat = jest.spyOn(repo, 'heartbeat');

      // The injected clock must move WITH the fake timers. Without this every
      // beat writes `clockMs + LEASE_MS` — the same value every time — so the
      // lease assertion below holds whether or not heartbeats fire. The
      // mutation caught exactly that, and it is the fifth test in this PR to
      // fail this way.
      const advance = async (ms: number): Promise<void> => {
        clockMs += ms;
        await jest.advanceTimersByTimeAsync(ms);
      };

      job.start();
      await advance(SERIALIZED_ASSET_RETRY_POLL_MS);
      expect(executor.run).toHaveBeenCalledTimes(1);

      // Healthy: the beats land and the lease genuinely moves.
      const claimedLease = (await repo.getById(TENANT, reserved.operation.id))!.leaseExpiresAt;
      await advance(SERIALIZED_ASSET_RETRY_HEARTBEAT_MS * 2);
      const beating = (await repo.getById(TENANT, reserved.operation.id))!;
      expect(beating.leaseExpiresAt).not.toBe(claimedLease);
      const beatsWhileHealthy = beat.mock.calls.length;
      expect(beatsWhileHealthy).toBeGreaterThan(0);

      // Shutdown begins and gives up at the grace deadline.
      const stopped = job.stop();
      await advance(SERIALIZED_ASSET_RETRY_STOP_GRACE_MS + 1);
      await stopped;

      // Well past several heartbeat intervals, with the clock moving, so any
      // beat that fired would write a visibly later lease.
      await advance(SERIALIZED_ASSET_RETRY_HEARTBEAT_MS * 6);

      const after = (await repo.getById(TENANT, reserved.operation.id))!;
      expect(after.leaseExpiresAt).toBe(beating.leaseExpiresAt);
      expect(beat).toHaveBeenCalledTimes(beatsWhileHealthy);
    });

    it('a restart does not resurrect the abandoned tick\'s heartbeat', async () => {
      // The hole `stopping` alone leaves. stop() abandons a tick that outlives
      // the grace, but that tick's heartbeat interval is STILL ARMED —
      // runClaimed's finally never ran, because the executor never settled. A
      // later start() sets stopping = false, and the abandoned tick would begin
      // renewing its lease again, re-pinning the very operation shutdown gave
      // up on. The generation counter is one-way, so abandonment survives the
      // restart that `stopping` forgets.
      jest.useFakeTimers();
      const reserved = await reserve('op-1');
      await reserve('op-2', 'cfg-2');
      executor.run.mockImplementation(() => new Promise<never>(() => {}));

      const advance = async (ms: number): Promise<void> => {
        clockMs += ms;
        await jest.advanceTimersByTimeAsync(ms);
      };

      job.start();
      await advance(SERIALIZED_ASSET_RETRY_POLL_MS);
      await advance(SERIALIZED_ASSET_RETRY_HEARTBEAT_MS * 2);

      const stopped = job.stop();
      await advance(SERIALIZED_ASSET_RETRY_STOP_GRACE_MS + 1);
      await stopped;
      const abandoned = (await repo.getById(TENANT, reserved.operation.id))!;

      // Restart. `stopping` is false again and tick A's interval is still armed.
      job.start();
      const beat = jest.spyOn(repo, 'heartbeat');
      await advance(SERIALIZED_ASSET_RETRY_HEARTBEAT_MS * 4);

      // op-1 was abandoned; its lease must stay frozen so the row becomes
      // reclaimable once it lapses. Reclaimable is the whole claim — nothing
      // here guarantees another replica exists to actually take it.
      const after = (await repo.getById(TENANT, reserved.operation.id))!;
      expect(after.leaseExpiresAt).toBe(abandoned.leaseExpiresAt);
      expect(
        beat.mock.calls.filter(([h]) => h.id === reserved.operation.id),
      ).toHaveLength(0);

      // The other half of the claim, and without it this test is only half an
      // assertion (Codex round 6): a mutant that silenced EVERY heartbeat would
      // satisfy the check above. The restarted job's own tick must still be
      // beating normally — abandonment is specific to the old tick, not a
      // global stop.
      expect(beat.mock.calls.filter(([h]) => h.id === 'op-2').length).toBeGreaterThan(0);

      // Wind the restart down HERE, past its grace. The shared afterEach calls
      // jest.clearAllTimers() before stop(), which kills the grace timer — so a
      // never-settling tick left in flight at the end of a case makes that
      // stop() wait forever and the hook times out rather than the test failing.
      const finalStop = job.stop();
      await advance(SERIALIZED_ASSET_RETRY_STOP_GRACE_MS + 1);
      await finalStop;
    });

    it('start() during an in-progress stop() is refused', async () => {
      // Codex round 2: stop() clears the interval before awaiting the in-flight
      // tick. A start() in that window would clear `stopping`, arm a fresh
      // interval, and leave the in-progress stop() logging "stopped" over a job
      // that is running again.
      jest.useFakeTimers();
      await reserve('op-1');
      // A SECOND claimable operation, on a different configuration so it clears
      // the active-per-configuration unique index. Without it this test is
      // vacuous — op-1 is held `running` under a live lease, so claimNext finds
      // nothing and the assertion below passes whether or not start() was
      // refused. The mutation caught exactly that. This op is what a resurrected
      // interval would pick up.
      await reserve('op-2', 'cfg-2');

      let release: (() => void) | undefined;
      executor.run.mockImplementation(
        () => new Promise((resolve) => { release = () => resolve(COUNTERS); }),
      );

      job.start();
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS);
      expect(executor.run).toHaveBeenCalledTimes(1);

      const stopped = job.stop();
      await Promise.resolve();

      job.start();

      // The assertion CANNOT be made here. While op-1's tick is still in
      // flight, the one-tick-at-a-time guard makes the interval callback
      // return early, so op-2 goes unclaimed whether or not start() was
      // refused — Codex round 3 caught exactly that, and an earlier version of
      // this test was vacuous for it. A resurrected interval only becomes
      // observable once the in-flight tick clears. So: release, let stop()
      // finish, and only THEN look.
      executor.run.mockClear();
      release?.();
      await stopped;

      // stop() cleared the original interval before start() was called, so any
      // interval alive now was armed by that start(). op-2 is sitting there
      // claimable for it.
      await jest.advanceTimersByTimeAsync(SERIALIZED_ASSET_RETRY_POLL_MS * 3);

      expect(executor.run).not.toHaveBeenCalled();
      expect(await repo.getById(TENANT, 'op-2')).toMatchObject({ status: 'accepted' });
      expect(logger.warn).toHaveBeenCalledWith(
        '[SerializedAssetRetryJob] start() called while stopping — ignoring',
      );
    });
  });

  describe('takeover', () => {
    it('recovers an operation whose previous owner died, once the lease lapses', async () => {
      const reserved = await reserve('op-1');
      // A different worker claims and then vanishes without finishing.
      const dead = await repo.claimNext('worker-dead');
      expect(dead!.fencingToken).toBe(1);

      clockMs += SERIALIZED_ASSET_RETRY_LEASE_MS + 1;
      await job.tick();

      expect(executor.run).toHaveBeenCalledTimes(1);
      const after = await repo.getById(TENANT, reserved.operation.id);
      expect(after).toMatchObject({ status: 'succeeded', fencingToken: 2 });
    });

    it('leaves a live claim alone', async () => {
      await reserve('op-1');
      await repo.claimNext('worker-other');

      clockMs += SERIALIZED_ASSET_RETRY_LEASE_MS - 1;
      await job.tick();

      expect(executor.run).not.toHaveBeenCalled();
    });
  });

  describe('safeErrorClass', () => {
    // Codex R1 on #1132: error.constructor.name is not bounded. An over-long
    // name would fail the VARCHAR(64) write, aborting the terminal update and
    // stranding the operation `running` until its lease lapsed; a hostile one
    // could carry content into a row served over HTTP.
    it('keeps an ordinary error class name', () => {
      class ConnectorError extends Error {}
      expect(safeErrorClass(new ConnectorError('x'))).toBe('ConnectorError');
    });

    it('truncates an over-long class name to exactly the leading 64 characters', () => {
      // Asserting the CONTENT, not only the length (Codex round 2 nit): a
      // length-only assertion also passes if the function silently returns the
      // fixed fallback, a hash, or the TRAILING 64 characters.
      // The marker starts at index 64 exactly, so it is the first thing cut.
      const name = `${'E'.repeat(64)}TAIL_MARKER${'F'.repeat(200)}`;
      const err = new Error('x');
      Object.defineProperty(err, 'constructor', { value: { name } });

      const result = safeErrorClass(err);

      expect(result).toBe(name.slice(0, 64));
      expect(result).toHaveLength(64);
      expect(result).not.toContain('TAIL_MARKER');
    });

    it('falls back rather than throwing when reading the class name throws', () => {
      // Codex round 2: `constructor` and `name` are ordinary property reads, so
      // a throwing getter makes them throw. safeErrorClass is called INSIDE the
      // catch that writes the terminal failure row, so a throw here would abort
      // that write and strand the operation `running` — the same outcome the
      // truncation above prevents, reached through a different door.
      const err = new Error('x');
      Object.defineProperty(err, 'constructor', {
        get() {
          throw new Error('hostile getter');
        },
      });

      expect(() => safeErrorClass(err)).not.toThrow();
      expect(safeErrorClass(err)).toBe(RETRY_UNKNOWN_ERROR_CLASS);
    });

    it.each([
      ['spaces and punctuation', 'SN-000123 leaked'],
      ['an empty name', ''],
      ['a non-string name', 42 as unknown as string],
    ])('falls back to a fixed value for %s', (_label, name) => {
      const err = new Error('x');
      Object.defineProperty(err, 'constructor', { value: { name } });
      expect(safeErrorClass(err)).toBe(RETRY_UNKNOWN_ERROR_CLASS);
    });

    it('falls back for a non-Error throw', () => {
      expect(safeErrorClass('a string')).toBe(RETRY_UNKNOWN_ERROR_CLASS);
      expect(safeErrorClass(null)).toBe(RETRY_UNKNOWN_ERROR_CLASS);
    });

    it('persists the bounded value, so a hostile class name cannot strand the operation', async () => {
      const err = new Error('boom');
      Object.defineProperty(err, 'constructor', { value: { name: 'X'.repeat(300) } });
      executor.run.mockRejectedValue(err);
      const reserved = await reserve('op-1');

      await job.tick();

      const after = await repo.getById(TENANT, reserved.operation.id);
      expect(after!.status).toBe('failed');
      expect(after!.errorClass!.length).toBeLessThanOrEqual(64);
    });

    it('still reaches a terminal row when the class-name getter throws', async () => {
      // The end-to-end form of the guard above: without the try/catch in
      // safeErrorClass the throw escapes runClaimed's catch, no terminal write
      // happens, and the row stays `running` until the lease lapses.
      const err = new Error('boom');
      Object.defineProperty(err, 'constructor', {
        get() {
          throw new Error('hostile getter');
        },
      });
      executor.run.mockRejectedValue(err);
      const reserved = await reserve('op-throwing-getter');

      await job.tick();

      const after = await repo.getById(TENANT, reserved.operation.id);
      expect(after!.status).toBe('failed');
      expect(after!.errorClass).toBe(RETRY_UNKNOWN_ERROR_CLASS);
    });

    it('records a busy configuration under its own code, not the generic failure', async () => {
      // Codex round 2: an operator must be able to tell "collided with a
      // scheduled sync, run it again" from "the drain genuinely failed".
      const busy = Object.assign(new Error('Integration cfg-1 is already running'), {
        statusCode: 409,
      });
      executor.run.mockRejectedValue(busy);
      const reserved = await reserve('op-busy');

      await job.tick();

      const after = await repo.getById(TENANT, reserved.operation.id);
      expect(after!.status).toBe('failed');
      expect(after!.errorCode).toBe(RETRY_BUSY_CODE);
      expect(after!.errorCode).not.toBe(RETRY_FAILURE_CODE);
      // The thrower names the configuration; the durable row must not carry it.
      expect(JSON.stringify(after)).not.toContain('is already running');
    });

    it('still reaches a terminal row when the statusCode getter throws', async () => {
      // Codex round 3, same class as safeErrorClass: isConfigurationBusy reads
      // `statusCode`, and a throwing getter there escapes the catch that writes
      // the terminal row, stranding the operation `running`.
      const err = new Error('boom');
      Object.defineProperty(err, 'statusCode', {
        get() {
          throw new Error('hostile getter');
        },
      });
      executor.run.mockRejectedValue(err);
      const reserved = await reserve('op-hostile-status');

      await job.tick();

      const after = await repo.getById(TENANT, reserved.operation.id);
      expect(after!.status).toBe('failed');
      expect(after!.errorCode).toBe(RETRY_FAILURE_CODE);
    });

    it('does not treat an unrelated 409 as a busy configuration', async () => {
      // Copilot round 7. The drain reaches connectors, governance and guarded
      // writes, any of which could raise a 409 for a DETERMINISTIC reason.
      // Recording one of those as busy tells the operator "transient, run it
      // again" about a condition that will never clear on its own — worse than
      // not classifying it. Only the already-running shape counts.
      const other = Object.assign(new Error('managed credential reference conflict'), {
        statusCode: 409,
      });
      executor.run.mockRejectedValue(other);
      const reserved = await reserve('op-other-409');

      await job.tick();

      const after = await repo.getById(TENANT, reserved.operation.id);
      expect(after!.status).toBe('failed');
      expect(after!.errorCode).toBe(RETRY_FAILURE_CODE);
      expect(after!.errorCode).not.toBe(RETRY_BUSY_CODE);
    });

    it('keeps the generic failure code for an ordinary executor failure', async () => {
      executor.run.mockRejectedValue(new Error('connector exploded'));
      const reserved = await reserve('op-generic');

      await job.tick();

      const after = await repo.getById(TENANT, reserved.operation.id);
      expect(after!.errorCode).toBe(RETRY_FAILURE_CODE);
    });
  });

  describe('toRetryCounters', () => {
    const base: SyncResult = {
      integrationId: CONFIG,
      syncId: 'sync-1',
      status: 'success',
      success: true,
      recordsProcessed: 10,
      recordsSuccessful: 8,
      recordsFailed: 2,
      errors: ['ambiguous_parent', 'undecodable_payload'],
      startTime: T0,
      endTime: T0,
    };

    it('keeps only bounded counters and drops errors and metadata entirely', async () => {
      const counters = toRetryCounters({
        ...base,
        metadata: {
          serializedAssetResult: {
            deferred: 3,
            quarantined: 1,
            failures: [{ unitRef: 'digest-abc', category: 'write_failed' }],
          },
        },
      });

      expect(counters).toEqual({ read: 10, upserted: 8, failed: 2, deferred: 3, quarantined: 1 });
      // Nothing structural survives — the shape has no room for it.
      expect(Object.keys(counters).sort()).toEqual([
        'deferred', 'failed', 'quarantined', 'read', 'upserted',
      ]);
      expect(JSON.stringify(counters)).not.toContain('digest-abc');
      expect(JSON.stringify(counters)).not.toContain('ambiguous_parent');
    });

    it('degrades an unexpected nested shape to zero rather than persisting it', async () => {
      const counters = toRetryCounters({
        ...base,
        metadata: { serializedAssetResult: { deferred: 'lots', quarantined: null } },
      });
      expect(counters.deferred).toBe(0);
      expect(counters.quarantined).toBe(0);
    });

    it('tolerates a missing metadata block', async () => {
      expect(toRetryCounters(base)).toEqual({
        read: 10, upserted: 8, failed: 2, deferred: 0, quarantined: 0,
      });
    });
  });

  describe('heartbeat', () => {
    it('beats on the 30-second cadence while a drain runs', async () => {
      jest.useFakeTimers();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      await reserve('op-1');

      let release: (() => void) | undefined;
      executor.run.mockImplementation(
        () => new Promise((resolve) => { release = () => resolve(COUNTERS); }),
      );

      const ticking = job.tick();
      // Flush the claim's promise chain so the heartbeat timer is installed.
      await jest.advanceTimersByTimeAsync(0);

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        SERIALIZED_ASSET_RETRY_HEARTBEAT_MS,
      );

      release?.();
      await ticking;
    });
  });
});
