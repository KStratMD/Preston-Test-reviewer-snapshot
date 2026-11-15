// ApprovalResumeWorker + ApprovalResumeRegistry unit tests (PR 3B).
//
// Mocks ApprovalQueueRepository (only claimForApply is exercised) and Logger.
// The registry is constructed real because it has no I/O — it's the in-memory
// dispatch table.
//
// Imports `reflect-metadata` before the decorated classes (Copilot R3): Jest
// fast config's `setupFilesAfterEnv` (tests/fastMocks.ts) does not load it,
// so a `Reflect.defineMetadata is not a function` failure could surface in
// isolation runs without this guard.
import 'reflect-metadata';

import {
  ApprovalResumeRegistry,
  ApprovalResumeWorker,
  type ApprovalResumeHandler,
} from '../../../../src/services/governance/ApprovalResumeWorker';
import type {
  ApprovalQueueRepository,
  PersistedApproval,
} from '../../../../src/services/governance/ApprovalQueueRepository';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function mockRepo() {
  return {
    insertPending: jest.fn(),
    getById: jest.fn(),
    listPendingForTenant: jest.fn(),
    countPendingForTenant: jest.fn(),
    decide: jest.fn(),
    claimForApply: jest.fn(),
    markApplySucceeded: jest.fn(),
    markApplyFailed: jest.fn(),
    expireStale: jest.fn(),
  };
}

function makeApproval(overrides: Partial<PersistedApproval> = {}): PersistedApproval {
  return {
    id: 'a1',
    tenantId: 't1',
    requesterUserId: 'u1',
    operationType: 'connector_write',
    resourceType: 'hubspot.contact',
    resourceId: 'new',
    riskLevel: 'high',
    redactedPayload: JSON.stringify({ email: '[REDACTED]' }),
    policyFindings: JSON.stringify(['email']),
    status: 'approved',
    createdAt: '2026-05-19T00:00:00.000Z',
    expiresAt: '2026-05-20T00:00:00.000Z',
    decidedAt: '2026-05-19T01:00:00.000Z',
    decidedByUserId: 'approver-u',
    decisionReason: null,
    applyIdempotencyKey: null,
    applyStatus: 'not_started',
    appliedAt: null,
    applyFailedAt: null,
    applyError: null,
    ...overrides,
  };
}

describe('ApprovalResumeRegistry', () => {
  it('starts empty', () => {
    const reg = new ApprovalResumeRegistry();
    expect(reg.size()).toBe(0);
    expect(reg.registeredKeys()).toEqual([]);
  });

  it('register + resolve round-trips by composite key', () => {
    const reg = new ApprovalResumeRegistry();
    const handler: ApprovalResumeHandler = {
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      apply: jest.fn(),
    };
    reg.register(handler);
    expect(reg.size()).toBe(1);
    expect(reg.registeredKeys()).toEqual(['connector_write::hubspot.contact']);
    expect(reg.resolve('connector_write', 'hubspot.contact')).toBe(handler);
  });

  it('returns null for unknown (operationType, resourceType) pair', () => {
    const reg = new ApprovalResumeRegistry();
    expect(reg.resolve('ai_call', 'openai_chat')).toBeNull();
  });

  it('refuses duplicate registration for the same key', () => {
    const reg = new ApprovalResumeRegistry();
    const a: ApprovalResumeHandler = {
      operationType: 'ai_call',
      resourceType: 'openai_chat',
      apply: jest.fn(),
    };
    const b: ApprovalResumeHandler = {
      operationType: 'ai_call',
      resourceType: 'openai_chat',
      apply: jest.fn(),
    };
    reg.register(a);
    expect(() => reg.register(b)).toThrow(/duplicate handler/);
  });
});

