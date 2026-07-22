import { injectable, inject } from 'inversify';
import { uuidv4 } from '../../utils/uuid';
import pLimit from 'p-limit';
import type { IConnector } from '../../interfaces/IConnector';
import type { DataRecord, IntegrationConfig, SyncResult } from '../../types';
import type { TransformationEngine, TransformationContext } from '../TransformationEngine';
import type { Logger } from '../../utils/Logger';
import type { ObservabilityService } from '../../observability';
import { ConnectorManager } from './ConnectorManager';
import { IntegrationStatusManager } from './IntegrationStatusManager';
import { TYPES } from '../../inversify/types';
import { adaptScopeLogger } from '../../utils/loggerAdapter';
import { guardedWrite } from '../../governance/sourceOfTruth/guardedWrite';
import { canonicalEntityFor } from '../../governance/sourceOfTruth/canonicalEntity';
import { isCanonicalEntity } from '../../governance/sourceOfTruth/SourceOfTruthManifest';
import type { OwnershipResolver } from '../../governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../governance/ApprovalQueueService';
import type { CanonicalEntity, SourceSystem } from '../../governance/sourceOfTruth/SourceOfTruthManifest';
import { SYSTEM_IDENTITY } from '../governance/identityContext';

/**
 * Options for sync operations
 */
export interface SyncOptions {
  batchSize?: number;
  dryRun?: boolean;
  skipValidation?: boolean;
  concurrency?: number;
}

/**
 * Helper function to extract system type string from SystemConfig union type
 */
function getSystemType(system: string | { type: string }): string {
  return typeof system === 'string' ? system : system.type;
}

const SYSTEM_TYPE_TO_SOURCE_SYSTEM: Record<string, SourceSystem> = {
  netsuite: 'netsuite',
  NetSuite: 'netsuite',
  salesforce: 'salesforce',
  Salesforce: 'salesforce',
  businesscentral: 'business_central',
  BusinessCentral: 'business_central',
  // Copilot R10 on PR #851: identity mapping for the canonical manifest
  // spelling (configs already in manifest vocab would otherwise fall
  // through to 'squire' and misattribute Business Central writes).
  business_central: 'business_central',
  hubspot: 'hubspot',
  HubSpot: 'hubspot',
  shipstation: 'shipstation',
  ShipStation: 'shipstation',
  stripe: 'stripe',
  Stripe: 'stripe',
  shopify: 'shopify',
  Shopify: 'shopify',
};

function toSourceSystem(systemType: string, targetEntity?: string): SourceSystem {
  const mapped = SYSTEM_TYPE_TO_SOURCE_SYSTEM[systemType];
  if (mapped) {
    return mapped;
  }
  // Unmapped system type. Fail fast ONLY when the write targets a canonical
  // entity governed by a SourceSystem ownership policy: there, attributing an
  // unmapped connector to 'squire' would corrupt the ownership decision
  // (wrong-by-construction — squire is a non-owner). For non-canonical /
  // policy-less entities the OwnershipResolver short-circuits to
  // no_policy_declared (allowed regardless of caller), so 'squire' is cosmetic
  // audit-only attribution; preserving it keeps valid-but-unmapped connectors
  // (Dynamics365/SAP/Oracle/SuiteCentral — registered but absent from the
  // SourceSystem union) syncing for non-canonical entities.
  if (targetEntity !== undefined && isCanonicalEntity(canonicalEntityFor(targetEntity))) {
    throw new Error(
      `toSourceSystem: unmapped system type '${systemType}' for canonical entity ` +
      `'${canonicalEntityFor(targetEntity)}' — add it to SYSTEM_TYPE_TO_SOURCE_SYSTEM ` +
      `or migrate the caller to use a real SourceSystem name. Squire-fallback removed ` +
      `for canonical writes in PR 13c-5.`,
    );
  }
  return 'squire';
}

/**
 * True only for errors that plausibly mean "record does not exist" (HTTP 404
 * or an explicit not-found message). Everything else — auth failures, rate
 * limits, network errors — must NOT be treated as not-found: doing so turns a
 * transient outage into a duplicate create in the target ERP.
 */
