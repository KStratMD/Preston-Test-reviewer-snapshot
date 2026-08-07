import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database, DeferredSerializedUnitRow } from '../../database/types';
import type { SerializedUnit } from '../../types/serializedAsset';

/**
 * Durable tenant-scoped deferred-work store for the NetSuite serialized-asset
 * execution profile (Task 2, 2026-07-27 NetSuite serialized-asset sync plan;
 * schema: migration 058). When a NetSuite `inventorynumber` cannot yet be
 * upserted as a Salesforce `Asset` (its parent Product2 hasn't synced yet, or
 * a dependency call failed transiently), the executor defers it here instead
 * of dropping it.
 *
 * Every method is constrained by BOTH `tenant_id` and `configuration_id` — no
 * method may read or write across a tenant boundary (decision 9 of the plan).
 * A row is deleted only after a confirmed Salesforce upsert (`deleteSucceeded`).
 *
 * Privacy (decision 8): `normalized_payload` may carry the serial number — the
 * ONE column in this whole system permitted to. Nothing else here — not the
 * `reason` column (a closed enum, so it structurally cannot), not this class's
 * own error messages — may ever include a field value from that payload. See
 * `decodeNormalizedPayload`'s doc comment.
 */

/**
 * Why a unit is durably owed to Salesforce. A CLOSED enum by design — this value
 * reaches logs, metrics labels and the `reason` column, all of which are
 * decision-8 surfaces, so it structurally cannot carry a serial number.
 *
 * `write_failed` covers the case where the governed upsert itself threw
 * (transient Salesforce failure, governance refusal, connector error). Without
 * it a FRESH unit's write failure left nothing durable while the sweep cursor
 * had already advanced past its window — see the catch in
 * `SerializedAssetSyncService.writeUnit`.
 *
 * Exported as a const tuple, not a bare union, so migration 058's CHECK
 * constraint can be tested against THIS list rather than a hand-copied one.
 * The two must agree exactly: a value the type permits but the CHECK rejects
 * throws at write time — and on Postgres that violation's `DETAIL` embeds the
 * whole failing row, `normalized_payload` included, which is precisely the
 * decision-8 leak this column's closed vocabulary exists to prevent.
 */
export const DEFERRED_SERIALIZED_UNIT_REASONS = [
  'parent_missing',
  'transient_dependency_failure',
  'write_failed',
] as const;

export type DeferredSerializedUnitReason = (typeof DEFERRED_SERIALIZED_UNIT_REASONS)[number];

const DEFERRED_SERIALIZED_UNIT_REASON_SET: ReadonlySet<string> = new Set(DEFERRED_SERIALIZED_UNIT_REASONS);

/** Fixed text (decision 8): names the column, never the rejected value or the payload. */
const REASON_VOCABULARY_ERROR = 'deferred_serialized_units.reason is not in the closed vocabulary';

/**
 * Runtime enforcement of the closed vocabulary, at the boundary. The const
 * tuple and migration 058's CHECK are kept in agreement by a test, but a
 * TYPE is not a runtime guarantee: a JavaScript caller, an `as` cast, or a
 * value round-tripped through `JSON.parse` all reach this method untyped.
 * Letting such a value through would hand the CHECK violation to PostgreSQL,
 * whose error `DETAIL` embeds the ENTIRE failing row — `normalized_payload`,
 * i.e. the serial number, included. Refusing here keeps that leak
 * unreachable regardless of caller discipline.
 */
function assertKnownReason(reason: string): void {
  if (!DEFERRED_SERIALIZED_UNIT_REASON_SET.has(reason)) {
    throw new Error(REASON_VOCABULARY_ERROR);
  }
}

export interface DeferredSerializedUnitInput {
  tenantId: string;
  configurationId: string;
  inventoryNumberId: string;
  normalizedPayload: SerializedUnit;
  reason: DeferredSerializedUnitReason;
}

