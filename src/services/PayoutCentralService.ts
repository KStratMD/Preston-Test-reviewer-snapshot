import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { squireProjects, squireInstallers } from '../data/squireMockData';

/**
 * NetSuite commission record structure
 */
export interface NetSuiteCommissionRecord {
  internalId: string;
  affiliateId: string;
  affiliateName: string;
  salesOrderId: string;
  salesOrderNumber: string;
  commissionAmount: number;
  commissionRate: number;
  baseAmount: number;
  status: 'pending' | 'approved' | 'paid' | 'disputed';
  periodStart: number;
  periodEnd: number;
  createdDate: number;
  netSuiteLink?: string;
}

/**
 * Commission period for fetching
 */
export interface CommissionPeriod {
  periodId: string;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed' | 'processing';
}

/**
 * Tax withholding information
 */
export interface TaxWithholding {
  federalWithholding: number;
  stateWithholding: number;
  localWithholding: number;
  totalWithholding: number;
  effectiveRate: number;
}

/**
 * 1099 stub data for tax reporting
 */
export interface Form1099Stub {
  affiliateId: string;
  affiliateName: string;
  taxId: string;
  taxYear: number;
  totalEarnings: number;
  totalWithholding: number;
  netPayout: number;
  box1NonemployeeCompensation: number;
  box4FederalTaxWithheld: number;
  periodsCovered: string[];
  generated: boolean;
  generatedDate?: number;
}

/**
 * Payout calculation request
 */
export interface PayoutCalculationRequest {
  affiliateId: string;
  periodId: string;
  includeWithholding?: boolean;
  paymentMethod?: 'paypal' | 'payquicker' | 'ach' | 'check';
}

/**
 * Calculated payout details
 */
export interface PayoutCalculation {
  affiliateId: string;
  affiliateName: string;
  periodId: string;
  commissions: NetSuiteCommissionRecord[];
  grossAmount: number;
  taxWithholding: TaxWithholding;
  netAmount: number;
  paymentMethod: string;
  estimatedArrival: string;
  fees: {
    processingFee: number;
    platformFee: number;
    total: number;
  };
  finalAmount: number;
}

/**
 * Payout execution request
 */
export interface PayoutExecutionRequest {
  affiliateId: string;
  amount: number;
  paymentMethod: 'paypal' | 'payquicker' | 'ach' | 'check';
  paymentDetails: {
    paypalEmail?: string;
    payquickerId?: string;
    bankAccount?: string;
    routingNumber?: string;
    mailingAddress?: string;
  };
  reference?: string;
}

/**
 * Payout execution result
 */
export interface PayoutExecutionResult {
  success: boolean;
  payoutId: string;
  affiliateId: string;
  amount: number;
  paymentMethod: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  transactionId?: string;
  errorMessage?: string;
  timestamp: number;
  estimatedArrival?: string;
}

/**
 * Payout history record
 */
export interface PayoutHistoryRecord {
  payoutId: string;
  affiliateId: string;
  amount: number;
  paymentMethod: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  transactionId?: string;
  processedDate: number;
  periodId: string;
  commissionCount: number;
}

/**
 * Dashboard metrics for PayoutCentral
 */
export interface PayoutDashboardMetrics {
  summary: {
    pendingPayouts: number;
    processedToday: number;
    failedPayments: number;
    totalPendingAmount: number;
  };
  metrics: {
    totalPayoutsThisMonth: number;
    totalAmountThisMonth: number;
    avgPayoutAmount: number;
    successRate: number;
    paypalPayouts: number;
    payquickerPayouts: number;
    achPayouts: number;
    processingTime: string;
  };
  payoutsByMethod: Record<string, {
    count: number;
    amount: number;
    percentage: number;
  }>;
  recentPayouts: {
    id: string;
    affiliate: string;
    amount: number;
    method: string;
    status: string;
    timestamp: number;
  }[];
  failedPayouts: {
    id: string;
    affiliate: string;
    amount: number;
    reason: string;
    attempts: number;
  }[];
}

