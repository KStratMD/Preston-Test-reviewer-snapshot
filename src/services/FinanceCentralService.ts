import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { FinanceCentralOperatorService } from './financeCentral/FinanceCentralOperatorService';
import type { PendingApprovalView } from './financeCentral/types';
import { TenantSandbox } from './common/TenantSandbox';
import { buildFinanceCentralSeed, type FinanceCentralStores } from './financeCentral/financeCentralDemoSeed';

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
  // Per-tenant lazy copy-on-write demo stores. `pendingApprovals` was moved to a
  // durable DB table (migration 039) read via FinanceCentralOperatorService — see spec §3.
  private readonly sandbox = new TenantSandbox<FinanceCentralStores>(buildFinanceCentralSeed);

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.FinanceCentralOperatorService) private readonly operatorService: FinanceCentralOperatorService,
  ) {
    this.logger.info('FinanceCentralService initialized');
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

    const cashPosition = await this.getCashPosition(tenantId);
    const arAging = await this.getARAgingReport(tenantId);
    const apAging = await this.getAPAgingReport(tenantId);
    const metrics = await this.calculateFinancialMetrics(tenantId);
    // Dashboard returns the full pending-approvals array — `summary.pendingApprovals`
    // counts approvals.length and the UI template slices to 8 with a "View All N"
    // overflow link. No limit so the count remains accurate (spec §3 wording said
    // limit:5 but that would break the UI count contract).
    const approvals = await this.operatorService.listPendingApprovals({
      tenantId,
    });
    const cashFlow = await this.getCashFlowForecast(tenantId, 4); // 4 weeks

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
  public async getCashPosition(tenantId: string): Promise<CashPosition> {
    const { financialDocuments, bankAccounts } = this.sandbox.forTenant(tenantId);
    const bankAccountsList = Array.from(bankAccounts.values());
    const totalCash = bankAccountsList
      .filter(a => a.accountType !== 'credit_line')
      .reduce((sum, a) => sum + a.balance, 0);

    const availableCredit = bankAccountsList
      .filter(a => a.accountType === 'credit_line')
      .reduce((sum, a) => sum + a.availableBalance, 0);

    // Calculate pending receipts (open AR)
    const arDocs = Array.from(financialDocuments.values())
      .filter(d => d.type === 'invoice' && d.status !== 'paid' && d.status !== 'voided');
    const pendingReceipts = arDocs.reduce((sum, d) => sum + d.amountDue, 0);

    // Calculate pending payments (open AP)
    const apDocs = Array.from(financialDocuments.values())
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
  public async getARAgingReport(tenantId: string): Promise<AgingReport> {
    return this.calculateAgingReport(tenantId, 'ar');
  }

  /**
   * Get AP Aging Report
   */
  public async getAPAgingReport(tenantId: string): Promise<AgingReport> {
    return this.calculateAgingReport(tenantId, 'ap');
  }

  /**
   * Calculate aging report for AR or AP
   */
  private calculateAgingReport(tenantId: string, type: 'ar' | 'ap'): AgingReport {
    const { financialDocuments } = this.sandbox.forTenant(tenantId);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const docType = type === 'ar' ? 'invoice' : 'bill';
    const documents = Array.from(financialDocuments.values())
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
  public async calculateFinancialMetrics(tenantId: string): Promise<FinancialMetrics> {
    const { glAccounts } = this.sandbox.forTenant(tenantId);
    const now = Date.now();

    // Get revenue and expense accounts
    const revenueAccounts = Array.from(glAccounts.values()).filter(a => a.type === 'revenue');
    const expenseAccounts = Array.from(glAccounts.values()).filter(a => a.type === 'expense');
    const assetAccounts = Array.from(glAccounts.values()).filter(a => a.type === 'asset');
    const liabilityAccounts = Array.from(glAccounts.values()).filter(a => a.type === 'liability');
    const equityAccounts = Array.from(glAccounts.values()).filter(a => a.type === 'equity');

    const revenue = revenueAccounts.reduce((sum, a) => sum + a.balance, 0);
    const expenses = expenseAccounts.reduce((sum, a) => sum + a.balance, 0);
    const cogs = expenseAccounts.filter(a => a.subType === 'cogs').reduce((sum, a) => sum + a.balance, 0);
    const netIncome = revenue - expenses;

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
  public async getCashFlowForecast(tenantId: string, weeks: number): Promise<CashFlowPeriod[]> {
    const { financialDocuments } = this.sandbox.forTenant(tenantId);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = 7 * day;

    const cashPosition = await this.getCashPosition(tenantId);
    let openingBalance = cashPosition.totalCash;

    const forecast: CashFlowPeriod[] = [];

    for (let w = 0; w < weeks; w++) {
      const startDate = now + w * week;
      const endDate = now + (w + 1) * week;

      // Calculate expected inflows (invoices due in this period)
      const invoicesDue = Array.from(financialDocuments.values())
        .filter(d => d.type === 'invoice' && d.status !== 'paid' && d.status !== 'voided')
        .filter(d => d.dueDate >= startDate && d.dueDate < endDate);

      const expectedReceipts = invoicesDue.reduce((sum, d) => sum + d.amountDue, 0);

      // Calculate expected outflows (bills due in this period)
      const billsDue = Array.from(financialDocuments.values())
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
  public async getGLAccounts(tenantId: string, filters?: {
    type?: GLAccount['type'];
    isActive?: boolean;
  }): Promise<GLAccount[]> {
    const { glAccounts } = this.sandbox.forTenant(tenantId);
    let accounts = Array.from(glAccounts.values());

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
  public async getConsolidatedSummary(tenantId: string): Promise<ConsolidatedSummary> {
    const { glAccounts, entities } = this.sandbox.forTenant(tenantId);
    const entitiesList = Array.from(entities.values());

    // Get totals from GL
    const cashAccounts = Array.from(glAccounts.values()).filter(a => a.subType === 'cash');
    const arAccounts = Array.from(glAccounts.values()).filter(a => a.subType === 'receivable');
    const apAccounts = Array.from(glAccounts.values()).filter(a => a.subType === 'payable');
    const revenueAccounts = Array.from(glAccounts.values()).filter(a => a.type === 'revenue');
    const expenseAccounts = Array.from(glAccounts.values()).filter(a => a.type === 'expense');

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
  public async getFinancialDocuments(tenantId: string, filters?: {
    type?: 'invoice' | 'bill';
    status?: FinancialDocument['status'];
    entityId?: string;
    minAmount?: number;
    maxAmount?: number;
  }): Promise<FinancialDocument[]> {
    const { financialDocuments } = this.sandbox.forTenant(tenantId);
    let documents = Array.from(financialDocuments.values());

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
    tenantId: string,
    documentId: string,
    amount: number,
    paymentDate: number,
    paymentMethod: string,
    reference?: string
  ): Promise<{ success: boolean; message: string; document?: FinancialDocument }> {
    const { financialDocuments } = this.sandbox.forTenant(tenantId);
    const document = financialDocuments.get(documentId);
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

    financialDocuments.set(documentId, document);

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