/** The camelCased view returned by every read method. */
export interface DeferredSerializedUnit {
  tenantId: string;
  configurationId: string;
  inventoryNumberId: string;
  normalizedPayload: SerializedUnit;
  reason: DeferredSerializedUnitReason;
  attemptCount: number;
  nextAttemptAt: string;
  firstDeferredAt: string;
  lastAttemptAt: string;
}

/**
 * Identity-only projection of a row whose stored payload could not be decoded.
 *
 * Deliberately carries NO payload: the whole reason the row is undecodable is
 * that its `normalized_payload` is malformed, and that column can legitimately
 * hold a serial number. The three key components plus the attempt count are
 * everything a caller needs to quarantine, report, and back the row off, and
 * the service digests the key into a `unitRef` before it reaches a failure list
 * or an audit row.
 */
export interface UndecodableDeferredRow {
  tenantId: string;
  configurationId: string;
  inventoryNumberId: string;
  attemptCount: number;
}

/**
 * A listing result that REPORTS corrupt rows instead of silently dropping them.
 *
 * The listings used to skip undecodable rows internally and return only the
 * decoded ones. That hid three separate defects, all of which reduce to the
 * service never learning a row was skipped:
 *
 *  - a corrupt row could never reach the attempt ceiling in
 *    `mergeDeferredRows`, so the one operator-visible "we have given up on this
 *    unit" signal never fired for exactly the rows that most needed it;
 *  - `listDue` grew an internal back-off write to stop corrupt rows occupying
 *    every page, which put a MUTATION inside a read — and that read runs during
 *    `dryRun`, so a preview silently advanced retry state;
 *  - that back-off's failure had to be swallowed to keep the read total, so a
 *    failed housekeeping write restored the stall with no signal at all.
 *
 * Returning them lets the caller decide, using the run context it already has
 * (including `dryRun`), and lets the repository go back to being a pure read.
 */
export interface DeferredSerializedUnitPage {
  units: DeferredSerializedUnit[];
  undecodable: UndecodableDeferredRow[];
}

const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_EXPONENT = 11;

/**
 * Total rows one `listForRetry` call may READ while scanning past corrupt rows.
 * Bounds a pathological corrupt backlog to a degraded remedy rather than an
 * unbounded table walk.
 *
 * Deliberately a ROW budget, not a page count. A page-count bound is defeated
 * by a small `limit`: at `limit = 1`, five pages is five rows, so five corrupt
 * rows at the front of the ordering are enough to make the operator remedy
 * return nothing — permanently, since nothing moves them (see `listForRetry`).
 * A row budget makes the scan's reach independent of the caller's page size.
 *
 * 5,000 is `SerializedAssetSyncService`'s `MAX_UNITS_PER_RUN`, borrowed as a
 * familiar order of magnitude — NOT a shared envelope. This scan is ADDITIVE to
 * the source sweep: the forced-retry route hardcodes `batchSize` 100, so one
 * request can process up to 2,000 fresh units AND scan up to 5,000 deferred
 * rows. (The constants are deliberately not shared either — the service imports
 * this module, so importing back would invert the dependency.)
 *
 * What the comparison does buy, scoped strictly to REMOTE/API work: a corrupt
 * row issues none, while a healthy unit issues a Salesforce PATCH (plus a
 * Product2 lookup, though those are cached per distinct `itemId` per run rather
 * than per unit). In DATABASE work the corrupt row is not obviously cheaper —
 * it costs a serialized SELECT + UPDATE transaction and one audit row with its
 * DLP scan, against a healthy unit's two governance audit rows on the same
 * audit path. And it is not cheaper in wall-clock: healthy units fan out
 * through `p-limit`, while corrupt-row quarantine is sequential and runs before
 * them.
 *
 * The honest summary is that this is row-bounded and light on remote calls, but
 * still a synchronous, serialized, database-heavy workload stacked on top of a
 * full sync. Moving the forced retry off the request path is the real remedy
 * and is tracked separately.
 */
