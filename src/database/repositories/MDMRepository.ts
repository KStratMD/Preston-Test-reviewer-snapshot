import { injectable, inject } from 'inversify';
import { sql } from 'kysely';
import type { Kysely, Transaction, Updateable } from 'kysely';
import type { DatabaseService } from '../DatabaseService';
import { TYPES } from '../../inversify/types';
import type {
  Database,
  MDMGoldenRecordsTable,
  MDMGoldenRecordRow,
  NewMDMGoldenRecord,
  MDMGoldenRecordUpdate,
  MDMEntitySourceRow,
  NewMDMEntitySource,
  MDMSyncRequestsTable,
  MDMSyncRequestRow,
  NewMDMSyncRequest,
  MDMSyncRequestUpdate,
  MDMSurvivorshipRuleRow,
  NewMDMSurvivorshipRule,
  MDMConflictStatRow,
  MDMConflictHistoryRow,
} from '../types';

/**
 * Parse a JSON field from the database.
 * SQLite returns TEXT (string), PostgreSQL returns parsed objects for JSONB.
 */
function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

/**
 * Convert a Date to ISO string for SQLite compatibility.
 * SQLite only binds numbers, strings, bigints, buffers, and null.
 */
function dateToStr(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

export type ConflictResolution = 'auto' | 'manual' | 'pending';

export interface ConflictStatFilters {
  fieldName?: string;
  sourceSystem?: string;
}

export interface ConflictHistoryFilters {
  fieldName?: string;
  sourceSystem?: string;
  resolution?: ConflictResolution;
}

export interface ConflictHistoryPagination {
  offset?: number;
  limit?: number;
}

export interface ConflictRecordInput {
  fieldName: string;
  sourceSystem: string;
  targetSystem?: string;
  valueA: unknown;
  valueB: unknown;
  resolution: ConflictResolution;
}

/**
 * Repository for MDM data access — golden records, entity sources, and sync requests.
 */
@injectable()
export class MDMRepository {
  private readonly db: Kysely<Database>;

  constructor(@inject(TYPES.DatabaseService) databaseService: DatabaseService) {
    this.db = databaseService.getDatabase();
  }

  // ── Golden Records ───────────────────────────────────────────────

  async createGoldenRecord(record: NewMDMGoldenRecord): Promise<MDMGoldenRecordRow> {
    const now = dateToStr(new Date());
    const result = await this.db
      .insertInto('mdm_golden_records')
      .values({
        ...record,
        data: JSON.stringify(record.data),
        conflicts: JSON.stringify(record.conflicts),
        approved_at: record.approved_at ? dateToStr(record.approved_at) : null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.hydrateGoldenRecord(result);
  }

  async findGoldenRecordById(id: string): Promise<MDMGoldenRecordRow | null> {
    const result = await this.db
      .selectFrom('mdm_golden_records')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return result ? this.hydrateGoldenRecord(result) : null;
  }

  async listGoldenRecords(filters?: {
    entityType?: string;
    status?: string;
    hasConflicts?: boolean;
  }): Promise<MDMGoldenRecordRow[]> {
    let query = this.db
      .selectFrom('mdm_golden_records')
      .selectAll();

    if (filters?.entityType) {
      query = query.where('entity_type', '=', filters.entityType);
    }
    if (filters?.status) {
      query = query.where('status', '=', filters.status);
    }
    if (filters?.hasConflicts === true) {
      query = query.where('conflict_count', '>', 0);
    } else if (filters?.hasConflicts === false) {
      query = query.where('conflict_count', '=', 0);
    }

    const rows = await query.execute();
    return rows.map((r) => this.hydrateGoldenRecord(r));
  }

  async updateGoldenRecord(id: string, updates: MDMGoldenRecordUpdate): Promise<MDMGoldenRecordRow> {
    const toSet: Updateable<MDMGoldenRecordsTable> = { ...updates, updated_at: dateToStr(new Date()) };
    if (updates.data !== undefined) {
      toSet.data = JSON.stringify(updates.data);
    }
    if (updates.conflicts !== undefined) {
      toSet.conflicts = JSON.stringify(updates.conflicts);
    }
    if (updates.approved_at !== undefined) {
      toSet.approved_at = updates.approved_at ? dateToStr(updates.approved_at) : null;
    }

    const result = await this.db
      .updateTable('mdm_golden_records')
      .set(toSet)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.hydrateGoldenRecord(result);
  }

  /**
   * Atomic: insert golden record + sources in a single transaction.
   */
  async createGoldenRecordWithSources(
    record: NewMDMGoldenRecord,
    sources: NewMDMEntitySource[],
  ): Promise<MDMGoldenRecordRow> {
    return this.db.transaction().execute(async (trx) => {
      const now = dateToStr(new Date());
      const grResult = await trx
        .insertInto('mdm_golden_records')
        .values({
          ...record,
          data: JSON.stringify(record.data),
          conflicts: JSON.stringify(record.conflicts),
          approved_at: record.approved_at ? dateToStr(record.approved_at) : null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      for (const source of sources) {
        await trx
          .insertInto('mdm_entity_sources')
          .values({
            ...source,
            source_data: JSON.stringify(source.source_data),
            last_synced_at: dateToStr(source.last_synced_at),
            golden_record_id: grResult.id,
            created_at: now,
          })
          .execute();
      }

      return this.hydrateGoldenRecord(grResult);
    });
  }

  // ── Entity Sources ───────────────────────────────────────────────

  async findSourcesByGoldenRecordId(goldenRecordId: string): Promise<MDMEntitySourceRow[]> {
    const rows = await this.db
      .selectFrom('mdm_entity_sources')
      .selectAll()
      .where('golden_record_id', '=', goldenRecordId)
      .execute();

    return rows.map((r) => this.hydrateEntitySource(r));
  }

  /**
   * Batch-load sources for multiple golden records in a single query.
   * Returns a Map keyed by golden_record_id for O(1) lookup.
   */
  async findSourcesByGoldenRecordIds(ids: string[]): Promise<Map<string, MDMEntitySourceRow[]>> {
    if (ids.length === 0) return new Map();

    const rows = await this.db
      .selectFrom('mdm_entity_sources')
      .selectAll()
      .where('golden_record_id', 'in', ids)
      .execute();

    const map = new Map<string, MDMEntitySourceRow[]>();
    for (const row of rows) {
      const hydrated = this.hydrateEntitySource(row);
      const existing = map.get(row.golden_record_id) || [];
      existing.push(hydrated);
      map.set(row.golden_record_id, existing);
    }
    return map;
  }

  // ── Sync Requests ────────────────────────────────────────────────

  async createSyncRequest(request: NewMDMSyncRequest): Promise<MDMSyncRequestRow> {
    const now = dateToStr(new Date());
    const result = await this.db
      .insertInto('mdm_sync_requests')
      .values({
        ...request,
        target_systems: JSON.stringify(request.target_systems),
        reviewed_at: request.reviewed_at ? dateToStr(request.reviewed_at) : null,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.hydrateSyncRequest(result);
  }

  async findSyncRequestById(id: string): Promise<MDMSyncRequestRow | null> {
    const result = await this.db
      .selectFrom('mdm_sync_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return result ? this.hydrateSyncRequest(result) : null;
  }

  async findPendingSyncRequests(): Promise<MDMSyncRequestRow[]> {
    const rows = await this.db
      .selectFrom('mdm_sync_requests')
      .selectAll()
      .where('status', '=', 'pending')
      .execute();

    return rows.map((r) => this.hydrateSyncRequest(r));
  }

  async updateSyncRequest(id: string, updates: MDMSyncRequestUpdate): Promise<MDMSyncRequestRow> {
    const toSet: Updateable<MDMSyncRequestsTable> = { ...updates };
    if (updates.target_systems !== undefined) {
      toSet.target_systems = JSON.stringify(updates.target_systems);
    }
    if (updates.reviewed_at !== undefined) {
      toSet.reviewed_at = updates.reviewed_at ? dateToStr(updates.reviewed_at) : null;
    }

    const result = await this.db
      .updateTable('mdm_sync_requests')
      .set(toSet)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.hydrateSyncRequest(result);
  }

  /**
   * Atomic approve: UPDATE ... WHERE id = ? AND status = 'pending'.
   * Returns null if no row matched (already approved/rejected or not found).
   */
  async approveSyncRequest(
    id: string,
    reviewedBy: string,
    reviewedAt: Date,
  ): Promise<MDMSyncRequestRow | null> {
    const result = await this.db
      .updateTable('mdm_sync_requests')
      .set({
        status: 'approved',
        reviewed_by: reviewedBy,
        reviewed_at: dateToStr(reviewedAt),
      })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();

    return result ? this.hydrateSyncRequest(result) : null;
  }

  // ── Survivorship Rules ─────────────────────────────────────────────

  async listSurvivorshipRules(entityType?: string): Promise<MDMSurvivorshipRuleRow[]> {
    let query = this.db
      .selectFrom('mdm_survivorship_rules')
      .selectAll()
      .orderBy('priority', 'asc');

    if (entityType) {
      query = query.where((eb) =>
        eb.or([
          eb('entity_type', '=', entityType),
          eb('entity_type', '=', '*'),
        ])
      );
    }

    const rows = await query.execute();
    return rows.map((r) => this.hydrateSurvivorshipRule(r));
  }

  async findSurvivorshipRuleById(id: string): Promise<MDMSurvivorshipRuleRow | null> {
    const result = await this.db
      .selectFrom('mdm_survivorship_rules')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return result ? this.hydrateSurvivorshipRule(result) : null;
  }

  async upsertSurvivorshipRule(rule: NewMDMSurvivorshipRule): Promise<MDMSurvivorshipRuleRow> {
    const now = dateToStr(new Date());
    const result = await this.db
      .insertInto('mdm_survivorship_rules')
      .values({
        ...rule,
        config: JSON.stringify(rule.config),
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          entity_type: rule.entity_type,
          field_name: rule.field_name,
          strategy: rule.strategy,
          config: JSON.stringify(rule.config),
          priority: rule.priority,
          is_default: rule.is_default,
          updated_at: now,
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.hydrateSurvivorshipRule(result);
  }

  async deleteSurvivorshipRule(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('mdm_survivorship_rules')
      .where('id', '=', id)
      .where('is_default', '=', 0)
      .executeTakeFirst();

    return BigInt(result.numDeletedRows) > 0n;
  }

  // ── Conflict Stats & History ──────────────────────────────────────

  async recordConflictAtomic(
    fieldName: string,
    sourceSystem: string,
    targetSystem: string | undefined,
    resolution: ConflictResolution,
    historyRecord: { valueA: unknown; valueB: unknown },
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.recordConflictAtomicTx(
        trx,
        fieldName,
        sourceSystem,
        targetSystem,
        resolution,
        historyRecord,
      );
    });
  }

  async recordConflictBatch(records: ConflictRecordInput[]): Promise<void> {
    if (records.length === 0) return;

    await this.db.transaction().execute(async (trx) => {
      for (const record of records) {
        await this.recordConflictAtomicTx(
          trx,
          record.fieldName,
          record.sourceSystem,
          record.targetSystem,
          record.resolution,
          { valueA: record.valueA, valueB: record.valueB },
        );
      }
    });
  }

  async resolveConflictAtomic(
    fieldName: string,
    sourceSystem: string,
    targetSystem: string | undefined,
    resolution: Exclude<ConflictResolution, 'pending'>,
  ): Promise<boolean> {
    const now = dateToStr(new Date());
    const normalizedTarget = this.normalizeTargetSystem(targetSystem);
    const autoIncrement = resolution === 'auto' ? 1 : 0;
    const manualIncrement = resolution === 'manual' ? 1 : 0;

    const result = await this.db
      .updateTable('mdm_conflict_stats')
      .set({
        resolution_count: sql<number>`resolution_count + 1` as any,
        auto_resolution_count: sql<number>`auto_resolution_count + ${autoIncrement}` as any,
        manual_resolution_count: sql<number>`manual_resolution_count + ${manualIncrement}` as any,
        updated_at: now as any,
      })
      .where('field_name', '=', fieldName)
      .where('source_system', '=', sourceSystem)
      .where('target_system', '=', normalizedTarget)
      .executeTakeFirst();

    return BigInt(result.numUpdatedRows) > 0n;
  }

  async listConflictStats(filters?: ConflictStatFilters): Promise<MDMConflictStatRow[]> {
    let query = this.db
      .selectFrom('mdm_conflict_stats')
      .selectAll()
      .orderBy('conflict_count', 'desc');

    if (filters?.fieldName) {
      query = query.where('field_name', '=', filters.fieldName);
    }
    if (filters?.sourceSystem) {
      query = query.where('source_system', '=', filters.sourceSystem);
    }

    const rows = await query.execute();
    return rows.map((r) => this.hydrateConflictStat(r));
  }

  async listConflictHistory(
    filters?: ConflictHistoryFilters,
    pagination?: ConflictHistoryPagination,
  ): Promise<MDMConflictHistoryRow[]> {
    const limit = Math.max(1, Math.min(500, pagination?.limit ?? 50));
    const offset = Math.max(0, pagination?.offset ?? 0);

    let query = this.db
      .selectFrom('mdm_conflict_history')
      .selectAll()
      .orderBy('created_at', 'desc');

    if (filters?.fieldName) {
      query = query.where('field_name', '=', filters.fieldName);
    }
    if (filters?.sourceSystem) {
      query = query.where((eb) =>
        eb.or([
          eb('source_a', '=', filters.sourceSystem!),
          eb('source_b', '=', filters.sourceSystem!),
        ])
      );
    }
    if (filters?.resolution) {
      query = query.where('resolution', '=', filters.resolution);
    }

    const rows = await query
      .offset(offset)
      .limit(limit)
      .execute();

    return rows.map((r) => this.hydrateConflictHistory(r));
  }

  async countConflictHistory(filters?: ConflictHistoryFilters): Promise<number> {
    let query = this.db
      .selectFrom('mdm_conflict_history')
      .select((eb) => eb.fn.countAll<number>().as('count'));

    if (filters?.fieldName) {
      query = query.where('field_name', '=', filters.fieldName);
    }
    if (filters?.sourceSystem) {
      query = query.where((eb) =>
        eb.or([
          eb('source_a', '=', filters.sourceSystem!),
          eb('source_b', '=', filters.sourceSystem!),
        ])
      );
    }
    if (filters?.resolution) {
      query = query.where('resolution', '=', filters.resolution);
    }

    const result = await query.executeTakeFirstOrThrow();
    return Number(result.count ?? 0);
  }

  async deleteAllConflictStats(): Promise<void> {
    await this.db.deleteFrom('mdm_conflict_stats').execute();
  }

  async deleteAllConflictHistory(): Promise<void> {
    await this.db.deleteFrom('mdm_conflict_history').execute();
  }

  async purgeOldHistory(retentionDays: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const cutoff = dateToStr(cutoffDate);
    const result = await this.db
      .deleteFrom('mdm_conflict_history')
      .where('created_at', '<', cutoff)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  private async recordConflictAtomicTx(
    trx: Transaction<Database>,
    fieldName: string,
    sourceSystem: string,
    targetSystem: string | undefined,
    resolution: ConflictResolution,
    historyRecord: { valueA: unknown; valueB: unknown },
  ): Promise<void> {
    const now = dateToStr(new Date());
    const normalizedTarget = this.normalizeTargetSystem(targetSystem);
    const resolutionIncrement = resolution === 'pending' ? 0 : 1;
    const autoIncrement = resolution === 'auto' ? 1 : 0;
    const manualIncrement = resolution === 'manual' ? 1 : 0;

    await trx
      .insertInto('mdm_conflict_stats')
      .values({
        field_name: fieldName,
        source_system: sourceSystem,
        target_system: normalizedTarget,
        conflict_count: 1,
        resolution_count: resolutionIncrement,
        auto_resolution_count: autoIncrement,
        manual_resolution_count: manualIncrement,
        last_conflict_at: now,
        common_issues: JSON.stringify([]),
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['field_name', 'source_system', 'target_system']).doUpdateSet({
          conflict_count: sql<number>`mdm_conflict_stats.conflict_count + 1` as any,
          resolution_count: sql<number>`mdm_conflict_stats.resolution_count + ${resolutionIncrement}` as any,
          auto_resolution_count: sql<number>`mdm_conflict_stats.auto_resolution_count + ${autoIncrement}` as any,
          manual_resolution_count: sql<number>`mdm_conflict_stats.manual_resolution_count + ${manualIncrement}` as any,
          last_conflict_at: now as any,
          updated_at: now as any,
        })
      )
      .execute();

    await trx
      .insertInto('mdm_conflict_history')
      .values({
        field_name: fieldName,
        source_a: sourceSystem,
        source_b: normalizedTarget,
        value_a: this.toJsonString(historyRecord.valueA),
        value_b: this.toJsonString(historyRecord.valueB),
        resolution,
        created_at: now,
      })
      .execute();
  }

  // ── Hydration helpers (JSON parse for SQLite/PG portability) ─────

  private hydrateGoldenRecord(row: MDMGoldenRecordRow): MDMGoldenRecordRow {
    return {
      ...row,
      data: parseJson<object>(row.data),
      conflicts: parseJson<object>(row.conflicts),
    };
  }

  private hydrateEntitySource(row: MDMEntitySourceRow): MDMEntitySourceRow {
    return {
      ...row,
      source_data: parseJson<object>(row.source_data),
    };
  }

  private hydrateSyncRequest(row: MDMSyncRequestRow): MDMSyncRequestRow {
    return {
      ...row,
      target_systems: parseJson<object>(row.target_systems),
    };
  }

  private hydrateSurvivorshipRule(row: MDMSurvivorshipRuleRow): MDMSurvivorshipRuleRow {
    return {
      ...row,
      config: parseJson<object>(row.config),
    };
  }

  private hydrateConflictStat(row: MDMConflictStatRow): MDMConflictStatRow {
    return {
      ...row,
      common_issues: parseJson<object>(row.common_issues),
    };
  }

  private hydrateConflictHistory(row: MDMConflictHistoryRow): MDMConflictHistoryRow {
    return {
      ...row,
      value_a: parseJson<unknown>(row.value_a),
      value_b: parseJson<unknown>(row.value_b),
    };
  }

  private normalizeTargetSystem(targetSystem?: string): string {
    return targetSystem ?? '';
  }

  private toJsonString(value: unknown): string {
    try {
      return JSON.stringify(value ?? null);
    } catch {
      return JSON.stringify(String(value));
    }
  }
}
