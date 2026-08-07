import { SuiteCentralConnectorProd } from '../../../connectors/SuiteCentralConnectorProd';
import type { Logger } from '../../../utils/Logger';
import type { SuiteCentralControlPlaneRepository } from './SuiteCentralControlPlaneRepository';
import type { SuiteCentralOutboundPolicy } from './SuiteCentralOutboundPolicy';
import type { SuiteCentralSecretStore } from './SuiteCentralSecretStore';
import type { PinnedHttpsTransport } from './PinnedHttpsTransport';
import type { SuiteCentralControlPlaneContext } from './domain';
import { SuiteCentralNotFoundError } from './errors';

/**
 * Constructs a fresh, single-operation {@link SuiteCentralConnectorProd} for one
 * (tenant, environment, credential) triple. The security-critical ordering is
 * FIXED and fail-closed:
 *
 *   1. load the environment (tenant-scoped) — 404 if absent
 *   2. load the credential (tenant-scoped) — 404 if absent, inactive, or bound
 *      to a different environment
 *   3. validate the destination (allowlist + DNS-rebind checks) BEFORE any
 *      secret is touched, so a revoked host or changed DNS answer is caught
 *      without ever resolving the secret
 *   4. resolve the client secret through the write-only secret store
 *   5. build a pinned HTTPS client and construct + initialize the connector
 *
 * The connector and the secret-bearing config NEVER enter a singleton or cache —
 * a new instance is returned on every call and discarded after the operation.
 */
export class SuiteCentralConnectorFactory {
  constructor(
    private readonly repository: Pick<SuiteCentralControlPlaneRepository, 'findEnvironment' | 'findCredentialMetadata'>,
    private readonly outboundPolicy: Pick<SuiteCentralOutboundPolicy, 'validateBaseUrl'>,
    private readonly secretStore: Pick<SuiteCentralSecretStore, 'resolve'>,
    private readonly transport: Pick<PinnedHttpsTransport, 'create'>,
    private readonly logger: Logger,
  ) {}

  async create(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    credentialProfileId: string,
  ): Promise<SuiteCentralConnectorProd> {
    // 1. Ownership: the environment must belong to the target tenant.
    const environment = await this.repository.findEnvironment(context.targetTenantId, environmentId);
    if (!environment) {
      throw new SuiteCentralNotFoundError('environment_not_found', 'Environment not found.');
    }

    // 2. Ownership: the credential must belong to the same tenant AND
    //    environment, and be active. A cross-environment or inactive credential
    //    is indistinguishable from "not found" so no existence is leaked.
    const credential = await this.repository.findCredentialMetadata(context.targetTenantId, credentialProfileId);
    if (!credential || credential.environmentId !== environmentId || !credential.isActive) {
      throw new SuiteCentralNotFoundError('credential_not_found', 'Credential not found.');
    }

    // 3. Destination validation BEFORE secret resolution — a revoked host or a
    //    rebound DNS answer must fail closed without ever reading the secret.
    const destination = await this.outboundPolicy.validateBaseUrl(environment.baseUrl);

    // 4. Resolve the secret only after ownership + destination are proven.
    const clientSecret = await this.secretStore.resolve({
      tenantId: context.targetTenantId,
      profileId: credential.id,
      storedRef: credential.secretRef,
    });

    // 5. Build the pinned client and a FRESH connector. `canonicalUrl` (PR-A3
    //    rename of `canonicalBaseUrl`) is the validated origin.
    const httpClient = this.transport.create(destination, environment.timeoutMs);
    const connector = new SuiteCentralConnectorProd(
      `suitecentral:${environment.id}`,
      this.logger,
      undefined,
      httpClient,
    );
    await connector.initialize({
      type: 'oauth2',
      credentials: {
        clientId: credential.clientId,
        clientSecret,
        baseUrl: destination.canonicalUrl,
        apiVersion: environment.apiVersion ?? undefined,
        environment: environment.environmentTier,
        timeout: environment.timeoutMs,
        retryAttempts: environment.retryAttempts,
        companyId: credential.companyId ?? undefined,
      },
    });
    return connector;
  }
}
