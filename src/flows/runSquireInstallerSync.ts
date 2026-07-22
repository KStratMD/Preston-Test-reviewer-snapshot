import { Logger } from '../utils/Logger';
import { FieldMapperUtility } from '../utils/fieldMapper';
import { squireInstallers, getMappingMetadata } from '../data/squireMockData';
import type { SyncResult, DataRecord } from '../types';

export interface InstallerSyncOptions {
  dryRun?: boolean;
  batchSize?: number;
  includeUnavailable?: boolean;
  filterBySpecialization?: string[];
  minRating?: number;
  maxRadius?: number;
  logLevel?: 'info' | 'debug' | 'warn' | 'error';
}

export class SquireInstallerSyncFlow {
  private readonly logger: Logger;
  private readonly fieldMapper: FieldMapperUtility;

  constructor() {
    this.logger = new Logger('SquireInstallerSync');
    this.fieldMapper = new FieldMapperUtility(this.logger);
  }

  /**
   * Execute the complete Squire → SuiteCentral InstallerCentral sync flow
   */
  async execute(options: InstallerSyncOptions = {}): Promise<SyncResult> {
    const startTime = new Date();
    const {
      dryRun = false,
      batchSize = 10,
      includeUnavailable = false,
      filterBySpecialization,
      minRating = 0,
      maxRadius,
      logLevel = 'info',
    } = options;

    this.logger.setLevel(logLevel);
    
    this.logger.info('🚀 Starting Squire Installer → SuiteCentral InstallerCentral sync', {
      dryRun,
      batchSize,
      includeUnavailable,
      filterBySpecialization,
      minRating,
      maxRadius,
    });

    try {
      // Step 1: Retrieve and filter Squire installer data
      const sourceRecords = this.getFilteredInstallers(includeUnavailable, filterBySpecialization, minRating, maxRadius);
      this.logger.info(`👷 Retrieved ${sourceRecords.length} installer records from Squire`);

      // Step 2: Get field mapping metadata
      const mappingMetadata = getMappingMetadata('installerCentral');
      
      // Step 3: Validate mapping metadata
      const validation = this.fieldMapper.validateMappingMetadata(mappingMetadata);
      if (!validation.isValid) {
        throw new Error(`Invalid mapping metadata: ${validation.errors.join(', ')}`);
      }

      if (validation.warnings.length > 0) {
        this.logger.warn('⚠️ Mapping metadata warnings', { warnings: validation.warnings });
      }

      // Step 4: Transform records in batches
      const transformedRecords: DataRecord[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];

      for (let i = 0; i < sourceRecords.length; i += batchSize) {
        const batch = sourceRecords.slice(i, i + batchSize);
        this.logger.info(`🔄 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(sourceRecords.length / batchSize)}`);

        for (const record of batch) {
          try {
            const mappingResult = await this.fieldMapper.mapFields(record, mappingMetadata);
            
            if (mappingResult.success && mappingResult.mappedRecord) {
              // Enrich with installer-specific metadata
              const enrichedRecord = this.enrichInstallerRecord(mappingResult.mappedRecord, record);
              transformedRecords.push(enrichedRecord);
              this.logger.debug(`✅ Mapped installer: ${record.installerName} → ${enrichedRecord.installerName}`);
            } else {
              errors.push(...mappingResult.errors);
              this.logger.error(`❌ Failed to map installer: ${record.installerName}`, { errors: mappingResult.errors });
            }

            warnings.push(...mappingResult.warnings);
          } catch (error) {
            const errorMsg = `Mapping failed for installer ${record.installerName}: ${error instanceof Error ? error.message : String(error)}`;
            errors.push(errorMsg);
            this.logger.error('❌ Installer mapping error', error);
          }
        }

        // Simulate processing delay for realism
        if (!dryRun) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }

      // Step 5: Simulate SuiteCentral API calls (if not dry run)
      let syncedCount = 0;
      if (!dryRun) {
        syncedCount = await this.syncToSuiteCentral(transformedRecords);
        this.logger.info(`📤 Synced ${syncedCount} installers to SuiteCentral InstallerCentral`);
      } else {
        this.logger.info('🔍 Dry run completed - no data was synced to SuiteCentral');
      }

      // Step 6: Generate sync report
      const endTime = new Date();
      const result: SyncResult = {
        integrationId: 'squire-installercentral-sync',
        syncId: `installer_sync_${Date.now()}`,
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
          includeUnavailable,
          filterBySpecialization: filterBySpecialization || [],
          minRating,
          maxRadius,
          syncedToSuiteCentral: !dryRun,
          suiteCentralRecords: syncedCount,
          installerAvailabilityCheck: true,
          licenseValidationPerformed: true,
        },
      };

      this.logger.info('🎉 Squire Installer sync completed', {
        status: result.status,
        processed: result.recordsProcessed,
        successful: result.recordsSuccessful,
        failed: result.recordsFailed,
        duration: `${(endTime.getTime() - startTime.getTime()) / 1000}s`,
      });

      return result;
    } catch (error) {
      const endTime = new Date();
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      this.logger.error('💥 Installer sync failed', error);

      return {
        integrationId: 'squire-installercentral-sync',
        syncId: `installer_sync_${Date.now()}`,
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
   * Get filtered installer records based on criteria
   */
  private getFilteredInstallers(
    includeUnavailable: boolean, 
    filterBySpecialization?: string[], 
    minRating?: number,
    maxRadius?: number
  ): DataRecord[] {
    let installers = [...squireInstallers];

    // Filter by availability status
    if (!includeUnavailable) {
      installers = installers.filter(installer => installer.availabilityStatus !== 'Unavailable');
    }

    // Filter by specialization
    if (filterBySpecialization && filterBySpecialization.length > 0) {
      installers = installers.filter(installer => 
        installer.specializations.some(spec => filterBySpecialization.includes(spec))
      );
    }

    // Filter by minimum rating
    if (minRating && minRating > 0) {
      installers = installers.filter(installer => installer.averageRating >= minRating);
    }

    // Filter by maximum service radius
    if (maxRadius && maxRadius > 0) {
      installers = installers.filter(installer => installer.workingRadius <= maxRadius);
    }

    return installers;
  }

  /**
   * Enrich installer record with additional metadata for SuiteCentral
   */
  private enrichInstallerRecord(mappedRecord: DataRecord, originalRecord: DataRecord): DataRecord {
    return {
      ...mappedRecord,
      // Add SuiteCentral-specific enrichment
      lastSyncDate: new Date().toISOString(),
      syncSource: 'Squire',
      qualificationStatus: this.calculateQualificationStatus(originalRecord),
      capacityScore: this.calculateCapacityScore(originalRecord),
      riskAssessment: this.calculateRiskAssessment(originalRecord),
      nextAvailableDate: this.calculateNextAvailableDate(originalRecord),
    };
  }

  /**
   * Calculate installer qualification status for SuiteCentral
   */
  private calculateQualificationStatus(installer: DataRecord): string {
    const rating = installer.averageRating as number;
    const certLevel = installer.certificationLevel as string;
    const completedProjects = installer.completedProjects as number;

    if (rating >= 4.8 && certLevel === 'Master' && completedProjects >= 100) {
      return 'premier';
    } else if (rating >= 4.5 && (certLevel === 'Master' || certLevel === 'Advanced') && completedProjects >= 50) {
      return 'certified';
    } else if (rating >= 4.0 && completedProjects >= 25) {
      return 'qualified';
    } else {
      return 'standard';
    }
  }

  /**
   * Calculate capacity score based on workload and availability
   */
  private calculateCapacityScore(installer: DataRecord): number {
    const completedProjects = installer.completedProjects as number;
    const availabilityStatus = installer.availabilityStatus as string;
    const workingRadius = installer.workingRadius as number;

    let score = Math.min(completedProjects / 10, 10); // Project experience (0-10)
    
    // Availability bonus/penalty
    if (availabilityStatus === 'Available') score += 5;
    else if (availabilityStatus === 'Booked') score += 2;
    else score -= 3;

    // Service area coverage (larger radius = higher capacity)
    score += Math.min(workingRadius / 20, 5); // Service area (0-5)

    return Math.max(0, Math.min(20, score)); // Normalize to 0-20
  }

  /**
   * Calculate risk assessment score
   */
  private calculateRiskAssessment(installer: DataRecord): string {
    const licenseExpiry = new Date(installer.licenseExpiry as string);
    const insuranceExpiry = new Date(installer.insuranceExpiry as string);
    const rating = installer.averageRating as number;
    const now = new Date();
    
    // Check license expiry
    const licenseMonthsLeft = (licenseExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 30);
    const insuranceMonthsLeft = (insuranceExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 30);

    if (licenseMonthsLeft < 3 || insuranceMonthsLeft < 3) return 'high';
    if (rating < 4.0) return 'medium';
    if (licenseMonthsLeft < 6 || insuranceMonthsLeft < 6 || rating < 4.5) return 'low';
    return 'minimal';
  }

  /**
   * Calculate next available date based on current status
   */
  private calculateNextAvailableDate(installer: DataRecord): string {
    const availabilityStatus = installer.availabilityStatus as string;
    const now = new Date();

    switch (availabilityStatus) {
      case 'Available':
        return now.toISOString();
      case 'Booked':
        // Estimate 1-2 weeks based on typical project duration
        const daysUntilAvailable = Math.random() * 7 + 7; // 7-14 days
        const availableDate = new Date(now.getTime() + (daysUntilAvailable * 24 * 60 * 60 * 1000));
        return availableDate.toISOString();
      default:
        // Unavailable - estimate 1 month
        const futureDate = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
        return futureDate.toISOString();
    }
  }

  /**
   * Simulate syncing transformed records to SuiteCentral InstallerCentral
   */
  private async syncToSuiteCentral(records: DataRecord[]): Promise<number> {
    this.logger.info('📡 Connecting to SuiteCentral InstallerCentral API...');
    
    // Simulate API connection delay
    await new Promise(resolve => setTimeout(resolve, 750));

    let syncedCount = 0;
    for (const record of records) {
      try {
        // Simulate license validation check
        this.logger.debug(`🔍 Validating installer license: ${record.installerName}`, {
          licenseId: record.licenseId,
          licenseExpiration: record.licenseExpiration,
        });

        // Simulate API call to SuiteCentral
        this.logger.debug(`📤 Syncing installer: ${record.installerName}`, {
          externalId: record.externalId,
          level: record.level,
          status: record.status,
          qualificationStatus: record.qualificationStatus,
        });

        // Simulate API response time (installers require more validation)
        await new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 100));

        // Simulate 92% success rate (lower due to license/insurance validation)
        if (Math.random() > 0.08) {
          syncedCount++;
          this.logger.debug(`✅ Successfully synced installer: ${record.installerName}`);
        } else {
          this.logger.warn(`⚠️ Failed to sync installer: ${record.installerName} (License validation failed)`);
        }
      } catch (error) {
        this.logger.error(`❌ Error syncing installer: ${record.installerName}`, error);
      }
    }

    return syncedCount;
  }

