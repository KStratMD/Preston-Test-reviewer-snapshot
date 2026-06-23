import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { AuthService } from './AuthService';
import type { TransformationEngine } from './TransformationEngine';
import type { TelemetryService } from './TelemetryService';
import { CryptoUtils } from '../utils/crypto';

export interface MigrationPlan {
  id: string;
  name: string;
  description: string;
  sourceSystem: string;
  targetSystem: string;
  status: 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
  estimatedDuration?: number;
  totalRecords?: number;
  processedRecords: number;
  successfulRecords: number;
  failedRecords: number;
  currentPhase?: string;
  phases: MigrationPhase[];
  mappings: FieldMapping[];
  validationRules: ValidationRule[];
  rollbackPlan?: RollbackPlan;
  schedule?: MigrationSchedule;
}

export interface MigrationPhase {
  id: string;
  name: string;
  description: string;
  order: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  entityType: string;
  dependsOn?: string[];
  parallelizable: boolean;
  batchSize: number;
  estimatedRecords: number;
  processedRecords: number;
  startTime?: Date;
  endTime?: Date;
  configuration: PhaseConfiguration;
}

export interface PhaseConfiguration {
  extractionQuery?: string;
  transformationRules?: unknown[];
  validationRules?: unknown[];
  loadOptions?: {
    mode: 'insert' | 'upsert' | 'merge';
    conflictResolution: 'skip' | 'overwrite' | 'merge';
    enableReferentialIntegrity: boolean;
  };
}

export interface FieldMapping {
  sourceField: string;
  targetField: string;
  transformationType: 'direct' | 'lookup' | 'calculation' | 'concatenation' | 'conditional';
  transformationValue?: string;
  isRequired: boolean;
  validation?: string;
  defaultValue?: unknown;
}

export interface ValidationRule {
  id: string;
  name: string;
  field: string;
  type: 'required' | 'format' | 'range' | 'custom';
  rule: string;
  errorMessage: string;
}

export interface RollbackPlan {
  enabled: boolean;
  backupLocation: string;
  rollbackSteps: RollbackStep[];
  autoRollbackTriggers: string[];
}

export interface RollbackStep {
  order: number;
  action: 'restore_backup' | 'delete_records' | 'execute_script';
  description: string;
  configuration: unknown;
}

export interface MigrationSchedule {
  type: 'immediate' | 'scheduled' | 'recurring';
  startTime?: Date;
  maintenanceWindow?: {
    start: string; // HH:MM format
    end: string;   // HH:MM format
    timezone: string;
  };
  notifications: NotificationConfig[];
}

export interface NotificationConfig {
  type: 'email' | 'webhook' | 'slack';
  recipients: string[];
  events: ('started' | 'completed' | 'failed' | 'progress')[];
  configuration: unknown;
}

export interface MigrationProgress {
  planId: string;
  status: string;
  currentPhase?: string;
  overallProgress: number;
  phaseProgress: number;
  startTime?: Date;
  estimatedCompletion?: Date;
  recordsPerSecond: number;
  errors: MigrationError[];
  warnings: MigrationWarning[];
  metadata: {
    dataQualityScore: number;
    referentialIntegrityScore: number;
    transformationAccuracy: number;
    estimatedTimeRemaining: number;
  };
}

export interface MigrationError {
  id: string;
  timestamp: Date;
  phase: string;
  recordId?: string;
  errorType: 'extraction' | 'transformation' | 'validation' | 'loading' | 'system';
  errorMessage: string;
  errorCode?: string;
  context: unknown;
  severity: 'low' | 'medium' | 'high' | 'critical';
  resolution?: string;
}

export interface MigrationWarning {
  id: string;
  timestamp: Date;
  phase: string;
  recordId?: string;
  warningType: string;
  message: string;
  impact: 'none' | 'low' | 'medium' | 'high';
}

export interface DataQualityReport {
  planId: string;
  timestamp: Date;
  overallScore: number;
  metrics: {
    completeness: number;
    accuracy: number;
    consistency: number;
    validity: number;
    uniqueness: number;
  };
  issues: DataQualityIssue[];
  recommendations: string[];
}

