import { FinanceCentralOperatorService } from '../../../../src/services/financeCentral/FinanceCentralOperatorService';

function rowFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'row-uuid',
    tenant_id: 'tnt_A',
    approval_id: 'appr-1',
    document_id: 'doc-1',
    document_number: 'INV-2024-001',
    document_type: 'invoice',
    description: 'Monthly service invoice',
    entity_name: 'Supplier Corp',
    employee_name: null,
    amount: 1500,
    currency: 'USD',
    submitted_by: 's@x',
    submitted_at: new Date().toISOString(),
    current_approver: 'a@x',
    approval_level: 1,
    priority: 'medium',
    netsuite_id: 'NS-9999',
    operator_disposition: 'applying',
    operator_disposition_user_id: 'op_42',
    ...overrides,
  };
}

describe('FinanceCentralOperatorService', () => {
  let svc: FinanceCentralOperatorService;
  let mockRepo: jest.Mocked<any>;
  let mockConnectorManager: jest.Mocked<any>;
  let mockAuditLog: jest.Mocked<any>;
  let mockLogger: jest.Mocked<any>;
  let mockConnector: jest.Mocked<any>;

  beforeEach(() => {
    mockConnector = {
      update: jest.fn().mockResolvedValue({ id: 'NS-applied-1' }),
    };
    mockRepo = {
      listPendingApprovals: jest.fn().mockResolvedValue([]),
      getRowByApprovalId: jest.fn().mockResolvedValue(rowFixture()),
      getDisposition: jest.fn().mockResolvedValue('pending'),
      beginAccept: jest.fn().mockResolvedValue(true),
      completeAccept: jest.fn().mockResolvedValue(true),
      revertToPending: jest.fn().mockResolvedValue(true),
      markRejected: jest.fn().mockResolvedValue(true),
    };
    mockConnectorManager = {
      getConnector: jest.fn().mockResolvedValue(mockConnector),
    };
    mockAuditLog = { create: jest.fn().mockResolvedValue({}) };
    mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    svc = new FinanceCentralOperatorService(
      mockLogger,
      mockRepo,
      mockConnectorManager,
      mockAuditLog,
    );
  });

  describe('listPendingApprovals', () => {
    it('delegates to the repo and returns its result', async () => {
      mockRepo.listPendingApprovals.mockResolvedValueOnce([{ id: 'appr-1' }]);
      const result = await svc.listPendingApprovals({ tenantId: 'tnt_A', limit: 50 });
      expect(result).toEqual([{ id: 'appr-1' }]);
      expect(mockRepo.listPendingApprovals).toHaveBeenCalledWith({ tenantId: 'tnt_A', limit: 50 });
    });

    it('forwards filters to the repo', async () => {
      await svc.listPendingApprovals({ tenantId: 'tnt_A', filters: { type: 'invoice', priority: 'high' } });
      expect(mockRepo.listPendingApprovals).toHaveBeenCalledWith({
        tenantId: 'tnt_A',
        filters: { type: 'invoice', priority: 'high' },
      });
    });
  });

  describe('approveItem', () => {
    it('happy path: leases, dispatches update, completes lease, writes success audit, returns ok=true with appliedRecordId', async () => {
      const result = await svc.approveItem({
        tenantId: 'tnt_A',
        approvalId: 'appr-1',
        approverId: 'op_42',
        comments: 'looks good',
      });
      expect(result.ok).toBe(true);
      if (result.ok && result.code === 'ok' && 'appliedRecordId' in result) {
        expect(result.appliedRecordId).toBe('NS-applied-1');
      }
      // Order: beginAccept → connector.update → completeAccept.
      expect(mockRepo.beginAccept.mock.invocationCallOrder[0])
        .toBeLessThan(mockConnector.update.mock.invocationCallOrder[0]);
      expect(mockConnector.update.mock.invocationCallOrder[0])
        .toBeLessThan(mockRepo.completeAccept.mock.invocationCallOrder[0]);
      expect(mockConnectorManager.getConnector).toHaveBeenCalledWith('netsuite', 'netsuite_tnt_A');
      // Payload wrapped in { fields: ... } to match NetSuiteConnector contract.
      expect(mockConnector.update).toHaveBeenCalledWith(
        'invoice',
        'NS-9999',
        expect.objectContaining({
          fields: expect.objectContaining({
            status: 'approved',
            approved_by: 'op_42',
            approval_comments: 'looks good',
          }),
        }),
      );
      expect(mockRepo.revertToPending).not.toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'finance_central.approve',
        result: 'success',
      }));
    });

    it('passes null approval_comments when comments are omitted', async () => {
      await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(mockConnector.update).toHaveBeenCalledWith(
        'invoice',
        'NS-9999',
        expect.objectContaining({
          fields: expect.objectContaining({ approval_comments: null }),
        }),
      );
    });

    it('lease lost (already dispositioned): returns already_dispositioned without calling connector or reverting, AND audits failure (PR 6 R9)', async () => {
      mockRepo.beginAccept.mockResolvedValueOnce(false);
      mockRepo.getDisposition.mockResolvedValueOnce('rejected');
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('already_dispositioned');
      }
      expect(mockConnector.update).not.toHaveBeenCalled();
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
      expect(mockRepo.revertToPending).not.toHaveBeenCalled();
      // PR 6 R9: every failure mode must audit, matching rejectItem.
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'finance_central.approve',
        result: 'failure',
        error_message: 'already_dispositioned',
        details: expect.objectContaining({ stage: 'beginAccept' }),
      }));
    });

    it('beginAccept false + getDisposition null: returns not_found AND audits failure (PR 6 R9)', async () => {
      mockRepo.beginAccept.mockResolvedValueOnce(false);
      mockRepo.getDisposition.mockResolvedValueOnce(null);
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('not_found');
      }
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'finance_central.approve',
        result: 'failure',
        error_message: 'not_found',
        details: expect.objectContaining({ stage: 'beginAccept' }),
      }));
    });

    it('row vanishes after lease (theoretically unreachable defensive path): reverts lease + audits failure + returns not_found', async () => {
      mockRepo.getRowByApprovalId.mockResolvedValueOnce(null);
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('not_found');
      }
      expect(mockRepo.revertToPending).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tnt_A', approvalId: 'appr-1', userId: 'op_42' }),
      );
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'finance_central.approve',
        result: 'failure',
        error_message: 'row_vanished_after_lease',
      }));
      expect(mockConnector.update).not.toHaveBeenCalled();
    });

    it('row missing netsuite_id (spec §2.D3 F-02): reverts lease + returns connector_unavailable with no_netsuite_id message', async () => {
      mockRepo.getRowByApprovalId.mockResolvedValueOnce(rowFixture({ netsuite_id: null }));
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('connector_unavailable');
        expect(result.message).toBe('no_netsuite_id');
      }
      expect(mockRepo.revertToPending).toHaveBeenCalled();
      expect(mockConnectorManager.getConnector).not.toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        result: 'failure',
        error_message: 'no_netsuite_id',
        details: expect.objectContaining({ connector_error: 'no_netsuite_id' }),
      }));
    });

    it('getConnector throws: reverts lease + audits getConnector_threw + returns connector_unavailable', async () => {
      mockConnectorManager.getConnector.mockRejectedValueOnce(new Error('credential resolution failed'));
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('connector_unavailable');
        expect(result.message).toBe('credential resolution failed');
      }
      expect(mockRepo.revertToPending).toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        result: 'failure',
        details: expect.objectContaining({ connector_error: 'getConnector_threw' }),
      }));
    });

    it('getConnector returns null: reverts lease + audits getConnector_null + returns connector_unavailable', async () => {
      mockConnectorManager.getConnector.mockResolvedValueOnce(null);
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('connector_unavailable');
      }
      expect(mockRepo.revertToPending).toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        details: expect.objectContaining({ connector_error: 'getConnector_null' }),
      }));
    });

    it('connector.update throws: reverts lease + audits failure + returns write_failed', async () => {
      mockConnector.update.mockRejectedValueOnce(new Error('NetSuite 500'));
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('write_failed');
        expect(result.message).toBe('NetSuite 500');
      }
      expect(mockRepo.revertToPending).toHaveBeenCalled();
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'finance_central.approve',
        result: 'failure',
      }));
    });

    it('connector.update returns no id field (D3a contract violation): throws → revert + write_failed', async () => {
      mockConnector.update.mockResolvedValueOnce({});
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('write_failed');
      }
      expect(mockRepo.revertToPending).toHaveBeenCalled();
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
    });

    it('connector.update returns empty-string id (D3a contract violation): same as missing → revert + write_failed', async () => {
      mockConnector.update.mockResolvedValueOnce({ id: '' });
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('write_failed');
      }
      expect(mockRepo.revertToPending).toHaveBeenCalled();
    });

    // PR 6 R2 (Codex BM-1): completeAccept failure after a successful connector
    // write returns `state_drift` (not ok=true). Allowing ok=true would let
    // another operator pick up the now-pending row and re-approve, double-writing
    // to the ERP. Audit `applied_record_id` is preserved for reconciliation.

    it('completeAccept fails because state moved (reaper reverted): state_drift + audit failure with completion_result=state_moved + appliedRecordId preserved', async () => {
      mockRepo.completeAccept.mockResolvedValueOnce(false);
      // 1st call: pre-write row lookup (has netsuite_id). 2nd call: post-completeAccept disambiguation.
      mockRepo.getRowByApprovalId
        .mockResolvedValueOnce(rowFixture())
        .mockResolvedValueOnce(rowFixture({
          operator_disposition: 'pending',
          operator_disposition_user_id: null,
        }));
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('state_drift');
        expect(result.message).toContain('NS-applied-1');
        expect(result.message).toContain('state_moved');
      }
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        result: 'failure',
        error_message: 'state_drift:state_moved',
        details: expect.objectContaining({
          completion_result: 'state_moved',
          applied_record_id: 'NS-applied-1',
        }),
      }));
    });

    it('completeAccept fails because wrong holder: state_drift + audit failure with completion_result=wrong_holder', async () => {
      mockRepo.completeAccept.mockResolvedValueOnce(false);
      mockRepo.getRowByApprovalId
        .mockResolvedValueOnce(rowFixture())
        .mockResolvedValueOnce(rowFixture({
          operator_disposition: 'applying',
          operator_disposition_user_id: 'somebody_else',
        }));
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('state_drift');
        expect(result.message).toContain('wrong_holder');
      }
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        result: 'failure',
        error_message: 'state_drift:wrong_holder',
        details: expect.objectContaining({ completion_result: 'wrong_holder' }),
      }));
    });

    it('completeAccept fails because row missing: state_drift + audit failure with completion_result=missing', async () => {
      mockRepo.completeAccept.mockResolvedValueOnce(false);
      mockRepo.getRowByApprovalId
        .mockResolvedValueOnce(rowFixture())
        .mockResolvedValueOnce(null);
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('state_drift');
        expect(result.message).toContain('missing');
      }
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        result: 'failure',
        error_message: 'state_drift:missing',
        details: expect.objectContaining({ completion_result: 'missing' }),
      }));
    });

    it('audit write failure does NOT abort: returns ok=true after successful write+complete + logs warn', async () => {
      mockAuditLog.create.mockRejectedValueOnce(new Error('audit DB outage'));
      const result = await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(result.ok).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('revert is called with the approver userId for lease isolation (matches the lease holder)', async () => {
      mockConnector.update.mockRejectedValueOnce(new Error('boom'));
      await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(mockRepo.revertToPending).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tnt_A', approvalId: 'appr-1', userId: 'op_42' }),
      );
    });

    it('completeAccept is called with the approver userId for lease isolation', async () => {
      await svc.approveItem({ tenantId: 'tnt_A', approvalId: 'appr-1', approverId: 'op_42' });
      expect(mockRepo.completeAccept).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tnt_A', approvalId: 'appr-1', userId: 'op_42' }),
      );
    });
  });

  describe('rejectItem', () => {
    it('marks rejected + writes audit; does NOT call connector', async () => {
      const result = await svc.rejectItem({
        tenantId: 'tnt_A',
        approvalId: 'appr-1',
        rejecterId: 'op_42',
        reason: 'missing receipts',
      });
      expect(result.ok).toBe(true);
      expect(mockConnectorManager.getConnector).not.toHaveBeenCalled();
      expect(mockRepo.markRejected).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 'tnt_A',
        approvalId: 'appr-1',
        userId: 'op_42',
        rejectionReason: 'missing receipts',
      }));
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'finance_central.reject',
        result: 'success',
      }));
    });

    it('returns already_dispositioned when row is not pending', async () => {
      mockRepo.markRejected.mockResolvedValueOnce(false);
      mockRepo.getDisposition.mockResolvedValueOnce('accepted');
      const result = await svc.rejectItem({
        tenantId: 'tnt_A',
        approvalId: 'appr-1',
        rejecterId: 'op_42',
        reason: 'late',
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('already_dispositioned');
      }
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        result: 'failure',
        error_message: 'already_dispositioned',
      }));
    });

    it('returns not_found when row does not exist', async () => {
      mockRepo.markRejected.mockResolvedValueOnce(false);
      mockRepo.getDisposition.mockResolvedValueOnce(null);
      const result = await svc.rejectItem({
        tenantId: 'tnt_A',
        approvalId: 'missing',
        rejecterId: 'op_42',
        reason: 'late',
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe('not_found');
      }
    });

    it('audit write failure does NOT abort: returns ok=true after successful markRejected + logs warn', async () => {
      mockAuditLog.create.mockRejectedValueOnce(new Error('audit DB outage'));
      const result = await svc.rejectItem({
        tenantId: 'tnt_A',
        approvalId: 'appr-1',
        rejecterId: 'op_42',
        reason: 'late',
      });
      expect(result.ok).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
