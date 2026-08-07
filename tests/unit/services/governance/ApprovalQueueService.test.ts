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
import { EncryptionService } from '../../../../src/services/security/EncryptionService';

const TEST_ENCRYPTION_KEY = '0'.repeat(64);
let testEncryption: EncryptionService;
let prevEncryptionKey: string | undefined;
beforeAll(() => {
  // Save/restore the env var so this suite doesn't leak global state to
  // other tests in the same Jest worker. Copilot R0 #3 on PR #853.
  prevEncryptionKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
  process.env.AI_CONFIG_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  testEncryption = new EncryptionService();
});
afterAll(() => {
  if (prevEncryptionKey === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
  else process.env.AI_CONFIG_ENCRYPTION_KEY = prevEncryptionKey;
});

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
    resetFailedApplyClaim: jest.fn(),
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
    reason: { kind: 'governance', decision: makeDecision() },
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
    applyStatus: 'not_started',
    appliedAt: null,
    applyFailedAt: null,
    applyError: null,
    writeDescriptor: null,
    ...overrides,
  };
}

// ── enqueue ────────────────────────────────────────────────────────

describe('ApprovalQueueService.enqueue', () => {
  it('throws InvalidDecisionError when decision.approvalRequired is false', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);
    const args = makeEnqueueArgs({ reason: { kind: 'governance', decision: makeDecision({ approvalRequired: false }) } });
    await expect(svc.enqueue(args)).rejects.toBeInstanceOf(InvalidDecisionError);
    expect(repo.insertPending).not.toHaveBeenCalled();
  });

  it('throws InvalidDecisionError when decision.redactedPayload is undefined', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);
    const args = makeEnqueueArgs({ reason: { kind: 'governance', decision: makeDecision({ redactedPayload: undefined }) } });
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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);
    const decision = makeDecision({
      // Simulates OutboundGovernanceService's fallback path: scan detected PII
      // (findings populated), classified high-risk → approvalRequired=true, but
      // scanResult.redactedData was missing so redactedPayload === original payload
      // and auditMetadata.redacted === false.
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: false, blocked: false },
    });
    const args = makeEnqueueArgs({ reason: { kind: 'governance', decision } });
    await expect(svc.enqueue(args)).rejects.toBeInstanceOf(UnredactedPayloadError);
    expect(repo.insertPending).not.toHaveBeenCalled();
  });

  it('does not throw UnredactedPayloadError when auditMetadata.redacted=true (the happy path)', async () => {
    const repo = mockRepo();
    repo.insertPending.mockResolvedValue(makePersistedApproval());
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);
    // The default fixture sets auditMetadata.redacted === true.
    await expect(svc.enqueue(makeEnqueueArgs())).resolves.toBeDefined();
    expect(repo.insertPending).toHaveBeenCalledTimes(1);
  });

  it('calls repo.insertPending with UUID, stringified payload + findings, and expiresAt = createdAt + 24h (default TTL)', async () => {
    const repo = mockRepo();
    repo.insertPending.mockResolvedValue(makePersistedApproval());
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, logger as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    await expect(
      svc.approve({ tenantId: 't1', id: 'missing-id', approverUserId: 'op-1' }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });

  it('throws AlreadyDecidedError on repo outcome="already_decided" carrying the persisted row status', async () => {
    const repo = mockRepo();
    const row = makePersistedApproval({ status: 'rejected' });
    repo.decide.mockResolvedValue({ outcome: 'already_decided', row });
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    await expect(
      svc.approve({ tenantId: 't1', id: 'approval-1', approverUserId: 'op-1' }),
    ).rejects.toBeInstanceOf(ApprovalExpiredError);
  });
});