describe('ApprovalResumeWorker.resume', () => {
  it('returns skipped: not_approved for a non-approved row (defensive guard)', async () => {
    const repo = mockRepo();
    const reg = new ApprovalResumeRegistry();
    const worker = new ApprovalResumeWorker(
      repo as unknown as ApprovalQueueRepository,
      reg,
      mockLogger() as unknown as import('../../../../src/utils/Logger').Logger,
    );

    const result = await worker.resume(makeApproval({ status: 'pending' }));
    expect(result).toEqual({ applied: false, skipped: 'not_approved' });
    expect(repo.claimForApply).not.toHaveBeenCalled();
  });

  it('returns skipped: no_handler when registry has no entry', async () => {
    const repo = mockRepo();
    const reg = new ApprovalResumeRegistry();
    const worker = new ApprovalResumeWorker(
      repo as unknown as ApprovalQueueRepository,
      reg,
      mockLogger() as unknown as import('../../../../src/utils/Logger').Logger,
    );

    const result = await worker.resume(makeApproval());
    expect(result).toEqual({ applied: false, skipped: 'no_handler' });
    expect(repo.claimForApply).not.toHaveBeenCalled();
  });

  it('returns skipped: already_claimed when claimForApply returns null', async () => {
    const repo = mockRepo();
    repo.claimForApply.mockResolvedValue(null);

    const reg = new ApprovalResumeRegistry();
    const handlerApply = jest.fn();
    reg.register({
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      apply: handlerApply,
    });

    const worker = new ApprovalResumeWorker(
      repo as unknown as ApprovalQueueRepository,
      reg,
      mockLogger() as unknown as import('../../../../src/utils/Logger').Logger,
    );

    const result = await worker.resume(makeApproval());
    expect(result).toEqual({ applied: false, skipped: 'already_claimed' });
    expect(handlerApply).not.toHaveBeenCalled();
  });

  it('applies via the registered handler and returns the result on success', async () => {
    const repo = mockRepo();
    const claimed = makeApproval({ applyIdempotencyKey: 'resume::a1' });
    repo.claimForApply.mockResolvedValue(claimed);

    const reg = new ApprovalResumeRegistry();
    const handlerApply = jest.fn().mockResolvedValue({ wrote: true, id: 'c1' });
    reg.register({
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      apply: handlerApply,
    });

    const worker = new ApprovalResumeWorker(
      repo as unknown as ApprovalQueueRepository,
      reg,
      mockLogger() as unknown as import('../../../../src/utils/Logger').Logger,
    );

    const result = await worker.resume(makeApproval());
    expect(result).toEqual({ applied: true, result: { wrote: true, id: 'c1' } });
    expect(repo.claimForApply).toHaveBeenCalledTimes(1);
    // Idempotency key derives from the approval id (stable for race semantics)
    expect(repo.claimForApply).toHaveBeenCalledWith({
      tenantId: 't1',
      id: 'a1',
      idempotencyKey: 'resume::a1',
    });
    expect(handlerApply).toHaveBeenCalledWith(claimed);
    expect(repo.markApplySucceeded).toHaveBeenCalledWith({
      tenantId: 't1',
      id: 'a1',
      appliedAt: expect.any(String),
    });
  });

  it('returns {applied:false, error} when the handler throws (no propagation)', async () => {
    const repo = mockRepo();
    repo.claimForApply.mockResolvedValue(makeApproval({ applyIdempotencyKey: 'resume::a1' }));

    const reg = new ApprovalResumeRegistry();
    reg.register({
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      apply: jest.fn().mockRejectedValue(new Error('connector down')),
    });

    const worker = new ApprovalResumeWorker(
      repo as unknown as ApprovalQueueRepository,
      reg,
      mockLogger() as unknown as import('../../../../src/utils/Logger').Logger,
    );

    const result = await worker.resume(makeApproval());
    expect(result).toEqual({ applied: false, error: 'connector down' });
    expect(repo.markApplyFailed).toHaveBeenCalledWith({
      tenantId: 't1',
      id: 'a1',
      error: 'connector down',
      failedAt: expect.any(String),
    });
  });

  it('returns {applied:false, error} when claimForApply throws', async () => {
    const repo = mockRepo();
    repo.claimForApply.mockRejectedValue(new Error('db unavailable'));

    const reg = new ApprovalResumeRegistry();
    reg.register({
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      apply: jest.fn(),
    });

    const worker = new ApprovalResumeWorker(
      repo as unknown as ApprovalQueueRepository,
      reg,
      mockLogger() as unknown as import('../../../../src/utils/Logger').Logger,
    );

    const result = await worker.resume(makeApproval());
    expect(result).toEqual({ applied: false, error: 'db unavailable' });
  });

  it('race: two concurrent resume() calls — exactly one wins the CAS', async () => {
    const repo = mockRepo();
    const claimed = makeApproval({ applyIdempotencyKey: 'resume::a1' });
    // Simulate CAS: first call returns the claimed row, second returns null
    repo.claimForApply
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce(null);

    const reg = new ApprovalResumeRegistry();
    const handlerApply = jest.fn().mockResolvedValue({ wrote: true });
    reg.register({
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      apply: handlerApply,
    });

    const worker = new ApprovalResumeWorker(
      repo as unknown as ApprovalQueueRepository,
      reg,
      mockLogger() as unknown as import('../../../../src/utils/Logger').Logger,
    );

    const [a, b] = await Promise.all([
      worker.resume(makeApproval()),
      worker.resume(makeApproval()),
    ]);

    const applied = [a, b].filter((r) => r.applied === true);
    const skipped = [a, b].filter((r) => 'skipped' in r && r.skipped === 'already_claimed');
    expect(applied).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(handlerApply).toHaveBeenCalledTimes(1);
  });
});
