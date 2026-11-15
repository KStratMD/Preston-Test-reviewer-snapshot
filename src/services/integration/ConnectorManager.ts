import { injectable } from 'inversify';
import { getConnectorRegistration } from '../../connectors/connectorRegistry';
import { connectorKeyForSystem } from '../../connectors/connectorIdentity';
import { AppError, ConflictAppError } from '../../errors/AppError';
import type { IConnector } from '../../interfaces/IConnector';
import type { AuthenticationConfig, IntegrationConfig } from '../../types';
import type { Logger } from '../../utils/Logger';
import type { AuthService } from '../AuthService';
import type { OutboundGovernanceService } from '../governance/OutboundGovernanceService';
import { ConnectorCredentialResolutionError } from './ConnectorCredentialResolver';
import type { ConnectorCredentialResolver } from './ConnectorCredentialResolver';

/**
 * The connector cache is keyed by `${systemType}_${systemId}`. Standard paths
 * pass `${connectorKey}_${config.id}` as `systemId` on BOTH sides, so a
 * configuration whose source and target project to the SAME connector key
 * resolves ONE shared instance — and the target's `initialize()` would overwrite
 * the source's credentials.
 *
 * That collision is pre-existing and cannot be fixed by changing the cache id
 * here alone: roughly twenty call sites across IntegrationService,
 * IntegrationExecutor, SyncCentralOrchestrator, FinanceCentral, SyncErrorAssist,
 * ReconciliationCenter and WorkflowCentral each reconstruct the same
 * `${systemType}_${systemType}_${configId}` map key independently to RETRIEVE
 * the connector this method initialized. Changing the convention on one side
 * would desynchronize them and hand retrievers an uninitialized connector —
 * strictly worse. Correcting it is its own PR.
 *
 * What IS new here is the `systemId` dimension: before managed credential
 * references existed, two same-typed sides were genuinely indistinguishable, so
 * sharing was merely imprecise. Now they can name DIFFERENT brokered credentials
 * (two Salesforce orgs) while still collapsing to one cache key. This guard
 * refuses exactly that newly-expressible shape rather than letting the target's
 * credentials silently service the source's reads.
 *
 * Legacy configs where neither side declares a `systemId` are untouched — the
 * pre-existing imprecision remains, and no previously-working config starts
 * failing.
 */
