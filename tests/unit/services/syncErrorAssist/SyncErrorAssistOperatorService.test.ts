// Fix B / Defect 2 — SyncErrorAssistOperatorService.accept() calls
// `buildNetSuiteEnvAuthConfig()` immediately after `ConnectorManager.getConnector()`
// resolves, then passes the result to `connector.initialize(...)`. This test
// environment has no real NETSUITE_* env credentials configured, so mock the
// helper to a stable fixture AuthConfig.
jest.mock('../../../../src/services/syncErrorAssist/netsuiteEnvAuth', () => {
  const FIXTURE_AUTH_CONFIG = {
    type: 'oauth1',
    credentials: {
      accountId: 'test-ns-account',
      consumerKey: 'test-ns-consumer-key',
      consumerSecret: 'test-ns-consumer-secret',
      tokenId: 'test-ns-token-id',
      tokenSecret: 'test-ns-token-secret',
    },
  };
  return {
    buildNetSuiteEnvAuthConfig: jest.fn().mockReturnValue(FIXTURE_AUTH_CONFIG),
    // Codex P1 — call sites now go through the tenant-checked variant.
    buildNetSuiteEnvAuthConfigForTenant: jest.fn().mockResolvedValue(FIXTURE_AUTH_CONFIG),
    NetSuiteEnvCredentialsMissingError: class NetSuiteEnvCredentialsMissingError extends Error {},
    NetSuiteTenantAccountMismatchError: class NetSuiteTenantAccountMismatchError extends Error {},
  };
});
import { SyncErrorAssistOperatorService } from '../../../../src/services/syncErrorAssist/SyncErrorAssistOperatorService';

