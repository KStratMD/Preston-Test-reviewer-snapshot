import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { FinanceCentralOperatorService } from './financeCentral/FinanceCentralOperatorService';
import type { PendingApprovalView } from './financeCentral/types';

/**
 * GL Account structure
 */
export interface GLAccount {
  id: string;
  accountNumber: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subType: string;
  balance: number;
  currency: string;
  isActive: boolean;
  parentAccountId?: string;
  description?: string;
  netSuiteId?: string;
  lastUpdated: number;
}

/**
 * Invoice/Bill for AR/AP tracking
 */
export interface FinancialDocument {
  id: string;
  type: 'invoice' | 'bill' | 'credit_memo' | 'debit_memo';
  documentNumber: string;
  entityId: string;
  entityName: string;
  entityType: 'customer' | 'vendor';
  amount: number;
  amountPaid: number;
  amountDue: number;
  currency: string;
  issueDate: number;
  dueDate: number;
  status: 'open' | 'partial' | 'paid' | 'overdue' | 'voided' | 'disputed';
  glAccountId: string;
  terms: string;
  netSuiteId?: string;
  lineItems: DocumentLineItem[];
}

/**
 * Line item for financial documents
 */
export interface DocumentLineItem {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  glAccountId: string;
  department?: string;
  class?: string;
  location?: string;
}

/**
 * Aging bucket structure
 */
export interface AgingBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  amount: number;
  count: number;
  percentage: number;
}

/**
 * AR/AP Aging report
 */
export interface AgingReport {
  type: 'ar' | 'ap';
  asOfDate: number;
  totalAmount: number;
  totalDocuments: number;
  buckets: AgingBucket[];
  byEntity: EntityAging[];
  currency: string;
  generatedAt: number;
}

/**
 * Entity-level aging
 */
export interface EntityAging {
  entityId: string;
  entityName: string;
  totalAmount: number;
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  oldestInvoiceDate: number;
  lastPaymentDate?: number;
  creditLimit?: number;
  creditUtilization?: number;
}

/**
 * Cash position summary
 */
export interface CashPosition {
  totalCash: number;
  bankAccounts: BankAccountBalance[];
  availableCredit: number;
  pendingReceipts: number;
  pendingPayments: number;
  netCashPosition: number;
  currency: string;
  asOfDate: number;
}

/**
 * Bank account balance
 */
export interface BankAccountBalance {
  accountId: string;
  accountName: string;
  bankName: string;
  accountType: 'checking' | 'savings' | 'money_market' | 'credit_line';
  balance: number;
  availableBalance: number;
  currency: string;
  lastUpdated: number;
  netSuiteId?: string;
}

/**
 * Cash flow forecast period
 */
export interface CashFlowPeriod {
  periodLabel: string;
  startDate: number;
  endDate: number;
  openingBalance: number;
  inflows: CashFlowCategory;
  outflows: CashFlowCategory;
  netCashFlow: number;
  closingBalance: number;
}

/**
 * Cash flow category breakdown
 */
export interface CashFlowCategory {
  total: number;
  breakdown: {
    category: string;
    amount: number;
    count: number;
  }[];
}

/**
 * Financial metrics summary
 */
export interface FinancialMetrics {
  revenue: number;
  expenses: number;
  netIncome: number;
  grossMargin: number;
  operatingMargin: number;
  netMargin: number;
  dso: number; // Days Sales Outstanding
  dpo: number; // Days Payable Outstanding
  currentRatio: number;
  quickRatio: number;
  debtToEquity: number;
  workingCapital: number;
  period: string;
  currency: string;
  calculatedAt: number;
}

/**
 * Entity for multi-entity consolidation
 */
export interface FinancialEntity {
  id: string;
  name: string;
  type: 'subsidiary' | 'division' | 'department';
  parentId?: string;
  currency: string;
  isElimination: boolean;
  netSuiteId?: string;
}

/**
 * Consolidated financial summary
 */
export interface ConsolidatedSummary {
  entities: FinancialEntity[];
  consolidatedCash: number;
  consolidatedAR: number;
  consolidatedAP: number;
  intercompanyEliminations: number;
  totalRevenue: number;
  totalExpenses: number;
  consolidatedNetIncome: number;
  currency: string;
  asOfDate: number;
}

/**
 * Period close status
 */
export interface PeriodCloseStatus {
  periodId: string;
  periodName: string;
  startDate: number;
  endDate: number;
  status: 'open' | 'soft_close' | 'closed' | 'locked';
  closeTasks: CloseTask[];
  percentComplete: number;
  targetCloseDate: number;
  actualCloseDate?: number;
}

/**
 * Close task for period close
 */
export interface CloseTask {
  id: string;
  name: string;
  category: 'ar' | 'ap' | 'gl' | 'inventory' | 'reconciliation' | 'reporting';
  status: 'not_started' | 'in_progress' | 'completed' | 'blocked';
  assignee: string;
  dueDate: number;
  completedAt?: number;
  notes?: string;
}

