import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { TelemetryService } from './TelemetryService';
import type {
  DunningAgent,
  DunningOutput,
} from './ai/orchestrator/agents/DunningAgent';
import type {
  Invoice,
  InvoiceLineItem,
  InvoiceDispute,
  CreditMemo,
  InvoiceMatchResult,
  InvoiceFilters,
  InvoiceStatistics,
} from '../types/invoice';
import type {
  PaymentProcessor,
  ReconciliationReport,
  PaymentAnalytics,
  DunningSchedule,
  DunningEntry,
  DunningStatistics,
  GLAccount,
  JournalEntry,
  GLPostingBatch,
  GLPostingResult,
  GLPostingStatistics,
  PaymentTransactionFilters,
  PaymentTransactionListResult,
  DunningEntryFilters,
  DunningEntryListResult,
} from '../types/paymentCentral';
import {
  createPaymentCentralRuntime,
  type PaymentCentralRuntime,
} from './payment-central/PaymentCentralRuntime';
import { ProcessorService } from './payment-central/processors/ProcessorService';
import { TransactionService } from './payment-central/transactions/TransactionService';
import { ReconciliationService } from './payment-central/reconciliation/ReconciliationService';
import { PaymentAnalyticsService } from './payment-central/analytics/PaymentAnalyticsService';
import { DunningAgentAdapter } from './payment-central/dunning/DunningAgentAdapter';
import { DunningService } from './payment-central/dunning/DunningService';
import { GLPostingService } from './payment-central/gl/GLPostingService';
import { InvoiceMatchingService } from './payment-central/invoices/InvoiceMatchingService';

export * from '../types/paymentCentral';

/**
 * PaymentCentral Service - Multi-processor payment reconciliation and analytics
 * Supports Stripe, Adyen, PayPal, Worldpay, Braintree with Business Central integration
 * 
 * NOTE: This is a demo implementation with sample data.
 * Production implementation would integrate with actual payment processor APIs.
 */
@injectable()
export class PaymentCentralService {
  private readonly processorService: ProcessorService;
  private readonly transactionService: TransactionService;
  private readonly reconciliationService: ReconciliationService;
  private readonly analyticsService: PaymentAnalyticsService;
  private readonly dunningService: DunningService;
  private readonly glPostingService: GLPostingService;
  private readonly invoiceService: InvoiceMatchingService;

