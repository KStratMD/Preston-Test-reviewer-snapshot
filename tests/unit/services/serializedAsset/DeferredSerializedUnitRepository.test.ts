import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import {
  DeferredSerializedUnitRepository,
  DEFERRED_SERIALIZED_UNIT_REASONS,
  computeDeferredBackoffMs,
  decodeNormalizedPayload,
  type DeferredSerializedUnitInput,
  type DeferredSerializedUnitReason,
} from '../../../../src/services/serializedAsset/DeferredSerializedUnitRepository';
import type { SerializedUnit } from '../../../../src/types/serializedAsset';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) await m.run(db, 'sqlite');
}

function makeRepo(db: Kysely<Database>): DeferredSerializedUnitRepository {
  return new DeferredSerializedUnitRepository({ getDatabase: () => db } as never);
}

function unit(overrides: Partial<SerializedUnit> = {}): SerializedUnit {
  return {
    tenantId: overrides.tenantId ?? 'tenant-a',
    configurationId: overrides.configurationId ?? 'cfg-1',
    inventoryNumberId: overrides.inventoryNumberId ?? 'inv-1',
    serialNumber: overrides.serialNumber ?? 'SN-0001',
    itemId: overrides.itemId ?? 'item-1',
    status: overrides.status,
    location: overrides.location,
  };
}

function input(overrides: Partial<DeferredSerializedUnitInput> = {}): DeferredSerializedUnitInput {
  const payload = overrides.normalizedPayload ?? unit();
  return {
    tenantId: overrides.tenantId ?? payload.tenantId,
    configurationId: overrides.configurationId ?? payload.configurationId,
    inventoryNumberId: overrides.inventoryNumberId ?? payload.inventoryNumberId,
    normalizedPayload: payload,
    reason: overrides.reason ?? 'parent_missing',
  };
}

const NOW = new Date('2026-07-27T00:00:00.000Z');

