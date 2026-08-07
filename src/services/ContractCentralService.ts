/**
 * ContractCentralService - Contract Lifecycle Management
 *
 * Provides comprehensive contract management including:
 * - Contract CRUD operations
 * - Lifecycle management (draft, review, active, expired)
 * - Renewal tracking and automation
 * - Compliance monitoring
 * - Approval workflows
 * - Contract analytics
 *
 * @module services/ContractCentralService
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from 'pino';

// ============================================================================
// Interfaces
// ============================================================================

export interface Contract {
  id: string;
  contractNumber: string;
  name: string;
  description: string;
  type: 'sales' | 'vendor' | 'service' | 'nda' | 'partnership' | 'employment';
  status: 'draft' | 'pending_review' | 'pending_approval' | 'pending_signature' | 'active' | 'expired' | 'terminated' | 'renewed';
  partyA: ContractParty;
  partyB: ContractParty;
  terms: ContractTerms;
  value: number;
  currency: string;
  startDate: string;
  endDate: string;
  autoRenew: boolean;
  renewalTermMonths: number;
  renewalNoticeDate: string | null;
  documents: ContractDocument[];
  approvals: ContractApproval[];
  amendments: ContractAmendment[];
  tags: string[];
  customFields: Record<string, string | number | boolean>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  signedAt: string | null;
  signedByPartyA: string | null;
  signedByPartyB: string | null;
}

export interface ContractParty {
  id: string;
  name: string;
  type: 'internal' | 'customer' | 'vendor' | 'partner';
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
}

export interface ContractTerms {
  paymentTerms: string;
  deliveryTerms?: string;
  warrantyTerms?: string;
  terminationClause: string;
  confidentialityClause: boolean;
  nonCompeteClause: boolean;
  liabilityLimit?: number;
  governingLaw: string;
  disputeResolution: string;
  customClauses: string[];
}

export interface ContractDocument {
  id: string;
  name: string;
  type: 'contract' | 'amendment' | 'attachment' | 'signature_page';
  url: string;
  version: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface ContractApproval {
  id: string;
  approverId: string;
  approverName: string;
  approverRole: string;
  status: 'pending' | 'approved' | 'rejected';
  comments?: string;
  requestedAt: string;
  respondedAt?: string;
}

export interface ContractAmendment {
  id: string;
  description: string;
  changes: string;
  effectiveDate: string;
  approvedBy: string;
  approvedAt: string;
  documentUrl?: string;
}

export interface ContractAction {
  id: string;
  contractId: string;
  contractName: string;
  action: string;
  assignee: string;
  dueDate: string;
  status: 'pending' | 'completed' | 'overdue';
  createdAt: string;
  completedAt?: string;
}

export interface ContractActivityLog {
  id: string;
  contractId: string;
  contractName: string;
  action: string;
  userId: string;
  userName: string;
  details?: string;
  timestamp: string;
}

export interface ContractsByType {
  type: string;
  count: number;
  value: number;
}

export interface ContractMetrics {
  totalContracts: number;
  activeContracts: number;
  expiredContracts: number;
  draftContracts: number;
  avgContractValue: number;
  totalContractValue: number;
  renewalRate: number;
  avgNegotiationDays: number;
  complianceScore: number;
  expiringIn30Days: number;
  expiringIn60Days: number;
  expiringIn90Days: number;
}

export interface ContractCentralDashboard {
  summary: {
    activeContracts: number;
    expiringSoon: number;
    pendingRenewals: number;
    totalContractValue: number;
  };
  metrics: ContractMetrics;
  contractsByType: ContractsByType[];
  expiringContracts: Contract[];
  pendingActions: ContractAction[];
  recentActivity: ContractActivityLog[];
  lastUpdated: number;
}

export interface ContractCreateRequest {
  name: string;
  description: string;
  type: Contract['type'];
  partyA: ContractParty;
  partyB: ContractParty;
  terms: ContractTerms;
  value: number;
  currency?: string;
  startDate: string;
  endDate: string;
  autoRenew?: boolean;
  renewalTermMonths?: number;
  tags?: string[];
  customFields?: Record<string, string | number | boolean>;
  createdBy: string;
}

export interface ContractUpdateRequest {
  name?: string;
  description?: string;
  status?: Contract['status'];
  terms?: Partial<ContractTerms>;
  value?: number;
  startDate?: string;
  endDate?: string;
  autoRenew?: boolean;
  renewalTermMonths?: number;
  tags?: string[];
  customFields?: Record<string, string | number | boolean>;
}

// ============================================================================
// Service Implementation
// ============================================================================

@injectable()
export class ContractCentralService {
  private contracts = new Map<string, Contract>();
  private actions = new Map<string, ContractAction>();
  private activityLogs = new Map<string, ContractActivityLog>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('ContractCentralService initialized');
    this.initializeDemoData();
  }

  // ==========================================================================
  // Dashboard & Metrics
  // ==========================================================================

  /**
   * Get comprehensive contract dashboard data
   */
  public async getDashboard(): Promise<ContractCentralDashboard> {
    this.logger.info('Fetching contract central dashboard');

    const metrics = await this.getMetrics();
    const contractsByType = await this.getContractsByType();
    const expiringContracts = await this.getExpiringContracts(30);
    const pendingActions = await this.getPendingActions();
    const recentActivity = await this.getRecentActivity(10);

    const pendingRenewals = Array.from(this.contracts.values())
      .filter((c) => c.status === 'active' && c.autoRenew && this.isExpiringSoon(c, 60))
      .length;

    return {
      summary: {
        activeContracts: metrics.activeContracts,
        expiringSoon: metrics.expiringIn30Days,
        pendingRenewals,
        totalContractValue: metrics.totalContractValue,
      },
      metrics,
      contractsByType,
      expiringContracts,
      pendingActions,
      recentActivity,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get contract metrics
   */
  public async getMetrics(): Promise<ContractMetrics> {
    const contracts = Array.from(this.contracts.values());

    const activeContracts = contracts.filter((c) => c.status === 'active').length;
    const expiredContracts = contracts.filter((c) => c.status === 'expired').length;
    const draftContracts = contracts.filter((c) => c.status === 'draft').length;

    const activeContractValues = contracts
      .filter((c) => c.status === 'active')
      .map((c) => c.value);
    const totalContractValue = activeContractValues.reduce((sum, v) => sum + v, 0);
    const avgContractValue = activeContractValues.length > 0
      ? totalContractValue / activeContractValues.length
      : 0;

    // Renewal rate (contracts renewed vs expired in last year)
    const renewedContracts = contracts.filter((c) => c.status === 'renewed').length;
    const totalEndedContracts = renewedContracts + expiredContracts;
    const renewalRate = totalEndedContracts > 0
      ? Math.round((renewedContracts / totalEndedContracts) * 1000) / 10
      : 100;

    // Average negotiation time (draft to active)
    const completedContracts = contracts.filter((c) => c.signedAt && c.status === 'active');
    const totalDays = completedContracts.reduce((sum, c) => {
      const created = new Date(c.createdAt).getTime();
      const signed = new Date(c.signedAt!).getTime();
      return sum + (signed - created) / (1000 * 60 * 60 * 24);
    }, 0);
    const avgNegotiationDays = completedContracts.length > 0
      ? Math.round((totalDays / completedContracts.length) * 10) / 10
      : 0;

    // Compliance score (contracts with all required approvals)
    const contractsRequiringApproval = contracts.filter(
      (c) => c.approvals.length > 0 && c.status === 'active'
    );
    const compliantContracts = contractsRequiringApproval.filter((c) =>
      c.approvals.every((a) => a.status === 'approved')
    );
    const complianceScore = contractsRequiringApproval.length > 0
      ? Math.round((compliantContracts.length / contractsRequiringApproval.length) * 1000) / 10
      : 100;

    const expiringIn30Days = this.countExpiringContracts(30);
    const expiringIn60Days = this.countExpiringContracts(60);
    const expiringIn90Days = this.countExpiringContracts(90);

    return {
      totalContracts: contracts.length,
      activeContracts,
      expiredContracts,
      draftContracts,
      avgContractValue: Math.round(avgContractValue * 100) / 100,
      totalContractValue: Math.round(totalContractValue * 100) / 100,
      renewalRate,
      avgNegotiationDays,
      complianceScore,
      expiringIn30Days,
      expiringIn60Days,
      expiringIn90Days,
    };
  }

  /**
   * Get contracts grouped by type
   */
  public async getContractsByType(): Promise<ContractsByType[]> {
    const contracts = Array.from(this.contracts.values());
    const types: Contract['type'][] = ['sales', 'vendor', 'service', 'nda', 'partnership', 'employment'];

    return types.map((type) => {
      const typeContracts = contracts.filter((c) => c.type === type && c.status === 'active');
      return {
        type,
        count: typeContracts.length,
        value: typeContracts.reduce((sum, c) => sum + c.value, 0),
      };
    }).filter((t) => t.count > 0);
  }

  // ==========================================================================
  // Contract CRUD Operations
  // ==========================================================================

  /**
   * Get all contracts with optional filtering
   */
  public async getContracts(filters?: {
    type?: Contract['type'];
    status?: Contract['status'];
    partyId?: string;
    expiringSoon?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ contracts: Contract[]; total: number }> {
    let contracts = Array.from(this.contracts.values());

    if (filters?.type) {
      contracts = contracts.filter((c) => c.type === filters.type);
    }
    if (filters?.status) {
      contracts = contracts.filter((c) => c.status === filters.status);
    }
    if (filters?.partyId) {
      contracts = contracts.filter(
        (c) => c.partyA.id === filters.partyId || c.partyB.id === filters.partyId
      );
    }
    if (filters?.expiringSoon) {
      contracts = contracts.filter((c) => this.isExpiringSoon(c, 90));
    }
    if (filters?.search) {
      const search = filters.search.toLowerCase();
      contracts = contracts.filter(
        (c) =>
          c.name.toLowerCase().includes(search) ||
          c.contractNumber.toLowerCase().includes(search) ||
          c.partyA.name.toLowerCase().includes(search) ||
          c.partyB.name.toLowerCase().includes(search)
      );
    }

    // Sort by end date (expiring soonest first for active)
    contracts.sort((a, b) => {
      if (a.status === 'active' && b.status === 'active') {
        return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const total = contracts.length;
    const offset = filters?.offset || 0;
    const limit = filters?.limit || 50;

    return {
      contracts: contracts.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Get contract by ID
   */
  public async getContract(id: string): Promise<Contract | null> {
    return this.contracts.get(id) || null;
  }

  /**
   * Get contract by contract number
   */
  public async getContractByNumber(contractNumber: string): Promise<Contract | null> {
    return Array.from(this.contracts.values()).find(
      (c) => c.contractNumber === contractNumber
    ) || null;
  }

  /**
   * Create a new contract
   */
  public async createContract(request: ContractCreateRequest): Promise<Contract> {
    const id = `CTR-${Date.now()}`;
    const now = new Date().toISOString();
    const contractNumber = `CTR-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

    // Calculate renewal notice date (30 days before end)
    const endDate = new Date(request.endDate);
    const renewalNoticeDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const contract: Contract = {
      id,
      contractNumber,
      name: request.name,
      description: request.description,
      type: request.type,
      status: 'draft',
      partyA: request.partyA,
      partyB: request.partyB,
      terms: request.terms,
      value: request.value,
      currency: request.currency || 'USD',
      startDate: request.startDate,
      endDate: request.endDate,
      autoRenew: request.autoRenew || false,
      renewalTermMonths: request.renewalTermMonths || 12,
      renewalNoticeDate,
      documents: [],
      approvals: [],
      amendments: [],
      tags: request.tags || [],
      customFields: request.customFields || {},
      createdBy: request.createdBy,
      createdAt: now,
      updatedAt: now,
      signedAt: null,
      signedByPartyA: null,
      signedByPartyB: null,
    };

    this.contracts.set(id, contract);
    this.logActivity(id, contract.name, 'Created', request.createdBy, 'System');

    this.logger.info({ contractId: id }, 'Created contract');

    return contract;
  }

  /**
   * Update a contract
   */
  public async updateContract(id: string, updates: ContractUpdateRequest): Promise<Contract | null> {
    const contract = this.contracts.get(id);
    if (!contract) {
      return null;
    }

    const now = new Date().toISOString();

    if (updates.name !== undefined) contract.name = updates.name;
    if (updates.description !== undefined) contract.description = updates.description;
    if (updates.status !== undefined) contract.status = updates.status;
    if (updates.value !== undefined) contract.value = updates.value;
    if (updates.startDate !== undefined) contract.startDate = updates.startDate;
    if (updates.endDate !== undefined) {
      contract.endDate = updates.endDate;
      const endDate = new Date(updates.endDate);
      contract.renewalNoticeDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }
    if (updates.autoRenew !== undefined) contract.autoRenew = updates.autoRenew;
    if (updates.renewalTermMonths !== undefined) contract.renewalTermMonths = updates.renewalTermMonths;
    if (updates.tags !== undefined) contract.tags = updates.tags;
    if (updates.terms !== undefined) {
      contract.terms = { ...contract.terms, ...updates.terms };
    }
    if (updates.customFields !== undefined) {
      contract.customFields = { ...contract.customFields, ...updates.customFields };
    }

    contract.updatedAt = now;

    this.contracts.set(id, contract);
    this.logger.info({ contractId: id }, 'Updated contract');

    return contract;
  }

  /**
   * Submit contract for review
   */
  public async submitForReview(id: string, submittedBy: string): Promise<Contract | null> {
    const contract = this.contracts.get(id);
    if (!contract || contract.status !== 'draft') {
      return null;
    }

    contract.status = 'pending_review';
    contract.updatedAt = new Date().toISOString();

    this.contracts.set(id, contract);
    this.logActivity(id, contract.name, 'Submitted for Review', submittedBy, 'System');

    return contract;
  }

  /**
   * Request approval for a contract
   */
  public async requestApproval(
    id: string,
    approvers: { approverId: string; approverName: string; approverRole: string }[]
  ): Promise<Contract | null> {
    const contract = this.contracts.get(id);
    if (!contract || contract.status !== 'pending_review') {
      return null;
    }

    const now = new Date().toISOString();

    approvers.forEach((approver) => {
      const approvalId = `APR-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 4)}`;
      contract.approvals.push({
        id: approvalId,
        approverId: approver.approverId,
        approverName: approver.approverName,
        approverRole: approver.approverRole,
        status: 'pending',
        requestedAt: now,
      });
    });

    contract.status = 'pending_approval';
    contract.updatedAt = now;

    this.contracts.set(id, contract);
    this.logActivity(id, contract.name, 'Approval Requested', 'System', 'System');

    return contract;
  }

  /**
   * Approve or reject a contract
   */
  public async processApproval(
    contractId: string,
    approvalId: string,
    decision: { approved: boolean; comments?: string }
  ): Promise<Contract | null> {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      return null;
    }

    const approval = contract.approvals.find((a) => a.id === approvalId);
    if (!approval || approval.status !== 'pending') {
      return null;
    }

    const now = new Date().toISOString();
    approval.status = decision.approved ? 'approved' : 'rejected';
    approval.comments = decision.comments;
    approval.respondedAt = now;

    // Check if all approvals are done
    const allApproved = contract.approvals.every((a) => a.status === 'approved');
    const anyRejected = contract.approvals.some((a) => a.status === 'rejected');

    if (allApproved) {
      contract.status = 'pending_signature';
    } else if (anyRejected) {
      contract.status = 'draft'; // Return to draft for revision
    }

    contract.updatedAt = now;

    this.contracts.set(contractId, contract);
    this.logActivity(contractId, contract.name, decision.approved ? 'Approved' : 'Rejected', approval.approverName, approval.approverName);

    return contract;
  }

  /**
   * Sign a contract
   */
  public async signContract(
    id: string,
    signature: { signedBy: string; party: 'A' | 'B' }
  ): Promise<Contract | null> {
    const contract = this.contracts.get(id);
    if (!contract || contract.status !== 'pending_signature') {
      return null;
    }

    const now = new Date().toISOString();

    if (signature.party === 'A') {
      contract.signedByPartyA = signature.signedBy;
    } else {
      contract.signedByPartyB = signature.signedBy;
    }

    // Check if both parties have signed
    if (contract.signedByPartyA && contract.signedByPartyB) {
      contract.status = 'active';
      contract.signedAt = now;
    }

    contract.updatedAt = now;

    this.contracts.set(id, contract);
    this.logActivity(id, contract.name, 'Signed', signature.signedBy, signature.signedBy);

    return contract;
  }

  /**
   * Renew a contract
   */
  public async renewContract(
    id: string,
    renewalData: { newEndDate: string; newValue?: number; renewedBy: string }
  ): Promise<Contract | null> {
    const contract = this.contracts.get(id);
    if (!contract || contract.status !== 'active') {
      return null;
    }

    const now = new Date().toISOString();

    // Mark old contract as renewed
    contract.status = 'renewed';
    contract.updatedAt = now;
    this.contracts.set(id, contract);

    // Create new contract as renewal
    const newContract = await this.createContract({
      name: contract.name,
      description: `Renewal of ${contract.contractNumber}`,
      type: contract.type,
      partyA: contract.partyA,
      partyB: contract.partyB,
      terms: contract.terms,
      value: renewalData.newValue || contract.value,
      currency: contract.currency,
      startDate: contract.endDate,
      endDate: renewalData.newEndDate,
      autoRenew: contract.autoRenew,
      renewalTermMonths: contract.renewalTermMonths,
      tags: [...contract.tags, 'renewal'],
      customFields: { ...contract.customFields, previousContractId: id },
      createdBy: renewalData.renewedBy,
    });

    this.logActivity(id, contract.name, 'Renewed', renewalData.renewedBy, renewalData.renewedBy);

    return newContract;
  }

  /**
   * Terminate a contract
   */
  public async terminateContract(
    id: string,
    termination: { reason: string; terminatedBy: string; effectiveDate?: string }
  ): Promise<Contract | null> {
    const contract = this.contracts.get(id);
    if (!contract || contract.status !== 'active') {
      return null;
    }

    const now = new Date().toISOString();
    contract.status = 'terminated';
    contract.endDate = termination.effectiveDate || now;
    contract.updatedAt = now;

    // Add amendment for termination
    contract.amendments.push({
      id: `AMD-${Date.now()}`,
      description: `Contract terminated: ${termination.reason}`,
      changes: 'Status changed to terminated',
      effectiveDate: termination.effectiveDate || now,
      approvedBy: termination.terminatedBy,
      approvedAt: now,
    });

    this.contracts.set(id, contract);
    this.logActivity(id, contract.name, 'Terminated', termination.terminatedBy, termination.terminatedBy);

    return contract;
  }

  // ==========================================================================
  // Expiring Contracts & Actions
  // ==========================================================================

  /**
   * Get contracts expiring within specified days
   */
  public async getExpiringContracts(days: number): Promise<Contract[]> {
    const now = new Date();
    const threshold = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    return Array.from(this.contracts.values())
      .filter((c) => c.status === 'active' && new Date(c.endDate) <= threshold)
      .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
  }

  /**
   * Get pending actions
   */
  public async getPendingActions(): Promise<ContractAction[]> {
    return Array.from(this.actions.values())
      .filter((a) => a.status === 'pending' || a.status === 'overdue')
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  }

  /**
   * Create an action for a contract
   */
  public async createAction(
    contractId: string,
    action: { action: string; assignee: string; dueDate: string }
  ): Promise<ContractAction | null> {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      return null;
    }

    const id = `ACT-${Date.now()}`;
    const now = new Date().toISOString();

    const contractAction: ContractAction = {
      id,
      contractId,
      contractName: contract.name,
      action: action.action,
      assignee: action.assignee,
      dueDate: action.dueDate,
      status: 'pending',
      createdAt: now,
    };

    this.actions.set(id, contractAction);

    return contractAction;
  }

  /**
   * Complete an action
   */
  public async completeAction(actionId: string): Promise<ContractAction | null> {
    const action = this.actions.get(actionId);
    if (!action) {
      return null;
    }

    action.status = 'completed';
    action.completedAt = new Date().toISOString();

    this.actions.set(actionId, action);

    return action;
  }

  // ==========================================================================
  // Activity Logging
  // ==========================================================================

  /**
   * Get recent activity
   */
  public async getRecentActivity(limit = 10): Promise<ContractActivityLog[]> {
    return Array.from(this.activityLogs.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private isExpiringSoon(contract: Contract, days: number): boolean {
    if (contract.status !== 'active') return false;
    const now = new Date();
    const threshold = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return new Date(contract.endDate) <= threshold;
  }

  private countExpiringContracts(days: number): number {
    return Array.from(this.contracts.values())
      .filter((c) => this.isExpiringSoon(c, days))
      .length;
  }

  private logActivity(
    contractId: string,
    contractName: string,
    action: string,
    userId: string,
    userName: string,
    details?: string
  ): void {
    const id = `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 4)}`;
    this.activityLogs.set(id, {
      id,
      contractId,
      contractName,
      action,
      userId,
      userName,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  // ==========================================================================
  // Demo Data Initialization
  // ==========================================================================

  private initializeDemoData(): void {
    const now = new Date();

    const demoContracts: Omit<Contract, 'id' | 'createdAt' | 'updatedAt'>[] = [
      {
        contractNumber: 'CTR-2024-892',
        name: 'Enterprise Support Agreement',
        description: 'Annual enterprise support and maintenance',
        type: 'service',
        status: 'active',
        partyA: { id: 'INTERNAL', name: 'Our Company', type: 'internal', contactName: 'Legal Team', contactEmail: 'legal@company.com' },
        partyB: { id: 'CUST-001', name: 'Acme Corp', type: 'customer', contactName: 'John Smith', contactEmail: 'john@acme.com' },
        terms: {
          paymentTerms: 'Net 30',
          terminationClause: '30 days notice',
          confidentialityClause: true,
          nonCompeteClause: false,
          governingLaw: 'Delaware',
          disputeResolution: 'Arbitration',
          customClauses: [],
        },
        value: 125000,
        currency: 'USD',
        startDate: new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date(now.getTime() + 27 * 24 * 60 * 60 * 1000).toISOString(),
        autoRenew: true,
        renewalTermMonths: 12,
        renewalNoticeDate: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        documents: [],
        approvals: [{ id: 'APR-001', approverId: 'USR-001', approverName: 'Jane Legal', approverRole: 'Legal', status: 'approved', requestedAt: now.toISOString(), respondedAt: now.toISOString() }],
        amendments: [],
        tags: ['enterprise', 'support'],
        customFields: {},
        createdBy: 'system',
        signedAt: new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000).toISOString(),
        signedByPartyA: 'CEO',
        signedByPartyB: 'John Smith',
      },
      {
        contractNumber: 'CTR-2024-756',
        name: 'Software License Agreement',
        description: 'Annual software license',
        type: 'sales',
        status: 'active',
        partyA: { id: 'INTERNAL', name: 'Our Company', type: 'internal', contactName: 'Sales Team', contactEmail: 'sales@company.com' },
        partyB: { id: 'CUST-002', name: 'Tech Solutions', type: 'customer', contactName: 'Sarah Lee', contactEmail: 'sarah@techsolutions.com' },
        terms: {
          paymentTerms: 'Net 45',
          terminationClause: '60 days notice',
          confidentialityClause: true,
          nonCompeteClause: false,
          governingLaw: 'California',
          disputeResolution: 'Mediation',
          customClauses: [],
        },
        value: 45000,
        currency: 'USD',
        startDate: new Date(now.getTime() - 270 * 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date(now.getTime() + 40 * 24 * 60 * 60 * 1000).toISOString(),
        autoRenew: false,
        renewalTermMonths: 12,
        renewalNoticeDate: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        documents: [],
        approvals: [],
        amendments: [],
        tags: ['software', 'license'],
        customFields: {},
        createdBy: 'system',
        signedAt: new Date(now.getTime() - 270 * 24 * 60 * 60 * 1000).toISOString(),
        signedByPartyA: 'Sales Director',
        signedByPartyB: 'Sarah Lee',
      },
      {
        contractNumber: 'CTR-2024-623',
        name: 'Maintenance Contract',
        description: 'Equipment maintenance services',
        type: 'service',
        status: 'active',
        partyA: { id: 'INTERNAL', name: 'Our Company', type: 'internal', contactName: 'Operations', contactEmail: 'ops@company.com' },
        partyB: { id: 'CUST-003', name: 'Manufacturing Inc', type: 'customer', contactName: 'Mike Johnson', contactEmail: 'mike@manufacturing.com' },
        terms: {
          paymentTerms: 'Net 30',
          terminationClause: '90 days notice',
          confidentialityClause: false,
          nonCompeteClause: false,
          governingLaw: 'Texas',
          disputeResolution: 'Litigation',
          customClauses: [],
        },
        value: 78000,
        currency: 'USD',
        startDate: new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date(now.getTime() + 50 * 24 * 60 * 60 * 1000).toISOString(),
        autoRenew: true,
        renewalTermMonths: 12,
        renewalNoticeDate: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString(),
        documents: [],
        approvals: [],
        amendments: [],
        tags: ['maintenance'],
        customFields: {},
        createdBy: 'system',
        signedAt: new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString(),
        signedByPartyA: 'COO',
        signedByPartyB: 'Mike Johnson',
      },
      {
        contractNumber: 'CTR-2025-001',
        name: 'Vendor NDA',
        description: 'Non-disclosure agreement with vendor',
        type: 'nda',
        status: 'draft',
        partyA: { id: 'INTERNAL', name: 'Our Company', type: 'internal', contactName: 'Procurement', contactEmail: 'procurement@company.com' },
        partyB: { id: 'VEN-001', name: 'Supplier Co', type: 'vendor', contactName: 'Vendor Rep', contactEmail: 'rep@supplier.com' },
        terms: {
          paymentTerms: 'N/A',
          terminationClause: '30 days notice',
          confidentialityClause: true,
          nonCompeteClause: true,
          governingLaw: 'New York',
          disputeResolution: 'Arbitration',
          customClauses: ['2-year confidentiality period'],
        },
        value: 0,
        currency: 'USD',
        startDate: new Date().toISOString(),
        endDate: new Date(now.getTime() + 730 * 24 * 60 * 60 * 1000).toISOString(),
        autoRenew: false,
        renewalTermMonths: 0,
        renewalNoticeDate: null,
        documents: [],
        approvals: [],
        amendments: [],
        tags: ['nda', 'vendor'],
        customFields: {},
        createdBy: 'system',
        signedAt: null,
        signedByPartyA: null,
        signedByPartyB: null,
      },
    ];

    demoContracts.forEach((contract, index) => {
      const id = `CTR-${1000 + index}`;
      const createdAt = new Date(now.getTime() - (365 - index * 30) * 24 * 60 * 60 * 1000).toISOString();
      this.contracts.set(id, {
        id,
        ...contract,
        createdAt,
        updatedAt: new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString(),
      } as Contract);
    });

    // Create demo actions
    const actions: ContractAction[] = [
      { id: 'ACT-001', contractId: 'CTR-1000', contractName: 'Enterprise Support Agreement', action: 'Renewal Negotiation', assignee: 'Sales Team', dueDate: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(), status: 'pending', createdAt: now.toISOString() },
      { id: 'ACT-002', contractId: 'CTR-1003', contractName: 'Vendor NDA', action: 'Signature Required', assignee: 'Legal', dueDate: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(), status: 'pending', createdAt: now.toISOString() },
    ];
    actions.forEach((a) => this.actions.set(a.id, a));

    // Create demo activity logs
    this.logActivity('CTR-1000', 'Enterprise Support Agreement', 'Reviewed', 'USR-001', 'John Smith');
    this.logActivity('CTR-1001', 'Software License Agreement', 'Renewed', 'USR-002', 'Jane Doe');
    this.logActivity('CTR-1003', 'Vendor NDA', 'Created', 'USR-003', 'Mike Johnson');

    this.logger.info(
      {
        contracts: this.contracts.size,
        actions: this.actions.size,
        activityLogs: this.activityLogs.size,
      },
      'ContractCentralService demo data initialized'
    );
  }
}
