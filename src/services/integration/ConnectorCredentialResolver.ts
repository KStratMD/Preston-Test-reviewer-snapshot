import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { getSystemType } from '../../connectors/connectorIdentity';
import { ConflictAppError } from '../../errors/AppError';
import type { SecureCredentialManager } from '../SecureCredentialManager';
import type { TenantSystemCredentialRegistry } from './TenantSystemCredentialRegistry';
import type { AuthConfig, IntegrationConfig, SystemConfig } from '../../types';

/**
 * Lazy provider so a sync-bound consumer (ConnectorManager, via this
 * resolver) can obtain SecureCredentialManager without cascading its
 * async-bound `SecretManager` dependency through the whole chain. Mirrors the
 * established `TenantConfigurationProvider` pattern
 * (`src/services/ai/orchestrator/GovernanceService.ts`) — the DI binding
 * (`inversify.config.ts`) wires this to `context.container.getAsync(...)`.
 */
export type SecureCredentialManagerProvider = () => Promise<SecureCredentialManager>;

/**
 * Resolves the `AuthConfig` `ConnectorManager` should hand to
 * `IConnector.initialize()` for one side (source/target) of an
 * `IntegrationConfig` — the runtime counterpart of the schema-level managed
 * credential reference added in `configurationSchemas.ts` (Prerequisite PR B,
 * 2026-07-27 NetSuite serialized-asset sync plan, decision 15: managed
 * credentials are a PLATFORM capability, not feature-specific parsing).
 *
 * Resolution rules are exact (mirrored in the schema's cross-field checks):
 *   1. `SystemConfig.credentialSource === 'secret_manager'` ->
 *      `SecureCredentialManager.getCredentials(getSystemType(system), system.systemId)`.
 *      A lookup failure PROPAGATES — callers must not call
 *      `IConnector.initialize()` when `resolve()` rejects.
 *   2. `'inline'`, an omitted `credentialSource`, or a legacy string system
 *      reference -> the existing side-specific authentication object
 *      (`sourceAuthentication`/`targetAuthentication`, falling back to the
 *      legacy `authentication.source`/`authentication.target` shape).
 *   3. `'environment'` -> `undefined`. This prerequisite does not invent a new
 *      environment credential format; the caller's existing behavior of
 *      skipping `initialize()` when no inline auth is present is preserved.
 */
export interface ConnectorCredentialResolver {
  resolve(config: IntegrationConfig, side: 'source' | 'target'): Promise<AuthConfig | undefined>;
}

/**
 * Marks an UNCLASSIFIED failure as having come from credential RESOLUTION
 * rather than from anything else `ConnectorManager.initializeConnectorsForConfig()`
 * does (PR A2, deployment-readiness Tranche A).
 *
 * That distinction is load-bearing for `IntegrationService`. Resolution reaches
 * a real secret store, so an unclassified failure from it can carry secret
 * material in its message, and that service's callers put thrown text into
 * client-visible results, logs and audit payloads — so it must be replaced with
 * a fixed, value-free message. `IConnector.initialize()` failures travel the
 * same call, but they are ordinary connector/auth errors whose text callers
 * have always seen and rely on ('Token expired'), and A2 has no mandate to
 * start masking them. Without this marker the service can only distinguish by
 * the error's CLASS, and both arrive as a plain `Error`.
 *
 * The original message is preserved so existing propagation assertions keep
 * describing the real failure; the boundary that replaces it lives in
 * `IntegrationService`, deliberately, since that is where the leak-prone
 * consumers are. `AppError`s are NOT wrapped — they are the deliberate,
 * value-free refusals the resolver, the ownership registry and
 * `assertDistinguishableManagedSides` already emit.
 */
export class ConnectorCredentialResolutionError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ConnectorCredentialResolutionError';
  }
}

@injectable()
export class DefaultConnectorCredentialResolver implements ConnectorCredentialResolver {
  constructor(
    @inject(TYPES.SecureCredentialManagerProvider)
    private readonly secureCredentialManagerProvider: SecureCredentialManagerProvider,
    @inject(TYPES.TenantSystemCredentialRegistry)
    private readonly ownershipRegistry: TenantSystemCredentialRegistry,
  ) {}