describe('ApprovalQueueService.resetFailedApplyClaim', () => {
  it('passes through to the repository', async () => {
    const repo = mockRepo();
    const outcome = { outcome: 'reset', row: makePersistedApproval({ applyStatus: 'not_started' }) } as const;
    repo.resetFailedApplyClaim.mockResolvedValue(outcome);
    const logger = mockLogger();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, logger as any, testEncryption);

    await expect(svc.resetFailedApplyClaim({
      tenantId: 't1',
      id: 'approval-1',
      adminUserId: 'admin-1',
      reason: 'retry after connector config repair',
    })).resolves.toBe(outcome);
    expect(repo.resetFailedApplyClaim).toHaveBeenCalledWith({ tenantId: 't1', id: 'approval-1' });
    expect(logger.info).toHaveBeenCalledWith('Approval apply claim reset requested', expect.objectContaining({
      tenantId: 't1',
      approvalId: 'approval-1',
      adminUserId: 'admin-1',
      reason: 'retry after connector config repair',
      outcome: 'reset',
    }));
  });

  it('throws InvalidDecisionError when reason is empty or whitespace-only (mirrors reject())', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    await expect(
      svc.resetFailedApplyClaim({ tenantId: 't1', id: 'approval-1', adminUserId: 'admin-1', reason: '' }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);
    await expect(
      svc.resetFailedApplyClaim({ tenantId: 't1', id: 'approval-1', adminUserId: 'admin-1', reason: '   ' }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);
    expect(repo.resetFailedApplyClaim).not.toHaveBeenCalled();
  });

  it('fires resumeWorker.resume(row) async after a successful reset (does NOT block the response)', async () => {
    const repo = mockRepo();
    const resetRow = makePersistedApproval({ applyStatus: 'not_started' });
    repo.resetFailedApplyClaim.mockResolvedValue({ outcome: 'reset', row: resetRow });
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);
    // Resolve resume slowly to prove the call returns BEFORE resume completes
    // — same fire-and-forget semantics as approve() (Copilot R13).
    let resumeResolve!: () => void;
    const resumePromise = new Promise<void>((resolve) => { resumeResolve = resolve; });
    const resumeWorker = { resume: jest.fn().mockReturnValue(resumePromise.then(() => ({ applied: true }))) };
    svc.setResumeWorker(resumeWorker as any);

    const resetCallPromise = svc.resetFailedApplyClaim({ tenantId: 't1', id: 'approval-1', adminUserId: 'admin-1', reason: 'retry' });
    await expect(resetCallPromise).resolves.toMatchObject({ outcome: 'reset' });
    expect(resumeWorker.resume).toHaveBeenCalledTimes(1);
    expect(resumeWorker.resume).toHaveBeenCalledWith(resetRow);
    // Cleanup the dangling promise.
    resumeResolve();
  });

  it('does NOT invoke resumeWorker.resume on non-reset outcomes (not_found, not_failed)', async () => {
    const repo = mockRepo();
    repo.resetFailedApplyClaim.mockResolvedValue({ outcome: 'not_found' });
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);
    const resumeWorker = { resume: jest.fn() };
    svc.setResumeWorker(resumeWorker as any);

    await svc.resetFailedApplyClaim({ tenantId: 't1', id: 'approval-1', adminUserId: 'admin-1', reason: 'retry' });

    expect(resumeWorker.resume).not.toHaveBeenCalled();
  });

  it('reset response is unaffected by resumeWorker.resume rejection (fired async; logged)', async () => {
    const repo = mockRepo();
    const resetRow = makePersistedApproval({ applyStatus: 'not_started' });
    repo.resetFailedApplyClaim.mockResolvedValue({ outcome: 'reset', row: resetRow });
    const logger = mockLogger();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, logger as any, testEncryption);
    const resumeWorker = { resume: jest.fn().mockRejectedValue(new Error('downstream connector down')) };
    svc.setResumeWorker(resumeWorker as any);

    await expect(
      svc.resetFailedApplyClaim({ tenantId: 't1', id: 'approval-1', adminUserId: 'admin-1', reason: 'retry' }),
    ).resolves.toMatchObject({ outcome: 'reset' });
    // Drain pending microtasks so the fire-and-forget rejection surfaces in the logger.
    await new Promise((r) => setImmediate(r));
    expect(logger.error).toHaveBeenCalledWith(
      'ApprovalQueueService → worker.resume threw (contract violation)',
      expect.any(Error),
      expect.objectContaining({ approvalId: 'approval-1' }),
    );
  });
});

// ── reject ─────────────────────────────────────────────────────────

