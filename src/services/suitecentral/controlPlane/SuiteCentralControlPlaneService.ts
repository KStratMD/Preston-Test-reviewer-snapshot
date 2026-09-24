import { createHash } from 'crypto';
import { uuidv4 } from '../../../utils/uuid';
import type { DataRecord } from '../../../types';
import type { Logger } from '../../../utils/Logger';
import type { OutboundGovernanceService } from '../../governance/OutboundGovernanceService';
import type { SuiteCentralControlPlaneRepository } from './SuiteCentralControlPlaneRepository';
import type { SuiteCentralSecretStore } from './SuiteCentralSecretStore';
import type { SuiteCentralOutboundPolicy } from './SuiteCentralOutboundPolicy';
import type { SuiteCentralConnectorFactory } from './SuiteCentralConnectorFactory';
import type { SuiteCentralAuditWriter, SuiteCentralAuditDetails } from './SuiteCentralAuditWriter';
import {
  MAX_MONITORING_INTERVAL_MS,
  MIN_MONITORING_INTERVAL_MS,
  type SuiteCentralMonitoringRuntime,
  type SuiteCentralAlert,
  type SuiteCentralHealthSample,
  type SuiteCentralUsageSnapshot,
} from './SuiteCentralMonitoringRuntime';
import {
  governedBulkImport,
  governedRemoveWebhook,
  governedSetupWebhook,
} from './suiteCentralGovernedWrite';
import { safeCorrelationId } from './correlation';
import type {
  AllowedHostView,
  CreateAllowedHostInput,
  CreateCredentialInput,
  CreateEnvironmentInput,
  CreateTemplateInput,
  CredentialMetadataRow,
  CredentialProfileView,
  EnvironmentView,
  MonitoringConfigView,
  SuiteCentralControlPlaneContext,
  TemplateView,
  UpdateEnvironmentPatch,
  UpsertMonitoringInput,
} from './domain';
import {
  stableErrorCode,
  SuiteCentralConflictError,
  SuiteCentralControlPlaneError,
  SuiteCentralDependencyError,
  SuiteCentralForbiddenError,
  SuiteCentralInternalError,
  SuiteCentralNotFoundError,
  SuiteCentralValidationError,
} from './errors';

/**
 * The application service for the SuiteCentral control plane (PR-A5).
 *
 * This is the ONLY surface routes are meant to call (PR-A6 mounts them). It owns
 * four invariants the layers beneath it cannot enforce on their own:
 *
 *   1. **Tenant ownership.** Every resource id arriving from a request is
 *      resolved against `context.targetTenantId`. A cross-tenant id is a typed
 *      404 — indistinguishable from a missing one, so no existence leaks.
 *   2. **Audit before action.** Every state change and every outbound call
 *      records an `attempt` row BEFORE the work starts. If that row cannot be
 *      written, the work does not happen.
 *   3. **Destination validation before persistence and before egress.** A base
 *      URL is validated before it is stored; the connector factory re-validates
 *      immediately before every construction, so a revoked host or a changed DNS
 *      answer takes effect without waiting for a configuration edit.
 *   4. **Secrets in exactly one place.** A client secret travels from the caller
 *      to `SuiteCentralSecretStore` and nowhere else — not into a view, a
 *      repository row, an audit detail, a log line, or an error.
 *
 * Every write crosses `suiteCentralGovernedWrite`; the connector's raw write
 * methods are never called from here.
 */

/** Credential creation is the one input that carries secret material. */
export interface CreateCredentialWithSecretInput extends CreateCredentialInput {
  clientSecret: string;
}

export interface SuiteCentralEnvironmentHealth {
  environmentId: string;
  name: string;
  latest: SuiteCentralHealthSample | null;
}

export class SuiteCentralControlPlaneService {
  constructor(
    private readonly repository: SuiteCentralControlPlaneRepository,
    private readonly secretStore: SuiteCentralSecretStore,
    private readonly outboundPolicy: SuiteCentralOutboundPolicy,
    private readonly connectorFactory: SuiteCentralConnectorFactory,
    private readonly outboundGovernance: OutboundGovernanceService,
    private readonly monitoring: SuiteCentralMonitoringRuntime,
    private readonly audit: SuiteCentralAuditWriter,
    private readonly logger: Logger,
  ) {}

  // ── Environments ───────────────────────────────────────────────────────────

