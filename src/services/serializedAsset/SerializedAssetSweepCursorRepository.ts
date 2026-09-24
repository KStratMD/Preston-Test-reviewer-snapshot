import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database } from '../../database/types';

/**
 * Durable source-sweep position for the `netsuite_serialized_asset` execution
 * profile (Task 7 review round 2; schema: migration 059).
 *
 * Without this, every run restarted its source listing at `offset = 0`: the
 * same first window was re-upserted on every run while every row past the
 * sweep bound was never reached by ANY run. `truncated: true` was honest, but
 * its implied remedy ("schedule a follow-up run") made no progress, because the
 * follow-up run swept exactly the same window.
 *
 * Every method is constrained by BOTH `tenant_id` and `configuration_id` —
 * the same discipline as `DeferredSerializedUnitRepository`, and the reason
 * this is a purpose-built table rather than a reuse of `sync_cursors` (which
 * has no tenant column at all). See migration 059's doc comment for the full
 * mechanism comparison.
 *
 * Carries NO unit data — only an integer offset and two timestamps — so it is
 * outside decision 8's blast radius by construction.
 */

/** A negative or non-integer offset would make `list()` skip or repeat rows. */
function sanitizeOffset(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

/**
 * Unique/primary-key-violation codes across the two supported dialects:
 * Postgres SQLSTATE `23505` (unique_violation) and better-sqlite3's
 * `SQLITE_CONSTRAINT_PRIMARYKEY` / `SQLITE_CONSTRAINT_UNIQUE`. Checked by
 * error CODE (not dialect, which this repository doesn't otherwise track)
 * so the retry below fires only for the exact concurrent-insert race it
 * exists to absorb — a connection drop, a CHECK violation, or any other
 * failure should propagate immediately rather than being masked by a blind
 * retry.
 */
const UNIQUE_VIOLATION_CODES = new Set([
  '23505',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_UNIQUE',
]);

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && UNIQUE_VIOLATION_CODES.has(code);
}

@injectable()
export class SerializedAssetSweepCursorRepository {
  private readonly db: Kysely<Database>;

  constructor(@inject(TYPES.DatabaseService) dbService: DatabaseService) {
    this.db = dbService.getDatabase();
  }

  /**
   * The offset the next sweep should resume from. A configuration that has
   * never been swept (no row) starts at the beginning — 0 — which is also what
   * a corrupt/negative stored value degrades to: restarting a sweep is always
   * safe (upserts are idempotent by External ID), whereas trusting a bad offset
   * would silently skip rows.
   */
  async getNextOffset(tenantId: string, configurationId: string): Promise<number> {
    const row = await this.db
      .selectFrom('serialized_asset_sweep_cursors')
      .select(['next_offset'])
      .where('tenant_id', '=', tenantId)
      .where('configuration_id', '=', configurationId)
      .executeTakeFirst();

    return row ? sanitizeOffset(row.next_offset) : 0;
  }

  /**
   * Records where the next sweep resumes. Callers pass 0 to WRAP — i.e. the
   * sweep reached the end of the source, so the next run starts over.
   *
   * Select-then-write inside a transaction, matching
   * `DeferredSerializedUnitRepository.upsertDeferred`. Two overlapping runs
   * for one (tenant, configuration) CAN interleave here: under real
   * concurrency (confirmed against a live PostgreSQL 15 backend by Task 12's
   * durability suite — SQLite's synchronous single-connection driver never
   * exhibits this), both transactions' SELECTs can miss seeing each other's
   * row, so both attempt the INSERT arm and the loser takes an unhandled
   * unique-constraint violation on `(tenant_id, configuration_id)` instead of
   * gracefully falling through to an overwrite. One retry converts that into
   * the UPDATE arm (the winner's row is now visible) — the same fix
   * `SerializedAssetSyncService.persistDeferral` applies to the identical
   * hazard class on `upsertDeferred`. The loser's own position still lands
   * durably; at worst a repeated or skipped window on ONE run, never a
   * permanently unreachable row, because the cursor always keeps advancing
   * and always wraps.
   */
  async setNextOffset(
    tenantId: string,
    configurationId: string,
    nextOffset: number,
    now: Date,
  ): Promise<void> {
    const offset = sanitizeOffset(nextOffset);
    const nowIso = now.toISOString();

    const attemptWrite = (): Promise<void> =>
      this.db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('serialized_asset_sweep_cursors')
          .select(['tenant_id'])
          .where('tenant_id', '=', tenantId)
          .where('configuration_id', '=', configurationId)
          .executeTakeFirst();

        if (existing) {
          await trx
            .updateTable('serialized_asset_sweep_cursors')
            .set({ next_offset: offset, last_swept_at: nowIso, updated_at: nowIso })
            .where('tenant_id', '=', tenantId)
            .where('configuration_id', '=', configurationId)
            .execute();
          return;
        }

        await trx
          .insertInto('serialized_asset_sweep_cursors')
          .values({
            tenant_id: tenantId,
            configuration_id: configurationId,
            next_offset: offset,
            last_swept_at: nowIso,
            updated_at: nowIso,
          })
          .execute();
      });

    try {
      await attemptWrite();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Single retry, ONLY for the exact concurrent-insert race: the
      // concurrent winner's row is now visible, so this second attempt
      // takes the UPDATE arm. Never logged here — a Postgres unique-
      // violation DETAIL can echo bound values, and this table's own
      // columns are non-sensitive (an integer offset + timestamps), but the
      // discipline matches `persistDeferral` regardless.
      await attemptWrite();
    }
  }
}