  async resolve(config: IntegrationConfig, side: 'source' | 'target'): Promise<AuthConfig | undefined> {
    const system = side === 'source' ? config.sourceSystem : config.targetSystem;
    const inlineAuth = side === 'source'
      ? (config.sourceAuthentication ?? config.authentication?.source)
      : (config.targetAuthentication ?? config.authentication?.target);

    if (typeof system === 'string') {
      return inlineAuth;
    }

    switch (system.credentialSource) {
      case 'secret_manager':
        return this.resolveFromSecretManager(config, system, side);
      case 'environment':
        return undefined;
      case 'inline':
      case undefined:
        return inlineAuth;
      default: {
        // Exhaustiveness guard — system.credentialSource is narrowed to
        // `never` here; the canonical schema's z.enum already rejects any
        // other literal, so this only fires on an uncast runtime value.
        const exhaustive: never = system.credentialSource;
        // ConflictAppError (409), not a plain Error (Copilot R4). Both throws in
        // this resolver describe a STORED configuration that declares something
        // the schema forbids — only reachable when a record bypassed
        // `validateIntegrationConfig` (hand-edited on disk, or written before
        // the canonical schema existed). A plain Error would surface as HTTP
        // 500, reporting a deterministic, retry-invariant refusal as a server
        // fault. 409 matches the two sibling guards this PR introduces
        // (`assertNoManagedCredentialReference`, `assertDistinguishableManagedSides`):
        // the request is fine, the stored configuration is not, and the operator
        // remedy is to correct the config.
        throw new ConflictAppError(
          `ConnectorCredentialResolver: unrecognized credentialSource '${String(exhaustive)}' for ${side} system`,
        );
      }
    }
  }

  /**
   * SECURITY: `SecureCredentialManager.getCredentials` has NO tenant dimension
   * (its secret key is `credentials_${systemType}_${systemId}`), and `systemId`
   * is operator-authored free text on a stored configuration. Ownership is
   * therefore verified against the tenant-scoped registry FIRST — before the
   * secret-manager lookup — using `config.tenantId`, which is the server-owned
   * tenant of the STORED record (never anything a request supplied).
   *
   * This is the funnel for managed credentials reached from a stored
   * configuration: readiness, activation, and sync all resolve through here, so
   * the check covers every path that acts on `IntegrationConfig.sourceSystem` /
   * `.targetSystem`. A refusal (`CrossTenantCredentialError`) and an
   * undeterminable check (`ServiceUnavailableAppError`) both propagate —
   * `initialize()` is never called for that side.
   *
   * It is NOT the only caller of `SecureCredentialManager.getCredentials` in the
   * codebase, and this comment previously overclaimed that.
   * `SecureConfigurationService.getSecureIntegration()` also calls it directly,
   * without an ownership assertion. That method has no production caller at all
   * today — only tests reference it — so it is not presently reachable. But it
   * is a public method on an injectable service, so the first production caller
   * added would silently bypass this check. It must not be treated as covered.
   */
  private async resolveFromSecretManager(
    config: IntegrationConfig,
    system: SystemConfig,
    side: 'source' | 'target',
  ): Promise<AuthConfig> {
    if (!system.systemId) {
      // ConflictAppError (409) — see the exhaustiveness guard in `resolve()`
      // for why a stored-config defect is a conflict rather than a 500. The
      // canonical schema already requires `systemId` here
      // (`checkManagedCredentialPair`), so reaching this line means the record
      // was persisted without passing validation.
      throw new ConflictAppError(
        `ConnectorCredentialResolver: ${side} system.credentialSource is 'secret_manager' but systemId is missing`,
      );
    }
    const systemType = getSystemType(system);
    await this.ownershipRegistry.assertSystemOwnedByTenant(config.tenantId, systemType, system.systemId);
    const secureCredentialManager = await this.secureCredentialManagerProvider();
    return secureCredentialManager.getCredentials(systemType, system.systemId);
  }
}