  async listEnvironments(context: SuiteCentralControlPlaneContext): Promise<EnvironmentView[]> {
    return this.repository.listEnvironments(context.targetTenantId);
  }

  async getEnvironment(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
  ): Promise<EnvironmentView> {
    return this.requireEnvironment(context, environmentId);
  }

  async createEnvironment(
    context: SuiteCentralControlPlaneContext,
    input: CreateEnvironmentInput,
  ): Promise<EnvironmentView> {
    // Allocate first so the audit resourceId is this opaque id, not the
    // caller-supplied name: `audit_logs.resource_id` is NOT DLP-scanned (only
    // `details` is), so a name there would be untrusted text in a durable,
    // ungoverned column. The name still travels — in `details`, where it is
    // scanned.
    const environmentId = uuidv4();
    return this.audited(
      context,
      'environment.create',
      'environment',
      environmentId,
      { name: input.name, environmentTier: input.environmentTier ?? 'sandbox' },
      async () => {
        // Reject an unreachable/disallowed destination before it is ever stored.
        await this.outboundPolicy.validateBaseUrl(input.baseUrl);
        return this.repository.createEnvironment(
          context.targetTenantId,
          environmentId,
          input,
          context.actorUserId,
        );
      },
    );
  }

  async updateEnvironment(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    expectedVersion: number,
    patch: UpdateEnvironmentPatch,
  ): Promise<EnvironmentView> {
    await this.requireEnvironment(context, environmentId);
    return this.audited(
      context,
      'environment.update',
      'environment',
      environmentId,
      { expectedVersion },
      async () => {
        if (patch.baseUrl !== undefined) {
          await this.outboundPolicy.validateBaseUrl(patch.baseUrl);
        }
        return this.repository.updateEnvironment(
          context.targetTenantId,
          environmentId,
          expectedVersion,
          patch,
          context.actorUserId,
        );
      },
    );
  }

  // ── Credentials ────────────────────────────────────────────────────────────

  async listCredentials(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
  ): Promise<CredentialProfileView[]> {
    await this.requireEnvironment(context, environmentId);
    return this.repository.listCredentials(context.targetTenantId, environmentId);
  }

  async getCredential(
    context: SuiteCentralControlPlaneContext,
    profileId: string,
  ): Promise<CredentialProfileView> {
    return this.toCredentialView(await this.requireCredential(context, profileId));
  }

  /**
   * Create a credential profile.
   *
   * Ordering is deliberate: allocate the profile id, derive the deterministic
   * secret ref from it, store the secret, THEN insert the metadata. Storing
   * second would leave a metadata row pointing at a secret that was never
   * written — unresolvable, and indistinguishable from a secret-backend outage.
   * Storing first can only leave an orphaned secret, which we delete on failure.
   */
  async createCredential(
    context: SuiteCentralControlPlaneContext,
    input: CreateCredentialWithSecretInput,
  ): Promise<CredentialProfileView> {
    await this.requireEnvironment(context, input.environmentId);
    const profileId = uuidv4();
    const { clientSecret, ...metadata } = input;

    return this.audited(
      context,
      'credential.create',
      'credential',
      profileId,
      { environmentId: input.environmentId, name: input.name, clientId: input.clientId },
      async () => {
        const secretRef = await this.storeSecretOrFail(context, profileId, clientSecret);
        try {
          return await this.repository.createCredentialMetadata(
            context.targetTenantId,
            profileId,
            metadata,
            secretRef,
            context.actorUserId,
          );
        } catch (error) {
          // A throw does NOT prove the row is absent: createCredentialMetadata
          // inserts and then reads back, so a failed read-back after a successful
          // insert lands here with the row committed. Deleting the secret then
          // would produce the exact state this ordering exists to prevent —
          // metadata pointing at a secret that no longer exists. Only clean up a
          // secret we can prove is orphaned.
          if (await this.credentialRowIsAbsent(context, profileId)) {
            await this.deleteOrphanedSecret(context, profileId, secretRef, 'credential_create_cleanup_failed');
          } else {
            this.logger.error('SuiteCentral credential create failed after the row landed; secret retained', {
              correlationId: safeCorrelationId(context.correlationId),
              tenantId: context.targetTenantId,
              profileId,
            });
          }
          throw error;
        }
      },
    );
  }