describe('DeferredSerializedUnitRepository', () => {
  let db: Kysely<Database>;
  let repo: DeferredSerializedUnitRepository;

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
    repo = makeRepo(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('upsertDeferred', () => {
    it('creates a new row on first deferral with attempt_count=1', async () => {
      await repo.upsertDeferred(input(), NOW);
      const rows = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      expect(rows).toHaveLength(1);
      expect(rows[0].attemptCount).toBe(1);
      expect(rows[0].firstDeferredAt).toBe(NOW.toISOString());
      expect(rows[0].lastAttemptAt).toBe(NOW.toISOString());
      expect(rows[0].reason).toBe('parent_missing');
      expect(rows[0].normalizedPayload).toEqual(unit());
    });

    it('sets next_attempt_at to now + backoff(1) on first deferral', async () => {
      await repo.upsertDeferred(input(), NOW);
      const [row] = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      const expected = new Date(NOW.getTime() + computeDeferredBackoffMs(1)).toISOString();
      expect(row.nextAttemptAt).toBe(expected);
    });

    it('increments attempt_count and advances next_attempt_at on a repeat deferral of the same key', async () => {
      await repo.upsertDeferred(input(), NOW);
      const secondAttemptAt = new Date(NOW.getTime() + 60_000);
      await repo.upsertDeferred(
        input({ reason: 'transient_dependency_failure' }),
        secondAttemptAt,
      );

      const rows = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      expect(rows).toHaveLength(1); // same key — updated in place, not duplicated
      expect(rows[0].attemptCount).toBe(2);
      expect(rows[0].reason).toBe('transient_dependency_failure');
      expect(rows[0].lastAttemptAt).toBe(secondAttemptAt.toISOString());
      const expectedNext = new Date(secondAttemptAt.getTime() + computeDeferredBackoffMs(2)).toISOString();
      expect(rows[0].nextAttemptAt).toBe(expectedNext);
    });

    it('preserves first_deferred_at across repeat deferrals', async () => {
      await repo.upsertDeferred(input(), NOW);
      const later = new Date(NOW.getTime() + 3600_000);
      await repo.upsertDeferred(input(), later);
      const [row] = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      expect(row.firstDeferredAt).toBe(NOW.toISOString());
      expect(row.lastAttemptAt).toBe(later.toISOString());
    });

    it('caps backoff at the 24h ceiling after many repeat deferrals', async () => {
      // The formula's exponent is capped at min(attemptCount-1, 11), so the raw
      // doubling reaches 60_000 * 2^11 = 122,880,000ms (~34.13h) — above the 24h
      // outer ceiling, which therefore genuinely clamps it. (With the previous
      // exponent cap of 10 the largest reachable delay was 17.07h and the 24h
      // ceiling was unreachable dead code.)
      let at = NOW;
      let lastAt = at;
      for (let i = 0; i < 15; i++) {
        lastAt = at;
        await repo.upsertDeferred(input(), at);
        at = new Date(at.getTime() + 1);
      }
      const [row] = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      expect(row.attemptCount).toBe(15);
      const capped = new Date(lastAt.getTime() + computeDeferredBackoffMs(15)).toISOString();
      expect(row.nextAttemptAt).toBe(capped);
      expect(computeDeferredBackoffMs(15)).toBe(24 * 60 * 60 * 1000);
    });

    it('treats (tenant_id, configuration_id, inventory_number_id) as the uniqueness key — a different configuration creates a separate row', async () => {
      await repo.upsertDeferred(input({ configurationId: 'cfg-1' }), NOW);
      await repo.upsertDeferred(
        input({ configurationId: 'cfg-2', normalizedPayload: unit({ configurationId: 'cfg-2' }) }),
        NOW,
      );
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(1);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-2')).toBe(1);
    });

    it('treats a different tenant as a separate row even with the same configuration/inventory ids', async () => {
      await repo.upsertDeferred(input({ tenantId: 'tenant-a' }), NOW);
      await repo.upsertDeferred(
        input({ tenantId: 'tenant-b', normalizedPayload: unit({ tenantId: 'tenant-b' }) }),
        NOW,
      );
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(1);
      expect(await repo.countForConfiguration('tenant-b', 'cfg-1')).toBe(1);
    });

    // Mutation-proving: the two tests below exercise the UPDATE branch (not just
    // INSERT) with a SECOND tenant/configuration present that shares the rest of
    // the key. Without both `.where('tenant_id', ...)` AND
    // `.where('configuration_id', ...)` on the UPDATE, a repeat deferral of one
    // key would silently overwrite the other row sharing (configuration_id,
    // inventory_number_id) or (tenant_id, inventory_number_id).
    it('a repeat deferral for tenant-a does not alter tenant-b row sharing (configuration_id, inventory_number_id)', async () => {
      await repo.upsertDeferred(
        input({ tenantId: 'tenant-a', normalizedPayload: unit({ tenantId: 'tenant-a', serialNumber: 'SN-A' }) }),
        NOW,
      );
      await repo.upsertDeferred(
        input({ tenantId: 'tenant-b', normalizedPayload: unit({ tenantId: 'tenant-b', serialNumber: 'SN-B' }) }),
        NOW,
      );

      // Repeat-defer tenant-a ONLY — this must hit the UPDATE branch for
      // tenant-a's row and never touch tenant-b's row.
      await repo.upsertDeferred(
        input({
          tenantId: 'tenant-a',
          reason: 'transient_dependency_failure',
          normalizedPayload: unit({ tenantId: 'tenant-a', serialNumber: 'SN-A-UPDATED' }),
        }),
        new Date(NOW.getTime() + 60_000),
      );

      const [tenantARow] = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      const [tenantBRow] = (await repo.listForRetry('tenant-b', 'cfg-1', 10)).units;

      expect(tenantARow.attemptCount).toBe(2);
      expect(tenantARow.reason).toBe('transient_dependency_failure');
      expect(tenantARow.normalizedPayload.serialNumber).toBe('SN-A-UPDATED');

      // tenant-b's row shares (configuration_id, inventory_number_id) with
      // tenant-a's — it must be completely untouched by tenant-a's repeat deferral.
      expect(tenantBRow.attemptCount).toBe(1);
      expect(tenantBRow.reason).toBe('parent_missing');
      expect(tenantBRow.normalizedPayload.serialNumber).toBe('SN-B');
    });

    it('a repeat deferral for cfg-1 does not alter cfg-2 row sharing (tenant_id, inventory_number_id)', async () => {
      await repo.upsertDeferred(
        input({
          configurationId: 'cfg-1',
          normalizedPayload: unit({ configurationId: 'cfg-1', serialNumber: 'SN-CFG1' }),
        }),
        NOW,
      );
      await repo.upsertDeferred(
        input({
          configurationId: 'cfg-2',
          normalizedPayload: unit({ configurationId: 'cfg-2', serialNumber: 'SN-CFG2' }),
        }),
        NOW,
      );

      // Repeat-defer cfg-1 ONLY — must hit the UPDATE branch for cfg-1's row
      // and never touch cfg-2's row (same tenant, same inventory_number_id).
      await repo.upsertDeferred(
        input({
          configurationId: 'cfg-1',
          reason: 'transient_dependency_failure',
          normalizedPayload: unit({ configurationId: 'cfg-1', serialNumber: 'SN-CFG1-UPDATED' }),
        }),
        new Date(NOW.getTime() + 60_000),
      );

      const [cfg1Row] = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      const [cfg2Row] = (await repo.listForRetry('tenant-a', 'cfg-2', 10)).units;

      expect(cfg1Row.attemptCount).toBe(2);
      expect(cfg1Row.reason).toBe('transient_dependency_failure');
      expect(cfg1Row.normalizedPayload.serialNumber).toBe('SN-CFG1-UPDATED');

      expect(cfg2Row.attemptCount).toBe(1);
      expect(cfg2Row.reason).toBe('parent_missing');
      expect(cfg2Row.normalizedPayload.serialNumber).toBe('SN-CFG2');
    });
  });

  describe('listDue', () => {
    it('returns only rows due at or before now, scoped to tenant + configuration', async () => {
      // A deferral recorded a long time in the past is due by NOW even after
      // its 1-minute initial backoff; a deferral recorded at NOW is not.
      await repo.upsertDeferred(
        input({ inventoryNumberId: 'inv-due', normalizedPayload: unit({ inventoryNumberId: 'inv-due' }) }),
        new Date(NOW.getTime() - 3600_000),
      );
      await repo.upsertDeferred(
        input({ inventoryNumberId: 'inv-future', normalizedPayload: unit({ inventoryNumberId: 'inv-future' }) }),
        NOW,
      );

      const due = (await repo.listDue('tenant-a', 'cfg-1', NOW, 10)).units;
      expect(due.map((r) => r.inventoryNumberId)).toEqual(['inv-due']);
    });

    it('excludes rows from a different tenant or configuration', async () => {
      await repo.upsertDeferred(
        input({ tenantId: 'tenant-a', configurationId: 'cfg-1' }),
        new Date(NOW.getTime() - 3600_000),
      );
      await repo.upsertDeferred(
        input({
          tenantId: 'tenant-b',
          normalizedPayload: unit({ tenantId: 'tenant-b' }),
        }),
        new Date(NOW.getTime() - 3600_000),
      );
      await repo.upsertDeferred(
        input({
          tenantId: 'tenant-a',
          configurationId: 'cfg-2',
          normalizedPayload: unit({ configurationId: 'cfg-2' }),
        }),
        new Date(NOW.getTime() - 3600_000),
      );

      const due = (await repo.listDue('tenant-a', 'cfg-1', NOW, 10)).units;
      expect(due).toHaveLength(1);
      expect(due[0].tenantId).toBe('tenant-a');
    });

    it('honors the limit and orders by next_attempt_at ascending', async () => {
      // Stagger the deferral timestamps themselves (not next_attempt_at directly) so
      // next_attempt_at = deferredAt + backoff(1) preserves the same relative order:
      // inv-2 earliest, inv-1 next, inv-3 latest — all still due before NOW.
      const base = NOW.getTime() - 3600_000;
      await repo.upsertDeferred(
        input({ inventoryNumberId: 'inv-2', normalizedPayload: unit({ inventoryNumberId: 'inv-2' }) }),
        new Date(base),
      );
      await repo.upsertDeferred(
        input({ inventoryNumberId: 'inv-1', normalizedPayload: unit({ inventoryNumberId: 'inv-1' }) }),
        new Date(base + 100),
      );
      await repo.upsertDeferred(
        input({ inventoryNumberId: 'inv-3', normalizedPayload: unit({ inventoryNumberId: 'inv-3' }) }),
        new Date(base + 200),
      );

      const due = (await repo.listDue('tenant-a', 'cfg-1', NOW, 2)).units;
      expect(due).toHaveLength(2);
      expect(due.map((r) => r.inventoryNumberId)).toEqual(['inv-2', 'inv-1']);
    });
  });

  describe('listForRetry', () => {
    it('returns rows regardless of next_attempt_at, including future-scheduled rows listDue withholds', async () => {
      await repo.upsertDeferred(input(), NOW); // scheduled into the future by backoff(1)
      const due = (await repo.listDue('tenant-a', 'cfg-1', NOW, 10)).units;
      expect(due).toHaveLength(0); // confirms the row is indeed future-scheduled

      const retry = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      expect(retry).toHaveLength(1);
      expect(retry[0].inventoryNumberId).toBe('inv-1');
    });

    it('still refuses to cross tenant or configuration', async () => {
      await repo.upsertDeferred(input({ tenantId: 'tenant-a', configurationId: 'cfg-1' }), NOW);
      await repo.upsertDeferred(
        input({ tenantId: 'tenant-a', configurationId: 'cfg-2', normalizedPayload: unit({ configurationId: 'cfg-2' }) }),
        NOW,
      );
      await repo.upsertDeferred(
        input({ tenantId: 'tenant-b', normalizedPayload: unit({ tenantId: 'tenant-b' }) }),
        NOW,
      );

      const retry = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      expect(retry).toHaveLength(1);
      expect(retry[0].tenantId).toBe('tenant-a');
      expect(retry[0].configurationId).toBe('cfg-1');
    });

    it('still honors limit', async () => {
      for (const id of ['inv-1', 'inv-2', 'inv-3']) {
        await repo.upsertDeferred(
          input({ inventoryNumberId: id, normalizedPayload: unit({ inventoryNumberId: id }) }),
          NOW,
        );
      }
      const retry = (await repo.listForRetry('tenant-a', 'cfg-1', 2)).units;
      expect(retry).toHaveLength(2);
    });

    it('orders oldest-first by first_deferred_at so a forced retry cannot starve early rows', async () => {
      await repo.upsertDeferred(
        input({ inventoryNumberId: 'inv-old', normalizedPayload: unit({ inventoryNumberId: 'inv-old' }) }),
        new Date(NOW.getTime() - 10_000),
      );
      await repo.upsertDeferred(
        input({ inventoryNumberId: 'inv-new', normalizedPayload: unit({ inventoryNumberId: 'inv-new' }) }),
        NOW,
      );
      const retry = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      expect(retry.map((r) => r.inventoryNumberId)).toEqual(['inv-old', 'inv-new']);
    });
  });

  describe('deleteSucceeded', () => {
    it('deletes the matching row scoped to tenant + configuration + inventory number and returns true', async () => {
      await repo.upsertDeferred(input(), NOW);
      const deleted = await repo.deleteSucceeded('tenant-a', 'cfg-1', 'inv-1');
      expect(deleted).toBe(true);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(0);
    });

    it('returns false and deletes nothing for an unknown key', async () => {
      await repo.upsertDeferred(input(), NOW);
      const deleted = await repo.deleteSucceeded('tenant-a', 'cfg-1', 'inv-does-not-exist');
      expect(deleted).toBe(false);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(1);
    });

    it('never deletes across a tenant boundary even with matching configuration/inventory ids', async () => {
      await repo.upsertDeferred(input({ tenantId: 'tenant-a' }), NOW);
      const deleted = await repo.deleteSucceeded('tenant-b', 'cfg-1', 'inv-1');
      expect(deleted).toBe(false);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(1);
    });

    it('never deletes across a configuration boundary even with matching tenant/inventory ids (decision 9: only a confirmed upsert deletes)', async () => {
      await repo.upsertDeferred(
        input({ configurationId: 'cfg-1', normalizedPayload: unit({ configurationId: 'cfg-1' }) }),
        NOW,
      );
      await repo.upsertDeferred(
        input({ configurationId: 'cfg-2', normalizedPayload: unit({ configurationId: 'cfg-2' }) }),
        NOW,
      );

      // Confirming cfg-1's upsert must delete ONLY cfg-1's row — cfg-2's row for
      // the same tenant + inventory_number_id has NOT been confirmed and must
      // survive (deleting it would be silent, unconfirmed work loss).
      const deleted = await repo.deleteSucceeded('tenant-a', 'cfg-1', 'inv-1');
      expect(deleted).toBe(true);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(0);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-2')).toBe(1);
    });
  });

  describe('touchAttempt', () => {
    it('advances attempt_count and next_attempt_at without changing reason or the payload', async () => {
      await repo.upsertDeferred(input({ reason: 'parent_missing' }), NOW);
      const before = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units[0];

      const later = new Date(NOW.getTime() + 5 * 60_000);
      const attemptCount = await repo.touchAttempt('tenant-a', 'cfg-1', 'inv-1', later);

      const after = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units[0];
      expect(attemptCount).toBe(2);
      expect(after.attemptCount).toBe(2);
      expect(new Date(after.nextAttemptAt).getTime()).toBe(
        later.getTime() + computeDeferredBackoffMs(2),
      );
      expect(new Date(after.nextAttemptAt).getTime()).toBeGreaterThan(
        new Date(before.nextAttemptAt).getTime(),
      );
      // The diagnostic and the design-approved payload column are untouched.
      expect(after.reason).toBe('parent_missing');
      expect(after.normalizedPayload).toEqual(before.normalizedPayload);
      expect(after.firstDeferredAt).toBe(before.firstDeferredAt);
      expect(after.lastAttemptAt).toBe(later.toISOString());
    });

    it('backs off further on each successive touch, then saturates', async () => {
      // Saturation is the EXPONENT cap (2^10 x 1 min) rather than the 24h
      // ceiling — the exponent binds first. Asserted against the helper so this
      // test tracks whichever cap wins rather than a hand-copied number.
      const saturated = computeDeferredBackoffMs(Number.MAX_SAFE_INTEGER);
      await repo.upsertDeferred(input(), NOW);
      let previous = 0;
      for (let i = 0; i < 14; i += 1) {
        const at = new Date(NOW.getTime() + i * 1000);
        const attemptCount = await repo.touchAttempt('tenant-a', 'cfg-1', 'inv-1', at);
        const row = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units[0];
        const delay = new Date(row.nextAttemptAt).getTime() - at.getTime();
        expect(delay).toBe(computeDeferredBackoffMs(attemptCount as number));
        expect(delay).toBeGreaterThanOrEqual(previous);
        previous = delay;
      }
      expect(previous).toBe(saturated);
      expect(saturated).toBeGreaterThan(computeDeferredBackoffMs(1));
    });

    it('returns null when no row matches, without creating one', async () => {
      expect(await repo.touchAttempt('tenant-a', 'cfg-1', 'inv-absent', NOW)).toBeNull();
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(0);
    });

    it('never crosses a tenant or configuration boundary', async () => {
      await repo.upsertDeferred(input(), NOW);
      await repo.upsertDeferred(
        input({ tenantId: 'tenant-b', normalizedPayload: unit({ tenantId: 'tenant-b' }) }),
        NOW,
      );

      const later = new Date(NOW.getTime() + 60_000);
      expect(await repo.touchAttempt('tenant-b', 'cfg-1', 'inv-1', later)).toBe(2);

      const untouched = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units[0];
      expect(untouched.attemptCount).toBe(1);
      expect(await repo.touchAttempt('tenant-a', 'cfg-2', 'inv-1', later)).toBeNull();
    });
  });

  describe('countForConfiguration', () => {
    it('counts only rows scoped to the given tenant + configuration', async () => {
      await repo.upsertDeferred(input({ inventoryNumberId: 'inv-1' }), NOW);
      await repo.upsertDeferred(
        input({ inventoryNumberId: 'inv-2', normalizedPayload: unit({ inventoryNumberId: 'inv-2' }) }),
        NOW,
      );
      await repo.upsertDeferred(
        input({ tenantId: 'tenant-b', normalizedPayload: unit({ tenantId: 'tenant-b' }) }),
        NOW,
      );
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(2);
      expect(await repo.countForConfiguration('tenant-b', 'cfg-1')).toBe(1);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-does-not-exist')).toBe(0);
    });
  });

  describe('payload/key isolation guard', () => {
    const SHAPE_ERROR = 'deferred_serialized_units.normalized_payload failed shape validation';

    it('rejects upsertDeferred when normalizedPayload.tenantId disagrees with the row key, without leaking payload contents', async () => {
      const divergent = input({
        tenantId: 'tenant-a',
        normalizedPayload: unit({ tenantId: 'tenant-EVIL', serialNumber: 'SN-EVIL' }),
      });
      let thrown: unknown;
      try {
        await repo.upsertDeferred(divergent, NOW);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(SHAPE_ERROR);
      expect((thrown as Error).message).not.toContain('tenant-EVIL');
      expect((thrown as Error).message).not.toContain('SN-EVIL');
      // Nothing was written — the guard runs before any database access.
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(0);
    });

    it('rejects upsertDeferred when normalizedPayload.configurationId disagrees with the row key', async () => {
      const divergent = input({
        configurationId: 'cfg-1',
        normalizedPayload: unit({ configurationId: 'cfg-OTHER' }),
      });
      await expect(repo.upsertDeferred(divergent, NOW)).rejects.toThrow(SHAPE_ERROR);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(0);
    });

    it('rejects upsertDeferred when normalizedPayload.inventoryNumberId disagrees with the row key', async () => {
      const divergent = input({
        inventoryNumberId: 'inv-1',
        normalizedPayload: unit({ inventoryNumberId: 'inv-OTHER' }),
      });
      await expect(repo.upsertDeferred(divergent, NOW)).rejects.toThrow(SHAPE_ERROR);
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(0);
    });

    it('accepts a payload whose key fields agree with the row key', async () => {
      await expect(repo.upsertDeferred(input(), NOW)).resolves.toBeUndefined();
    });
  });

  describe('reason vocabulary guard', () => {
    const REASON_ERROR = 'deferred_serialized_units.reason is not in the closed vocabulary';

    // The TYPE cannot protect the CHECK-constrained column: a JS caller, an
    // `as` cast, or a JSON.parse round-trip all reach upsertDeferred untyped.
    // Handing the violation to PostgreSQL would surface a CHECK `DETAIL` that
    // embeds the whole failing row — normalized_payload, i.e. the serial.
    it('rejects an out-of-vocabulary reason before any database access, without leaking the payload', async () => {
      const rogue = input({
        reason: 'SN-LEAKED' as unknown as DeferredSerializedUnitReason,
        normalizedPayload: unit({ serialNumber: 'SN-LEAKED' }),
      });
      let thrown: unknown;
      try {
        await repo.upsertDeferred(rogue, NOW);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(REASON_ERROR);
      expect((thrown as Error).message).not.toContain('SN-LEAKED');
      expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(0);
    });

    it.each(DEFERRED_SERIALIZED_UNIT_REASONS)('accepts the in-vocabulary reason %s', async (reason) => {
      await expect(repo.upsertDeferred(input({ reason }), NOW)).resolves.toBeUndefined();
    });

    it("overwrites a hand-corrupted stored row's key fields with the row-derived key on read, never trusting the stored payload", async () => {
      // Bypasses the repository entirely (raw SQL) to construct a row that
      // diverges from its own key — the only way this can happen now that
      // upsertDeferred guards against it. Proves toView can never hand a wrong
      // tenantId/configurationId/inventoryNumberId to a caller even when the
      // stored payload itself is corrupted.
      const corruptPayload = JSON.stringify({
        tenantId: 'tenant-EVIL',
        configurationId: 'cfg-EVIL',
        inventoryNumberId: 'inv-OTHER',
        serialNumber: 'SN-CORRUPT',
        itemId: 'item-corrupt',
      });
      await sql`
        INSERT INTO deferred_serialized_units
          (tenant_id, configuration_id, inventory_number_id, normalized_payload, reason, attempt_count, next_attempt_at, first_deferred_at, last_attempt_at)
        VALUES
          (${'tenant-a'}, ${'cfg-1'}, ${'inv-1'}, ${corruptPayload}, ${'parent_missing'}, ${1}, ${NOW.toISOString()}, ${NOW.toISOString()}, ${NOW.toISOString()})
      `.execute(db);

      const [row] = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).units;
      expect(row.tenantId).toBe('tenant-a');
      expect(row.configurationId).toBe('cfg-1');
      expect(row.inventoryNumberId).toBe('inv-1');
      expect(row.normalizedPayload.tenantId).toBe('tenant-a');
      expect(row.normalizedPayload.configurationId).toBe('cfg-1');
      expect(row.normalizedPayload.inventoryNumberId).toBe('inv-1');
      // Non-key fields still come through from the stored payload unmodified.
      expect(row.normalizedPayload.serialNumber).toBe('SN-CORRUPT');
    });
  });
});

describe('computeDeferredBackoffMs', () => {
  it('starts at 1 minute for the first attempt', () => {
    expect(computeDeferredBackoffMs(1)).toBe(60_000);
  });

  it('doubles per attempt', () => {
    expect(computeDeferredBackoffMs(2)).toBe(120_000);
    expect(computeDeferredBackoffMs(3)).toBe(240_000);
  });

  it('takes its last uncapped doubling at attempt 11, then saturates at the 24h ceiling', () => {
    const CEILING_MS = 24 * 60 * 60 * 1000;

    // Attempt 11 -> exponent 10 -> 17.07h, still under the ceiling.
    expect(computeDeferredBackoffMs(11)).toBe(60_000 * 2 ** 10);
    expect(computeDeferredBackoffMs(11)).toBeLessThan(CEILING_MS);

    // Attempt 12 -> exponent 11 -> 34.13h raw, which the ceiling clamps to 24h.
    // Asserting the raw value EXCEEDS the ceiling is the load-bearing half: it
    // proves `Math.min(MAX_BACKOFF_MS, …)` is doing real work rather than being
    // an unreachable defensive bound (the defect this replaced).
    expect(60_000 * 2 ** 11).toBeGreaterThan(CEILING_MS);
    expect(computeDeferredBackoffMs(12)).toBe(CEILING_MS);
    expect(computeDeferredBackoffMs(100)).toBe(CEILING_MS);
  });

  it('never exceeds the 24-hour outer ceiling', () => {
    const cap = 24 * 60 * 60 * 1000;
    for (const attemptCount of [1, 2, 5, 10, 11, 50]) {
      expect(computeDeferredBackoffMs(attemptCount)).toBeLessThanOrEqual(cap);
    }
  });
});

describe('decodeNormalizedPayload', () => {
  it('round-trips a valid serialized unit through JSON string storage', () => {
    const payload = unit({ serialNumber: 'SN-ROUNDTRIP' });
    const decoded = decodeNormalizedPayload(JSON.stringify(payload));
    expect(decoded).toEqual(payload);
  });

  it('passes through an already-parsed object (Postgres jsonb read shape)', () => {
    const payload = unit({ serialNumber: 'SN-OBJECT' });
    expect(decodeNormalizedPayload(payload)).toEqual(payload);
  });

  it('throws on malformed shape without leaking any field value into the error message', () => {
    const sensitive = 'SECRET-SERIAL-DO-NOT-LEAK';
    let thrown: unknown;
    try {
      // Missing required fields entirely, but the JSON text itself contains a
      // decoy value shaped like a serial number to prove it never reaches the
      // thrown message.
      decodeNormalizedPayload(JSON.stringify({ note: sensitive }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).not.toContain(sensitive);
  });

  it('throws on non-object JSON (e.g. a bare string or array)', () => {
    expect(() => decodeNormalizedPayload(JSON.stringify('not-an-object'))).toThrow();
    expect(() => decodeNormalizedPayload(JSON.stringify([1, 2, 3]))).toThrow();
  });

  it('throws when a required field has the wrong type', () => {
    expect(() =>
      decodeNormalizedPayload(
        JSON.stringify({
          tenantId: 'tenant-a',
          configurationId: 'cfg-1',
          inventoryNumberId: 'inv-1',
          serialNumber: 12345, // wrong type
          itemId: 'item-1',
        }),
      ),
    ).toThrow();
  });

  // The read path must be exactly as strict as the write path:
  // NetSuiteSerializedUnitReader's normalizeScalar refuses a whitespace-only
  // string as missing_required_field, so decoding one back would yield a
  // SerializedUnit the reader could never have produced. Worst for
  // inventoryNumberId, which is both the Salesforce upsert external-ID key and
  // the deferred-work uniqueness key.
  it.each(['tenantId', 'configurationId', 'inventoryNumberId', 'serialNumber', 'itemId'])(
    'throws when required field %s is empty or whitespace-only',
    (field) => {
      for (const blank of ['', '   ', '\t\n']) {
        const payload = { ...unit(), [field]: blank };
        expect(() => decodeNormalizedPayload(JSON.stringify(payload))).toThrow(
          'deferred_serialized_units.normalized_payload failed shape validation',
        );
      }
    },
  );

  // Decode must reproduce what the reader would have produced, not merely
  // something type-compatible: padded values would otherwise be written
  // straight into Salesforce by SalesforceAssetPayloadBuilder.
  it('trims required fields the way the reader does', () => {
    const decoded = decodeNormalizedPayload(
      JSON.stringify({ ...unit(), serialNumber: '  SN-1  ', itemId: ' item-1 ' }),
    );
    expect(decoded.serialNumber).toBe('SN-1');
    expect(decoded.itemId).toBe('item-1');
  });

  it('trims a valid optional and omits a blank one, matching the reader', () => {
    const decoded = decodeNormalizedPayload(
      JSON.stringify({ ...unit(), status: '   ', location: '  L1  ' }),
    );
    expect(decoded.status).toBeUndefined();
    expect(decoded.location).toBe('L1');
  });
});

describe('a corrupt row never blocks the rest of the configuration', () => {
  let db: Kysely<Database>;
  let repo: DeferredSerializedUnitRepository;

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
    repo = makeRepo(db);
  });
  afterEach(async () => { await db.destroy(); });

  // decodeNormalizedPayload is deliberately strict, and both listings decode a
  // whole page. Unguarded, ONE corrupt row would throw out of the listing and
  // take every other deferred unit for the configuration with it — permanently,
  // since nothing quarantines the row and the sweep cursor has already moved on.
  async function insertCorruptRow(
    inventoryNumberId = 'inv-CORRUPT',
    firstDeferredAt: Date = NOW,
  ): Promise<void> {
    await sql`
      INSERT INTO deferred_serialized_units
        (tenant_id, configuration_id, inventory_number_id, normalized_payload, reason,
         attempt_count, next_attempt_at, first_deferred_at, last_attempt_at)
      VALUES ('tenant-a', 'cfg-1', ${inventoryNumberId},
        ${JSON.stringify({
          tenantId: 'tenant-a', configurationId: 'cfg-1', inventoryNumberId,
          serialNumber: '   ', itemId: 'item-1',
        })},
        'parent_missing', 1, ${NOW.toISOString()}, ${firstDeferredAt.toISOString()}, ${NOW.toISOString()})
    `.execute(db);
  }

  it('listForRetry separates the corrupt row from the healthy ones instead of dropping it', async () => {
    await repo.upsertDeferred(input(), NOW);
    await insertCorruptRow();

    const page = await repo.listForRetry('tenant-a', 'cfg-1', 10);
    expect(page.units.map(u => u.inventoryNumberId)).toEqual(['inv-1']);
    expect(page.undecodable).toEqual([
      { tenantId: 'tenant-a', configurationId: 'cfg-1', inventoryNumberId: 'inv-CORRUPT', attemptCount: 1 },
    ]);
  });

  it('listDue separates the corrupt row from the healthy ones instead of dropping it', async () => {
    await repo.upsertDeferred(input(), NOW);
    await insertCorruptRow();

    const page = await repo.listDue('tenant-a', 'cfg-1', new Date(NOW.getTime() + 86_400_000), 10);
    expect(page.units.map(u => u.inventoryNumberId)).toEqual(['inv-1']);
    expect(page.undecodable.map(r => r.inventoryNumberId)).toEqual(['inv-CORRUPT']);
  });

  // The identity projection is the whole contract: the reason the row is
  // undecodable is that its payload is malformed, and that column can hold a
  // serial. Reporting the payload to explain a corrupt payload would leak
  // exactly the value the digest exists to keep out of diagnostics.
  it('reports corrupt rows as identity only, never any part of the stored payload', async () => {
    await insertCorruptRow();

    const [reported] = (await repo.listForRetry('tenant-a', 'cfg-1', 10)).undecodable;
    expect(Object.keys(reported).sort()).toEqual([
      'attemptCount', 'configurationId', 'inventoryNumberId', 'tenantId',
    ]);
    expect(JSON.stringify(reported)).not.toContain('item-1');
  });

  // A corrupt row is never drained, so its next_attempt_at stays in the past and
  // it keeps sorting to the front of the oldest-due-first, LIMIT-bounded listDue
  // query. Once `limit` corrupt rows accumulate they occupy every slot of every
  // page forever. The back-off that prevents that now belongs to the caller —
  // this asserts the read itself stays PURE so a dryRun cannot mutate state.
  it('listDue mutates nothing: a repeat read returns the identical page', async () => {
    await insertCorruptRow();
    await repo.upsertDeferred(input(), NOW);
    const later = new Date(NOW.getTime() + 86_400_000);

    const first = await repo.listDue('tenant-a', 'cfg-1', later, 1);
    const second = await repo.listDue('tenant-a', 'cfg-1', later, 1);

    expect(first.units).toEqual([]);
    expect(first.undecodable.map(r => r.inventoryNumberId)).toEqual(['inv-CORRUPT']);
    expect(second).toEqual(first);
  });

  // listForRetry cannot rely on that back-off at all: touchAttempt never moves
  // first_deferred_at, so a corrupt row holds the front of THIS ordering
  // permanently. It scans past corrupt rows instead — without which the design's
  // only operator remedy for a stuck unit returns nothing forever.
  it('listForRetry scans past a page-filling corrupt row to reach the healthy backlog', async () => {
    await insertCorruptRow();
    // Deferred a second later, so the corrupt row is unambiguously the oldest
    // and the ordering cannot decide this test by the tiebreaker instead.
    await repo.upsertDeferred(input(), new Date(NOW.getTime() + 1_000));

    // limit=1 and the corrupt row is the oldest-deferred, so it fills the only
    // slot of the first page.
    const page = await repo.listForRetry('tenant-a', 'cfg-1', 1);
    expect(page.units.map(u => u.inventoryNumberId)).toEqual(['inv-1']);
    expect(page.undecodable.map(r => r.inventoryNumberId)).toEqual(['inv-CORRUPT']);
  });

  // The scan budget is a ROW count, not a page count, and the seek is keyset on
  // BOTH sort columns. Every row here shares one `first_deferred_at` — which is
  // the normal case, since every unit deferred by a single run does — and the
  // healthy row sorts after the corrupt prefix on the tiebreaker alone. That
  // makes the case kill both regressions:
  //
  //  - a page-count bound (5 x `limit`) reaches 5 rows at `limit = 1`, so the
  //    healthy row 250 corrupt rows deep is unreachable and the operator remedy
  //    returns nothing forever;
  //  - a seek on `first_deferred_at` alone cannot advance past a tie at all: it
  //    asks for a STRICTLY later timestamp, so after the first chunk it matches
  //    nothing and the scan ends having silently skipped every remaining row.
  it('scans past a corrupt prefix far larger than the page size to reach the healthy backlog', async () => {
    for (let i = 0; i < 250; i += 1) {
      await insertCorruptRow(`inv-c${String(i).padStart(4, '0')}`, NOW);
    }
    await repo.upsertDeferred(
      input({ normalizedPayload: unit({ inventoryNumberId: 'inv-h1' }) }),
      NOW,
    );

    const page = await repo.listForRetry('tenant-a', 'cfg-1', 1);

    expect(page.units.map(u => u.inventoryNumberId)).toEqual(['inv-h1']);
    // EVERY corrupt row read is reported, not `limit` of them. This ordering is
    // identical on every forced run, so a capped-out row is not deferred to a
    // later call — it is hidden forever, and would never be quarantined,
    // audited, metered, or counted by any run.
    expect(page.undecodable).toHaveLength(250);
    expect(new Set(page.undecodable.map(r => r.inventoryNumberId)).size).toBe(250);
  });

  it('leaves the corrupt row in place so countForConfiguration exposes the divergence', async () => {
    await repo.upsertDeferred(input(), NOW);
    await insertCorruptRow();

    // Rows counted (2) > units returned (1): the operator-visible signal that a
    // row needs manual attention. Durable work is never deleted to make a read
    // succeed.
    expect(await repo.countForConfiguration('tenant-a', 'cfg-1')).toBe(2);
    expect((await repo.listForRetry('tenant-a', 'cfg-1', 10)).units).toHaveLength(1);
  });
});
