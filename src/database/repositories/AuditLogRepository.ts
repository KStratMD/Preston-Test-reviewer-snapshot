import { injectable, inject } from 'inversify';
import type { Kysely } from 'kysely';
import type { DatabaseService } from '../DatabaseService';
import { TYPES } from '../../inversify/types';
import type { Database, AuditLog, NewAuditLog } from '../types';

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
   * Create a new audit log entry
   */
  async create(auditLog: NewAuditLog): Promise<AuditLog> {
    const result = await this.db
      .insertInto('audit_logs')
      .values({
        ...auditLog,
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