describe('ApprovalQueueService.reject', () => {
  it('throws InvalidDecisionError when reason is undefined, empty, or whitespace-only', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    const opts = { limit: 5, offset: 10 };
    const result = await svc.listPending('t1', opts);

    expect(repo.listPendingForTenant).toHaveBeenCalledWith('t1', opts);
    expect(result).toBe(rows);
  });

  it('countPending forwards tenantId to repo.countPendingForTenant', async () => {
    const repo = mockRepo();
    repo.countPendingForTenant.mockResolvedValue(42);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    const result = await svc.countPending('t1');

    // Copilot R3 on PR #851: countPending now takes optional opts for SQL-side
    // operationType filtering. With no opts passed, the repo receives `{}`.
    expect(repo.countPendingForTenant).toHaveBeenCalledWith('t1', {});
    expect(result).toBe(42);
  });

  it('countPending forwards operationType filter to repo when supplied', async () => {
    const repo = mockRepo();
    repo.countPendingForTenant.mockResolvedValue(3);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    const result = await svc.countPending('t1', { operationType: 'ownership_write' });

    expect(repo.countPendingForTenant).toHaveBeenCalledWith('t1', { operationType: 'ownership_write' });
    expect(result).toBe(3);
  });

  it('claimForApply forwards args to repo.claimForApply and returns the result', async () => {
    const repo = mockRepo();
    const claimed = makePersistedApproval({ applyIdempotencyKey: 'key-1' });
    repo.claimForApply.mockResolvedValue(claimed);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

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
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    const result = await svc.listByTerminalStatus('t1', 'approved', { limit: 5 });

    expect(repo.listByTerminalStatusForTenant).toHaveBeenCalledWith('t1', 'approved', { limit: 5 });
    expect(result).toBe(rows);
  });

  it('listByTerminalStatus forwards rejected status separately', async () => {
    const repo = mockRepo();
    const rows = [makePersistedApproval({ id: 'h-r', status: 'rejected' })];
    repo.listByTerminalStatusForTenant.mockResolvedValue(rows);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    await svc.listByTerminalStatus('t1', 'rejected');

    expect(repo.listByTerminalStatusForTenant).toHaveBeenCalledWith('t1', 'rejected', undefined);
  });

  it('countByTerminalStatus forwards tenantId + status to repo.countByTerminalStatusForTenant', async () => {
    const repo = mockRepo();
    repo.countByTerminalStatusForTenant.mockResolvedValue(7);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    const result = await svc.countByTerminalStatus('t1', 'approved');

    // Copilot R3 on PR #851: countByTerminalStatus now takes optional opts for
    // SQL-side operationType filtering. With no opts passed, the repo
    // receives `{}`.
    expect(repo.countByTerminalStatusForTenant).toHaveBeenCalledWith('t1', 'approved', {});
    expect(result).toBe(7);
  });

  it('countByTerminalStatus forwards operationType filter to repo when supplied', async () => {
    const repo = mockRepo();
    repo.countByTerminalStatusForTenant.mockResolvedValue(2);
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    const result = await svc.countByTerminalStatus('t1', 'approved', { operationType: 'ownership_write' });

    expect(repo.countByTerminalStatusForTenant).toHaveBeenCalledWith('t1', 'approved', { operationType: 'ownership_write' });
    expect(result).toBe(2);
  });
});

// ── ownership arm (PR 13b Stage B → PR 13c-2 Task 3) ──────────────

import type { WriteDescriptor } from '../../../../src/governance/sourceOfTruth/guardedWrite';
import { decryptDescriptor } from '../../../../src/services/governance/writeDescriptorEncryption';

function makeWriteDescriptor(): WriteDescriptor {
  return {
    targetSystemId: 'hubspot',
    operation: 'create',
    entityType: 'Contact',
    args: { firstName: 'Ada' },
    ownership: {
      entity: 'customer',
      declaredOwner: 'hubspot',
      callerSystem: 'netsuite',
      targetSystem: 'hubspot',
    },
  };
}