  /**
   * Get installer availability report for scheduling optimization
   */
  async getAvailabilityReport(): Promise<{
    totalInstallers: number;
    availableInstallers: number;
    bookedInstallers: number;
    unavailableInstallers: number;
    averageCapacity: number;
    specializations: Record<string, number>;
    serviceAreas: Record<string, number>;
  }> {
    this.logger.info('📊 Generating installer availability report');

    const installers = squireInstallers;
    const specializations: Record<string, number> = {};
    const serviceAreas: Record<string, number> = {};
    
    let totalCapacity = 0;
    let availableCount = 0;
    let bookedCount = 0;
    let unavailableCount = 0;

    for (const installer of installers) {
      // Count availability status
      switch (installer.availabilityStatus) {
        case 'Available':
          availableCount++;
          break;
        case 'Booked':
          bookedCount++;
          break;
        case 'Unavailable':
          unavailableCount++;
          break;
      }

      // Track specializations
      installer.specializations.forEach(spec => {
        specializations[spec] = (specializations[spec] || 0) + 1;
      });

      // Track service areas
      installer.serviceAreas.forEach(area => {
        serviceAreas[area] = (serviceAreas[area] || 0) + 1;
      });

      // Calculate capacity
      totalCapacity += this.calculateCapacityScore(installer);
    }

    const report = {
      totalInstallers: installers.length,
      availableInstallers: availableCount,
      bookedInstallers: bookedCount,
      unavailableInstallers: unavailableCount,
      averageCapacity: totalCapacity / installers.length,
      specializations,
      serviceAreas,
    };

    this.logger.info('📋 Availability report generated', {
      totalInstallers: report.totalInstallers,
      availableInstallers: report.availableInstallers,
      averageCapacity: report.averageCapacity.toFixed(1),
    });

    return report;
  }
}