const MAX_RETRY_SCAN_ROWS = 5000;

/**
 * Minimum rows per scan read, so a small `limit` costs proportionally fewer
 * round-trips: at `limit = 1` the scan reads 200 rows per query rather than
 * issuing 5,000 single-row queries to spend the same budget.
 */
const RETRY_SCAN_CHUNK = 200;

/**
 * Deterministic, bounded backoff (plan template, decision-adjacent): 1 minute
 * for the first attempt, doubling per attempt thereafter, capped at 24 hours.
 * `attemptCount` below 1 is treated as 1 (the exponent never goes negative).
 *
 * The exponent cap is 11 rather than 10 so the documented 24h ceiling is
 * actually REACHABLE: at exponent 10 the largest delay is 60s * 2^10 = 17.07h,
 * which `Math.min` never clamps, leaving `MAX_BACKOFF_MS` as dead code and the
 * real ceiling 7 hours below the documented one. At exponent 11 the raw value
 * is 34.13h, so `Math.min` clamps it to exactly 24h and the ceiling becomes the
 * operative bound it was always described as. Growth is therefore: attempt 11
 * -> 17.07h (last uncapped step), attempt 12 and beyond -> 24h.
 */
export function computeDeferredBackoffMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), MAX_BACKOFF_EXPONENT);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent);
}

/**
 * Fixed, content-free error text shared by every normalized_payload rejection
 * path — `decodeNormalizedPayload`'s shape checks AND `upsertDeferred`'s
 * key-match guard below. Never interpolate payload contents into it (decision
 * 8): the payload may legitimately carry a serial number, and this message is
 * the one thing an exception-message audit can't special-case per call site.
 */
const NORMALIZED_PAYLOAD_SHAPE_ERROR = 'deferred_serialized_units.normalized_payload failed shape validation';

/**
 * Narrow runtime decoder for the stored `normalized_payload` column. SQLite
 * always returns the raw TEXT string; PostgreSQL's JSONB driver returns an
 * already-parsed object — both shapes are accepted.
 *
 * Deliberately never includes the input value (or any field extracted from
 * it) in a thrown error message. The payload may legitimately carry a serial
 * number (decision 8's one permitted exception), and this decoder runs on the
 * read path an exception-message audit can't special-case — so its errors
 * must be safe by construction, not by caller discipline.
 */
export function decodeNormalizedPayload(value: unknown): SerializedUnit {
  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(NORMALIZED_PAYLOAD_SHAPE_ERROR);
    }
  } else {
    parsed = value;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(NORMALIZED_PAYLOAD_SHAPE_ERROR);
  }

  const candidate = parsed as Record<string, unknown>;
  const requiredStringFields: (keyof SerializedUnit)[] = [
    'tenantId',
    'configurationId',
    'inventoryNumberId',
    'serialNumber',
    'itemId',
  ];
  for (const field of requiredStringFields) {
    // Blank-ish is a shape failure, not a valid value — the read path must be
    // exactly as strict as the write path. `NetSuiteSerializedUnitReader`'s
    // `normalizeScalar` already refuses a whitespace-only string as
    // `missing_required_field`, so a row that decoded one back would be a
    // `SerializedUnit` the reader could never have produced. It matters most
    // for `inventoryNumberId`, which is BOTH the Salesforce upsert external-ID
    // key (decision 4) and the deferred-work uniqueness key (decision 9): a
    // blank one would collapse distinct units onto a single key and address
    // the wrong Salesforce record. Refused, never trimmed into shape — a
    // corrupted row is not silently repaired.
    const raw = candidate[field];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error(NORMALIZED_PAYLOAD_SHAPE_ERROR);
    }
  }
  if (candidate.status !== undefined && typeof candidate.status !== 'string') {
    throw new Error(NORMALIZED_PAYLOAD_SHAPE_ERROR);
  }
  if (candidate.location !== undefined && typeof candidate.location !== 'string') {
    throw new Error(NORMALIZED_PAYLOAD_SHAPE_ERROR);
  }

  // Decode must reproduce EXACTLY what `NetSuiteSerializedUnitReader` would have
  // produced, not merely something type-compatible with it. The reader trims
  // every accepted scalar and omits a blank optional entirely
  // (`normalizeScalar` + the optional-field handling in `normalizeBatch`), so a
  // decoder that returned raw padded values would hand
  // `SalesforceAssetPayloadBuilder` a `serialNumber` of `' SN-1 '` or a
  // `status` of `'   '` and write that padding straight into Salesforce —
  // reachable because `upsertDeferred` validates key agreement, not the whole
  // payload. Required fields are already proven non-blank above.
  const optional = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  return {
    tenantId: (candidate.tenantId as string).trim(),
    configurationId: (candidate.configurationId as string).trim(),
    inventoryNumberId: (candidate.inventoryNumberId as string).trim(),
    serialNumber: (candidate.serialNumber as string).trim(),
    itemId: (candidate.itemId as string).trim(),
    status: optional(candidate.status),
    location: optional(candidate.location),
  };
}

