/**
 * FlowExecutor — Unit Tests (PR 14 narrowed).
 *
 * Mocks OutboundGovernanceService, ApprovalQueueService, Logger, and a stub
 * IConnector instance (passed via FlowContext.connector per the Codex 5.5
 * connector-contract restructure — the executor no longer takes a
 * ConnectorManager dependency). The integration test exercises the same
 * surface against the real DI container with a stubbed connector.
 *
 * Families:
 *   - transform / validate failure modes
 *   - governance decisions: approve / queue / block / scan-throw
 *   - dispatch: create / update / delete + id resolution (incl. readId trim)
 *   - connector contract: systemType match assertion
 *   - delete pre-resolve: resolver-throw fail-fast + empty-string rejection
 *   - enqueue fail-closed (UnredactedPayloadError surfacing)
 *   - governance context plumbing
 *   - redactedPayload precedence over raw record
 */

// Inversify's @injectable() runs at class-definition time and reads
// Reflect.defineMetadata. Some Jest setup paths (e.g. the fast config that
// doesn't pull in reflect-metadata transitively) would crash on the
// FlowExecutor import below without this explicit shim. Copilot R2 on PR
// #825 flagged the missing import as a brittleness vector even though the
// current test suite happens to import reflect-metadata transitively.
import 'reflect-metadata';
import { FlowExecutor } from '../../../../src/flows/templates/FlowExecutor';
import type { FlowContext, FlowTemplate } from '../../../../src/flows/templates/FlowTemplate';
import type { OutboundDecision } from '../../../../src/services/governance/OutboundGovernanceService';
import type { OutboundGovernanceService } from '../../../../src/services/governance/OutboundGovernanceService';
import type { ApprovalQueueService } from '../../../../src/services/governance/ApprovalQueueService';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import { UnredactedPayloadError } from '../../../../src/services/governance/ApprovalQueueErrors';

// ── Fixtures ───────────────────────────────────────────────────────────

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function mockConnector(overrides: Partial<IConnector> & { systemType?: string } = {}): jest.Mocked<IConnector> {
  const conn = {
    systemType: overrides.systemType ?? 'tgt-sys',
    initialize: jest.fn(),
    authenticate: jest.fn(),
    testConnection: jest.fn(),
    getSystemInfo: jest.fn(),
    create: jest.fn(),
    read: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    list: jest.fn(),
    search: jest.fn(),
    syncRecord: jest.fn(),
    syncBatch: jest.fn(),
    ...overrides,
  };
  return conn as unknown as jest.Mocked<IConnector>;
}

function mockGovernance(decision: OutboundDecision<unknown>) {
  return {
    validateConnectorWrite: jest.fn().mockResolvedValue(decision),
    validateAIProviderRequest: jest.fn(),
    validateAuditLogPayload: jest.fn(),
  } as unknown as jest.Mocked<OutboundGovernanceService>;
}

function mockApprovalQueue() {
  return {
    enqueue: jest.fn().mockResolvedValue('approval-id-123'),
    approve: jest.fn(),
    reject: jest.fn(),
  } as unknown as jest.Mocked<ApprovalQueueService>;
}

function makeDecision(overrides: Partial<OutboundDecision> = {}): OutboundDecision {
  return {
    approved: true,
    approvalRequired: false,
    redactedPayload: { id: 'rec-1', name: 'Alice' },
    findings: [],
    riskLevel: 'low',
    auditMetadata: { scanDurationMs: 1, findingsCount: 0, redacted: false, blocked: false },
    ...overrides,
  };
}

interface SampleEvent {
  id: string;
  name: string;
}

interface SampleRecord extends Record<string, unknown> {
  id: string;
  name: string;
}

function makeTemplate(
  overrides: Partial<FlowTemplate<SampleEvent, SampleRecord>> = {},
): FlowTemplate<SampleEvent, SampleRecord> {
  return {
    id: 'unit-test-template-v1',
    category: 'master_data_sync',
    version: '1.0.0',
    source: { system: 'src-sys', eventType: 'created' },
    target: { system: 'tgt-sys', recordType: 'Widget', operation: 'create' },
    description: 'unit test template',
    governanceCallouts: [],
    transform: async (e) => ({ id: e.id, name: e.name }),
    riskClassification: () => 'low',
    retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotencyKey: (e) => (e as SampleEvent).id },
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<FlowContext> = {},
  connector?: IConnector,
): FlowContext {
  return {
    tenantId: 't1',
    userId: 'u1',
    correlationId: 'corr-1',
    connector: connector ?? mockConnector(),
    ...overrides,
  };
}

