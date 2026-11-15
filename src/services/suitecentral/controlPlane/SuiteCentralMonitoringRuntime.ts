import { uuidv4 } from '../../../utils/uuid';
import type { Logger } from '../../../utils/Logger';
import type { SuiteCentralControlPlaneRepository } from './SuiteCentralControlPlaneRepository';
import type { SuiteCentralConnectorFactory } from './SuiteCentralConnectorFactory';
import type { SuiteCentralAuditWriter } from './SuiteCentralAuditWriter';
import type { SuiteCentralControlPlaneContext } from './domain';
import { SYSTEM_IDENTITY } from '../../governance/identityContext';
import { stableErrorCode } from './errors';

/**
 * Tenant-keyed monitoring runtime for the SuiteCentral control plane (PR-A5).
 *
 * Replaces the global timers and `Map<environmentId, …>` state in the legacy
 * `SuiteCentralMonitoringService`. That keying was a real cross-tenant defect:
 * two tenants owning environments with the same id shared one health history,
 * one usage counter, and one timer — so tenant B could read tenant A's health
 * and either could stop the other's monitoring. Every map here is keyed by an
 * injective (tenantId, environmentId) composite (see {@link keyFor}) and every
 * read is tenant-scoped.
 *
 * Lifecycle mirrors `EmbeddedRetentionJob`, the canonical Tier-B scheduled
 * service (idempotent start, no overlapping ticks, `stop()` awaits in-flight
 * work, `unref()` so a bare process can still exit) — one timer per monitored
 * environment instead of one per process.
 *
 * Probes re-enter the connector factory on EVERY tick and never cache a
 * connector, so a revoked allowlist row or a rebound DNS answer takes effect on
 * the next tick without waiting for a configuration edit.
 */

export type SuiteCentralHealthStatus = 'healthy' | 'unhealthy';

export interface SuiteCentralHealthSample {
  readonly status: SuiteCentralHealthStatus;
  /** Measured wall-clock duration of the probe. Never accepted from a caller. */
  readonly responseTimeMs: number;
  readonly checkedAt: string;
  /** Stable machine code on failure; never raw upstream text. */
  readonly errorCode?: string;
}

export interface SuiteCentralUsageSnapshot {
  readonly probes: number;
  readonly failures: number;
  readonly lastResponseTimeMs: number | null;
  readonly averageResponseTimeMs: number | null;
}

export interface SuiteCentralAlert {
  readonly id: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly code: string;
  readonly createdAt: string;
  resolvedAt: string | null;
}

/** Bound per-environment history so a long-lived process cannot grow without limit. */
const MAX_HEALTH_SAMPLES = 50;

/**
 * Bound retained alerts per tenant.
 *
 * Alerts are deduped per (environment, code) so a flapping probe cannot flood,
 * but that still allows one alert per monitored environment. Eviction order is
 * resolved-first, then OLDEST ACTIVE if the tenant is still over the bound —
 * exempting active alerts made this cap nominal, since a tenant monitoring many
 * environments accumulates active alerts that were never dropped. Evicting a live
 * signal is logged rather than silent, and the condition is not lost: it remains
 * in health history and the next probe re-raises the alert.
 */
const MAX_RETAINED_ALERTS_PER_TENANT = 100;

/**
 * Floor on the probe interval. `setInterval` treats 0/negative/NaN as ~1ms, which
 * would hammer the ERP and flood the audit log from a single bad config row. The
 * service validates on write; this clamp is the defense-in-depth for a row that
 * predates the validation or was written directly.
 */
export const MIN_MONITORING_INTERVAL_MS = 30_000;

/**
 * Ceiling on the probe interval: Node's timers are backed by a signed 32-bit
 * delay, and `setInterval` silently coerces anything larger to ~1ms. So an
 * absurdly LARGE interval is not a slow probe — it is the fastest possible one,
 * arriving through the field meant to slow probes down. Bounding the top end is
 * as load-bearing as bounding the bottom.
 */
