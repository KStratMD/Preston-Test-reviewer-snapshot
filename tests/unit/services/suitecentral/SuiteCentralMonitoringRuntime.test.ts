import { SuiteCentralMonitoringRuntime } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralMonitoringRuntime';
import { SuiteCentralDestinationRejectedError } from '../../../../src/services/suitecentral/controlPlane/errors';
import type { Logger } from '../../../../src/utils/Logger';
import type { SuiteCentralControlPlaneContext } from '../../../../src/services/suitecentral/controlPlane/domain';

const ctxA: SuiteCentralControlPlaneContext = {
  actorUserId: 'user-a',
  targetTenantId: 'tenant-a',
  accessMode: 'tenant_admin',
  correlationId: 'corr-a',
};

const ctxB: SuiteCentralControlPlaneContext = {
  actorUserId: 'user-b',
  targetTenantId: 'tenant-b',
  accessMode: 'tenant_admin',
  correlationId: 'corr-b',
};

/**
 * Runtime keys are JSON-encoded rather than `${tenantId}:${environmentId}` so the
 * mapping stays injective when an id contains the delimiter.
 */
const key = (tenantId: string, environmentId: string) => JSON.stringify([tenantId, environmentId]);

function credential(id: string, environmentId: string) {
  return {
    id,
    environmentId,
    name: 'primary',
    clientId: 'client-abc',
    companyId: null,
    scopes: [],
    isActive: true,
    secretConfigured: true,
    rotatedAt: null,
    lastUsedAt: null,
    version: 1,
  };
}

