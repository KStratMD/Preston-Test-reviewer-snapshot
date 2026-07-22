import { guardedWrite } from '../../../../src/governance/sourceOfTruth/guardedWrite';
import {
  LoopDetectedError,
  MissingWriteDescriptorError,
  OwnershipBlockedError,
  OwnershipFieldLevelMergeBlockedError,
  OwnershipPendingApprovalError,
  OwnershipViolationError,
} from '../../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';

describe('guardedWrite — Stage A1 skeleton', () => {
  let mockResolver: any;
  let mockAuditService: any;

  beforeEach(() => {
    mockResolver = {
      validateWrite: jest.fn(),
      detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
    };
    mockAuditService = {
      logGovernanceCheck: jest.fn().mockResolvedValue('audit-id-1'),
    };
  });

  const baseContext = () => ({
    tenantId: 't-1',
    callerSystem: 'hubspot' as const,
    targetSystem: 'hubspot' as const,
    entity: 'contact' as const,
    correlationId: 'cor-1',
    requesterUserId: 'user-1',
    operation: 'create' as const,
  });

  it('allow path: runs do() and returns result + emits success outcome audit', async () => {
    mockResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'hubspot' });
    const result = await guardedWrite(
      { context: baseContext(), do: async () => ({ id: 'rec-1' }) },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    );
    expect(result).toEqual({ id: 'rec-1' });
    expect(mockAuditService.logGovernanceCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkType: 'ownership', approved: true }),
    );
  });

  it('source_wins block path: throws OwnershipBlockedError', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: false, reason: 'non_owner_write',
      policy: 'source_wins', declaredOwner: 'hubspot',
    });
    await expect(
      guardedWrite(
        { context: { ...baseContext(), callerSystem: 'netsuite' }, do: async () => ({}) },
        { ownershipResolver: mockResolver, auditService: mockAuditService },
      ),
    ).rejects.toBeInstanceOf(OwnershipBlockedError);
  });

  it('reject_with_alert: re-throws OwnershipViolationError from validateWrite', async () => {
    mockResolver.validateWrite.mockRejectedValue(
      new OwnershipViolationError({
        entity: 'customer', declaredOwner: 'netsuite', callerSystem: 'salesforce',
        conflictPolicy: 'reject_with_alert', correlationId: 'cor-1',
      }),
    );
    await expect(
      guardedWrite(
        { context: { ...baseContext(), callerSystem: 'salesforce', entity: 'customer' }, do: async () => ({}) },
        { ownershipResolver: mockResolver, auditService: mockAuditService },
      ),
    ).rejects.toBeInstanceOf(OwnershipViolationError);
  });

  // Copilot R1 (PR 13b) cluster-A2: a rejected non-owner write must emit a
  // governance_check audit row with approved=false BEFORE the rethrow, so
  // the /api/governance/ownership-rejections dashboard surfaces it. Prior
  // code rethrew immediately and the dashboard would never see the row.
  it('reject_with_alert (no override): emits rejected audit row BEFORE re-throwing', async () => {
    mockResolver.validateWrite.mockRejectedValue(
      new OwnershipViolationError({
        entity: 'customer', declaredOwner: 'netsuite', callerSystem: 'salesforce',
        conflictPolicy: 'reject_with_alert', correlationId: 'cor-reject-1',
      }),
    );
    await expect(
      guardedWrite(
        { context: { ...baseContext(), callerSystem: 'salesforce', entity: 'customer' }, do: async () => ({}) },
        { ownershipResolver: mockResolver, auditService: mockAuditService },
      ),
    ).rejects.toBeInstanceOf(OwnershipViolationError);
    const calls = mockAuditService.logGovernanceCheck.mock.calls;
    const rejectedRows = calls.filter((c: any) => c[0].approved === false && c[0].flags?.includes('ownership_violation_rejected'));
    expect(rejectedRows).toHaveLength(1);
    expect(rejectedRows[0][0]).toMatchObject({
      checkType: 'ownership',
      approved: false,
      riskLevel: 'high',
      flags: ['ownership_violation_rejected'],
      ownership: expect.objectContaining({
        entity: 'customer',
        declaredOwner: 'netsuite',
        callerSystem: 'salesforce',
        policy: 'reject_with_alert',
      }),
    });
  });

  // Defense for the inner try/catch: if logGovernanceCheck throws, the
  // OwnershipViolationError must still propagate to the caller — losing
  // observability is preferable to masking the original violation.
  it('reject_with_alert: still re-throws when the audit-row emission fails', async () => {
    mockResolver.validateWrite.mockRejectedValue(
      new OwnershipViolationError({
        entity: 'customer', declaredOwner: 'netsuite', callerSystem: 'salesforce',
        conflictPolicy: 'reject_with_alert', correlationId: 'cor-reject-2',
      }),
    );
    mockAuditService.logGovernanceCheck.mockRejectedValueOnce(new Error('audit DB down'));
    await expect(
      guardedWrite(
        { context: { ...baseContext(), callerSystem: 'salesforce', entity: 'customer' }, do: async () => ({}) },
        { ownershipResolver: mockResolver, auditService: mockAuditService },
      ),
    ).rejects.toBeInstanceOf(OwnershipViolationError);
  });

  // Copilot R1 (PR 13b) cluster-B: validateWrite returning the new
  // `reason: 'no_policy_declared'` shape must surface a guarded-write
  // audit row flagged `ownership_no_policy_declared` so the operator
  // dashboard can tell apart "passing through unknown entity" from
  // "owner write".
  it('no-policy-declared allow: audit row flagged ownership_no_policy_declared', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: true,
      owner: 'hubspot',
      reason: 'no_policy_declared',
    });
    await guardedWrite(
      { context: { ...baseContext(), entity: 'contacts' }, do: async () => ({ ok: true }) },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    );
    const calls = mockAuditService.logGovernanceCheck.mock.calls;
    const decisionRow = calls.find((c: any) => c[0].approved === true && c[0].flags?.includes('ownership_no_policy_declared'));
    expect(decisionRow).toBeDefined();
  });

  it('passes operation and fieldPaths to OwnershipResolver', async () => {
    mockResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'hubspot' });
    await guardedWrite(
      {
        context: {
          ...baseContext(),
          operation: 'update',
          fieldPaths: ['salesPipelineStage'],
        },
        fieldLevelPayload: { payload: { salesPipelineStage: 'proposal' }, mode: 'drop_disallowed' },
        do: async (approved) => approved,
      },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    );

    expect(mockResolver.validateWrite).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'update',
      fieldPaths: ['salesPipelineStage'],
    }));
  });

  it('do() throws: success outcome audit not emitted; error propagates', async () => {
    mockResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'hubspot' });
    const doErr = new Error('connector exploded');
    await expect(
      guardedWrite(
        { context: baseContext(), do: async () => { throw doErr; } },
        { ownershipResolver: mockResolver, auditService: mockAuditService },
      ),
    ).rejects.toBe(doErr);
    const calls = mockAuditService.logGovernanceCheck.mock.calls;
    expect(calls.filter((c: any) => c[0].approved === true && c[0].flags?.includes('write_succeeded'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stage D: merge_field_level payload filtering (PR 13d)
// ---------------------------------------------------------------------------

describe('guardedWrite — Stage D: merge_field_level payload filtering', () => {
  let mockResolver: any;
  let mockAuditService: any;

  beforeEach(() => {
    mockResolver = {
      validateWrite: jest.fn(),
      detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
    };
    mockAuditService = {
      logGovernanceCheck: jest.fn().mockResolvedValue('audit-id-1'),
    };
  });

  const baseContext = () => ({
    tenantId: 't-1',
    callerSystem: 'salesforce' as const,
    targetSystem: 'netsuite' as const,
    entity: 'customer' as const,
    recordId: 'cust-1',
    correlationId: 'cor-merge-1',
    requesterUserId: 'user-1',
    operation: 'update' as const,
    fieldPaths: ['salesPipelineStage', 'name'],
  });

  const mergeDecision = (blockedFieldPaths: string[] = ['name']) => ({
    allowed: true as const,
    owner: 'salesforce' as const,
    reason: 'field_level_merge' as const,
    policy: 'merge_field_level' as const,
    declaredOwner: 'netsuite' as const,
    allowedFieldPaths: ['salesPipelineStage'],
    blockedFieldPaths,
  });

  it('drop_disallowed passes only the allowed payload subset to do()', async () => {
    mockResolver.validateWrite.mockResolvedValue(mergeDecision());
    const doFn = jest.fn().mockResolvedValue({ id: 'cust-1' });

    await guardedWrite(
      {
        context: baseContext(),
        fieldLevelPayload: {
          payload: { salesPipelineStage: 'proposal', name: 'Acme' },
          mode: 'drop_disallowed',
        },
        do: doFn,
      },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    );

    expect(doFn).toHaveBeenCalledWith({ salesPipelineStage: 'proposal' });
    const decisionRow = mockAuditService.logGovernanceCheck.mock.calls[0][0];
    expect(decisionRow).toMatchObject({
      approved: true,
      riskLevel: 'high',
      flags: ['ownership_field_merge_partial'],
      ownership: expect.objectContaining({
        policy: 'merge_field_level',
        allowedFieldPaths: ['salesPipelineStage'],
        blockedFieldPaths: ['name'],
      }),
    });
  });

  it('drop_disallowed allows a full merge payload when no fields are blocked', async () => {
    mockResolver.validateWrite.mockResolvedValue(mergeDecision([]));
    const doFn = jest.fn().mockResolvedValue({ id: 'cust-1' });

    await guardedWrite(
      {
        context: baseContext(),
        fieldLevelPayload: {
          payload: { salesPipelineStage: 'proposal' },
          mode: 'drop_disallowed',
        },
        do: doFn,
      },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    );

    expect(doFn).toHaveBeenCalledWith({ salesPipelineStage: 'proposal' });
    const decisionRow = mockAuditService.logGovernanceCheck.mock.calls[0][0];
    expect(decisionRow).toMatchObject({
      approved: true,
      riskLevel: 'high',
      flags: ['ownership_field_merge_allowed'],
      ownership: expect.objectContaining({
        policy: 'merge_field_level',
        allowedFieldPaths: ['salesPipelineStage'],
        blockedFieldPaths: [],
      }),
    });
  });

  it('block_on_any_disallowed throws before do() when any field is blocked', async () => {
    mockResolver.validateWrite.mockResolvedValue(mergeDecision());
    const doFn = jest.fn().mockResolvedValue({ id: 'cust-1' });

    await expect(guardedWrite(
      {
        context: baseContext(),
        fieldLevelPayload: {
          payload: { salesPipelineStage: 'proposal', name: 'Acme' },
          mode: 'block_on_any_disallowed',
        },
        do: doFn,
      },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    )).rejects.toBeInstanceOf(OwnershipFieldLevelMergeBlockedError);

    expect(doFn).not.toHaveBeenCalled();
    // Codex review: the decision audit row must record approved=false for a
    // write that the payload mode blocks — not a misleading approved=true.
    const decisionRow = mockAuditService.logGovernanceCheck.mock.calls[0][0];
    expect(decisionRow).toMatchObject({
      checkType: 'ownership',
      approved: false,
      flags: ['ownership_field_merge_blocked'],
    });
  });

  it('empty filtered payload throws before do()', async () => {
    mockResolver.validateWrite.mockResolvedValue(mergeDecision());
    const doFn = jest.fn().mockResolvedValue({ id: 'cust-1' });

    await expect(guardedWrite(
      {
        context: baseContext(),
        fieldLevelPayload: {
          payload: { name: 'Acme' },
          mode: 'drop_disallowed',
        },
        do: doFn,
      },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    )).rejects.toBeInstanceOf(OwnershipFieldLevelMergeBlockedError);

    expect(doFn).not.toHaveBeenCalled();
    // Audit must record approved=false when the drop_disallowed filter empties
    // the payload (Codex review).
    const decisionRow = mockAuditService.logGovernanceCheck.mock.calls[0][0];
    expect(decisionRow).toMatchObject({ approved: false, flags: ['ownership_field_merge_blocked'] });
  });

  it('field_level_merge_blocked decision throws before do()', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: false,
      reason: 'field_level_merge_blocked',
      policy: 'merge_field_level',
      declaredOwner: 'netsuite',
      allowedFieldPaths: [],
      blockedFieldPaths: ['name'],
    });
    const doFn = jest.fn().mockResolvedValue({ id: 'cust-1' });

    await expect(guardedWrite(
      {
        context: baseContext(),
        fieldLevelPayload: {
          payload: { name: 'Acme' },
          mode: 'drop_disallowed',
        },
        do: doFn,
      },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    )).rejects.toBeInstanceOf(OwnershipFieldLevelMergeBlockedError);

    expect(doFn).not.toHaveBeenCalled();
  });

  it('field_level_merge without a field-level payload fails closed before do()', async () => {
    mockResolver.validateWrite.mockResolvedValue(mergeDecision());
    const doFn = jest.fn().mockResolvedValue({ id: 'cust-1' });

    await expect(guardedWrite(
      {
        context: baseContext(),
        do: doFn,
      },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    )).rejects.toBeInstanceOf(OwnershipFieldLevelMergeBlockedError);

    expect(doFn).not.toHaveBeenCalled();
    // Audit must record approved=false when no field-level payload is supplied
    // for a field_level_merge decision (Codex review).
    const decisionRow = mockAuditService.logGovernanceCheck.mock.calls[0][0];
    expect(decisionRow).toMatchObject({ approved: false, flags: ['ownership_field_merge_blocked'] });
  });

  it('operator override permits the full field-level payload and emits merge override metadata', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: false,
      reason: 'field_level_merge_blocked',
      policy: 'merge_field_level',
      declaredOwner: 'netsuite',
      allowedFieldPaths: [],
      blockedFieldPaths: ['name'],
    });
    const doFn = jest.fn().mockResolvedValue({ id: 'cust-1' });

    await guardedWrite(
      {
        context: { ...baseContext(), callerSystem: 'operator_action' as const },
        fieldLevelPayload: {
          payload: { name: 'Acme' },
          mode: 'drop_disallowed',
        },
        override: { permitted: true, reason: 'operator correction' },
        do: doFn,
      },
      { ownershipResolver: mockResolver, auditService: mockAuditService },
    );

    expect(doFn).toHaveBeenCalledWith({ name: 'Acme' });
    const decisionRow = mockAuditService.logGovernanceCheck.mock.calls[0][0];
    expect(decisionRow).toMatchObject({
      approved: true,
      riskLevel: 'high',
      flags: ['ownership_violation_override'],
      ownership: expect.objectContaining({
        policy: 'merge_field_level',
        blockedFieldPaths: ['name'],
      }),
    });
    const overrideRow = mockAuditService.logGovernanceCheck.mock.calls
      .map((call: any) => call[0])
      .find((row: any) => row.flags?.includes('governance_override'));
    expect(overrideRow).toMatchObject({
      ownership: expect.objectContaining({
        policy: 'merge_field_level',
        blockedFieldPaths: ['name'],
        governanceOverride: expect.objectContaining({ originalPolicy: 'merge_field_level' }),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Stage B: queue_for_human + operator override (PR 13b)
// ---------------------------------------------------------------------------

describe('guardedWrite — Stage B (PR 13b)', () => {
  let mockResolver: any;
  let mockAuditService: any;
  let mockApprovalQueueService: any;

  beforeEach(() => {
    mockResolver = {
      validateWrite: jest.fn(),
      detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
    };
    mockAuditService = {
      logGovernanceCheck: jest.fn().mockResolvedValue('audit-id-1'),
    };
    mockApprovalQueueService = {
      enqueue: jest.fn().mockResolvedValue('queue-id-1'),
    };
  });

  const baseDeps = () => ({
    ownershipResolver: mockResolver,
    auditService: mockAuditService,
    approvalQueueService: mockApprovalQueueService,
  });

  const baseContext = () => ({
    tenantId: 't-1',
    callerSystem: 'netsuite' as const,
    targetSystem: 'hubspot' as const,
    entity: 'customer' as const,
    correlationId: 'cor-1',
    requesterUserId: 'user-1',
    operation: 'create' as const,
  });

  const queueRequiredDecision = () => ({
    allowed: false as const,
    reason: 'queue_required' as const,
    declaredOwner: 'hubspot' as const,
  });

  const resumeDescriptor = () => ({
    targetSystemId: 'hubspot',
    operation: 'create' as const,
    entityType: 'Customer',
    args: { name: 'Acme' },
  });

  // PR 13c-2 Task 3: queue_for_human is LIVE. The decision-audit row fires
  // (policy='queue_for_human'), ApprovalQueueService.enqueue persists the
  // encrypted descriptor, and guardedWrite throws OwnershipPendingApprovalError
  // carrying the queueId so the route layer maps to 202.
  it('queue_required → enqueues encrypted descriptor + throws OwnershipPendingApprovalError(queueId)', async () => {
    mockResolver.validateWrite.mockResolvedValue(queueRequiredDecision());

    await expect(
      guardedWrite(
        { context: baseContext(), do: async () => ({ id: 'x' }), resume: resumeDescriptor() },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(OwnershipPendingApprovalError);

    expect(mockApprovalQueueService.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArg = mockApprovalQueueService.enqueue.mock.calls[0][0];
    expect(enqueueArg.operationType).toBe('ownership_write');
    expect(enqueueArg.resourceType).toBe('customer');
    expect(enqueueArg.tenantId).toBe('t-1');
    expect(enqueueArg.reason.kind).toBe('ownership');
    expect(enqueueArg.reason.writeDescriptor.targetSystemId).toBe('hubspot');
    expect(enqueueArg.reason.writeDescriptor.operation).toBe('create');
    expect(enqueueArg.reason.writeDescriptor.entityType).toBe('Customer');
    expect(enqueueArg.reason.writeDescriptor.args).toEqual({ name: 'Acme' });
    // guardedWrite enriches the caller's descriptor with the manifest-owned
    // ownership block — the resume handler audits this canonical-vocab form.
    expect(enqueueArg.reason.writeDescriptor.ownership).toEqual({
      entity: 'customer',
      declaredOwner: 'hubspot',
      callerSystem: 'netsuite',
      targetSystem: 'hubspot',
    });
  });

  it('OwnershipPendingApprovalError.queueId is the enqueue return value', async () => {
    mockResolver.validateWrite.mockResolvedValue(queueRequiredDecision());
    mockApprovalQueueService.enqueue.mockResolvedValue('queue-id-from-svc');

    let caughtError: unknown;
    try {
      await guardedWrite(
        { context: baseContext(), do: async () => ({}), resume: resumeDescriptor() },
        baseDeps(),
      );
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(OwnershipPendingApprovalError);
    expect((caughtError as OwnershipPendingApprovalError).queueId).toBe('queue-id-from-svc');
  });

  it('queue_required + no resume descriptor: throws MissingWriteDescriptorError, does NOT enqueue', async () => {
    mockResolver.validateWrite.mockResolvedValue(queueRequiredDecision());

    await expect(
      guardedWrite(
        { context: baseContext(), do: async () => ({ id: 'x' }) },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(MissingWriteDescriptorError);

    expect(mockApprovalQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('queue_required without approvalQueueService dep: throws plain Error (programming error)', async () => {
    mockResolver.validateWrite.mockResolvedValue(queueRequiredDecision());
    const depsWithoutQueue = {
      ownershipResolver: mockResolver,
      auditService: mockAuditService,
      // approvalQueueService intentionally omitted
    };

    await expect(
      guardedWrite(
        { context: baseContext(), do: async () => ({}), resume: resumeDescriptor() },
        depsWithoutQueue,
      ),
    ).rejects.toThrow(/queue_required decision but no approvalQueueService dep was injected/);
  });

  it('queue_required + integrationConfigId in context: propagated into the persisted descriptor', async () => {
    mockResolver.validateWrite.mockResolvedValue(queueRequiredDecision());
    const ctxWithConfig = { ...baseContext(), integrationConfigId: 'cfg-7' };

    await expect(
      guardedWrite(
        { context: ctxWithConfig, do: async () => ({}), resume: resumeDescriptor() },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(OwnershipPendingApprovalError);

    const enqueueArg = mockApprovalQueueService.enqueue.mock.calls[0][0];
    expect(enqueueArg.reason.writeDescriptor.integrationConfigId).toBe('cfg-7');
  });

  it('queue_required + integrationConfigId in resume: persisted descriptor prefers the resume value', async () => {
    mockResolver.validateWrite.mockResolvedValue(queueRequiredDecision());
    const ctxWithConfig = { ...baseContext(), integrationConfigId: 'cfg-context' };
    const resumeWithConfig = { ...resumeDescriptor(), integrationConfigId: 'cfg-resume' };

    await expect(
      guardedWrite(
        { context: ctxWithConfig, do: async () => ({}), resume: resumeWithConfig },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(OwnershipPendingApprovalError);

    const enqueueArg = mockApprovalQueueService.enqueue.mock.calls[0][0];
    expect(enqueueArg.reason.writeDescriptor.integrationConfigId).toBe('cfg-resume');
  });

  // Copilot R9 on PR #853: derive targetSystemId from canonical
  // context.targetSystem and fail-close if resume.targetSystemId disagrees.
  // Symmetric with FlowExecutor.ts:193's connector-contract check. Without
  // this, a caller passing the canonical name (e.g. 'business_central')
  // in resume.targetSystemId would enqueue a descriptor that later resolves
  // to a non-existent registry key at resume time.
  it('queue_required + resume.targetSystemId mismatches derived connector key: throws and does NOT enqueue', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: false as const,
      reason: 'queue_required' as const,
      declaredOwner: 'business_central' as const,
    });
    const ctxBC = { ...baseContext(), targetSystem: 'business_central' as const };
    // Caller mistakenly passes the canonical manifest name instead of the
    // connector-registry key 'businesscentral'.
    const resumeWithCanonicalName = { ...resumeDescriptor(), targetSystemId: 'business_central' };

    await expect(
      guardedWrite(
        { context: ctxBC, do: async () => ({}), resume: resumeWithCanonicalName },
        baseDeps(),
      ),
    ).rejects.toThrow(/does not match the connector-registry key derived from context\.targetSystem='business_central'/);

    expect(mockApprovalQueueService.enqueue).not.toHaveBeenCalled();
  });

  // Copilot R10 on PR #853: same fail-close pattern as R9's targetSystemId
  // check, applied to resume.operation. A divergence between resume.operation
  // and context.operation would mean the audit chain (which uses context.operation)
  // and the resumed write would disagree.
  it('queue_required + resume.operation disagrees with context.operation: throws and does NOT enqueue', async () => {
    mockResolver.validateWrite.mockResolvedValue(queueRequiredDecision());
    const ctx = baseContext(); // operation: 'create'
    const resumeWrongOp = { ...resumeDescriptor(), operation: 'update' as const };

    await expect(
      guardedWrite(
        { context: ctx, do: async () => ({}), resume: resumeWrongOp },
        baseDeps(),
      ),
    ).rejects.toThrow(/resume\.operation='update' does not match context\.operation='create'/);

    expect(mockApprovalQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('queue_required + business_central context: persisted descriptor carries the derived registry key (businesscentral)', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: false as const,
      reason: 'queue_required' as const,
      declaredOwner: 'business_central' as const,
    });
    const ctxBC = { ...baseContext(), targetSystem: 'business_central' as const };
    const resumeBC = { ...resumeDescriptor(), targetSystemId: 'businesscentral' };

    await expect(
      guardedWrite(
        { context: ctxBC, do: async () => ({}), resume: resumeBC },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(OwnershipPendingApprovalError);

    const enqueueArg = mockApprovalQueueService.enqueue.mock.calls[0][0];
    expect(enqueueArg.reason.writeDescriptor.targetSystemId).toBe('businesscentral');
    expect(enqueueArg.reason.writeDescriptor.ownership.targetSystem).toBe('business_central');
  });

  it('operator_action + override + source_wins: 3-row audit pattern (decision → override → outcome), runs do()', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: false,
      reason: 'non_owner_write',
      policy: 'source_wins',
      declaredOwner: 'hubspot',
    });
    const ctx = { ...baseContext(), callerSystem: 'operator_action' as const };
    const doFn = jest.fn().mockResolvedValue({ id: 'new-rec' });

    const result = await guardedWrite(
      {
        context: ctx,
        do: doFn,
        override: { permitted: true, reason: 'bulk backfill authorized by finance team' },
      },
      baseDeps(),
    );

    expect(result).toEqual({ id: 'new-rec' });
    expect(doFn).toHaveBeenCalledTimes(1);

    const auditCalls: any[] = mockAuditService.logGovernanceCheck.mock.calls.map((c: any) => c[0]);

    // Row 1: decision (approved=TRUE, override flag).
    // Copilot R17 on PR #851: source_wins + canOverride is now pre-flipped
    // BEFORE the decision audit row fires (mirroring the reject_with_alert +
    // override path that uses caughtViolation). Without this, the
    // /api/governance/ownership-rejections dashboard (filters approved=false)
    // was leaking successfully-overridden writes into the rejections panel.
    expect(auditCalls[0]).toMatchObject({
      checkType: 'ownership',
      approved: true,
      flags: ['ownership_violation_override'],
    });
    // Row 2: override (approved=true, governance_override flag)
    expect(auditCalls[1]).toMatchObject({
      checkType: 'ownership',
      approved: true,
      flags: expect.arrayContaining(['governance_override']),
      ownership: expect.objectContaining({ governanceOverride: { permitted: true, reason: 'bulk backfill authorized by finance team', originalPolicy: 'source_wins' } }),
    });
    // Row 3: outcome (approved=true, write_succeeded)
    expect(auditCalls[2]).toMatchObject({
      checkType: 'ownership',
      approved: true,
      flags: expect.arrayContaining(['write_succeeded']),
    });
  });

  it('operator_action + override + reject_with_alert: 3-row audit (decision via catch → override → outcome), runs do()', async () => {
    mockResolver.validateWrite.mockRejectedValue(
      new OwnershipViolationError({
        entity: 'customer',
        declaredOwner: 'hubspot',
        callerSystem: 'operator_action',
        conflictPolicy: 'reject_with_alert',
        correlationId: 'cor-1',
      }),
    );
    const ctx = { ...baseContext(), callerSystem: 'operator_action' as const };
    const doFn = jest.fn().mockResolvedValue({ id: 'override-rec' });

    const result = await guardedWrite(
      {
        context: ctx,
        do: doFn,
        override: { permitted: true, reason: 'emergency correction' },
      },
      baseDeps(),
    );

    expect(result).toEqual({ id: 'override-rec' });

    const auditCalls: any[] = mockAuditService.logGovernanceCheck.mock.calls.map((c: any) => c[0]);
    // Row 1: decision row (approved=true because caughtViolation overrides → allowed:true set)
    expect(auditCalls[0]).toMatchObject({
      checkType: 'ownership',
      flags: expect.arrayContaining(['ownership_violation_override']),
    });
    // Row 2: override audit
    expect(auditCalls[1]).toMatchObject({
      flags: expect.arrayContaining(['governance_override']),
      ownership: expect.objectContaining({ governanceOverride: expect.objectContaining({ originalPolicy: 'reject_with_alert' }) }),
    });
    // Row 3: outcome
    expect(auditCalls[2]).toMatchObject({
      flags: expect.arrayContaining(['write_succeeded', 'governance_override']),
    });
  });

  it('non-operator caller with source_wins: throws OwnershipBlockedError even with override field', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: false,
      reason: 'non_owner_write',
      policy: 'source_wins',
      declaredOwner: 'hubspot',
    });
    // callerSystem is NOT operator_action — override is ignored
    const ctx = { ...baseContext(), callerSystem: 'netsuite' as const };

    await expect(
      guardedWrite(
        {
          context: ctx,
          do: async () => ({}),
          override: { permitted: true, reason: 'should be ignored' },
        },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(OwnershipBlockedError);
  });

  it('operator_action with source_wins but no override field: throws OwnershipBlockedError', async () => {
    mockResolver.validateWrite.mockResolvedValue({
      allowed: false,
      reason: 'non_owner_write',
      policy: 'source_wins',
      declaredOwner: 'hubspot',
    });
    const ctx = { ...baseContext(), callerSystem: 'operator_action' as const };

    // No override field provided
    await expect(
      guardedWrite(
        { context: ctx, do: async () => ({}) },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(OwnershipBlockedError);
  });

  it('operator_action + override + queue_required: enqueues (override has no effect on queue_required)', async () => {
    mockResolver.validateWrite.mockResolvedValue(queueRequiredDecision());
    const ctx = { ...baseContext(), callerSystem: 'operator_action' as const };

    await expect(
      guardedWrite(
        {
          context: ctx,
          do: async () => ({}),
          resume: resumeDescriptor(),
          override: { permitted: true, reason: 'manual trigger' },
        },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(OwnershipPendingApprovalError);

    // Override does NOT short-circuit the queue path — operator overrides
    // target reject_with_alert and source_wins, not queue_for_human. The
    // queue still fires because the entity declared queue_for_human and the
    // policy must be honored.
    expect(mockApprovalQueueService.enqueue).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Stage C: detectLoop wiring (PR 13b)
// ---------------------------------------------------------------------------

describe('guardedWrite — Stage C: detectLoop', () => {
  let mockResolver: any;
  let mockAuditService: any;
  let mockApprovalQueueService: any;

  beforeEach(() => {
    mockResolver = {
      validateWrite: jest.fn(),
      detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
    };
    mockAuditService = {
      logGovernanceCheck: jest.fn().mockResolvedValue('audit-id-1'),
    };
    mockApprovalQueueService = {
      enqueue: jest.fn().mockResolvedValue('queue-id-1'),
    };
  });

  const baseDeps = () => ({
    ownershipResolver: mockResolver,
    auditService: mockAuditService,
    approvalQueueService: mockApprovalQueueService,
  });

  const baseContext = () => ({
    tenantId: 't-1',
    callerSystem: 'netsuite' as const,
    targetSystem: 'stripe' as const,
    entity: 'payment' as const,
    recordId: 'pay-123',
    correlationId: 'cor-c-1',
    requesterUserId: 'user-1',
    operation: 'create' as const,
  });

  it('SourceSystem caller + allow + loopDetected: throws LoopDetectedError, do() NOT called, audit row emitted', async () => {
    mockResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'stripe' });
    mockResolver.detectLoop.mockResolvedValue({
      loopDetected: true,
      breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
    });
    const doFn = jest.fn().mockResolvedValue({ id: 'should-not-run' });

    await expect(
      guardedWrite(
        { context: baseContext(), do: doFn },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(LoopDetectedError);

    expect(doFn).not.toHaveBeenCalled();

    const auditCalls: any[] = mockAuditService.logGovernanceCheck.mock.calls.map((c: any) => c[0]);
    // Last row should be the loop_detection row
    const loopRow = auditCalls.find(
      (c) => c.checkType === 'loop_detection',
    );
    expect(loopRow).toBeDefined();
    expect(loopRow).toMatchObject({
      checkType: 'loop_detection',
      approved: false,
      riskLevel: 'high',
      flags: expect.arrayContaining(['loop_detected']),
      ownership: expect.objectContaining({
        entity: 'payment',
        loopBreakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      }),
    });
  });

  it('non-SourceSystem caller (operator_action) + allow: detectLoop NOT called, do() runs', async () => {
    mockResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'hubspot' });
    const doFn = jest.fn().mockResolvedValue({ id: 'rec-op' });

    const result = await guardedWrite(
      {
        context: {
          ...baseContext(),
          callerSystem: 'operator_action' as const,
          targetSystem: 'hubspot' as const,
          entity: 'contact' as const,
        },
        do: doFn,
      },
      baseDeps(),
    );

    expect(result).toEqual({ id: 'rec-op' });
    expect(doFn).toHaveBeenCalledTimes(1);
    expect(mockResolver.detectLoop).toHaveBeenCalledTimes(0);
  });

  it('non-SourceSystem caller (webhook_relay) + allow: detectLoop NOT called', async () => {
    mockResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'hubspot' });
    const doFn = jest.fn().mockResolvedValue({ id: 'rec-wh' });

    await guardedWrite(
      {
        context: {
          ...baseContext(),
          callerSystem: 'webhook_relay' as const,
          targetSystem: 'hubspot' as const,
          entity: 'contact' as const,
        },
        do: doFn,
      },
      baseDeps(),
    );

    expect(doFn).toHaveBeenCalledTimes(1);
    expect(mockResolver.detectLoop).toHaveBeenCalledTimes(0);
  });

  it('SourceSystem caller + override + loopDetected: still throws LoopDetectedError (override has NO effect on loop)', async () => {
    mockResolver.validateWrite.mockResolvedValue({ allowed: true, owner: 'stripe' });
    mockResolver.detectLoop.mockResolvedValue({
      loopDetected: true,
      breakingCondition: 'X',
    });
    const doFn = jest.fn().mockResolvedValue({ id: 'should-not-run' });

    await expect(
      guardedWrite(
        {
          context: baseContext(), // netsuite → stripe, payment
          do: doFn,
          override: { permitted: true, reason: 'urgent' },
        },
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(LoopDetectedError);

    expect(doFn).not.toHaveBeenCalled();
  });
});

// Demo-tenant override (OWNERSHIP_DEMO_TENANT_ID): the resolver returns
// {allowed: true, reason: 'demo_tenant_override', declaredOwner, policy} for
// the designated tenant's non-owner writes under reject_with_alert.
// guardedWrite must (1) execute the write, (2) record the distinct
// 'ownership_demo_tenant_override' flag at HIGH risk on the decision row so
// overridden demo writes are queryable, (3) keep declaredOwner honest (the
// manifest owner, not the caller/target), and (4) keep loop detection live —
// the override bypasses ownership policy, never the reciprocal-loop gate.
describe('guardedWrite — demo-tenant override decision', () => {
  let mockResolver: any;
  let mockAuditService: any;

  beforeEach(() => {
    mockResolver = {
      validateWrite: jest.fn().mockResolvedValue({
        allowed: true,
        owner: 'netsuite',
        reason: 'demo_tenant_override',
        declaredOwner: 'netsuite',
        policy: 'reject_with_alert',
      }),
      detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
    };
    mockAuditService = {
      logGovernanceCheck: jest.fn().mockResolvedValue('audit-id-1'),
    };
  });

  const demoContext = () => ({
    tenantId: 'demo-tenant-1',
    callerSystem: 'squire' as const,
    targetSystem: 'netsuite' as const,
    entity: 'customer' as const,
    recordId: 'rec-1',
    correlationId: 'cor-demo',
    requesterUserId: 'user-1',
    operation: 'create' as const,
  });

  const deps = () => ({ ownershipResolver: mockResolver, auditService: mockAuditService });

  it('executes the write and returns its result', async () => {
    const result = await guardedWrite(
      { context: demoContext(), do: async () => ({ id: 'ns-1' }) },
      deps(),
    );
    expect(result).toEqual({ id: 'ns-1' });
  });

  it('decision audit row: approved=true, high risk, demo flag, honest declaredOwner', async () => {
    await guardedWrite({ context: demoContext(), do: async () => ({}) }, deps());
    expect(mockAuditService.logGovernanceCheck).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        checkType: 'ownership',
        approved: true,
        riskLevel: 'high',
        flags: ['ownership_demo_tenant_override'],
        ownership: expect.objectContaining({
          entity: 'customer',
          declaredOwner: 'netsuite',
          callerSystem: 'squire',
          targetSystem: 'netsuite',
          operation: 'create',
        }),
      }),
    );
  });

  it('outcome audit row carries write_succeeded + the demo flag and honest declaredOwner', async () => {
    await guardedWrite({ context: demoContext(), do: async () => ({}) }, deps());
    const calls = mockAuditService.logGovernanceCheck.mock.calls;
    const outcome = calls[calls.length - 1][0];
    expect(outcome).toMatchObject({
      checkType: 'ownership',
      approved: true,
      flags: ['write_succeeded', 'ownership_demo_tenant_override'],
      ownership: expect.objectContaining({ declaredOwner: 'netsuite' }),
    });
  });

  it('loop detection still runs and a detected loop blocks the overridden write', async () => {
    mockResolver.detectLoop.mockResolvedValue({ loopDetected: true, breakingCondition: 'X' });
    const doFn = jest.fn().mockResolvedValue({});
    await expect(
      guardedWrite({ context: demoContext(), do: doFn }, deps()),
    ).rejects.toBeInstanceOf(LoopDetectedError);
    expect(doFn).not.toHaveBeenCalled();
    // The loop audit row's declaredOwner stays the manifest owner.
    const loopRow = mockAuditService.logGovernanceCheck.mock.calls.find(
      ([row]: [{ checkType: string }]) => row.checkType === 'loop_detection',
    )![0];
    expect(loopRow.ownership.declaredOwner).toBe('netsuite');
  });
});