  async rotateCredential(
    context: SuiteCentralControlPlaneContext,
    profileId: string,
    expectedVersion: number,
    clientSecret: string,
  ): Promise<CredentialProfileView> {
    const meta = await this.requireCredential(context, profileId);
    return this.audited(
      context,
      'credential.rotate',
      'credential',
      profileId,
      { environmentId: meta.environmentId, expectedVersion },
      async () => {
        // CAS BEFORE the secret write. Rotating first meant two concurrent
        // rotations both wrote secrets and only one won the version check, so the
        // live secret was whichever call happened to write last — not the one the
        // winning metadata described. Worse, a rotation racing a delete would
        // re-create the secret the delete had just removed, orphaning it.
        // Winning the CAS first serializes rotation: a loser never touches the
        // secret, and a deleted row fails the CAS instead of resurrecting it.
        const view = await this.repository.rotateCredentialMetadata(
          context.targetTenantId,
          profileId,
          expectedVersion,
          context.actorUserId,
          meta.secretRef,
          new Date().toISOString(),
        );
        // If this fails the row claims a rotation that did not land and the caller
        // gets a 503 — but the credential keeps working on one of the two secrets
        // and the operation is retryable. That is strictly better than the reverse
        // ordering's failure mode.
        //
        // The error is held rather than thrown: a REJECTED write is not proof
        // nothing was written (the provider can commit and then fail the
        // response), so the orphan check below must run on the failure path too.
        // Throwing here would skip it and leave a committed secret with no row.
        let rotateError: unknown;
        try {
          await this.rotateSecretOrFail(context, profileId, meta.secretRef, clientSecret);
        } catch (error) {
          rotateError = error;
        }

        // Re-read once and use it for both post-conditions. The DB and the secret
        // provider share no transaction, so neither can be established by ordering
        // alone — they have to be detected after the fact. A lookup failure leaves
        // both unknown, and we assert neither rather than guess.
        let current: CredentialMetadataRow | undefined;
        let lookupFailed = false;
        try {
          current = await this.repository.findCredentialMetadata(context.targetTenantId, profileId);
        } catch {
          lookupFailed = true;
        }

        if (!lookupFailed && !current) {
          // A concurrent delete removed the row (at the new version) while the
          // write was in flight, so the rotation re-created a secret with no owner.
          this.logger.warn('SuiteCentral credential deleted during rotation; removing resurrected secret', {
            correlationId: safeCorrelationId(context.correlationId),
            tenantId: context.targetTenantId,
            profileId,
          });
          await this.deleteOrphanedSecret(context, profileId, meta.secretRef, 'credential_delete_cleanup_failed');
          throw new SuiteCentralNotFoundError('credential_not_found', 'Credential not found.');
        }

        // The CAS serializes the METADATA, not the two secret writes. Rotations A
        // and B can win successive versions and still write their secrets in the
        // opposite order, leaving the row describing B while A's secret is live.
        // Closing that needs a compare-and-set on the secret provider (which the
        // SecretManager interface does not offer) or a distributed lock. What we
        // can do is refuse to report success on a rotation we know was overtaken,
        // so a silent mismatch becomes a conflict the operator can act on.
        //
        // Compare against the version this CAS WROTE — `expectedVersion + 1`, since
        // the update is `version = version + 1 WHERE version = expectedVersion` —
        // not against `view.version`. The view comes from a re-read the repository
        // performs after its update, and a rotation landing in between makes that
        // re-read return the OTHER rotation's version: comparing to it would match,
        // and the check would miss the very supersession it exists to catch.
        const versionThisRotationWrote = expectedVersion + 1;
        if (!lookupFailed && current && current.version !== versionThisRotationWrote) {
          this.logger.warn('SuiteCentral rotation superseded by a concurrent rotation', {
            correlationId: safeCorrelationId(context.correlationId),
            tenantId: context.targetTenantId,
            profileId,
          });
          throw new SuiteCentralConflictError(
            'rotation_superseded',
            'A concurrent rotation superseded this one; the live secret is undetermined. Re-rotate, then verify with a connection test.',
          );
        }

        if (rotateError) throw rotateError;
        return view;
      },
    );
  }

