/**
 * FinanceCentralService Tests
 * Tests for GL accounts, AR/AP aging, cash flow forecasting, financial metrics
 */

import { FinanceCentralService } from '../../../../src/services/FinanceCentralService';
import type { FinanceCentralOperatorService } from '../../../../src/services/financeCentral/FinanceCentralOperatorService';
import type { PendingApprovalView } from '../../../../src/services/financeCentral/types';
import type { Logger } from '../../../../src/utils/Logger';

// Create mocks
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

// PR 6 T7: getDashboard reads pending approvals via the operator service. The
// existing dashboard assertions expect `summary.pendingApprovals > 0` and a
// non-empty `dashboard.pendingApprovals` array, so the mock returns a small
// seeded set covering the priority types used by the sort-order check.
function createMockOperatorService(): jest.Mocked<FinanceCentralOperatorService> {
  const seeded: PendingApprovalView[] = [
    { id: 'appr-001', type: 'invoice', documentNumber: 'INV-2024-4521', description: 'Monthly service invoice', amount: 45000, currency: 'USD', submittedBy: 'jane.doe@company.com', submittedAt: Date.now() - 2 * 86_400_000, daysWaiting: 2, currentApprover: 'john.smith@company.com', approvalLevel: 2, priority: 'medium' },
    { id: 'appr-002', type: 'purchase_order', documentNumber: 'PO-2024-892', description: 'Q1 hardware refresh', amount: 28000, currency: 'USD', submittedBy: 'mike.jones@company.com', submittedAt: Date.now() - 1 * 86_400_000, daysWaiting: 1, currentApprover: 'jane.doe@company.com', approvalLevel: 1, priority: 'high' },
    { id: 'appr-010', type: 'purchase_order', documentNumber: 'PO-2024-894', description: 'Emergency server replacement', amount: 42000, currency: 'USD', submittedBy: 'it@company.com', submittedAt: Date.now(), daysWaiting: 0, currentApprover: 'cio@company.com', approvalLevel: 1, priority: 'urgent' },
  ];
  return {
    listPendingApprovals: jest.fn().mockResolvedValue(seeded),
    approveItem: jest.fn(),
    rejectItem: jest.fn(),
  } as unknown as jest.Mocked<FinanceCentralOperatorService>;
}

