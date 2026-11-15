import {
  WriteBlockedError,
  OwnershipViolationError,
  OwnershipBlockedError,
  OwnershipFieldLevelMergeBlockedError,
  LoopDetectedError,
  MissingWriteDescriptorError,
  OwnershipPendingApprovalError,
  QueueForHumanNotYetSafeError,
  PolicyNotYetImplementedError,
} from '../../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';

describe('WriteBlockedError hierarchy', () => {
  it('OwnershipViolationError extends WriteBlockedError with code=ownership_violation', () => {
    const err = new OwnershipViolationError({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'salesforce',
      conflictPolicy: 'reject_with_alert',
      correlationId: 'cor-1',
    });
    expect(err).toBeInstanceOf(WriteBlockedError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ownership_violation');
    expect(err.detail.entity).toBe('customer');
  });

  it('OwnershipBlockedError extends WriteBlockedError with code=ownership_blocked', () => {
    const err = new OwnershipBlockedError({
      entity: 'contact',
      declaredOwner: 'hubspot',
      callerSystem: 'netsuite',
      policy: 'source_wins',
      correlationId: 'cor-2',
    });
    expect(err).toBeInstanceOf(WriteBlockedError);
    expect(err.code).toBe('ownership_blocked');
    expect(err.detail.policy).toBe('source_wins');
  });

  it('OwnershipFieldLevelMergeBlockedError extends WriteBlockedError with code=ownership_field_level_merge_blocked', () => {
    const err = new OwnershipFieldLevelMergeBlockedError({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'salesforce',
      policy: 'merge_field_level',
      correlationId: 'cor-merge-1',
      allowedFieldPaths: ['salesPipelineStage'],
      blockedFieldPaths: ['name'],
    });

    expect(err).toBeInstanceOf(WriteBlockedError);
    expect(err.code).toBe('ownership_field_level_merge_blocked');
    expect(err.detail.policy).toBe('merge_field_level');
    expect(err.detail.allowedFieldPaths).toEqual(['salesPipelineStage']);
    expect(err.detail.blockedFieldPaths).toEqual(['name']);
  });

  it('LoopDetectedError extends WriteBlockedError with code=loop_detected', () => {
    const err = new LoopDetectedError({
      entity: 'payment',
      callerSystem: 'netsuite',
      targetSystem: 'stripe',
      breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      correlationId: 'cor-3',
    });
    expect(err).toBeInstanceOf(WriteBlockedError);
    expect(err.code).toBe('loop_detected');
    expect(err.detail.breakingCondition).toContain('sync_back_from_erp');
  });

  it('MissingWriteDescriptorError extends Error but NOT WriteBlockedError', () => {
    const err = new MissingWriteDescriptorError('cor-4');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WriteBlockedError);
    expect(err.correlationId).toBe('cor-4');
    expect(err.message).toContain('cor-4');
    expect(err.name).toBe('MissingWriteDescriptorError');
  });

  // PR 13c-2 lifted the PR 13b fail-closed. QueueForHumanNotYetSafeError is no
  // longer thrown by guardedWrite or ApprovalQueueService but is retained as
  // part of the WriteBlockedError hierarchy + FlowExecutor catch surface for
  // any future defensive use; these tests pin the constructor + detail shape.
  it('QueueForHumanNotYetSafeError extends WriteBlockedError with code=queue_for_human_not_yet_safe', () => {
    const err = new QueueForHumanNotYetSafeError({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'salesforce',
      correlationId: 'cor-5',
    });
    expect(err).toBeInstanceOf(WriteBlockedError);
    expect(err.code).toBe('queue_for_human_not_yet_safe');
    expect(err.detail.entity).toBe('customer');
    expect(err.name).toBe('QueueForHumanNotYetSafeError');
  });

  it('OwnershipPendingApprovalError extends Error but NOT WriteBlockedError, carries queueId', () => {
    const err = new OwnershipPendingApprovalError('queue-abc');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WriteBlockedError);
    expect(err.queueId).toBe('queue-abc');
    expect(err.message).toContain('queue-abc');
    expect(err.name).toBe('OwnershipPendingApprovalError');
  });

  it('PolicyNotYetImplementedError carries the policy name', () => {
    const err = new PolicyNotYetImplementedError('merge_field_level');
    expect(err).toBeInstanceOf(Error);
    expect(err.policy).toBe('merge_field_level');
    expect(err.message).toContain('merge_field_level');
    expect(err.name).toBe('PolicyNotYetImplementedError');
  });

  // Note: TypeScript `abstract` is compile-time only — emitted JS does NOT
  // throw on direct construction. The compile-time guarantee is asserted by
  // the @ts-expect-error directives at the type-only call sites; no runtime
  // test is meaningful here.
});
