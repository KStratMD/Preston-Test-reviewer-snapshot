import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import type {
  ConflictHistoryFilters,
  ConflictHistoryPagination,
  ConflictRecordInput,
  ConflictResolution,
  MDMRepository,
} from '../../database/repositories/MDMRepository';

/**
 * MDM Conflict Feedback Service
 *
 * Tracks field-level conflict patterns from MDM operations and provides
 * feedback to AIFieldMappingService to improve future mapping suggestions.
 */

export interface FieldConflictStat {
  fieldName: string;
  sourceSystem: string;
  targetSystem?: string;
  conflictCount: number;
  resolutionCount: number;
  autoResolutionCount: number;
  manualResolutionCount: number;
  autoResolutionRate: number;
  manualResolutionRate: number;
  avgTimeSinceLastConflict: number;
  lastConflictAt: Date;
  commonIssues: string[];
}

export interface ConflictHistoryEntry {
  id?: number;
  fieldName: string;
  sourceA: string;
  sourceB: string;
  valueA: unknown;
  valueB: unknown;
  resolution: ConflictResolution;
  timestamp: Date;
}

export interface ConflictHistoryResult {
  records: ConflictHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
}

export interface ConflictPattern {
  pattern: string;
  description: string;
  affectedFields: string[];
  frequency: number;
  severity: 'low' | 'medium' | 'high';
  recommendation: string;
}

export interface MappingQualityAdjustment {
  fieldName: string;
  confidenceAdjustment: number;
  reason: string;
}

