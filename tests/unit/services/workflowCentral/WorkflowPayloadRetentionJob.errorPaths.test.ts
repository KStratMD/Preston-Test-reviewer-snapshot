import 'reflect-metadata';
import { WorkflowPayloadRetentionJob } from '../../../../src/services/workflowCentral/WorkflowPayloadRetentionJob';

// ---------------------------------------------------------------------------
// Error-path coverage for WorkflowPayloadRetentionJob.
//
// Why this file exists: the happy paths and scheduling are covered by
// WorkflowPayloadRetentionJob.test.ts. The two branches that were NOT exercised
// were the failure paths - what the reaper does when the repository throws.
// For the data-liability story, "what happens when the ephemeral-payload sweep
// fails" is exactly the branch that matters: it must NOT crash the interval and
// must NOT silently report a successful sweep. These tests pin that contract.
//
// Branches covered:
//   - tick() catch block (logs error, returns zeroed counts, does not throw)
//   - start() setInterval .catch sink (a rejecting tick does not produce an
//     unhandled rejection and the interval survives)
// ---------------------------------------------------------------------------

function makeMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    withCorrelationId: jest.fn().mockReturnThis(),
  };
}

type MockRepo = {
  clearExpiredEphemeralPayloads: jest.Mock<
    Promise<{ tasksCleared: number; instancesCleared: number }>,
    [Date]
  >;
};

describe('WorkflowPayloadRetentionJob - error paths', () => {
  let logger: ReturnType<typeof makeMockLogger>;
  let repo: MockRepo;
  let job: WorkflowPayloadRetentionJob;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = makeMockLogger();
    repo = {
      clearExpiredEphemeralPayloads: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job = new WorkflowPayloadRetentionJob(repo as any, logger as any);
  });

  afterEach(async () => {
    await job.stop();
    jest.useRealTimers();
  });

  describe('tick() when the repository rejects', () => {
    it('logs the error and returns zeroed counts without throwing (Error instance)', async () => {
      const boom = new Error('db connection lost');
      repo.clearExpiredEphemeralPayloads.mockRejectedValueOnce(boom);

      const result = await job.tick(new Date('2026-06-01T00:00:00Z'));

      // Contract: never report a successful sweep on failure.
      expect(result).toEqual({ tasksCleared: 0, instancesCleared: 0 });
      // Contract: error logged with the Error as 2nd arg, message in metadata
      // under `errorMessage` (NOT `error`) per the Logger overwrite quirk.
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [msg, errArg, meta] = logger.error.mock.calls[0];
      expect(String(msg)).toContain('clearExpiredEphemeralPayloads failed');
      expect(errArg).toBe(boom);
      expect(meta).toEqual({ errorMessage: 'db connection lost' });
    });

    it('handles a non-Error rejection (string) without throwing', async () => {
      repo.clearExpiredEphemeralPayloads.mockRejectedValueOnce('weird failure');

      const result = await job.tick(new Date('2026-06-01T00:00:00Z'));

      expect(result).toEqual({ tasksCleared: 0, instancesCleared: 0 });
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [, errArg, meta] = logger.error.mock.calls[0];
      // Non-Error: 2nd arg is undefined, message is String(err).
      expect(errArg).toBeUndefined();
      expect(meta).toEqual({ errorMessage: 'weird failure' });
    });
  });

  describe('start() interval survives a rejecting tick', () => {
    it('does not surface an unhandled rejection and keeps ticking', async () => {
      // First tick rejects, second resolves - the interval must survive the first.
      repo.clearExpiredEphemeralPayloads
        .mockRejectedValueOnce(new Error('transient blip'))
        .mockResolvedValueOnce({ tasksCleared: 2, instancesCleared: 1 });

      job.start(1000);

      // First tick (rejects). Pump the microtask queue enough times for the
      // rejected promise + its .catch handler to fully settle before the next
      // timer fires - a rejecting async interval callback needs several turns.
      jest.advanceTimersByTime(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Second tick (resolves) - proves the interval was not torn down by the throw.
      jest.advanceTimersByTime(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(repo.clearExpiredEphemeralPayloads).toHaveBeenCalledTimes(2);
      // The failing tick was logged; the successful one logged its completion.
      expect(logger.error).toHaveBeenCalled();
    });
  });
});