// ── transform / validate failure modes ─────────────────────────────────

describe('FlowExecutor — transform / validate', () => {
  it('returns failed when transform throws', async () => {
    const conn = mockConnector();
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({ transform: async () => { throw new Error('boom'); } });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toBe('boom');
    expect(conn.create).not.toHaveBeenCalled();
  });

  it('returns blocked with reason=validation when validate returns ok:false', async () => {
    const conn = mockConnector();
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({
      validate: async () => ({ ok: false, errors: ['missing email'] }),
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('validation');
      expect(result.findings).toEqual(['missing email']);
    }
    expect(conn.create).not.toHaveBeenCalled();
  });

  it('returns failed when validate throws', async () => {
    const conn = mockConnector();
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({
      validate: async () => { throw new Error('validate-crash'); },
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toBe('validate-crash');
  });

  it('proceeds when validate returns ok:true', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'created-1', name: 'x' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({ validate: async () => ({ ok: true, errors: [] }) });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
  });
});

// ── governance decisions ───────────────────────────────────────────────

describe('FlowExecutor — governance decisions', () => {
  it('returns failed when governance scan throws', async () => {
    const conn = mockConnector();
    const gov = mockGovernance(makeDecision());
    gov.validateConnectorWrite = jest.fn().mockRejectedValue(new Error('scan-down')) as any;
    const exec = new FlowExecutor(
      mockLogger() as any,
      gov,
      mockApprovalQueue(),
    );
    const result = await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toBe('scan-down');
    expect(conn.create).not.toHaveBeenCalled();
  });

  it('enqueue resourceId reflects target.operation: update → decision.redactedPayload.id (Copilot R8 on PR #825 — PII leak guard)', async () => {
    // The redacted payload's id is preferred over the raw record's id so a
    // PII-bearing id field is masked before it reaches
    // governance_approvals.resource_id. Raw record has a real SSN-shaped
    // value; redacted form is '[REDACTED-ID]' — only the redacted form
    // must reach enqueue.
    const conn = mockConnector();
    const queue = mockApprovalQueue();
    const decision = makeDecision({
      approved: false,
      approvalRequired: true,
      redactedPayload: { id: '[REDACTED-ID]', name: 'updated' },
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      queue,
    );
    const tpl = makeTemplate({ target: { system: 'tgt-sys', recordType: 'Widget', operation: 'update' } });
    await exec.execute(tpl, { id: '123-45-6789', name: 'updated' }, makeCtx({}, conn));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      operationType: 'connector_write',
      resourceType: 'Widget',
      resourceId: '[REDACTED-ID]',
    }));
    // CRITICAL: the raw SSN-shaped id MUST NOT have reached the enqueue args.
    const enqueueArgs = (queue.enqueue as jest.Mock).mock.calls[0][0];
    expect(enqueueArgs.resourceId).not.toMatch(/\d{3}-\d{2}-\d{4}/);
  });

  it('enqueue resourceId still uses redactedPayload.id when no redaction needed (happy path)', async () => {
    // PII-free update — redactedPayload.id present (no redaction needed),
    // still preferred via the readId(redactedPayload) path.
    const conn = mockConnector();
    const queue = mockApprovalQueue();
    const decision = makeDecision({
      approved: false,
      approvalRequired: true,
      redactedPayload: { id: 'existing-99', name: 'updated' },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      queue,
    );
    const tpl = makeTemplate({ target: { system: 'tgt-sys', recordType: 'Widget', operation: 'update' } });
    await exec.execute(tpl, { id: 'existing-99', name: 'updated' }, makeCtx({}, conn));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'Widget',
      resourceId: 'existing-99',
    }));
  });

  it('enqueue resourceId reflects target.operation: delete → resolveTargetRecordId', async () => {
    const conn = mockConnector();
    const queue = mockApprovalQueue();
    const decision = makeDecision({ approved: false, approvalRequired: true });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      queue,
    );
    const tpl = makeTemplate({
      target: {
        system: 'tgt-sys',
        recordType: 'Widget',
        operation: 'delete',
        resolveTargetRecordId: async (e) => `del-${(e as SampleEvent).id}`,
      },
    });
    await exec.execute(tpl, { id: 'e42', name: 'doomed' }, makeCtx({}, conn));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'Widget',
      resourceId: 'del-e42',
    }));
  });

  it('enqueues and returns pending_approval when decision.approvalRequired', async () => {
    const conn = mockConnector();
    const queue = mockApprovalQueue();
    const decision = makeDecision({
      approved: false,
      approvalRequired: true,
      redactedPayload: { id: 'rec-1', name: '[REDACTED]' },
      findings: ['email'],
      riskLevel: 'high',
      auditMetadata: { scanDurationMs: 5, findingsCount: 1, redacted: true, blocked: false },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      queue,
    );
    const result = await exec.execute(makeTemplate(), { id: 'e1', name: 'Alice <alice@x.com>' }, makeCtx({}, conn));
    expect(result.status).toBe('pending_approval');
    if (result.status === 'pending_approval') {
      expect(result.approvalId).toBe('approval-id-123');
      expect(result.pollUrl).toBe('/api/governance/approvals/approval-id-123');
      expect(result.governance.approvalRequired).toBe(true);
    }
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1',
      requesterUserId: 'u1',
      operationType: 'connector_write',
      resourceType: 'Widget',
      resourceId: 'new',
      decision,
    }));
    expect(conn.create).not.toHaveBeenCalled();
  });

  it('returns failed (fail-closed) when enqueue throws UnredactedPayloadError', async () => {
    const conn = mockConnector();
    const queue = mockApprovalQueue();
    queue.enqueue = jest.fn().mockRejectedValue(
      new UnredactedPayloadError('refused: decision.auditMetadata.redacted !== true'),
    ) as any;
    const decision = makeDecision({ approved: false, approvalRequired: true });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      queue,
    );
    const result = await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    expect(conn.create).not.toHaveBeenCalled();
  });

  it('returns blocked with reason=governance when decision.approved is false and not approval-required', async () => {
    const conn = mockConnector();
    const decision = makeDecision({
      approved: false,
      approvalRequired: false,
      findings: ['ssn'],
      riskLevel: 'high',
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: false, blocked: true },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
    );
    const result = await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('governance');
      expect(result.findings).toEqual(['ssn']);
      expect(result.governance).toBe(decision);
    }
    expect(conn.create).not.toHaveBeenCalled();
  });

  it('dispatches redactedPayload (not raw record) when approved with redaction', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'created-1', name: '[REDACTED]' });
    const decision = makeDecision({
      approved: true,
      approvalRequired: false,
      redactedPayload: { id: 'rec-1', name: '[REDACTED]' },
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
    );
    await exec.execute(makeTemplate(), { id: 'e1', name: 'Alice' }, makeCtx({}, conn));
    expect(conn.create).toHaveBeenCalledWith('Widget', { id: 'rec-1', name: '[REDACTED]' });
  });

  it('falls back to raw record when approved decision has no redactedPayload', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'created-1', name: 'Alice' });
    const decision = makeDecision({
      approved: true,
      approvalRequired: false,
      redactedPayload: undefined,
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
    );
    await exec.execute(makeTemplate(), { id: 'e1', name: 'Alice' }, makeCtx({}, conn));
    expect(conn.create).toHaveBeenCalledWith('Widget', { id: 'e1', name: 'Alice' });
  });
});