export const MAX_MONITORING_INTERVAL_MS = 2_147_483_647;

interface UsageAccumulator {
  probes: number;
  failures: number;
  totalResponseTimeMs: number;
  lastResponseTimeMs: number | null;
}

export class SuiteCentralMonitoringRuntime {
  /**
   * One interval handle per monitored (tenant, environment), with the cadence it
   * was created at — an interval change must be detectable, or a persisted new
   * cadence would silently never take effect.
   */
  private readonly timers = new Map<string, { handle: NodeJS.Timeout; intervalMs: number }>();

  /**
   * In-flight probes, tracked separately from `timers` rather than as a field on
   * the timer entry: a probe can also be driven directly (an operator-triggered
   * check, or `tickEnvironment` in tests) with no timer registered, and `stop()`
   * must still await it. Folding it into the timer entry would silently skip
   * exactly those probes on shutdown.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  /**
   * Set once `stop()` begins. `stop()` must await every probe, but awaiting a
   * snapshot leaves a window: an operator-triggered probe starting during that
   * await would not be in the snapshot and would outlive shutdown. New probes are
   * refused from this point and the drain loops until nothing is in flight.
   * Terminal by design — the process is shutting down.
   */
  private stopping = false;

  private readonly health = new Map<string, SuiteCentralHealthSample[]>();
  private readonly usage = new Map<string, UsageAccumulator>();
  /** Keyed by tenant so an alert read can never span tenants. */
  private readonly alerts = new Map<string, SuiteCentralAlert[]>();

  constructor(
    private readonly repository: Pick<
      SuiteCentralControlPlaneRepository,
      'listEnabledMonitoringConfigs' | 'listCredentials'
    >,
    private readonly connectorFactory: Pick<SuiteCentralConnectorFactory, 'create'>,
    private readonly audit: Pick<SuiteCentralAuditWriter, 'success' | 'failure'>,
    private readonly logger: Logger,
  ) {}

  /**
   * Reconcile persisted enablement once, after database readiness and before the
   * HTTP listen. Existing databases have no enabled configs, so this is inert
   * until an administrator turns monitoring on.
   */
  async start(): Promise<void> {
    const configs = await this.repository.listEnabledMonitoringConfigs();
    for (const config of configs) {
      this.startEnvironment(this.systemContext(config.tenantId), config.environmentId, config.intervalMs);
    }
    this.logger.info('SuiteCentral monitoring runtime started', { environments: configs.length });
  }

