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
import type { AuditService } from '../../../../src/services/ai/orchestrator/AuditService';
import type { OwnershipResolver } from '../../../../src/governance/sourceOfTruth/OwnershipResolver';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import { UnredactedPayloadError } from '../../../../src/services/governance/ApprovalQueueErrors';

// ── Fixtures ───────────────────────────────────────────────────────────

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function mockConnector(overrides: Partial<IConnector> & { systemType?: string } = {}): jest.Mocked<IConnector> {
  const conn = {
    systemType: overrides.systemType ?? 'NetSuite',
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

function mockOwnershipResolver(): jest.Mocked<Pick<OwnershipResolver, 'validateWrite' | 'ownerFor' | 'detectLoop'>> {
  return {
    validateWrite: jest.fn().mockResolvedValue({ allowed: true, owner: 'netsuite' }),
    ownerFor: jest.fn().mockReturnValue('netsuite'),
    detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
  };
}

function mockAuditService(): jest.Mocked<Pick<AuditService, 'logGovernanceCheck'>> {
  return {
    logGovernanceCheck: jest.fn().mockResolvedValue(undefined),
  };
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
    source: { system: 'hubspot', eventType: 'created' },
    target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'create' },
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    await exec.execute(tpl, { id: 'existing-99', name: 'updated' }, makeCtx({}, conn));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'Widget',
      resourceId: 'existing-99',
    }));
  });

  it('enqueue resourceId falls back to the raw record id when approvalRequired decision omits redactedPayload', async () => {
    const conn = mockConnector();
    const queue = mockApprovalQueue();
    const decision = makeDecision({
      approved: false,
      approvalRequired: true,
      redactedPayload: undefined,
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      queue,
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    await exec.execute(tpl, { id: 'existing-raw-42', name: 'updated' }, makeCtx({}, conn));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'Widget',
      resourceId: 'existing-raw-42',
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({
      target: {
        system: 'netsuite',
        recordType: 'Widget',
        canonicalEntity: 'customer',
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      reason: { kind: 'governance', decision },
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const result = await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({}, conn));
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked' && result.reason === 'governance') {
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    const result = await exec.execute(tpl, { id: 'existing-id-99', name: 'updated' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.targetRecordId).toBe('existing-id-99');
    expect(conn.update).toHaveBeenCalledWith('Widget', 'existing-id-99', { id: 'existing-id-99', name: 'updated' });
  });

  it('update returns originalUpdateId even when connector ECHOES the redacted body id (Copilot R10 on PR #827 — connector-echo guard)', async () => {
    // A connector that echoes the request body's `id` field in its update
    // response (a common REST shape) would hand back the MASKED id from
    // the redacted payload. Pre-R10 the dispatch returned
    // `readId(result) ?? originalUpdateId`, which would have propagated
    // that masked echo as FlowResult.targetRecordId — breaking downstream
    // chaining on the canonical target id AND surfacing the redaction
    // placeholder. The fix: ALWAYS return originalUpdateId for update;
    // the connector's response shape is dropped on this code path.
    const rawId = 'real-customer-id-42';
    const conn = mockConnector();
    // Connector echoes the body's redacted id (worst case for the
    // pre-R10 contract). Some REST APIs do exactly this.
    conn.update.mockResolvedValue({ id: '[REDACTED-EMAIL]', name: 'updated' });
    const decision = makeDecision({
      approved: true,
      approvalRequired: false,
      redactedPayload: { id: '[REDACTED-EMAIL]', name: 'updated' },
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    const result = await exec.execute(tpl, { id: rawId, name: 'updated' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    // CRITICAL: the result's targetRecordId is the ORIGINAL raw id, not
    // the redacted echo from the connector response.
    if (result.status === 'succeeded') {
      expect(result.targetRecordId).toBe(rawId);
      expect(result.targetRecordId).not.toContain('[REDACTED');
    }
  });

  it('update fails fast when transformed record has whitespace-only id (Copilot R5 on PR #825)', async () => {
    // readId now trims string ids; whitespace-only collapses to null and
    // triggers the same pre-governance fail-fast as missing-id.
    const conn = mockConnector();
    const gov = mockGovernance(makeDecision());
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(mockLogger() as any, gov, queue,
      mockOwnershipResolver() as unknown as OwnershipResolver, mockAuditService() as unknown as AuditService);
    const tpl = makeTemplate({
      target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' },
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    const result = await exec.execute(tpl, { id: 'existing-99', name: 'updated' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.targetRecordId).toBe('existing-99');
    // dispatch should have used the TRIMMED id, not the padded form.
    expect(conn.update).toHaveBeenCalledWith('Widget', 'existing-99', expect.any(Object));
  });

  it('update dispatch uses ORIGINAL record id, not the redacted-payload id (Codex 5.5 HIGH on PR #825 — update-id leak guard)', async () => {
    // The headline regression: a low/medium PII record where the `id`
    // field itself is PII-shaped (email, phone, name-like external id)
    // gets APPROVED with a redacted form (here `[REDACTED-EMAIL]`).
    // The dispatch path used to read the lookup id from
    // `decision.redactedPayload ?? record`, which would have sent the
    // MASKED id to `connector.update(...)` — either missing the target
    // record or, worse, updating a different record that happens to
    // share the redaction placeholder. The fix: capture the ORIGINAL
    // id BEFORE governance, use it as the LOOKUP arg even when the
    // body carries the redacted form.
    const conn = mockConnector();
    conn.update.mockResolvedValue({ name: 'updated' });
    const decision = makeDecision({
      approved: true,
      approvalRequired: false,
      // The redacted form has a masked id field — what would have been
      // sent to connector.update under the buggy contract.
      redactedPayload: { id: '[REDACTED-EMAIL]', name: 'updated' },
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    // Raw record carries a real-shaped target id; redaction would have
    // turned it into the placeholder above. Dispatch MUST use the raw
    // id as the lookup arg.
    const result = await exec.execute(tpl, { id: 'real-customer-id-42', name: 'updated' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    // CRITICAL: the lookup id passed to connector.update is the REAL
    // record.id, not the redacted form. Body still carries the redacted
    // payload (id field included, masked) — connectors decide whether
    // to accept body.id ≠ url.id; we don't second-guess that here.
    expect(conn.update).toHaveBeenCalledWith(
      'Widget',
      'real-customer-id-42',
      { id: '[REDACTED-EMAIL]', name: 'updated' },
    );
    const lookupId = (conn.update as jest.Mock).mock.calls[0][1];
    expect(lookupId).toBe('real-customer-id-42');
    expect(lookupId).not.toContain('[REDACTED');
  });

  it('update enqueue resourceId is "unknown" placeholder when redactedPayload.id is STRIPPED (Copilot R4 on PR #827 — resourceId PII-fallback guard)', async () => {
    // Companion guard for the queue-path contract (ADR-021 §5a). Some
    // DLP redaction policies STRIP PII fields rather than mask them, so
    // `decision.redactedPayload` may be a plain object with no `id` key
    // at all. The pre-fix resolveResourceIdSync() would fall back to the
    // raw `record.id` in that case — which is exactly the PII the scan
    // just removed. The fix: when redactedPayload is a plain object,
    // ALWAYS read from it (id ?? 'unknown'); never fall back to the
    // unredacted record. Asserts the enqueue arg's resourceId is the
    // 'unknown' placeholder and does NOT contain the raw PII-shaped id.
    const rawId = 'alice@example.com';
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision({
        // Per OutboundGovernanceService contract: `approved` is computed
        // as `!blocked && !approvalRequired`, so an approvalRequired
        // decision is ALWAYS `approved: false`. `riskLevel: 'high'` is
        // what triggers approvalRequired in the first place (the service
        // sets `approvalRequired = riskLevel === 'high'` then collapses
        // to hard-block unless the org's option is 'queue'). Copilot R6
        // on PR #827 tightened the fixture to match the real shape.
        approved: false,
        approvalRequired: true,
        riskLevel: 'high',
        // DLP scan STRIPPED the id field entirely (not present in the
        // redacted payload). Other PII fields may be stripped or masked
        // too — only `name` survives here.
        redactedPayload: { name: 'Customer' },
        auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
      })),
      queue,
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    const result = await exec.execute(tpl, { id: rawId, name: 'Customer' }, makeCtx({}));
    expect(result.status).toBe('pending_approval');
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = (queue.enqueue as jest.Mock).mock.calls[0][0];
    expect(enqueueArgs.resourceId).toBe('unknown');
    expect(enqueueArgs.resourceId).not.toBe(rawId);
    expect(JSON.stringify(enqueueArgs)).not.toContain(rawId);
  });

  it('update enqueue resourceId is "unknown" placeholder when redactedPayload is non-plain-object (Copilot R8 on PR #827 — non-plain redactedPayload guard)', async () => {
    // Defense-in-depth companion to the stripped-id case above. The
    // OutboundDecision.redactedPayload type is `T | undefined` where T is
    // the caller-supplied record shape (always a plain object), so a
    // non-plain non-null value (string, array, primitive, class instance)
    // would require an upstream type-contract violation. The queue-path
    // contract still has to hold: if redactedPayload is present at ALL,
    // the raw record id never reaches `governance_approvals.resource_id`.
    // Asserts that a malformed string-shaped redactedPayload collapses to
    // the `'unknown'` placeholder via `readId` returning null on
    // non-plain inputs, NOT to the raw `record.id`.
    const rawId = 'bob@example.com';
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision({
        approved: false,
        approvalRequired: true,
        riskLevel: 'high',
        // Hand-crafted type-contract violation — a future caller might
        // construct an OutboundDecision shape with a non-plain payload.
        // Cast required since OutboundDecision.redactedPayload is typed
        // `T | undefined`; this test deliberately violates that contract
        // to exercise the defense-in-depth gate.
        redactedPayload: 'malformed-decision-payload' as unknown as Record<string, unknown>,
        auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
      })),
      queue,
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    const result = await exec.execute(tpl, { id: rawId, name: 'Customer' }, makeCtx({}));
    expect(result.status).toBe('pending_approval');
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = (queue.enqueue as jest.Mock).mock.calls[0][0];
    expect(enqueueArgs.resourceId).toBe('unknown');
    expect(enqueueArgs.resourceId).not.toBe(rawId);
    expect(JSON.stringify(enqueueArgs)).not.toContain(rawId);
  });

  it('update dispatch-succeeded log line does NOT contain the raw target id (Copilot R3 on PR #827 — log-line leak guard)', async () => {
    // Companion guard to the headline update-id leak test above. The fix
    // for Codex 5.5 HIGH plumbed the raw `originalUpdateId` through to
    // connector.update — correct for the connector lookup arg, but the
    // success log line `FlowExecutor dispatch succeeded` would have
    // included that raw id in its metadata payload, re-introducing the
    // leak Logger sinks aggregate as searchable text. The log line MUST
    // NOT carry the raw PII-shaped id. Asserts on the actual logger call
    // args so a future refactor that re-adds `targetRecordId` to the
    // metadata fails fast.
    const logger = mockLogger();
    const conn = mockConnector();
    conn.update.mockResolvedValue({ name: 'updated' });
    const decision = makeDecision({
      approved: true,
      approvalRequired: false,
      redactedPayload: { id: '[REDACTED-EMAIL]', name: 'updated' },
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
    });
    const exec = new FlowExecutor(
      logger as any,
      mockGovernance(decision),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    const rawId = 'alice@example.com';
    const result = await exec.execute(tpl, { id: rawId, name: 'updated' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');

    const succeededLogCall = logger.info.mock.calls.find(
      (call: unknown[]) => call[0] === 'FlowExecutor dispatch succeeded',
    );
    expect(succeededLogCall).toBeDefined();
    const meta = succeededLogCall?.[1] as Record<string, unknown>;
    expect(meta).toBeDefined();
    // Hard guards: neither `targetRecordId` as a key nor the raw id as
    // any nested value can appear in the success log metadata.
    expect(Object.keys(meta)).not.toContain('targetRecordId');
    expect(JSON.stringify(meta)).not.toContain(rawId);
    // flowMeta fields must still be present so log lines are traceable.
    expect(meta.templateId).toBe('unit-test-template-v1');
    expect(meta.correlationId).toBe('corr-1');
    expect(meta.operation).toBe('update');
    // The result still carries the raw id for downstream callers — only
    // the log-line surface drops it.
    if (result.status === 'succeeded') expect(result.targetRecordId).toBe(rawId);
  });

  // Belt-and-braces guard tests. The dispatch logic now lives inline inside
  // the `do:` arrow function of guardedWrite() in execute(). The guards
  // (update-null / delete-null) are unreachable from execute() because the
  // pre-governance gates return `status: 'failed'` before the do: callback
  // fires. Coverage for the pre-flight gates is via the execute() path:

  it('execute returns failed when update template produces record without id (pre-flight guard covers the update-null path)', async () => {
    const conn = mockConnector();
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    // Pass a record with NO id — the pre-flight gate catches this and returns 'failed'
    // before the guardedWrite do: callback (and any connector.update call) runs.
    const result = await exec.execute(tpl, { name: 'x' } as any, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    expect(conn.update).not.toHaveBeenCalled();
  });

  it('execute returns failed when delete resolver returns empty string (pre-flight guard covers the delete-null path)', async () => {
    const conn = mockConnector();
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({
      target: {
        system: 'netsuite',
        recordType: 'Widget',
        canonicalEntity: 'customer',
        operation: 'delete',
        resolveTargetRecordId: async () => '',    // empty → pre-flight fails
      },
    });
    const result = await exec.execute(tpl, {}, makeCtx({}, conn));
    expect(result.status).toBe('failed');
    expect(conn.delete).not.toHaveBeenCalled();
  });

  it('update dispatch reads the lookup id from the record even when redactedPayload has no id field at all', async () => {
    // Edge case: DLP scan strips the id field entirely from the
    // redacted form (some redaction policies drop PII fields rather
    // than mask them). The pre-Codex-HIGH contract would have crashed
    // here ("update operation requires payload.id" thrown from the
    // dispatch branch); the new contract uses the captured original
    // and succeeds.
    const conn = mockConnector();
    conn.update.mockResolvedValue({ name: 'no-id' });
    const decision = makeDecision({
      approved: true,
      approvalRequired: false,
      redactedPayload: { name: 'no-id' }, // id field STRIPPED entirely
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' } });
    const result = await exec.execute(tpl, { id: 'real-id-99', name: 'no-id' }, makeCtx({}, conn));
    expect(result.status).toBe('succeeded');
    expect(conn.update).toHaveBeenCalledWith('Widget', 'real-id-99', { name: 'no-id' });
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({
      target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'update' },
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({
      target: {
        system: 'netsuite',
        recordType: 'Widget',
        canonicalEntity: 'customer',
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ target: { system: 'netsuite', recordType: 'Widget', canonicalEntity: 'customer', operation: 'create' } });
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
    const exec = new FlowExecutor(mockLogger() as any, gov, queue,
      mockOwnershipResolver() as unknown as OwnershipResolver, mockAuditService() as unknown as AuditService);
    const result = await exec.execute(
      makeTemplate(), // target.system === 'netsuite'
      { id: 'e1', name: 'x' },
      makeCtx({}, wrongConnector),
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/wrong-system.*netsuite/);
    }
    // Neither governance scan nor enqueue should run.
    expect(gov.validateConnectorWrite).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(wrongConnector.create).not.toHaveBeenCalled();
  });

  it('normalises business_central (snake_case) to businesscentral (registry key) for connector matching', async () => {
    // PR 13 Codex review #4: template.target.system 'business_central'
    // must match a real BusinessCentral connector. Without the
    // SOURCE_SYSTEM_TO_CONNECTOR_KEY lookup, raw lowercase comparison
    // would reject the connector ('business_central' !== 'businesscentral').
    const bcConnector = mockConnector({ systemType: 'BusinessCentral' });
    bcConnector.create.mockResolvedValue({ id: 'bc-001' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision({ redactedPayload: { id: 'rec-1', name: 'X' } })),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({
      source: { system: 'business_central', eventType: 'created' },
      target: { system: 'business_central', recordType: 'Customer', canonicalEntity: 'customer', operation: 'create' },
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, bcConnector));
    expect(result.status).toBe('succeeded');
    expect(bcConnector.create).toHaveBeenCalledTimes(1);
  });

  it('squire-targeted template matches a connector with systemType=Squire', async () => {
    // squire maps to the 'squire' registry key (demo-only SuiteCentral
    // mock entry exists for DI parity); a real Squire connector should
    // satisfy the contract check.
    const squireConnector = mockConnector({ systemType: 'Squire' });
    squireConnector.create.mockResolvedValue({ id: 'sq-001' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision({ redactedPayload: { id: 'rec-1', name: 'X' } })),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({
      source: { system: 'squire', eventType: 'created' },
      target: { system: 'squire', recordType: 'PayoutBatch', canonicalEntity: 'payout_batch', operation: 'create' },
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, squireConnector));
    expect(result.status).toBe('succeeded');
    expect(squireConnector.create).toHaveBeenCalledTimes(1);
  });

  it('squire-targeted template rejects a non-Squire connector via the contract check', async () => {
    // Exercises the mismatch branch when SOURCE_SYSTEM_TO_CONNECTOR_KEY
    // resolves to a non-empty key — distinct from the wrong-system test
    // above which uses a fake systemType.
    const netsuiteConnector = mockConnector({ systemType: 'NetSuite' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({
      source: { system: 'squire', eventType: 'created' },
      target: { system: 'squire', recordType: 'PayoutBatch', canonicalEntity: 'payout_batch', operation: 'create' },
    });
    const result = await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({}, netsuiteConnector));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/NetSuite.*squire/);
    }
    expect(netsuiteConnector.create).not.toHaveBeenCalled();
  });
});

describe('FlowExecutor — delete pre-resolve (Codex 5.5 MEDIUM)', () => {
  it('fails fast BEFORE governance scan when resolveTargetRecordId throws', async () => {
    const conn = mockConnector();
    const gov = mockGovernance(makeDecision());
    const queue = mockApprovalQueue();
    const exec = new FlowExecutor(mockLogger() as any, gov, queue,
      mockOwnershipResolver() as unknown as OwnershipResolver, mockAuditService() as unknown as AuditService);
    const tpl = makeTemplate({
      target: {
        system: 'netsuite',
        recordType: 'Widget',
        canonicalEntity: 'customer',
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
    const exec = new FlowExecutor(mockLogger() as any, gov, queue,
      mockOwnershipResolver() as unknown as OwnershipResolver, mockAuditService() as unknown as AuditService);
    const tpl = makeTemplate({
      target: {
        system: 'netsuite',
        recordType: 'Widget',
        canonicalEntity: 'customer',
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
    const exec = new FlowExecutor(mockLogger() as any, mockGovernance(decision), queue,
      mockOwnershipResolver() as unknown as OwnershipResolver, mockAuditService() as unknown as AuditService);
    const tpl = makeTemplate({
      target: {
        system: 'netsuite',
        recordType: 'Widget',
        canonicalEntity: 'customer',
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate({ riskClassification: () => 'high' });
    await exec.execute(tpl, { id: 'e1', name: 'x' }, makeCtx({ tenantId: 'tenant-7', userId: 'user-7' }, conn));
    expect(gov.validateConnectorWrite).toHaveBeenCalledWith(
      { id: 'e1', name: 'x' },
      expect.objectContaining({
        tenantId: 'tenant-7',
        userId: 'user-7',
        destination: 'connector_write',
        destinationDetail: 'netsuite.create',
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
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    await exec.execute(makeTemplate(), { id: 'e1', name: 'x' }, makeCtx({ userId: undefined }, conn));
    const ctxArg = (gov.validateConnectorWrite as jest.Mock).mock.calls[0][1];
    expect(typeof ctxArg.userId).toBe('string');
    expect(ctxArg.userId.length).toBeGreaterThan(0);
  });
});

// ── PR 12 lineage instrumentation (opt-in via ctx.lineageRecorder) ─────

describe('FlowExecutor — lineage instrumentation (PR 12)', () => {
  it('records lineage when ctx.lineageRecorder is provided', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'created-id-77', name: 'Alice' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const tpl = makeTemplate();

    const chain = {
      chainId: 'lin_test',
      sourceRead: jest.fn(async () => undefined),
      transform: jest.fn(async () => undefined),
      governanceDecision: jest.fn(async () => undefined),
      targetWrite: jest.fn(async () => undefined),
    };
    const lineageRecorder = { startChain: jest.fn(() => chain) };

    const result = await exec.execute(
      tpl,
      { id: 'e1', name: 'Alice' },
      makeCtx({
        tenantId: 't_squire',
        userId: 'u_ops',
        correlationId: 'corr_lineage',
        lineageRecorder: lineageRecorder as never,
        sourceRecord: { system: 'hubspot', entityType: 'contact', entityId: 'src_77' },
      }, conn),
    );

    expect(result.status).toBe('succeeded');
    expect(lineageRecorder.startChain).toHaveBeenCalledWith({
      tenantId: 't_squire',
      correlationId: 'corr_lineage',
      templateId: tpl.id,
    });
    // PR 12 follow-up — source_read now fires as the FIRST chain event when
    // the caller has plumbed `ctx.sourceRecord`.
    expect(chain.sourceRead).toHaveBeenCalledWith({
      system: 'hubspot',
      entityType: 'contact',
      entityId: 'src_77',
    });
    expect(chain.transform).toHaveBeenCalledWith(
      expect.objectContaining({ payloadHash: expect.stringMatching(/^sha256:/) }),
    );
    expect(chain.governanceDecision).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'approved' }),
    );
    expect(chain.targetWrite).toHaveBeenCalledWith(expect.objectContaining({
      system: tpl.target.system,
      entityType: tpl.target.recordType,
      entityId: 'created-id-77',
    }));
  });

  it('skips source_read when ctx.sourceRecord is absent (other chain events still fire)', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'created-id-78', name: 'Alice' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );

    const chain = {
      chainId: 'lin_no_source',
      sourceRead: jest.fn(async () => undefined),
      transform: jest.fn(async () => undefined),
      governanceDecision: jest.fn(async () => undefined),
      targetWrite: jest.fn(async () => undefined),
    };
    const lineageRecorder = { startChain: jest.fn(() => chain) };

    const result = await exec.execute(
      makeTemplate(),
      { id: 'e1', name: 'Alice' },
      makeCtx({
        tenantId: 't_squire',
        userId: 'u_ops',
        correlationId: 'corr_no_source',
        lineageRecorder: lineageRecorder as never,
        // sourceRecord intentionally absent — callers that haven't wired
        // upstream ingest yet still get transform/governance/target events.
      }, conn),
    );

    expect(result.status).toBe('succeeded');
    expect(chain.sourceRead).not.toHaveBeenCalled();
    expect(chain.transform).toHaveBeenCalled();
    expect(chain.governanceDecision).toHaveBeenCalled();
    expect(chain.targetWrite).toHaveBeenCalled();
  });

  it('does not call lineageRecorder when ctx.lineageRecorder is undefined', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'created-id-99', name: 'x' });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    // Pin the contract: execute must succeed WITHOUT throwing when no lineage
    // recorder is provided. PR 12 R1 (Copilot a/b/c) — the `.catch` on the
    // optional-chain result MUST itself be optional-chained, otherwise the
    // no-lineage path crashes with TypeError "Cannot read properties of
    // undefined (reading 'catch')". Without the explicit no-throw assertion
    // below, jest swallows the TypeError as an unhandled rejection and the
    // test would falsely pass.
    let thrown: unknown;
    let result: Awaited<ReturnType<typeof exec.execute>> | undefined;
    try {
      result = await exec.execute(
        makeTemplate(),
        { id: 'e1', name: 'x' },
        makeCtx({
          tenantId: 't_squire',
          userId: 'u_ops',
          correlationId: 'corr_no_lineage',
          // lineageRecorder intentionally absent
        }, conn),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(result?.status).toBe('succeeded');
    // No throw, no chain instantiated; existing baseline assertions still hold.
  });

  it('maps approvalRequired → "pending_approval" lineage result', async () => {
    const queue = mockApprovalQueue();
    const decision = makeDecision({
      approved: false,
      approvalRequired: true,
      findings: ['email'],
      redactedPayload: { id: 'rec-1', name: '[REDACTED]' },
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      queue,
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const chain = {
      chainId: 'lin_test',
      sourceRead: jest.fn(async () => undefined),
      transform: jest.fn(async () => undefined),
      governanceDecision: jest.fn(async () => undefined),
      targetWrite: jest.fn(async () => undefined),
    };
    const lineageRecorder = { startChain: jest.fn(() => chain) };

    const result = await exec.execute(
      makeTemplate(),
      { id: 'e1', name: 'Alice' },
      makeCtx({ lineageRecorder: lineageRecorder as never }),
    );
    expect(result.status).toBe('pending_approval');
    expect(chain.governanceDecision).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'pending_approval', findings: ['email'] }),
    );
    // targetWrite NOT called when execution short-circuits at the queue.
    expect(chain.targetWrite).not.toHaveBeenCalled();
  });

  it('maps hard-blocked decision → "blocked" lineage result', async () => {
    const decision = makeDecision({
      approved: false,
      approvalRequired: false,
      findings: ['ssn'],
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: false, blocked: true },
    });
    const exec = new FlowExecutor(
      mockLogger() as any,
      mockGovernance(decision),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const chain = {
      chainId: 'lin_test',
      sourceRead: jest.fn(async () => undefined),
      transform: jest.fn(async () => undefined),
      governanceDecision: jest.fn(async () => undefined),
      targetWrite: jest.fn(async () => undefined),
    };
    const lineageRecorder = { startChain: jest.fn(() => chain) };

    const result = await exec.execute(
      makeTemplate(),
      { id: 'e1', name: 'x' },
      makeCtx({ lineageRecorder: lineageRecorder as never }),
    );
    expect(result.status).toBe('blocked');
    expect(chain.governanceDecision).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'blocked', findings: ['ssn'] }),
    );
    expect(chain.targetWrite).not.toHaveBeenCalled();
  });

  it('swallows lineage append failures — flow still succeeds when chain methods reject', async () => {
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'created-99', name: 'x' });
    const logger = mockLogger();
    const exec = new FlowExecutor(
      logger as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );
    const chain = {
      chainId: 'lin_test',
      sourceRead: jest.fn(async () => { throw new Error('repo-down'); }),
      transform: jest.fn(async () => { throw new Error('repo-down'); }),
      governanceDecision: jest.fn(async () => { throw new Error('repo-down'); }),
      targetWrite: jest.fn(async () => { throw new Error('repo-down'); }),
    };
    const lineageRecorder = { startChain: jest.fn(() => chain) };

    const result = await exec.execute(
      makeTemplate(),
      { id: 'e1', name: 'x' },
      makeCtx({
        lineageRecorder: lineageRecorder as never,
        sourceRecord: { system: 'hubspot', entityType: 'contact', entityId: 'src_swallow' },
      }, conn),
    );
    expect(result.status).toBe('succeeded');
    // All four failure cases were logged (best-effort instrumentation).
    // Assert the full 3-arg shape — message + Error in slot 2 + flowMeta in
    // slot 3 — so a regression that swaps arg2/arg3 fails the test. Pure
    // message-only assertions would silently pass when metadata moves into
    // the `error` slot, because `Logger.error` gates the error slot on
    // `instanceof Error` and drops anything else (see
    // feedback_logger_error_metadata_position_bug).
    const flowMetaShape = expect.objectContaining({
      templateId: expect.any(String),
      tenantId: expect.any(String),
      correlationId: expect.any(String),
      operation: expect.any(String),
      target: expect.any(String),
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('lineage.sourceRead append failed'),
      expect.any(Error),
      flowMetaShape,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('lineage.transform append failed'),
      expect.any(Error),
      flowMetaShape,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('lineage.governanceDecision append failed'),
      expect.any(Error),
      flowMetaShape,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('lineage.targetWrite append failed'),
      expect.any(Error),
      flowMetaShape,
    );
  });

  it('survives a hashLineagePayload throw and still completes the flow with a sentinel hash (PR 12 R5)', async () => {
    // If hashLineagePayload itself throws on a degenerate transformed payload
    // (circular refs, BigInt, custom toJSON that throws), the throw must NOT
    // crash the business flow — the lineage emission falls back to
    // 'sha256:hash-failed' and the executor still returns 'succeeded'.
    const conn = mockConnector();
    conn.create.mockResolvedValue({ id: 'created-id-78', name: 'Alice' });
    const logger = mockLogger();
    const exec = new FlowExecutor(
      logger as any,
      mockGovernance(makeDecision()),
      mockApprovalQueue(),
      mockOwnershipResolver() as unknown as OwnershipResolver,
      mockAuditService() as unknown as AuditService,
    );

    // Override transform to produce a circular-reference record — JSON.stringify
    // (used inside canonicalStringify → hashLineagePayload) will throw on it.
    const tpl = makeTemplate({
      transform: async (e) => {
        const r: Record<string, unknown> = { id: e.id, name: e.name };
        r.self = r;
        return r as unknown as SampleRecord;
      },
    });

    const chain = {
      chainId: 'lin_hashfail',
      sourceRead: jest.fn(async () => undefined),
      transform: jest.fn(async () => undefined),
      governanceDecision: jest.fn(async () => undefined),
      targetWrite: jest.fn(async () => undefined),
    };
    const lineageRecorder = { startChain: jest.fn(() => chain) };

    const result = await exec.execute(
      tpl,
      { id: 'e1', name: 'Alice' },
      makeCtx({
        tenantId: 't_squire',
        userId: 'u_ops',
        correlationId: 'corr_hashfail',
        lineageRecorder: lineageRecorder as never,
      }, conn),
    );

    expect(result.status).toBe('succeeded');
    // Recorder still receives the transform call — with the sentinel hash.
    expect(chain.transform).toHaveBeenCalledWith({ payloadHash: 'sha256:hash-failed' });
    // The hash failure was swallowed + logged with a "compute failed" message
    // (NOT "append failed" — no append was attempted; hash computation threw
    // synchronously). Distinct wording per PR #846 R6.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('lineage.transform-hash compute failed'),
      expect.any(Error),
      expect.objectContaining({ templateId: expect.any(String) }),
    );
    // Governance + target events still emit normally (independent of the hash failure).
    expect(chain.governanceDecision).toHaveBeenCalled();
    expect(chain.targetWrite).toHaveBeenCalled();
  });
});
