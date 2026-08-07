import { DynamicConfiguration, FileConfigurationSource, EnvironmentConfigurationSource } from '../utils/DynamicConfiguration';
import { AdvancedRetryManager, RetryConfigurations, type RetryMetrics } from '../utils/AdvancedRetryStrategies';
import { EventBus } from '../utils/EventBus';
import { logger } from '../utils/Logger';
import path from 'path';

export interface IntegrationConfig {
  // Circuit Breaker Configuration
  circuitBreaker: {
    enabled: boolean;
    defaultFailureThreshold: number;
    defaultResetTimeout: number;
    defaultMonitoringPeriod: number;
  };

  // Event System Configuration
  eventBus: {
    enabled: boolean;
    maxRetries: number;
    retryDelay: number;
    deadLetterQueueEnabled: boolean;
    metricsCollectionEnabled: boolean;
    maxQueueSize: number;
    overflowBehavior: 'persist' | 'reject';
  };

  // Dynamic Configuration
  dynamicConfig: {
    enabled: boolean;
    sources: {
      type: 'file' | 'environment';
      name: string;
      priority: number;
      path?: string;
      prefix?: string;
    }[];
    watchForChanges: boolean;
    validationEnabled: boolean;
  };

  // Advanced Retry Configuration
  retryStrategies: {
    enabled: boolean;
    defaultStrategy: 'exponential' | 'linear' | 'fixed' | 'fibonacci';
    adaptiveRetryEnabled: boolean;
    bulkheadEnabled: boolean;
    defaultBulkheadSize: number;
  };

  // System Integration Settings
  integration: {
    healthCheckInterval: number;
    metricsCollectionInterval: number;
    performanceMonitoringEnabled: boolean;
    autoRecoveryEnabled: boolean;
  };
}

export class SystemInfrastructureOrchestrator {
  private static instance: SystemInfrastructureOrchestrator;
  private config: IntegrationConfig;
  private readonly dynamicConfig: DynamicConfiguration;
  private readonly retryManager: AdvancedRetryManager;
  private eventBus!: EventBus;
  private initialized = false;
  private healthCheckInterval?: NodeJS.Timeout;
  private metricsInterval?: NodeJS.Timeout;

  private constructor() {
    this.dynamicConfig = DynamicConfiguration.getInstance();
    this.retryManager = AdvancedRetryManager.getInstance();

    // Default configuration
    this.config = this.getDefaultConfig();
  }

  public static getInstance(): SystemInfrastructureOrchestrator {
    if (!SystemInfrastructureOrchestrator.instance) {
      SystemInfrastructureOrchestrator.instance = new SystemInfrastructureOrchestrator();
    }
    return SystemInfrastructureOrchestrator.instance;
  }

  private getDefaultConfig(): IntegrationConfig {
    return {
      circuitBreaker: {
        enabled: true,
        defaultFailureThreshold: 5,
        defaultResetTimeout: 60000,
        defaultMonitoringPeriod: 60000,
      },
      eventBus: {
        enabled: true,
        maxRetries: 3,
        retryDelay: 1000,
        deadLetterQueueEnabled: true,
        metricsCollectionEnabled: true,
        maxQueueSize: 1000,
        overflowBehavior: 'persist',
      },
      dynamicConfig: {
        enabled: true,
        sources: [
          {
            type: 'file',
            name: 'main-config',
            priority: 100,
            path: path.join(process.cwd(), 'config', 'app.json'),
          },
          {
            type: 'environment',
            name: 'env-config',
            priority: 200,
            prefix: 'INTEGRATION_HUB_',
          },
        ],
        watchForChanges: true,
        validationEnabled: true,
      },
      retryStrategies: {
        enabled: true,
        defaultStrategy: 'exponential',
        adaptiveRetryEnabled: true,
        bulkheadEnabled: true,
        defaultBulkheadSize: 20,
      },
      integration: {
        healthCheckInterval: 30000, // 30 seconds
        metricsCollectionInterval: 60000, // 1 minute
        performanceMonitoringEnabled: true,
        autoRecoveryEnabled: true,
      },
    };
  }

