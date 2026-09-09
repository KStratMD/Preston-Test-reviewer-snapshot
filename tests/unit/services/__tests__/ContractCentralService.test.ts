/**
 * ContractCentralService Unit Tests
 */

import 'reflect-metadata';
import { ContractCentralService } from '../../../../src/services/ContractCentralService';
import type { Logger } from 'pino';

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Logger>;
}

describe('ContractCentralService', () => {
  let service: ContractCentralService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    service = new ContractCentralService(mockLogger);
  });

  describe('initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('ContractCentralService initialized');
    });
  });

  describe('Dashboard & Metrics', () => {
    describe('getDashboard', () => {
      it('should return comprehensive dashboard data', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard).toHaveProperty('summary');
        expect(dashboard).toHaveProperty('metrics');
        expect(dashboard).toHaveProperty('contractsByType');
        expect(dashboard).toHaveProperty('expiringContracts');
        expect(dashboard).toHaveProperty('pendingActions');
        expect(dashboard).toHaveProperty('recentActivity');
        expect(dashboard).toHaveProperty('lastUpdated');
      });

      it('should have valid summary', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard.summary.activeContracts).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.expiringSoon).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.pendingRenewals).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.totalContractValue).toBeGreaterThanOrEqual(0);
      });
    });

    describe('getMetrics', () => {
      it('should return contract metrics', async () => {
        const metrics = await service.getMetrics();

        expect(metrics).toHaveProperty('totalContracts');
        expect(metrics).toHaveProperty('activeContracts');
        expect(metrics).toHaveProperty('expiredContracts');
        expect(metrics).toHaveProperty('draftContracts');
        expect(metrics).toHaveProperty('avgContractValue');
        expect(metrics).toHaveProperty('totalContractValue');
        expect(metrics).toHaveProperty('renewalRate');
        expect(metrics).toHaveProperty('avgNegotiationDays');
        expect(metrics).toHaveProperty('complianceScore');
        expect(metrics).toHaveProperty('expiringIn30Days');
        expect(metrics).toHaveProperty('expiringIn60Days');
        expect(metrics).toHaveProperty('expiringIn90Days');
      });
    });

    describe('getContractsByType', () => {
      it('should return contracts grouped by type', async () => {
        const byType = await service.getContractsByType();

        // Deterministic: demo seed has 3 active contracts (2 service, 1 sales),
        // and getContractsByType only reports active types with count > 0.
        expect(byType.length).toBe(2);
        byType.forEach((entry) => {
          expect(entry).toHaveProperty('type');
          expect(entry.count).toBeGreaterThan(0);
          expect(entry.value).toBeGreaterThan(0);
        });
        const serviceEntry = byType.find((t) => t.type === 'service');
        const salesEntry = byType.find((t) => t.type === 'sales');
        expect(serviceEntry?.count).toBe(2);
        expect(salesEntry?.count).toBe(1);
      });
    });
  });

  describe('Contract CRUD', () => {
    describe('getContracts', () => {
      it('should return contracts', async () => {
        const result = await service.getContracts();
        expect(result.contracts.length).toBeGreaterThan(0);
        expect(result.total).toBeGreaterThan(0);
      });

      it('should filter by type', async () => {
        const result = await service.getContracts({ type: 'service' });
        result.contracts.forEach((c) => expect(c.type).toBe('service'));
      });

      it('should filter by status', async () => {
        const result = await service.getContracts({ status: 'active' });
        result.contracts.forEach((c) => expect(c.status).toBe('active'));
      });

      it('should limit results', async () => {
        const result = await service.getContracts({ limit: 2 });
        expect(result.contracts.length).toBeLessThanOrEqual(2);
      });

      it('should support offset for pagination', async () => {
        const result1 = await service.getContracts({ limit: 1, offset: 0 });
        const result2 = await service.getContracts({ limit: 1, offset: 1 });

        // Deterministic: the demo seed creates 4 contracts, so both pages exist.
        expect(result1.total).toBeGreaterThan(1);
        expect(result1.contracts[0].id).not.toBe(result2.contracts[0].id);
      });
    });

    describe('getContract', () => {
      it('should return contract by ID', async () => {
        const contracts = await service.getContracts();
        const contract = await service.getContract(contracts.contracts[0].id);
        expect(contract).not.toBeNull();
        expect(contract!.id).toBe(contracts.contracts[0].id);
      });

      it('should return null for non-existent', async () => {
        const contract = await service.getContract('NON-EXISTENT');
        expect(contract).toBeNull();
      });
    });

    describe('getContractByNumber', () => {
      it('should return contract by contract number', async () => {
        const contracts = await service.getContracts();
        const contract = await service.getContractByNumber(contracts.contracts[0].contractNumber);
        expect(contract).not.toBeNull();
        expect(contract!.contractNumber).toBe(contracts.contracts[0].contractNumber);
      });

      it('should return null for non-existent contract number', async () => {
        const contract = await service.getContractByNumber('NON-EXISTENT-NUMBER');
        expect(contract).toBeNull();
      });
    });

    describe('createContract', () => {
      it('should create a new contract', async () => {
        const contract = await service.createContract({
          name: 'Test Contract',
          description: 'A test contract',
          type: 'service',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'customer', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'Net 30',
            terminationClause: '30 days notice',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'Delaware',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 50000,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        expect(contract.id).toMatch(/^CTR-/);
        expect(contract.contractNumber).toMatch(/^CTR-/);
        expect(contract.status).toBe('draft');
        expect(contract.name).toBe('Test Contract');
        expect(contract.value).toBe(50000);
      });

      it('should set default values', async () => {
        const contract = await service.createContract({
          name: 'Minimal Contract',
          description: 'Minimal fields',
          type: 'nda',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'vendor', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'N/A',
            terminationClause: '30 days',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'NY',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 0,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        expect(contract.currency).toBe('USD');
        expect(contract.autoRenew).toBe(false);
        expect(contract.renewalTermMonths).toBe(12);
        expect(contract.tags).toEqual([]);
        expect(contract.customFields).toEqual({});
      });
    });

    describe('updateContract', () => {
      it('should update contract fields', async () => {
        // Deterministic: demo seed always contains a draft contract (Vendor NDA).
        const contracts = await service.getContracts({ status: 'draft' });
        expect(contracts.contracts.length).toBeGreaterThan(0);
        const contract = contracts.contracts[0];
        const updated = await service.updateContract(contract.id, {
          name: 'Updated Contract Name',
          value: 100000,
        });

        expect(updated).not.toBeNull();
        expect(updated!.name).toBe('Updated Contract Name');
        expect(updated!.value).toBe(100000);
      });

      it('should update terms partially', async () => {
        const created = await service.createContract({
          name: 'Terms Test Contract',
          description: 'Testing terms update',
          type: 'service',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'customer', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'Net 30',
            terminationClause: '30 days',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'Delaware',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 50000,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        const updated = await service.updateContract(created.id, {
          terms: { paymentTerms: 'Net 60' },
        });

        expect(updated!.terms.paymentTerms).toBe('Net 60');
        expect(updated!.terms.governingLaw).toBe('Delaware'); // Unchanged
      });

      it('should return null for non-existent', async () => {
        const result = await service.updateContract('NON-EXISTENT', { name: 'Test' });
        expect(result).toBeNull();
      });
    });
  });

  describe('Contract Workflow', () => {
    describe('submitForReview', () => {
      it('should submit draft contract for review', async () => {
        const created = await service.createContract({
          name: 'Review Test Contract',
          description: 'Testing review submission',
          type: 'sales',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'customer', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'Net 30',
            terminationClause: '30 days',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'Delaware',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 50000,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        const submitted = await service.submitForReview(created.id, 'submitter');
        expect(submitted).not.toBeNull();
        expect(submitted!.status).toBe('pending_review');
      });

      it('should return null for non-draft contracts', async () => {
        // Deterministic: demo seed always contains active contracts.
        const contracts = await service.getContracts({ status: 'active' });
        expect(contracts.contracts.length).toBeGreaterThan(0);
        const result = await service.submitForReview(contracts.contracts[0].id, 'submitter');
        expect(result).toBeNull();
      });

      it('should return null for non-existent contract', async () => {
        const result = await service.submitForReview('NON-EXISTENT', 'submitter');
        expect(result).toBeNull();
      });
    });

    describe('requestApproval', () => {
      it('should request approval from approvers', async () => {
        const created = await service.createContract({
          name: 'Approval Test Contract',
          description: 'Testing approval request',
          type: 'sales',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'customer', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'Net 30',
            terminationClause: '30 days',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'Delaware',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 50000,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        await service.submitForReview(created.id, 'submitter');

        const approved = await service.requestApproval(created.id, [
          { approverId: 'APR-001', approverName: 'Legal Approver', approverRole: 'Legal' },
          { approverId: 'APR-002', approverName: 'Finance Approver', approverRole: 'Finance' },
        ]);

        expect(approved).not.toBeNull();
        expect(approved!.status).toBe('pending_approval');
        expect(approved!.approvals.length).toBe(2);
        expect(approved!.approvals[0].status).toBe('pending');
        expect(approved!.approvals[1].status).toBe('pending');
      });

      it('should return null for non-pending_review contracts', async () => {
        // Deterministic: demo seed always contains a draft contract.
        const contracts = await service.getContracts({ status: 'draft' });
        expect(contracts.contracts.length).toBeGreaterThan(0);
        const result = await service.requestApproval(contracts.contracts[0].id, [
          { approverId: 'APR-001', approverName: 'Approver', approverRole: 'Legal' },
        ]);
        expect(result).toBeNull();
      });
    });

    describe('processApproval', () => {
      it('should approve a pending approval', async () => {
        const created = await service.createContract({
          name: 'Process Approval Test',
          description: 'Testing approval processing',
          type: 'vendor',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'vendor', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'Net 30',
            terminationClause: '30 days',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'Delaware',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 75000,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        await service.submitForReview(created.id, 'submitter');
        const withApprovers = await service.requestApproval(created.id, [
          { approverId: 'APR-001', approverName: 'Legal Approver', approverRole: 'Legal' },
        ]);

        const approvalId = withApprovers!.approvals[0].id;
        const processed = await service.processApproval(created.id, approvalId, {
          approved: true,
          comments: 'Looks good',
        });

        expect(processed).not.toBeNull();
        expect(processed!.approvals[0].status).toBe('approved');
        expect(processed!.approvals[0].comments).toBe('Looks good');
        expect(processed!.status).toBe('pending_signature');
      });

      it('should reject and return to draft', async () => {
        const created = await service.createContract({
          name: 'Rejection Test',
          description: 'Testing rejection',
          type: 'nda',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'partner', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'N/A',
            terminationClause: '30 days',
            confidentialityClause: true,
            nonCompeteClause: true,
            governingLaw: 'NY',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 0,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        await service.submitForReview(created.id, 'submitter');
        const withApprovers = await service.requestApproval(created.id, [
          { approverId: 'APR-001', approverName: 'Legal', approverRole: 'Legal' },
        ]);

        const approvalId = withApprovers!.approvals[0].id;
        const rejected = await service.processApproval(created.id, approvalId, {
          approved: false,
          comments: 'Needs revision',
        });

        expect(rejected!.approvals[0].status).toBe('rejected');
        expect(rejected!.status).toBe('draft');
      });

      it('should return null for invalid approval ID', async () => {
        const contracts = await service.getContracts();
        const result = await service.processApproval(contracts.contracts[0].id, 'INVALID-APR', {
          approved: true,
        });
        expect(result).toBeNull();
      });
    });

    describe('signContract', () => {
      it('should sign contract by party A', async () => {
        const created = await service.createContract({
          name: 'Signature Test A',
          description: 'Testing party A signature',
          type: 'service',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'customer', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'Net 30',
            terminationClause: '30 days',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'Delaware',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 50000,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        await service.submitForReview(created.id, 'submitter');
        const withApprovers = await service.requestApproval(created.id, [
          { approverId: 'APR-001', approverName: 'Legal', approverRole: 'Legal' },
        ]);
        await service.processApproval(created.id, withApprovers!.approvals[0].id, { approved: true });

        const signed = await service.signContract(created.id, { signedBy: 'CEO', party: 'A' });

        expect(signed).not.toBeNull();
        expect(signed!.signedByPartyA).toBe('CEO');
        expect(signed!.status).toBe('pending_signature'); // Still waiting for party B
      });

      it('should activate contract when both parties sign', async () => {
        const created = await service.createContract({
          name: 'Full Signature Test',
          description: 'Testing both signatures',
          type: 'partnership',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'partner', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'Revenue share',
            terminationClause: '90 days',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'California',
            disputeResolution: 'Mediation',
            customClauses: [],
          },
          value: 100000,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        await service.submitForReview(created.id, 'submitter');
        const withApprovers = await service.requestApproval(created.id, [
          { approverId: 'APR-001', approverName: 'Legal', approverRole: 'Legal' },
        ]);
        await service.processApproval(created.id, withApprovers!.approvals[0].id, { approved: true });

        await service.signContract(created.id, { signedBy: 'CEO', party: 'A' });
        const fullyExecuted = await service.signContract(created.id, { signedBy: 'Partner CEO', party: 'B' });

        expect(fullyExecuted!.status).toBe('active');
        expect(fullyExecuted!.signedByPartyA).toBe('CEO');
        expect(fullyExecuted!.signedByPartyB).toBe('Partner CEO');
        expect(fullyExecuted!.signedAt).not.toBeNull();
      });

      it('should return null for non-pending_signature contracts', async () => {
        // Deterministic: demo seed always contains a draft contract.
        const contracts = await service.getContracts({ status: 'draft' });
        expect(contracts.contracts.length).toBeGreaterThan(0);
        const result = await service.signContract(contracts.contracts[0].id, { signedBy: 'Test', party: 'A' });
        expect(result).toBeNull();
      });
    });

    describe('renewContract', () => {
      it('should renew an active contract', async () => {
        // Deterministic: demo seed always contains active contracts.
        const contracts = await service.getContracts({ status: 'active' });
        expect(contracts.contracts.length).toBeGreaterThan(0);
        const original = contracts.contracts[0];
        const newEndDate = new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString();

        const renewed = await service.renewContract(original.id, {
          newEndDate,
          newValue: 150000,
          renewedBy: 'renewal-user',
        });

        expect(renewed).not.toBeNull();
        expect(renewed!.status).toBe('draft'); // New contract starts as draft
        expect(renewed!.value).toBe(150000);
        expect(renewed!.tags).toContain('renewal');

        // Original should be marked as renewed
        const originalAfter = await service.getContract(original.id);
        expect(originalAfter!.status).toBe('renewed');
      });

      it('should return null for non-active contracts', async () => {
        // Deterministic: demo seed always contains a draft contract.
        const contracts = await service.getContracts({ status: 'draft' });
        expect(contracts.contracts.length).toBeGreaterThan(0);
        const result = await service.renewContract(contracts.contracts[0].id, {
          newEndDate: new Date().toISOString(),
          renewedBy: 'test',
        });
        expect(result).toBeNull();
      });
    });

    describe('terminateContract', () => {
      it('should terminate an active contract', async () => {
        // First create and activate a contract
        const created = await service.createContract({
          name: 'Termination Test',
          description: 'Testing termination',
          type: 'service',
          partyA: { id: 'PA-001', name: 'Party A', type: 'internal', contactName: 'Contact A', contactEmail: 'a@test.com' },
          partyB: { id: 'PB-001', name: 'Party B', type: 'customer', contactName: 'Contact B', contactEmail: 'b@test.com' },
          terms: {
            paymentTerms: 'Net 30',
            terminationClause: '30 days',
            confidentialityClause: true,
            nonCompeteClause: false,
            governingLaw: 'Delaware',
            disputeResolution: 'Arbitration',
            customClauses: [],
          },
          value: 50000,
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          createdBy: 'test-user',
        });

        await service.submitForReview(created.id, 'submitter');
        const withApprovers = await service.requestApproval(created.id, [
          { approverId: 'APR-001', approverName: 'Legal', approverRole: 'Legal' },
        ]);
        await service.processApproval(created.id, withApprovers!.approvals[0].id, { approved: true });
        await service.signContract(created.id, { signedBy: 'CEO', party: 'A' });
        await service.signContract(created.id, { signedBy: 'Customer', party: 'B' });

        const terminated = await service.terminateContract(created.id, {
          reason: 'Breach of contract',
          terminatedBy: 'legal-team',
        });

        expect(terminated).not.toBeNull();
        expect(terminated!.status).toBe('terminated');
        expect(terminated!.amendments.length).toBeGreaterThan(0);
        expect(terminated!.amendments[terminated!.amendments.length - 1].description).toContain('terminated');
      });

      it('should return null for non-active contracts', async () => {
        // Deterministic: demo seed always contains a draft contract.
        const contracts = await service.getContracts({ status: 'draft' });
        expect(contracts.contracts.length).toBeGreaterThan(0);
        const result = await service.terminateContract(contracts.contracts[0].id, {
          reason: 'Test',
          terminatedBy: 'test',
        });
        expect(result).toBeNull();
      });
    });
  });

  describe('Expiring Contracts & Actions', () => {
    describe('getExpiringContracts', () => {
      it('should return contracts expiring within specified days', async () => {
        const expiring = await service.getExpiringContracts(90);
        expect(Array.isArray(expiring)).toBe(true);
        expiring.forEach((c) => expect(c.status).toBe('active'));
      });
    });

    describe('getPendingActions', () => {
      it('should return pending actions', async () => {
        const actions = await service.getPendingActions();
        expect(Array.isArray(actions)).toBe(true);
        actions.forEach((a) => {
          expect(['pending', 'overdue']).toContain(a.status);
        });
      });
    });

    describe('createAction', () => {
      it('should create an action for a contract', async () => {
        const contracts = await service.getContracts();
        const action = await service.createAction(contracts.contracts[0].id, {
          action: 'Review terms',
          assignee: 'legal-team',
          dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });

        expect(action).not.toBeNull();
        expect(action!.id).toMatch(/^ACT-/);
        expect(action!.status).toBe('pending');
        expect(action!.action).toBe('Review terms');
      });

      it('should return null for non-existent contract', async () => {
        const action = await service.createAction('NON-EXISTENT', {
          action: 'Test',
          assignee: 'test',
          dueDate: new Date().toISOString(),
        });
        expect(action).toBeNull();
      });
    });

    describe('completeAction', () => {
      it('should complete an action', async () => {
        const contracts = await service.getContracts();
        const created = await service.createAction(contracts.contracts[0].id, {
          action: 'Complete this task',
          assignee: 'user',
          dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });

        const completed = await service.completeAction(created!.id);

        expect(completed).not.toBeNull();
        expect(completed!.status).toBe('completed');
        expect(completed!.completedAt).not.toBeNull();
      });

      it('should return null for non-existent action', async () => {
        const result = await service.completeAction('NON-EXISTENT');
        expect(result).toBeNull();
      });
    });

    describe('getRecentActivity', () => {
      it('should return recent activity logs', async () => {
        const activity = await service.getRecentActivity(10);
        expect(Array.isArray(activity)).toBe(true);
      });

      it('should respect limit parameter', async () => {
        const activity = await service.getRecentActivity(2);
        expect(activity.length).toBeLessThanOrEqual(2);
      });
    });
  });
});
