import { injectable, inject } from 'inversify';
import { ERROR_CODES, INTEGRATION_CONSTANTS } from '../../constants/systemConstants';
import { NotFoundError } from '../../errors/NotFoundError';
import type { IntegrationConfig, SyncResult } from '../../types';
import type { Logger } from '../../utils/Logger';
import type { ObservabilityService } from '../../observability';
import type { ConfigurationService } from '../ConfigurationService';
import { ConnectorManager } from './ConnectorManager';
import { IntegrationStatusManager } from './IntegrationStatusManager';
import { IntegrationExecutor, type SyncOptions } from './IntegrationExecutor';
import { TYPES } from '../../inversify/types';
import { env } from '../../config/env';
import { adaptScopeLogger } from '../../utils/loggerAdapter';

/**
 * Rate limiting status information
 */
export interface RateLimitStatus {
  maxConcurrent: number;
  currentRunning: number;
  available: number;
  isAtLimit: boolean;
}

/**
 * System health information
 */
export interface SystemHealth {
  totalConfigurations: number;
  activeConfigurations: number;
  runningIntegrations: number;
  rateLimitStatus: RateLimitStatus;
  systemStatus: Record<string, boolean>;
  connectorStats: {
    totalConnectors: number;
    connectorsByType: Record<string, number>;
    activeConnections: number;
  };
  integrationMetrics: {
    totalIntegrations: number;
    runningIntegrations: number;
    successfulRuns: number;
    failedRuns: number;
    averageRunTime: number;
    totalRecordsProcessed: number;
    errorRate: number;
    uptime: number;
  };
}

/**
 * Helper function to extract system type string from SystemConfig union type
 */
function getSystemType(system: string | { type: string }): string {
  return typeof system === 'string' ? system : system.type;
}

/**
 * Main orchestrator service that coordinates integration operations
 * This is the new simplified IntegrationService that delegates to specialized services
 */
@injectable()
export class IntegrationOrchestrator {
  private readonly logger: Logger;
  private readonly configService: ConfigurationService;
  private readonly connectorManager: ConnectorManager;
  private readonly statusManager: IntegrationStatusManager;
  private readonly executor: IntegrationExecutor;
  private readonly observabilityService: ObservabilityService;
  private readonly maxConcurrentIntegrations: number;

  constructor(
    logger: Logger,
    configService: ConfigurationService,
    connectorManager: ConnectorManager,
    statusManager: IntegrationStatusManager,
    executor: IntegrationExecutor,
    observabilityService?: ObservabilityService,
  ) {
    this.logger = logger;
    this.configService = configService;
    this.connectorManager = connectorManager;
    this.statusManager = statusManager;
    this.executor = executor;
    this.observabilityService = observabilityService ?? ({} as ObservabilityService);
    this.maxConcurrentIntegrations =
      env.MAX_CONCURRENT_INTEGRATIONS || INTEGRATION_CONSTANTS.MAX_CONCURRENT_INTEGRATIONS;
  }

  /**
   * Initialize the orchestrator and all its services
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing Integration Orchestrator');

    // Load configurations
    await this.configService.loadConfigurations();

    // Initialize connectors and status for active configurations
    const activeConfigs = this.configService.getAllConfigurations().filter(config => config.isActive);
    
    for (const config of activeConfigs) {
      await this.connectorManager.initializeConnectorsForConfig(config);
      this.statusManager.initializeStatus(config.id);
    }

    this.logger.info(`Integration Orchestrator initialized with ${activeConfigs.length} active configurations`);
  }

  /**
   * Run an integration with full orchestration
   */
  async runIntegration(configId: string, options: SyncOptions = {}): Promise<SyncResult> {
    return this.runIntegrationWithOptionalTenant(undefined, configId, options);
  }

  async runIntegrationForTenant(tenantId: string, configId: string, options: SyncOptions = {}): Promise<SyncResult> {
    return this.runIntegrationWithOptionalTenant(tenantId, configId, options);
  }