export function isNotFoundReadError(error: unknown): boolean {
  if (error !== null && typeof error === 'object') {
    // statusCode covers this repo's AppError hierarchy (NotFoundAppError etc.).
    const maybe = error as { response?: { status?: unknown }; status?: unknown; statusCode?: unknown };
    const code = typeof maybe.response?.status === 'number'
      ? maybe.response.status
      : typeof maybe.status === 'number' ? maybe.status
      : typeof maybe.statusCode === 'number' ? maybe.statusCode : undefined;
    if (typeof code === 'number') {
      return code === 404;
    }
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /\b404\b|not found/i.test(message);
}

/**
 * Service responsible for executing integration synchronization operations
 */
@injectable()
export class IntegrationExecutor {
  private readonly logger: Logger;
  private readonly transformationEngine: TransformationEngine;
  private readonly connectorManager: ConnectorManager;
  private readonly statusManager: IntegrationStatusManager;
  private readonly observabilityService: ObservabilityService;
  private readonly ownershipResolver: OwnershipResolver;
  private readonly auditService: AuditService;
  private readonly approvalQueueService: ApprovalQueueService;

  constructor(
    logger: Logger,
    transformationEngine: TransformationEngine,
    connectorManager: ConnectorManager,
    statusManager: IntegrationStatusManager,
    observabilityService: ObservabilityService | undefined,
    // Copilot R9 on PR #851: the governance trio is REQUIRED at the type
    // level (was optional-with-runtime-throw, which allowed
    // pre-PR-13b construction sites to compile and fail at first write).
    // observabilityService stays optional because some callers (lightweight
    // CLI tools, legacy fixtures) construct without it.
    ownershipResolver: OwnershipResolver,
    auditService: AuditService,
    approvalQueueService: ApprovalQueueService,
  ) {
    this.logger = logger;
    this.transformationEngine = transformationEngine;
    this.connectorManager = connectorManager;
    this.statusManager = statusManager;
    this.observabilityService = observabilityService ?? ({} as ObservabilityService);
    this.ownershipResolver = ownershipResolver;
    this.auditService = auditService;
    this.approvalQueueService = approvalQueueService;
  }

  /**
   * Execute a full synchronization for an integration configuration
   */
  async executeSync(config: IntegrationConfig, options: SyncOptions = {}): Promise<SyncResult> {
    const {
      batchSize = 100,
      dryRun = false,
      skipValidation = false,
      concurrency = 5,
    } = options;

    const operationId = uuidv4();
    const scope = this.observabilityService.createScope({
      integrationId: config.id,
      operationId,
    });

    const startTime = Date.now();
    let recordsProcessed = 0;
    let recordsSuccessful = 0;
    let recordsFailed = 0;
    const errors: string[] = [];

    try {
      // Get connectors
      const sourceSystemType = getSystemType(config.sourceSystem);
      const targetSystemType = getSystemType(config.targetSystem);
      
      const sourceConnector = await this.connectorManager.getConnector(
        sourceSystemType, 
        `${sourceSystemType}_${config.id}`
      );
      const targetConnector = await this.connectorManager.getConnector(
        targetSystemType, 
        `${targetSystemType}_${config.id}`
      );

      // Fetch source data
      scope.logger.info(`Fetching data from ${sourceSystemType}`);
      const sourceRecords = await sourceConnector.list(config.sourceEntity, {
        limit: batchSize,
        offset: 0,
      });

      if (sourceRecords.length === 0) {
        scope.logger.info('No records found to sync');
        return {
          integrationId: config.id,
          syncId: operationId,
          status: 'success',
          success: true,
          recordsProcessed: 0,
          recordsSuccessful: 0,
          recordsFailed: 0,
          errors: [],
          startTime: new Date(startTime),
          endTime: new Date(),
        };
      }

      // Process records with concurrency control
      const limit = pLimit(concurrency);
      const processRecord = async (sourceRecord: DataRecord): Promise<void> => {
        try {
          await this.syncRecord(
            sourceRecord,
            sourceConnector,
            targetConnector,
            config,
            { dryRun, skipValidation },
            toSourceSystem(sourceSystemType, config.targetEntity),
            toSourceSystem(targetSystemType, config.targetEntity),
            `integration-batch-${operationId}-${sourceRecord.id ?? 'unknown'}`,
          );
          recordsSuccessful++;
        } catch (error) {
          recordsFailed++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`Record ${sourceRecord.id}: ${errorMessage}`);
          scope.logger.error(`Failed to sync record ${sourceRecord.id}`, error);
        }
        recordsProcessed++;
      };

      // Execute sync with concurrency control
      await Promise.all(
        sourceRecords.map(record => limit(() => processRecord(record)))
      );

      const status = recordsFailed === 0 ? 'success' : recordsSuccessful > 0 ? 'partial' : 'failed';
      const endTime = Date.now();

      scope.logger.info(`Sync completed: ${status}`, {
        recordsProcessed,
        recordsSuccessful,
        recordsFailed,
        duration: endTime - startTime,
      });

      return {
        integrationId: config.id,
        syncId: operationId,
        status,
        success: status === 'success',
        recordsProcessed,
        recordsSuccessful,
        recordsFailed,
        errors,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      scope.logger.error('Sync execution failed', error);
      
      return {
        integrationId: config.id,
        syncId: operationId,
        status: 'failed',
        success: false,
        recordsProcessed,
        recordsSuccessful,
        recordsFailed,
        errors: [errorMessage],
        startTime: new Date(startTime),
        endTime: new Date(),
      };
    }
  }

  /**
   * Sync a single record between systems
   */
  async syncSingleRecord(
    config: IntegrationConfig, 
    recordId: string, 
    options: SyncOptions = {}
  ): Promise<SyncResult> {
    const { dryRun = false, skipValidation = false } = options;
    const operationId = uuidv4();
    const startTime = Date.now();

    try {
      // Get connectors
      const sourceSystemType = getSystemType(config.sourceSystem);
      const targetSystemType = getSystemType(config.targetSystem);
      
      const sourceConnector = await this.connectorManager.getConnector(
        sourceSystemType, 
        `${sourceSystemType}_${config.id}`
      );
      const targetConnector = await this.connectorManager.getConnector(
        targetSystemType, 
        `${targetSystemType}_${config.id}`
      );

      // Fetch the specific record
      const sourceRecord = await sourceConnector.read(config.sourceEntity, recordId);
      if (!sourceRecord) {
        throw new Error(`Record ${recordId} not found in ${sourceSystemType}`);
      }

      // Sync the record
      await this.syncRecord(
        sourceRecord,
        sourceConnector,
        targetConnector,
        config,
        { dryRun, skipValidation },
        toSourceSystem(sourceSystemType, config.targetEntity),
        toSourceSystem(targetSystemType, config.targetEntity),
        `integration-single-${operationId}-${recordId}`,
      );

      return {
        integrationId: config.id,
        syncId: operationId,
        status: 'success',
        success: true,
        recordsProcessed: 1,
        recordsSuccessful: 1,
        recordsFailed: 0,
        errors: [],
        startTime: new Date(startTime),
        endTime: new Date(),
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        integrationId: config.id,
        syncId: operationId,
        status: 'failed',
        success: false,
        recordsProcessed: 1,
        recordsSuccessful: 0,
        recordsFailed: 1,
        errors: [errorMessage],
        startTime: new Date(startTime),
        endTime: new Date(),
      };
    }
  }

  /**
   * Sync a single record between connectors
   */
  private async syncRecord(
    sourceRecord: DataRecord,
    sourceConnector: IConnector,
    targetConnector: IConnector,
    config: IntegrationConfig,
    options: { dryRun?: boolean; skipValidation?: boolean } = {},
    sourceSystem: SourceSystem = 'squire',
    targetSystem: SourceSystem = 'squire',
    correlationId = `integration-${uuidv4()}`,
  ): Promise<void> {
    const { dryRun = false, skipValidation = false } = options;

    // Transform the record
    const transformedRecord = await this.transformationEngine.transformRecord(
      sourceRecord,
      config.fieldMappings || [],
      config.transformationRules || []
    );

    if (!skipValidation) {
      // Note: Validation would need to be implemented separately
      // as the current TransformationEngine doesn't have a validate method
      this.logger.debug('Validation skipped - not implemented in current TransformationEngine');
    }

    if (dryRun) {
      this.logger.debug('Dry run - would sync record', {
        sourceId: sourceRecord.id,
        transformedRecord,
      });
      return;
    }

    // Check if record exists in target system
    const recordId = sourceRecord.id;
    if (!recordId) {
      throw new Error('Source record must have an id field');
    }

    let existingRecord: DataRecord | null = null;
    try {
      existingRecord = await targetConnector.read(config.targetEntity, recordId);
    } catch (error) {
      if (!isNotFoundReadError(error)) {
        // Auth/rate-limit/network failure — NOT proof the record is absent.
        // Rethrow so the sync fails instead of duplicating the record.
        throw error;
      }
      // 404-shaped: safe to take the create branch (connectors that throw on
      // not-found instead of returning null per the base contract).
    }

    // Perform create or update — routed through guardedWrite for ownership audit.
    if (existingRecord) {
      await guardedWrite(
        {
          context: {
            // Copilot R12: carry the tenant-bound config's tenantId so any
            // queue_for_human approval/audit row is attributed to the owning
            // tenant instead of '__system__'. Falls back to SYSTEM_IDENTITY for
            // legacy configs that pre-date IntegrationConfig.tenantId.
            tenantId: config.tenantId ?? SYSTEM_IDENTITY.tenantId,
            // Copilot R5 on PR #851: callerSystem is the mapped source system
            // so guardedWrite's detectLoop step runs for source↔target syncs.
            callerSystem: sourceSystem,
            targetSystem,
            // Copilot R10 on PR #851: normalize to canonical manifest entity.
            entity: canonicalEntityFor(config.targetEntity) as CanonicalEntity,
            recordId,
            correlationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'update',
          },
          do: () => targetConnector.update(config.targetEntity, recordId, transformedRecord),
        },
        { ownershipResolver: this.ownershipResolver, auditService: this.auditService, approvalQueueService: this.approvalQueueService },
      );
      this.logger.debug(`Updated record ${recordId} in target system`);
    } else {
      await guardedWrite(
        {
          context: {
            // See update branch for tenantId rationale (Copilot R12).
            tenantId: config.tenantId ?? SYSTEM_IDENTITY.tenantId,
            // Copilot R5 on PR #851: callerSystem is the mapped source system.
            callerSystem: sourceSystem,
            targetSystem,
            // Copilot R10 on PR #851: normalize to canonical manifest entity.
            entity: canonicalEntityFor(config.targetEntity) as CanonicalEntity,
            recordId,
            correlationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'create',
          },
          do: () => targetConnector.create(config.targetEntity, transformedRecord),
        },
        { ownershipResolver: this.ownershipResolver, auditService: this.auditService, approvalQueueService: this.approvalQueueService },
      );
      this.logger.debug(`Created record ${recordId} in target system`);
    }
  }

  /**
   * Test sync execution without actually performing the sync
   */
  async testSync(config: IntegrationConfig, sampleSize = 5): Promise<{
    canConnect: boolean;
    sampleRecords: DataRecord[];
    transformationPreview: DataRecord[];
    validationResults: { isValid: boolean; errors: string[] }[];
    errors: string[];
  }> {
    const errors: string[] = [];
    let canConnect = false;
    let sampleRecords: DataRecord[] = [];
    const transformationPreview: DataRecord[] = [];
    const validationResults: { isValid: boolean; errors: string[] }[] = [];

    try {
      // Test connectivity
      const sourceSystemType = getSystemType(config.sourceSystem);
      const targetSystemType = getSystemType(config.targetSystem);
      
      const sourceConnector = await this.connectorManager.getConnector(
        sourceSystemType, 
        `${sourceSystemType}_test`
      );
      const targetConnector = await this.connectorManager.getConnector(
        targetSystemType, 
        `${targetSystemType}_test`
      );

      // Test connections
      const sourceTest = await sourceConnector.testConnection();
      const targetTest = await targetConnector.testConnection();

      if (!sourceTest.isConnected) {
        errors.push(`Source system connection failed: ${sourceTest.errorMessage}`);
      }
      if (!targetTest.isConnected) {
        errors.push(`Target system connection failed: ${targetTest.errorMessage}`);
      }

      canConnect = sourceTest.isConnected && targetTest.isConnected;

      if (canConnect) {
        // Fetch sample records
        sampleRecords = await sourceConnector.list(config.sourceEntity, {
          limit: sampleSize,
          offset: 0,
        });

        // Test transformations
        for (const record of sampleRecords) {
          try {
            const transformed = await this.transformationEngine.transformRecord(
              record,
              config.fieldMappings || [],
              config.transformationRules || []
            );
            transformationPreview.push(transformed as DataRecord);

            // Note: Validation would need to be implemented separately
            validationResults.push({
              isValid: true,
              errors: [],
            });
          } catch (error) {
            errors.push(`Transformation failed for record ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
            validationResults.push({
              isValid: false,
              errors: [error instanceof Error ? error.message : String(error)],
            });
          }
        }
      }

    } catch (error) {
      errors.push(`Test execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      canConnect,
      sampleRecords,
      transformationPreview,
      validationResults,
      errors,
    };
  }
}

export default IntegrationExecutor;