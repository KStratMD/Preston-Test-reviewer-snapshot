/**
 * ApprovalQueueService — Unit Tests (PR 3A).
 *
 * Mocks `ApprovalQueueRepository` and `Logger` directly — the repo's DB
 * behavior is exercised by its own integration suite. This file pins the
 * service's domain contracts: enqueue validation, CAS-outcome → typed-error
 * mapping, reject reason gate, and pass-through verbs.
 */

import { ApprovalQueueService, type EnqueueArgs } from '../../../../src/services/governance/ApprovalQueueService';
import type {
  ApprovalQueueRepository,
  PersistedApproval,
  DecideOutcome,
} from '../../../../src/services/governance/ApprovalQueueRepository';
import type { OutboundDecision } from '../../../../src/services/governance/OutboundGovernanceService';
import {
  AlreadyDecidedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  InvalidDecisionError,
  UnredactedPayloadError,
} from '../../../../src/services/governance/ApprovalQueueErrors';

// ── Fixtures ───────────────────────────────────────────────────────

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function mockRepo() {
  return {
    insertPending: jest.fn(),
    getById: jest.fn(),
    listPendingForTenant: jest.fn(),
    countPendingForTenant: jest.fn(),
    listByTerminalStatusForTenant: jest.fn(),
    countByTerminalStatusForTenant: jest.fn(),
    decide: jest.fn(),
    claimForApply: jest.fn(),
    expireStale: jest.fn(),
  };
}

function makeDecision(overrides: Partial<OutboundDecision> = {}): OutboundDecision {
  return {
    approved: false,
    approvalRequired: true,
    redactedPayload: { text: '[REDACTED]' },
    findings: ['ssn'],
    riskLevel: 'high',
    auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
    ...overrides,
  };
}

function makeEnqueueArgs(overrides: Partial<EnqueueArgs> = {}): EnqueueArgs {
  return {
    tenantId: 't1',
    requesterUserId: 'u1',
    operationType: 'ai_call',
    resourceType: 'openai_chat',
    resourceId: 'res-1',
    decision: makeDecision(),
    ...overrides,
  };
}

function makePersistedApproval(overrides: Partial<PersistedApproval> = {}): PersistedApproval {
  return {
    id: 'approval-1',
    tenantId: 't1',
    requesterUserId: 'u1',
    operationType: 'ai_call',
    resourceType: 'openai_chat',
    resourceId: 'res-1',
    riskLevel: 'high',
    redactedPayload: '{"text":"[REDACTED]"}',
    policyFindings: '["ssn"]',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    decidedAt: null,
    decidedByUserId: null,
    decisionReason: null,
    applyIdempotencyKey: null,
    ...overrides,
  };
}

// ── enqueue ────────────────────────────────────────────────────────