describe('SuiteCentralMonitoringRuntime', () => {
  let repository: {
    listEnabledMonitoringConfigs: jest.Mock;
    listCredentials: jest.Mock;
  };
  let connectorFactory: { create: jest.Mock };
  let audit: { success: jest.Mock; failure: jest.Mock };
  let logger: Logger;
  let runtime: SuiteCentralMonitoringRuntime;

  beforeEach(() => {
    repository = {
      listEnabledMonitoringConfigs: jest.fn(async () => []),
      listCredentials: jest.fn(async (_tenantId: string, environmentId: string) => [
        credential('cred-1', environmentId),
      ]),
    };
    connectorFactory = {
      create: jest.fn(async () => ({ authenticate: jest.fn(async () => true) })),
    };
    audit = { success: jest.fn(async () => undefined), failure: jest.fn(async () => undefined) };
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    runtime = new SuiteCentralMonitoringRuntime(repository, connectorFactory, audit, logger);
  });

  afterEach(async () => {
    await runtime.stop();
    jest.useRealTimers();
  });

  describe('tenant keying', () => {
    it('does not collide when two tenants use the same environment id', () => {
      runtime.startEnvironment(ctxA, 'same-id', 60_000);
      runtime.startEnvironment(ctxB, 'same-id', 60_000);

      expect(runtime.activeKeys().sort()).toEqual(
        [key('tenant-a', 'same-id'), key('tenant-b', 'same-id')].sort(),
      );
    });

    it('does not collide when a tenant id contains the key delimiter', () => {
      // ("a:b", "c") and ("a", "b:c") both flatten to `a:b:c` under a plain
      // template — one tenant could then read the other's health or stop its timer.
      runtime.startEnvironment({ ...ctxA, targetTenantId: 'a:b' }, 'c', 60_000);
      runtime.startEnvironment({ ...ctxA, targetTenantId: 'a' }, 'b:c', 60_000);

      expect(runtime.activeKeys()).toHaveLength(2);
      expect(new Set(runtime.activeKeys()).size).toBe(2);
    });

    it('keeps health history separate per tenant for the same environment id', async () => {
      await runtime.tickEnvironment(ctxA, 'same-id');
      await runtime.tickEnvironment(ctxB, 'same-id');
      await runtime.tickEnvironment(ctxB, 'same-id');

      expect(runtime.getHealthHistory('tenant-a', 'same-id')).toHaveLength(1);
      expect(runtime.getHealthHistory('tenant-b', 'same-id')).toHaveLength(2);
    });

    it('never returns another tenant history, usage, or alerts', async () => {
      await runtime.tickEnvironment(ctxA, 'same-id');

      expect(runtime.getHealthHistory('tenant-b', 'same-id')).toEqual([]);
      expect(runtime.getUsage('tenant-b', 'same-id')).toBeNull();
      expect(runtime.getActiveAlerts('tenant-b')).toEqual([]);
    });
  });

  describe('lifecycle', () => {
    it('is idempotent on double start and does not leak a second timer', () => {
      runtime.startEnvironment(ctxA, 'env-1', 60_000);
      runtime.startEnvironment(ctxA, 'env-1', 60_000);

      expect(runtime.activeKeys()).toEqual([key('tenant-a', 'env-1')]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('stop() clears handles and awaits the in-flight probe', async () => {
      let releaseProbe: () => void = () => {};
      const probeStarted = new Promise<void>((resolveStarted) => {
        connectorFactory.create.mockImplementation(async () => {
          resolveStarted();
          await new Promise<void>((r) => {
            releaseProbe = r;
          });
          return { authenticate: jest.fn(async () => true) };
        });
      });

      const tick = runtime.tickEnvironment(ctxA, 'env-1');
      await probeStarted;

      let stopResolved = false;
      const stopping = runtime.stop().then(() => {
        stopResolved = true;
      });

      // stop() must not resolve while a probe is still running.
      await Promise.resolve();
      expect(stopResolved).toBe(false);

      releaseProbe();
      await tick;
      await stopping;
      expect(stopResolved).toBe(true);
      expect(runtime.activeKeys()).toEqual([]);
    });

    it('refuses new probes once stop() has begun and drains what is running', async () => {
      let release: () => void = () => {};
      const started = new Promise<void>((resolveStarted) => {
        connectorFactory.create.mockImplementation(async () => {
          resolveStarted();
          await new Promise<void>((r) => {
            release = r;
          });
          return { authenticate: jest.fn(async () => true) };
        });
      });

      const inflight = runtime.tickEnvironment(ctxA, 'env-1');
      await started;

      const stopping = runtime.stop();
      // A probe starting inside stop()'s drain window would not be in the
      // snapshot and would outlive shutdown, so it must be refused outright.
      await runtime.tickEnvironment(ctxA, 'env-2');
      expect(runtime.getHealthHistory('tenant-a', 'env-2')).toEqual([]);

      release();
      await Promise.all([inflight, stopping]);
    });

    it('drops health, usage, and alerts for a stopped environment', async () => {
      connectorFactory.create.mockRejectedValue(Object.assign(new Error('x'), { code: 'probe_failed' }));
      await runtime.tickEnvironment(ctxA, 'env-1');
      expect(runtime.getHealthHistory('tenant-a', 'env-1')).toHaveLength(1);
      expect(runtime.getActiveAlerts('tenant-a', 'env-1')).toHaveLength(1);

      await runtime.stopEnvironment('tenant-a', 'env-1');

      // Process-local state must not outlive the environment it describes.
      expect(runtime.getHealthHistory('tenant-a', 'env-1')).toEqual([]);
      expect(runtime.getUsage('tenant-a', 'env-1')).toBeNull();
      expect(runtime.getActiveAlerts('tenant-a', 'env-1')).toEqual([]);
    });

    it('stopEnvironment() removes only the targeted tenant/environment', async () => {
      runtime.startEnvironment(ctxA, 'same-id', 60_000);
      runtime.startEnvironment(ctxB, 'same-id', 60_000);

      await runtime.stopEnvironment('tenant-a', 'same-id');

      expect(runtime.activeKeys()).toEqual([key('tenant-b', 'same-id')]);
    });

    it('reconciles enabled configs once on start()', async () => {
      repository.listEnabledMonitoringConfigs.mockResolvedValue([
        { tenantId: 'tenant-a', environmentId: 'env-1', intervalMs: 60_000 },
        { tenantId: 'tenant-b', environmentId: 'env-2', intervalMs: 30_000 },
      ]);

      await runtime.start();

      expect(runtime.activeKeys().sort()).toEqual(
        [key('tenant-a', 'env-1'), key('tenant-b', 'env-2')].sort(),
      );
      expect(repository.listEnabledMonitoringConfigs).toHaveBeenCalledTimes(1);
    });

    it('starts nothing when no configs are enabled (inert on existing databases)', async () => {
      await runtime.start();

      expect(runtime.activeKeys()).toEqual([]);
      expect(connectorFactory.create).not.toHaveBeenCalled();
    });
  });

  describe('probe behavior', () => {
    it('re-enters factory validation on every tick rather than caching a connector', async () => {
      await runtime.tickEnvironment(ctxA, 'env-1');
      await runtime.tickEnvironment(ctxA, 'env-1');

      // A revoked host or rebound DNS answer must take effect on the next tick,
      // so the factory (which re-validates the destination) is re-entered each time.
      expect(connectorFactory.create).toHaveBeenCalledTimes(2);
      expect(connectorFactory.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetTenantId: 'tenant-a' }),
        'env-1',
        'cred-1',
      );
    });

    it('authenticates rather than trusting construction alone', async () => {
      // factory.create() validates the destination and resolves the secret, but
      // connector.initialize() makes no network call — reporting healthy on
      // construction would mask revoked credentials and an unreachable ERP.
      const authenticate = jest.fn(async () => false);
      connectorFactory.create.mockResolvedValue({ authenticate });

      await runtime.tickEnvironment(ctxA, 'env-1');

      expect(authenticate).toHaveBeenCalled();
      const [sample] = runtime.getHealthHistory('tenant-a', 'env-1');
      expect(sample.status).toBe('unhealthy');
      expect(sample.errorCode).toBe('authentication_failed');
    });

    it('records unhealthy when authentication throws', async () => {
      connectorFactory.create.mockResolvedValue({
        authenticate: jest.fn(async () => {
          throw Object.assign(new Error('token exchange failed'), { code: 'oauth_failed' });
        }),
      });

      await runtime.tickEnvironment(ctxA, 'env-1');

      expect(runtime.getHealthHistory('tenant-a', 'env-1')[0].status).toBe('unhealthy');
    });

    it('coalesces a concurrent probe for the same environment instead of overlapping', async () => {
      let release: () => void = () => {};
      const started = new Promise<void>((resolveStarted) => {
        connectorFactory.create.mockImplementation(async () => {
          resolveStarted();
          await new Promise<void>((r) => {
            release = r;
          });
          return { authenticate: jest.fn(async () => true) };
        });
      });

      const first = runtime.tickEnvironment(ctxA, 'env-1');
      await started;
      // A second probe while the first is in flight must join it, not replace its
      // in-flight entry — otherwise the first probe's cleanup would delete the
      // second's, and stop() would return while it was still running.
      const second = runtime.tickEnvironment(ctxA, 'env-1');

      release();
      await Promise.all([first, second]);

      expect(connectorFactory.create).toHaveBeenCalledTimes(1);
      expect(runtime.getHealthHistory('tenant-a', 'env-1')).toHaveLength(1);
    });

    it('stop() still awaits a probe that raced with another for the same key', async () => {
      let release: () => void = () => {};
      const started = new Promise<void>((resolveStarted) => {
        connectorFactory.create.mockImplementation(async () => {
          resolveStarted();
          await new Promise<void>((r) => {
            release = r;
          });
          return { authenticate: jest.fn(async () => true) };
        });
      });

      const first = runtime.tickEnvironment(ctxA, 'env-1');
      await started;
      const second = runtime.tickEnvironment(ctxA, 'env-1');

      let stopped = false;
      const stopping = runtime.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      release();
      await Promise.all([first, second, stopping]);
      expect(stopped).toBe(true);
    });

    it('audits the first result and every failure, but not steady-state healthy ticks', async () => {
      await runtime.tickEnvironment(ctxA, 'env-1');
      expect(audit.success).toHaveBeenCalledTimes(1); // first result is an event

      await runtime.tickEnvironment(ctxA, 'env-1');
      await runtime.tickEnvironment(ctxA, 'env-1');
      // Steady-state "still healthy" belongs in health history, not audit_logs —
      // auditing every tick would write thousands of rows per environment per day.
      expect(audit.success).toHaveBeenCalledTimes(1);
      expect(audit.failure).not.toHaveBeenCalled();
    });

    it('audits every transition in both directions', async () => {
      await runtime.tickEnvironment(ctxA, 'env-1'); // healthy (first result)
      connectorFactory.create.mockRejectedValue(Object.assign(new Error('x'), { code: 'oauth_failed' }));
      await runtime.tickEnvironment(ctxA, 'env-1'); // healthy -> unhealthy
      await runtime.tickEnvironment(ctxA, 'env-1'); // still unhealthy: every failure audits
      connectorFactory.create.mockResolvedValue({ authenticate: jest.fn(async () => true) });
      await runtime.tickEnvironment(ctxA, 'env-1'); // unhealthy -> healthy (recovery)

      expect(audit.failure).toHaveBeenCalledTimes(2);
      expect(audit.success).toHaveBeenCalledTimes(2);
      expect(audit.success).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetTenantId: 'tenant-a' }),
        'monitoring.probe',
        'environment',
        'env-1',
        { recovered: true },
        expect.any(Number),
      );
    });

    it('keeps reporting health when the audit backend is down', async () => {
      audit.success.mockRejectedValue(new Error('audit down'));

      // Monitoring is a background observer: an audit outage must not stop it.
      await expect(runtime.tickEnvironment(ctxA, 'env-1')).resolves.toBeUndefined();
      expect(runtime.getHealthHistory('tenant-a', 'env-1')).toHaveLength(1);
    });

    it('attributes scheduled probes to the system, not to whoever enabled monitoring', async () => {
      jest.useFakeTimers();
      // ctxA is a human request context (an admin calling setMonitoringConfig).
      runtime.startEnvironment(ctxA, 'env-1', 30_000);
      jest.advanceTimersByTime(30_000);
      await jest.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      const probeContext = connectorFactory.create.mock.calls[0][0];
      // Otherwise months of background probes audit as that admin personally...
      expect(probeContext.actorUserId).not.toBe('user-a');
      // ...replaying one correlationId on every tick.
      expect(probeContext.correlationId).not.toBe('corr-a');
      // Tenant scope is preserved — that is the part that must carry over.
      expect(probeContext.targetTenantId).toBe('tenant-a');
    });

    it('gives each scheduled tick its own correlation id', async () => {
      jest.useFakeTimers();
      runtime.startEnvironment(ctxA, 'env-1', 30_000);

      // Two successive ticks — one correlation id reused across every probe would
      // make trace correlation useless.
      for (let i = 0; i < 2; i += 1) {
        jest.advanceTimersByTime(30_000);
        await jest.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();
      }

      const ids = connectorFactory.create.mock.calls.map(
        (c: unknown[]) => (c[0] as { correlationId: string }).correlationId,
      );
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps the caller context for an operator-triggered probe', async () => {
      // A direct tick genuinely IS the operator's action, so it stays attributed.
      await runtime.tickEnvironment(ctxA, 'env-1');

      expect(connectorFactory.create.mock.calls[0][0]).toMatchObject({
        actorUserId: 'user-a',
        correlationId: 'corr-a',
      });
    });

    it('records a healthy sample with a measured duration', async () => {
      await runtime.tickEnvironment(ctxA, 'env-1');

      const [sample] = runtime.getHealthHistory('tenant-a', 'env-1');
      expect(sample.status).toBe('healthy');
      expect(typeof sample.responseTimeMs).toBe('number');
      expect(sample.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('derives usage from measured probes, never from a caller', async () => {
      await runtime.tickEnvironment(ctxA, 'env-1');
      await runtime.tickEnvironment(ctxA, 'env-1');

      const usage = runtime.getUsage('tenant-a', 'env-1');
      expect(usage).toMatchObject({ probes: 2, failures: 0 });
      expect(usage?.averageResponseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('records an unhealthy sample and raises an alert when the probe fails', async () => {
      connectorFactory.create.mockRejectedValue(new Error('destination_rejected'));

      await runtime.tickEnvironment(ctxA, 'env-1');

      const [sample] = runtime.getHealthHistory('tenant-a', 'env-1');
      expect(sample.status).toBe('unhealthy');
      expect(runtime.getActiveAlerts('tenant-a')).toHaveLength(1);
      expect(runtime.getUsage('tenant-a', 'env-1')).toMatchObject({ probes: 1, failures: 1 });
    });

    it('does not surface raw upstream error text through health, alerts, audit, or logs', async () => {
      // A token-shaped `.code` is NOT proof it is safe — an API key satisfies any
      // token regex. Only codes authored on our own typed errors are trusted.
      const SECRET = 'super_secret_value_shaped_like_a_token';
      connectorFactory.create.mockRejectedValue(
        Object.assign(new Error(`refused body {"secret":"${SECRET}"}`), { code: SECRET }),
      );

      await runtime.tickEnvironment(ctxA, 'env-1');

      const [sample] = runtime.getHealthHistory('tenant-a', 'env-1');
      expect(sample.errorCode).toBe('probe_failed');
      expect(runtime.getActiveAlerts('tenant-a')[0].code).toBe('probe_failed');
      expect(JSON.stringify(audit.failure.mock.calls)).not.toContain(SECRET);
      // The raw message must not reach the log either.
      expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(SECRET);
    });

    it('preserves the code from our own typed errors', async () => {
      connectorFactory.create.mockRejectedValue(
        new SuiteCentralDestinationRejectedError('destination_rejected', 'nope'),
      );

      await runtime.tickEnvironment(ctxA, 'env-1');

      expect(runtime.getHealthHistory('tenant-a', 'env-1')[0].errorCode).toBe('destination_rejected');
    });

    it('records unhealthy when the environment has no active credential to probe with', async () => {
      repository.listCredentials.mockResolvedValue([]);

      await runtime.tickEnvironment(ctxA, 'env-1');

      expect(runtime.getHealthHistory('tenant-a', 'env-1')[0].status).toBe('unhealthy');
      expect(connectorFactory.create).not.toHaveBeenCalled();
    });

    it('bounds retained alerts per tenant even when every alert is active', async () => {
      // One active alert per monitored environment. Exempting active alerts made
      // the cap nominal — it bounded nothing in exactly this shape.
      connectorFactory.create.mockRejectedValue(
        new SuiteCentralDestinationRejectedError('destination_rejected', 'nope'),
      );

      for (let i = 0; i < 130; i += 1) {
        await runtime.tickEnvironment(ctxA, `env-${i}`);
      }

      expect(runtime.getActiveAlerts('tenant-a').length).toBeLessThanOrEqual(100);
      // Eviction of a live signal is never silent.
      expect(logger.warn).toHaveBeenCalledWith(
        'SuiteCentral active alerts evicted at retention bound',
        expect.objectContaining({ tenantId: 'tenant-a' }),
      );
    });

    it('reschedules when the interval changes rather than silently keeping the old cadence', async () => {
      jest.useFakeTimers();
      runtime.startEnvironment(ctxA, 'env-1', 60_000);
      runtime.startEnvironment(ctxA, 'env-1', 30_000);

      expect(runtime.activeKeys()).toHaveLength(1);
      // An administrator who saves a new interval must get it — the old code saw
      // an existing timer, warned, and returned, so the change did nothing until
      // the next restart.
      jest.advanceTimersByTime(30_000);
      // The interval callback awaits several promises before reaching the factory,
      // so a single microtask tick is not enough to settle the chain.
      await jest.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(connectorFactory.create).toHaveBeenCalled();
    });

    it('preserves history across a cadence change', async () => {
      await runtime.tickEnvironment(ctxA, 'env-1');
      expect(runtime.getHealthHistory('tenant-a', 'env-1')).toHaveLength(1);

      runtime.startEnvironment(ctxA, 'env-1', 60_000);
      runtime.startEnvironment(ctxA, 'env-1', 45_000);

      // A cadence change is not a lifecycle change.
      expect(runtime.getHealthHistory('tenant-a', 'env-1')).toHaveLength(1);
    });

    it('refuses to register a timer once shutdown has begun', async () => {
      await runtime.stop();

      runtime.startEnvironment(ctxA, 'env-1', 60_000);

      // A timer registered after stop() cleared the map would never be cleared.
      expect(runtime.activeKeys()).toEqual([]);
    });

    it('holds the bound when active alerts alone reach it (slice(-0) returns everything)', async () => {
      // At exactly the bound, resolvedKeep is 0 — and `slice(-0)` is `slice(0)`,
      // which returns the WHOLE array, so every resolved alert would be retained
      // and the cap would silently not hold.
      connectorFactory.create.mockRejectedValue(
        new SuiteCentralDestinationRejectedError('destination_rejected', 'nope'),
      );
      // 40 alerts, then resolve them, so there is a resolved population to drop.
      for (let i = 0; i < 40; i += 1) {
        await runtime.tickEnvironment(ctxA, `old-${i}`);
      }
      for (const alert of runtime.getActiveAlerts('tenant-a')) {
        runtime.resolveAlert('tenant-a', alert.id);
      }
      // Now push active alerts up to and past the bound.
      for (let i = 0; i < 105; i += 1) {
        await runtime.tickEnvironment(ctxA, `new-${i}`);
      }

      const total = runtime.getActiveAlerts('tenant-a').length;
      expect(total).toBeLessThanOrEqual(100);
    });

    it('drops oldest resolved alerts once the retention bound is exceeded', async () => {
      let counter = 0;
      connectorFactory.create.mockImplementation(async () => {
        counter += 1;
        throw Object.assign(new Error('boom'), { code: `probe_failure_${counter}` });
      });

      for (let i = 0; i < 130; i += 1) {
        await runtime.tickEnvironment(ctxA, `env-${i}`);
      }
      // Resolve everything, then push one more alert to trigger a prune.
      for (const alert of runtime.getActiveAlerts('tenant-a')) {
        runtime.resolveAlert('tenant-a', alert.id);
      }
      await runtime.tickEnvironment(ctxA, 'env-final');

      expect(runtime.getActiveAlerts('tenant-a')).toHaveLength(1);
    });

    it('does not let one failing environment stop the others', async () => {
      connectorFactory.create.mockImplementation(async (_ctx: unknown, environmentId: string) => {
        if (environmentId === 'broken') throw new Error('boom');
        return { authenticate: jest.fn(async () => true) };
      });

      await runtime.tickEnvironment(ctxA, 'broken');
      await runtime.tickEnvironment(ctxA, 'healthy-env');

      expect(runtime.getHealthHistory('tenant-a', 'broken')[0].status).toBe('unhealthy');
      expect(runtime.getHealthHistory('tenant-a', 'healthy-env')[0].status).toBe('healthy');
      expect(runtime.activeKeys()).toEqual([]);
    });

    it('a rejected probe never rejects the scheduled tick', async () => {
      jest.useFakeTimers();
      connectorFactory.create.mockRejectedValue(new Error('boom'));

      runtime.startEnvironment(ctxA, 'env-1', 1_000);
      jest.advanceTimersByTime(1_000);

      // The interval callback must swallow probe failures; an unhandled rejection
      // inside a timer would take the process down.
      await expect(runtime.stop()).resolves.toBeUndefined();
    });
  });
});