  public async initialize(customConfig?: Partial<IntegrationConfig>): Promise<void> {
    if (this.initialized) {
      logger.warn('Integration orchestrator already initialized');
      return;
    }

    try {
      logger.info('Initializing Integration Orchestrator');

      // Merge custom configuration
      if (customConfig) {
        this.config = this.mergeConfigs(this.config, customConfig);
      }

      // Initialize Dynamic Configuration
      if (this.config.dynamicConfig.enabled) {
        await this.initializeDynamicConfiguration();
      }

      // Initialize Event Bus
      if (this.config.eventBus.enabled) {
        await this.initializeEventBus();
      }

      // Initialize Retry Manager
      if (this.config.retryStrategies.enabled) {
        await this.initializeRetryManager();
      }

      // Setup system monitoring
      if (this.config.integration.performanceMonitoringEnabled) {
        this.setupMonitoring();
      }

      // Setup health checks
      this.setupHealthChecks();

      // Setup event handlers for integration
      this.setupIntegrationEventHandlers();

      this.initialized = true;
      logger.info('Integration Orchestrator initialized successfully');

      // Emit initialization complete event
      this.eventBus.emit('system:integration:initialized', {
        timestamp: new Date(),
        config: this.config,
      });

    } catch (error) {
      logger.error('Failed to initialize Integration Orchestrator', { error });
      throw error;
    }
  }

  private async initializeDynamicConfiguration(): Promise<void> {
    logger.info('Initializing Dynamic Configuration');

    // Setup configuration schema
    this.dynamicConfig.setSchema({
      'app.name': {
        type: 'string',
        required: true,
        default: 'Integration Hub',
        description: 'Application name',
      },
      'app.version': {
        type: 'string',
        required: true,
        default: '1.0.0',
        description: 'Application version',
      },
      'server.port': {
        type: 'number',
        required: true,
        default: 3000,
        hotReloadable: true,
        description: 'Server port number',
      },
      'database.connectionString': {
        type: 'string',
        required: true,
        sensitive: true,
        description: 'Database connection string',
      },
      'logging.level': {
        type: 'string',
        required: true,
        default: 'info',
        hotReloadable: true,
        validation: (value) => ['debug', 'info', 'warn', 'error'].includes(value as string) || 'Invalid log level',
        description: 'Logging level',
      },
      'features.circuitBreaker': {
        type: 'boolean',
        required: false,
        default: true,
        hotReloadable: true,
        description: 'Enable circuit breaker pattern',
      },
      'features.eventBus': {
        type: 'boolean',
        required: false,
        default: true,
        hotReloadable: true,
        description: 'Enable event bus system',
      },
      'performance.maxConcurrentRequests': {
        type: 'number',
        required: false,
        default: 100,
        hotReloadable: true,
        description: 'Maximum concurrent requests',
      },
    });

    // Add configuration sources
    for (const sourceConfig of this.config.dynamicConfig.sources) {
      if (sourceConfig.type === 'file' && sourceConfig.path) {
        const source = new FileConfigurationSource(
          sourceConfig.name,
          sourceConfig.priority,
          sourceConfig.path,
        );
        this.dynamicConfig.addSource(source);
      } else if (sourceConfig.type === 'environment') {
        const source = new EnvironmentConfigurationSource(
          sourceConfig.name,
          sourceConfig.priority,
          sourceConfig.prefix || '',
        );
        this.dynamicConfig.addSource(source);
      }
    }

    // Load initial configuration
    await this.dynamicConfig.load();

    logger.info('Dynamic Configuration initialized', {
      sources: this.config.dynamicConfig.sources.length,
      watchEnabled: this.config.dynamicConfig.watchForChanges,
    });
  }

  private async initializeEventBus(): Promise<void> {
    logger.info('Initializing Event Bus');

    this.eventBus = EventBus.getInstance({
      maxQueueSize: this.config.eventBus.maxQueueSize,
      overflowBehavior: this.config.eventBus.overflowBehavior,
    });

    // Setup system event handlers
    this.eventBus.on('error', (error) => {
      logger.error('Event bus error', { error });
    });

    this.eventBus.on('event:retry', (data) => {
      logger.warn('Event retry', data);
    });

    this.eventBus.on('event:dead-letter', (data) => {
      logger.error('Event sent to dead letter queue', data);
    });

    logger.info('Event Bus initialized', {
      maxRetries: this.config.eventBus.maxRetries,
      deadLetterQueueEnabled: this.config.eventBus.deadLetterQueueEnabled,
      maxQueueSize: this.config.eventBus.maxQueueSize,
      overflowBehavior: this.config.eventBus.overflowBehavior,
    });
  }