describe('SyncErrorAssistOperatorService', () => {
  let svc: SyncErrorAssistOperatorService;
  let mockRepo: jest.Mocked<any>;
  let mockConnectorManager: jest.Mocked<any>;
  let mockAuditLog: jest.Mocked<any>;
  let mockLogger: jest.Mocked<any>;
  let mockConnector: jest.Mocked<any>;
  let mockOwnershipResolver: jest.Mocked<any>;
  let mockAuditService: jest.Mocked<any>;

  beforeEach(() => {
    mockConnector = {
      initialize: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue({ id: 'created_record_42' }),
      update: jest.fn().mockResolvedValue({ id: 'updated_record_99' }),
    };
    mockRepo = {
      listPendingSuggestionsByTenant: jest.fn().mockResolvedValue([]),
      getProcessedRowByErrorRecord: jest.fn(),
      beginAccept: jest.fn().mockResolvedValue(true),
      completeAccept: jest.fn().mockResolvedValue(true),
      revertToPending: jest.fn().mockResolvedValue(true),
      markDisposition: jest.fn().mockResolvedValue(true),
    };
    mockConnectorManager = {
      getConnector: jest.fn().mockResolvedValue(mockConnector),
    };
    mockAuditLog = { create: jest.fn().mockResolvedValue({}) };
    mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    mockOwnershipResolver = {
      validateWrite: jest.fn().mockResolvedValue({ allowed: true, owner: 'netsuite' }),
    };
    mockAuditService = {
      logGovernanceCheck: jest.fn().mockResolvedValue(undefined),
    };
    // Copilot R11 on PR #851: production constructor requires
    // ApprovalQueueService as the 7th dependency (PR 13b CI-9/CI-10 made it
    // required at the type level). No-op enqueue mock — the operator-write
    // path never actually enqueues because guardedWrite fail-closes
    // queue_for_human, but the constructor type contract requires it.
    const mockApprovalQueueService: jest.Mocked<any> = {
      enqueue: jest.fn().mockResolvedValue('mock-approval-id'),
    };
    svc = new SyncErrorAssistOperatorService(
      mockLogger, mockRepo, mockConnectorManager, mockAuditLog,
      mockOwnershipResolver, mockAuditService, mockApprovalQueueService,
    );
  });

  describe('list', () => {
    it('delegates to repo and returns the result', async () => {
      mockRepo.listPendingSuggestionsByTenant.mockResolvedValueOnce([
        { errorRecordId: 'e1', confidence: 'high' } as any,
      ]);
      const out = await svc.list({ tenantId: 'tnt_A', limit: 50 });
      expect(out).toHaveLength(1);
      expect(mockRepo.listPendingSuggestionsByTenant).toHaveBeenCalledWith('tnt_A', { limit: 50 });
    });
  });

  describe('accept', () => {
    it('happy path: leases, dispatches create, completes lease, writes audit, returns ok=true', async () => {
      const result = await svc.accept({
        tenantId: 'tnt_A',
        errorRecordId: 'e1',
        userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: { name: 'Widget' } },
      });
      expect(result.ok).toBe(true);
      expect(mockRepo.beginAccept.mock.invocationCallOrder[0])
        .toBeLessThan(mockConnector.create.mock.invocationCallOrder[0]);
      expect(mockConnectorManager.getConnector).toHaveBeenCalledWith('netsuite', 'netsuite_tnt_A');
      // Defect 2 — connector must be initialized (env-derived AuthConfig) before
      // the write, or NetSuiteConnector.ensureAuthenticated() would throw.
      expect(mockConnector.initialize).toHaveBeenCalledWith({
        type: 'oauth1',
        credentials: expect.objectContaining({ accountId: 'test-ns-account' }),
      });
      expect(mockConnector.initialize.mock.invocationCallOrder[0])
        .toBeLessThan(mockConnector.create.mock.invocationCallOrder[0]);
      // Payload wrapped in { fields: ... } to match NetSuiteConnector contract.
      expect(mockConnector.create).toHaveBeenCalledWith('item', { fields: { name: 'Widget' } });
      expect(mockConnector.create.mock.invocationCallOrder[0])
        .toBeLessThan(mockRepo.completeAccept.mock.invocationCallOrder[0]);
      expect(mockRepo.revertToPending).not.toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'sync_error_assist.accept', result: 'success',
      }));
    });

    it('happy path: update dispatches connector.update', async () => {
      await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'update', entityType: 'invoice', recordId: '5678', patch: { taxRate: 0.07 } },
      });
      expect(mockConnector.update).toHaveBeenCalledWith('invoice', '5678', { fields: { taxRate: 0.07 } });
    });

    it('lease lost (concurrent caller): returns already_dispositioned without calling connector', async () => {
      mockRepo.beginAccept.mockResolvedValueOnce(false);
      mockRepo.getProcessedRowByErrorRecord.mockResolvedValueOnce({ tenant_id: 'tnt_A', error_record_id: 'e1' });
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('already_dispositioned');
      expect(mockConnector.create).not.toHaveBeenCalled();
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
      expect(mockRepo.revertToPending).not.toHaveBeenCalled();
    });

    it('connector unavailable (null returned): reverts lease, returns connector_unavailable', async () => {
      mockConnectorManager.getConnector.mockResolvedValueOnce(null);
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.code).toBe('connector_unavailable');
      expect(mockRepo.revertToPending).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42' }),
      );
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
    });

    it('connector unavailable (getConnector throws mid-construction): reverts lease + writes failure audit', async () => {
      mockConnectorManager.getConnector.mockRejectedValueOnce(new Error('credential resolution failed'));
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.code).toBe('connector_unavailable');
      expect(mockRepo.revertToPending).toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'sync_error_assist.accept',
        result: 'failure',
        details: expect.objectContaining({ connector_error: 'getConnector_threw' }),
      }));
    });

    it('Fix D1 — connector.initialize() throws (e.g. missing NetSuite env credentials): ' +
       'reverts lease, returns connector_unavailable, writes failure audit — same degrade ' +
       'as a getConnector() throw', async () => {
      // getConnector() resolves fine, but the subsequent initialize() call (which
      // this file's module-level jest.mock feeds a fixture AuthConfig) rejects —
      // simulating NetSuiteEnvCredentialsMissingError. Both failure modes share
      // the same try/catch in accept() (SyncErrorAssistOperatorService.ts:75-104),
      // so the outcome must match the existing getConnector-throws test above.
      mockConnector.initialize.mockRejectedValueOnce(new Error('NetSuite env credentials missing'));
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('connector_unavailable');
      expect(mockRepo.revertToPending).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42' }),
      );
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
      expect(mockConnector.create).not.toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'sync_error_assist.accept',
        result: 'failure',
        details: expect.objectContaining({ connector_error: 'initialize_threw' }),
      }));
    });

    it('Codex P1 (PR #966) — tenant-account guard mismatch: reverts lease, returns ' +
       'connector_unavailable, writes failure audit with the typed error message', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteTenantAccountMismatchError } =
        require('../../../../src/services/syncErrorAssist/netsuiteEnvAuth') as {
          buildNetSuiteEnvAuthConfigForTenant: jest.Mock;
          NetSuiteTenantAccountMismatchError: new (...args: unknown[]) => Error;
        };
      buildNetSuiteEnvAuthConfigForTenant.mockRejectedValueOnce(
        new NetSuiteTenantAccountMismatchError('tnt_A', 'TENANT_ACCT', 'ENV_ACCT'),
      );
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('connector_unavailable');
      expect(buildNetSuiteEnvAuthConfigForTenant).toHaveBeenCalledWith('tnt_A', mockRepo);
      expect(mockConnector.initialize).not.toHaveBeenCalled();
      expect(mockConnector.create).not.toHaveBeenCalled();
      expect(mockRepo.revertToPending).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42' }),
      );
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
      // Guard failures surface under the initialize stage — the typed error
      // name/message in error_message disambiguates them from env-missing.
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'sync_error_assist.accept',
        result: 'failure',
        details: expect.objectContaining({ connector_error: 'initialize_threw' }),
      }));
    });

    it('connector write failure: reverts lease and returns write_failed', async () => {
      mockConnector.create.mockRejectedValueOnce(new Error('NetSuite 500'));
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('write_failed');
      expect(mockRepo.revertToPending).toHaveBeenCalled();
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'sync_error_assist.accept', result: 'failure',
      }));
    });

    it('connector returns empty id: reverts lease and returns write_failed (NetSuiteConnector contract)', async () => {
      mockConnector.create.mockResolvedValueOnce({});
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.code).toBe('write_failed');
      expect(mockRepo.revertToPending).toHaveBeenCalled();
    });

    it('connector returns empty-string id: same as missing — reverts lease', async () => {
      mockConnector.create.mockResolvedValueOnce({ id: '' });
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.code).toBe('write_failed');
      expect(mockRepo.revertToPending).toHaveBeenCalled();
    });

    it('UPDATE returns empty-id object: reverts lease, returns write_failed (data-integrity guard)', async () => {
      mockConnector.update.mockResolvedValueOnce({});
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'update', entityType: 'invoice', recordId: '5678', patch: { taxRate: 0.07 } },
      });
      expect(result.code).toBe('write_failed');
      expect(mockRepo.revertToPending).toHaveBeenCalled();
      expect(mockRepo.completeAccept).not.toHaveBeenCalled();
    });

    it('UPDATE returns empty-string id: reverts lease, returns write_failed', async () => {
      mockConnector.update.mockResolvedValueOnce({ id: '' });
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'update', entityType: 'invoice', recordId: '5678', patch: { taxRate: 0.07 } },
      });
      expect(result.code).toBe('write_failed');
      expect(mockRepo.revertToPending).toHaveBeenCalled();
    });

    it('lease releases pass userId to revertToPending (lease isolation)', async () => {
      mockConnector.create.mockRejectedValueOnce(new Error('boom'));
      await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(mockRepo.revertToPending).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42' }),
      );
    });

    it('completeAccept is called with userId for lease isolation', async () => {
      await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(mockRepo.completeAccept).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42' }),
      );
    });

    it('completeAccept failed because state moved (e.g., reaper reverted): audit completion_result=state_moved', async () => {
      mockRepo.completeAccept.mockResolvedValueOnce(false);
      mockRepo.getProcessedRowByErrorRecord.mockResolvedValueOnce({
        tenant_id: 'tnt_A', error_record_id: 'e1', operator_disposition: 'pending', operator_disposition_user_id: null,
      });
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: { name: 'Widget' } },
      });
      expect(result.ok).toBe(true);
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        details: expect.objectContaining({ completion_result: 'state_moved' }),
      }));
    });

    it('completeAccept failed because wrong holder: audit completion_result=wrong_holder', async () => {
      mockRepo.completeAccept.mockResolvedValueOnce(false);
      mockRepo.getProcessedRowByErrorRecord.mockResolvedValueOnce({
        tenant_id: 'tnt_A', error_record_id: 'e1', operator_disposition: 'applying', operator_disposition_user_id: 'someone_else',
      });
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: { name: 'Widget' } },
      });
      expect(result.ok).toBe(true);
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        details: expect.objectContaining({ completion_result: 'wrong_holder' }),
      }));
    });

    it('completeAccept failed because row missing: audit completion_result=missing', async () => {
      mockRepo.completeAccept.mockResolvedValueOnce(false);
      mockRepo.getProcessedRowByErrorRecord.mockResolvedValueOnce(null);
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: { name: 'Widget' } },
      });
      expect(result.ok).toBe(true);
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        details: expect.objectContaining({ completion_result: 'missing' }),
      }));
    });

    it('audit write failure does NOT abort: returns ok=true after successful write+complete', async () => {
      mockAuditLog.create.mockRejectedValueOnce(new Error('audit DB outage'));
      const result = await svc.accept({
        tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42',
        applyAction: { type: 'create', entityType: 'item', payload: {} },
      });
      expect(result.ok).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('marks disposition + writes audit; does NOT call connector', async () => {
      const result = await svc.reject({ tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42', reason: 'wrong' });
      expect(result.ok).toBe(true);
      expect(mockConnectorManager.getConnector).not.toHaveBeenCalled();
      expect(mockRepo.markDisposition).toHaveBeenCalledWith(expect.objectContaining({ newDisposition: 'rejected' }));
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync_error_assist.reject' }));
    });

    it('returns already_dispositioned when row not pending', async () => {
      mockRepo.markDisposition.mockResolvedValueOnce(false);
      mockRepo.getProcessedRowByErrorRecord.mockResolvedValueOnce({ tenant_id: 'tnt_A', error_record_id: 'e1' });
      const result = await svc.reject({ tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42', reason: 'wrong' });
      expect(result.code).toBe('already_dispositioned');
    });
  });

  describe('escalate', () => {
    it('marks disposition + writes audit; does NOT call connector', async () => {
      const result = await svc.escalate({ tenantId: 'tnt_A', errorRecordId: 'e1', userId: 'op_42', note: 'needs eng' });
      expect(result.ok).toBe(true);
      expect(mockRepo.markDisposition).toHaveBeenCalledWith(expect.objectContaining({ newDisposition: 'escalated' }));
      expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync_error_assist.escalate' }));
    });
  });
});
