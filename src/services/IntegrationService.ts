import { inject, injectable, optional } from 'inversify';
import { uuidv4 } from '../utils/uuid';
import pLimit from 'p-limit';
import { getConnectorRegistration } from '../connectors/connectorRegistry';
import type { OutboundGovernanceService } from './governance/OutboundGovernanceService';
import { ERROR_CODES, INTEGRATION_CONSTANTS } from '../constants/systemConstants';
import { NotFoundError } from '../errors/NotFoundError';
import type { IConnector } from '../interfaces/IConnector';
import { TYPES } from '../inversify/types';
import type { ObservabilityService } from '../observability';
import type { DataRecord, IntegrationConfig, SyncResult, SystemConfig, AuthenticationConfig } from '../types';
import type { Logger } from '../utils/Logger';
import { adaptScopeLogger } from '../utils/loggerAdapter';
import type { AuthService } from './AuthService';
import type { ConfigurationService } from './ConfigurationService';
import type { TransformationContext, TransformationEngine } from './TransformationEngine';
import { env } from '../config/env';
import { guardedWrite, type GuardedWriteDeps } from '../governance/sourceOfTruth/guardedWrite';
import { canonicalEntityFor } from '../governance/sourceOfTruth/canonicalEntity';
import { isCanonicalEntity } from '../governance/sourceOfTruth/SourceOfTruthManifest';
import type { OwnershipResolver } from '../governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from './ai/orchestrator/AuditService';
import type { ApprovalQueueService } from './governance/ApprovalQueueService';
import type { CanonicalEntity, SourceSystem } from '../governance/sourceOfTruth/SourceOfTruthManifest';
import { SYSTEM_IDENTITY } from './governance/identityContext';

/**
 * Helper function to extract system type string from SystemConfig union type
 */
function getSystemType(system: string | SystemConfig): string {
  return typeof system === 'string' ? system : system.type;
}

/**
 * Maps an IntegrationService system-type string (PascalCase registry key or
 * raw SourceSystem snake_case) to a SourceSystem. Unmapped system types
 * fail fast for canonical-entity writes and fall back to 'squire' otherwise
 * — see toSourceSystem.
 */