/**
 * Mock affiliate data (would come from database in production)
 */
const MOCK_AFFILIATES: Record<string, { name: string; taxId: string; paypalEmail?: string; payquickerId?: string }> = {
  'SQ_INST_001': { name: 'Thompson Professional Installs', taxId: '12-3456789', paypalEmail: 'alex@thompsoninstalls.com' },
  'SQ_INST_002': { name: 'Precision Install Services', taxId: '98-7654321', paypalEmail: 'maria@precisioninstalls.com' },
  'SQ_INST_003': { name: 'Elite Installation Co', taxId: '45-6789012', payquickerId: 'PQ-ELITE-001' },
};

/**
 * PayoutCentralService handles affiliate/partner payouts via PayPal, PayQuicker, and other methods
 * Integrates with NetSuite for commission data and supports 1099 tax reporting
 */
@injectable()
export class PayoutCentralService {
  private readonly payoutHistory: PayoutHistoryRecord[] = [];
  private payoutCounter = 1000;

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('PayoutCentralService initialized');
  }

  /**
   * Fetch commission records from NetSuite for a given period
   * In production, this would call the NetSuite connector
   */
  public async fetchNetSuiteCommissions(periodId: string): Promise<NetSuiteCommissionRecord[]> {
    this.logger.info('Fetching NetSuite commissions', { periodId });

    // Parse period dates from periodId (format: YYYY-MM)
    // Use UTC to avoid timezone boundary issues with date-only strings
    const [year, month] = periodId.split('-').map(Number);
    const periodStart = Date.UTC(year, month - 1, 1);
    const periodEnd = Date.UTC(year, month, 0, 23, 59, 59, 999);

    // Convert squire projects to commission records
    const commissions: NetSuiteCommissionRecord[] = [];

    for (const project of squireProjects) {
      // Only include completed projects
      if (project.projectStatus !== 'Completed') continue;

      // Filter by completion date within the requested period
      if (project.completionDate) {
        let completionTime: number;
        if (typeof project.completionDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(project.completionDate)) {
          const [cYear, cMonth, cDay] = project.completionDate.split('-').map(Number);
          completionTime = Date.UTC(cYear, cMonth - 1, cDay);
        } else {
          completionTime = new Date(project.completionDate).getTime();
        }
        // Guard against invalid dates (NaN) - skip records with unparseable dates
        if (Number.isNaN(completionTime)) continue;
        if (completionTime < periodStart || completionTime > periodEnd) continue;
      }

      const installer = squireInstallers.find(i => i.id === project.assignedInstaller);
      if (!installer) continue;

      const commissionAmount = project.projectValue * project.commissionRate;

      commissions.push({
        internalId: `COMM-${project.id}`,
        affiliateId: project.assignedInstaller,
        affiliateName: installer.businessName,
        salesOrderId: project.squireProjectId,
        salesOrderNumber: project.projectNumber,
        commissionAmount,
        commissionRate: project.commissionRate,
        baseAmount: project.projectValue,
        status: project.payoutStatus === 'Paid' ? 'paid' : 'pending',
        periodStart,
        periodEnd,
        createdDate: Date.now(),
        netSuiteLink: `/app/common/search/searchresults.nl?rectype=customrecord_commission&id=${project.id}`,
      });
    }

    this.logger.info('NetSuite commissions fetched telemetry', {
      periodId,
      count: commissions.length,
      totalAmount: commissions.reduce((sum, c) => sum + c.commissionAmount, 0),
    });

    return commissions;
  }

  /**
   * Get available commission periods
   */
  public async getCommissionPeriods(): Promise<CommissionPeriod[]> {
    const now = new Date();
    const periods: CommissionPeriod[] = [];

    // Generate last 6 months of periods
    for (let i = 0; i < 6; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const periodId = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);

      periods.push({
        periodId,
        startDate: date.toISOString().split('T')[0],
        endDate: endOfMonth.toISOString().split('T')[0],
        status: i === 0 ? 'open' : 'closed',
      });
    }

    return periods;
  }

  /**
   * Calculate tax withholding for a payout amount
   * In production, this would use actual tax tables and affiliate tax status
   */
  private calculateTaxWithholding(amount: number, affiliateId: string): TaxWithholding {
    // Simplified withholding calculation
    // In production: consider W-9 status, tax treaties, state of residence, etc.
    const federalRate = 0.24; // Backup withholding rate
    const stateRate = 0.05;
    const localRate = 0.0;

    const federalWithholding = Math.round(amount * federalRate * 100) / 100;
    const stateWithholding = Math.round(amount * stateRate * 100) / 100;
    const localWithholding = Math.round(amount * localRate * 100) / 100;
    const totalWithholding = federalWithholding + stateWithholding + localWithholding;

    return {
      federalWithholding,
      stateWithholding,
      localWithholding,
      totalWithholding,
      effectiveRate: amount > 0 ? Math.round((totalWithholding / amount) * 10000) / 100 : 0,
    };
  }

  /**
   * Calculate processing fees for a payment method
   */
  private calculateFees(amount: number, method: string): { processingFee: number; platformFee: number; total: number } {
    let processingFee = 0;
    const platformFee = Math.round(amount * 0.005 * 100) / 100; // 0.5% platform fee

    switch (method) {
      case 'paypal':
        processingFee = Math.round((amount * 0.029 + 0.30) * 100) / 100; // 2.9% + $0.30
        break;
      case 'payquicker':
        processingFee = Math.round(amount * 0.015 * 100) / 100; // 1.5%
        break;
      case 'ach':
        processingFee = Math.min(5.00, Math.round(amount * 0.008 * 100) / 100); // 0.8% up to $5
        break;
      case 'check':
        processingFee = 2.50; // Flat fee
        break;
    }

    return {
      processingFee,
      platformFee,
      total: Math.round((processingFee + platformFee) * 100) / 100,
    };
  }

  /**
   * Calculate payout for an affiliate
   */
  public async calculatePayout(request: PayoutCalculationRequest): Promise<PayoutCalculation> {
    const { affiliateId, periodId, includeWithholding = true, paymentMethod = 'paypal' } = request;

    this.logger.info('Calculating payout', { affiliateId, periodId });

    // Fetch commissions for this affiliate and period
    const allCommissions = await this.fetchNetSuiteCommissions(periodId);
    const affiliateCommissions = allCommissions.filter(c => c.affiliateId === affiliateId && c.status === 'pending');

    const affiliate = MOCK_AFFILIATES[affiliateId] || { name: 'Unknown Affiliate', taxId: '00-0000000' };
    const grossAmount = affiliateCommissions.reduce((sum, c) => sum + c.commissionAmount, 0);

    const taxWithholding = includeWithholding
      ? this.calculateTaxWithholding(grossAmount, affiliateId)
      : { federalWithholding: 0, stateWithholding: 0, localWithholding: 0, totalWithholding: 0, effectiveRate: 0 };

    const netAmount = grossAmount - taxWithholding.totalWithholding;
    const fees = this.calculateFees(netAmount, paymentMethod);
    const finalAmount = Math.round((netAmount - fees.total) * 100) / 100;

    // Estimate arrival time based on payment method
    let estimatedArrival: string;
    switch (paymentMethod) {
      case 'paypal':
        estimatedArrival = 'Instant to 1 business day';
        break;
      case 'payquicker':
        estimatedArrival = '1-2 business days';
        break;
      case 'ach':
        estimatedArrival = '3-5 business days';
        break;
      case 'check':
        estimatedArrival = '7-10 business days';
        break;
      default:
        estimatedArrival = '1-3 business days';
    }

    this.logger.info('Payout calculated telemetry', {
      affiliateId,
      periodId,
      grossAmount,
      netAmount,
      finalAmount,
      paymentMethod,
    });

    return {
      affiliateId,
      affiliateName: affiliate.name,
      periodId,
      commissions: affiliateCommissions,
      grossAmount: Math.round(grossAmount * 100) / 100,
      taxWithholding,
      netAmount: Math.round(netAmount * 100) / 100,
      paymentMethod,
      estimatedArrival,
      fees,
      finalAmount,
    };
  }

  /**
   * Execute a payout via PayPal or PayQuicker
   * In production, this would call the actual payment connectors
   */
  public async executePayout(request: PayoutExecutionRequest): Promise<PayoutExecutionResult> {
    const { affiliateId, amount, paymentMethod, paymentDetails, reference } = request;

    this.logger.info('Executing payout', { affiliateId, amount, paymentMethod });

    // Validate payment details
    if (paymentMethod === 'paypal' && !paymentDetails.paypalEmail) {
      return {
        success: false,
        payoutId: '',
        affiliateId,
        amount,
        paymentMethod,
        status: 'failed',
        errorMessage: 'PayPal email is required for PayPal payouts',
        timestamp: Date.now(),
      };
    }

    if (paymentMethod === 'payquicker' && !paymentDetails.payquickerId) {
      return {
        success: false,
        payoutId: '',
        affiliateId,
        amount,
        paymentMethod,
        status: 'failed',
        errorMessage: 'PayQuicker ID is required for PayQuicker payouts',
        timestamp: Date.now(),
      };
    }

    // Generate payout ID
    const payoutId = `PO-${new Date().getFullYear()}-${++this.payoutCounter}`;

    // Simulate payment processing (in production, call actual payment API)
    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`;

    // Add to history
    this.payoutHistory.push({
      payoutId,
      affiliateId,
      amount,
      paymentMethod,
      status: 'completed',
      transactionId,
      processedDate: Date.now(),
      periodId: reference || 'manual',
      commissionCount: 1,
    });

    this.logger.info('Payout executed telemetry', {
      payoutId,
      affiliateId,
      amount,
      paymentMethod,
      transactionId,
    });

    this.logger.info('Payout executed successfully', { payoutId, transactionId });

    return {
      success: true,
      payoutId,
      affiliateId,
      amount,
      paymentMethod,
      status: 'completed',
      transactionId,
      timestamp: Date.now(),
      estimatedArrival: paymentMethod === 'paypal' ? 'Instant' : '1-3 business days',
    };
  }

  /**
   * Get payout history for an affiliate
   */
  public async getPayoutHistory(affiliateId: string): Promise<PayoutHistoryRecord[]> {
    return this.payoutHistory.filter(p => p.affiliateId === affiliateId);
  }

  /**
   * Generate 1099 stub data for tax reporting
   */
  public async generate1099Stub(affiliateId: string, taxYear: number): Promise<Form1099Stub> {
    this.logger.info('Generating 1099 stub', { affiliateId, taxYear });

    const affiliate = MOCK_AFFILIATES[affiliateId];
    if (!affiliate) {
      throw new Error(`Affiliate ${affiliateId} not found`);
    }

    // Calculate total earnings for the year from payout history
    const yearPayouts = this.payoutHistory.filter(p =>
      p.affiliateId === affiliateId &&
      new Date(p.processedDate).getFullYear() === taxYear
    );

    const totalEarnings = yearPayouts.reduce((sum, p) => sum + p.amount, 0);
    const taxWithholding = this.calculateTaxWithholding(totalEarnings, affiliateId);

    // Get unique periods covered
    const periodsCovered = [...new Set(yearPayouts.map(p => p.periodId))].filter(p => p !== 'manual');

    return {
      affiliateId,
      affiliateName: affiliate.name,
      taxId: affiliate.taxId,
      taxYear,
      totalEarnings: Math.round(totalEarnings * 100) / 100,
      totalWithholding: Math.round(taxWithholding.totalWithholding * 100) / 100,
      netPayout: Math.round((totalEarnings - taxWithholding.totalWithholding) * 100) / 100,
      box1NonemployeeCompensation: Math.round(totalEarnings * 100) / 100,
      box4FederalTaxWithheld: Math.round(taxWithholding.federalWithholding * 100) / 100,
      periodsCovered,
      generated: true,
      generatedDate: Date.now(),
    };
  }

  /**
   * Get dashboard metrics with live data
   */
  public async getDashboardMetrics(): Promise<PayoutDashboardMetrics> {
    // Get all commissions for current period
    const now = new Date();
    const currentPeriodId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const commissions = await this.fetchNetSuiteCommissions(currentPeriodId);

    const pendingCommissions = commissions.filter(c => c.status === 'pending');
    const totalPendingAmount = pendingCommissions.reduce((sum, c) => sum + c.commissionAmount, 0);

    // Calculate metrics from history
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthPayouts = this.payoutHistory.filter(p => p.processedDate >= monthStart);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayPayouts = this.payoutHistory.filter(p => p.processedDate >= todayStart);
    const failedPayouts = this.payoutHistory.filter(p => p.status === 'failed');

    const totalAmountThisMonth = monthPayouts.reduce((sum, p) => sum + p.amount, 0);
    const avgPayoutAmount = monthPayouts.length > 0 ? totalAmountThisMonth / monthPayouts.length : 0;

    // Count by method
    const paypalPayouts = monthPayouts.filter(p => p.paymentMethod === 'paypal').length;
    const payquickerPayouts = monthPayouts.filter(p => p.paymentMethod === 'payquicker').length;
    const achPayouts = monthPayouts.filter(p => p.paymentMethod === 'ach').length;

    // Calculate percentages
    const totalMethodCount = paypalPayouts + payquickerPayouts + achPayouts || 1;
    const paypalAmount = monthPayouts.filter(p => p.paymentMethod === 'paypal').reduce((sum, p) => sum + p.amount, 0);
    const payquickerAmount = monthPayouts.filter(p => p.paymentMethod === 'payquicker').reduce((sum, p) => sum + p.amount, 0);
    const achAmount = monthPayouts.filter(p => p.paymentMethod === 'ach').reduce((sum, p) => sum + p.amount, 0);

    // Recent payouts (last 5)
    const recentPayouts = [...this.payoutHistory]
      .sort((a, b) => b.processedDate - a.processedDate)
      .slice(0, 5)
      .map(p => ({
        id: p.payoutId,
        affiliate: MOCK_AFFILIATES[p.affiliateId]?.name || 'Unknown',
        amount: p.amount,
        method: p.paymentMethod,
        status: p.status,
        timestamp: p.processedDate,
      }));

    return {
      summary: {
        pendingPayouts: pendingCommissions.length,
        processedToday: todayPayouts.length,
        failedPayments: failedPayouts.length,
        totalPendingAmount: Math.round(totalPendingAmount * 100) / 100,
      },
      metrics: {
        totalPayoutsThisMonth: monthPayouts.length,
        totalAmountThisMonth: Math.round(totalAmountThisMonth * 100) / 100,
        avgPayoutAmount: Math.round(avgPayoutAmount * 100) / 100,
        successRate: monthPayouts.length > 0
          ? Math.round((monthPayouts.filter(p => p.status === 'completed').length / monthPayouts.length) * 1000) / 10
          : 100,
        paypalPayouts,
        payquickerPayouts,
        achPayouts,
        processingTime: '1.2 hrs',
      },
      payoutsByMethod: {
        paypal: {
          count: paypalPayouts,
          amount: Math.round(paypalAmount * 100) / 100,
          percentage: Math.round((paypalPayouts / totalMethodCount) * 1000) / 10,
        },
        payquicker: {
          count: payquickerPayouts,
          amount: Math.round(payquickerAmount * 100) / 100,
          percentage: Math.round((payquickerPayouts / totalMethodCount) * 1000) / 10,
        },
        ach: {
          count: achPayouts,
          amount: Math.round(achAmount * 100) / 100,
          percentage: Math.round((achPayouts / totalMethodCount) * 1000) / 10,
        },
      },
      recentPayouts,
      failedPayouts: failedPayouts.slice(0, 5).map(p => ({
        id: p.payoutId,
        affiliate: MOCK_AFFILIATES[p.affiliateId]?.name || 'Unknown',
        amount: p.amount,
        reason: 'Payment processing error',
        attempts: 1,
      })),
    };
  }
}
