import { injectable } from 'inversify';
import { getConnectorRegistration } from '../../connectors/connectorRegistry';
import type { IConnector } from '../../interfaces/IConnector';
import type { AuthenticationConfig, IntegrationConfig } from '../../types';
import type { Logger } from '../../utils/Logger';
import type { AuthService } from '../AuthService';
import type { OutboundGovernanceService } from '../governance/OutboundGovernanceService';

/**
 * Helper function to extract system type string from SystemConfig union type
 */
function getSystemType(system: string | { type: string }): string {
  return typeof system === 'string' ? system : system.type;
}

/**
 * Service responsible for managing connector instances and their lifecycle.
 *
 * Wiring (PR 6A-2): `createConnector()` consumes
 * `src/connectors/connectorRegistry.ts` instead of a hand-maintained switch.
 * The audit gate `audit-status-claims --check-wired-connectors` enforces that
 * any connector class with a registry `factory` closure is instantiated only
 * inside the registry file — `new XxxConnector(` here would fail CI.
 */
@injectable()
export class ConnectorManager {
  private readonly connectors = new Map<string, IConnector>();
  private readonly logger: Logger;
  private readonly authService: AuthService;
  private readonly outboundGovernance: OutboundGovernanceService;

  constructor(
    logger: Logger,
    authService: AuthService,
    outboundGovernance: OutboundGovernanceService,
  ) {
    this.logger = logger;
    this.authService = authService;
    this.outboundGovernance = outboundGovernance;
  }

  /**
   * Get or create a connector for the specified system type
   */
  async getConnector(systemType: string, systemId: string): Promise<IConnector> {
    const connectorKey = `${systemType}_${systemId}`;

    if (this.connectors.has(connectorKey)) {
      return this.connectors.get(connectorKey)!;
    }

    const connector = this.createConnector(systemType, connectorKey);
    this.connectors.set(connectorKey, connector);

    this.logger.debug(`Created connector for ${systemType} with ID ${systemId}`);
    return connector;
  }

  /**
   * Initialize connectors for a configuration
   */
  async initializeConnectorsForConfig(config: IntegrationConfig): Promise<void> {
    const sourceSystemType = getSystemType(config.sourceSystem);
    const targetSystemType = getSystemType(config.targetSystem);

    // Initialize source connector
    const sourceConnector = await this.getConnector(sourceSystemType, `${sourceSystemType}_${config.id}`);
    const sourceAuth = config.sourceAuthentication ?? config.authentication?.source;
    if (sourceAuth) {
      await sourceConnector.initialize(sourceAuth);
    }

    // Initialize target connector
    const targetConnector = await this.getConnector(targetSystemType, `${targetSystemType}_${config.id}`);
    const targetAuth = config.targetAuthentication ?? config.authentication?.target;
    if (targetAuth) {
      await targetConnector.initialize(targetAuth);
    }

    this.logger.info(`Initialized connectors for configuration ${config.id}: ${sourceSystemType} -> ${targetSystemType}`);
  }

  /**
   * Test connector connectivity
   */
  async testConnector(systemType: string, authConfig: AuthenticationConfig): Promise<{
    isConnected: boolean;
    errorMessage?: string;
    responseTime?: number;
  }> {
    const startTime = Date.now();

    try {
      const connector = await this.getConnector(systemType, `${systemType}_test`);
      await connector.initialize(authConfig);
      const result = await connector.testConnection();

      return {
        ...result,
        responseTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        isConnected: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        responseTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Get all active connectors
   */
  getActiveConnectors(): Map<string, IConnector> {
    return new Map(this.connectors);
  }

  /**
   * Remove a connector
   */
  async removeConnector(systemType: string, systemId: string): Promise<boolean> {
    const connectorKey = `${systemType}_${systemId}`;
    const connector = this.connectors.get(connectorKey);

    if (connector) {
      try {
        // Check if connector has shutdown method (not part of IConnector interface)
        if ('shutdown' in connector && typeof (connector as any).shutdown === 'function') {
          await (connector as any).shutdown();
        }
      } catch (error) {
        this.logger.warn(`Error shutting down connector ${connectorKey}:`, { error: error instanceof Error ? error.message : String(error) });
      }

      this.connectors.delete(connectorKey);
      this.logger.debug(`Removed connector ${connectorKey}`);
      return true;
    }

    return false;
  }

  /**
   * Shutdown all connectors
   */
  async shutdown(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];

    this.connectors.forEach((connector, key) => {
      const shutdownPromise = (async () => {
        try {
          // Check if connector has shutdown method (not part of IConnector interface)
          if ('shutdown' in connector && typeof (connector as any).shutdown === 'function') {
            await (connector as any).shutdown();
          }
        } catch (error) {
          this.logger.warn(`Error shutting down connector ${key}:`, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
      shutdownPromises.push(shutdownPromise);
    });

    await Promise.all(shutdownPromises);
    this.connectors.clear();
    this.logger.info('All connectors shut down');
  }

  /**
   * Create a connector instance via the canonical registry. Throws if
   * `systemType` has no registry entry or no `factory` closure (i.e. the
   * connector exists but is not reachable through this manager — e.g. Squire
   * and SuiteCentralConnectorProd are DI-only by design).
   */
  private createConnector(systemType: string, systemId: string): IConnector {
    const entry = getConnectorRegistration(systemType.toLowerCase());
    if (!entry?.factory) {
      throw new Error(`Unsupported system type: ${systemType}`);
    }
    return entry.factory(systemId, {
      logger: this.logger,
      authService: this.authService,
      outboundGovernance: this.outboundGovernance,
    });
  }

  /**
   * Get connector statistics
   */
  getConnectorStats(): {
    totalConnectors: number;
    connectorsByType: Record<string, number>;
    activeConnections: number;
  } {
    const connectorsByType: Record<string, number> = {};
    let activeConnections = 0;

    this.connectors.forEach((connector, key) => {
      const keyParts = key.split('_');
      const systemType = keyParts[0];
      if (systemType) {
        connectorsByType[systemType] = (connectorsByType[systemType] || 0) + 1;
      }

      // Check if connector is initialized (has active connection)
      if (connector && typeof connector.testConnection === 'function') {
        activeConnections++;
      }
    });

    return {
      totalConnectors: this.connectors.size,
      connectorsByType,
      activeConnections,
    };
  }
}

export default ConnectorManager;