function assertDistinguishableManagedSides(
  config: IntegrationConfig,
  sourceConnectorKey: string,
  targetConnectorKey: string,
): void {
  if (sourceConnectorKey !== targetConnectorKey) return;

  // The comparison must be over the EFFECTIVE credential identity, not the id
  // alone. Matching ids do not imply matching credentials: a side declaring
  // `credentialSource: 'secret_manager'` resolves a brokered secret, while a
  // side declaring `inline` with the very same `systemId` resolves the config's
  // inline auth object. Those are two different credentials on one cached
  // connector, and an id-only check waves them through.
  //
  // `undefined` and `'inline'` are deliberately the SAME source here: an
  // omitted `credentialSource` means inline, so treating them as distinct would
  // start refusing legacy configs that work today.
  const identityOf = (
    system: IntegrationConfig['sourceSystem'],
  ): { credentialSource: string; systemId: string | undefined } => {
    if (typeof system === 'string') return { credentialSource: 'inline', systemId: undefined };
    return {
      credentialSource: system.credentialSource ?? 'inline',
      systemId: system.systemId,
    };
  };

  const source = identityOf(config.sourceSystem);
  const target = identityOf(config.targetSystem);

  // Legacy shape — neither side names a system and both resolve inline. The
  // pre-existing imprecision remains and nothing that works today starts
  // failing.
  const bothLegacyInline =
    source.systemId === undefined &&
    target.systemId === undefined &&
    source.credentialSource === 'inline' &&
    target.credentialSource === 'inline';
  if (bothLegacyInline) return;

  if (
    source.credentialSource === target.credentialSource &&
    source.systemId === target.systemId
  ) {
    return;
  }

  // ConflictAppError (409), not a plain Error — same reasoning as
  // `assertNoManagedCredentialReference` in IntegrationService (Copilot R4).
  // A plain Error reaches the error boundary unclassified and is reported as
  // HTTP 500, telling an operator the server broke when the request was in fact
  // refused deterministically and will be refused identically on every retry.
  // 409 rather than 400 because nothing is wrong with the REQUEST: the conflict
  // is between the two credential identities the stored configuration declares.
  throw new ConflictAppError(
    `Configuration ${config.id} points source and target at the same connector ` +
      `('${sourceConnectorKey}') but different credential identities; the ` +
      'connector cache cannot distinguish them, so the target credentials would ' +
      'service source reads. Use distinct system types, or give both sides the ' +
      'same credentialSource and systemId.',
  );
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
  private readonly credentialResolver: ConnectorCredentialResolver;

  constructor(
    logger: Logger,
    authService: AuthService,
    outboundGovernance: OutboundGovernanceService,
    credentialResolver: ConnectorCredentialResolver,
  ) {
    this.logger = logger;
    this.authService = authService;
    this.outboundGovernance = outboundGovernance;
    this.credentialResolver = credentialResolver;
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
   * Initialize connectors for a configuration.
   *
   * Cache/creation key: derived via `connectorKeyForSystem()` (Prerequisite A's
   * connectorIdentity module), NOT the raw `getSystemType()` spelling. A
   * config's system reference may be spelled either as a connector-registry
   * key already or as a SourceOfTruth manifest `SourceSystem` (e.g.
   * 'business_central', whose registry key is 'businesscentral') —
   * `createConnector()`'s naive `.toLowerCase()` cannot resolve the manifest
   * spelling, so retrieving/creating by the raw type throws "Unsupported
   * system type" for any config whose spelling diverges from its registry
   * key. Projecting through `connectorKeyForSystem()` here keeps this
   * method's cache key CONSISTENT with what any other caller retrieving the
   * same connector must also use (e.g. `OwnershipResumeHandler`, which
   * projects through the same helper before calling `getConnector()`).
   *
   * Credential resolution is delegated to the injected
   * `ConnectorCredentialResolver` (Prerequisite PR B) instead of reading
   * `sourceAuthentication`/`targetAuthentication` inline, so a managed
   * (`secret_manager`) or environment-backed system reference is honored —
   * not silently ignored. A resolver rejection (e.g. a secret-manager lookup
   * failure) propagates and `initialize()` is never called for that side.
   *
   * ORDER (tightened by PR A2, deployment-readiness Tranche A): BOTH sides
   * resolve before EITHER connector is created. Resolving per-side and
   * creating as it went made a refusal arrive too late — `getConnector()`
   * creates AND caches through the registry factory, so a cross-tenant
   * `systemId` or a secret-manager outage still left an uninitialized instance
   * in the per-process cache under the manager's `${systemType}_${systemId}`
   * key. Standard paths pass `${connectorKey}_${config.id}` as `systemId`, so
   * downstream retrievers reconstruct the same effective map key. The next
   * caller would hit that cached instance rather than creating one, receiving a
   * connector for a configuration its tenant had just been refused. A2 routes
   * `IntegrationService`'s standard execution paths through this method, so a
   * refusal has to land before the factory, not merely before `initialize()`.
   *
   * Creation itself stays unconditional once resolution succeeds: callers
   * retrieve this pair by cache key afterwards, and making creation contingent
   * on a side having resolved credentials would leave an
   * environment-credential side absent from the cache.
   */
  async initializeConnectorsForConfig(config: IntegrationConfig): Promise<void> {
    const sourceConnectorKey = connectorKeyForSystem(config.sourceSystem);
    const targetConnectorKey = connectorKeyForSystem(config.targetSystem);

    assertDistinguishableManagedSides(config, sourceConnectorKey, targetConnectorKey);

    // Resolve BOTH sides first — see ORDER above.
    const sourceAuth = await this.resolveSideCredentials(config, 'source');
    const targetAuth = await this.resolveSideCredentials(config, 'target');

    // Initialize source connector
    const sourceConnector = await this.getConnector(sourceConnectorKey, `${sourceConnectorKey}_${config.id}`);
    if (sourceAuth) {
      await sourceConnector.initialize(sourceAuth);
    }

    // Initialize target connector
    const targetConnector = await this.getConnector(targetConnectorKey, `${targetConnectorKey}_${config.id}`);
    if (targetAuth) {
      await targetConnector.initialize(targetAuth);
    }

    this.logger.info(`Initialized connectors for configuration ${config.id}: ${sourceConnectorKey} -> ${targetConnectorKey}`);
  }

  /**
   * Labels an unclassified resolver failure as such, so a caller can tell it
   * apart from an `IConnector.initialize()` failure raised later in the same
   * method — see `ConnectorCredentialResolutionError`. The message is
   * preserved and `AppError` refusals pass through untouched, so nothing about
   * what propagates changes; only its identifiability does.
   */
  private async resolveSideCredentials(
    config: IntegrationConfig,
    side: 'source' | 'target',
  ): Promise<AuthenticationConfig | undefined> {
    try {
      return await this.credentialResolver.resolve(config, side);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new ConnectorCredentialResolutionError(error);
    }
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
