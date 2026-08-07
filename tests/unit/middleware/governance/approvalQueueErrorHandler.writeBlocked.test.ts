import {
  LoopDetectedError,
  OwnershipBlockedError,
  OwnershipFieldLevelMergeBlockedError,
  OwnershipPendingApprovalError,
  OwnershipViolationError,
} from '../../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import {
  approvalQueueErrorHandler,
  handleApprovalQueueError,
} from '../../../../src/middleware/governance/approvalQueueErrorHandler';

describe('approvalQueueErrorHandler — WriteBlockedError → 409 mapping', () => {
  let mockReq: any;
  let mockRes: any;
  let mockNext: any;

  beforeEach(() => {
    mockReq = {};
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
  });

  it('OwnershipViolationError → 409 with error=ownership_violation', () => {
    const err = new OwnershipViolationError({
      entity: 'customer', declaredOwner: 'netsuite', callerSystem: 'salesforce',
      conflictPolicy: 'reject_with_alert', correlationId: 'cor-1',
    });
    approvalQueueErrorHandler(err, mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'ownership_violation', entity: 'customer', declaredOwner: 'netsuite', correlationId: 'cor-1',
    }));
  });

  it('OwnershipBlockedError → 409 with error=ownership_blocked', () => {
    const err = new OwnershipBlockedError({
      entity: 'contact', declaredOwner: 'hubspot', callerSystem: 'netsuite',
      policy: 'source_wins', correlationId: 'cor-2',
    });
    approvalQueueErrorHandler(err, mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'ownership_blocked', policy: 'source_wins',
    }));
  });

  it('OwnershipFieldLevelMergeBlockedError → 409 with blocked field paths', () => {
    const err = new OwnershipFieldLevelMergeBlockedError({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'salesforce',
      policy: 'merge_field_level',
      correlationId: 'cor-merge-1',
      allowedFieldPaths: ['salesPipelineStage'],
      blockedFieldPaths: ['name'],
    });
    approvalQueueErrorHandler(err, mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'ownership_field_level_merge_blocked',
      policy: 'merge_field_level',
      allowedFieldPaths: ['salesPipelineStage'],
      blockedFieldPaths: ['name'],
    }));
  });

  it('LoopDetectedError → 409 with error=loop_detected + breakingCondition', () => {
    const err = new LoopDetectedError({
      entity: 'payment', callerSystem: 'netsuite', targetSystem: 'stripe',
      breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      correlationId: 'cor-3',
    });
    approvalQueueErrorHandler(err, mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'loop_detected',
      breakingCondition: expect.stringContaining('sync_back_from_erp'),
    }));
  });

  it('OwnershipPendingApprovalError → 202 with pendingApprovalId + pollUrl', () => {
    const err = new OwnershipPendingApprovalError('q-abc-123');
    approvalQueueErrorHandler(err, mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(202);
    expect(mockRes.json).toHaveBeenCalledWith({
      pendingApprovalId: 'q-abc-123',
      pollUrl: '/api/governance/approvals/q-abc-123',
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('does NOT fire on a non-WriteBlockedError', () => {
    const err = new Error('generic');
    approvalQueueErrorHandler(err, mockReq, mockRes, mockNext);
    expect(mockRes.status).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalledWith(err);
  });
});

describe('handleApprovalQueueError — WriteBlockedError case', () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    mockReq = {};
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      headersSent: false,
    };
  });

  it('OwnershipViolationError → handled (returns true) + sets 409', async () => {
    const err = new OwnershipViolationError({
      entity: 'customer', declaredOwner: 'netsuite', callerSystem: 'salesforce',
      conflictPolicy: 'reject_with_alert', correlationId: 'cor-1',
    });
    const handled = await handleApprovalQueueError(err, mockReq, mockRes, {
      operationType: 'create', resourceType: 'customer', resourceId: 'new',
    });
    expect(handled).toBe(true);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'ownership_violation', entity: 'customer',
    }));
  });

  it('OwnershipBlockedError → handled + 409 with error=ownership_blocked', async () => {
    const err = new OwnershipBlockedError({
      entity: 'contact', declaredOwner: 'hubspot', callerSystem: 'netsuite',
      policy: 'source_wins', correlationId: 'cor-2',
    });
    const handled = await handleApprovalQueueError(err, mockReq, mockRes, {
      operationType: 'update', resourceType: 'contact', resourceId: 'c-1',
    });
    expect(handled).toBe(true);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'ownership_blocked',
    }));
  });

  it('OwnershipFieldLevelMergeBlockedError → handled + 409 with blocked field paths', async () => {
    const err = new OwnershipFieldLevelMergeBlockedError({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'salesforce',
      policy: 'merge_field_level',
      correlationId: 'cor-merge-2',
      allowedFieldPaths: [],
      blockedFieldPaths: ['name'],
    });
    const handled = await handleApprovalQueueError(err, mockReq, mockRes, {
      operationType: 'update', resourceType: 'customer', resourceId: 'cust-1',
    });
    expect(handled).toBe(true);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'ownership_field_level_merge_blocked',
      blockedFieldPaths: ['name'],
    }));
  });

  it('LoopDetectedError → handled + 409 with error=loop_detected', async () => {
    const err = new LoopDetectedError({
      entity: 'payment', callerSystem: 'netsuite', targetSystem: 'stripe',
      breakingCondition: 'audit_logs.action != "sync_back_from_erp"', correlationId: 'cor-3',
    });
    const handled = await handleApprovalQueueError(err, mockReq, mockRes, {
      operationType: 'create', resourceType: 'payment', resourceId: 'new',
    });
    expect(handled).toBe(true);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'loop_detected',
    }));
  });

  it('OwnershipPendingApprovalError → handled + 202 with pendingApprovalId + pollUrl', async () => {
    const err = new OwnershipPendingApprovalError('q-xyz-789');
    const handled = await handleApprovalQueueError(err, mockReq, mockRes, {
      operationType: 'create', resourceType: 'customer', resourceId: 'new',
    });
    expect(handled).toBe(true);
    expect(mockRes.status).toHaveBeenCalledWith(202);
    expect(mockRes.json).toHaveBeenCalledWith({
      pendingApprovalId: 'q-xyz-789',
      pollUrl: '/api/governance/approvals/q-xyz-789',
    });
  });

  it('non-WriteBlockedError → not handled (returns false)', async () => {
    const err = new Error('generic');
    const handled = await handleApprovalQueueError(err, mockReq, mockRes, {
      operationType: 'create', resourceType: 'order', resourceId: 'new',
    });
    expect(handled).toBe(false);
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});
