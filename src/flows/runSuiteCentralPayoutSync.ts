import { Logger } from '../utils/Logger';
import { FieldMapperUtility } from '../utils/fieldMapper';
import { squireProjects, getMappingMetadata } from '../data/squireMockData';
import type { SyncResult, DataRecord } from '../types';

export interface PayoutSyncOptions {
  dryRun?: boolean;
  batchSize?: number;
  includeIncomplete?: boolean;
  filterByStatus?: string[];
  minProjectValue?: number;
  dateRange?: {
    start: Date;
    end: Date;
  };
  logLevel?: 'info' | 'debug' | 'warn' | 'error';
}

export class SuiteCentralPayoutSyncFlow {
  private readonly logger: Logger;
  private readonly fieldMapper: FieldMapperUtility;

  constructor() {
    this.logger = new Logger('SuiteCentralPayoutSync');
    this.fieldMapper = new FieldMapperUtility(this.logger);
  }

  /**
   * Execute the complete Squire → SuiteCentral PayoutCentral sync flow
   */
  async execute(options: PayoutSyncOptions = {}): Promise<SyncResult> {
    const startTime = new Date();
    const {
      dryRun = false,
      batchSize = 5, // Smaller batches for financial data
      includeIncomplete = false,
      filterByStatus,
      minProjectValue = 0,
      dateRange,
      logLevel = 'info',
    } = options;

    this.logger.setLevel(logLevel);
    
    this.logger.info('🚀 Starting Squire → SuiteCentral PayoutCentral sync', {
      dryRun,
      batchSize,
      includeIncomplete,
      filterByStatus,
      minProjectValue,
      dateRange,
    });

    try {
      // Step 1: Retrieve and filter Squire project data
      const sourceRecords = this.getFilteredProjects(includeIncomplete, filterByStatus, minProjectValue, dateRange);
      this.logger.info(`💰 Retrieved ${sourceRecords.length} project records for payout processing`);

      // Step 2: Get field mapping metadata
      const mappingMetadata = getMappingMetadata('payoutCentral');
      
      // Step 3: Validate mapping metadata
      const validation = this.fieldMapper.validateMappingMetadata(mappingMetadata);
      if (!validation.isValid) {
        throw new Error(`Invalid mapping metadata: ${validation.errors.join(', ')}`);
      }

      if (validation.warnings.length > 0) {
        this.logger.warn('⚠️ Mapping metadata warnings', { warnings: validation.warnings });
      }

      // Step 4: Transform records in batches (with financial calculations)
      const transformedRecords: DataRecord[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];
      let totalPayoutValue = 0;

      for (let i = 0; i < sourceRecords.length; i += batchSize) {
        const batch = sourceRecords.slice(i, i + batchSize);
        this.logger.info(`💱 Processing payout batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(sourceRecords.length / batchSize)}`);

        for (const record of batch) {
          try {
            const mappingResult = await this.fieldMapper.mapFields(record, mappingMetadata);
            
            if (mappingResult.success && mappingResult.mappedRecord) {
              // Enrich with payout-specific calculations
              const enrichedRecord = this.enrichPayoutRecord(mappingResult.mappedRecord, record);
              transformedRecords.push(enrichedRecord);
              totalPayoutValue += (enrichedRecord.commissionAmount as number) || 0;
              
              this.logger.debug(`✅ Processed payout: ${record.projectNumber} → $${enrichedRecord.commissionAmount}`);
            } else {
              errors.push(...mappingResult.errors);
              this.logger.error(`❌ Failed to process payout: ${record.projectNumber}`, { errors: mappingResult.errors });
            }

            warnings.push(...mappingResult.warnings);
          } catch (error) {
            const errorMsg = `Payout processing failed for project ${record.projectNumber}: ${error instanceof Error ? error.message : String(error)}`;
            errors.push(errorMsg);
            this.logger.error('❌ Payout processing error', error);
          }
        }

        // Extra delay for financial operations (security/audit trail)
        if (!dryRun) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      // Step 5: Simulate SuiteCentral API calls (if not dry run)
      let syncedCount = 0;
      if (!dryRun) {
        syncedCount = await this.syncToSuiteCentral(transformedRecords);
        this.logger.info(`📤 Synced ${syncedCount} payouts to SuiteCentral PayoutCentral (Total: $${totalPayoutValue.toFixed(2)})`);
      } else {
        this.logger.info(`🔍 Dry run completed - would process $${totalPayoutValue.toFixed(2)} in payouts`);
      }

      // Step 6: Generate sync report with financial summary
      const endTime = new Date();
      const result: SyncResult = {
        integrationId: 'squire-payoutcentral-sync',
        syncId: `payout_sync_${Date.now()}`,
        status: errors.length === 0 ? 'success' : transformedRecords.length > 0 ? 'partial' : 'failed',
        success: errors.length === 0,
        recordsProcessed: sourceRecords.length,
        recordsSuccessful: transformedRecords.length,
        recordsFailed: sourceRecords.length - transformedRecords.length,
        errors,
        warnings,
        startTime,
        endTime,
        metadata: {
          dryRun,
          batchSize,
          includeIncomplete,
          filterByStatus: filterByStatus || [],
          minProjectValue,
          dateRange,
          syncedToSuiteCentral: !dryRun,
          suiteCentralRecords: syncedCount,
          totalPayoutValue: Number(totalPayoutValue.toFixed(2)),
          averagePayoutAmount: transformedRecords.length > 0 ? Number((totalPayoutValue / transformedRecords.length).toFixed(2)) : 0,
          payoutValidationPerformed: true,
          auditTrailGenerated: true,
        },
      };

      this.logger.info('🎉 SuiteCentral Payout sync completed', {
        status: result.status,
        processed: result.recordsProcessed,
        successful: result.recordsSuccessful,
        failed: result.recordsFailed,
        totalValue: `$${totalPayoutValue.toFixed(2)}`,
        duration: `${(endTime.getTime() - startTime.getTime()) / 1000}s`,
      });

      return result;
    } catch (error) {
      const endTime = new Date();
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      this.logger.error('💥 Payout sync failed', error);

      return {
        integrationId: 'squire-payoutcentral-sync',
        syncId: `payout_sync_${Date.now()}`,
        status: 'failed',
        success: false,
        recordsProcessed: 0,
        recordsSuccessful: 0,
        recordsFailed: 0,
        errors: [errorMsg],
        startTime,
        endTime,
      };
    }
  }

  /**
   * Get filtered project records based on criteria
   */
  private getFilteredProjects(
    includeIncomplete: boolean, 
    filterByStatus?: string[], 
    minProjectValue?: number,
    dateRange?: { start: Date; end: Date }
  ): DataRecord[] {
    let projects = [...squireProjects];

    // Filter by completion status
    if (!includeIncomplete) {
      projects = projects.filter(project => project.projectStatus === 'Completed');
    }

    // Filter by specific statuses
    if (filterByStatus && filterByStatus.length > 0) {
      projects = projects.filter(project => filterByStatus.includes(project.projectStatus));
    }

    // Filter by minimum project value
    if (minProjectValue && minProjectValue > 0) {
      projects = projects.filter(project => project.projectValue >= minProjectValue);
    }

    // Filter by date range
    if (dateRange) {
      projects = projects.filter(project => {
        const projectDate = new Date(project.installationDate);
        return projectDate >= dateRange.start && projectDate <= dateRange.end;
      });
    }

    return projects;
  }

  /**
   * Enrich project record with payout calculations and metadata
   */
  private enrichPayoutRecord(mappedRecord: DataRecord, originalRecord: DataRecord): DataRecord {
    const projectValue = originalRecord.projectValue as number;
    const commissionPercent = mappedRecord.commissionPercent as number;
    const hoursWorked = mappedRecord.hoursWorked as number || 0;
    
    // Calculate commission amount
    const commissionAmount = (projectValue * commissionPercent) / 100;
    
    return {
      ...mappedRecord,
      // Financial calculations
      commissionAmount: Number(commissionAmount.toFixed(2)),
      basePayout: Number(commissionAmount.toFixed(2)),
      bonusPayout: this.calculateBonusPayout(originalRecord),
      totalPayout: Number((commissionAmount + this.calculateBonusPayout(originalRecord)).toFixed(2)),
      
      // Payout metadata
      payoutCalculatedDate: new Date().toISOString(),
      payoutCurrency: 'USD',
      payoutTaxStatus: this.determineTaxStatus(originalRecord),
      payoutPriority: this.calculatePayoutPriority(originalRecord),
      
      // Audit fields
      lastSyncDate: new Date().toISOString(),
      syncSource: 'Squire',
      auditTrail: this.generateAuditTrail(originalRecord),
      
      // Performance metrics
      efficiencyRatio: hoursWorked > 0 ? Number(((originalRecord.estimatedHours as number) / hoursWorked).toFixed(2)) : null,
      profitMargin: this.calculateProfitMargin(projectValue, commissionAmount),
    };
  }

  /**
   * Calculate bonus payout based on performance metrics
   */
  private calculateBonusPayout(project: DataRecord): number {
    let bonus = 0;
    const projectValue = project.projectValue as number;
    const satisfaction = project.customerSatisfaction as number;
    const estimatedHours = project.estimatedHours as number;
    const actualHours = project.actualHours as number;

    // Customer satisfaction bonus
    if (satisfaction >= 5) {
      bonus += projectValue * 0.02; // 2% bonus for perfect rating
    } else if (satisfaction >= 4.5) {
      bonus += projectValue * 0.01; // 1% bonus for excellent rating
    }

    // Efficiency bonus (completed ahead of schedule)
    if (actualHours && actualHours < estimatedHours) {
      const efficiencyRatio = (estimatedHours - actualHours) / estimatedHours;
      if (efficiencyRatio >= 0.2) {
        bonus += projectValue * 0.015; // 1.5% bonus for 20%+ efficiency
      } else if (efficiencyRatio >= 0.1) {
        bonus += projectValue * 0.01; // 1% bonus for 10%+ efficiency
      }
    }

    return Number(bonus.toFixed(2));
  }

  /**
   * Determine tax status for payout processing
   */
  private determineTaxStatus(project: DataRecord): string {
    const projectValue = project.projectValue as number;
    
    if (projectValue >= 10000) {
      return '1099_required'; // Large projects require 1099
    } else if (projectValue >= 5000) {
      return '1099_recommended'; // Medium projects should have 1099
    } else {
      return 'standard'; // Small projects use standard processing
    }
  }

  /**
   * Calculate payout priority based on various factors
   */
  private calculatePayoutPriority(project: DataRecord): string {
    const projectValue = project.projectValue as number;
    const status = project.projectStatus as string;
    const payoutStatus = project.payoutStatus as string;
    
    // High priority: Large completed projects not yet paid
    if (projectValue >= 10000 && status === 'Completed' && payoutStatus === 'Pending') {
      return 'high';
    }
    
    // Medium priority: Regular completed projects
    if (status === 'Completed' && payoutStatus === 'Pending') {
      return 'medium';
    }
    
    // Low priority: In-progress or paid projects
    if (payoutStatus === 'Paid') {
      return 'completed';
    }
    
    return 'low';
  }

  /**
   * Generate audit trail for compliance
   */
  private generateAuditTrail(project: DataRecord): string {
    return JSON.stringify({
      originalProjectId: project.id,
      projectNumber: project.projectNumber,
      calculationDate: new Date().toISOString(),
      calculationMethod: 'percentage_based',
      bonusFactors: ['customer_satisfaction', 'efficiency_rating'],
      taxStatusDetermined: this.determineTaxStatus(project),
      complianceChecked: true,
    });
  }

  /**
   * Calculate profit margin for business intelligence
   */
  private calculateProfitMargin(projectValue: number, commissionAmount: number): number {
    // Estimate project costs (labor, materials, overhead)
    const estimatedCosts = projectValue * 0.65; // Assume 65% cost ratio
    const profit = projectValue - estimatedCosts - commissionAmount;
    const margin = (profit / projectValue) * 100;
    
    return Number(margin.toFixed(2));
  }

  /**
   * Simulate syncing transformed records to SuiteCentral PayoutCentral
   */
  private async syncToSuiteCentral(records: DataRecord[]): Promise<number> {
    this.logger.info('📡 Connecting to SuiteCentral PayoutCentral API...');
    
    // Simulate secure financial API connection
    await new Promise(resolve => setTimeout(resolve, 1000));

    let syncedCount = 0;
    for (const record of records) {
      try {
        // Simulate financial validation checks
        this.logger.debug(`💳 Validating payout: ${record.projectId}`, {
          totalPayout: record.totalPayout,
          taxStatus: record.payoutTaxStatus,
          priority: record.payoutPriority,
        });

        // Simulate compliance and audit checks
        this.logger.debug(`📋 Performing compliance checks: ${record.projectId}`);

        // Simulate API call to SuiteCentral
        this.logger.debug(`📤 Syncing payout: ${record.projectId}`, {
          externalId: record.externalId,
          commissionAmount: record.commissionAmount,
          bonusPayout: record.bonusPayout,
          totalPayout: record.totalPayout,
        });

        // Simulate API response time (financial operations are slower)
        await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 250));

        // Simulate 97% success rate (high due to financial validation)
        if (Math.random() > 0.03) {
          syncedCount++;
          this.logger.debug(`✅ Successfully synced payout: ${record.projectId} ($${record.totalPayout})`);
        } else {
          this.logger.warn(`⚠️ Failed to sync payout: ${record.projectId} (Compliance validation failed)`);
        }
      } catch (error) {
        this.logger.error(`❌ Error syncing payout: ${record.projectId}`, error);
      }
    }