/** Normalize a Kysely affected-row count (bigint, or undefined on some drivers) to a number. */
function rowCount(n: bigint | undefined): number {
  return Number(n ?? 0n);
}

/** Postgres TIMESTAMPTZ reads can arrive as `Date`; SQLite always returns an ISO string. */
function toIsoString(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/**
 * The row's own `(tenant_id, configuration_id, inventory_number_id)` columns
 * are ALWAYS the authoritative key — never the decoded payload's copies of
 * those same three fields. A stored row can only diverge from its key via
 * something bypassing `upsertDeferred`'s guard (e.g. a hand-written SQL
 * write), but `toView` must not trust the payload even then: overwriting from
 * the row here is what makes a divergent stored row structurally incapable of
 * handing a wrong tenantId to a caller, rather than merely rejecting one at
 * write time.
 */
/**
 * Decodes one row, or returns `undefined` if its stored payload is corrupt.
 *
 * The listing methods MUST NOT propagate a decode failure. `decodeNormalizedPayload`
 * is deliberately strict (it refuses a blank required identifier), and both
 * `listDue` and `listForRetry` decode a whole page — so a single corrupt row
 * would throw out of the listing and take EVERY other deferred unit for that
 * configuration down with it. That failure is permanent: the sync wraps it as a
 * run-stage error but never quarantines, backs off, or deletes the offending
 * row, while the source sweep cursor has already advanced past that window. One
 * bad row would silently stop the configuration from ever draining again.
 *
 * Skipped, never deleted: durable work owed to Salesforce is not destroyed to
 * make a read succeed. The row is instead REPORTED — it comes back in the page's
 * `undecodable` list, and the service turns that into an `undecodable_payload`
 * quarantine. That count is the operator-visible signal, and it needs no logger
 * in this class to surface it.
 *
 * NOT the signal: `countForConfiguration` (which counts ROWS) exceeding the
 * units a listing returns. Every listing is page-bounded, so any backlog larger
 * than `limit` produces that divergence while perfectly healthy.
 */
function toViewOrSkip(row: DeferredSerializedUnitRow): DeferredSerializedUnit | undefined {
  try {
    return toView(row);
  } catch {
    // Deliberately swallows the payload-shape error rather than re-wrapping it:
    // the thrown message is content-free by construction (decision 8), but
    // re-throwing here is exactly what must not happen.
    return undefined;
  }
}

/** Identity + attempt count only — never the payload. See `UndecodableDeferredRow`. */
function toUndecodable(row: DeferredSerializedUnitRow): UndecodableDeferredRow {
  return {
    tenantId: row.tenant_id,
    configurationId: row.configuration_id,
    inventoryNumberId: row.inventory_number_id,
    attemptCount: row.attempt_count,
  };
}

/** Splits one fetched page into decoded units and identity-only corrupt rows. */
function partitionPage(rows: DeferredSerializedUnitRow[]): DeferredSerializedUnitPage {
  const units: DeferredSerializedUnit[] = [];
  const undecodable: UndecodableDeferredRow[] = [];
  for (const row of rows) {
    const view = toViewOrSkip(row);
    if (view) units.push(view);
    else undecodable.push(toUndecodable(row));
  }
  return { units, undecodable };
}

function toView(row: DeferredSerializedUnitRow): DeferredSerializedUnit {
  const decodedPayload = decodeNormalizedPayload(row.normalized_payload);
  return {
    tenantId: row.tenant_id,
    configurationId: row.configuration_id,
    inventoryNumberId: row.inventory_number_id,
    normalizedPayload: {
      ...decodedPayload,
      tenantId: row.tenant_id,
      configurationId: row.configuration_id,
      inventoryNumberId: row.inventory_number_id,
    },
    reason: row.reason,
    attemptCount: row.attempt_count,
    nextAttemptAt: toIsoString(row.next_attempt_at as string | Date),
    firstDeferredAt: toIsoString(row.first_deferred_at as string | Date),
    lastAttemptAt: toIsoString(row.last_attempt_at as string | Date),
  };
}

@injectable()
export class DeferredSerializedUnitRepository {
  private readonly db: Kysely<Database>;

  constructor(@inject(TYPES.DatabaseService) dbService: DatabaseService) {
    this.db = dbService.getDatabase();
  }

  /**
   * Creates a new deferred row on first deferral, or updates the existing row
   * for the same `(tenant_id, configuration_id, inventory_number_id)` key on a
   * repeat deferral (decision 9 — unique by that triple, never duplicated).
   * `attempt_count` increments and `next_attempt_at` advances per
   * `computeDeferredBackoffMs`; `first_deferred_at` is set once and never
   * changes; `last_attempt_at` always reflects `now`. Select-then-write inside
   * a transaction — this store is a bounded per-(tenant, configuration) batch
   * executor, not a multi-writer hot path, so transaction-scoped read-then-
   * write consistency is sufficient (no SELECT ... FOR UPDATE needed).
   *
   * Rejects (before touching the database) when `normalizedPayload`'s own
   * `tenantId`/`configurationId`/`inventoryNumberId` disagree with the row
   * key the caller passed. Without this guard, a caller-side bug could store
   * one tenant's payload under another tenant's key — and since
   * `SerializedUnit` carries its own tenantId, a downstream consumer that
   * (incorrectly) trusts the payload's tenantId over the row's would
   * originate a cross-tenant write from this store. The rejection uses the
   * fixed `NORMALIZED_PAYLOAD_SHAPE_ERROR` text — never the payload's actual
   * values (decision 8).
   *
   * Also rejects (before touching the database) a `reason` outside the closed
   * vocabulary — see `assertKnownReason` for why the TYPE alone is not
   * sufficient protection for a CHECK-constrained column.
   */
  async upsertDeferred(input: DeferredSerializedUnitInput, now: Date): Promise<void> {
    if (
      input.normalizedPayload.tenantId !== input.tenantId ||
      input.normalizedPayload.configurationId !== input.configurationId ||
      input.normalizedPayload.inventoryNumberId !== input.inventoryNumberId
    ) {
      throw new Error(NORMALIZED_PAYLOAD_SHAPE_ERROR);
    }
    assertKnownReason(input.reason);

    const nowIso = now.toISOString();
    const payloadJson = JSON.stringify(input.normalizedPayload);

    await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('deferred_serialized_units')
        .select(['attempt_count', 'first_deferred_at'])
        .where('tenant_id', '=', input.tenantId)
        .where('configuration_id', '=', input.configurationId)
        .where('inventory_number_id', '=', input.inventoryNumberId)
        .executeTakeFirst();

      const attemptCount = existing ? existing.attempt_count + 1 : 1;
      const nextAttemptAt = new Date(now.getTime() + computeDeferredBackoffMs(attemptCount)).toISOString();
      const firstDeferredAt = existing
        ? toIsoString(existing.first_deferred_at as string | Date)
        : nowIso;

      if (existing) {
        await trx
          .updateTable('deferred_serialized_units')
          .set({
            normalized_payload: payloadJson,
            reason: input.reason,
            attempt_count: attemptCount,
            next_attempt_at: nextAttemptAt,
            last_attempt_at: nowIso,
          })
          .where('tenant_id', '=', input.tenantId)
          .where('configuration_id', '=', input.configurationId)
          .where('inventory_number_id', '=', input.inventoryNumberId)
          .execute();
      } else {
        await trx
          .insertInto('deferred_serialized_units')
          .values({
            tenant_id: input.tenantId,
            configuration_id: input.configurationId,
            inventory_number_id: input.inventoryNumberId,
            normalized_payload: payloadJson,
            reason: input.reason,
            attempt_count: attemptCount,
            next_attempt_at: nextAttemptAt,
            first_deferred_at: firstDeferredAt,
            last_attempt_at: nowIso,
          })
          .execute();
      }
    });
  }

  /**
   * Advances ONLY the retry schedule for an existing row: `attempt_count`
   * increments and `next_attempt_at` moves out by `computeDeferredBackoffMs`,
   * exactly as `upsertDeferred` would. `reason`, `normalized_payload`, and
   * `first_deferred_at` are deliberately left untouched.
   *
   * Exists because a deferred unit can reach a terminal NON-success outcome
   * that is not itself a deferral reason — an ambiguous parent, a failed
   * Salesforce upsert, a governance refusal. Without this, `next_attempt_at`
   * stays in the past and `listDue` re-returns the row on every subsequent
   * run forever: a zero-backoff retry storm against the target system, with
   * no attempt ceiling and no give-up signal.
   *
   * Preserving `reason` is the whole point of a separate method rather than a
   * third enum value: `reason` records WHY the unit is waiting (its original
   * dependency gap), and overwriting it with a write-side failure would
   * destroy the only diagnostic an operator has for the backlog — and would
   * require a migration to widen the column's CHECK constraint.
   *
   * Returns the new `attempt_count`, or `null` when no row matched (the unit
   * was never deferred, or a concurrent run already cleared it after a
   * successful upsert — both benign).
   */
  async touchAttempt(
    tenantId: string,
    configurationId: string,
    inventoryNumberId: string,
    now: Date,
  ): Promise<number | null> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('deferred_serialized_units')
        .select(['attempt_count'])
        .where('tenant_id', '=', tenantId)
        .where('configuration_id', '=', configurationId)
        .where('inventory_number_id', '=', inventoryNumberId)
        .executeTakeFirst();

      if (!existing) return null;

      const attemptCount = existing.attempt_count + 1;
      const nextAttemptAt = new Date(now.getTime() + computeDeferredBackoffMs(attemptCount)).toISOString();

      await trx
        .updateTable('deferred_serialized_units')
        .set({
          attempt_count: attemptCount,
          next_attempt_at: nextAttemptAt,
          last_attempt_at: now.toISOString(),
        })
        .where('tenant_id', '=', tenantId)
        .where('configuration_id', '=', configurationId)
        .where('inventory_number_id', '=', inventoryNumberId)
        .execute();

      return attemptCount;
    });
  }

  /**
   * Candidate read — rows due at or before `now`, tenant + configuration
   * scoped, oldest-due-first. A PURE read: it reports corrupt rows to the
   * caller and mutates nothing (see `DeferredSerializedUnitPage`).
   *
   * Corrupt rows must still be backed off by the caller, and this ordering is
   * why: an un-drained row's `next_attempt_at` stays in the past, so it keeps
   * sorting to the FRONT of this oldest-due-first, `LIMIT`-bounded query. Once
   * `limit` corrupt rows accumulate they occupy every slot of every page
   * forever and no healthy unit is ever returned again. Backing them off is
   * sufficient HERE precisely because the ordering key is the one the back-off
   * moves — which is not true of `listForRetry`, see its note.
   */
  async listDue(
    tenantId: string,
    configurationId: string,
    now: Date,
    limit: number,
  ): Promise<DeferredSerializedUnitPage> {
    const safeLimit = boundedLimit(limit);
    if (safeLimit === 0) return { units: [], undecodable: [] };
    const rows = await this.db
      .selectFrom('deferred_serialized_units')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('configuration_id', '=', configurationId)
      .where('next_attempt_at', '<=', now.toISOString())
      .orderBy('next_attempt_at', 'asc')
      .limit(safeLimit)
      .execute();

    return partitionPage(rows);
  }

  /**
   * Forced-retry read: returns rows regardless of `next_attempt_at`, still
   * bounded by `limit` and still scoped to (tenant, configuration). Orders by
   * `first_deferred_at` ascending so a forced retry drains the oldest backlog
   * first and cannot starve early rows behind a large recent batch.
   *
   * Scans PAST corrupt rows instead of letting them consume the page. Backing a
   * corrupt row off — which is what keeps `listDue` unblocked — cannot help
   * here: `touchAttempt` deliberately never moves `first_deferred_at` (that
   * column records when the unit first fell behind and is a diagnostic), so a
   * corrupt row holds its place at the front of THIS ordering permanently.
   * Without the scan, `limit` corrupt rows make the forced retry return nothing
   * forever — and this path is the design's only operator remedy for a stuck
   * unit, so its failure mode is the loss of the escape hatch itself.
   *
   * The scan is KEYSET-paged on `(first_deferred_at, inventory_number_id)`, not
   * OFFSET-paged. Under OFFSET, a row inserted ahead of the window mid-scan
   * shifts every later row right, so the next read re-returns a row already
   * seen AND skips one entirely. Neither is harmless: a repeated healthy unit
   * double-counts `retriesAttempted`, a repeated corrupt row is audited and
   * backed off twice, and a skipped row silently misses the run. Seeking past
   * the last key seen cannot do either. `inventory_number_id` is part of the
   * key, not decoration — `first_deferred_at` ties freely (every unit deferred
   * by one run shares a timestamp), and a keyset seek on a non-unique key
   * loses the tied rows.
   *
   * The scan reads at most `MAX_RETRY_SCAN_ROWS` rows. Beyond that the remedy
   * degrades rather than becoming a table walk: a backlog whose first 5,000
   * rows are ALL corrupt still returns no units. That residual is visible
   * rather than silent — the run reports those corrupt rows as
   * `undecodable_payload` quarantines with zero retries attempted, which is a
   * different signature from an empty backlog. Fully removing it needs the
   * corrupt rows to stop occupying the front of this ordering, which this
   * ordering cannot express: `touchAttempt` deliberately never moves
   * `first_deferred_at`.
   *
   * EVERY corrupt row the scan reads is reported — deliberately uncapped, with
   * `MAX_RETRY_SCAN_ROWS` as the only bound. Capping the report at `limit`
   * looks like the symmetric choice (the units get that bound) and is wrong
   * here, for the same reason the scan exists at all: this ordering never
   * changes between forced runs, so the capped-out rows are not deferred to a
   * later call, they are hidden forever. At `limit = 1` with corrupt rows A and
   * B, every forced retry reports A and no run ever reports B — never
   * quarantined, audited, metered, or counted.
   *
   * The cost that cap was avoiding is real but bounded and proportional: a
   * maximally corrupt backlog makes one forced retry — an explicit operator
   * action — quarantine up to `MAX_RETRY_SCAN_ROWS` rows. Each of those writes
   * also makes progress, since backing a row off is what keeps `listDue`
   * unblocked.
   */
  async listForRetry(
    tenantId: string,
    configurationId: string,
    limit: number,
  ): Promise<DeferredSerializedUnitPage> {
    const safeLimit = boundedLimit(limit);
    if (safeLimit === 0) return { units: [], undecodable: [] };

    const units: DeferredSerializedUnit[] = [];
    const undecodable: UndecodableDeferredRow[] = [];
    const chunk = Math.max(safeLimit, RETRY_SCAN_CHUNK);
    let cursor: { firstDeferredAt: string; inventoryNumberId: string } | undefined;
    let rowsScanned = 0;

    while (units.length < safeLimit && rowsScanned < MAX_RETRY_SCAN_ROWS) {
      const seek = cursor;
      const rows = await this.db
        .selectFrom('deferred_serialized_units')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('configuration_id', '=', configurationId)
        .$if(seek !== undefined, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('first_deferred_at', '>', seek!.firstDeferredAt),
              eb.and([
                eb('first_deferred_at', '=', seek!.firstDeferredAt),
                eb('inventory_number_id', '>', seek!.inventoryNumberId),
              ]),
            ]),
          ),
        )
        .orderBy('first_deferred_at', 'asc')
        .orderBy('inventory_number_id', 'asc')
        .limit(Math.min(chunk, MAX_RETRY_SCAN_ROWS - rowsScanned))
        .execute();
      if (rows.length === 0) break;
      rowsScanned += rows.length;

      const last = rows[rows.length - 1];
      cursor = {
        // The RAW column value, never the ISO-normalized view: it is fed back
        // into a comparison against that same column, so it must stay in
        // whatever domain the driver just handed us.
        //
        // `Database` DECLARES this column `string`, but that is the write-side
        // truth only. The column is TEXT on SQLite and TIMESTAMPTZ on Postgres
        // (migration 058), and node-postgres parses a TIMESTAMPTZ into a JS
        // `Date` on the way out — which is why every read path in this file
        // launders it through `toIsoString(... as string | Date)`. Passing the
        // value straight back is therefore correct in BOTH directions and does
        // not depend on which one it is; converting it to match the declared
        // type would be the bug.
        firstDeferredAt: last.first_deferred_at,
        inventoryNumberId: last.inventory_number_id,
      };

      const partitioned = partitionPage(rows);
      undecodable.push(...partitioned.undecodable);
      for (const unit of partitioned.units) {
        if (units.length >= safeLimit) break;
        units.push(unit);
      }

      // A short read is the end of the backlog — seeking further would only
      // re-query past it.
      if (rows.length < chunk) break;
    }

    return { units, undecodable };
  }

  /** Tenant + configuration scoped delete after a confirmed Salesforce upsert. Returns true iff a row was removed. */
  async deleteSucceeded(tenantId: string, configurationId: string, inventoryNumberId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('deferred_serialized_units')
      .where('tenant_id', '=', tenantId)
      .where('configuration_id', '=', configurationId)
      .where('inventory_number_id', '=', inventoryNumberId)
      .executeTakeFirst();
    return rowCount(result.numDeletedRows) > 0;
  }

  /** Tenant + configuration scoped count of currently-deferred rows. */
  async countForConfiguration(tenantId: string, configurationId: string): Promise<number> {
    const result = await this.db
      .selectFrom('deferred_serialized_units')
      .select(({ fn }) => [fn.countAll<number>().as('count')])
      .where('tenant_id', '=', tenantId)
      .where('configuration_id', '=', configurationId)
      .executeTakeFirst();
    return Number(result?.count ?? 0);
  }
}

/** Clamps a caller-supplied limit to a non-negative integer; SQLite's `LIMIT -1` means "unbounded", so a negative input must never reach the query builder. */
function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor(limit));
}
