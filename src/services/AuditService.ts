import { injectable } from 'inversify';
import { Logger } from '../utils/Logger';
import { uuidv4 } from '../utils/uuid';
import { maskSensitiveData } from '../utils/securityHelpers';

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  result: 'success' | 'failure';
  errorMessage?: string;
  ipAddress?: string;
  userAgent?: string;
  duration?: number;
}

export interface AuditLogFilter {
  userId?: string;
  action?: string;
  resource?: string;
  startDate?: Date;
  endDate?: Date;
  result?: 'success' | 'failure';
  limit?: number;
  offset?: number;
}

/**
 * @deprecated Internal legacy helper retained for compatibility tests only.
 * The production-bound audit service is
 * `src/services/ai/orchestrator/AuditService.ts`, resolved through
 * `TYPES.AuditService` and persisted by PR 4A2. Do not add new production
 * call sites to this in-memory service.
 */
@injectable()
export class AuditService {
  private logs: AuditLogEntry[] = [];
  
  constructor(private readonly logger: Logger) {}
  
  async log(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const auditEntry: AuditLogEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      ...entry
    };
    
    // Store in memory for now (should be persisted to database in production)
    this.logs.push(auditEntry);
    
    // Also log to standard logger (with sensitive data masked)
    this.logger.info('Audit log entry', {
      auditId: auditEntry.id,
      action: auditEntry.action,
      resource: auditEntry.resource,
      result: auditEntry.result,
      userId: auditEntry.userId,
      details: auditEntry.details ? maskSensitiveData(auditEntry.details) : undefined
    });
    
    // In production, this would persist to database
    // await this.persistToDatabase(auditEntry);
  }
  
  async logSuccess(
    action: string,
    resource: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.log({
      action,
      resource,
      details,
      result: 'success'
    });
  }
  
  async logFailure(
    action: string,
    resource: string,
    error: Error | string,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.log({
      action,
      resource,
      details,
      result: 'failure',
      errorMessage: error instanceof Error ? error.message : error
    });
  }
  
  async query(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    let filtered = [...this.logs];
    
    if (filter.userId) {
      filtered = filtered.filter(log => log.userId === filter.userId);
    }
    
    if (filter.action) {
      filtered = filtered.filter(log => log.action === filter.action);
    }
    
    if (filter.resource) {
      filtered = filtered.filter(log => log.resource === filter.resource);
    }
    
    if (filter.result) {
      filtered = filtered.filter(log => log.result === filter.result);
    }
    
    if (filter.startDate) {
      filtered = filtered.filter(log => log.timestamp >= filter.startDate!);
    }
    
    if (filter.endDate) {
      filtered = filtered.filter(log => log.timestamp <= filter.endDate!);
    }
    
    // Sort by timestamp descending
    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    // Apply pagination
    const offset = filter.offset || 0;
    const limit = filter.limit || 100;
    
    return filtered.slice(offset, offset + limit);
  }
  
  async getComplianceReport(startDate: Date, endDate: Date): Promise<{
    totalActions: number;
    successRate: number;
    topUsers: { userId: string; actionCount: number }[];
    topActions: { action: string; count: number }[];
    failuresByResource: Record<string, number>;
  }> {
    const logs = await this.query({ startDate, endDate });
    
    const userActions = new Map<string, number>();
    const actionCounts = new Map<string, number>();
    const failuresByResource: Record<string, number> = {};
    
    let successCount = 0;
    
    for (const log of logs) {
      // Count successes
      if (log.result === 'success') {
        successCount++;
      } else if (log.resource) {
        failuresByResource[log.resource] = (failuresByResource[log.resource] || 0) + 1;
      }
      
      // Count by user
      if (log.userId) {
        userActions.set(log.userId, (userActions.get(log.userId) || 0) + 1);
      }
      
      // Count by action
      actionCounts.set(log.action, (actionCounts.get(log.action) || 0) + 1);
    }
    
    // Get top users
    const topUsers = Array.from(userActions.entries())
      .map(([userId, actionCount]) => ({ userId, actionCount }))
      .sort((a, b) => b.actionCount - a.actionCount)
      .slice(0, 10);
    
    // Get top actions
    const topActions = Array.from(actionCounts.entries())
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    return {
      totalActions: logs.length,
      successRate: logs.length > 0 ? (successCount / logs.length) * 100 : 0,
      topUsers,
      topActions,
      failuresByResource
    };
  }
}