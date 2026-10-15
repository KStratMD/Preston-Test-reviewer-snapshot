import { Logger } from '../utils/Logger';
import { FieldMapperUtility } from '../utils/fieldMapper';
import { squireVendors, getMappingMetadata } from '../data/squireMockData';
import { SuiteCentralMetrics } from '../services/SuiteCentralMetrics';
import type { SyncResult, DataRecord } from '../types';

export interface SupplierSyncOptions {
  dryRun?: boolean;
  batchSize?: number;
  includeInactive?: boolean;
  filterByCategory?: string[];
  logLevel?: 'info' | 'debug' | 'warn' | 'error';
}

export class SquireSupplierSyncFlow {
  private readonly logger: Logger;
  private readonly fieldMapper: FieldMapperUtility;
  private readonly metrics: InstanceType<typeof SuiteCentralMetrics>;

  constructor() {
    this.logger = new Logger('SquireSupplierSync');
    this.fieldMapper = new FieldMapperUtility(this.logger);
    this.metrics = new SuiteCentralMetrics(this.logger);
  }

  /**
   * Execute the complete Squire → SuiteCentral SupplierCentral sync flow
   */
  async execute(options: SupplierSyncOptions = {}): Promise<SyncResult> {
    const startTime = new Date();
    const {
      dryRun = false,
      batchSize = 10,
      includeInactive = false,
      filterByCategory,
      logLevel = 'info',
    } = options;

    this.logger.setLevel(logLevel);
    
    this.logger.info('🚀 Starting Squire Supplier → SuiteCentral SupplierCentral sync', {
      dryRun,
      batchSize,
      includeInactive,
      filterByCategory,
    });

    try {
      // Step 1: Retrieve and filter Squire vendor data
      const sourceRecords = this.getFilteredVendors(includeInactive, filterByCategory);
      this.logger.info(`📊 Retrieved ${sourceRecords.length} vendor records from Squire`);

      // Step 2: Get field mapping metadata
      const mappingMetadata = getMappingMetadata('supplierCentral');
      
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
              transformedRecords.push(mappingResult.mappedRecord);
              this.logger.debug(`✅ Mapped vendor: ${record.vendorName} → ${mappingResult.mappedRecord.supplierName}`);
            } else {
              errors.push(...mappingResult.errors);
              this.logger.error(`❌ Failed to map vendor: ${record.vendorName}`, { errors: mappingResult.errors });
            }

            warnings.push(...mappingResult.warnings);
          } catch (error) {
            const errorMsg = `Mapping failed for vendor ${record.vendorName}: ${error instanceof Error ? error.message : String(error)}`;
            errors.push(errorMsg);
            this.logger.error('❌ Vendor mapping error', error);
          }
        }

        // Simulate processing delay for realism
        if (!dryRun) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Step 5: Simulate SuiteCentral API calls (if not dry run)
      let syncedCount = 0;
      if (!dryRun) {
        syncedCount = await this.syncToSuiteCentral(transformedRecords);
        this.logger.info(`📤 Synced ${syncedCount} suppliers to SuiteCentral SupplierCentral`);
      } else {
        this.logger.info('🔍 Dry run completed - no data was synced to SuiteCentral');
      }

      // Step 6: Generate sync report
      const endTime = new Date();
      const result: SyncResult = {
        integrationId: 'squire-suppliercentral-sync',
        syncId: `supplier_sync_${Date.now()}`,
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
          includeInactive,
          filterByCategory: filterByCategory || [],
          syncedToSuiteCentral: !dryRun,
          suiteCentralRecords: syncedCount,
        },
      };

      this.logger.info('🎉 Squire Supplier sync completed', {
        status: result.status,
        processed: result.recordsProcessed,
        successful: result.recordsSuccessful,
        failed: result.recordsFailed,
        duration: `${(endTime.getTime() - startTime.getTime()) / 1000}s`,
      });

      // Record comprehensive metrics
      const duration = (endTime.getTime() - startTime.getTime()) / 1000;
      this.metrics.recordSyncOperation({
        module: 'SupplierCentral',
        entityType: 'vendors',
        operation: 'sync',
        status: result.status as 'success' | 'partial' | 'failed'
      }, duration, result.recordsProcessed);

      // Record throughput
      if (duration > 0 && result.recordsSuccessful > 0) {
        this.metrics.recordThroughput('SupplierCentral', 'sync', result.recordsSuccessful / duration);
      }

      // Record data quality score (based on success rate)
      const qualityScore = result.recordsProcessed > 0 ? 
        result.recordsSuccessful / result.recordsProcessed : 0;
      this.metrics.setDataQualityScore('SupplierCentral', 'vendors', qualityScore);

      // Record any errors
      if (result.errors && result.errors.length > 0) {
        result.errors.forEach(error => {
          this.metrics.recordSyncError({
            module: 'SupplierCentral',
            entityType: 'vendors',
            operation: 'sync',
            status: result.status as 'success' | 'partial' | 'failed'
          }, this.categorizeError(error));
        });
      }

      return result;
    } catch (error) {
      const endTime = new Date();
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      this.logger.error('💥 Supplier sync failed', error);

      // Record failure metrics
      const duration = (endTime.getTime() - startTime.getTime()) / 1000;
      this.metrics.recordSyncOperation({
        module: 'SupplierCentral',
        entityType: 'vendors',
        operation: 'sync',
        status: 'failed'
      }, duration, 0);

      this.metrics.recordSyncError({
        module: 'SupplierCentral',
        entityType: 'vendors',
        operation: 'sync',
        status: 'failed'
      }, this.categorizeError(errorMsg));

      return {
        integrationId: 'squire-suppliercentral-sync',
        syncId: `supplier_sync_${Date.now()}`,
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
   * Get filtered vendor records based on criteria
   */
  private getFilteredVendors(includeInactive: boolean, filterByCategory?: string[]): DataRecord[] {
    let vendors = [...squireVendors];

    // Filter by approval status
    if (!includeInactive) {
      vendors = vendors.filter(vendor => vendor.approvalStatus === 'Approved');
    }

    // Filter by category
    if (filterByCategory && filterByCategory.length > 0) {
      vendors = vendors.filter(vendor => filterByCategory.includes(vendor.vendorCategory));
    }

    return vendors;
  }

  /**
   * Simulate syncing transformed records to SuiteCentral SupplierCentral
   */
  private async syncToSuiteCentral(records: DataRecord[]): Promise<number> {
    this.logger.info('📡 Connecting to SuiteCentral SupplierCentral API...');
    
    // Simulate API connection delay
    await new Promise(resolve => setTimeout(resolve, 500));

    let syncedCount = 0;
    for (const record of records) {
      try {
        // Simulate API call to SuiteCentral
        this.logger.debug(`📤 Syncing supplier: ${record.supplierName}`, {
          externalId: record.externalId,
          supplierType: record.supplierType,
          status: record.status,
        });

        // Simulate API response time
        await new Promise(resolve => setTimeout(resolve, Math.random() * 200 + 50));

        // Simulate 95% success rate
        if (Math.random() > 0.05) {
          syncedCount++;
          this.logger.debug(`✅ Successfully synced supplier: ${record.supplierName}`);
        } else {
          this.logger.warn(`⚠️ Failed to sync supplier: ${record.supplierName} (API error)`);
        }
      } catch (error) {
        this.logger.error(`❌ Error syncing supplier: ${record.supplierName}`, error);
      }
    }

    return syncedCount;
  }

  /**
   * Get detailed mapping analysis for troubleshooting
   */
  async analyzeMappings(): Promise<{
    sourceFields: string[];
    targetFields: string[];
    mappingAnalysis: {
      sourceField: string;
      targetField: string;
      transformation: string;
      required: boolean;
      sampleValue: unknown;
      transformedValue: unknown;
    }[];
  }> {
    const mappingMetadata = getMappingMetadata('supplierCentral');
    const sampleRecord = squireVendors[0];
    
    if (!sampleRecord) {
      this.logger.warn('No sample records available for analysis');
      return {
        sourceFields: [],
        targetFields: mappingMetadata.mappings.map(m => m.targetField),
        mappingAnalysis: []
      };
    }

    this.logger.info('🔍 Analyzing Squire → SuiteCentral SupplierCentral field mappings');

    const analysis = {
      sourceFields: Object.keys(sampleRecord),
      targetFields: mappingMetadata.mappings.map(m => m.targetField),
      mappingAnalysis: [] as {
        sourceField: string;
        targetField: string;
        transformation: string;
        required: boolean;
        sampleValue: unknown;
        transformedValue: unknown;
      }[],
    };

    // Analyze each mapping with sample data
    for (const mapping of mappingMetadata.mappings) {
      const sampleValue = sampleRecord[mapping.sourceField];
      const mappingResult = await this.fieldMapper.mapFields(sampleRecord, {
        ...mappingMetadata,
        mappings: [mapping], // Test individual mapping
      });

      analysis.mappingAnalysis.push({
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        transformation: mapping.transformation || 'direct',
        required: mapping.required,
        sampleValue,
        transformedValue: mappingResult.mappedRecord?.[mapping.targetField] || null,
      });
    }

    this.logger.info('📋 Mapping analysis completed', {
      totalMappings: analysis.mappingAnalysis.length,
      requiredMappings: analysis.mappingAnalysis.filter(m => m.required).length,
      transformations: [...new Set(analysis.mappingAnalysis.map(m => m.transformation))],
    });

    return analysis;
  }

  /**
   * Categorize errors for better metrics classification
   */
  private categorizeError(error: string): string {
    const errorLower = error.toLowerCase();
    
    if (errorLower.includes('network') || errorLower.includes('connection') || errorLower.includes('timeout')) {
      return 'network_error';
    } else if (errorLower.includes('auth') || errorLower.includes('unauthorized') || errorLower.includes('forbidden')) {
      return 'authentication_error';
    } else if (errorLower.includes('validation') || errorLower.includes('invalid') || errorLower.includes('required')) {
      return 'validation_error';
    } else if (errorLower.includes('mapping') || errorLower.includes('transform')) {
      return 'transformation_error';
    } else if (errorLower.includes('api') || errorLower.includes('http') || errorLower.includes('status')) {
      return 'api_error';
    } else {
      return 'unknown_error';
    }
  }
}