describe('ApprovalQueueService.enqueue — ownership arm (PR 13c-2)', () => {
  it('governance arm persists writeDescriptor=null (backward compat)', async () => {
    const repo = mockRepo();
    repo.insertPending.mockResolvedValue(makePersistedApproval());
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    await svc.enqueue(makeEnqueueArgs());

    expect(repo.insertPending).toHaveBeenCalledWith(
      expect.objectContaining({ writeDescriptor: null }),
    );
  });

  it('ownership arm encrypts args before persisting and the persisted JSON contains no plaintext PII', async () => {
    const repo = mockRepo();
    repo.insertPending.mockResolvedValue(makePersistedApproval());
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);
    const descriptor: WriteDescriptor = {
      ...makeWriteDescriptor(),
      args: { firstName: 'Ada', email: 'ada@example.com', lastName: 'Lovelace' },
    };

    const id = await svc.enqueue({
      tenantId: 't1',
      requesterUserId: 'u1',
      operationType: 'ownership_write',
      resourceType: 'customer',
      resourceId: 'rec_1',
      reason: {
        kind: 'ownership',
        entity: 'customer',
        declaredOwner: 'hubspot',
        callerSystem: 'netsuite',
        conflictPolicy: 'queue_for_human',
        writeDescriptor: descriptor,
      },
    });
    expect(typeof id).toBe('string');
    expect(repo.insertPending).toHaveBeenCalledTimes(1);

    const row = repo.insertPending.mock.calls[0][0];
    expect(row.operationType).toBe('ownership_write');
    expect(row.resourceType).toBe('customer');
    expect(row.resourceId).toBe('rec_1');
    expect(row.riskLevel).toBe('medium');

    // The persisted writeDescriptor JSON must NOT contain plaintext PII.
    expect(typeof row.writeDescriptor).toBe('string');
    const serialized: string = row.writeDescriptor!;
    expect(serialized).not.toContain('ada@example.com');
    expect(serialized).not.toContain('Ada');
    expect(serialized).not.toContain('Lovelace');
    // Manifest vocabulary stays plaintext for queryability.
    expect(serialized).toContain('hubspot');

    // Round-trip decrypts back to the original descriptor.
    const parsed = JSON.parse(serialized);
    const decrypted = await decryptDescriptor(parsed, testEncryption);
    expect(decrypted.args).toEqual({
      firstName: 'Ada',
      email: 'ada@example.com',
      lastName: 'Lovelace',
    });
  });

  it('ownership arm with mismatched operationType throws InvalidDecisionError', async () => {
    // Copilot R1 on PR #853: enqueue() is independently callable; reason.kind
    // ownership must coincide with operationType='ownership_write'. A mis-call
    // would otherwise persist an encrypted descriptor under a non-ownership
    // operation type, breaking the operations-router ?reason=ownership filter
    // and the resume-registry's operationType-keyed dispatch.
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);
    const descriptor = makeWriteDescriptor();
    await expect(svc.enqueue({
      tenantId: 't1',
      requesterUserId: 'u1',
      operationType: 'ai_call', // wrong — must be 'ownership_write'
      resourceType: 'customer',
      resourceId: 'rec_1',
      reason: {
        kind: 'ownership',
        entity: 'customer',
        declaredOwner: 'hubspot',
        callerSystem: 'netsuite',
        conflictPolicy: 'queue_for_human',
        writeDescriptor: descriptor,
      },
    })).rejects.toBeInstanceOf(InvalidDecisionError);
    expect(repo.insertPending).not.toHaveBeenCalled();
  });

  it('ownership arm with null writeDescriptor throws InvalidDecisionError', async () => {
    const repo = mockRepo();
    const svc = new ApprovalQueueService(repo as unknown as ApprovalQueueRepository, mockLogger() as any, testEncryption);

    // TypeScript enforces non-null at compile time, but we test runtime guard
    // by casting through unknown.
    await expect(svc.enqueue({
      tenantId: 't1',
      requesterUserId: 'u1',
      operationType: 'ownership_write',
      resourceType: 'customer',
      resourceId: '',
      reason: {
        kind: 'ownership',
        entity: 'customer',
        declaredOwner: 'hubspot',
        callerSystem: 'netsuite',
        conflictPolicy: 'queue_for_human',
        writeDescriptor: null as unknown as WriteDescriptor,
      },
    })).rejects.toBeInstanceOf(InvalidDecisionError);
    expect(repo.insertPending).not.toHaveBeenCalled();
  });
});