describe('FinanceCentralService', () => {
  let service: FinanceCentralService;
  let mockLogger: jest.Mocked<Logger>;
  let mockOperatorService: jest.Mocked<FinanceCentralOperatorService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockOperatorService = createMockOperatorService();
    service = new FinanceCentralService(mockLogger, mockOperatorService);
  });

  describe('initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('FinanceCentralService initialized');
    });
  });

  describe('getDashboard', () => {
    it('should return comprehensive dashboard data', async () => {
      const dashboard = await service.getDashboard('__test_tenant__');

      expect(dashboard).toHaveProperty('summary');
      expect(dashboard).toHaveProperty('metrics');
      expect(dashboard).toHaveProperty('arAging');
      expect(dashboard).toHaveProperty('apAging');
      expect(dashboard).toHaveProperty('pendingApprovals');
      expect(dashboard).toHaveProperty('cashFlowForecast');
      expect(dashboard).toHaveProperty('generatedAt');
    });

    it('should have valid summary values', async () => {
      const dashboard = await service.getDashboard('__test_tenant__');

      expect(dashboard.summary.cashPosition).toBeGreaterThan(0);
      expect(dashboard.summary.arBalance).toBeGreaterThan(0);
      expect(dashboard.summary.apBalance).toBeGreaterThan(0);
      expect(dashboard.summary.pendingApprovals).toBeGreaterThan(0);
    });

    it('should include cash flow forecast', async () => {
      const dashboard = await service.getDashboard('__test_tenant__');

      expect(dashboard.cashFlowForecast.length).toBe(4); // Default 4 weeks
      dashboard.cashFlowForecast.forEach(period => {
        expect(period).toHaveProperty('periodLabel');
        expect(period).toHaveProperty('openingBalance');
        expect(period).toHaveProperty('inflows');
        expect(period).toHaveProperty('outflows');
        expect(period).toHaveProperty('netCashFlow');
        expect(period).toHaveProperty('closingBalance');
      });
    });
  });

  describe('getCashPosition', () => {
    it('should return current cash position', async () => {
      const cashPosition = await service.getCashPosition('tenant-test');

      expect(cashPosition).toHaveProperty('totalCash');
      expect(cashPosition).toHaveProperty('bankAccounts');
      expect(cashPosition).toHaveProperty('availableCredit');
      expect(cashPosition).toHaveProperty('pendingReceipts');
      expect(cashPosition).toHaveProperty('pendingPayments');
      expect(cashPosition).toHaveProperty('netCashPosition');
      expect(cashPosition).toHaveProperty('currency');
      expect(cashPosition).toHaveProperty('asOfDate');
    });

    it('should have bank accounts', async () => {
      const cashPosition = await service.getCashPosition('tenant-test');

      expect(cashPosition.bankAccounts.length).toBeGreaterThan(0);
      cashPosition.bankAccounts.forEach(account => {
        expect(account).toHaveProperty('accountId');
        expect(account).toHaveProperty('accountName');
        expect(account).toHaveProperty('bankName');
        expect(account).toHaveProperty('balance');
      });
    });

    it('should calculate net cash position correctly', async () => {
      const cashPosition = await service.getCashPosition('tenant-test');

      // Net = totalCash + availableCredit - pendingPayments
      const expectedNet = cashPosition.totalCash + cashPosition.availableCredit - cashPosition.pendingPayments;
      expect(cashPosition.netCashPosition).toBe(expectedNet);
    });

    it('should use USD as currency', async () => {
      const cashPosition = await service.getCashPosition('tenant-test');
      expect(cashPosition.currency).toBe('USD');
    });
  });

  describe('getARAgingReport', () => {
    it('should return AR aging report', async () => {
      const arAging = await service.getARAgingReport('tenant-test');

      expect(arAging.type).toBe('ar');
      expect(arAging).toHaveProperty('totalAmount');
      expect(arAging).toHaveProperty('totalDocuments');
      expect(arAging).toHaveProperty('buckets');
      expect(arAging).toHaveProperty('byEntity');
    });

    it('should have correct aging buckets', async () => {
      const arAging = await service.getARAgingReport('tenant-test');

      expect(arAging.buckets.length).toBe(5);
      const labels = arAging.buckets.map(b => b.label);
      expect(labels).toContain('Current');
      expect(labels).toContain('1-30 Days');
      expect(labels).toContain('31-60 Days');
      expect(labels).toContain('61-90 Days');
      expect(labels).toContain('Over 90 Days');
    });

    it('should have percentages that sum to 100', async () => {
      const arAging = await service.getARAgingReport('tenant-test');

      const totalPercentage = arAging.buckets.reduce((sum, b) => sum + b.percentage, 0);
      expect(totalPercentage).toBeCloseTo(100, 0);
    });

    it('should have entity-level aging breakdown', async () => {
      const arAging = await service.getARAgingReport('tenant-test');

      expect(arAging.byEntity.length).toBeGreaterThan(0);
      arAging.byEntity.forEach(entity => {
        expect(entity).toHaveProperty('entityId');
        expect(entity).toHaveProperty('entityName');
        expect(entity).toHaveProperty('totalAmount');
        expect(entity).toHaveProperty('current');
        expect(entity).toHaveProperty('days1to30');
        expect(entity).toHaveProperty('days31to60');
        expect(entity).toHaveProperty('days61to90');
        expect(entity).toHaveProperty('over90');
      });
    });
  });

  describe('getAPAgingReport', () => {
    it('should return AP aging report', async () => {
      const apAging = await service.getAPAgingReport('tenant-test');

      expect(apAging.type).toBe('ap');
      expect(apAging).toHaveProperty('totalAmount');
      expect(apAging).toHaveProperty('totalDocuments');
      expect(apAging).toHaveProperty('buckets');
    });

    it('should have correct aging buckets', async () => {
      const apAging = await service.getAPAgingReport('tenant-test');

      expect(apAging.buckets.length).toBe(5);
      const labels = apAging.buckets.map(b => b.label);
      expect(labels).toContain('Current');
      expect(labels).toContain('Over 90 Days');
    });

    it('should have entity-level aging breakdown', async () => {
      const apAging = await service.getAPAgingReport('tenant-test');

      expect(apAging.byEntity.length).toBeGreaterThan(0);
    });
  });

  describe('calculateFinancialMetrics', () => {
    it('should return financial metrics', async () => {
      const metrics = await service.calculateFinancialMetrics('tenant-test');

      expect(metrics).toHaveProperty('revenue');
      expect(metrics).toHaveProperty('expenses');
      expect(metrics).toHaveProperty('netIncome');
      expect(metrics).toHaveProperty('grossMargin');
      expect(metrics).toHaveProperty('operatingMargin');
      expect(metrics).toHaveProperty('netMargin');
      expect(metrics).toHaveProperty('dso');
      expect(metrics).toHaveProperty('dpo');
      expect(metrics).toHaveProperty('currentRatio');
      expect(metrics).toHaveProperty('quickRatio');
      expect(metrics).toHaveProperty('debtToEquity');
      expect(metrics).toHaveProperty('workingCapital');
    });

    it('should calculate net income correctly', async () => {
      const metrics = await service.calculateFinancialMetrics('tenant-test');

      expect(metrics.netIncome).toBe(metrics.revenue - metrics.expenses);
    });

    it('should have positive margins', async () => {
      const metrics = await service.calculateFinancialMetrics('tenant-test');

      expect(metrics.grossMargin).toBeGreaterThan(0);
      expect(metrics.operatingMargin).toBeGreaterThan(0);
    });

    it('should have reasonable DSO/DPO values', async () => {
      const metrics = await service.calculateFinancialMetrics('tenant-test');

      expect(metrics.dso).toBeGreaterThan(0);
      expect(metrics.dso).toBeLessThan(365);
      expect(metrics.dpo).toBeGreaterThan(0);
      expect(metrics.dpo).toBeLessThan(365);
    });

    it('should have working capital', async () => {
      const metrics = await service.calculateFinancialMetrics('tenant-test');

      expect(typeof metrics.workingCapital).toBe('number');
    });
  });

  describe('getCashFlowForecast', () => {
    it('should return forecast for specified weeks', async () => {
      const forecast = await service.getCashFlowForecast('tenant-test', 8);

      expect(forecast.length).toBe(8);
    });

    it('should have closing balance equal to next period opening balance', async () => {
      const forecast = await service.getCashFlowForecast('tenant-test', 4);

      for (let i = 0; i < forecast.length - 1; i++) {
        expect(forecast[i].closingBalance).toBe(forecast[i + 1].openingBalance);
      }
    });

    it('should have inflow and outflow breakdowns', async () => {
      const forecast = await service.getCashFlowForecast('tenant-test', 2);

      forecast.forEach(period => {
        expect(period.inflows).toHaveProperty('total');
        expect(period.inflows).toHaveProperty('breakdown');
        expect(period.outflows).toHaveProperty('total');
        expect(period.outflows).toHaveProperty('breakdown');
      });
    });

    it('should calculate net cash flow correctly', async () => {
      const forecast = await service.getCashFlowForecast('tenant-test', 2);

      forecast.forEach(period => {
        const expectedNet = period.inflows.total - period.outflows.total;
        expect(period.netCashFlow).toBe(expectedNet);
      });
    });
  });

  // PR 6 T7: getPendingApprovals/approveItem/rejectItem moved off FinanceCentralService
  // to FinanceCentralOperatorService. Their coverage lives in the operator service's
  // own test suite (added in T8). Dashboard composition still asserted here via the
  // mocked operator service.

  describe('getGLAccounts', () => {
    it('should return all GL accounts', async () => {
      const accounts = await service.getGLAccounts('tenant-test');

      expect(accounts.length).toBeGreaterThan(0);
      accounts.forEach(account => {
        expect(account).toHaveProperty('id');
        expect(account).toHaveProperty('accountNumber');
        expect(account).toHaveProperty('name');
        expect(account).toHaveProperty('type');
        expect(account).toHaveProperty('balance');
      });
    });

    it('should filter by type', async () => {
      const assetAccounts = await service.getGLAccounts('tenant-test', { type: 'asset' });

      assetAccounts.forEach(account => {
        expect(account.type).toBe('asset');
      });
    });

    it('should filter by active status', async () => {
      const activeAccounts = await service.getGLAccounts('tenant-test', { isActive: true });

      activeAccounts.forEach(account => {
        expect(account.isActive).toBe(true);
      });
    });

    it('should sort by account number', async () => {
      const accounts = await service.getGLAccounts('tenant-test');

      for (let i = 0; i < accounts.length - 1; i++) {
        expect(accounts[i].accountNumber.localeCompare(accounts[i + 1].accountNumber)).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('getConsolidatedSummary', () => {
    it('should return consolidated summary', async () => {
      const summary = await service.getConsolidatedSummary('tenant-test');

      expect(summary).toHaveProperty('entities');
      expect(summary).toHaveProperty('consolidatedCash');
      expect(summary).toHaveProperty('consolidatedAR');
      expect(summary).toHaveProperty('consolidatedAP');
      expect(summary).toHaveProperty('intercompanyEliminations');
      expect(summary).toHaveProperty('totalRevenue');
      expect(summary).toHaveProperty('totalExpenses');
      expect(summary).toHaveProperty('consolidatedNetIncome');
    });

    it('should have entities', async () => {
      const summary = await service.getConsolidatedSummary('tenant-test');

      expect(summary.entities.length).toBeGreaterThan(0);
      summary.entities.forEach(entity => {
        expect(entity).toHaveProperty('id');
        expect(entity).toHaveProperty('name');
        expect(entity).toHaveProperty('type');
      });
    });

    it('should calculate consolidated net income correctly', async () => {
      const summary = await service.getConsolidatedSummary('tenant-test');

      expect(summary.consolidatedNetIncome).toBe(summary.totalRevenue - summary.totalExpenses);
    });
  });

  describe('getPeriodCloseStatus', () => {
    it('should return period close status', async () => {
      const status = await service.getPeriodCloseStatus();

      expect(status).toHaveProperty('periodId');
      expect(status).toHaveProperty('periodName');
      expect(status).toHaveProperty('startDate');
      expect(status).toHaveProperty('endDate');
      expect(status).toHaveProperty('status');
      expect(status).toHaveProperty('closeTasks');
      expect(status).toHaveProperty('percentComplete');
      expect(status).toHaveProperty('targetCloseDate');
    });

    it('should have close tasks', async () => {
      const status = await service.getPeriodCloseStatus();

      expect(status.closeTasks.length).toBeGreaterThan(0);
      status.closeTasks.forEach(task => {
        expect(task).toHaveProperty('id');
        expect(task).toHaveProperty('name');
        expect(task).toHaveProperty('category');
        expect(task).toHaveProperty('status');
        expect(task).toHaveProperty('assignee');
      });
    });

    it('should calculate percent complete correctly', async () => {
      const status = await service.getPeriodCloseStatus();

      const completedTasks = status.closeTasks.filter(t => t.status === 'completed').length;
      const expectedPercent = Math.round((completedTasks / status.closeTasks.length) * 100);
      expect(status.percentComplete).toBe(expectedPercent);
    });
  });

  describe('getFinancialDocuments', () => {
    it('should return all documents', async () => {
      const documents = await service.getFinancialDocuments('tenant-test');

      expect(documents.length).toBeGreaterThan(0);
    });

    it('should filter by type', async () => {
      const invoices = await service.getFinancialDocuments('tenant-test', { type: 'invoice' });

      invoices.forEach(doc => {
        expect(doc.type).toBe('invoice');
      });
    });

    it('should filter by status', async () => {
      const overdueDocuments = await service.getFinancialDocuments('tenant-test', { status: 'overdue' });

      overdueDocuments.forEach(doc => {
        expect(doc.status).toBe('overdue');
      });
    });

    it('should filter by amount range', async () => {
      const documents = await service.getFinancialDocuments('tenant-test', { minAmount: 50000, maxAmount: 100000 });

      documents.forEach(doc => {
        expect(doc.amount).toBeGreaterThanOrEqual(50000);
        expect(doc.amount).toBeLessThanOrEqual(100000);
      });
    });

    it('should sort by issue date descending', async () => {
      const documents = await service.getFinancialDocuments('tenant-test');

      for (let i = 0; i < documents.length - 1; i++) {
        expect(documents[i].issueDate).toBeGreaterThanOrEqual(documents[i + 1].issueDate);
      }
    });
  });

  describe('recordPayment', () => {
    it('should record payment on existing document', async () => {
      const documents = await service.getFinancialDocuments('tenant-test', { type: 'invoice', status: 'open' });
      const invoice = documents[0];

      const result = await service.recordPayment(
        'tenant-test',
        invoice.id,
        10000,
        Date.now(),
        'ACH',
        'PMT-001'
      );

      expect(result.success).toBe(true);
      expect(result.document).toBeDefined();
      expect(result.document!.amountPaid).toBe(10000);
      expect(result.document!.amountDue).toBe(invoice.amount - 10000);
    });

    it('should mark document as paid when fully paid', async () => {
      const documents = await service.getFinancialDocuments('tenant-test', { type: 'invoice', status: 'open' });
      const invoice = documents[0];

      const result = await service.recordPayment(
        'tenant-test',
        invoice.id,
        invoice.amountDue,
        Date.now(),
        'Wire',
        'PMT-002'
      );

      expect(result.success).toBe(true);
      expect(result.document!.status).toBe('paid');
      expect(result.document!.amountDue).toBe(0);
    });

    it('should mark document as partial when partially paid', async () => {
      const documents = await service.getFinancialDocuments('tenant-test', { type: 'invoice', status: 'open' });
      const invoice = documents[0];

      const partialAmount = invoice.amountDue / 2;
      const result = await service.recordPayment(
        'tenant-test',
        invoice.id,
        partialAmount,
        Date.now(),
        'Check',
        'PMT-003'
      );

      expect(result.success).toBe(true);
      expect(result.document!.status).toBe('partial');
    });

    it('should reject payment exceeding amount due', async () => {
      const documents = await service.getFinancialDocuments('tenant-test', { type: 'invoice', status: 'open' });
      const invoice = documents[0];

      const result = await service.recordPayment(
        'tenant-test',
        invoice.id,
        invoice.amountDue + 1000,
        Date.now(),
        'ACH'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('exceeds');
    });

    it('should return error for non-existent document', async () => {
      const result = await service.recordPayment(
        'tenant-test',
        'non-existent-id',
        1000,
        Date.now(),
        'ACH'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });
  });

  describe('financial ratio calculations', () => {
    it('should calculate DSO correctly', () => {
      const arBalance = 100000;
      const annualRevenue = 365000;

      const dso = service.calculateDSO(arBalance, annualRevenue);

      expect(dso).toBe(100); // 100000 / (365000/365) = 100 days
    });

    it('should handle zero revenue in DSO', () => {
      const dso = service.calculateDSO(100000, 0);
      expect(dso).toBe(0);
    });

    it('should calculate DPO correctly', () => {
      const apBalance = 50000;
      const annualCOGS = 182500;

      const dpo = service.calculateDPO(apBalance, annualCOGS);

      expect(dpo).toBe(100); // 50000 / (182500/365) = 100 days
    });

    it('should handle zero COGS in DPO', () => {
      const dpo = service.calculateDPO(50000, 0);
      expect(dpo).toBe(0);
    });

    it('should calculate current ratio correctly', () => {
      const currentRatio = service.calculateCurrentRatio(200000, 100000);

      expect(currentRatio).toBe(2);
    });

    it('should handle zero liabilities in current ratio', () => {
      const currentRatio = service.calculateCurrentRatio(200000, 0);
      expect(currentRatio).toBe(0);
    });

    it('should calculate quick ratio correctly', () => {
      const quickRatio = service.calculateQuickRatio(200000, 50000, 100000);

      expect(quickRatio).toBe(1.5); // (200000 - 50000) / 100000
    });

    it('should handle zero liabilities in quick ratio', () => {
      const quickRatio = service.calculateQuickRatio(200000, 50000, 0);
      expect(quickRatio).toBe(0);
    });
  });
});
