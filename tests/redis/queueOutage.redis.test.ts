/**
 * Boot-and-degrade against an UNREACHABLE Redis, using real BullMQ (#1102).
 *
 * This is the test whose absence let a process-killing defect through four
 * review rounds, a Copilot pass, and a live-head sweep. Every other gate
 * mocked BullMQ — and a mock never opens a socket, never emits a real
 * connection error, and never leaves a promise rejecting after a race has
 * been decided. The real-Redis lifecycle suite only proves the happy path,
 * because there Redis is up.
 *
 * It needs no Redis, only a port with nothing on it, so it could have run on
 * any machine at any point. That is the lesson worth keeping: the expensive
 * dependency was never the blocker to testing the failure path.
 *
 * What the earlier implementation actually did against a closed port:
 *   - Queue/Worker/QueueEvents emitted 'error' with no listener  -> process died
 *   - waitUntilReady() never rejected, it retried forever        -> startup hung
 *   - closing a Worker mid-reconnect rejected unobserved         -> process died
 *
 * Lives in the redis profile because that profile omits the hermetic
 * setupEnv (which forces DISABLE_REDIS=1) and runs with forceExit disabled,
 * so a leaked handle surfaces instead of being papered over.
 */

// A port deliberately left closed. Not 6379: the Redis-backed job in CI has a
// live server there, and this test must exercise the unreachable path even
// when Redis is healthy.
const DEAD_PORT = 6399;

process.env.DISABLE_REDIS = '0';
process.env.REDIS_URL = `redis://127.0.0.1:${DEAD_PORT}`;
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'redis-outage-test-secret-123456789012345678901234567890';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
import type { Logger } from '../../src/utils/Logger';

const silentLogger = (): Logger =>
  ({
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child() {
      return this;
    },
    setCorrelationId() {
      return this;
    },
    withCorrelationId() {
      return this;
    },
    getCorrelationId: () => 'redis-outage-test',
  }) as unknown as Logger;

describe('batch queue against an unreachable Redis (real bullmq)', () => {
  let unhandled: unknown[] = [];
  const capture = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', capture);
    process.on('uncaughtException', capture);
  });

  afterEach(() => {
    process.off('unhandledRejection', capture);
    process.off('uncaughtException', capture);
  });

  it('degrades to unavailable, stays alive, and raises nothing unhandled', async () => {
    const { QueueService } = require('../../src/services/QueueService');
    const service = new QueueService(silentLogger());

    expect(service.getAvailability()).toBe('uninitialized');

    // Must resolve, not reject: this runs before Server.start() opens the
    // port, so a throw here aborts startup and a hang here blocks it. Both
    // are worse than degrading, and the production image boots Redis-less on
    // the one machine-required check.
    await expect(
      service.initializeQueue('outage-probe', async () => undefined),
    ).resolves.toBeUndefined();

    expect(service.getAvailability()).toBe('unavailable');
    expect(service.isReady()).toBe(false);

    // Let the retry loop run well past the point where the old implementation
    // died, so a late orphaned rejection has time to surface.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    expect(unhandled).toEqual([]);

    // Refusal, not a synthetic success, while unavailable.
    const { ServiceUnavailableAppError } = require('../../src/errors/AppError');
    await expect(
      service.addBatchJob('outage-probe', 'process-integration-batch', {
        integrationId: 'outage-test',
        records: [],
        batchSize: 10,
      }),
    ).rejects.toThrow(ServiceUnavailableAppError);

    // Shutdown must also settle rather than hang: QueueEvents.close() does not
    // resolve against a dead Redis, so it is bounded internally.
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(unhandled).toEqual([]);
  }, 45000);
});