  startEnvironment(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    intervalMs: number,
  ): void {
    // Refuse admission once shutdown has begun: a timer registered after stop()
    // cleared the map would never be cleared, and its probes would silently no-op
    // forever.
    if (this.stopping) {
      this.logger.warn('SuiteCentral monitoring start refused during shutdown', {
        tenantId: context.targetTenantId,
        environmentId,
      });
      return;
    }
    const key = this.keyFor(context.targetTenantId, environmentId);
    const safeIntervalMs = this.clampInterval(context, environmentId, intervalMs);
    const existing = this.timers.get(key);
    if (existing) {
      // Idempotent for an unchanged cadence. But a CHANGED one must be applied:
      // returning early here meant an administrator could save a new interval,
      // see it persisted, and have the old cadence keep running until the next
      // restart — the setting silently doing nothing.
      if (existing.intervalMs === safeIntervalMs) {
        this.logger.warn('SuiteCentral monitoring already running for environment — ignoring', {
          tenantId: context.targetTenantId,
          environmentId,
        });
        return;
      }
      this.logger.info('SuiteCentral monitoring interval changed — rescheduling', {
        tenantId: context.targetTenantId,
        environmentId,
        previousIntervalMs: existing.intervalMs,
        intervalMs: safeIntervalMs,
      });
      // Replace only the timer. Health/usage/alerts are intentionally NOT purged:
      // this is a cadence change, not a lifecycle change, and the environment's
      // history should survive it.
      clearInterval(existing.handle);
      this.timers.delete(key);
    }
    const handle = setInterval(() => {
      // Skip rather than overlap: a slow probe must not stack ticks.
      if (this.inFlight.has(key)) {
        this.logger.warn('SuiteCentral monitoring probe still running — skipping tick', {
          tenantId: context.targetTenantId,
          environmentId,
        });
        return;
      }
      // A SCHEDULED probe is system-initiated, whoever enabled monitoring. The
      // enabling context often belongs to a request (setMonitoringConfig /
      // startMonitoring), and reusing it would attribute months of background
      // probes to that administrator personally and replay their correlationId on
      // every tick — collapsing trace correlation into one meaningless bucket and
      // making the audit trail actively misleading about who did what. A fresh
      // system context per tick keeps the tenant scope and nothing else.
      //
      // A direct `tickEnvironment(context, …)` call still carries the caller's
      // context, because an operator-triggered probe genuinely is theirs.
      const tickContext = this.systemContext(context.targetTenantId);
      // `tickEnvironment` absorbs probe failures, but guard anyway: an unhandled
      // rejection raised inside a timer callback would take the process down.
      void this.tickEnvironment(tickContext, environmentId).catch((error: unknown) => {
        // Log the stable code, never the raw message: a probe failure can
        // originate in the secret provider or the ERP client, whose text may
        // quote the request — and with it credential material.
        this.logger.error('SuiteCentral monitoring tick failed', {
          tenantId: context.targetTenantId,
          environmentId,
          code: this.codeFor(error),
        });
      });
    }, safeIntervalMs);

    if (typeof handle.unref === 'function') {
      handle.unref();
    }
    this.timers.set(key, { handle, intervalMs: safeIntervalMs });
  }