const SYSTEM_TYPE_TO_SOURCE_SYSTEM: Record<string, SourceSystem> = {
  netsuite: 'netsuite',
  NetSuite: 'netsuite',
  salesforce: 'salesforce',
  Salesforce: 'salesforce',
  businesscentral: 'business_central',
  BusinessCentral: 'business_central',
  // Copilot R10 on PR #851: identity mapping for the canonical manifest
  // spelling. Configs already in manifest vocabulary (e.g. read from the
  // manifest itself) would otherwise fall through to the 'squire' default
  // and misattribute Business Central writes in audit + loop detection.
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

export interface SyncOptions {
  batchSize?: number;
  dryRun?: boolean;
  skipValidation?: boolean;
  concurrency?: number;
}

export interface IntegrationStatus {
  configId: string;
  isRunning: boolean;
  lastSync?: Date;
  lastSyncResult?: SyncResult;
  nextScheduledSync?: Date;
  errorCount: number;
  successCount: number;
}

/**
 * Service responsible for managing and executing integration flows.
 * Handles running, testing, and monitoring integrations, and orchestrates data synchronization.
 */
@injectable()
export class IntegrationService {
  private readonly logger: Logger;
  private readonly transformationEngine: TransformationEngine;
  public configService: ConfigurationService;
  private readonly connectors = new Map<string, IConnector>();
  private readonly runningIntegrations = new Set<string>();
  private readonly integrationStatus = new Map<string, IntegrationStatus>();
  private readonly observabilityService: ObservabilityService;
  private readonly outboundGovernance: OutboundGovernanceService;
  private readonly maxConcurrentIntegrations: number;
  private readonly ownershipResolver: OwnershipResolver;
  private readonly auditService: AuditService;
  private readonly approvalQueueService: ApprovalQueueService;
  // Hoisted once in the constructor so per-record syncs reuse the same deps
  // object instead of allocating `{ownershipResolver, auditService,
  // approvalQueueService}` on every guardedWrite call. Codex R13 on PR #851
  // flagged the per-call churn as the likely source of the 500-record perf
  // regression (heap > 50 MB).
  private readonly guardedWriteDeps!: GuardedWriteDeps;

  /**
   * Creates an instance of IntegrationService.
   * @param {Logger} logger - The logger instance.
   * @param {TransformationEngine} transformationEngine - The transformation engine instance.
   * @param {ConfigurationService} configService - The configuration service instance.
   * @param {AuthService} authService - The authentication service instance.
   */
  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.TransformationEngine) transformationEngine: TransformationEngine,
    @inject(TYPES.ConfigurationService) configService: ConfigurationService,
    @inject(TYPES.AuthService) private readonly authService: AuthService,
    @inject(TYPES.ObservabilityService) observabilityService?: ObservabilityService,
    @optional() @inject(TYPES.OutboundGovernanceService) outboundGovernance?: OutboundGovernanceService,
    @optional() @inject(TYPES.OwnershipResolver) ownershipResolver?: OwnershipResolver,
    @optional() @inject(TYPES.AuditService) auditService?: AuditService,
    @optional() @inject(TYPES.ApprovalQueueService) approvalQueueService?: ApprovalQueueService,
  ) {
    this.logger = logger || console as any;
    this.transformationEngine = transformationEngine;
    this.configService = configService;
    // Assign ObservabilityService or use no-op stub
    this.observabilityService = observabilityService ?? ({} as ObservabilityService);
    if (!outboundGovernance) {
      throw new Error('OutboundGovernanceService is required for IntegrationService outbound protection');
    }
    this.outboundGovernance = outboundGovernance;
    this.maxConcurrentIntegrations =
      env.MAX_CONCURRENT_INTEGRATIONS || INTEGRATION_CONSTANTS.MAX_CONCURRENT_INTEGRATIONS;
    if (!ownershipResolver) {
      throw new Error('OwnershipResolver is required for IntegrationService write governance');
    }
    this.ownershipResolver = ownershipResolver;
    if (!auditService) {
      throw new Error('AuditService is required for IntegrationService write governance');
    }
    this.auditService = auditService;
    if (!approvalQueueService) {
      throw new Error('ApprovalQueueService is required for IntegrationService write governance');
    }
    this.approvalQueueService = approvalQueueService;
    this.guardedWriteDeps = {
      ownershipResolver: this.ownershipResolver,
      auditService: this.auditService,
      approvalQueueService: this.approvalQueueService,
    };
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Integration Service');

    // Load configurations
    await this.configService.loadConfigurations();

    // Initialize connectors for active configurations
    const activeConfigs = this.configService.getAllConfigurations().filter(config => config.isActive);
    for (const config of activeConfigs) {
      await this.initializeConnectorsForConfig(config);
    }

    this.logger.info(`Integration Service initialized with ${activeConfigs.length} active configurations`);
  }

  async runIntegration(configId: string, options: SyncOptions = {}): Promise<SyncResult> {
    return this.runIntegrationWithOptionalTenant(undefined, configId, options);
  }

  async runIntegrationForTenant(tenantId: string, configId: string, options: SyncOptions = {}): Promise<SyncResult> {
    return this.runIntegrationWithOptionalTenant(tenantId, configId, options);
  }

  private async runIntegrationWithOptionalTenant(tenantId: string | undefined, configId: string, options: SyncOptions): Promise<SyncResult> {
    // Tenant resolution MUST run before the global isRunning / rate-limit
    // checks (Copilot R10). Otherwise a cross-tenant or nonexistent configId
    // can surface "already running" or RATE_LIMIT_EXCEEDED from another
    // tenant's state — info leak about the owning tenant's runtime. Resolve
    // the config first and 404 cross-tenant probes before touching the
    // shared running-integrations set.
    const config = this.resolveConfiguration(configId, tenantId);
    if (!config) {
      // NotFoundError so the route catch maps to 404 (consistent with
      // testIntegrationForTenant + syncSingleRecordForTenant). Plain Error
      // here would map to 500 and mask the cross-tenant rejection (Copilot R8).
      throw new NotFoundError(`Configuration ${configId} not found`);
    }

    if (this.runningIntegrations.has(configId)) {
      throw new Error(`Integration ${configId} is already running`);
    }

    // Check rate limiting
    if (this.runningIntegrations.size >= this.maxConcurrentIntegrations) {
      const error = new Error(`Maximum concurrent integrations (${this.maxConcurrentIntegrations}) exceeded. Currently running: ${this.runningIntegrations.size}`);
      error.name = ERROR_CODES.RATE_LIMIT_EXCEEDED;
      throw error;
    }

    if (!config.isActive) {
      throw new Error(`Configuration ${configId} is not active`);
    }

    this.runningIntegrations.add(configId);
    this.updateIntegrationStatus(configId, { isRunning: true });

    const operationId = uuidv4();
    const scope = this.observabilityService.createScope({
      integrationId: configId,
      operationId,
    });

    const startTime = Date.now();

    try {
      scope.logger.info(`Starting integration: ${config.name}`);
      scope.metrics.incrementActiveIntegrations();
      const result = await this.executeSync(config, options);
      const duration = Date.now() - startTime;

      this.updateIntegrationStatus(configId, {
        isRunning: false,
        lastSync: new Date(),
        lastSyncResult: result,
        successCount: this.getIntegrationStatus(configId).successCount + (result.status === 'success' ? 1 : 0),
        errorCount: this.getIntegrationStatus(configId).errorCount + (result.status === 'failed' ? 1 : 0),
      });

      // Record metrics (status string, then duration)
      scope.metrics.recordIntegrationRun(
        configId,
        result.success ? 'success' : 'failure',
        duration,
        result.recordsProcessed ?? 0,
      );

      try {
        const sLogger = adaptScopeLogger(scope.logger);
        sLogger.info(`Integration completed: ${config.name}`, { status: result.status, recordsProcessed: result.recordsProcessed, recordsSuccessful: result.recordsSuccessful, recordsFailed: result.recordsFailed, duration });
      } catch (_) { /* ignore logging errors in demo */ }

      return result;
    } catch (error) {
      this.updateIntegrationStatus(configId, {
        isRunning: false,
        errorCount: this.getIntegrationStatus(configId).errorCount + 1,
      });

  const duration = Date.now() - startTime;
  scope.metrics.recordIntegrationRun(configId, 'failure', duration, 0);
      try {
        const sLogger = adaptScopeLogger(scope.logger);
        sLogger.error(`Integration failed: ${config.name}`, error, { duration });
      } catch (_) { /* ignore logging errors in demo */ }
      throw error;
    } finally {
      this.runningIntegrations.delete(configId);
      scope.metrics.decrementActiveIntegrations();
    }
  }

  async testIntegration(configId: string): Promise<{
    isValid: boolean;
    sourceConnection: { isConnected: boolean; errorMessage?: string };
    targetConnection: { isConnected: boolean; errorMessage?: string };
    errors: string[];
    warnings: string[];
  }> {
    return this.testIntegrationWithOptionalTenant(undefined, configId);
  }

  async testIntegrationForTenant(tenantId: string, configId: string): Promise<{
    isValid: boolean;
    sourceConnection: { isConnected: boolean; errorMessage?: string };
    targetConnection: { isConnected: boolean; errorMessage?: string };
    errors: string[];
    warnings: string[];
  }> {
    return this.testIntegrationWithOptionalTenant(tenantId, configId);
  }

  private async testIntegrationWithOptionalTenant(tenantId: string | undefined, configId: string): Promise<{
    isValid: boolean;
    sourceConnection: { isConnected: boolean; errorMessage?: string };
    targetConnection: { isConnected: boolean; errorMessage?: string };
    errors: string[];
    warnings: string[];
  }> {
    const config = this.resolveConfiguration(configId, tenantId);
    if (!config) {
      throw new NotFoundError(`Configuration ${configId} not found`);
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Test configuration validity
      const validation = await this.configService.validateConfiguration(config);
      if (!validation.isValid) {
        errors.push(...validation.errors);
      }
      warnings.push(...validation.warnings);

      // Test connector connections
      const sourceSystemType = getSystemType(config.sourceSystem);
      const targetSystemType = getSystemType(config.targetSystem);
      const sourceConnector = await this.getConnector(sourceSystemType, `${sourceSystemType}_${configId}`);
      const targetConnector = await this.getConnector(targetSystemType, `${targetSystemType}_${configId}`);

      await sourceConnector.initialize(config.sourceAuthentication);
      const sourceStatus = await sourceConnector.testConnection();
      if (!sourceStatus.isConnected) {
        errors.push(`Source system connection failed: ${sourceStatus.errorMessage}`);
      }

      if (config.targetAuthentication) {
        await targetConnector.initialize(config.targetAuthentication);
      }
      const targetStatus = await targetConnector.testConnection();
      if (!targetStatus.isConnected) {
        errors.push(`Target system connection failed: ${targetStatus.errorMessage}`);
      }

      // Test transformation with sample data
      try {
        const sampleData: DataRecord = {
          id: 'test_001',
          externalId: 'test_ext_001',
          fields: { testField: 'testValue' },
          metadata: {
            source: 'test',
            lastModified: new Date(),
            version: '1.0',
          },
        };

        // Attempt to read a sample record from the source system if possible
        let actualSampleData: DataRecord | null = null;
        try {
          // This assumes a 'customer' entity exists and has at least one record
          const sampleRecords = await sourceConnector.list(config.sourceEntity, { limit: 1 });
          if (sampleRecords.length > 0) {
            actualSampleData = sampleRecords[0] || null;
            if (actualSampleData) {
              this.logger.debug(`Using actual sample data from ${config.sourceSystem}: ${actualSampleData.id}`);
            }
          } else {
            this.logger.warn(`No sample records found in ${config.sourceSystem} for entity ${config.sourceEntity}. Using mock data for transformation test.`);
          }
        } catch (err) {
          this.logger.warn(`Failed to retrieve sample data from ${config.sourceSystem}: ${err}. Using mock data for transformation test.`);
        }

        const transformationContext: TransformationContext = {
          sourceData: actualSampleData || sampleData,
          mappings: config.fieldMappings || [],
          rules: config.transformationRules || [],
        };

        const transformResult = await this.transformationEngine.transform(transformationContext);
        if (!transformResult.success) {
          warnings.push('Sample transformation failed - check field mappings and rules');
          errors.push(...transformResult.errors.map(e => `Transformation Error: ${e.message}`));
        }
      } catch (error) {
        warnings.push(`Transformation test failed: ${error}`);
      }

      return {
        isValid: errors.length === 0,
        sourceConnection: { isConnected: !!(sourceStatus && sourceStatus.isConnected), errorMessage: sourceStatus?.errorMessage },
        targetConnection: { isConnected: !!(targetStatus && targetStatus.isConnected), errorMessage: targetStatus?.errorMessage },
        errors,
        warnings,
      };
    } catch (error) {
      errors.push(`Test failed: ${error}`);
      return { isValid: false, sourceConnection: { isConnected: false, errorMessage: 'Test failed' }, targetConnection: { isConnected: false, errorMessage: 'Test failed' }, errors, warnings };
    }
  }

  async syncSingleRecord(configId: string, recordId: string): Promise<SyncResult> {
    return this.syncSingleRecordWithOptionalTenant(undefined, configId, recordId);
  }

  async syncSingleRecordForTenant(tenantId: string, configId: string, recordId: string): Promise<SyncResult> {
    return this.syncSingleRecordWithOptionalTenant(tenantId, configId, recordId);
  }

  private async syncSingleRecordWithOptionalTenant(tenantId: string | undefined, configId: string, recordId: string): Promise<SyncResult> {
    const config = this.resolveConfiguration(configId, tenantId);
    if (!config) {
      // NotFoundError so the route catch maps to 404 (Copilot R8).
      throw new NotFoundError(`Configuration ${configId} not found`);
    }

    const sourceSystemType = getSystemType(config.sourceSystem);
    const targetSystemType = getSystemType(config.targetSystem);
    const sourceConnector = await this.getConnector(sourceSystemType, `${sourceSystemType}_${configId}`);
    const targetConnector = await this.getConnector(targetSystemType, `${targetSystemType}_${configId}`);

    await sourceConnector.initialize(config.sourceAuthentication);
    if (config.targetAuthentication) {
      await targetConnector.initialize(config.targetAuthentication);
    }

    const startTime = new Date();
    const syncId = `single_${Date.now()}`;

    try {
      // Read record from source
      const sourceRecord = await sourceConnector.read(config.sourceEntity, recordId);
      if (!sourceRecord) {
        throw new Error(`Record ${recordId} not found in source system for entity ${config.sourceEntity}`);
      }

      // Transform record
      const transformationContext: TransformationContext = {
        sourceData: sourceRecord,
        mappings: config.fieldMappings || [],
        rules: config.transformationRules || [],
      };

      const transformResult = await this.transformationEngine.transform(transformationContext);
      if (!transformResult.success) {
        throw new Error(`Transformation failed: ${transformResult.errors.map(e => e.message).join(', ')}`);
      }

      // Write to target — routed through guardedWrite for ownership audit.
      // Copilot R5 on PR #851: use the mapped source system as callerSystem
      // so guardedWrite's detectLoop step runs (it only fires for real
      // SourceSystem callers via isSourceSystem narrowing). The previous
      // 'integration_engine' synthetic identity made single-record IntegrationService
      // writes blind to source↔target reciprocal-write loops.
      const _singleCorrelationId = `integration-single-${syncId}`;
      await guardedWrite(
        {
          context: {
            // Copilot R11: carry the tenant-bound config's tenantId through to
            // guardedWrite so any queue_for_human approval / audit row is
            // attributed to the owning tenant instead of '__system__'. Falls
            // back to SYSTEM_IDENTITY for legacy configs that pre-date the
            // IntegrationConfig.tenantId field.
            tenantId: config.tenantId ?? SYSTEM_IDENTITY.tenantId,
            callerSystem: toSourceSystem(sourceSystemType, config.targetEntity),
            targetSystem: toSourceSystem(targetSystemType, config.targetEntity),
            // Copilot R10 on PR #851: normalize connector record type
            // (`Customer`, `customers`, ...) to canonical manifest entity
            // (`customer`) so OwnershipResolver evaluates the policy.
            entity: canonicalEntityFor(config.targetEntity) as CanonicalEntity,
            correlationId: _singleCorrelationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'create',
          },
          do: () => targetConnector.create(config.targetEntity, transformResult.transformedData),
        },
        this.guardedWriteDeps,
      );

      return {
        integrationId: configId,
        syncId,
        status: 'success',
        success: true,
        recordsProcessed: 1,
        recordsSuccessful: 1,
        recordsFailed: 0,
        errors: [],
        startTime,
        endTime: new Date(),
      };
    } catch (error) {
      return {
        integrationId: configId,
        syncId,
        status: 'failed',
        success: false,
        recordsProcessed: 1,
        recordsSuccessful: 0,
        recordsFailed: 1,
        errors: [error instanceof Error ? error.message : String(error)],
        startTime,
        endTime: new Date(),
      };
    }
  }

  private resolveConfiguration(configId: string, tenantId?: string): IntegrationConfig | undefined {
    if (tenantId) {
      return this.configService.getConfigurationForTenant(tenantId, configId);
    }
    // Deliberate background/system escape hatch — NOT a pending migration. The
    // only callers without a request tenant are background jobs (e.g.
    // BatchProcessingService) and the dead route ternary branch; they keep the
    // historical deployment-global lookup. Every request path uses the ForTenant
    // variants above. Pinned by IntegrationService.core.test.ts.
    return this.configService.getConfiguration(configId);
  }

  getIntegrationStatus(configId: string): IntegrationStatus {
    if (!this.integrationStatus.has(configId)) {
      this.integrationStatus.set(configId, {
        configId,
        isRunning: false,
        errorCount: 0,
        successCount: 0,
      });
    }
    return this.integrationStatus.get(configId)!;
  }

  getAllIntegrationStatuses(): IntegrationStatus[] {
    return Array.from(this.integrationStatus.values());
  }

  /**
   * Persists the result of an ad-hoc sync operation.
   * @param {string} configId - Identifier for the integration flow.
   * @param {SyncResult} result - Result details of the sync.
   */
  recordSyncResult(configId: string, result: SyncResult): void {
    const current = this.getIntegrationStatus(configId);
    this.updateIntegrationStatus(configId, {
      lastSync: result.endTime,
      lastSyncResult: result,
      isRunning: false,
      successCount: current.successCount + (result.status === 'success' ? 1 : 0),
      errorCount: current.errorCount + (result.status === 'failed' ? 1 : 0),
    });
  }

  async stopIntegration(configId: string): Promise<boolean> {
    if (!this.runningIntegrations.has(configId)) {
      return false;
    }

    // In a real implementation, we would have more sophisticated cancellation
    this.runningIntegrations.delete(configId);
    this.updateIntegrationStatus(configId, { isRunning: false });

    this.logger.info(`Integration stopped: ${configId}`);
    return true;
  }

  private async executeSync(config: IntegrationConfig, options: SyncOptions): Promise<SyncResult> {
    const sourceSystemType = getSystemType(config.sourceSystem);
    const targetSystemType = getSystemType(config.targetSystem);
    const sourceConnector = await this.getConnector(sourceSystemType, `${sourceSystemType}_${config.id}`);
    const targetConnector = await this.getConnector(targetSystemType, `${targetSystemType}_${config.id}`);

    // Initialize connectors
    await sourceConnector.initialize(config.sourceAuthentication);
    if (config.targetAuthentication) {
      await targetConnector.initialize(config.targetAuthentication);
    }

    const startTime = new Date();
    const syncId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 2 + INTEGRATION_CONSTANTS.SYNC_ID_LENGTH)}`;
    const batchSize = options.batchSize || INTEGRATION_CONSTANTS.DEFAULT_BATCH_SIZE;
    const concurrency = Math.max(
      1,
      options.concurrency || parseInt(process.env.MAX_RECORD_CONCURRENCY || '5', 10),
    );
    const limit = pLimit(concurrency);

    let recordsProcessed = 0;
    let recordsSuccessful = 0;
    let recordsFailed = 0;
    const errors: SyncResult['errors'] = [];

    try {
      // Get records from source
      const sourceRecords = await sourceConnector.list(config.sourceEntity, { limit: batchSize });

      this.logger.info(`Retrieved ${sourceRecords.length} records from source system for entity ${config.sourceEntity}`);
      const processRecord = async (sourceRecord: DataRecord): Promise<void> => {
        try {
          const transformationContext: TransformationContext = {
            sourceData: sourceRecord,
            mappings: config.fieldMappings || [],
            rules: config.transformationRules || [],
          };

          const transformResult = await this.transformationEngine.transform(transformationContext);

          if (!transformResult.success) {
            throw new Error(`Transformation failed: ${transformResult.errors.map(e => e.message).join(', ')}`);
          }

          if (options.dryRun) {
            this.logger.debug(`DRY RUN: Would sync record ${sourceRecord.id}`);
            recordsSuccessful++;
          } else {
            await this.syncRecord(
              targetConnector,
              config.targetEntity,
              transformResult.transformedData,
              toSourceSystem(sourceSystemType, config.targetEntity),
              toSourceSystem(targetSystemType, config.targetEntity),
              `integration-batch-${syncId}-${sourceRecord.id ?? 'unknown'}`,
              config.tenantId,
            );
            recordsSuccessful++;
          }
        } catch (error) {
          recordsFailed++;
          errors.push(error instanceof Error ? error.message : String(error));
          this.logger.error(`Failed to sync record ${sourceRecord.id}`, error);
        } finally {
          recordsProcessed++;
        }
      };

      await Promise.allSettled(
        sourceRecords.map(record => limit(() => processRecord(record))),
      );

      const status: 'success' | 'partial' | 'failed' =
        recordsFailed === 0 ? 'success' :
          recordsSuccessful > 0 ? 'partial' : 'failed';

      return {
        integrationId: config.id,
        syncId,
        status,
        success: status === 'success',
        recordsProcessed,
        recordsSuccessful,
        recordsFailed,
        errors,
        startTime,
        endTime: new Date(),
      };
    } catch (error) {
      this.logger.error('Sync execution failed', error);
      throw error;
    }
  }

  private async syncRecord(
    targetConnector: IConnector,
    targetEntity: string,
    transformedRecord: DataRecord,
    sourceSystem: SourceSystem,
    targetSystem: SourceSystem,
    correlationId: string,
    // Tenant context for the downstream guardedWrite (Copilot R11). Undefined
    // for legacy callers that don't carry a tenant; SYSTEM_IDENTITY fallback
    // preserves prior behavior on those paths.
    tenantId?: string,
  ): Promise<void> {
    // Check if record exists in target
    let existingRecord: DataRecord | null = null;

    if (transformedRecord.id || transformedRecord.externalId) {
      const searchId = transformedRecord.id || transformedRecord.externalId!;
      existingRecord = await targetConnector.read(targetEntity, searchId);
    }

    if (existingRecord) {
      // Update existing record — routed through guardedWrite for ownership audit.
      // Copilot R5 on PR #851: callerSystem is the mapped source system (not
      // 'integration_engine') so detectLoop runs for source↔target syncs.
      await guardedWrite(
        {
          context: {
            tenantId: tenantId ?? SYSTEM_IDENTITY.tenantId,
            callerSystem: sourceSystem,
            targetSystem,
            // Copilot R10 on PR #851: normalize to canonical manifest entity.
            entity: canonicalEntityFor(targetEntity) as CanonicalEntity,
            recordId: existingRecord.id ?? undefined,
            correlationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'update',
          },
          do: () => targetConnector.update(targetEntity, existingRecord!.id!, transformedRecord),
        },
        this.guardedWriteDeps,
      );
      this.logger.debug(`Updated record ${existingRecord.id} in target system`);
    } else {
      // Create new record — routed through guardedWrite for ownership audit.
      // Copilot R5 on PR #851: callerSystem is the mapped source system.
      const created = await guardedWrite(
        {
          context: {
            tenantId: tenantId ?? SYSTEM_IDENTITY.tenantId,
            callerSystem: sourceSystem,
            targetSystem,
            // Copilot R10 on PR #851: normalize to canonical manifest entity.
            entity: canonicalEntityFor(targetEntity) as CanonicalEntity,
            correlationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'create',
          },
          do: () => targetConnector.create(targetEntity, transformedRecord),
        },
        this.guardedWriteDeps,
      );
      this.logger.debug(`Created record ${(created as DataRecord | undefined)?.id ?? 'unknown'} in target system`);
    }
  }

  private async getConnector(systemType: string, systemId: string): Promise<IConnector> {
    const connectorKey = `${systemType}_${systemId}`;

    if (this.connectors.has(connectorKey)) {
      return this.connectors.get(connectorKey)!;
    }

    // Map IntegrationService's PascalCase systemType to the registry's
    // lowercase key. Construction is then routed through the registry's
    // `factory` closure (PR 6A-2 — registry is single source of truth for
    // connector instantiation).
    const registryKeyMap: Record<string, string> = {
      NetSuite: 'netsuite',
      Dynamics365: 'dynamics',
      Salesforce: 'salesforce',
      SAP: 'sap',
      Oracle: 'oracle',
      BusinessCentral: 'businesscentral',
      SuiteCentral: 'suitecentral',
    };
    const registryKey = registryKeyMap[systemType];
    const entry = registryKey ? getConnectorRegistration(registryKey) : undefined;
    if (!entry?.factory) {
      throw new Error(`Unsupported system type: ${systemType}`);
    }
    const connector = entry.factory(systemId, {
      logger: this.logger,
      authService: this.authService,
      outboundGovernance: this.outboundGovernance,
    });

    this.connectors.set(connectorKey, connector);
    return connector;
  }

  private async initializeConnectorsForConfig(config: IntegrationConfig): Promise<void> {
    try {
      const sourceSystemType = getSystemType(config.sourceSystem);
      const targetSystemType = getSystemType(config.targetSystem);
      const sourceConnector = await this.getConnector(sourceSystemType, `${sourceSystemType}_${config.id}`);
      const targetConnector = await this.getConnector(targetSystemType, `${targetSystemType}_${config.id}`);

      await sourceConnector.initialize(config.sourceAuthentication);
      if (config.targetAuthentication) {
        await targetConnector.initialize(config.targetAuthentication);
      }

      this.logger.debug(`Initialized connectors for ${config.name}`);
    } catch (error) {
      this.logger.error(`Failed to initialize connectors for ${config.name}`, error);
    }
  }

  /**
   * Updates the internal status of an integration.
   * @param {string} configId - The ID of the integration configuration.
   * @param {Partial<IntegrationStatus>} updates - Partial object containing status updates.
   * @private
   */
  private updateIntegrationStatus(configId: string, updates: Partial<IntegrationStatus>): void {
    const currentStatus = this.getIntegrationStatus(configId);
    this.integrationStatus.set(configId, { ...currentStatus, ...updates });
  }

  getRateLimitStatus(): {
    currentRunning: number;
    maxConcurrent: number;
    available: number;
    isAtLimit: boolean;
    } {
    const currentRunning = this.runningIntegrations.size;
    const available = Math.max(0, this.maxConcurrentIntegrations - currentRunning);

    return {
      currentRunning,
      maxConcurrent: this.maxConcurrentIntegrations,
      available,
      isAtLimit: currentRunning >= this.maxConcurrentIntegrations,
    };
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Integration Service');

    // Stop all running integrations
    for (const configId of this.runningIntegrations) {
      try {
        this.logger.debug(`Stopping integration: ${configId}`);
        this.updateIntegrationStatus(configId, { isRunning: false });
      } catch (error) {
        this.logger.error(`Error stopping integration ${configId}:`, error);
      }
    }

    this.runningIntegrations.clear();
    this.logger.info('Integration Service shutdown complete');
  }

  /**
   * Get health status for disaster recovery integration
   */
  async getHealthStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'critical' | 'unknown';
    message?: string;
    metrics?: Record<string, unknown>;
  }> {
    const systemHealth = await this.getSystemHealth();
    const healthySystems = Object.values(systemHealth.systemStatus).filter(status => status).length;
    const totalSystems = Object.values(systemHealth.systemStatus).length;
    
    if (totalSystems === 0) {
      return { status: 'unknown', message: 'No systems configured' };
    }
    
    const healthPercentage = (healthySystems / totalSystems) * 100;
    
    if (healthPercentage >= 90) {
      return { 
        status: 'healthy', 
        message: `${healthySystems}/${totalSystems} systems healthy`,
        metrics: {
          healthySystemsCount: healthySystems,
          totalSystemsCount: totalSystems,
          healthPercentage,
          runningIntegrations: systemHealth.runningIntegrations,
          activeConfigurations: systemHealth.activeConfigurations
        }
      };
    } else if (healthPercentage >= 50) {
      return { 
        status: 'degraded', 
        message: `${healthySystems}/${totalSystems} systems healthy`,
        metrics: {
          healthySystemsCount: healthySystems,
          totalSystemsCount: totalSystems,
          healthPercentage,
          runningIntegrations: systemHealth.runningIntegrations,
          activeConfigurations: systemHealth.activeConfigurations
        }
      };
    } else {
      return { 
        status: 'critical', 
        message: `Only ${healthySystems}/${totalSystems} systems healthy`,
        metrics: {
          healthySystemsCount: healthySystems,
          totalSystemsCount: totalSystems,
          healthPercentage,
          runningIntegrations: systemHealth.runningIntegrations,
          activeConfigurations: systemHealth.activeConfigurations
        }
      };
    }
  }

  /**
   * Export integration states for backup
   */
  async exportStates(): Promise<unknown> {
    const integrationStates = Array.from(this.integrationStatus.entries()).map(([configId, status]) => status);
    
    const runningIntegrations = Array.from(this.runningIntegrations);
    
    return {
      integrationStates,
      runningIntegrations,
      connectorCount: this.connectors.size,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Import integration states from backup
   */
  async importStates(data: unknown): Promise<void> {
    if ((data as any).integrationStates) {
      this.integrationStatus.clear();
      for (const state of (data as any).integrationStates) {
        const { configId, ...status } = state;
        this.integrationStatus.set(configId, status);
      }
    }
    
    if ((data as any).runningIntegrations) {
      this.runningIntegrations.clear();
      for (const configId of (data as any).runningIntegrations) {
        this.runningIntegrations.add(configId);
      }
    }
    
    this.logger.info('Integration states imported successfully');
  }

  /**
   * Restart all integrations (for disaster recovery)
   */
  async restart(): Promise<void> {
    this.logger.info('Restarting Integration Service for disaster recovery');
    
    // Stop all running integrations
    await this.shutdown();
    
    // Reinitialize the service
    await this.initialize();
    
    this.logger.info('Integration Service restart completed');
  }

  async getSystemHealth(): Promise<{
    totalConfigurations: number;
    activeConfigurations: number;
    runningIntegrations: number;
    rateLimitStatus: ReturnType<IntegrationService['getRateLimitStatus']>;
    systemStatus: Record<string, boolean>;
  }> {
    const configs = this.configService.getAllConfigurations();
    const activeConfigs = configs.filter(c => c.isActive);

    const systemStatus: Record<string, boolean> = {};

    // Test connectivity for each system type
    const systemTypes = [
      ...new Set([
        ...configs.map(c => getSystemType(c.sourceSystem)),
        ...configs.map(c => getSystemType(c.targetSystem)),
      ]),
    ];

    for (const systemType of systemTypes) {
      // Find minimal auth configuration for this system type
      let authConfig: AuthenticationConfig | undefined;
      for (const config of configs) {
        if (getSystemType(config.sourceSystem) === systemType) {
          authConfig = config.sourceAuthentication ?? config.authentication?.source;
          break;
        }
        if (getSystemType(config.targetSystem) === systemType) {
          authConfig = config.targetAuthentication ?? config.authentication?.target;
          break;
        }
      }

      if (!authConfig) {
        systemStatus[systemType] = false;
        this.logger.error(`Health check failed for ${systemType}: missing authentication configuration`);
        continue;
      }

      try {
        const connector = await this.getConnector(systemType, `${systemType}_healthcheck`);
        await connector.initialize(authConfig);
        const status = await connector.testConnection();
        systemStatus[systemType] = status.isConnected;

        if (!status.isConnected) {
          this.logger.error(
            `Health check failed for ${systemType}: ${status.errorMessage ?? 'Unknown error'}`,
          );
        }
      } catch (error) {
        systemStatus[systemType] = false;
        this.logger.error(`Health check error for ${systemType}`, error);
      }
    }

    return {
      totalConfigurations: configs.length,
      activeConfigurations: activeConfigs.length,
      runningIntegrations: this.runningIntegrations.size,
      rateLimitStatus: this.getRateLimitStatus(),
      systemStatus,
    };
  }
}