  private readonly runtime: PaymentCentralRuntime;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.TelemetryService) private telemetryService: TelemetryService,
    @optional() @inject(TYPES.DunningAgent) private dunningAgent?: DunningAgent,
    // Tests bind TYPES.PaymentCentralRuntime to a deterministic runtime via
    // `createDeterministicPaymentCentralRuntime` so seed data is reproducible.
    // Production leaves this unbound and falls through to the default factory.
    @optional() @inject(TYPES.PaymentCentralRuntime) runtimeOverride?: PaymentCentralRuntime,
  ) {
    this.runtime = runtimeOverride ?? createPaymentCentralRuntime(
      this.logger,
      this.telemetryService,
      this.dunningAgent,
    );
    this.processorService = new ProcessorService(this.runtime);
    this.transactionService = new TransactionService(this.processorService, this.runtime);
    this.processorService.seedDemo();
    this.transactionService.seedDemo();
    this.reconciliationService = new ReconciliationService(this.processorService, this.transactionService, this.runtime);
    this.analyticsService = new PaymentAnalyticsService(this.processorService, this.transactionService, this.runtime);
    const dunningAdapter = new DunningAgentAdapter(this.runtime);
    this.dunningService = new DunningService(this.runtime, dunningAdapter);
    this.dunningService.seedDemo();
    this.glPostingService = new GLPostingService(this.processorService, this.transactionService, this.runtime);
    this.glPostingService.seedDemo();
    this.invoiceService = new InvoiceMatchingService(this.runtime);
    this.logger.info('PaymentCentral demo data initialized', {
      hasDunningAgent: !!dunningAgent,
      processors: this.processorService.listProcessors().length,
      transactions: this.transactionService.listTransactions().length,
      glAccounts: this.glPostingService.glAccountCount(),
      journalEntries: this.glPostingService.journalEntryCount(),
    });
  }

  /**
   * Get all configured payment processors
   */
  async getPaymentProcessors(): Promise<PaymentProcessor[]> { return this.processorService.getPaymentProcessors(); }

  /**
   * Add or update a payment processor
   */
  async configureProcessor(processor: Omit<PaymentProcessor, 'id'>): Promise<string> { return this.processorService.configureProcessor(processor); }

  /**
   * Get payment transactions with filtering
   */
  async getTransactions(filters: PaymentTransactionFilters = {}): Promise<PaymentTransactionListResult> { return this.transactionService.getTransactions(filters); }

  /**
   * Sync transaction to Business Central
   */
  async syncTransactionToBusinessCentral(transactionId: string): Promise<{
    success: boolean;
    syncId?: string;
    error?: string;
  }> { return this.transactionService.syncTransactionToBusinessCentral(transactionId); }

  /**
   * Generate reconciliation report
   */
  async generateReconciliationReport(
    dateRange: { start: number; end: number },
    processorIds: string[] = []
  ): Promise<string> { return this.reconciliationService.generateReconciliationReport(dateRange, processorIds); }

  /**
   * Get reconciliation report
   */
  async getReconciliationReport(reportId: string): Promise<ReconciliationReport | null> {
    return this.reconciliationService.getReconciliationReport(reportId);
  }

  /**
   * Get payment analytics
   */
  async getPaymentAnalytics(
    timeRangeMs: number = 30 * 24 * 60 * 60 * 1000
  ): Promise<PaymentAnalytics> { return this.analyticsService.getPaymentAnalytics(timeRangeMs); }

  // ==================== DUNNING AUTOMATION METHODS ====================

  /**
   * Get all dunning schedules
   */
  async getDunningSchedules(): Promise<DunningSchedule[]> { return this.dunningService.getDunningSchedules(); }

  /**
   * Get a dunning schedule by ID
   */
  async getDunningSchedule(scheduleId: string): Promise<DunningSchedule | null> { return this.dunningService.getDunningSchedule(scheduleId); }

  /**
   * Create or update a dunning schedule
   */
  async saveDunningSchedule(schedule: Omit<DunningSchedule, 'id' | 'createdAt' | 'updatedAt'>): Promise<DunningSchedule> { return this.dunningService.saveDunningSchedule(schedule); }

  /**
   * Update a dunning schedule
   */
  async updateDunningSchedule(scheduleId: string, updates: Partial<DunningSchedule>): Promise<DunningSchedule | null> { return this.dunningService.updateDunningSchedule(scheduleId, updates); }

  /**
   * Delete a dunning schedule
   */
  async deleteDunningSchedule(scheduleId: string): Promise<boolean> { return this.dunningService.deleteDunningSchedule(scheduleId); }

  /**
   * Get dunning entries with filtering
   */
  async getDunningEntries(filters: DunningEntryFilters = {}): Promise<DunningEntryListResult> { return this.dunningService.getDunningEntries(filters); }

  /**
   * Get a single dunning entry by ID
   */
  async getDunningEntry(entryId: string): Promise<DunningEntry | null> { return this.dunningService.getDunningEntry(entryId); }

  /**
   * Analyze a dunning entry with AI (preview mode - no state mutation)
   * Returns AI recommendations without sending or modifying the entry
   */
  async analyzeDunningEntry(entryId: string): Promise<{
    success: boolean;
    message: string;
    aiAnalysis?: DunningOutput;
  }> { return this.dunningService.analyzeDunningEntry(entryId); }

  /**
   * Send a dunning reminder for an entry
   * Uses DunningAgent for AI-powered message generation when available
   */
  async sendDunningReminder(entryId: string): Promise<{
    success: boolean;
    message: string;
    aiAnalysis?: DunningOutput;
  }> { return this.dunningService.sendDunningReminder(entryId); }

  /**
   * Pause dunning for an entry
   */
  async pauseDunning(entryId: string, reason: string): Promise<DunningEntry | null> { return this.dunningService.pauseDunning(entryId, reason); }

  /**
   * Resume dunning for a paused entry
   */
  async resumeDunning(entryId: string): Promise<DunningEntry | null> { return this.dunningService.resumeDunning(entryId); }

  /**
   * Mark an entry as paid
   */
  async markDunningPaid(entryId: string, paymentAmount: number): Promise<DunningEntry | null> { return this.dunningService.markDunningPaid(entryId, paymentAmount); }

  /**
   * Escalate an entry to collections
   */
  async escalateToCollections(entryId: string): Promise<DunningEntry | null> { return this.dunningService.escalateToCollections(entryId); }

  /**
   * Get dunning statistics
   */
  async getDunningStatistics(): Promise<DunningStatistics> { return this.dunningService.getDunningStatistics(); }

  /**
   * Process all pending dunning entries (batch operation)
   * In production, this would be triggered by a scheduled job
   */
  async processPendingDunning(): Promise<{
    processed: number;
    sent: number;
    escalated: number;
    paused: number;
    paymentPlans: number;
  }> { return this.dunningService.processPendingDunning(); }

  // ==================== GL POSTING METHODS ====================

  /**
   * Get all GL accounts (chart of accounts)
   */
  async getGLAccounts(filters: {
    type?: GLAccount['type'];
    isActive?: boolean;
    search?: string;
  } = {}): Promise<GLAccount[]> { return this.glPostingService.getGLAccounts(filters); }

  /**
   * Get a GL account by ID
   */
  async getGLAccount(accountId: string): Promise<GLAccount | null> { return this.glPostingService.getGLAccount(accountId); }

  /**
   * Get journal entries with filtering
   */
  async getJournalEntries(filters: {
    status?: JournalEntry['status'][];
    sourceType?: JournalEntry['sourceType'][];
    dateRange?: { start: number; end: number };
    syncStatus?: JournalEntry['syncStatus'][];
    limit?: number;
    offset?: number;
  } = {}): Promise<{ entries: JournalEntry[]; totalCount: number }> { return this.glPostingService.getJournalEntries(filters); }

  /**
   * Get a journal entry by ID
   */
  async getJournalEntry(entryId: string): Promise<JournalEntry | null> { return this.glPostingService.getJournalEntry(entryId); }

  /**
   * Create a journal entry from a transaction
   */
  async createJournalEntryFromTransaction(transactionId: string): Promise<GLPostingResult> { return this.glPostingService.createJournalEntryFromTransaction(transactionId); }

  /**
   * Approve a journal entry
   */
  async approveJournalEntry(entryId: string, approvedBy: string): Promise<JournalEntry | null> { return this.glPostingService.approveJournalEntry(entryId, approvedBy); }

  /**
   * Post a journal entry (sync to NetSuite)
   */
  async postJournalEntry(entryId: string, postedBy: string): Promise<GLPostingResult> { return this.glPostingService.postJournalEntry(entryId, postedBy); }

  /**
   * Void a journal entry
   */
  async voidJournalEntry(entryId: string, reason: string): Promise<JournalEntry | null> { return this.glPostingService.voidJournalEntry(entryId, reason); }

  /**
   * Create a posting batch
   */
  async createPostingBatch(
    name: string,
    entryIds: string[],
    createdBy: string
  ): Promise<GLPostingBatch> { return this.glPostingService.createPostingBatch(name, entryIds, createdBy); }

  /**
   * Process a posting batch
   */
  async processPostingBatch(batchId: string, processedBy: string): Promise<GLPostingBatch> { return this.glPostingService.processPostingBatch(batchId, processedBy); }

  /**
   * Get posting batches
   */
  async getPostingBatches(filters: {
    status?: GLPostingBatch['status'][];
    limit?: number;
    offset?: number;
  } = {}): Promise<{ batches: GLPostingBatch[]; totalCount: number }> { return this.glPostingService.getPostingBatches(filters); }

  /**
   * Get a posting batch by ID
   */
  async getPostingBatch(batchId: string): Promise<GLPostingBatch | null> { return this.glPostingService.getPostingBatch(batchId); }

  /**
   * Get GL posting statistics
   */
  async getGLPostingStatistics(): Promise<GLPostingStatistics> { return this.glPostingService.getGLPostingStatistics(); }

  /**
   * Get GL posting dashboard summary
   */
  async getGLPostingDashboard(): Promise<Record<string, unknown>> { return this.glPostingService.getGLPostingDashboard(); }

  // ==================== INVOICE MATCHING METHODS ====================

  /**
   * Create a new invoice
   */
  async createInvoice(
    tenantId: string,
    vendorId: string,
    invoiceData: {
      invoiceNumber: string;
      invoiceDate: number;
      dueDate: number;
      amount: number;
      taxAmount?: number;
      currency?: string;
      lineItems: Omit<InvoiceLineItem, 'lineNumber'>[];
      notes?: string;
      attachmentUrls?: string[];
      source?: 'manual' | 'upload' | 'edi' | 'api' | 'email';
    },
    createdBy = 'system'
  ): Promise<Invoice> { return this.invoiceService.createInvoice(tenantId, vendorId, invoiceData, createdBy); }

  /**
   * Get invoice by ID
   */
  async getInvoice(tenantId: string, invoiceId: string): Promise<Invoice | null> { return this.invoiceService.getInvoice(tenantId, invoiceId); }

  /**
   * Get invoices with filtering
   */
  async getInvoices(tenantId: string, filters: InvoiceFilters = {}): Promise<{
    invoices: Invoice[];
    totalCount: number;
  }> { return this.invoiceService.getInvoices(tenantId, filters); }

  /**
   * Match invoice to PO (2-way matching)
   */
  async matchInvoiceToPO(
    tenantId: string,
    invoiceId: string,
    poId: string,
    matchedBy = 'system'
  ): Promise<{
    success: boolean;
    matchResult?: InvoiceMatchResult;
    error?: string;
  }> { return this.invoiceService.matchInvoiceToPO(tenantId, invoiceId, poId, matchedBy); }

  /**
   * Auto-match invoice using heuristics
   */
  async autoMatchInvoice(tenantId: string, invoiceId: string): Promise<{
    success: boolean;
    matchResult?: InvoiceMatchResult;
    candidates?: { poId: string; confidence: number }[];
    error?: string;
  }> { return this.invoiceService.autoMatchInvoice(tenantId, invoiceId); }

  /**
   * Approve a matched invoice for payment
   */
  async approveInvoice(
    tenantId: string,
    invoiceId: string,
    approvedBy: string
  ): Promise<{ success: boolean; error?: string }> { return this.invoiceService.approveInvoice(tenantId, invoiceId, approvedBy); }

  /**
   * Create a dispute for an invoice
   */
  async createInvoiceDispute(
    tenantId: string,
    invoiceId: string,
    reason: InvoiceDispute['reason'],
    description: string,
    createdBy: string
  ): Promise<{ success: boolean; dispute?: InvoiceDispute; error?: string }> { return this.invoiceService.createInvoiceDispute(tenantId, invoiceId, reason, description, createdBy); }

  /**
   * Resolve an invoice dispute
   */
  async resolveDispute(
    tenantId: string,
    disputeId: string,
    resolution: {
      type: 'credit_memo' | 'price_adjustment' | 'quantity_adjustment' | 'invoice_cancelled' | 'invoice_approved' | 'other';
      description: string;
      adjustedAmount?: number;
    },
    resolvedBy: string
  ): Promise<{ success: boolean; creditMemo?: CreditMemo; error?: string }> { return this.invoiceService.resolveDispute(tenantId, disputeId, resolution, resolvedBy); }

  /**
   * Create a credit memo
   */
  async createCreditMemo(
    tenantId: string,
    invoiceId: string,
    amount: number,
    reason: string,
    createdBy: string,
    disputeId?: string
  ): Promise<CreditMemo> { return this.invoiceService.createCreditMemo(tenantId, invoiceId, amount, reason, createdBy, disputeId); }

  /**
   * Get invoice disputes
   */
  async getDisputes(tenantId: string, filters: {
    status?: InvoiceDispute['status'][];
    vendorId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ disputes: InvoiceDispute[]; totalCount: number }> { return this.invoiceService.getDisputes(tenantId, filters); }

  /**
   * Get credit memos
   */
  async getCreditMemos(tenantId: string, filters: {
    vendorId?: string;
    status?: CreditMemo['status'][];
    limit?: number;
    offset?: number;
  } = {}): Promise<{ creditMemos: CreditMemo[]; totalCount: number }> { return this.invoiceService.getCreditMemos(tenantId, filters); }

  /**
   * Get invoice statistics
   */
  async getInvoiceStatistics(tenantId: string): Promise<InvoiceStatistics> { return this.invoiceService.getInvoiceStatistics(tenantId); }
}