describe('ApprovalQueueService.enqueue', () => {
  it('throws InvalidDecisionError when decision.approvalRequired is false', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);
    const args = makeEnqueueArgs({ decision: makeDecision({ approvalRequired: false }) });
    await expect(svc.enqueue(args)).rejects.toBeInstanceOf(InvalidDecisionError);
    expect(repo.insertPending).not.toHaveBeenCalled();
  });

  it('throws InvalidDecisionError when decision.redactedPayload is undefined', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);
    const args = makeEnqueueArgs({ decision: makeDecision({ redactedPayload: undefined }) });
    await expect(svc.enqueue(args)).rejects.toBeInstanceOf(InvalidDecisionError);
    expect(repo.insertPending).not.toHaveBeenCalled();
  });

  // Copilot R2 on PR #819: OutboundGovernanceService falls back to the
  // ORIGINAL payload when scanResult.redactedData is missing. Without this
  // guard, queue-mode would persist raw PII into governance_approvals
  // (the "redactedPayload" field would actually contain the unredacted
  // original). Fail-closed by asserting auditMetadata.redacted === true.
  it('throws UnredactedPayloadError when approvalRequired=true but auditMetadata.redacted=false (scan ran but produced no redacted form)', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);
    const decision = makeDecision({
      // Simulates OutboundGovernanceService's fallback path: scan detected PII
      // (findings populated), classified high-risk → approvalRequired=true, but
      // scanResult.redactedData was missing so redactedPayload === original payload
      // and auditMetadata.redacted === false.
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: false, blocked: false },
    });
    const args = makeEnqueueArgs({ decision });
    await expect(svc.enqueue(args)).rejects.toBeInstanceOf(UnredactedPayloadError);
    expect(repo.insertPending).not.toHaveBeenCalled();
  });

  it('does not throw UnredactedPayloadError when auditMetadata.redacted=true (the happy path)', async () => {
    const repo = mockRepo();
    repo.insertPending.mockResolvedValue(makePersistedApproval());
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);
    // The default fixture sets auditMetadata.redacted === true.
    await expect(svc.enqueue(makeEnqueueArgs())).resolves.toBeDefined();
    expect(repo.insertPending).toHaveBeenCalledTimes(1);
  });

  it('calls repo.insertPending with UUID, stringified payload + findings, and expiresAt = createdAt + 24h (default TTL)', async () => {
    const repo = mockRepo();
    repo.insertPending.mockResolvedValue(makePersistedApproval());
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const fixedNow = 1_700_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      await svc.enqueue(makeEnqueueArgs());
    } finally {
      dateSpy.mockRestore();
    }

    expect(repo.insertPending).toHaveBeenCalledTimes(1);
    const row = repo.insertPending.mock.calls[0][0];
    // UUID v4-ish
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(row.tenantId).toBe('t1');
    expect(row.requesterUserId).toBe('u1');
    expect(row.operationType).toBe('ai_call');
    expect(row.resourceType).toBe('openai_chat');
    expect(row.resourceId).toBe('res-1');
    expect(row.riskLevel).toBe('high');
    expect(row.redactedPayload).toBe(JSON.stringify({ text: '[REDACTED]' }));
    expect(row.policyFindings).toBe(JSON.stringify(['ssn']));
    expect(row.createdAt).toBe(new Date(fixedNow).toISOString());
    expect(row.expiresAt).toBe(new Date(fixedNow + 24 * 60 * 60 * 1000).toISOString());
  });

  it('returns the generated id', async () => {
    const repo = mockRepo();
    repo.insertPending.mockResolvedValue(makePersistedApproval());
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const id = await svc.enqueue(makeEnqueueArgs());
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // The returned id must equal the one written to the repo.
    expect(repo.insertPending.mock.calls[0][0].id).toBe(id);
  });

  it('logger.info called on success with tenantId + approvalId + operationType', async () => {
    const repo = mockRepo();
    repo.insertPending.mockResolvedValue(makePersistedApproval());
    const logger = mockLogger();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, logger as any);

    const id = await svc.enqueue(makeEnqueueArgs());

    expect(logger.info).toHaveBeenCalledWith(
      'approval queued',
      expect.objectContaining({
        tenantId: 't1',
        approvalId: id,
        operationType: 'ai_call',
      }),
    );
  });
});

// ── approve ────────────────────────────────────────────────────────