/**
 * Dashboard response
 */
export interface FinanceCentralDashboard {
  summary: {
    cashPosition: number;
    arBalance: number;
    apBalance: number;
    pendingApprovals: number;
  };
  metrics: FinancialMetrics;
  arAging: AgingReport;
  apAging: AgingReport;
  pendingApprovals: PendingApprovalView[];
  cashFlowForecast: CashFlowPeriod[];
  periodStatus?: PeriodCloseStatus;
  generatedAt: number;
}

/**
 * FinanceCentralService
 *
 * Provides comprehensive financial management including:
 * - GL account management
 * - AR/AP aging calculations
 * - Cash position tracking
 * - Cash flow forecasting
 * - Financial metrics (DSO, DPO, ratios)
 * - Approval workflow management
 * - Multi-entity consolidation
 * - Period close tracking
 */
@injectable()
export class FinanceCentralService {
  // Demo data stores. `pendingApprovals` was moved to a durable DB table
  // (migration 039) read via FinanceCentralOperatorService — see spec §3.
  private glAccounts = new Map<string, GLAccount>();
  private financialDocuments = new Map<string, FinancialDocument>();
  private bankAccounts = new Map<string, BankAccountBalance>();
  private entities = new Map<string, FinancialEntity>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.FinanceCentralOperatorService) private readonly operatorService: FinanceCentralOperatorService,
  ) {
    this.logger.info('FinanceCentralService initialized');
    this.initializeDemoData();
  }

  /**
   * Initialize demo data for testing and development
   */
  private initializeDemoData(): void {
    // Initialize GL Accounts
    const glAccountsData: GLAccount[] = [
      { id: 'gl-1000', accountNumber: '1000', name: 'Cash - Operating', type: 'asset', subType: 'cash', balance: 2450000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-1010', accountNumber: '1010', name: 'Cash - Payroll', type: 'asset', subType: 'cash', balance: 500000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-1020', accountNumber: '1020', name: 'Cash - Savings', type: 'asset', subType: 'cash', balance: 500000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-1100', accountNumber: '1100', name: 'Accounts Receivable', type: 'asset', subType: 'receivable', balance: 1250000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-1200', accountNumber: '1200', name: 'Inventory', type: 'asset', subType: 'inventory', balance: 890000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-2000', accountNumber: '2000', name: 'Accounts Payable', type: 'liability', subType: 'payable', balance: 890000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-2100', accountNumber: '2100', name: 'Accrued Expenses', type: 'liability', subType: 'accrued', balance: 125000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-3000', accountNumber: '3000', name: 'Retained Earnings', type: 'equity', subType: 'retained', balance: 2500000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-4000', accountNumber: '4000', name: 'Revenue - Products', type: 'revenue', subType: 'sales', balance: 7500000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-4100', accountNumber: '4100', name: 'Revenue - Services', type: 'revenue', subType: 'services', balance: 1250000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-5000', accountNumber: '5000', name: 'Cost of Goods Sold', type: 'expense', subType: 'cogs', balance: 4500000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
      { id: 'gl-6000', accountNumber: '6000', name: 'Operating Expenses', type: 'expense', subType: 'operating', balance: 1700000, currency: 'USD', isActive: true, lastUpdated: Date.now() },
    ];
    glAccountsData.forEach(account => this.glAccounts.set(account.id, account));

    // Initialize Bank Accounts
    const bankAccountsData: BankAccountBalance[] = [
      { accountId: 'bank-1', accountName: 'Main Operating Account', bankName: 'Chase Bank', accountType: 'checking', balance: 2450000, availableBalance: 2400000, currency: 'USD', lastUpdated: Date.now() },
      { accountId: 'bank-2', accountName: 'Payroll Account', bankName: 'Chase Bank', accountType: 'checking', balance: 500000, availableBalance: 500000, currency: 'USD', lastUpdated: Date.now() },
      { accountId: 'bank-3', accountName: 'Reserve Savings', bankName: 'Wells Fargo', accountType: 'savings', balance: 500000, availableBalance: 500000, currency: 'USD', lastUpdated: Date.now() },
      { accountId: 'bank-4', accountName: 'Line of Credit', bankName: 'Bank of America', accountType: 'credit_line', balance: 0, availableBalance: 500000, currency: 'USD', lastUpdated: Date.now() },
    ];
    bankAccountsData.forEach(account => this.bankAccounts.set(account.accountId, account));

    // Initialize Financial Documents (invoices and bills)
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const invoices: FinancialDocument[] = [
      // Current invoices
      { id: 'inv-001', type: 'invoice', documentNumber: 'INV-2024-001', entityId: 'cust-1', entityName: 'Acme Corp', entityType: 'customer', amount: 125000, amountPaid: 0, amountDue: 125000, currency: 'USD', issueDate: now - 10 * day, dueDate: now + 20 * day, status: 'open', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      { id: 'inv-002', type: 'invoice', documentNumber: 'INV-2024-002', entityId: 'cust-2', entityName: 'TechStart Inc', entityType: 'customer', amount: 85000, amountPaid: 0, amountDue: 85000, currency: 'USD', issueDate: now - 5 * day, dueDate: now + 25 * day, status: 'open', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      { id: 'inv-003', type: 'invoice', documentNumber: 'INV-2024-003', entityId: 'cust-3', entityName: 'Global Services', entityType: 'customer', amount: 240000, amountPaid: 100000, amountDue: 140000, currency: 'USD', issueDate: now - 15 * day, dueDate: now + 15 * day, status: 'partial', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      // 1-30 days overdue
      { id: 'inv-004', type: 'invoice', documentNumber: 'INV-2024-004', entityId: 'cust-4', entityName: 'Pacific Industries', entityType: 'customer', amount: 175000, amountPaid: 0, amountDue: 175000, currency: 'USD', issueDate: now - 45 * day, dueDate: now - 15 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      { id: 'inv-005', type: 'invoice', documentNumber: 'INV-2024-005', entityId: 'cust-5', entityName: 'Eastern Supply', entityType: 'customer', amount: 95000, amountPaid: 0, amountDue: 95000, currency: 'USD', issueDate: now - 50 * day, dueDate: now - 20 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      { id: 'inv-006', type: 'invoice', documentNumber: 'INV-2024-006', entityId: 'cust-6', entityName: 'Mountain Trading', entityType: 'customer', amount: 80000, amountPaid: 0, amountDue: 80000, currency: 'USD', issueDate: now - 55 * day, dueDate: now - 25 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      // 31-60 days overdue
      { id: 'inv-007', type: 'invoice', documentNumber: 'INV-2024-007', entityId: 'cust-7', entityName: 'Coastal Manufacturing', entityType: 'customer', amount: 150000, amountPaid: 0, amountDue: 150000, currency: 'USD', issueDate: now - 75 * day, dueDate: now - 45 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      { id: 'inv-008', type: 'invoice', documentNumber: 'INV-2024-008', entityId: 'cust-8', entityName: 'Summit Solutions', entityType: 'customer', amount: 100000, amountPaid: 0, amountDue: 100000, currency: 'USD', issueDate: now - 80 * day, dueDate: now - 50 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      // 61-90 days overdue
      { id: 'inv-009', type: 'invoice', documentNumber: 'INV-2024-009', entityId: 'cust-9', entityName: 'Valley Enterprises', entityType: 'customer', amount: 75000, amountPaid: 0, amountDue: 75000, currency: 'USD', issueDate: now - 105 * day, dueDate: now - 75 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      { id: 'inv-010', type: 'invoice', documentNumber: 'INV-2024-010', entityId: 'cust-10', entityName: 'River Industries', entityType: 'customer', amount: 50000, amountPaid: 0, amountDue: 50000, currency: 'USD', issueDate: now - 110 * day, dueDate: now - 80 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      // Over 90 days
      { id: 'inv-011', type: 'invoice', documentNumber: 'INV-2024-011', entityId: 'cust-11', entityName: 'Desert Tech', entityType: 'customer', amount: 45000, amountPaid: 0, amountDue: 45000, currency: 'USD', issueDate: now - 135 * day, dueDate: now - 105 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
      { id: 'inv-012', type: 'invoice', documentNumber: 'INV-2024-012', entityId: 'cust-12', entityName: 'Frozen Foods Inc', entityType: 'customer', amount: 30000, amountPaid: 0, amountDue: 30000, currency: 'USD', issueDate: now - 150 * day, dueDate: now - 120 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    ];

    const bills: FinancialDocument[] = [
      // Current bills
      { id: 'bill-001', type: 'bill', documentNumber: 'BILL-2024-001', entityId: 'vend-1', entityName: 'Supplier Corp', entityType: 'vendor', amount: 95000, amountPaid: 0, amountDue: 95000, currency: 'USD', issueDate: now - 10 * day, dueDate: now + 20 * day, status: 'open', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      { id: 'bill-002', type: 'bill', documentNumber: 'BILL-2024-002', entityId: 'vend-2', entityName: 'Parts Unlimited', entityType: 'vendor', amount: 125000, amountPaid: 0, amountDue: 125000, currency: 'USD', issueDate: now - 8 * day, dueDate: now + 22 * day, status: 'open', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      { id: 'bill-003', type: 'bill', documentNumber: 'BILL-2024-003', entityId: 'vend-3', entityName: 'Tech Components', entityType: 'vendor', amount: 100000, amountPaid: 50000, amountDue: 50000, currency: 'USD', issueDate: now - 20 * day, dueDate: now + 10 * day, status: 'partial', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      // 1-30 days overdue
      { id: 'bill-004', type: 'bill', documentNumber: 'BILL-2024-004', entityId: 'vend-4', entityName: 'Industrial Supply', entityType: 'vendor', amount: 145000, amountPaid: 0, amountDue: 145000, currency: 'USD', issueDate: now - 45 * day, dueDate: now - 15 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      { id: 'bill-005', type: 'bill', documentNumber: 'BILL-2024-005', entityId: 'vend-5', entityName: 'Office Supplies Co', entityType: 'vendor', amount: 85000, amountPaid: 0, amountDue: 85000, currency: 'USD', issueDate: now - 50 * day, dueDate: now - 20 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      { id: 'bill-006', type: 'bill', documentNumber: 'BILL-2024-006', entityId: 'vend-6', entityName: 'Logistics Inc', entityType: 'vendor', amount: 50000, amountPaid: 0, amountDue: 50000, currency: 'USD', issueDate: now - 52 * day, dueDate: now - 22 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      // 31-60 days overdue
      { id: 'bill-007', type: 'bill', documentNumber: 'BILL-2024-007', entityId: 'vend-7', entityName: 'Equipment Rental', entityType: 'vendor', amount: 120000, amountPaid: 0, amountDue: 120000, currency: 'USD', issueDate: now - 78 * day, dueDate: now - 48 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      { id: 'bill-008', type: 'bill', documentNumber: 'BILL-2024-008', entityId: 'vend-8', entityName: 'IT Services LLC', entityType: 'vendor', amount: 60000, amountPaid: 0, amountDue: 60000, currency: 'USD', issueDate: now - 82 * day, dueDate: now - 52 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      // 61-90 days overdue
      { id: 'bill-009', type: 'bill', documentNumber: 'BILL-2024-009', entityId: 'vend-9', entityName: 'Marketing Agency', entityType: 'vendor', amount: 45000, amountPaid: 0, amountDue: 45000, currency: 'USD', issueDate: now - 108 * day, dueDate: now - 78 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      { id: 'bill-010', type: 'bill', documentNumber: 'BILL-2024-010', entityId: 'vend-10', entityName: 'Consulting Group', entityType: 'vendor', amount: 25000, amountPaid: 0, amountDue: 25000, currency: 'USD', issueDate: now - 112 * day, dueDate: now - 82 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      // Over 90 days
      { id: 'bill-011', type: 'bill', documentNumber: 'BILL-2024-011', entityId: 'vend-11', entityName: 'Legal Services', entityType: 'vendor', amount: 25000, amountPaid: 0, amountDue: 25000, currency: 'USD', issueDate: now - 140 * day, dueDate: now - 110 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
      { id: 'bill-012', type: 'bill', documentNumber: 'BILL-2024-012', entityId: 'vend-12', entityName: 'Old Vendor LLC', entityType: 'vendor', amount: 15000, amountPaid: 0, amountDue: 15000, currency: 'USD', issueDate: now - 155 * day, dueDate: now - 125 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    ];

    [...invoices, ...bills].forEach(doc => this.financialDocuments.set(doc.id, doc));

    // Initialize Entities for multi-entity consolidation
    const entitiesData: FinancialEntity[] = [
      { id: 'ent-1', name: 'Parent Corp', type: 'subsidiary', currency: 'USD', isElimination: false },
      { id: 'ent-2', name: 'West Region', type: 'division', parentId: 'ent-1', currency: 'USD', isElimination: false },
      { id: 'ent-3', name: 'East Region', type: 'division', parentId: 'ent-1', currency: 'USD', isElimination: false },
      { id: 'ent-4', name: 'Eliminations', type: 'subsidiary', parentId: 'ent-1', currency: 'USD', isElimination: true },
    ];
    entitiesData.forEach(entity => this.entities.set(entity.id, entity));

    this.logger.info('FinanceCentralService demo data initialized', {
      glAccounts: this.glAccounts.size,
      documents: this.financialDocuments.size,
      bankAccounts: this.bankAccounts.size,
      entities: this.entities.size,
    });
  }

  /**
   * Get the full finance central dashboard
   *
   * `tenantId` is propagated from the request via `extractIdentityContext(req)`
   * at the route layer, matching the pattern used by the approvals endpoints.
   * Pre-PR-2C-Auth this falls back to `SYSTEM_IDENTITY.tenantId` automatically
   * because `extractIdentityContext` returns SYSTEM_IDENTITY when no verified
   * auth is mounted on the route.
   */
  public async getDashboard(tenantId: string): Promise<FinanceCentralDashboard> {
    this.logger.info('Generating FinanceCentral dashboard');

    const cashPosition = await this.getCashPosition();
    const arAging = await this.getARAgingReport();
    const apAging = await this.getAPAgingReport();
    const metrics = await this.calculateFinancialMetrics();
    // Dashboard returns the full pending-approvals array — `summary.pendingApprovals`
    // counts approvals.length and the UI template slices to 8 with a "View All N"
    // overflow link. No limit so the count remains accurate (spec §3 wording said
    // limit:5 but that would break the UI count contract).
    const approvals = await this.operatorService.listPendingApprovals({
      tenantId,
    });
    const cashFlow = await this.getCashFlowForecast(4); // 4 weeks

    return {
      summary: {
        cashPosition: cashPosition.totalCash,
        arBalance: arAging.totalAmount,
        apBalance: apAging.totalAmount,
        pendingApprovals: approvals.length,
      },
      metrics,
      arAging,
      apAging,
      pendingApprovals: approvals,
      cashFlowForecast: cashFlow,
      generatedAt: Date.now(),
    };
  }

  /**
   * Get current cash position across all bank accounts
   */
  public async getCashPosition(): Promise<CashPosition> {
    const bankAccountsList = Array.from(this.bankAccounts.values());
    const totalCash = bankAccountsList
      .filter(a => a.accountType !== 'credit_line')
      .reduce((sum, a) => sum + a.balance, 0);

    const availableCredit = bankAccountsList
      .filter(a => a.accountType === 'credit_line')
      .reduce((sum, a) => sum + a.availableBalance, 0);

    // Calculate pending receipts (open AR)
    const arDocs = Array.from(this.financialDocuments.values())
      .filter(d => d.type === 'invoice' && d.status !== 'paid' && d.status !== 'voided');
    const pendingReceipts = arDocs.reduce((sum, d) => sum + d.amountDue, 0);

    // Calculate pending payments (open AP)
    const apDocs = Array.from(this.financialDocuments.values())
      .filter(d => d.type === 'bill' && d.status !== 'paid' && d.status !== 'voided');
    const pendingPayments = apDocs.reduce((sum, d) => sum + d.amountDue, 0);

    return {
      totalCash,
      bankAccounts: bankAccountsList,
      availableCredit,
      pendingReceipts,
      pendingPayments,
      netCashPosition: totalCash + availableCredit - pendingPayments,
      currency: 'USD',
      asOfDate: Date.now(),
    };
  }

  /**
   * Get AR Aging Report
   */
  public async getARAgingReport(): Promise<AgingReport> {
    return this.calculateAgingReport('ar');
  }

  /**
   * Get AP Aging Report
   */
  public async getAPAgingReport(): Promise<AgingReport> {
    return this.calculateAgingReport('ap');
  }

  /**
   * Calculate aging report for AR or AP
   */
  private calculateAgingReport(type: 'ar' | 'ap'): AgingReport {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const docType = type === 'ar' ? 'invoice' : 'bill';
    const documents = Array.from(this.financialDocuments.values())
      .filter(d => d.type === docType && d.status !== 'paid' && d.status !== 'voided');

    // Initialize buckets
    const bucketDefs = [
      { label: 'Current', minDays: -Infinity, maxDays: 0 },
      { label: '1-30 Days', minDays: 1, maxDays: 30 },
      { label: '31-60 Days', minDays: 31, maxDays: 60 },
      { label: '61-90 Days', minDays: 61, maxDays: 90 },
      { label: 'Over 90 Days', minDays: 91, maxDays: null },
    ];

    const buckets: AgingBucket[] = bucketDefs.map(def => ({
      ...def,
      amount: 0,
      count: 0,
      percentage: 0,
    }));

    // Group by entity
    const entityMap = new Map<string, EntityAging>();

    let totalAmount = 0;

    documents.forEach(doc => {
      const daysOverdue = Math.floor((now - doc.dueDate) / day);
      totalAmount += doc.amountDue;

      // Find appropriate bucket
      for (const bucket of buckets) {
        const inBucket = daysOverdue <= 0
          ? bucket.minDays === -Infinity
          : daysOverdue >= bucket.minDays && (bucket.maxDays === null || daysOverdue <= bucket.maxDays);

        if (inBucket) {
          bucket.amount += doc.amountDue;
          bucket.count++;
          break;
        }
      }

      // Update entity aging
      if (!entityMap.has(doc.entityId)) {
        entityMap.set(doc.entityId, {
          entityId: doc.entityId,
          entityName: doc.entityName,
          totalAmount: 0,
          current: 0,
          days1to30: 0,
          days31to60: 0,
          days61to90: 0,
          over90: 0,
          oldestInvoiceDate: doc.issueDate,
        });
      }

      const entityAging = entityMap.get(doc.entityId)!;
      entityAging.totalAmount += doc.amountDue;

      if (daysOverdue <= 0) entityAging.current += doc.amountDue;
      else if (daysOverdue <= 30) entityAging.days1to30 += doc.amountDue;
      else if (daysOverdue <= 60) entityAging.days31to60 += doc.amountDue;
      else if (daysOverdue <= 90) entityAging.days61to90 += doc.amountDue;
      else entityAging.over90 += doc.amountDue;

      if (doc.issueDate < entityAging.oldestInvoiceDate) {
        entityAging.oldestInvoiceDate = doc.issueDate;
      }
    });

    // Calculate percentages
    buckets.forEach(bucket => {
      bucket.percentage = totalAmount > 0 ? Math.round((bucket.amount / totalAmount) * 100) : 0;
    });

    return {
      type,
      asOfDate: now,
      totalAmount,
      totalDocuments: documents.length,
      buckets,
      byEntity: Array.from(entityMap.values()).sort((a, b) => b.totalAmount - a.totalAmount),
      currency: 'USD',
      generatedAt: now,
    };
  }

  /**
   * Calculate financial metrics including DSO, DPO, ratios
   */
  public async calculateFinancialMetrics(): Promise<FinancialMetrics> {
    const now = Date.now();

    // Get revenue and expense accounts
    const revenueAccounts = Array.from(this.glAccounts.values()).filter(a => a.type === 'revenue');
    const expenseAccounts = Array.from(this.glAccounts.values()).filter(a => a.type === 'expense');
    const assetAccounts = Array.from(this.glAccounts.values()).filter(a => a.type === 'asset');
    const liabilityAccounts = Array.from(this.glAccounts.values()).filter(a => a.type === 'liability');
    const equityAccounts = Array.from(this.glAccounts.values()).filter(a => a.type === 'equity');

    const revenue = revenueAccounts.reduce((sum, a) => sum + a.balance, 0);
    const expenses = expenseAccounts.reduce((sum, a) => sum + a.balance, 0);
    const cogs = expenseAccounts.filter(a => a.subType === 'cogs').reduce((sum, a) => sum + a.balance, 0);
    const netIncome = revenue - expenses;

    const totalAssets = assetAccounts.reduce((sum, a) => sum + a.balance, 0);
    const currentAssets = assetAccounts.filter(a => ['cash', 'receivable', 'inventory'].includes(a.subType)).reduce((sum, a) => sum + a.balance, 0);
    const inventory = assetAccounts.filter(a => a.subType === 'inventory').reduce((sum, a) => sum + a.balance, 0);
    const currentLiabilities = liabilityAccounts.filter(a => ['payable', 'accrued'].includes(a.subType)).reduce((sum, a) => sum + a.balance, 0);
    const totalLiabilities = liabilityAccounts.reduce((sum, a) => sum + a.balance, 0);
    const totalEquity = equityAccounts.reduce((sum, a) => sum + a.balance, 0);

    // AR for DSO calculation
    const arBalance = assetAccounts.filter(a => a.subType === 'receivable').reduce((sum, a) => sum + a.balance, 0);
    const apBalance = liabilityAccounts.filter(a => a.subType === 'payable').reduce((sum, a) => sum + a.balance, 0);

    // Calculate DSO (Days Sales Outstanding) - assumes 365 day period
    const dailyRevenue = revenue / 365;
    const dso = dailyRevenue > 0 ? arBalance / dailyRevenue : 0;

    // Calculate DPO (Days Payable Outstanding) - based on COGS
    const dailyCOGS = cogs / 365;
    const dpo = dailyCOGS > 0 ? apBalance / dailyCOGS : 0;

    // Calculate ratios
    const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;
    const quickRatio = currentLiabilities > 0 ? (currentAssets - inventory) / currentLiabilities : 0;
    const debtToEquity = totalEquity > 0 ? totalLiabilities / totalEquity : 0;
    const workingCapital = currentAssets - currentLiabilities;

    // Calculate margins
    const grossMargin = revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0;
    const operatingMargin = revenue > 0 ? (netIncome / revenue) * 100 : 0;
    const netMargin = revenue > 0 ? (netIncome / revenue) * 100 : 0;

    return {
      revenue,
      expenses,
      netIncome,
      grossMargin: Math.round(grossMargin * 10) / 10,
      operatingMargin: Math.round(operatingMargin * 10) / 10,
      netMargin: Math.round(netMargin * 10) / 10,
      dso: Math.round(dso * 10) / 10,
      dpo: Math.round(dpo * 10) / 10,
      currentRatio: Math.round(currentRatio * 100) / 100,
      quickRatio: Math.round(quickRatio * 100) / 100,
      debtToEquity: Math.round(debtToEquity * 100) / 100,
      workingCapital,
      period: 'YTD',
      currency: 'USD',
      calculatedAt: now,
    };
  }

  /**
   * Get cash flow forecast for specified number of weeks
   */
  public async getCashFlowForecast(weeks: number): Promise<CashFlowPeriod[]> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = 7 * day;

    const cashPosition = await this.getCashPosition();
    let openingBalance = cashPosition.totalCash;

    const forecast: CashFlowPeriod[] = [];

    for (let w = 0; w < weeks; w++) {
      const startDate = now + w * week;
      const endDate = now + (w + 1) * week;

      // Calculate expected inflows (invoices due in this period)
      const invoicesDue = Array.from(this.financialDocuments.values())
        .filter(d => d.type === 'invoice' && d.status !== 'paid' && d.status !== 'voided')
        .filter(d => d.dueDate >= startDate && d.dueDate < endDate);

      const expectedReceipts = invoicesDue.reduce((sum, d) => sum + d.amountDue, 0);

      // Calculate expected outflows (bills due in this period)
      const billsDue = Array.from(this.financialDocuments.values())
        .filter(d => d.type === 'bill' && d.status !== 'paid' && d.status !== 'voided')
        .filter(d => d.dueDate >= startDate && d.dueDate < endDate);

      const expectedPayments = billsDue.reduce((sum, d) => sum + d.amountDue, 0);

      // Add recurring expenses estimate (payroll, rent, utilities)
      const recurringExpenses = 150000; // Weekly recurring estimate

      const totalInflows = expectedReceipts + (w === 0 ? 0 : expectedReceipts * 0.3); // Add some recurring revenue
      const totalOutflows = expectedPayments + recurringExpenses;
      const netCashFlow = totalInflows - totalOutflows;
      const closingBalance = openingBalance + netCashFlow;

      forecast.push({
        periodLabel: `Week ${w + 1}`,
        startDate,
        endDate,
        openingBalance,
        inflows: {
          total: totalInflows,
          breakdown: [
            { category: 'Customer Receipts', amount: expectedReceipts, count: invoicesDue.length },
            { category: 'Other Revenue', amount: w === 0 ? 0 : expectedReceipts * 0.3, count: 0 },
          ],
        },
        outflows: {
          total: totalOutflows,
          breakdown: [
            { category: 'Vendor Payments', amount: expectedPayments, count: billsDue.length },
            { category: 'Payroll', amount: 100000, count: 1 },
            { category: 'Operating Expenses', amount: 50000, count: 0 },
          ],
        },
        netCashFlow,
        closingBalance,
      });

      openingBalance = closingBalance;
    }

    return forecast;
  }

  /**
   * Get GL accounts
   */
  public async getGLAccounts(filters?: {
    type?: GLAccount['type'];
    isActive?: boolean;
  }): Promise<GLAccount[]> {
    let accounts = Array.from(this.glAccounts.values());

    if (filters?.type) {
      accounts = accounts.filter(a => a.type === filters.type);
    }
    if (filters?.isActive !== undefined) {
      accounts = accounts.filter(a => a.isActive === filters.isActive);
    }

    return accounts.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  }

  /**
   * Get consolidated financial summary across entities
   */
  public async getConsolidatedSummary(): Promise<ConsolidatedSummary> {
    const entitiesList = Array.from(this.entities.values());

    // Get totals from GL
    const cashAccounts = Array.from(this.glAccounts.values()).filter(a => a.subType === 'cash');
    const arAccounts = Array.from(this.glAccounts.values()).filter(a => a.subType === 'receivable');
    const apAccounts = Array.from(this.glAccounts.values()).filter(a => a.subType === 'payable');
    const revenueAccounts = Array.from(this.glAccounts.values()).filter(a => a.type === 'revenue');
    const expenseAccounts = Array.from(this.glAccounts.values()).filter(a => a.type === 'expense');

    const consolidatedCash = cashAccounts.reduce((sum, a) => sum + a.balance, 0);
    const consolidatedAR = arAccounts.reduce((sum, a) => sum + a.balance, 0);
    const consolidatedAP = apAccounts.reduce((sum, a) => sum + a.balance, 0);
    const totalRevenue = revenueAccounts.reduce((sum, a) => sum + a.balance, 0);
    const totalExpenses = expenseAccounts.reduce((sum, a) => sum + a.balance, 0);

    // Intercompany eliminations (demo value)
    const intercompanyEliminations = 150000;

    return {
      entities: entitiesList,
      consolidatedCash,
      consolidatedAR,
      consolidatedAP,
      intercompanyEliminations,
      totalRevenue,
      totalExpenses,
      consolidatedNetIncome: totalRevenue - totalExpenses,
      currency: 'USD',
      asOfDate: Date.now(),
    };
  }

  /**
   * Get period close status
   */
  public async getPeriodCloseStatus(periodId?: string): Promise<PeriodCloseStatus> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // Demo: current period close
    const currentPeriodStart = new Date();
    currentPeriodStart.setDate(1);
    currentPeriodStart.setHours(0, 0, 0, 0);

    const currentPeriodEnd = new Date(currentPeriodStart);
    currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
    currentPeriodEnd.setDate(0);
    currentPeriodEnd.setHours(23, 59, 59, 999);

    const closeTasks: CloseTask[] = [
      { id: 'task-1', name: 'Review AR aging', category: 'ar', status: 'completed', assignee: 'ar.analyst@company.com', dueDate: currentPeriodEnd.getTime() + 3 * day, completedAt: now - 2 * day },
      { id: 'task-2', name: 'Process customer payments', category: 'ar', status: 'completed', assignee: 'ar.analyst@company.com', dueDate: currentPeriodEnd.getTime() + 3 * day, completedAt: now - 1 * day },
      { id: 'task-3', name: 'Review AP aging', category: 'ap', status: 'in_progress', assignee: 'ap.analyst@company.com', dueDate: currentPeriodEnd.getTime() + 4 * day },
      { id: 'task-4', name: 'Process vendor payments', category: 'ap', status: 'not_started', assignee: 'ap.analyst@company.com', dueDate: currentPeriodEnd.getTime() + 5 * day },
      { id: 'task-5', name: 'Post depreciation entries', category: 'gl', status: 'not_started', assignee: 'accountant@company.com', dueDate: currentPeriodEnd.getTime() + 5 * day },
      { id: 'task-6', name: 'Record accruals', category: 'gl', status: 'not_started', assignee: 'accountant@company.com', dueDate: currentPeriodEnd.getTime() + 6 * day },
      { id: 'task-7', name: 'Inventory count reconciliation', category: 'inventory', status: 'not_started', assignee: 'inventory@company.com', dueDate: currentPeriodEnd.getTime() + 4 * day },
      { id: 'task-8', name: 'Bank reconciliation', category: 'reconciliation', status: 'not_started', assignee: 'accountant@company.com', dueDate: currentPeriodEnd.getTime() + 5 * day },
      { id: 'task-9', name: 'Intercompany reconciliation', category: 'reconciliation', status: 'not_started', assignee: 'controller@company.com', dueDate: currentPeriodEnd.getTime() + 6 * day },
      { id: 'task-10', name: 'Generate financial statements', category: 'reporting', status: 'not_started', assignee: 'controller@company.com', dueDate: currentPeriodEnd.getTime() + 7 * day },
    ];

    const completedTasks = closeTasks.filter(t => t.status === 'completed').length;
    const percentComplete = Math.round((completedTasks / closeTasks.length) * 100);

    return {
      periodId: periodId || `period-${currentPeriodStart.getFullYear()}-${String(currentPeriodStart.getMonth() + 1).padStart(2, '0')}`,
      periodName: currentPeriodStart.toLocaleString('default', { month: 'long', year: 'numeric' }),
      startDate: currentPeriodStart.getTime(),
      endDate: currentPeriodEnd.getTime(),
      status: 'open',
      closeTasks,
      percentComplete,
      targetCloseDate: currentPeriodEnd.getTime() + 7 * day,
    };
  }

  /**
   * Get financial documents (invoices/bills) with filtering
   */
  public async getFinancialDocuments(filters?: {
    type?: 'invoice' | 'bill';
    status?: FinancialDocument['status'];
    entityId?: string;
    minAmount?: number;
    maxAmount?: number;
  }): Promise<FinancialDocument[]> {
    let documents = Array.from(this.financialDocuments.values());

    if (filters?.type) {
      documents = documents.filter(d => d.type === filters.type);
    }
    if (filters?.status) {
      documents = documents.filter(d => d.status === filters.status);
    }
    if (filters?.entityId) {
      documents = documents.filter(d => d.entityId === filters.entityId);
    }
    if (filters?.minAmount !== undefined) {
      documents = documents.filter(d => d.amount >= filters.minAmount!);
    }
    if (filters?.maxAmount !== undefined) {
      documents = documents.filter(d => d.amount <= filters.maxAmount!);
    }

    return documents.sort((a, b) => b.issueDate - a.issueDate);
  }

  /**
   * Record a payment against an invoice or bill
   */
  public async recordPayment(
    documentId: string,
    amount: number,
    paymentDate: number,
    paymentMethod: string,
    reference?: string
  ): Promise<{ success: boolean; message: string; document?: FinancialDocument }> {
    const document = this.financialDocuments.get(documentId);
    if (!document) {
      return { success: false, message: `Document ${documentId} not found` };
    }

    if (amount > document.amountDue) {
      return { success: false, message: `Payment amount ${amount} exceeds amount due ${document.amountDue}` };
    }

    this.logger.info('Recording payment', { documentId, amount, paymentMethod, reference });

    // Update document
    document.amountPaid += amount;
    document.amountDue -= amount;

    if (document.amountDue <= 0) {
      document.status = 'paid';
    } else {
      document.status = 'partial';
    }

    this.financialDocuments.set(documentId, document);

    return {
      success: true,
      message: `Payment of ${amount} recorded for ${document.documentNumber}`,
      document,
    };
  }

  /**
   * Calculate DSO (Days Sales Outstanding)
   */
  public calculateDSO(arBalance: number, annualRevenue: number): number {
    if (annualRevenue <= 0) return 0;
    const dailyRevenue = annualRevenue / 365;
    return Math.round((arBalance / dailyRevenue) * 10) / 10;
  }

  /**
   * Calculate DPO (Days Payable Outstanding)
   */
  public calculateDPO(apBalance: number, annualCOGS: number): number {
    if (annualCOGS <= 0) return 0;
    const dailyCOGS = annualCOGS / 365;
    return Math.round((apBalance / dailyCOGS) * 10) / 10;
  }

  /**
   * Calculate current ratio
   */
  public calculateCurrentRatio(currentAssets: number, currentLiabilities: number): number {
    if (currentLiabilities <= 0) return 0;
    return Math.round((currentAssets / currentLiabilities) * 100) / 100;
  }

  /**
   * Calculate quick ratio (acid test)
   */
  public calculateQuickRatio(currentAssets: number, inventory: number, currentLiabilities: number): number {
    if (currentLiabilities <= 0) return 0;
    return Math.round(((currentAssets - inventory) / currentLiabilities) * 100) / 100;
  }
}
