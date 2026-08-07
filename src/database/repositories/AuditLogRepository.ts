import { injectable, inject } from 'inversify';
import { randomUUID } from 'crypto';
import type { Kysely } from 'kysely';
import type { DatabaseService } from '../DatabaseService';
import { TYPES } from '../../inversify/types';
import type { Database, AuditLog, NewAuditLog } from '../types';

/** RFC 4122-shaped (8-4-4-4-12 hex) — matches what `crypto.randomUUID()`/`uuidv4()` produce. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts `undefined` because `NewAuditLog.id` is optional: a caller that omits
 * the id entirely is, like a caller supplying a non-UUID id, one whose value
 * cannot be stored in Postgres's UUID column as-is. Both answer `false` here
 * and take the generated-UUID branch, which is exactly the pre-strictNullChecks
 * behaviour (`UUID_SHAPE.test(undefined)` stringified to `"undefined"` and
 * failed the match).
 */
function isUuid(value: string | undefined): boolean {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

export interface AuditLogQueryOptions {
  tenantIds?: string[];
  sessionIds?: string[];
  userIds?: string[];
  actions?: string[];
  startDate?: Date;
  endDate?: Date;
  result?: 'success' | 'failure';
  limit?: number;
  offset?: number;
}

/**
 * Repository for audit log data access
 */
@injectable()
export class AuditLogRepository {
  private readonly db: Kysely<Database>;
  private readonly dbType: 'sqlite' | 'postgres';

  constructor(@inject(TYPES.DatabaseService) databaseService: DatabaseService) {
    this.db = databaseService.getDatabase();
    this.dbType = databaseService.getDbType();
  }

  /**
   * The id an insert actually persists.
   *
   * `NewAuditLog.id` is optional and many callers omit it (the authentication
   * middleware, `ApiKeyService`, `OAuth2Service`, `ErrorHandlingService`).
   * Postgres covers that with `DEFAULT gen_random_uuid()`; SQLite's column is
   * `TEXT PRIMARY KEY` with no default, and SQLite permits NULL in a
   * non-INTEGER primary key — so an omitted id persisted as NULL, silently,
   * for every one of those callers. Those rows are unaddressable by id:
   * `deleteByIds` can never match them, and nothing distinguishes one from
   * another. Synthesizing the id here fixes it for both backends without
   * depending on a column default.
   *
   * A caller-supplied id is otherwise preserved verbatim — except on Postgres
   * when it is not UUID-shaped, which is the substitution the `create` comment
   * describes.
   */
  private resolveInsertId(id: string | undefined): string {
    if (id === undefined) return randomUUID();
    return this.dbType === 'postgres' && !isUuid(id) ? randomUUID() : id;
  }

  /**
   * Create a new audit log entry
   */
  async create(auditLog: NewAuditLog): Promise<AuditLog> {
    const result = await this.db
      .insertInto('audit_logs')
      .values({
        ...auditLog,
        // Migration 006: `audit_logs.id` is UUID on Postgres but TEXT on
        // SQLite. Not every caller's id is UUID-shaped:
        // AuditService.generateAuditId() produces `audit_<timestamp>_<rand>`
        // (pinned by tests/unit/services/ai/AuditServiceExtended.test.ts),
        // which inserted verbatim throws `invalid input syntax for type
        // uuid` on a real Postgres backend (discovered via Task 12's
        // durability suite, the first integration coverage to exercise this
        // write path against real Postgres) — while other callers
        // (SuiteCentralAuditWriter) already pass a real `uuidv4()` id. Only
        // substitute when the caller's id genuinely isn't UUID-shaped, so a
        // caller that DOES supply a valid uuid keeps its own value as the
        // persisted row id rather than having it silently swapped.
        //
        // On Postgres, the id returned to a caller of AuditService's
        // logGovernanceCheck/logDataAccess/etc. (generateAuditId()'s own
        // string) is NOT necessarily the persisted audit_logs.id — that
        // method discards this call's return value entirely and hands its
        // own pre-computed id back instead, and nothing looks up a row by
        // that app-generated id (only by ids already read back from the DB
        // — see `deleteByIds`), so the divergence is safe. SQLite is
        // unaffected either way (its column is TEXT, no shape constraint).
        id: this.resolveInsertId(auditLog.id),
        old_values: this.toDbJson(auditLog.old_values),
        new_values: this.toDbJson(auditLog.new_values),
        details: this.toDbJson(auditLog.details),
        created_at: auditLog.created_at instanceof Date
          ? this.toDbDate(auditLog.created_at)
          : auditLog.created_at ?? this.toDbDate(new Date()),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.normalizeRow(result);
  }

  /**
   * Find audit logs by user ID
   */
  async findByUserId(
    userId: string,
    options?: {
      limit?: number;
      offset?: number;
      since?: Date;
      action?: string;
      resourceType?: string;
    },
  ): Promise<AuditLog[]> {
    let query = this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('user_id', '=', userId);

    if (options?.since) {
      query = query.where('created_at', '>=', this.toDbDate(options.since));
    }

    if (options?.action) {
      query = query.where('action', '=', options.action);
    }

    if (options?.resourceType) {
      query = query.where('resource_type', '=', options.resourceType);
    }

    query = query.orderBy('created_at', 'desc');

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.offset(options.offset);
    }

    const rows = await query.execute();
    return rows.map((row) => this.normalizeRow(row));
  }

  /**
   * Find audit logs by resource
   */
  async findByResource(
    resourceType: string,
    resourceId: string,
    options?: {
      limit?: number;
      offset?: number;
      since?: Date;
    },
  ): Promise<AuditLog[]> {
    let query = this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_type', '=', resourceType)
      .where('resource_id', '=', resourceId);

    if (options?.since) {
      query = query.where('created_at', '>=', this.toDbDate(options.since));
    }

    query = query.orderBy('created_at', 'desc');

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.offset(options.offset);
    }

    const rows = await query.execute();
    return rows.map((row) => this.normalizeRow(row));
  }

  /**
   * Find audit logs by tenant
   */
  async findByTenant(
    tenantId: string,
    options?: {
      limit?: number;
      offset?: number;
      since?: Date;
      action?: string;
    },
  ): Promise<AuditLog[]> {
    let query = this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', tenantId);

    if (options?.since) {
      query = query.where('created_at', '>=', this.toDbDate(options.since));
    }

    if (options?.action) {
      query = query.where('action', '=', options.action);
    }

    query = query.orderBy('created_at', 'desc');

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.offset(options.offset);
    }

    const rows = await query.execute();
    return rows.map((row) => this.normalizeRow(row));
  }

  /**
   * Get audit log statistics
   */
  async getStatistics(
    tenantId?: string,
    since?: Date,
  ): Promise<{
    totalLogs: number;
    actionCounts: Record<string, number>;
    resourceTypeCounts: Record<string, number>;
    userCounts: Record<string, number>;
  }> {
    let baseQuery = this.db.selectFrom('audit_logs');

    if (tenantId) {
      baseQuery = baseQuery.where('tenant_id', '=', tenantId);
    }

    if (since) {
      baseQuery = baseQuery.where('created_at', '>=', this.toDbDate(since));
    }

    // Get total count
    const totalResult = await baseQuery
      .select((eb) => eb.fn.count('id').as('total'))
      .executeTakeFirst();

    // Get action counts
    const actionResults = await baseQuery
      .select(['action', (eb) => eb.fn.count('id').as('count')])
      .groupBy('action')
      .execute();

    // Get resource type counts
    const resourceResults = await baseQuery
      .select(['resource_type', (eb) => eb.fn.count('id').as('count')])
      .groupBy('resource_type')
      .execute();

    // Get user counts
    const userResults = await baseQuery
      .select(['user_id', (eb) => eb.fn.count('id').as('count')])
      .groupBy('user_id')
      .execute();

    return {
      totalLogs: Number(totalResult?.total || 0),
      actionCounts: actionResults.reduce<Record<string, number>>((acc, row) => {
        acc[row.action] = Number(row.count);
        return acc;
      }, {}),
      resourceTypeCounts: resourceResults.reduce<Record<string, number>>((acc, row) => {
        acc[row.resource_type] = Number(row.count);
        return acc;
      }, {}),
      userCounts: userResults.reduce<Record<string, number>>((acc, row) => {
        acc[row.user_id] = Number(row.count);
        return acc;
      }, {}),
    };
  }

  /**
   * Delete old audit logs
   */
  async deleteOldLogs(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    return this.deleteOlderThan(cutoff);
  }

  /**
   * Find audit logs using flexible filter options
   */
  async findByAuditFilters(options: AuditLogQueryOptions): Promise<AuditLog[]> {
    let query = this.db.selectFrom('audit_logs').selectAll();

    if (options.tenantIds?.length) {
      query = query.where('tenant_id', 'in', options.tenantIds);
    }
    if (options.sessionIds?.length) {
      query = query.where('resource_id', 'in', options.sessionIds);
    }
    if (options.userIds?.length) {
      query = query.where('user_id', 'in', options.userIds);
    }
    if (options.actions?.length) {
      query = query.where('action', 'in', options.actions);
    }
    if (options.result) {
      query = query.where('result', '=', options.result);
    }
    if (options.startDate) {
      query = query.where('created_at', '>=', this.toDbDate(options.startDate));
    }
    if (options.endDate) {
      query = query.where('created_at', '<=', this.toDbDate(options.endDate));
    }

    query = query.orderBy('created_at', 'desc');

    if (options.limit !== undefined) {
      query = query.limit(options.limit);
    }
    if (options.offset !== undefined) {
      query = query.offset(options.offset);
    }

    const rows = await query.execute();
    return rows.map((row) => this.normalizeRow(row));
  }

  /**
   * Delete audit logs older than the given cutoff date
   */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('audit_logs')
      .where('created_at', '<', this.toDbDate(cutoff))
      .executeTakeFirst();

    return Number(result.numDeletedRows || 0);
  }

  /**
   * Delete audit logs by their IDs
   */
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const result = await this.db
      .deleteFrom('audit_logs')
      .where('id', 'in', ids)
      .executeTakeFirst();

    return Number(result.numDeletedRows || 0);
  }

  private toDbDate(value: Date): string {
    return value.toISOString();
  }

  private toDbJson(value: object | string | null | undefined): object | string | null {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    return this.dbType === 'sqlite' ? JSON.stringify(value) : value;
  }

  private fromDbJson(value: object | string | null): object | null {
    if (value == null) return null;
    if (typeof value !== 'string') return value as object;
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed !== null && typeof parsed === 'object' ? parsed as object : null;
    } catch {
      return null;
    }
  }

  private normalizeRow(row: AuditLog): AuditLog {
    return {
      ...row,
      old_values: this.fromDbJson(row.old_values),
      new_values: this.fromDbJson(row.new_values),
      details: this.fromDbJson(row.details),
    };
  }
}