@injectable()
export class MDMFeedbackService {
  private readonly logger: Logger;
  private readonly mdmRepository?: MDMRepository;
  private readonly conflictStats = new Map<string, FieldConflictStat>();
  private conflictHistory: ConflictHistoryEntry[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private lastPurgeAt = 0;

  private static readonly HISTORY_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  private static readonly HISTORY_RETENTION_DAYS = 90;
  private static readonly IN_MEMORY_HISTORY_LIMIT = 1000;
  private static readonly IN_MEMORY_HISTORY_TRIM_TO = 500;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.MDMRepository) @optional() mdmRepository?: MDMRepository,
  ) {
    this.logger = logger;
    this.mdmRepository = mdmRepository;
    this.logger.info('[MDMFeedback] Service initialized', {
      persistenceEnabled: !!mdmRepository,
    });
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.mdmRepository) {
      this.initialized = true;
      return;
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    try {
      const rows = await this.mdmRepository!.listConflictStats();
      this.conflictStats.clear();
      for (const row of rows) {
        const stat = this.rowToStat(row);
        this.conflictStats.set(
          this.statKey(stat.fieldName, stat.sourceSystem, stat.targetSystem),
          stat,
        );
      }
      this.initialized = true;
      this.logger.debug('[MDMFeedback] Conflict stats initialized from DB', {
        statCount: rows.length,
      });
    } catch (error) {
      this.logger.warn('[MDMFeedback] Failed to initialize stats from DB; retrying on next call', {
        error: (error as Error).message,
      });
    }
  }

  async recordConflict(
    fieldName: string,
    sourceSystem: string,
    targetSystem: string,
    valueA: unknown,
    valueB: unknown,
    resolution: ConflictResolution = 'pending',
  ): Promise<void> {
    await this.ensureInitialized();

    const normalizedTarget = this.normalizeTargetSystem(targetSystem);
    const eventTime = new Date();

    if (this.mdmRepository) {
      await this.mdmRepository.recordConflictAtomic(
        fieldName,
        sourceSystem,
        normalizedTarget,
        resolution,
        { valueA, valueB },
      );
      this.maybeScheduleHistoryPurge();
    } else {
      this.pushInMemoryHistory({
        fieldName,
        sourceA: sourceSystem,
        sourceB: normalizedTarget,
        valueA,
        valueB,
        resolution,
        timestamp: eventTime,
      });
    }

    this.applyConflictToCache(
      fieldName,
      sourceSystem,
      normalizedTarget,
      resolution,
      eventTime,
    );

    this.logger.debug('[MDMFeedback] Conflict recorded', {
      fieldName,
      sourceSystem,
      targetSystem: normalizedTarget,
      resolution,
    });
  }

  async recordConflictBatch(records: ConflictRecordInput[]): Promise<void> {
    await this.ensureInitialized();
    if (records.length === 0) return;

    if (this.mdmRepository) {
      await this.mdmRepository.recordConflictBatch(records);
      this.maybeScheduleHistoryPurge();
    }

    // Capture a single timestamp for the whole batch so cache stays consistent
    // with the DB transaction (which uses a single NOW() per statement).
    const batchTime = new Date();
    for (const record of records) {
      const normalizedTarget = this.normalizeTargetSystem(record.targetSystem);
      this.applyConflictToCache(
        record.fieldName,
        record.sourceSystem,
        normalizedTarget,
        record.resolution,
        batchTime,
      );

      if (!this.mdmRepository) {
        this.pushInMemoryHistory({
          fieldName: record.fieldName,
          sourceA: record.sourceSystem,
          sourceB: normalizedTarget,
          valueA: record.valueA,
          valueB: record.valueB,
          resolution: record.resolution,
          timestamp: batchTime,
        });
      }
    }

    this.logger.debug('[MDMFeedback] Conflict batch recorded', { count: records.length });
  }

  async resolveConflict(
    fieldName: string,
    sourceSystem: string,
    targetSystem: string,
    resolution: Exclude<ConflictResolution, 'pending'>,
  ): Promise<void> {
    await this.ensureInitialized();

    const normalizedTarget = this.normalizeTargetSystem(targetSystem);

    if (this.mdmRepository) {
      const updated = await this.mdmRepository.resolveConflictAtomic(
        fieldName,
        sourceSystem,
        normalizedTarget,
        resolution,
      );
      if (!updated) {
        // No matching stat row in DB — skip cache update to stay in sync
        this.logger.warn('[MDMFeedback] resolveConflict: no matching stat row in DB, skipping cache update', {
          fieldName, sourceSystem, targetSystem: normalizedTarget,
        });
        return;
      }
    }

    // Update cache: DB-mode only reaches here when DB row existed;
    // in-memory-only mode always updates cache (no DB to check against)
    const key = this.statKey(fieldName, sourceSystem, normalizedTarget);
    const stat = this.conflictStats.get(key);
    if (!stat) return; // No cached entry to update

    stat.resolutionCount++;
    if (resolution === 'auto') stat.autoResolutionCount++;
    if (resolution === 'manual') stat.manualResolutionCount++;
    this.recomputeRates(stat);

    this.logger.info('[MDMFeedback] Conflict resolved', {
      fieldName,
      sourceSystem,
      targetSystem: normalizedTarget,
      resolution,
      autoRate: stat.autoResolutionRate,
      manualRate: stat.manualResolutionRate,
    });
  }

  async getMappingQualityAdjustments(
    sourceSystem?: string,
    targetSystem?: string,
  ): Promise<MappingQualityAdjustment[]> {
    await this.ensureInitialized();

    const normalizedTarget = targetSystem !== undefined
      ? this.normalizeTargetSystem(targetSystem)
      : undefined;
    const adjustments: MappingQualityAdjustment[] = [];

    for (const stat of this.conflictStats.values()) {
      if (sourceSystem && stat.sourceSystem !== sourceSystem) continue;
      if (normalizedTarget !== undefined && this.normalizeTargetSystem(stat.targetSystem) !== normalizedTarget) {
        continue;
      }

      let adjustment = 1.0;
      let reason = '';

      if (stat.conflictCount > 50) {
        adjustment *= 0.7;
        reason = `High conflict frequency (${stat.conflictCount} conflicts)`;
      } else if (stat.conflictCount > 20) {
        adjustment *= 0.85;
        reason = `Moderate conflict frequency (${stat.conflictCount} conflicts)`;
      } else if (stat.conflictCount > 5) {
        adjustment *= 0.95;
        reason = `Some conflicts detected (${stat.conflictCount} conflicts)`;
      }

      if (stat.manualResolutionRate > 0.5 && stat.resolutionCount >= 3) {
        adjustment *= 0.8;
        reason += `. High manual resolution rate (${Math.round(stat.manualResolutionRate * 100)}%)`;
      }

      if (adjustment < 1.0) {
        adjustments.push({
          fieldName: stat.fieldName,
          confidenceAdjustment: adjustment,
          reason: reason.trim(),
        });
      }
    }

    return adjustments;
  }

  async getFieldStats(fieldName: string): Promise<FieldConflictStat[]> {
    await this.ensureInitialized();
    const stats: FieldConflictStat[] = [];
    for (const stat of this.conflictStats.values()) {
      if (stat.fieldName === fieldName) {
        stats.push({ ...stat, commonIssues: [...stat.commonIssues] });
      }
    }
    return stats;
  }

  async getTopConflictingFields(limit = 10): Promise<FieldConflictStat[]> {
    await this.ensureInitialized();
    return Array.from(this.conflictStats.values())
      .sort((a, b) => b.conflictCount - a.conflictCount)
      .slice(0, limit)
      .map((stat) => ({ ...stat, commonIssues: [...stat.commonIssues] }));
  }

  async analyzeConflictPatterns(): Promise<ConflictPattern[]> {
    await this.ensureInitialized();
    const patterns: ConflictPattern[] = [];

    const emailStats = await this.getFieldStats('email');
    if (emailStats.some((s) => s.conflictCount > 5)) {
      patterns.push({
        pattern: 'email_format_mismatch',
        description: 'Email addresses differ between systems (formatting, case, plus-addressing)',
        affectedFields: ['email', 'emailAddress', 'email_address'],
        frequency: emailStats.reduce((sum, s) => sum + s.conflictCount, 0) / 30,
        severity: 'medium',
        recommendation: 'Apply email normalization before comparison. Consider adding email format transformation.',
      });
    }

    const phoneStats = await this.getFieldStats('phone');
    if (phoneStats.some((s) => s.conflictCount > 5)) {
      patterns.push({
        pattern: 'phone_format_mismatch',
        description: 'Phone numbers differ in format (country codes, dashes, spaces)',
        affectedFields: ['phone', 'telephone', 'phoneNumber', 'mobile'],
        frequency: phoneStats.reduce((sum, s) => sum + s.conflictCount, 0) / 30,
        severity: 'medium',
        recommendation: 'Apply phone normalization. Map to E.164 format before syncing.',
      });
    }

    const addressStats = [
      ...(await this.getFieldStats('address')),
      ...(await this.getFieldStats('address1')),
    ];
    if (addressStats.some((s) => s.conflictCount > 3)) {
      patterns.push({
        pattern: 'address_structure_mismatch',
        description: 'Address components structured differently between systems',
        affectedFields: ['address', 'address1', 'address2', 'city', 'state', 'zip'],
        frequency: addressStats.reduce((sum, s) => sum + s.conflictCount, 0) / 30,
        severity: 'high',
        recommendation: 'Consider address parsing/standardization service. Map individual components rather than concatenated strings.',
      });
    }

    const nameStats = await this.getFieldStats('name');
    if (nameStats.some((s) => s.conflictCount > 5)) {
      patterns.push({
        pattern: 'company_name_variation',
        description: 'Company names differ due to abbreviations, suffixes (Inc, LLC), or formatting',
        affectedFields: ['name', 'companyName', 'company_name', 'businessName'],
        frequency: nameStats.reduce((sum, s) => sum + s.conflictCount, 0) / 30,
        severity: 'medium',
        recommendation: 'Apply company name normalization (remove suffixes, standardize abbreviations).',
      });
    }

    return patterns;
  }

  async getStatistics(): Promise<{
    totalConflicts: number;
    resolvedConflicts: number;
    pendingConflicts: number;
    autoResolutionRate: number;
    topConflictingFields: string[];
    patternCount: number;
  }> {
    await this.ensureInitialized();

    const allStats = Array.from(this.conflictStats.values());
    const totalConflicts = allStats.reduce((sum, s) => sum + s.conflictCount, 0);
    const resolvedConflicts = allStats.reduce((sum, s) => sum + s.resolutionCount, 0);
    const totalAutoResolutions = allStats.reduce((sum, s) => sum + s.autoResolutionCount, 0);
    const autoResolutionRate = resolvedConflicts > 0 ? totalAutoResolutions / resolvedConflicts : 0;
    const topConflictingFields = (await this.getTopConflictingFields(5)).map((s) => s.fieldName);
    const patternCount = (await this.analyzeConflictPatterns()).length;

    return {
      totalConflicts,
      resolvedConflicts,
      pendingConflicts: totalConflicts - resolvedConflicts,
      autoResolutionRate,
      topConflictingFields,
      patternCount,
    };
  }

  async getConflictHistory(
    filters?: ConflictHistoryFilters,
    pagination?: ConflictHistoryPagination,
  ): Promise<ConflictHistoryResult> {
    await this.ensureInitialized();
    const offset = Math.max(0, pagination?.offset ?? 0);
    const limit = Math.max(1, Math.min(500, pagination?.limit ?? 50));

    if (this.mdmRepository) {
      const [rows, total] = await Promise.all([
        this.mdmRepository.listConflictHistory(filters, { offset, limit }),
        this.mdmRepository.countConflictHistory(filters),
      ]);

      return {
        records: rows.map((row) => ({
          id: row.id,
          fieldName: row.field_name,
          sourceA: row.source_a,
          sourceB: row.source_b,
          valueA: row.value_a,
          valueB: row.value_b,
          resolution: row.resolution as ConflictResolution,
          timestamp: this.toDate(row.created_at),
        })),
        total,
        offset,
        limit,
      };
    }

    let filtered = this.conflictHistory.slice();
    if (filters?.fieldName) {
      filtered = filtered.filter((entry) => entry.fieldName === filters.fieldName);
    }
    if (filters?.sourceSystem) {
      filtered = filtered.filter(
        (entry) => entry.sourceA === filters.sourceSystem || entry.sourceB === filters.sourceSystem,
      );
    }
    if (filters?.resolution) {
      filtered = filtered.filter((entry) => entry.resolution === filters.resolution);
    }

    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return {
      records: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
    };
  }

  async clearAll(): Promise<void> {
    if (this.mdmRepository) {
      await this.mdmRepository.deleteAllConflictHistory();
      await this.mdmRepository.deleteAllConflictStats();
    }

    this.conflictStats.clear();
    this.conflictHistory = [];
    // DB mode: set false so next call re-loads from (now-empty) DB via ensureInitialized().
    // In-memory mode: set true — no DB to reload from, cache is already cleared above.
    this.initialized = !this.mdmRepository;
    this.initPromise = null;
    this.lastPurgeAt = 0;
    this.logger.info('[MDMFeedback] All data cleared');
  }

  private applyConflictToCache(
    fieldName: string,
    sourceSystem: string,
    targetSystem: string,
    resolution: ConflictResolution,
    timestamp: Date,
  ): void {
    const key = this.statKey(fieldName, sourceSystem, targetSystem);
    const existing = this.conflictStats.get(key);

    if (existing) {
      if (existing.conflictCount > 0) {
        const deltaMs = Math.max(0, timestamp.getTime() - existing.lastConflictAt.getTime());
        // conflictCount - 1 = number of previously computed intervals
        existing.avgTimeSinceLastConflict = this.updateRollingAverage(
          existing.avgTimeSinceLastConflict,
          existing.conflictCount - 1,
          deltaMs,
        );
      }
      existing.conflictCount++;
      if (resolution !== 'pending') {
        existing.resolutionCount++;
        if (resolution === 'auto') existing.autoResolutionCount++;
        if (resolution === 'manual') existing.manualResolutionCount++;
      }
      existing.lastConflictAt = timestamp;
      this.recomputeRates(existing);
      return;
    }

    const stat: FieldConflictStat = {
      fieldName,
      sourceSystem,
      targetSystem: targetSystem || undefined,
      conflictCount: 1,
      resolutionCount: resolution !== 'pending' ? 1 : 0,
      autoResolutionCount: resolution === 'auto' ? 1 : 0,
      manualResolutionCount: resolution === 'manual' ? 1 : 0,
      autoResolutionRate: 0,
      manualResolutionRate: 0,
      avgTimeSinceLastConflict: 0,
      lastConflictAt: timestamp,
      commonIssues: [],
    };
    this.recomputeRates(stat);
    this.conflictStats.set(key, stat);
  }

  private updateRollingAverage(currentAvg: number, count: number, increment: number): number {
    if (count <= 0) return increment;
    return (currentAvg * count + increment) / (count + 1);
  }

  private recomputeRates(stat: FieldConflictStat): void {
    if (stat.resolutionCount <= 0) {
      stat.autoResolutionRate = 0;
      stat.manualResolutionRate = 0;
      return;
    }
    stat.autoResolutionRate = stat.autoResolutionCount / stat.resolutionCount;
    stat.manualResolutionRate = stat.manualResolutionCount / stat.resolutionCount;
  }

  private maybeScheduleHistoryPurge(): void {
    if (!this.mdmRepository) return;
    const now = Date.now();
    if (now - this.lastPurgeAt < MDMFeedbackService.HISTORY_PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;

    void this.mdmRepository
      .purgeOldHistory(MDMFeedbackService.HISTORY_RETENTION_DAYS)
      .catch((error) => {
        this.logger.warn('[MDMFeedback] Conflict history purge failed', {
          error: (error as Error).message,
        });
      });
  }

  private pushInMemoryHistory(entry: ConflictHistoryEntry): void {
    this.conflictHistory.push(entry);
    if (this.conflictHistory.length > MDMFeedbackService.IN_MEMORY_HISTORY_LIMIT) {
      this.conflictHistory = this.conflictHistory.slice(-MDMFeedbackService.IN_MEMORY_HISTORY_TRIM_TO);
    }
  }

  private statKey(fieldName: string, sourceSystem: string, targetSystem?: string): string {
    return `${fieldName}:${sourceSystem}:${this.normalizeTargetSystem(targetSystem)}`;
  }

  private normalizeTargetSystem(targetSystem?: string): string {
    return targetSystem ?? '';
  }

  private rowToStat(row: {
    field_name: string;
    source_system: string;
    target_system: string;
    conflict_count: number;
    resolution_count: number;
    auto_resolution_count: number;
    manual_resolution_count: number;
    last_conflict_at: Date | string;
    common_issues: unknown;
  }): FieldConflictStat {
    const commonIssues = Array.isArray(row.common_issues)
      ? row.common_issues.filter((v): v is string => typeof v === 'string')
      : [];
    const stat: FieldConflictStat = {
      fieldName: row.field_name,
      sourceSystem: row.source_system,
      targetSystem: row.target_system || undefined,
      conflictCount: row.conflict_count,
      resolutionCount: row.resolution_count,
      autoResolutionCount: row.auto_resolution_count,
      manualResolutionCount: row.manual_resolution_count,
      autoResolutionRate: 0,
      manualResolutionRate: 0,
      // Session-only metric: not persisted to DB. Resets to 0 on service restart;
      // only accumulates timing intervals for conflicts recorded while the service is running.
      avgTimeSinceLastConflict: 0,
      lastConflictAt: this.toDate(row.last_conflict_at),
      commonIssues,
    };
    this.recomputeRates(stat);
    return stat;
  }

  private toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }
}