  /**
   * Raise a non-finite or too-small interval to the floor — clamp, don't refuse.
   *
   * Refusing here would silently stop monitoring an environment an administrator
   * asked to monitor, turning a bad number into a blind spot. The service rejects
   * such values on write, so anything reaching this path is a row that predates
   * that validation or was written directly; degrading it to a safe cadence keeps
   * the environment observed while still protecting the ERP.
   */
  private clampInterval(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    intervalMs: number,
  ): number {
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_MONITORING_INTERVAL_MS) {
      this.logger.warn('SuiteCentral monitoring interval below floor — clamping', {
        tenantId: context.targetTenantId,
        environmentId,
        requestedIntervalMs: intervalMs,
        appliedIntervalMs: MIN_MONITORING_INTERVAL_MS,
      });
      return MIN_MONITORING_INTERVAL_MS;
    }
    if (intervalMs > MAX_MONITORING_INTERVAL_MS) {
      // Left unclamped this becomes a ~1ms probe loop, not a slow one.
      this.logger.warn('SuiteCentral monitoring interval above Node timer limit — clamping', {
        tenantId: context.targetTenantId,
        environmentId,
        requestedIntervalMs: intervalMs,
        appliedIntervalMs: MAX_MONITORING_INTERVAL_MS,
      });
      return MAX_MONITORING_INTERVAL_MS;
    }
    return intervalMs;
  }

  async stopEnvironment(tenantId: string, environmentId: string): Promise<void> {
    const key = this.keyFor(tenantId, environmentId);
    const entry = this.timers.get(key);
    if (entry) {
      clearInterval(entry.handle);
      this.timers.delete(key);
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      await pending;
    }
    // Drop this environment's process-local state. Without this, health and
    // usage entries survive every environment that was ever probed — a deleted
    // environment's samples would outlive it for the life of the process. The
    // state is live-only and process-local by design (a restart rebuilds it from
    // the first probe), so retaining it past monitoring adds no durable value.
    this.health.delete(key);
    this.usage.delete(key);
    // Alerts are keyed by tenant, so drop only this environment's rows.
    const tenantAlerts = this.alerts.get(tenantId);
    if (tenantAlerts) {
      const remaining = tenantAlerts.filter((alert) => alert.environmentId !== environmentId);
      if (remaining.length > 0) this.alerts.set(tenantId, remaining);
      else this.alerts.delete(tenantId);
    }
  }

  /**
   * Run one probe. Failures are recorded as health, never thrown: one unhealthy
   * environment must not stop the others or reject a scheduled tick.
   */
  async tickEnvironment(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
  ): Promise<void> {
    if (this.stopping) return;
    const key = this.keyFor(context.targetTenantId, environmentId);

    // Coalesce rather than overlap. A timer-driven probe and an operator-triggered
    // one can race for the same key; storing the second over the first would let
    // the first probe's cleanup delete the second's entry, so stop() would return
    // while that probe was still running. Joining the in-flight probe also means a
    // slow environment cannot be stacked by repeated manual checks.
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const probe: Promise<void> = this.probe(context, environmentId).finally(() => {
      // Only clear the entry if it is still ours.
      if (this.inFlight.get(key) === probe) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, probe);
    return probe;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const entry of this.timers.values()) {
      clearInterval(entry.handle);
    }
    this.timers.clear();
    // Drain in a loop rather than awaiting one snapshot: a probe that began just
    // before `stopping` was set can still settle after the first await, and each
    // probe removes its own key as it finishes.
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  /**
   * Keys of environments with a live timer, in the opaque composite form produced
   * by {@link keyFor}. Treat them as opaque: the encoding exists for injectivity,
   * not for display, and callers must not parse or reconstruct them by hand.
   */
  activeKeys(): string[] {
    return [...this.timers.keys()];
  }

  getHealthHistory(tenantId: string, environmentId: string, limit = MAX_HEALTH_SAMPLES): SuiteCentralHealthSample[] {
    const samples = this.health.get(this.keyFor(tenantId, environmentId)) ?? [];
    return samples.slice(0, limit);
  }

  getUsage(tenantId: string, environmentId: string): SuiteCentralUsageSnapshot | null {
    const accumulator = this.usage.get(this.keyFor(tenantId, environmentId));
    if (!accumulator) return null;
    return {
      probes: accumulator.probes,
      failures: accumulator.failures,
      lastResponseTimeMs: accumulator.lastResponseTimeMs,
      averageResponseTimeMs:
        accumulator.probes > 0 ? accumulator.totalResponseTimeMs / accumulator.probes : null,
    };
  }

  getActiveAlerts(tenantId: string, environmentId?: string): SuiteCentralAlert[] {
    const tenantAlerts = this.alerts.get(tenantId) ?? [];
    return tenantAlerts.filter(
      (alert) => alert.resolvedAt === null && (!environmentId || alert.environmentId === environmentId),
    );
  }

  /** Resolve one alert. Tenant-scoped: an id from another tenant is not found. */
  resolveAlert(tenantId: string, alertId: string): boolean {
    const alert = (this.alerts.get(tenantId) ?? []).find((a) => a.id === alertId && a.resolvedAt === null);
    if (!alert) return false;
    alert.resolvedAt = new Date().toISOString();
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async probe(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const credentials = await this.repository.listCredentials(context.targetTenantId, environmentId);
      const credential = credentials.find((c) => c.isActive);
      if (!credential) {
        await this.record(context, environmentId, 'unhealthy', Date.now() - startedAt, 'no_active_credential');
        return;
      }

      // The factory re-validates the destination against the allowlist and live
      // DNS and resolves the secret — but `initialize()` performs NO network
      // call; it only validates and seals config. The OAuth token exchange is
      // `authenticate()`. Constructing alone would therefore report healthy while
      // the credentials are revoked or the ERP is unreachable, which is precisely
      // what monitoring exists to catch.
      const connector = await this.connectorFactory.create(context, environmentId, credential.id);
      if (!(await connector.authenticate())) {
        await this.record(context, environmentId, 'unhealthy', Date.now() - startedAt, 'authentication_failed');
        return;
      }
      await this.record(context, environmentId, 'healthy', Date.now() - startedAt);
    } catch (error) {
      // Same reasoning as the tick handler: the code is safe to log, the message
      // is not — it can carry secret-bearing provider text.
      this.logger.warn('SuiteCentral monitoring probe failed', {
        tenantId: context.targetTenantId,
        environmentId,
        code: this.codeFor(error),
      });
      await this.record(context, environmentId, 'unhealthy', Date.now() - startedAt, this.codeFor(error));
    }
  }

  private async record(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    status: SuiteCentralHealthStatus,
    responseTimeMs: number,
    errorCode?: string,
  ): Promise<void> {
    const key = this.keyFor(context.targetTenantId, environmentId);

    const samples = this.health.get(key) ?? [];
    const previousStatus = samples[0]?.status;
    samples.unshift({ status, responseTimeMs, checkedAt: new Date().toISOString(), errorCode });
    this.health.set(key, samples.slice(0, MAX_HEALTH_SAMPLES));

    await this.auditProbe(context, environmentId, status, responseTimeMs, previousStatus, errorCode);

    const accumulator = this.usage.get(key) ?? {
      probes: 0,
      failures: 0,
      totalResponseTimeMs: 0,
      lastResponseTimeMs: null,
    };
    accumulator.probes += 1;
    accumulator.totalResponseTimeMs += responseTimeMs;
    accumulator.lastResponseTimeMs = responseTimeMs;
    if (status === 'unhealthy') accumulator.failures += 1;
    this.usage.set(key, accumulator);

    if (status === 'unhealthy' && errorCode) {
      this.raiseAlert(context.targetTenantId, environmentId, errorCode);
    }
  }

  /**
   * Audit a probe on FAILURE or on a health-state TRANSITION — not on every tick.
   *
   * A probe is outbound: it resolves a secret and authenticates to the ERP, so it
   * belongs in the audit trail. But it is also periodic and system-initiated, and
   * auditing every tick at the interval floor would write thousands of rows per
   * environment per day — enough to threaten `audit_logs` availability, which is
   * a poor trade for recording "still healthy" over and over.
   *
   * So the split is: the audit trail carries the events (first result, every
   * failure, every recovery), and the bounded per-tenant health history carries
   * the steady-state series. The decision to monitor at all is separately audited
   * by `setMonitoringConfig`.
   *
   * This deliberately does NOT write an attempt-before-egress row the way the
   * control-plane service does: an attempt row per tick has the same volume
   * problem, and an interrupted probe is already visible as a gap in the history.
   *
   * An audit failure is logged and swallowed: monitoring is a background observer
   * and must not stop reporting health because the audit backend is down.
   */
  private async auditProbe(
    context: SuiteCentralControlPlaneContext,
    environmentId: string,
    status: SuiteCentralHealthStatus,
    responseTimeMs: number,
    previousStatus: SuiteCentralHealthStatus | undefined,
    errorCode?: string,
  ): Promise<void> {
    const isFirstResult = previousStatus === undefined;
    const transitioned = previousStatus !== undefined && previousStatus !== status;
    if (status === 'healthy' && !isFirstResult && !transitioned) return;

    try {
      if (status === 'unhealthy') {
        await this.audit.failure(
          context,
          'monitoring.probe',
          'environment',
          environmentId,
          errorCode ?? 'probe_failed',
          responseTimeMs,
        );
      } else {
        await this.audit.success(
          context,
          'monitoring.probe',
          'environment',
          environmentId,
          { recovered: transitioned },
          responseTimeMs,
        );
      }
    } catch (error) {
      // Third raw-logging site on this path: same rule as the tick and probe
      // handlers — the code is safe to log, the message is not.
      this.logger.error('SuiteCentral monitoring probe audit could not be written', {
        tenantId: context.targetTenantId,
        environmentId,
        code: stableErrorCode(error, 'audit_write_failed'),
      });
    }
  }

  /** One active alert per (tenant, environment, code) — a flapping probe must not flood. */
  private raiseAlert(tenantId: string, environmentId: string, code: string): void {
    const tenantAlerts = this.alerts.get(tenantId) ?? [];
    const existing = tenantAlerts.find(
      (alert) => alert.environmentId === environmentId && alert.code === code && alert.resolvedAt === null,
    );
    if (existing) return;

    tenantAlerts.push({
      id: uuidv4(),
      tenantId,
      environmentId,
      code,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    this.alerts.set(tenantId, this.pruneAlerts(tenantId, tenantAlerts));
  }

  /**
   * Enforce the per-tenant retention bound: resolved alerts go first, then the
   * OLDEST ACTIVE ones if the tenant is still over.
   *
   * Exempting active alerts (the earlier behavior) left the cap nominal — a
   * tenant monitoring many environments accumulates one active alert per
   * (environment, code) and none were ever dropped, so the bound bounded nothing.
   * Dropping an active alert loses a live signal, so it is never silent: each
   * eviction is logged. The underlying condition is not lost either — it stays in
   * health history, and the next probe re-raises the alert.
   */
  private pruneAlerts(tenantId: string, alerts: SuiteCentralAlert[]): SuiteCentralAlert[] {
    if (alerts.length <= MAX_RETAINED_ALERTS_PER_TENANT) return alerts;

    const active = alerts.filter((alert) => alert.resolvedAt === null);
    const resolved = alerts.filter((alert) => alert.resolvedAt !== null);
    const resolvedKeep = Math.max(0, MAX_RETAINED_ALERTS_PER_TENANT - active.length);
    // Insertion order, so the tail is newest. Guard the zero case explicitly:
    // `slice(-0)` is `slice(0)` because -0 === 0 in JS, which returns the WHOLE
    // array — so at exactly the bound (keep = 0) every resolved alert would be
    // retained and the cap would silently not hold.
    const keptResolved = resolvedKeep > 0 ? resolved.slice(-resolvedKeep) : [];
    const keptActive = active.slice(-MAX_RETAINED_ALERTS_PER_TENANT);

    const dropped = alerts.length - (keptActive.length + keptResolved.length);
    if (active.length > keptActive.length) {
      this.logger.warn('SuiteCentral active alerts evicted at retention bound', {
        tenantId,
        activeAlerts: active.length,
        bound: MAX_RETAINED_ALERTS_PER_TENANT,
        droppedActive: active.length - keptActive.length,
      });
    }
    if (dropped > 0) {
      this.logger.debug('SuiteCentral alerts pruned', { tenantId, dropped });
    }
    return [...keptActive, ...keptResolved];
  }

  /**
   * Map a probe failure to a stable machine code. Raw upstream text must never
   * reach health state, alerts, or the audit row — see {@link stableErrorCode}.
   */
  private codeFor(error: unknown): string {
    return stableErrorCode(error, 'probe_failed');
  }

  private systemContext(tenantId: string): SuiteCentralControlPlaneContext {
    return {
      actorUserId: SYSTEM_IDENTITY.userId,
      targetTenantId: tenantId,
      accessMode: 'tenant_admin',
      correlationId: uuidv4(),
    };
  }

  /**
   * Injective composite key.
   *
   * A plain `${tenantId}:${environmentId}` template collides: ("a:b", "c") and
   * ("a", "b:c") both produce `a:b:c`, which would cross tenant health reads and
   * let one tenant stop another's timer. JSON-encoding the components escapes
   * and delimits them so the mapping is injective for ANY id content — the same
   * reasoning (and the same fix) as `SuiteCentralSecretStore.referenceFor`.
   */
  private keyFor(tenantId: string, environmentId: string): string {
    return JSON.stringify([tenantId, environmentId]);
  }
}