describe('ApprovalQueueService.approve', () => {
  it('calls repo.decide with decision="approved" and returns repo row on outcome="updated"', async () => {
    const repo = mockRepo();
    const row = makePersistedApproval({ status: 'approved', decidedByUserId: 'op-1' });
    const outcome: DecideOutcome = { outcome: 'updated', row };
    repo.decide.mockResolvedValue(outcome);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const result = await svc.approve({ tenantId: 't1', id: 'approval-1', approverUserId: 'op-1' });

    expect(repo.decide).toHaveBeenCalledTimes(1);
    const args = repo.decide.mock.calls[0][0];
    expect(args).toEqual(expect.objectContaining({
      tenantId: 't1',
      id: 'approval-1',
      decidedByUserId: 'op-1',
      decision: 'approved',
      decisionReason: null,
    }));
    expect(typeof args.decidedAt).toBe('string');
    expect(result).toBe(row);
  });

  it('throws ApprovalNotFoundError on repo outcome="not_found"', async () => {
    const repo = mockRepo();
    repo.decide.mockResolvedValue({ outcome: 'not_found' });
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    await expect(
      svc.approve({ tenantId: 't1', id: 'missing-id', approverUserId: 'op-1' }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });

  it('throws AlreadyDecidedError on repo outcome="already_decided" carrying the persisted row status', async () => {
    const repo = mockRepo();
    const row = makePersistedApproval({ status: 'rejected' });
    repo.decide.mockResolvedValue({ outcome: 'already_decided', row });
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    let captured: unknown;
    try {
      await svc.approve({ tenantId: 't1', id: 'approval-1', approverUserId: 'op-1' });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(AlreadyDecidedError);
    expect((captured as AlreadyDecidedError).currentStatus).toBe('rejected');
  });

  // R3 / Codex 5.4 HIGH + Copilot R3 #1: distinct ApprovalExpiredError for 410 mapping.
  it('throws ApprovalExpiredError on repo outcome="expired"', async () => {
    const repo = mockRepo();
    const row = makePersistedApproval({ status: 'pending' });
    repo.decide.mockResolvedValue({ outcome: 'expired', row });
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    await expect(
      svc.approve({ tenantId: 't1', id: 'approval-1', approverUserId: 'op-1' }),
    ).rejects.toBeInstanceOf(ApprovalExpiredError);
  });
});

// ── reject ─────────────────────────────────────────────────────────

describe('ApprovalQueueService.reject', () => {
  it('throws InvalidDecisionError when reason is undefined, empty, or whitespace-only', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    await expect(
      svc.reject({ tenantId: 't1', id: 'approval-1', approverUserId: 'op-1' }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);
    await expect(
      svc.reject({ tenantId: 't1', id: 'approval-1', approverUserId: 'op-1', reason: '' }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);
    await expect(
      svc.reject({ tenantId: 't1', id: 'approval-1', approverUserId: 'op-1', reason: '   ' }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);

    expect(repo.decide).not.toHaveBeenCalled();
  });

  it('calls repo.decide with decision="rejected" + reason on success', async () => {
    const repo = mockRepo();
    const row = makePersistedApproval({ status: 'rejected', decisionReason: 'bad data' });
    repo.decide.mockResolvedValue({ outcome: 'updated', row });
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const result = await svc.reject({
      tenantId: 't1',
      id: 'approval-1',
      approverUserId: 'op-1',
      reason: 'bad data',
    });

    expect(repo.decide).toHaveBeenCalledTimes(1);
    expect(repo.decide.mock.calls[0][0]).toEqual(expect.objectContaining({
      tenantId: 't1',
      id: 'approval-1',
      decidedByUserId: 'op-1',
      decision: 'rejected',
      decisionReason: 'bad data',
    }));
    expect(result).toBe(row);
  });

  it('throws ApprovalNotFoundError on repo outcome="not_found" (covers reject path through decide)', async () => {
    const repo = mockRepo();
    repo.decide.mockResolvedValue({ outcome: 'not_found' });
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    await expect(
      svc.reject({
        tenantId: 't1',
        id: 'missing-id',
        approverUserId: 'op-1',
        reason: 'because',
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });
});

// ── pass-through verbs ────────────────────────────────────────────

describe('ApprovalQueueService list + count + claimForApply pass-through', () => {
  it('listPending forwards tenantId + opts to repo.listPendingForTenant', async () => {
    const repo = mockRepo();
    const rows = [makePersistedApproval({ id: 'a' }), makePersistedApproval({ id: 'b' })];
    repo.listPendingForTenant.mockResolvedValue(rows);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const opts = { limit: 5, offset: 10 };
    const result = await svc.listPending('t1', opts);

    expect(repo.listPendingForTenant).toHaveBeenCalledWith('t1', opts);
    expect(result).toBe(rows);
  });

  it('countPending forwards tenantId to repo.countPendingForTenant', async () => {
    const repo = mockRepo();
    repo.countPendingForTenant.mockResolvedValue(42);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const result = await svc.countPending('t1');

    expect(repo.countPendingForTenant).toHaveBeenCalledWith('t1');
    expect(result).toBe(42);
  });

  it('claimForApply forwards args to repo.claimForApply and returns the result', async () => {
    const repo = mockRepo();
    const claimed = makePersistedApproval({ applyIdempotencyKey: 'key-1' });
    repo.claimForApply.mockResolvedValue(claimed);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const args = { tenantId: 't1', id: 'approval-1', idempotencyKey: 'key-1' };
    const result = await svc.claimForApply(args);

    expect(repo.claimForApply).toHaveBeenCalledWith(args);
    expect(result).toBe(claimed);
  });

  // Tier-C history view pass-through.

  it('listByTerminalStatus forwards tenantId + status + opts to repo.listByTerminalStatusForTenant', async () => {
    const repo = mockRepo();
    const rows = [makePersistedApproval({ id: 'h-a', status: 'approved' })];
    repo.listByTerminalStatusForTenant.mockResolvedValue(rows);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const result = await svc.listByTerminalStatus('t1', 'approved', { limit: 5 });

    expect(repo.listByTerminalStatusForTenant).toHaveBeenCalledWith('t1', 'approved', { limit: 5 });
    expect(result).toBe(rows);
  });

  it('listByTerminalStatus forwards rejected status separately', async () => {
    const repo = mockRepo();
    const rows = [makePersistedApproval({ id: 'h-r', status: 'rejected' })];
    repo.listByTerminalStatusForTenant.mockResolvedValue(rows);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    await svc.listByTerminalStatus('t1', 'rejected');

    expect(repo.listByTerminalStatusForTenant).toHaveBeenCalledWith('t1', 'rejected', undefined);
  });

  it('countByTerminalStatus forwards tenantId + status to repo.countByTerminalStatusForTenant', async () => {
    const repo = mockRepo();
    repo.countByTerminalStatusForTenant.mockResolvedValue(7);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any);

    const result = await svc.countByTerminalStatus('t1', 'approved');

    expect(repo.countByTerminalStatusForTenant).toHaveBeenCalledWith('t1', 'approved');
    expect(result).toBe(7);
  });
});