  private async initializeRetryManager(): Promise<void> {
    logger.info('Initializing Retry Manager');

    // Setup default bulkheads
    if (this.config.retryStrategies.bulkheadEnabled) {
      this.retryManager.addBulkhead('default', this.config.retryStrategies.defaultBulkheadSize);
      this.retryManager.addBulkhead('critical', 5);
      this.retryManager.addBulkhead('background', 50);
    }

    // Setup retry event handlers
    this.retryManager.on('operationSuccess', (data) => {
      this.eventBus.emit('system:retry:success', data);
    });

    this.retryManager.on('operationFailed', (data) => {
      this.eventBus.emit('system:retry:failed', data);
    });

    this.retryManager.on('operationRetry', (data) => {
      this.eventBus.emit('system:retry:attempt', data);
    });

    logger.info('Retry Manager initialized', {
      defaultStrategy: this.config.retryStrategies.defaultStrategy,
      adaptiveEnabled: this.config.retryStrategies.adaptiveRetryEnabled,
      bulkheadEnabled: this.config.retryStrategies.bulkheadEnabled,
    });
  }

  private setupMonitoring(): void {
    this.metricsInterval = setInterval(() => {
      this.collectAndEmitMetrics();
    }, this.config.integration.metricsCollectionInterval);

    logger.info('Performance monitoring enabled', {
      interval: this.config.integration.metricsCollectionInterval,
    });
  }