export interface DataQualityIssue {
  field: string;
  issueType: 'missing_data' | 'invalid_format' | 'duplicate' | 'inconsistent' | 'out_of_range';
  severity: 'low' | 'medium' | 'high' | 'critical';
  count: number;
  examples: unknown[];
  suggestedFix: string;
}

/**
 * Data Migration Accelerator service for efficient bulk data migration
 * between business systems with progress tracking and quality assurance
 */
@injectable()
export class DataMigrationAccelerator {
  private activeMigrations = new Map<string, MigrationProgress>();
  private migrationPlans = new Map<string, MigrationPlan>();

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.AuthService) private authService: AuthService,
    @inject(TYPES.TransformationEngine) private transformationEngine: TransformationEngine,
    @inject(TYPES.TelemetryService) private telemetryService: TelemetryService,
  ) {
    this.logger.info('DataMigrationAccelerator initialized');
  }

  /**
   * Create a new migration plan
   */
  async createMigrationPlan(planData: Omit<MigrationPlan, 'id' | 'createdAt' | 'updatedAt' | 'processedRecords' | 'successfulRecords' | 'failedRecords'>): Promise<MigrationPlan> {
    try {
      const plan: MigrationPlan = {
        id: CryptoUtils.generateUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        processedRecords: 0,
        successfulRecords: 0,
        failedRecords: 0,
        ...planData,
      };

      // Validate the plan
      await this.validateMigrationPlan(plan);

      this.migrationPlans.set(plan.id, plan);

      this.logger.info('Migration plan created', {
        planId: plan.id,
        name: plan.name,
        sourceSystem: plan.sourceSystem,
        targetSystem: plan.targetSystem,
        phaseCount: plan.phases.length,
      });

      await this.telemetryService.recordEvent({
        id: CryptoUtils.generateUUID(),
        type: 'MigrationJobStarted',
        timestamp: Date.now(),
        jobId: plan.id,
        flowId: plan.id,
        totalRecords: plan.totalRecords || 0,
        estimatedDurationMs: plan.estimatedDuration || 0,
        metadata: { 
          sourceSystem: plan.sourceSystem,
          targetSystem: plan.targetSystem,
          phaseCount: plan.phases.length 
        }
      });

      return plan;
    } catch (error) {
      this.logger.error('Failed to create migration plan', { error });
      throw error;
    }
  }

  /**
   * Get migration plan by ID
   */
  async getMigrationPlan(planId: string): Promise<MigrationPlan | null> {
    return this.migrationPlans.get(planId) || null;
  }

  /**
   * List all migration plans
   */
  async listMigrationPlans(): Promise<MigrationPlan[]> {
    return Array.from(this.migrationPlans.values());
  }

  /**
   * Update migration plan
   */
  async updateMigrationPlan(planId: string, updates: Partial<MigrationPlan>): Promise<MigrationPlan> {
    const plan = this.migrationPlans.get(planId);
    if (!plan) {
      throw new Error(`Migration plan ${planId} not found`);
    }

    const updatedPlan = {
      ...plan,
      ...updates,
      updatedAt: new Date(),
    };

    await this.validateMigrationPlan(updatedPlan);
    this.migrationPlans.set(planId, updatedPlan);

    this.logger.info('Migration plan updated', { planId, updates: Object.keys(updates) });
    return updatedPlan;
  }

  /**
   * Start migration execution
   */
  async startMigration(planId: string): Promise<MigrationProgress> {
    try {
      const plan = this.migrationPlans.get(planId);
      if (!plan) {
        throw new Error(`Migration plan ${planId} not found`);
      }

      if (plan.status !== 'ready') {
        throw new Error(`Migration plan ${planId} is not ready to start`);
      }

      // Initialize progress tracking
      const progress: MigrationProgress = {
        planId,
        status: 'running',
        overallProgress: 0,
        phaseProgress: 0,
        startTime: new Date(),
        recordsPerSecond: 0,
        errors: [],
        warnings: [],
        metadata: {
          dataQualityScore: 0,
          referentialIntegrityScore: 0,
          transformationAccuracy: 0,
          estimatedTimeRemaining: 0,
        },
      };

      this.activeMigrations.set(planId, progress);
      
      // Update plan status
      plan.status = 'running';
      this.migrationPlans.set(planId, plan);

      this.logger.info('Migration started', { planId, phases: plan.phases.length });

      // Start migration execution (non-blocking)
      this.executeMigration(plan).catch(error => {
        this.logger.error('Migration execution failed', { planId, error });
        progress.status = 'failed';
      });

      await this.telemetryService.recordEvent({
        id: CryptoUtils.generateUUID(),
        type: 'MigrationJobStarted',
        jobId: planId,
        timestamp: Date.now(),
        flowId: planId,
        totalRecords: plan.totalRecords || 0,
        estimatedDurationMs: plan.estimatedDuration || 0,
        metadata: {
          sourceSystem: plan.sourceSystem,
          targetSystem: plan.targetSystem
        }
      });

      return progress;
    } catch (error) {
      this.logger.error('Failed to start migration', { planId, error });
      throw error;
    }
  }

  /**
   * Get migration progress
   */
  async getMigrationProgress(planId: string): Promise<MigrationProgress | null> {
    return this.activeMigrations.get(planId) || null;
  }

  /**
   * Pause migration
   */
  async pauseMigration(planId: string): Promise<void> {
    const progress = this.activeMigrations.get(planId);
    if (!progress) {
      throw new Error(`Active migration ${planId} not found`);
    }

    progress.status = 'paused';
    
    const plan = this.migrationPlans.get(planId);
    if (plan) {
      plan.status = 'paused';
    }

    this.logger.info('Migration paused', { planId });
  }

  /**
   * Resume migration
   */
  async resumeMigration(planId: string): Promise<void> {
    const progress = this.activeMigrations.get(planId);
    if (!progress) {
      throw new Error(`Active migration ${planId} not found`);
    }

    progress.status = 'running';
    
    const plan = this.migrationPlans.get(planId);
    if (plan) {
      plan.status = 'running';
    }

    this.logger.info('Migration resumed', { planId });
  }

  /**
   * Stop migration
   */
  async stopMigration(planId: string): Promise<void> {
    const progress = this.activeMigrations.get(planId);
    if (!progress) {
      throw new Error(`Active migration ${planId} not found`);
    }

    progress.status = 'failed';
    
    const plan = this.migrationPlans.get(planId);
    if (plan) {
      plan.status = 'failed';
    }

    this.activeMigrations.delete(planId);
    this.logger.info('Migration stopped', { planId });
  }

  /**
   * Generate data quality report
   */
  async generateDataQualityReport(planId: string): Promise<DataQualityReport> {
    const plan = this.migrationPlans.get(planId);
    if (!plan) {
      throw new Error(`Migration plan ${planId} not found`);
    }

    // Analyze data quality based on migration results
    const report: DataQualityReport = {
      planId,
      timestamp: new Date(),
      overallScore: 0,
      metrics: {
        completeness: 0,
        accuracy: 0,
        consistency: 0,
        validity: 0,
        uniqueness: 0,
      },
      issues: [],
      recommendations: [],
    };

    // Calculate metrics based on migration progress
    const progress = this.activeMigrations.get(planId);
    if (progress && plan.totalRecords && plan.totalRecords > 0) {
      const successRate = plan.successfulRecords / plan.totalRecords;
      const errorRate = plan.failedRecords / plan.totalRecords;
      
      report.metrics.completeness = Math.max(0, 100 - (errorRate * 100));
      report.metrics.accuracy = Math.min(100, successRate * 100);
      report.metrics.consistency = Math.max(0, 100 - (progress.errors.length / plan.totalRecords * 100));
      report.metrics.validity = Math.max(0, 100 - (progress.warnings.length / plan.totalRecords * 100));
      report.metrics.uniqueness = 95; // Default assumption, would need deduplication analysis
      
      report.overallScore = (
        report.metrics.completeness +
        report.metrics.accuracy +
        report.metrics.consistency +
        report.metrics.validity +
        report.metrics.uniqueness
      ) / 5;
    }

    // Generate recommendations
    if (report.metrics.completeness < 95) {
      report.recommendations.push('Review failed records and improve error handling');
    }
    if (report.metrics.accuracy < 90) {
      report.recommendations.push('Validate field mappings and transformation rules');
    }
    if (report.metrics.consistency < 85) {
      report.recommendations.push('Implement data consistency checks across related records');
    }

    this.logger.info('Data quality report generated', {
      planId,
      overallScore: report.overallScore,
      issueCount: report.issues.length,
    });

    return report;
  }

  /**
   * Validate migration plan
   */
  private async validateMigrationPlan(plan: MigrationPlan): Promise<void> {
    // Validate required fields
    if (!plan.name || !plan.sourceSystem || !plan.targetSystem) {
      throw new Error('Migration plan must have name, sourceSystem, and targetSystem');
    }

    // Validate phases
    if (!plan.phases || plan.phases.length === 0) {
      throw new Error('Migration plan must have at least one phase');
    }

    // Validate phase dependencies
    const phaseIds = new Set(plan.phases.map(p => p.id));
    for (const phase of plan.phases) {
      if (phase.dependsOn) {
        for (const dep of phase.dependsOn) {
          if (!phaseIds.has(dep)) {
            throw new Error(`Phase ${phase.id} depends on non-existent phase ${dep}`);
          }
        }
      }
    }

    // Validate field mappings
    if (plan.mappings.some(m => !m.sourceField || !m.targetField)) {
      throw new Error('All field mappings must have sourceField and targetField');
    }

    this.logger.debug('Migration plan validation passed', { planId: plan.id });
  }

  /**
   * Execute migration plan
   */
  private async executeMigration(plan: MigrationPlan): Promise<void> {
    const progress = this.activeMigrations.get(plan.id);
    if (!progress) {
      throw new Error(`Migration progress not found for plan ${plan.id}`);
    }

    try {
      // Sort phases by order and dependencies
      const sortedPhases = this.sortPhases(plan.phases);
      
      for (const phase of sortedPhases) {
        if (progress.status === 'paused') {
          // Wait for resume
          while (progress.status === 'paused') {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        if (progress.status !== 'running') {
          break;
        }

        progress.currentPhase = phase.name;
        progress.phaseProgress = 0;

        this.logger.info('Starting migration phase', {
          planId: plan.id,
          phaseId: phase.id,
          phaseName: phase.name,
        });

        phase.status = 'running';
        phase.startTime = new Date();

        try {
          await this.executePhase(plan, phase, progress);
          phase.status = 'completed';
          phase.endTime = new Date();
        } catch (error) {
          phase.status = 'failed';
          phase.endTime = new Date();
          throw error;
        }

        // Update overall progress
        const completedPhases = plan.phases.filter(p => p.status === 'completed').length;
        progress.overallProgress = (completedPhases / plan.phases.length) * 100;
      }

      progress.status = 'completed';
      plan.status = 'completed';
      
      this.logger.info('Migration completed successfully', {
        planId: plan.id,
        duration: Date.now() - (progress.startTime?.getTime() || 0),
        successfulRecords: plan.successfulRecords,
        failedRecords: plan.failedRecords,
      });

      await this.telemetryService.recordEvent({
        id: CryptoUtils.generateUUID(),
        type: 'MigrationJobCompleted',
        timestamp: Date.now(),
        jobId: plan.id,
        flowId: plan.id,
        totalRecords: plan.totalRecords || 0,
        successCount: plan.successfulRecords,
        failureCount: plan.failedRecords,
        durationMs: Date.now() - (progress.startTime?.getTime() || 0),
        metadata: {
          sourceSystem: plan.sourceSystem,
          targetSystem: plan.targetSystem,
          successRate: plan.totalRecords ? (plan.successfulRecords / plan.totalRecords) * 100 : 0
        }
      });
    } catch (error) {
      progress.status = 'failed';
      plan.status = 'failed';
      
      this.logger.error('Migration failed', { planId: plan.id, error });
      
      await this.telemetryService.recordEvent({
        id: CryptoUtils.generateUUID(),
        type: 'MigrationJobFailed',
        timestamp: Date.now(),
        jobId: plan.id,
        flowId: plan.id,
        errorCode: 'MIGRATION_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
        processedRecords: plan.processedRecords,
        totalRecords: plan.totalRecords || 0,
        metadata: {
          sourceSystem: plan.sourceSystem,
          targetSystem: plan.targetSystem
        }
      });
    }
  }

  /**
   * Execute a single migration phase
   */
  private async executePhase(plan: MigrationPlan, phase: MigrationPhase, progress: MigrationProgress): Promise<void> {
    // Simulate phase execution with progress tracking
    const batchSize = phase.batchSize || 100;
    const totalBatches = Math.ceil(phase.estimatedRecords / batchSize);

    for (let batch = 0; batch < totalBatches; batch++) {
      if (progress.status !== 'running') {
        break;
      }

      // Simulate processing time
      await new Promise(resolve => setTimeout(resolve, 100));

      const recordsProcessed = Math.min(batchSize, phase.estimatedRecords - (batch * batchSize));
      
      // Simulate some failures (5% failure rate for demo)
      const failedRecords = Math.floor(recordsProcessed * 0.05);
      const successfulRecords = recordsProcessed - failedRecords;

      phase.processedRecords += recordsProcessed;
      plan.processedRecords += recordsProcessed;
      plan.successfulRecords += successfulRecords;
      plan.failedRecords += failedRecords;

      // Update progress
      progress.phaseProgress = (phase.processedRecords / phase.estimatedRecords) * 100;
      
      // Update records per second
      if (progress.startTime) {
        const elapsedSeconds = (Date.now() - progress.startTime.getTime()) / 1000;
        progress.recordsPerSecond = plan.processedRecords / elapsedSeconds;
      }

      // Generate some demo errors and warnings
      if (failedRecords > 0) {
        progress.errors.push({
          id: CryptoUtils.generateUUID(),
          timestamp: new Date(),
          phase: phase.name,
          errorType: 'validation',
          errorMessage: `Validation failed for ${failedRecords} records in batch ${batch + 1}`,
          severity: 'medium',
          context: { batch: batch + 1, recordsAffected: failedRecords },
        });
      }

      // Add occasional warnings
      if (Math.random() < 0.1) {
        progress.warnings.push({
          id: CryptoUtils.generateUUID(),
          timestamp: new Date(),
          phase: phase.name,
          warningType: 'data_quality',
          message: `Data quality issue detected in batch ${batch + 1}`,
          impact: 'low',
        });
      }

      this.logger.debug('Phase batch completed', {
        planId: plan.id,
        phaseId: phase.id,
        batch: batch + 1,
        totalBatches,
        recordsProcessed,
        successfulRecords,
        failedRecords,
      });
    }
  }

  /**
   * Sort phases by dependencies and order
   */
  private sortPhases(phases: MigrationPhase[]): MigrationPhase[] {
    const sorted: MigrationPhase[] = [];
    const processed = new Set<string>();
    
    function canProcess(phase: MigrationPhase): boolean {
      return !phase.dependsOn || phase.dependsOn.every(dep => processed.has(dep));
    }
    
    while (sorted.length < phases.length) {
      const nextPhases = phases
        .filter(p => !processed.has(p.id) && canProcess(p))
        .sort((a, b) => a.order - b.order);
        
      if (nextPhases.length === 0) {
        throw new Error('Circular dependency detected in migration phases');
      }
      
      nextPhases.forEach(phase => {
        sorted.push(phase);
        processed.add(phase.id);
      });
    }
    
    return sorted;
  }
}