    return syncedCount;
  }

  /**
   * Generate financial summary report for management
   */
  async generateFinancialReport(): Promise<{
    totalProjects: number;
    totalProjectValue: number;
    totalCommissions: number;
    totalBonuses: number;
    averageCommissionRate: number;
    payoutsByStatus: Record<string, { count: number; amount: number }>;
    topPerformingProjects: {
      projectNumber: string;
      projectValue: number;
      commissionAmount: number;
      efficiencyRatio: number;
    }[];
  }> {
    this.logger.info('📊 Generating financial summary report');

    const projects = squireProjects;
    let totalProjectValue = 0;
    let totalCommissions = 0;
    let totalBonuses = 0;
    let totalCommissionRate = 0;
    
    const payoutsByStatus: Record<string, { count: number; amount: number }> = {};
    const projectPerformance: {
      projectNumber: string;
      projectValue: number;
      commissionAmount: number;
      efficiencyRatio: number;
    }[] = [];

    for (const project of projects) {
      const projectValue = project.projectValue;
      const commissionRate = project.commissionRate;
      const commissionAmount = projectValue * commissionRate;
      const bonusAmount = this.calculateBonusPayout(project);
      const efficiencyRatio = project.actualHours ? (project.estimatedHours / project.actualHours) : 1;

      totalProjectValue += projectValue;
      totalCommissions += commissionAmount;
      totalBonuses += bonusAmount;
      totalCommissionRate += commissionRate;

      // Track by payout status
      const status = project.payoutStatus;
      if (!payoutsByStatus[status]) {
        payoutsByStatus[status] = { count: 0, amount: 0 };
      }
      payoutsByStatus[status].count++;
      payoutsByStatus[status].amount += commissionAmount + bonusAmount;

      // Track performance
      projectPerformance.push({
        projectNumber: project.projectNumber,
        projectValue,
        commissionAmount,
        efficiencyRatio,
      });
    }

    // Sort by total payout amount for top performers
    const topPerformingProjects = projectPerformance
      .sort((a, b) => b.commissionAmount - a.commissionAmount)
      .slice(0, 5);

    const report = {
      totalProjects: projects.length,
      totalProjectValue: Number(totalProjectValue.toFixed(2)),
      totalCommissions: Number(totalCommissions.toFixed(2)),
      totalBonuses: Number(totalBonuses.toFixed(2)),
      averageCommissionRate: Number((totalCommissionRate / projects.length * 100).toFixed(2)),
      payoutsByStatus,
      topPerformingProjects,
    };

    this.logger.info('📋 Financial report generated', {
      totalProjects: report.totalProjects,
      totalProjectValue: `$${report.totalProjectValue.toLocaleString()}`,
      totalCommissions: `$${report.totalCommissions.toLocaleString()}`,
      averageCommissionRate: `${report.averageCommissionRate}%`,
    });

    return report;
  }
}