  async deleteCredential(
    context: SuiteCentralControlPlaneContext,
    profileId: string,
    expectedVersion: number,
  ): Promise<void> {
    const meta = await this.requireCredential(context, profileId);
    return this.audited(
      context,
      'credential.delete',
      'credential',
      profileId,
      { environmentId: meta.environmentId, expectedVersion },
      async () => {
        // Metadata first: a surviving row pointing at a deleted secret would be a
        // broken credential, whereas a surviving secret with no row is inert.
        await this.repository.deleteCredentialMetadata(context.targetTenantId, profileId, expectedVersion);
        await this.deleteOrphanedSecret(context, profileId, meta.secretRef, 'credential_delete_cleanup_failed');
      },
    );
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  async listTemplates(
    context: SuiteCentralControlPlaneContext,
    sourceSystem?: string,
  ): Promise<TemplateView[]> {
    return this.repository.listTemplates(context.targetTenantId, sourceSystem);
  }

  async getTemplate(context: SuiteCentralControlPlaneContext, templateId: string): Promise<TemplateView> {
    const template = await this.repository.findTemplate(context.targetTenantId, templateId);
    if (!template) {
      throw new SuiteCentralNotFoundError('template_not_found', 'Template not found.');
    }
    return template;
  }

  async createTemplate(
    context: SuiteCentralControlPlaneContext,
    input: CreateTemplateInput,
  ): Promise<TemplateView> {
    // Opaque id as the audit resourceId — see createEnvironment.
    const templateId = uuidv4();
    return this.audited(
      context,
      'template.create',
      'template',
      templateId,
      { name: input.name, sourceSystem: input.sourceSystem },
      async () =>
        this.repository.createTemplate(context.targetTenantId, templateId, input, context.actorUserId),
    );
  }

  // ── Monitoring configuration ───────────────────────────────────────────────

  async getMonitoringConfig(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
  ): Promise<MonitoringConfigView> {
    await this.requireEnvironment(context, environmentId);
    const config = await this.repository.findMonitoringConfig(context.targetTenantId, environmentId);
    if (!config) {
      throw new SuiteCentralNotFoundError('monitoring_not_found', 'Monitoring config not found.');
    }
    return config;
  }

  /**
   * Persist desired enablement and reconcile the runtime to match. The database
   * is the source of truth: the in-process timer is derived from it, so a restart
   * rebuilds the same set via `SuiteCentralMonitoringRuntime.start()`.
   */
  async setMonitoringConfig(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    input: UpsertMonitoringInput,
    expectedVersion: number,
  ): Promise<MonitoringConfigView> {
    await this.requireEnvironment(context, environmentId);
    return this.audited(
      context,
      'monitoring.configure',
      'environment',
      environmentId,
      { enabled: input.enabled, expectedVersion },
      async () => {
        // Validate before persistence: a zero/negative/NaN interval reaches
        // setInterval as ~1ms, turning one config row into a continuous probe
        // loop against the ERP. The runtime clamps too, but a bad value must not
        // be storable in the first place.
        if (input.intervalMs !== undefined) {
          if (!Number.isFinite(input.intervalMs) || input.intervalMs < MIN_MONITORING_INTERVAL_MS) {
            throw new SuiteCentralValidationError(
              'monitoring_interval_too_small',
              `intervalMs must be a finite value of at least ${MIN_MONITORING_INTERVAL_MS}ms.`,
            );
          }
          // An interval above Node's 32-bit timer delay is coerced to ~1ms, so an
          // absurdly large value is the FASTEST probe loop, not the slowest.
          if (input.intervalMs > MAX_MONITORING_INTERVAL_MS) {
            throw new SuiteCentralValidationError(
              'monitoring_interval_too_large',
              `intervalMs must be at most ${MAX_MONITORING_INTERVAL_MS}ms.`,
            );
          }
        }
        const config = await this.repository.upsertMonitoringConfig(
          context.targetTenantId,
          environmentId,
          input,
          context.actorUserId,
          expectedVersion,
        );
        if (config.enabled) {
          this.monitoring.startEnvironment(context, environmentId, config.intervalMs);
        } else {
          await this.monitoring.stopEnvironment(context.targetTenantId, environmentId);
        }
        return config;
      },
    );
  }

  /**
   * Resume the in-process timer for an environment whose persisted config is
   * enabled.
   *
   * This is a RUNTIME control, not a durable one: `setMonitoringConfig` is the
   * only way to change enablement. Starting a timer for a config that is
   * persisted as disabled would silently diverge from the database and vanish on
   * the next restart, so it is refused rather than honored.
   */
  async startMonitoring(context: SuiteCentralControlPlaneContext, environmentId: string): Promise<void> {
    const config = await this.getMonitoringConfig(context, environmentId);
    if (!config.enabled) {
      throw new SuiteCentralConflictError(
        'monitoring_not_enabled',
        'Monitoring is disabled for this environment; enable it before starting.',
      );
    }
    return this.audited(
      context,
      'monitoring.start',
      'environment',
      environmentId,
      { intervalMs: config.intervalMs },
      async () => {
        this.monitoring.startEnvironment(context, environmentId, config.intervalMs);
      },
    );
  }

  /**
   * Pause the in-process timer WITHOUT changing persisted enablement — the
   * environment resumes monitoring on the next restart. Use `setMonitoringConfig`
   * with `enabled: false` to stop it durably.
   */
  async stopMonitoring(context: SuiteCentralControlPlaneContext, environmentId: string): Promise<void> {
    await this.requireEnvironment(context, environmentId);
    return this.audited(
      context,
      'monitoring.stop',
      'environment',
      environmentId,
      { durable: false },
      async () => {
        await this.monitoring.stopEnvironment(context.targetTenantId, environmentId);
      },
    );
  }

  // ── Monitoring reads (tenant-scoped views of runtime state) ────────────────

  /** Latest health across every environment this tenant owns. */
  async getHealthReport(context: SuiteCentralControlPlaneContext): Promise<SuiteCentralEnvironmentHealth[]> {
    const environments = await this.repository.listEnvironments(context.targetTenantId);
    return environments.map((environment) => ({
      environmentId: environment.id,
      name: environment.name,
      latest: this.monitoring.getHealthHistory(context.targetTenantId, environment.id, 1)[0] ?? null,
    }));
  }

  async getHealthHistory(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    limit?: number,
  ): Promise<SuiteCentralHealthSample[]> {
    await this.requireEnvironment(context, environmentId);
    return this.monitoring.getHealthHistory(context.targetTenantId, environmentId, limit);
  }

  /** Measured throughput/latency for one environment. Never caller-supplied. */
  async getPerformance(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
  ): Promise<SuiteCentralUsageSnapshot | null> {
    await this.requireEnvironment(context, environmentId);
    return this.monitoring.getUsage(context.targetTenantId, environmentId);
  }

  async getAlerts(
    context: SuiteCentralControlPlaneContext,
    environmentId?: string,
  ): Promise<SuiteCentralAlert[]> {
    if (environmentId) {
      await this.requireEnvironment(context, environmentId);
    }
    return this.monitoring.getActiveAlerts(context.targetTenantId, environmentId);
  }

  /** Resolving an alert is an operator action on tenant state, so it is audited. */
  async resolveAlert(context: SuiteCentralControlPlaneContext, alertId: string): Promise<void> {
    return this.audited(context, 'monitoring.alert.resolve', 'alert', alertId, {}, async () => {
      // Tenant-scoped: an alert id belonging to another tenant is simply not found.
      if (!this.monitoring.resolveAlert(context.targetTenantId, alertId)) {
        throw new SuiteCentralNotFoundError('alert_not_found', 'Alert not found.');
      }
    });
  }

  async getDashboard(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
  ): Promise<{
    environment: EnvironmentView;
    health: SuiteCentralHealthSample[];
    usage: SuiteCentralUsageSnapshot | null;
    alerts: SuiteCentralAlert[];
  }> {
    const environment = await this.requireEnvironment(context, environmentId);
    return {
      environment,
      health: this.monitoring.getHealthHistory(context.targetTenantId, environmentId),
      usage: this.monitoring.getUsage(context.targetTenantId, environmentId),
      alerts: this.monitoring.getActiveAlerts(context.targetTenantId, environmentId),
    };
  }

  // ── Outbound operations ────────────────────────────────────────────────────

  async testConnection(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    credentialProfileId: string,
  ): Promise<{ ok: boolean }> {
    return this.audited(
      context,
      'connection.test',
      'environment',
      environmentId,
      { credentialProfileId },
      async () => {
        // The factory owns ownership + destination validation; it is the single
        // source of truth for both, so this path does not duplicate the checks.
        const connector = await this.connectorFactory.create(context, environmentId, credentialProfileId);
        return { ok: await connector.authenticate() };
      },
    );
  }

  async getSystemInfo(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    credentialProfileId: string,
  ): Promise<unknown> {
    return this.audited(
      context,
      'system.info',
      'environment',
      environmentId,
      { credentialProfileId },
      async () => {
        const connector = await this.connectorFactory.create(context, environmentId, credentialProfileId);
        return connector.getSystemInfo();
      },
    );
  }

  async bulkImport(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    credentialProfileId: string,
    entityType: string,
    records: DataRecord[],
  ): Promise<string> {
    return this.audited(
      context,
      'bulk.import',
      'environment',
      environmentId,
      { credentialProfileId, entityType, recordCount: records.length },
      async () => {
        const connector = await this.connectorFactory.create(context, environmentId, credentialProfileId);
        return governedBulkImport(
          { outboundGovernance: this.outboundGovernance },
          connector,
          context,
          entityType,
          records,
        );
      },
    );
  }

  async getBulkOperation(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    credentialProfileId: string,
    operationId: string,
  ): Promise<unknown> {
    return this.audited(
      context,
      'bulk.status',
      'environment',
      environmentId,
      { credentialProfileId, operationId },
      async () => {
        const connector = await this.connectorFactory.create(context, environmentId, credentialProfileId);
        return connector.getBulkOperationStatus(operationId);
      },
    );
  }

  async createWebhook(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    credentialProfileId: string,
    targetUrl: string,
    events: string[],
  ): Promise<string> {
    return this.audited(
      context,
      'webhook.create',
      'environment',
      environmentId,
      { credentialProfileId, eventCount: events.length },
      async () => {
        // A webhook target is attacker-influenced input that the ERP will later
        // call: validate it against the same allowlist/DNS rules as a base URL,
        // and before any connector exists.
        const destination = await this.outboundPolicy.validateWebhookTarget(targetUrl);
        const connector = await this.connectorFactory.create(context, environmentId, credentialProfileId);
        return governedSetupWebhook({ outboundGovernance: this.outboundGovernance }, connector, context, {
          targetUrl: destination.canonicalUrl,
          events,
        });
      },
    );
  }

  async deleteWebhook(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    credentialProfileId: string,
    webhookId: string,
  ): Promise<boolean> {
    return this.audited(
      context,
      'webhook.delete',
      'environment',
      environmentId,
      { credentialProfileId, webhookId },
      async () => {
        const connector = await this.connectorFactory.create(context, environmentId, credentialProfileId);
        return governedRemoveWebhook(
          { outboundGovernance: this.outboundGovernance },
          connector,
          context,
          webhookId,
        );
      },
    );
  }

  // ── Allowed hosts (platform-scoped) ────────────────────────────────────────

  async listAllowedHosts(context: SuiteCentralControlPlaneContext): Promise<AllowedHostView[]> {
    this.requirePlatformAdmin(context);
    return this.repository.listAllowedHosts();
  }

  async createAllowedHost(
    context: SuiteCentralControlPlaneContext,
    input: CreateAllowedHostInput,
  ): Promise<AllowedHostView> {
    this.requirePlatformAdmin(context);
    // Opaque id as the audit resourceId — see createEnvironment.
    const hostId = uuidv4();
    return this.audited(
      context,
      'allowed_host.create',
      'allowed_host',
      hostId,
      { hostname: input.hostname },
      async () => this.repository.createAllowedHost(hostId, input, context.actorUserId),
    );
  }

  async revokeAllowedHost(
    context: SuiteCentralControlPlaneContext,
    hostId: string,
  ): Promise<AllowedHostView> {
    this.requirePlatformAdmin(context);
    return this.audited(
      context,
      'allowed_host.revoke',
      'allowed_host',
      hostId,
      {},
      async () => this.repository.revokeAllowedHost(hostId, context.actorUserId),
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Record the attempt, run the work, then record the outcome.
   *
   * An `attempt` failure propagates: work must never run unaudited. A `failure`
   * audit that itself fails is logged and swallowed so it cannot mask the real
   * error the caller needs to see.
   */
  private async audited<T>(
    context: SuiteCentralControlPlaneContext,
    action: string,
    resourceType: string,
    resourceId: string,
    details: SuiteCentralAuditDetails,
    work: () => Promise<T>,
  ): Promise<T> {
    // The attempt is inside the sanitizing path too. It was outside, which left
    // the one call that MUST fail closed as the only one whose failure escaped
    // raw — the audit backend and its governance scan are exactly the kind of
    // dependency that throws unstructured text.
    const startedAt = Date.now();
    try {
      await this.audit.attempt(context, action, resourceType, resourceId, details);
    } catch (error) {
      throw this.sanitizedFailure(context, action, error);
    }
    try {
      const result = await work();
      // Best-effort, deliberately asymmetric with `attempt`.
      //
      // The work has already happened — often an irreversible side effect in the
      // ERP. Letting this throw would (a) tell the caller a completed operation
      // failed, inviting a retry that duplicates a credential or a bulk import,
      // and (b) fall into the catch below, writing a FAILURE row for an operation
      // that succeeded — corrupting the very trail this class exists to keep
      // honest. Neither is worth trading for a success row.
      //
      // The attempt row already records that this ran; a missing success row is
      // itself the signal that it was interrupted, which is exactly why the
      // attempt is written first and why IT fails closed.
      try {
        await this.audit.success(context, action, resourceType, resourceId, details, Date.now() - startedAt);
      } catch (auditError) {
        this.logger.error('SuiteCentral success audit could not be written; operation DID complete', {
          correlationId: safeCorrelationId(context.correlationId),
          tenantId: context.targetTenantId,
          action,
          resourceType,
          resourceId,
          code: stableErrorCode(auditError, 'audit_write_failed'),
        });
      }
      return result;
    } catch (error) {
      try {
        await this.audit.failure(
          context,
          action,
          resourceType,
          resourceId,
          this.codeFor(error),
          Date.now() - startedAt,
        );
      } catch (auditError) {
        this.logger.error('SuiteCentral failure audit could not be written', {
          correlationId: safeCorrelationId(context.correlationId),
          action,
          code: stableErrorCode(auditError, 'audit_write_failed'),
        });
      }
      throw this.sanitizedFailure(context, action, error);
    }
  }

  /**
   * Domain errors cross the boundary as-is; anything else is replaced.
   *
   * A connector, factory, or secret-provider failure is unstructured third-party
   * text that can quote the request it failed on — and with it credential
   * material. Rethrowing it unchanged would hand that to a route response or a
   * log line. The raw error is logged here under a stable code and never travels
   * further.
   */
  private sanitizedFailure(
    context: SuiteCentralControlPlaneContext,
    action: string,
    error: unknown,
  ): unknown {
    if (error instanceof SuiteCentralControlPlaneError) return error;

    // `error.name` is writable, so a provider can put arbitrary text there — it is
    // no safer than `error.message`. Log the stable code instead; an unrecognized
    // error simply logs the fallback, which is the point.
    this.logger.error('SuiteCentral operation failed with a non-domain error', {
      correlationId: safeCorrelationId(context.correlationId),
      tenantId: context.targetTenantId,
      action,
      code: stableErrorCode(error, 'operation_failed'),
    });
    return new SuiteCentralInternalError('operation_failed', 'The operation could not be completed.');
  }

  private async requireEnvironment(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
  ): Promise<EnvironmentView> {
    const environment = await this.repository.findEnvironment(context.targetTenantId, environmentId);
    if (!environment) {
      throw new SuiteCentralNotFoundError('environment_not_found', 'Environment not found.');
    }
    return environment;
  }

  private async requireCredential(
    context: SuiteCentralControlPlaneContext,
    profileId: string,
  ): Promise<CredentialMetadataRow> {
    const credential = await this.repository.findCredentialMetadata(context.targetTenantId, profileId);
    if (!credential) {
      throw new SuiteCentralNotFoundError('credential_not_found', 'Credential not found.');
    }
    return credential;
  }

  private requirePlatformAdmin(context: SuiteCentralControlPlaneContext): void {
    if (context.accessMode !== 'platform_admin') {
      throw new SuiteCentralForbiddenError(
        'platform_admin_required',
        'This operation requires platform administrator access.',
      );
    }
  }

  /**
   * Remove a secret whose owning metadata does not exist (or no longer does).
   *
   * A cleanup failure is escalated rather than swallowed: it leaves real secret
   * material behind in the provider, which an operator must know about. The
   * `code` is supplied by the caller because the two call sites are different
   * events — a failed create that orphaned a secret, and a completed delete
   * whose secret outlived its row.
   *
   * `cause` is deliberately omitted from the thrown error: the underlying
   * secret-provider error is unstructured third-party text that may quote the
   * request (and therefore the secret). It is logged as a digest here and never
   * attached to an error that a route could serialize.
   */
  private async deleteOrphanedSecret(
    context: SuiteCentralControlPlaneContext,
    profileId: string,
    secretRef: string,
    code: 'credential_create_cleanup_failed' | 'credential_delete_cleanup_failed',
  ): Promise<void> {
    try {
      await this.secretStore.delete(context.targetTenantId, profileId, secretRef);
    } catch {
      // Log the reference DIGEST, never the reference itself and never the
      // secret — the digest is enough to find the row without widening exposure.
      this.logger.error('SuiteCentral orphaned secret could not be removed', {
        correlationId: safeCorrelationId(context.correlationId),
        tenantId: context.targetTenantId,
        secretRefDigest: this.digestOf(secretRef),
        code,
      });
      throw new SuiteCentralDependencyError(
        code,
        'A SuiteCentral secret could not be removed and may require manual cleanup.',
      );
    }
  }

  /**
   * Store a secret, converting any provider failure into a typed error.
   *
   * A secret-provider client rejects with unstructured third-party text that may
   * quote the failed request — including the secret it was asked to store. That
   * error must never propagate: `audited()` rethrows the original, so a route
   * could serialize it straight into a response or a log. Only a stable code
   * crosses this boundary.
   */
  private async storeSecretOrFail(
    context: SuiteCentralControlPlaneContext,
    profileId: string,
    clientSecret: string,
  ): Promise<string> {
    try {
      return await this.secretStore.store(context.targetTenantId, profileId, clientSecret);
    } catch {
      // A rejected store() does NOT prove nothing was written: the provider can
      // commit and then fail the response. Because the reference is a
      // deterministic function of (tenantId, profileId), we can name and remove
      // the possibly-written secret without ever having received a ref back.
      // Best-effort — the store failure is what the caller is told about.
      const derivedRef = this.secretStore.referenceFor(context.targetTenantId, profileId);
      try {
        await this.secretStore.delete(context.targetTenantId, profileId, derivedRef);
      } catch {
        this.logger.error('SuiteCentral secret store failed and speculative cleanup also failed', {
          correlationId: safeCorrelationId(context.correlationId),
          tenantId: context.targetTenantId,
          profileId,
          secretRefDigest: this.digestOf(derivedRef),
        });
      }
      this.logger.error('SuiteCentral secret could not be stored', {
        correlationId: safeCorrelationId(context.correlationId),
        tenantId: context.targetTenantId,
        profileId,
      });
      throw new SuiteCentralDependencyError(
        'secret_store_unavailable',
        'The secret store is unavailable.',
      );
    }
  }

  /**
   * Rotate a secret, converting any provider failure into a typed error.
   *
   * The message deliberately does NOT promise the previous secret survived. A
   * rejected write is not proof nothing was written — the provider can commit and
   * then fail the response — so which secret is live afterwards is genuinely
   * unknown. Claiming otherwise would send an operator to the wrong conclusion.
   */
  private async rotateSecretOrFail(
    context: SuiteCentralControlPlaneContext,
    profileId: string,
    secretRef: string,
    clientSecret: string,
  ): Promise<void> {
    try {
      await this.secretStore.rotate(context.targetTenantId, profileId, secretRef, clientSecret);
    } catch {
      this.logger.error('SuiteCentral secret could not be rotated', {
        correlationId: safeCorrelationId(context.correlationId),
        tenantId: context.targetTenantId,
        profileId,
      });
      throw new SuiteCentralDependencyError(
        'secret_rotate_failed',
        'The secret store did not confirm the rotation; the credential may hold either the previous or the new secret. Retry, then verify with a connection test.',
      );
    }
  }

  /**
   * Whether a credential row is provably absent. A lookup failure returns false
   * (fail-closed for cleanup): retaining an orphaned secret is recoverable, while
   * deleting one whose row survived is not.
   */
  private async credentialRowIsAbsent(
    context: SuiteCentralControlPlaneContext,
    profileId: string,
  ): Promise<boolean> {
    try {
      return (await this.repository.findCredentialMetadata(context.targetTenantId, profileId)) === undefined;
    } catch {
      return false;
    }
  }

  private digestOf(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
  }

  private toCredentialView(meta: CredentialMetadataRow): CredentialProfileView {
    return {
      id: meta.id,
      environmentId: meta.environmentId,
      name: meta.name,
      clientId: meta.clientId,
      companyId: meta.companyId,
      scopes: meta.scopes,
      isActive: meta.isActive,
      secretConfigured: meta.secretRef.length > 0,
      rotatedAt: meta.rotatedAt,
      lastUsedAt: meta.lastUsedAt,
      version: meta.version,
    };
  }

  /**
   * Typed control-plane errors carry a stable code; anything else is generic.
   * See {@link stableErrorCode} for why the shape is enforced, not assumed.
   */
  private codeFor(error: unknown): string {
    return stableErrorCode(error, 'operation_failed');
  }
}