// ── dispatch + id resolution ───────────────────────────────────────────

describe('FlowExecutor — dispatch', () => {
  it('create returns the connector-assigned id', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'new-id-42', name: 'x' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const result = await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.targetRecordId).toBe('new-id-42');
  });

  it('update uses payload.id and returns it when connector returns no id', async () => {
    const conn = mockConnector();
    conn.update.mockResolvedValue({ name: 'updated' }); // no id in response
    const decision = makeDecision({
      redactedPayload: { id: 'existing-id-99', name: 'updated' },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({ target: { system: 'tgt-sys', recordType: 'Widget', operation: 'update' } });
    const result = await exec.execute(tpl, { id: 'existing-id-99', name: 'updated' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.targetRecordId).toBe('existing-id-99');
    expect(conn.update).toHaveBeenCalledWith('Widget', 'existing-id-99', { id: 'existing-id-99', name: 'updated' });
  });

  it('update fails fast when transformed record has whitespace-only id (Copilot R5 on PR #825)', async () => {
    // readId now trims string ids; whitespace-only collapses to null and
    // triggers the same pre-governance fail-fast as missing-id.
    const conn = mockConnector();
    const gov = mockGovernance(makeDecision());
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(mockLogger() as any, gov, queue);
    const tpl = makeTemplate({
      target: { system: 'tgt-sys', recordType: 'Widget', operation: 'update' },
      transform: async () => ({ id: '   ', name: 'x' }),
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    expect(gov.validateConnectorWrite).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('readId trims string ids when they are valid (Copilot R5 on PR #825)', async () => {
    // Whitespace AROUND a real id should be trimmed, not rejected.
    const conn = mockConnector();
    conn.update.mockResolvedValue({ name: 'updated' });
    const decision = makeDecision({
      redactedPayload: { id: '  existing-99  ', name: 'updated' },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({ target: { system: 'tgt-sys', recordType: 'Widget', operation: 'update' } });
    const result = await exec.execute(tpl, { id: 'existing-99', name: 'updated' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.targetRecordId).toBe('existing-99');
    // dispatch should have used the TRIMMED id, not the padded form.
    expect(conn.update).toHaveBeenCalledWith('Widget', 'existing-99', expect.any(Object));
  });

  it('update returns failed when redacted payload has no id (dispatch-time guard)', async () => {
    const conn = mockConnector();
    const decision = makeDecision({ redactedPayload: { name: 'no-id' } });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({ target: { system: 'tgt-sys', recordType: 'Widget', operation: 'update' } });
    // Record HAS an id (so the fail-fast pre-governance guard doesn't fire),
    // but the redactedPayload strips it before dispatch — covers the dispatch
    // path's own id requirement.
    const result = await exec.execute(tpl, { id: 'e1', name: 'no-id' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    expect(conn.update).not.toHaveBeenCalled();
  });

  it('update fails fast BEFORE governance scan when transformed record has no id', async () => {
    // Copilot R2: transform produces an update record without an id ⇒
    // executor must reject up-front rather than running the DLP scan +
    // enqueueing an unactionable row. This test exercises the
    // pre-governance fail-fast path that protects against that.
    const conn = mockConnector();
    const gov = mockGovernance(makeDecision());
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(
      mockLogger() as any,
      gov,
      queue,
    );
    const tpl = makeTemplate({
      target: { system: 'tgt-sys', recordType: 'Widget', operation: 'update' },
      transform: async () => ({ id: '', name: 'no-id' }), // empty id → readId returns null
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'no-id' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toMatch(/update.*payload\.id/i);
    // Critical assertions: neither governance scan nor enqueue should have run.
    expect(gov.validateConnectorWrite).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(conn.update).not.toHaveBeenCalled();
  });

  it('delete resolves target id via resolveTargetRecordId and returns it', async () => {
    const conn = mockConnector();
    conn.delete.mockResolvedValue(true);
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({
      target: {
        system: 'tgt-sys',
        recordType: 'Widget',
        operation: 'delete',
        resolveTargetRecordId: async (e) => `resolved-${(e as SampleEvent).id}`,
      },
    });
    const result = await exec.execute(tpl, { id: 'e9', name: 'doomed' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.targetRecordId).toBe('resolved-e9');
    expect(conn.delete).toHaveBeenCalledWith('Widget', 'resolved-e9');
  });

  it('returns failed when connector.create returns no id', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ name: 'no-id-back' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const result = await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
  });

  it('returns failed when connector dispatch throws', async () => {
    const conn = mockConnector();
    conn.create.mockRejectedValue(new Error('network-down'));
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const result = await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toBe('network-down');
  });
});

// ── connector contract + delete pre-resolve (Codex 5.5) ───────────────

describe('FlowExecutor — connector contract', () => {
  it('accepts display-case connector.systemType against lowercase template.target.system (Codex 5.5 HIGH on PR #825)', async () => {
    // Real connectors expose display-case systemType (`NetSuite`, `HubSpot`)
    // while the canonical registry keys (and the template authoring
    // convention) are lowercase. The case-insensitive comparison must
    // accept the production case so caller-resolved connectors aren't
    // rejected before governance + dispatch.
    const realLooking = mockConnector({ systemType: 'NetSuite' });
    realLooking.create.mockResolvedValue({ id: 'real-001' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', operation: 'create' } });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, realLooking));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.targetRecordId).toBe('real-001');
  });

  it('returns failed when ctx.connector.systemType does not match template.target.system', async () => {
    // Caller passed a HubSpot connector for a NetSuite-targeted template.
    // The pre-governance contract check catches this before any DLP scan.
    const wrongConnector = mockConnector({ systemType: 'wrong-system' });
    const gov = mockGovernance(makeDecision());
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(mockLogger() as any, gov, queue);
    const result = await exec.execute(
      makeTemplate(), // target.system === 'tgt-sys'
      { id: 'e1', name: 'x' },
      makeCtx({}, wrongConnector),
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/wrong-system.*tgt-sys/);
    }
    // Neither governance scan nor enqueue should run.
    expect(gov.validateConnectorWrite).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(wrongConnector.create).not.toHaveBeenCalled();
  });
});

describe('FlowExecutor — delete pre-resolve (Codex 5.5 MEDIUM)', () => {
  it('fails fast BEFORE governance scan when resolveTargetRecordId throws', async () => {
    const conn = mockConnector();
    const gov = mockGovernance(makeDecision());
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(mockLogger() as any, gov, queue);
    const tpl = makeTemplate({
      target: {
        system: 'tgt-sys',
        recordType: 'Widget',
        operation: 'delete',
        resolveTargetRecordId: async () => { throw new Error('lookup-failed'); },
      },
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toMatch(/lookup-failed/);
    // Critical: no DLP scan, no enqueue, no dispatch.
    expect(gov.validateConnectorWrite).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(conn.delete).not.toHaveBeenCalled();
  });

  it('fails fast when resolveTargetRecordId returns empty/whitespace string', async () => {
    const conn = mockConnector();
    const gov = mockGovernance(makeDecision());
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(mockLogger() as any, gov, queue);
    const tpl = makeTemplate({
      target: {
        system: 'tgt-sys',
        recordType: 'Widget',
        operation: 'delete',
        resolveTargetRecordId: async () => '   ',
      },
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toMatch(/empty\/whitespace-only string/);
    expect(gov.validateConnectorWrite).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('enqueue resourceId for delete uses pre-resolved id (Codex 5.5 MEDIUM)', async () => {
    const conn = mockConnector();
    const queue = mockApprovalQueue();
    const decision = makeDecision({ approved: false, approvalRequired: true });
    const exec = new FlowExecutor(mockLogger() as any, mockGovernance(decision), queue);
    const tpl = makeTemplate({
      target: {
        system: 'tgt-sys',
        recordType: 'Widget',
        operation: 'delete',
        resolveTargetRecordId: async (e) => `resolved-${(e as SampleEvent).id}`,
      },
    });
    await exec.execute(tpl, { id: 'e42', name: 'doomed' }, makeCtx({}, conn));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'Widget',
      resourceId: 'resolved-e42',
    }));
  });
});

// ── governance context plumbing ────────────────────────────────────────

describe('FlowExecutor — governance context plumbing', () => {
  it('passes templated riskClassification + destination + resourceType to OutboundGovernanceService', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'x' });
    const gov = mockGovernance(makeDecision());
    const exec = new FlowExecutor(
      mockLogger() as any,
      gov,
      mockApprovalQueue(),
    );
    const tpl = makeTemplate({ riskClassification: () => 'high' });
    await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({ tenantId: 'tenant-7', userId: 'user-7' }, conn));
    expect(gov.validateConnectorWrite).toHaveBeenCalledWith(
      { id: 'e1', name: 'x' },
      expect.objectContaining({
        tenantId: 'tenant-7',
        userId: 'user-7',
        destination: 'connector_write',
        destinationDetail: 'tgt-sys.create',
        operationType: 'write',
        resourceType: 'Widget',
        riskLevel: 'high',
      }),
    );
  });

  it('falls back to SYSTEM_IDENTITY userId when ctx.userId is undefined', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'x' });
    const gov = mockGovernance(makeDecision());
    const exec = new FlowExecutor(
      mockLogger() as any,
      gov,
      mockApprovalQueue(),
    );
    await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({ userId: undefined }, conn));
    const ctxArg = (gov.validateConnectorWrite as jest.Mock).mock.calls[0][1];
    expect(typeof ctxArg.userId).toBe('string');
    expect(ctxArg.userId.length).toBeGreaterThan(0);
  });
});