  private async runIntegrationWithOptionalTenant(tenantId: string | undefined, configId: string, options: SyncOptions): Promise<SyncResult> {
    // Tenant resolution MUST run before isRunning / rate-limit checks
    // (Copilot R10). See IntegrationService.runIntegrationWithOptionalTenant
    // for the rationale — otherwise the deployment-global running-integrations
    // set leaks status for another tenant's config id.
    const config = this.resolveConfiguration(configId, tenantId);
    if (!config) {
      throw new NotFoundError(`Configuration ${configId} not found`);
    }

    // Check if already running
    if (this.statusManager.isRunning(configId)) {
      throw new Error(`Integration ${configId} is already running`);
    }

    // Check rate limiting
    const runningCount = this.statusManager.getRunningIntegrations().size;
    if (runningCount >= this.maxConcurrentIntegrations) {
      const error = new Error(
        `Maximum concurrent integrations (${this.maxConcurrentIntegrations}) exceeded. Currently running: ${runningCount}`
      );
      error.name = ERROR_CODES.RATE_LIMIT_EXCEEDED;
      throw error;
    }

    if (!config.isActive) {
      throw new Error(`Configuration ${configId} is not active`);
    }

    // Mark as running
    this.statusManager.markAsRunning(configId);

    // Create observability scope
    const scope = this.observabilityService.createScope({
      integrationId: configId,
      operationId: `run_${Date.now()}`,
    });

    const startTime = Date.now();

    try {
      scope.logger.info(`Starting integration: ${config.name}`);
      scope.metrics.incrementActiveIntegrations();

      // Execute the integration
      const result = await this.executor.executeSync(config, options);
      const duration = Date.now() - startTime;

      // Update status
      this.statusManager.markAsCompleted(configId, result, duration);

      // Record metrics
      scope.metrics.recordIntegrationRun(
        configId,
        result.status === 'success' ? 'success' : (result.status === 'partial' ? 'success' : 'failure'),
        duration,
        result.recordsProcessed,
      );

      try {
        const sLogger = adaptScopeLogger(scope.logger);
        sLogger.info(`Integration completed: ${config.name}`, {
          status: result.status,
          recordsProcessed: result.recordsProcessed,
          recordsSuccessful: result.recordsSuccessful,
          recordsFailed: result.recordsFailed,
          duration,
        });
      } catch (_) {
        /* ignore logging errors in demo */
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update status
      this.statusManager.markAsFailed(configId, errorMessage, duration);

      // Record metrics
  scope.metrics.recordIntegrationRun(configId, 'failure', duration);

      try {
        const sLogger = adaptScopeLogger(scope.logger);
        sLogger.error(`Integration failed: ${config.name}`, error, { duration });
      } catch (_) {
        /* ignore logging errors in demo */
      }

      throw error;
    } finally {
      scope.metrics.decrementActiveIntegrations();
    }
  }

  /**
   * Test an integration configuration
   */
  async testIntegration(configId: string): Promise<unknown> {
    return this.testIntegrationWithOptionalTenant(undefined, configId);
  }

  async testIntegrationForTenant(tenantId: string, configId: string): Promise<unknown> {
    return this.testIntegrationWithOptionalTenant(tenantId, configId);
  }

  private async testIntegrationWithOptionalTenant(tenantId: string | undefined, configId: string): Promise<unknown> {
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

      // Test sync execution
      const syncTest = await this.executor.testSync(config);
      
      if (!syncTest.canConnect) {
        errors.push(...syncTest.errors);
      }

      // Test connector connections
      const sourceSystemType = getSystemType(config.sourceSystem);
      const targetSystemType = getSystemType(config.targetSystem);
      
      const sourceAuth = config.sourceAuthentication ?? config.authentication?.source;
      const targetAuth = config.targetAuthentication ?? config.authentication?.target;

      if (sourceAuth) {
        const sourceTest = await this.connectorManager.testConnector(sourceSystemType, sourceAuth);
        if (!sourceTest.isConnected) {
          errors.push(`Source system test failed: ${sourceTest.errorMessage}`);
        }
      }

      if (targetAuth) {
        const targetTest = await this.connectorManager.testConnector(targetSystemType, targetAuth);
        if (!targetTest.isConnected) {
          errors.push(`Target system test failed: ${targetTest.errorMessage}`);
        }
      }

      return {
        configId,
        configName: config.name,
        isValid: errors.length === 0,
        errors,
        warnings,
        connectivity: {
          canConnect: syncTest.canConnect,
          sampleRecords: syncTest.sampleRecords.length,
          transformationPreview: syncTest.transformationPreview,
          validationResults: syncTest.validationResults,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      errors.push(`Test execution failed: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        configId,
        configName: config.name,
        isValid: false,
        errors,
        warnings,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Sync a single record
   */
  async syncSingleRecord(configId: string, recordId: string): Promise<SyncResult> {
    return this.syncSingleRecordWithOptionalTenant(undefined, configId, recordId);
  }

  async syncSingleRecordForTenant(tenantId: string, configId: string, recordId: string): Promise<SyncResult> {
    return this.syncSingleRecordWithOptionalTenant(tenantId, configId, recordId);
  }

  private async syncSingleRecordWithOptionalTenant(tenantId: string | undefined, configId: string, recordId: string): Promise<SyncResult> {
    const config = this.resolveConfiguration(configId, tenantId);
    if (!config) {
      // NotFoundError so the route catch maps to 404 (Copilot R11; matches
      // the run/test ForTenant methods after R8).
      throw new NotFoundError(`Configuration ${configId} not found`);
    }

    return await this.executor.syncSingleRecord(config, recordId);
  }

  private resolveConfiguration(configId: string, tenantId?: string) {
    if (tenantId) {
      return this.configService.getConfigurationForTenant(tenantId, configId);
    }
    // Deliberate background/system escape hatch — NOT a pending migration.
    // Callers without a request tenant keep the historical deployment-global
    // lookup; request paths use the ForTenant variants above.
    return this.configService.getConfiguration(configId);
  }

  /**
   * Stop a running integration
   */
  async stopIntegration(configId: string): Promise<boolean> {
    if (!this.statusManager.isRunning(configId)) {
      return false;
    }

    // Note: In a real implementation, you'd need to implement cancellation
    // For now, we just mark it as stopped
    this.statusManager.updateStatus(configId, { isRunning: false });
    this.logger.info(`Integration ${configId} stop requested`);
    
    return true;
  }

  /**
   * Get integration status
   */
  getIntegrationStatus(configId: string) {
    return this.statusManager.getStatus(configId);
  }

  /**
   * Get all integration statuses
   */
  getAllIntegrationStatuses() {
    return this.statusManager.getAllStatuses();
  }

  /**
   * Get rate limiting status
   */
  getRateLimitStatus(): RateLimitStatus {
    const currentRunning = this.statusManager.getRunningIntegrations().size;
    
    return {
      maxConcurrent: this.maxConcurrentIntegrations,
      currentRunning,
      available: Math.max(0, this.maxConcurrentIntegrations - currentRunning),
      isAtLimit: currentRunning >= this.maxConcurrentIntegrations,
    };
  }

  /**
   * Get comprehensive system health
   */
  async getSystemHealth(): Promise<SystemHealth> {
    const configs = this.configService.getAllConfigurations();
    const activeConfigs = configs.filter(c => c.isActive);
    const connectorStats = this.connectorManager.getConnectorStats();
    const integrationMetrics = this.statusManager.getMetrics();

    // Test system connectivity
    const systemStatus: Record<string, boolean> = {};
    const systemTypes = [
      ...new Set([
        ...configs.map(c => getSystemType(c.sourceSystem)),
        ...configs.map(c => getSystemType(c.targetSystem)),
      ]),
    ];

    for (const systemType of systemTypes) {
      // Find auth configuration for this system type
      let authConfig = undefined;
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
        continue;
      }

      try {
        const testResult = await this.connectorManager.testConnector(systemType, authConfig);
        systemStatus[systemType] = testResult.isConnected;
      } catch (error) {
        systemStatus[systemType] = false;
        this.logger.error(`Health check error for ${systemType}`, error);
      }
    }

    return {
      totalConfigurations: configs.length,
      activeConfigurations: activeConfigs.length,
      runningIntegrations: this.statusManager.getRunningIntegrations().size,
      rateLimitStatus: this.getRateLimitStatus(),
      systemStatus,
      connectorStats,
      integrationMetrics,
    };
  }

  /**
   * Shutdown the orchestrator and all services
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Integration Orchestrator');
    
    // Stop all running integrations
    const runningIntegrations = this.statusManager.getRunningIntegrations();
    for (const configId of runningIntegrations) {
      await this.stopIntegration(configId);
    }

    // Shutdown connectors
    await this.connectorManager.shutdown();

    // Clear status
    this.statusManager.clearAll();

    this.logger.info('Integration Orchestrator shutdown complete');
  }
}

export default IntegrationOrchestrator;