  private setupHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.integration.healthCheckInterval);

    logger.info('Health checks enabled', {
      interval: this.config.integration.healthCheckInterval,
    });
  }

  private setupIntegrationEventHandlers(): void {
    // Configuration change events
    this.dynamicConfig.on('configurationChanged', (changes, previous, current) => {
      logger.info('Configuration changed', { changes: Object.keys(changes) });
      this.eventBus.emit('system:config:changed', { changes, previous, current });
    });

    this.dynamicConfig.on('hotReload', (changes) => {
      logger.info('Hot reload configuration changes', { changes: Object.keys(changes) });
      this.eventBus.emit('system:config:hot-reload', { changes });
    });

    // System events
    this.eventBus.on('system:integration:health-check', (data) => {
      logger.debug('Health check completed', data);
    });

    this.eventBus.on('system:integration:metrics', (data) => {
      logger.debug('Metrics collected', {
        timestamp: data.timestamp,
        metricsCount: Object.keys(data.metrics).length,
      });
    });
  }

  private async collectAndEmitMetrics(): Promise<void> {
    try {
      const metrics = {
        timestamp: new Date(),
        system: {
          memory: process.memoryUsage(),
          uptime: process.uptime(),
        },
        dynamicConfig: this.dynamicConfig.getMetrics(),
        retryManager: Object.fromEntries(this.retryManager.getMetrics() as Map<string, unknown>),
        eventBus: this.eventBus.getMetrics(),
      };

      this.eventBus.emit('system:integration:metrics', { metrics });
    } catch (error) {
      logger.error('Error collecting metrics', { error });
    }
  }

  private async performHealthCheck(): Promise<void> {
    try {
      const health = {
        timestamp: new Date(),
        status: 'healthy',
        components: {
          dynamicConfig: this.checkDynamicConfigHealth(),
          eventBus: this.checkEventBusHealth(),
          retryManager: this.checkRetryManagerHealth(),
        },
      };

      // Determine overall health
      const componentStates = Object.values(health.components);
      if (componentStates.some(state => state.status === 'unhealthy')) {
        health.status = 'unhealthy';
      } else if (componentStates.some(state => state.status === 'degraded')) {
        health.status = 'degraded';
      }

      this.eventBus.emit('system:integration:health-check', health);

      // Trigger auto-recovery if enabled and unhealthy
      if (health.status === 'unhealthy' && this.config.integration.autoRecoveryEnabled) {
        await this.attemptAutoRecovery(health);
      }

    } catch (error) {
      logger.error('Health check failed', { error });
    }
  }

  private checkDynamicConfigHealth(): { status: string; lastUpdate?: Date; sourceCount: number } {
    const metrics = this.dynamicConfig.getMetrics();
    const sourceStatus = this.dynamicConfig.getSourceStatus();

    const unhealthySources = Object.values(sourceStatus).filter(s => !s.healthy).length;

    return {
      status: unhealthySources === 0 ? 'healthy' : 'degraded',
      lastUpdate: metrics.lastReloadTime,
      sourceCount: Object.keys(sourceStatus).length,
    };
  }

  private checkEventBusHealth(): { status: string; pendingEvents: number; deadLetterCount: number } {
    const metrics = this.eventBus.getMetrics();

    return {
      status:
        metrics.queueSaturation >= 1
          ? 'unhealthy'
          : metrics.queueSaturation >= 0.8
            ? 'degraded'
            : 'healthy',
      pendingEvents: metrics.queuedEvents,
      deadLetterCount: metrics.totalEventsDeadLettered,
    };
  }

  private checkRetryManagerHealth(): { status: string; operations: number; avgSuccessRate: number } {
    const allMetrics = this.retryManager.getMetrics() as Map<string, RetryMetrics>;
    const operations = allMetrics.size;

    let totalSuccessRate = 0;
    for (const metrics of allMetrics.values()) {
      totalSuccessRate += metrics.successRate;
    }

    const avgSuccessRate = operations > 0 ? totalSuccessRate / operations : 1;

    return {
      status: avgSuccessRate < 0.5 ? 'degraded' : 'healthy',
      operations,
      avgSuccessRate,
    };
  }

  private async attemptAutoRecovery(healthStatus: {
    timestamp: Date;
    status: string;
    components: {
      dynamicConfig: { status: string };
      eventBus: { status: string };
      retryManager: { status: string };
    };
  }): Promise<void> {
    logger.warn('Attempting auto-recovery', { healthStatus });

    try {
      // Reload configuration
      if (healthStatus.components.dynamicConfig.status !== 'healthy') {
        await this.dynamicConfig.reload();
        logger.info('Configuration reloaded during auto-recovery');
      }

      // Reset retry manager if needed
      if (healthStatus.components.retryManager.status !== 'healthy') {
        this.retryManager.reset();
        logger.info('Retry manager reset during auto-recovery');
      }

      this.eventBus.emit('system:integration:auto-recovery', {
        timestamp: new Date(),
        reason: 'health-check-failure',
        actions: ['config-reload', 'retry-reset'],
      });

    } catch (error) {
      logger.error('Auto-recovery failed', { error });
    }
  }

  private mergeConfigs(base: IntegrationConfig, custom: Partial<IntegrationConfig>): IntegrationConfig {
    return {
      circuitBreaker: { ...base.circuitBreaker, ...custom.circuitBreaker },
      eventBus: { ...base.eventBus, ...custom.eventBus },
      dynamicConfig: { ...base.dynamicConfig, ...custom.dynamicConfig },
      retryStrategies: { ...base.retryStrategies, ...custom.retryStrategies },
      integration: { ...base.integration, ...custom.integration },
    };
  }

  // Public API methods
  public getConfig(): IntegrationConfig {
    return { ...this.config };
  }

  public async updateConfig(updates: Partial<IntegrationConfig>): Promise<void> {
    this.config = this.mergeConfigs(this.config, updates);
    logger.info('Integration config updated', { updates: Object.keys(updates) });

    if (updates.eventBus) {
      this.eventBus.updateConfig({
        maxQueueSize: updates.eventBus.maxQueueSize,
        overflowBehavior: updates.eventBus.overflowBehavior,
      });
    }

    this.eventBus.emit('system:integration:config-updated', {
      timestamp: new Date(),
      updates,
    });
  }

  public async getSystemStatus(): Promise<unknown> {
    return {
      initialized: this.initialized,
      config: this.config,
      health: await this.performHealthCheck(),
      metrics: await this.collectAndEmitMetrics(),
    };
  }

  public getDynamicConfig(): DynamicConfiguration {
    return this.dynamicConfig;
  }

  public getRetryManager(): AdvancedRetryManager {
    return this.retryManager;
  }

  public getEventBus(): EventBus {
    return this.eventBus;
  }

  public async shutdown(): Promise<void> {
    logger.info('Shutting down Integration Orchestrator');

    // Clear intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    // Shutdown components
    await this.dynamicConfig.shutdown();

    this.initialized = false;
    logger.info('System Infrastructure Orchestrator shutdown completed');
  }
}

// Convenience functions
export function getSystemInfrastructureOrchestrator(): SystemInfrastructureOrchestrator {
  return SystemInfrastructureOrchestrator.getInstance();
}

export async function initializeInfrastructureSuite(
  config?: Partial<IntegrationConfig>,
): Promise<SystemInfrastructureOrchestrator> {
  const orchestrator = SystemInfrastructureOrchestrator.getInstance();
  await orchestrator.initialize(config);
  return orchestrator;
}

// Backwards compatibility aliases (deprecated - use new names)
export const getIntegrationOrchestrator = getSystemInfrastructureOrchestrator;
export const initializeIntegrationSuite = initializeInfrastructureSuite;

// Class alias for backwards compatibility (allows IntegrationOrchestrator.getInstance())
export const IntegrationOrchestrator = SystemInfrastructureOrchestrator;

// Export retry configurations for easy access
export { RetryConfigurations };
