/**
 * Example demonstrating how to use the new decomposed integration services
 * This replaces the monolithic IntegrationService with focused, specialized services
 */

import { Container } from 'inversify';
import { Logger } from '../../utils/Logger';
import { AuthService } from '../AuthService';
import { ConfigurationService } from '../ConfigurationService';
import { TransformationEngine } from '../TransformationEngine';
import type { OutboundGovernanceService } from '../governance/OutboundGovernanceService';
import type { OwnershipResolver } from '../../governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../governance/ApprovalQueueService';
import {
  ConnectorManager,
  IntegrationStatusManager,
  IntegrationExecutor,
  IntegrationOrchestrator,
} from './index';

/**
 * Example of setting up the new integration architecture
 */
export class IntegrationServiceExample {
  private readonly logger: Logger;
  private readonly connectorManager: ConnectorManager;
  private readonly statusManager: IntegrationStatusManager;
  private readonly executor: IntegrationExecutor;
  private readonly orchestrator: IntegrationOrchestrator;

  constructor(
    logger: Logger,
    authService: AuthService,
    configService: ConfigurationService,
    transformationEngine: TransformationEngine,
    outboundGovernance: OutboundGovernanceService,
    // PR 13b governance trio — required by IntegrationExecutor.
    // (Copilot R9 on PR #851: was previously optional with runtime throw,
    // so example construction with only the original 5 params compiled but
    // would crash on first write.)
    ownershipResolver: OwnershipResolver,
    auditService: AuditService,
    approvalQueueService: ApprovalQueueService,
  ) {
    this.logger = logger;

    // Create specialized services
    this.connectorManager = new ConnectorManager(logger, authService, outboundGovernance);
    this.statusManager = new IntegrationStatusManager(logger);
    this.executor = new IntegrationExecutor(
      logger,
      transformationEngine,
      this.connectorManager,
      this.statusManager,
      undefined,
      ownershipResolver,
      auditService,
      approvalQueueService,
    );
    this.orchestrator = new IntegrationOrchestrator(
      logger,
      configService,
      this.connectorManager,
      this.statusManager,
      this.executor,
    );
  }

  /**
   * Example: Initialize and run an integration
   */
  async runExample(): Promise<void> {
    try {
      // Initialize the orchestrator
      await this.orchestrator.initialize();

      // Get system health
      const health = await this.orchestrator.getSystemHealth();
      this.logger.info('System Health:', { health });

      // Run an integration (example config ID)
      const configId = 'example-config-1';
      const result = await this.orchestrator.runIntegration(configId, {
        batchSize: 50,
        concurrency: 3,
        dryRun: false,
      });

      this.logger.info('Integration completed:', { result });

      // Get integration status
      const status = this.orchestrator.getIntegrationStatus(configId);
      this.logger.info('Integration status:', { status });

      // Test an integration
      const testResult = await this.orchestrator.testIntegration(configId);
      this.logger.info('Integration test result:', { testResult });

    } catch (error) {
      this.logger.error('Integration example failed:', error);
    }
  }

  /**
   * Example: Working with individual services
   */
  async serviceExamples(): Promise<void> {
    // Example 1: Direct connector management
    const connector = await this.connectorManager.getConnector('salesforce', 'sf-001');
    const testResult = await this.connectorManager.testConnector('salesforce', {
      type: 'oauth2',
      credentials: {
        clientId: 'example-client-id',
        clientSecret: 'example-secret',
        refreshToken: 'example-refresh-token',
      }
    });
    this.logger.info('Connector test:', testResult);

    // Example 2: Status management
    this.statusManager.initializeStatus('config-123');
    this.statusManager.markAsRunning('config-123');
    
    // Simulate completion
    setTimeout(() => {
      this.statusManager.markAsCompleted('config-123', {
        integrationId: 'config-123',
        syncId: 'sync-456',
        status: 'success',
        success: true,
        recordsProcessed: 100,
        recordsSuccessful: 95,
        recordsFailed: 5,
        errors: ['Minor validation error on 5 records'],
        startTime: new Date(Date.now() - 30000),
        endTime: new Date(),
      }, 30000);
    }, 1000);

    // Example 3: Get metrics
    const metrics = this.statusManager.getMetrics();
    this.logger.info('Integration metrics:', { metrics });

    // Example 4: Get problematic integrations
    const problematic = this.statusManager.getProblematicIntegrations(0.1); // 10% error rate threshold
    this.logger.info('Problematic integrations:', { problematic });
  }

  /**
   * Cleanup
   */
  async shutdown(): Promise<void> {
    await this.orchestrator.shutdown();
  }
}

/**
 * Benefits of the new architecture:
 * 
 * 1. **Single Responsibility**: Each service has a focused purpose
 *    - ConnectorManager: Handles connector lifecycle
 *    - IntegrationStatusManager: Tracks status and metrics
 *    - IntegrationExecutor: Executes sync operations
 *    - IntegrationOrchestrator: Coordinates everything
 * 
 * 2. **Better Testability**: Services can be tested in isolation
 * 
 * 3. **Improved Maintainability**: Changes to one aspect don't affect others
 * 
 * 4. **Enhanced Scalability**: Services can be scaled independently
 * 
 * 5. **Clearer Dependencies**: Each service has explicit dependencies
 * 
 * 6. **Better Error Handling**: Errors are contained within service boundaries
 * 
 * 7. **Easier Extension**: New functionality can be added to specific services
 */

export default IntegrationServiceExample;