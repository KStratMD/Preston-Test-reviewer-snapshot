import type {
  GLAccount,
  JournalEntryLine,
  JournalEntry,
  GLPostingBatch,
  GLPostingResult,
  GLPostingStatistics,
} from '../../../types/paymentCentral';
import type { PaymentCentralRuntime } from '../PaymentCentralRuntime';
import type { ProcessorReader, TransactionReader } from '../ports';

export class GLPostingService {
  private glAccounts = new Map<string, GLAccount>();
  private journalEntries = new Map<string, JournalEntry>();
  private postingBatches = new Map<string, GLPostingBatch>();

  constructor(
    private readonly processorReader: ProcessorReader,
    private readonly transactionReader: TransactionReader,
    private readonly runtime: PaymentCentralRuntime,
  ) {}

  /**
   * Seed GL demo data: chart of accounts + sample journal entries from transactions.
   */
  seedDemo(): void {
    // Create standard chart of accounts for payment processing
    const accounts: Omit<GLAccount, 'id'>[] = [
      // Asset accounts
      { accountNumber: '1000', name: 'Cash - Operating', type: 'asset', subType: 'bank', currency: 'USD', isActive: true },
      { accountNumber: '1010', name: 'Cash - Stripe', type: 'asset', subType: 'bank', currency: 'USD', isActive: true },
      { accountNumber: '1011', name: 'Cash - Adyen', type: 'asset', subType: 'bank', currency: 'USD', isActive: true },
      { accountNumber: '1012', name: 'Cash - PayPal', type: 'asset', subType: 'bank', currency: 'USD', isActive: true },
      { accountNumber: '1100', name: 'Accounts Receivable', type: 'asset', subType: 'receivable', currency: 'USD', isActive: true },
      { accountNumber: '1150', name: 'Undeposited Funds', type: 'asset', subType: 'other', currency: 'USD', isActive: true },
      // Liability accounts
      { accountNumber: '2000', name: 'Accounts Payable', type: 'liability', subType: 'payable', currency: 'USD', isActive: true },
      { accountNumber: '2100', name: 'Customer Deposits', type: 'liability', subType: 'deferred', currency: 'USD', isActive: true },
      { accountNumber: '2200', name: 'Sales Tax Payable', type: 'liability', subType: 'tax', currency: 'USD', isActive: true },
      { accountNumber: '2300', name: 'Refunds Payable', type: 'liability', subType: 'payable', currency: 'USD', isActive: true },
      // Revenue accounts
      { accountNumber: '4000', name: 'Sales Revenue', type: 'revenue', currency: 'USD', isActive: true },
      { accountNumber: '4010', name: 'Product Sales', type: 'revenue', currency: 'USD', isActive: true },
      { accountNumber: '4020', name: 'Service Revenue', type: 'revenue', currency: 'USD', isActive: true },
      { accountNumber: '4100', name: 'Shipping Revenue', type: 'revenue', currency: 'USD', isActive: true },
      { accountNumber: '4900', name: 'Other Income', type: 'revenue', currency: 'USD', isActive: true },
      // Expense accounts
      { accountNumber: '5000', name: 'Cost of Goods Sold', type: 'expense', currency: 'USD', isActive: true },
      { accountNumber: '6100', name: 'Payment Processing Fees', type: 'expense', currency: 'USD', isActive: true },
      { accountNumber: '6110', name: 'Stripe Fees', type: 'expense', currency: 'USD', isActive: true },
      { accountNumber: '6111', name: 'Adyen Fees', type: 'expense', currency: 'USD', isActive: true },
      { accountNumber: '6112', name: 'PayPal Fees', type: 'expense', currency: 'USD', isActive: true },
      { accountNumber: '6200', name: 'Bank Fees', type: 'expense', currency: 'USD', isActive: true },
      { accountNumber: '6300', name: 'Chargeback Losses', type: 'expense', currency: 'USD', isActive: true },
    ];

    for (const account of accounts) {
      const id = `gl_${account.accountNumber}`;
      this.glAccounts.set(id, { ...account, id });
    }

    // Create sample journal entries from recent transactions
    const transactions = Array.from(this.transactionReader.listTransactions()).slice(0, 50);

    for (let i = 0; i < transactions.length; i++) {
      const txn = transactions[i];
      if (!txn) continue;

      const entryId = `je_${this.runtime.now()}_${i}_${this.runtime.random().toString(36).slice(2, 2 + 6)}`;
      const processorAccount = this.getProcessorCashAccount(txn.processorId);
      const feeAccount = this.getProcessorFeeAccount(txn.processorId);

      const lines: JournalEntryLine[] = [];
      let lineNum = 1;

      if (txn.type === 'payment') {
        // Debit: Cash (processor account)
        lines.push({
          lineNumber: lineNum++,
          accountId: processorAccount.id,
          accountNumber: processorAccount.accountNumber,
          accountName: processorAccount.name,
          debit: txn.amount - txn.fees.total,
          credit: 0,
          memo: `Payment received - ${txn.processorTransactionId}`,
          entity: txn.customer.id ? {
            type: 'customer',
            id: txn.customer.id,
            name: txn.customer.name || 'Unknown Customer',
          } : undefined,
        });
        // Debit: Processing fees
        lines.push({
          lineNumber: lineNum++,
          accountId: feeAccount.id,
          accountNumber: feeAccount.accountNumber,
          accountName: feeAccount.name,
          debit: txn.fees.total,
          credit: 0,
          memo: 'Processing fees',
        });
        // Credit: Revenue
        lines.push({
          lineNumber: lineNum,
          accountId: 'gl_4010',
          accountNumber: '4010',
          accountName: 'Product Sales',
          debit: 0,
          credit: txn.amount,
          memo: `Sale - ${txn.processorTransactionId}`,
        });
      } else if (txn.type === 'refund') {
        // Debit: Refunds payable / Revenue reversal
        lines.push({
          lineNumber: lineNum++,
          accountId: 'gl_4010',
          accountNumber: '4010',
          accountName: 'Product Sales',
          debit: txn.amount,
          credit: 0,
          memo: `Refund - ${txn.processorTransactionId}`,
        });
        // Credit: Cash (processor account)
        lines.push({
          lineNumber: lineNum,
          accountId: processorAccount.id,
          accountNumber: processorAccount.accountNumber,
          accountName: processorAccount.name,
          debit: 0,
          credit: txn.amount,
          memo: `Refund issued - ${txn.processorTransactionId}`,
        });
      }

      const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
      const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);

      const statuses: JournalEntry['status'][] = ['posted', 'posted', 'posted', 'pending_approval', 'draft'];
      const status = statuses[Math.floor(this.runtime.random() * statuses.length)] || 'posted';

      const entry: JournalEntry = {
        id: entryId,
        entryNumber: `JE-${2026}${String(i + 1).padStart(5, '0')}`,
        transactionDate: txn.timestamp,
        postingDate: txn.timestamp,
        status,
        currency: txn.currency,
        exchangeRate: 1.0,
        memo: `Payment transaction ${txn.processorTransactionId}`,
        lines,
        totalDebit,
        totalCredit,
        sourceType: txn.type === 'refund' ? 'refund' : 'payment',
        sourceId: txn.id,
        sourceReference: txn.processorTransactionId,
        createdBy: 'system',
        createdAt: txn.timestamp,
        approvedBy: status === 'posted' ? 'admin' : undefined,
        approvedAt: status === 'posted' ? txn.timestamp + 3600000 : undefined,
        postedBy: status === 'posted' ? 'system' : undefined,
        postedAt: status === 'posted' ? txn.timestamp + 7200000 : undefined,
        netSuiteId: status === 'posted' ? `NS_JE_${this.runtime.random().toString(36).slice(2, 2 + 8)}` : undefined,
        syncStatus: status === 'posted' ? 'synced' : 'pending',
      };

      this.journalEntries.set(entryId, entry);
    }
  }

  private getProcessorCashAccount(processorId: string): GLAccount {
    const processor = this.processorReader.getProcessorById(processorId);
    const type = processor?.type || 'stripe';

    const accountMap: Record<string, string> = {
      'stripe': 'gl_1010',
      'adyen': 'gl_1011',
      'paypal': 'gl_1012',
    };

    return this.glAccounts.get(accountMap[type] || 'gl_1000') || {
      id: 'gl_1000',
      accountNumber: '1000',
      name: 'Cash - Operating',
      type: 'asset',
      currency: 'USD',
      isActive: true,
    };
  }

  private getProcessorFeeAccount(processorId: string): GLAccount {
    const processor = this.processorReader.getProcessorById(processorId);
    const type = processor?.type || 'stripe';

    const accountMap: Record<string, string> = {
      'stripe': 'gl_6110',
      'adyen': 'gl_6111',
      'paypal': 'gl_6112',
    };

    return this.glAccounts.get(accountMap[type] || 'gl_6100') || {
      id: 'gl_6100',
      accountNumber: '6100',
      name: 'Payment Processing Fees',
      type: 'expense',
      currency: 'USD',
      isActive: true,
    };
  }

  /**
   * Get all GL accounts (chart of accounts)
   */
  async getGLAccounts(filters: {
    type?: GLAccount['type'];
    isActive?: boolean;
    search?: string;
  } = {}): Promise<GLAccount[]> {
    let accounts = Array.from(this.glAccounts.values());

    if (filters.type) {
      accounts = accounts.filter(a => a.type === filters.type);
    }

    if (filters.isActive !== undefined) {
      accounts = accounts.filter(a => a.isActive === filters.isActive);
    }

    if (filters.search) {
      const search = filters.search.toLowerCase();
      accounts = accounts.filter(a =>
        a.name.toLowerCase().includes(search) ||
        a.accountNumber.includes(search)
      );
    }

    return accounts.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  }

  /**
   * Get a GL account by ID
   */
  async getGLAccount(accountId: string): Promise<GLAccount | null> {
    return this.glAccounts.get(accountId) || null;
  }

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
  } = {}): Promise<{ entries: JournalEntry[]; totalCount: number }> {
    let entries = Array.from(this.journalEntries.values());

    if (filters.status && filters.status.length > 0) {
      entries = entries.filter(e => filters.status!.includes(e.status));
    }

    if (filters.sourceType && filters.sourceType.length > 0) {
      entries = entries.filter(e => filters.sourceType!.includes(e.sourceType));
    }

    if (filters.dateRange) {
      entries = entries.filter(e =>
        e.transactionDate >= filters.dateRange!.start &&
        e.transactionDate <= filters.dateRange!.end
      );
    }

    if (filters.syncStatus && filters.syncStatus.length > 0) {
      entries = entries.filter(e => filters.syncStatus!.includes(e.syncStatus));
    }

    const totalCount = entries.length;

    // Sort by transaction date descending
    entries.sort((a, b) => b.transactionDate - a.transactionDate);

    if (filters.offset !== undefined) {
      entries = entries.slice(filters.offset);
    }

    if (filters.limit !== undefined) {
      entries = entries.slice(0, filters.limit);
    }

    return { entries, totalCount };
  }

  /**
   * Get a journal entry by ID
   */
  async getJournalEntry(entryId: string): Promise<JournalEntry | null> {
    return this.journalEntries.get(entryId) || null;
  }

  /**
   * Create a journal entry from a transaction
   */
  async createJournalEntryFromTransaction(transactionId: string): Promise<GLPostingResult> {
    const transaction = this.transactionReader.getTransactionById(transactionId);
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    // Check if entry already exists
    for (const entry of this.journalEntries.values()) {
      if (entry.sourceId === transactionId) {
        return {
          success: false,
          error: 'Journal entry already exists for this transaction',
          journalEntryId: entry.id,
        };
      }
    }

    const entryId = this.runtime.createId('je', 6);
    const processorAccount = this.getProcessorCashAccount(transaction.processorId);
    const feeAccount = this.getProcessorFeeAccount(transaction.processorId);

    const lines: JournalEntryLine[] = [];
    let lineNum = 1;

    if (transaction.type === 'payment' || transaction.type === 'fee') {
      lines.push({
        lineNumber: lineNum++,
        accountId: processorAccount.id,
        accountNumber: processorAccount.accountNumber,
        accountName: processorAccount.name,
        debit: transaction.amount - transaction.fees.total,
        credit: 0,
        memo: `Payment - ${transaction.processorTransactionId}`,
        entity: transaction.customer.id ? {
          type: 'customer',
          id: transaction.customer.id,
          name: transaction.customer.name || 'Unknown',
        } : undefined,
      });

      if (transaction.fees.total > 0) {
        lines.push({
          lineNumber: lineNum++,
          accountId: feeAccount.id,
          accountNumber: feeAccount.accountNumber,
          accountName: feeAccount.name,
          debit: transaction.fees.total,
          credit: 0,
          memo: 'Processing fees',
        });
      }

      lines.push({
        lineNumber: lineNum,
        accountId: 'gl_4010',
        accountNumber: '4010',
        accountName: 'Product Sales',
        debit: 0,
        credit: transaction.amount,
        memo: `Revenue - ${transaction.processorTransactionId}`,
      });
    } else if (transaction.type === 'refund') {
      lines.push({
        lineNumber: lineNum++,
        accountId: 'gl_4010',
        accountNumber: '4010',
        accountName: 'Product Sales',
        debit: transaction.amount,
        credit: 0,
        memo: `Refund reversal - ${transaction.processorTransactionId}`,
      });

      lines.push({
        lineNumber: lineNum,
        accountId: processorAccount.id,
        accountNumber: processorAccount.accountNumber,
        accountName: processorAccount.name,
        debit: 0,
        credit: transaction.amount,
        memo: `Refund - ${transaction.processorTransactionId}`,
      });
    } else if (transaction.type === 'chargeback') {
      lines.push({
        lineNumber: lineNum++,
        accountId: 'gl_6300',
        accountNumber: '6300',
        accountName: 'Chargeback Losses',
        debit: transaction.amount,
        credit: 0,
        memo: `Chargeback - ${transaction.processorTransactionId}`,
      });

      lines.push({
        lineNumber: lineNum,
        accountId: processorAccount.id,
        accountNumber: processorAccount.accountNumber,
        accountName: processorAccount.name,
        debit: 0,
        credit: transaction.amount,
        memo: `Chargeback deduction - ${transaction.processorTransactionId}`,
      });
    }

    const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
    const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);

    const entryNumber = `JE-${new Date(this.runtime.now()).getFullYear()}${String(this.journalEntries.size + 1).padStart(5, '0')}`;

    const entry: JournalEntry = {
      id: entryId,
      entryNumber,
      transactionDate: transaction.timestamp,
      postingDate: this.runtime.now(),
      status: 'draft',
      currency: transaction.currency,
      exchangeRate: 1.0,
      memo: `${transaction.type} transaction ${transaction.processorTransactionId}`,
      lines,
      totalDebit,
      totalCredit,
      sourceType: transaction.type as JournalEntry['sourceType'],
      sourceId: transaction.id,
      sourceReference: transaction.processorTransactionId,
      createdBy: 'system',
      createdAt: this.runtime.now(),
      syncStatus: 'pending',
    };

    this.journalEntries.set(entryId, entry);

    this.runtime.logger.info('Journal entry created', {
      entryId,
      transactionId,
      totalDebit,
      totalCredit,
    });

    return {
      success: true,
      journalEntryId: entryId,
    };
  }

  /**
   * Approve a journal entry
   */
  async approveJournalEntry(entryId: string, approvedBy: string): Promise<JournalEntry | null> {
    const entry = this.journalEntries.get(entryId);
    if (!entry) {
      return null;
    }

    if (entry.status !== 'draft' && entry.status !== 'pending_approval') {
      throw new Error(`Cannot approve entry in ${entry.status} status`);
    }

    // Validate balanced entry
    if (Math.abs(entry.totalDebit - entry.totalCredit) > 0.01) {
      throw new Error('Journal entry is not balanced');
    }

    entry.status = 'approved';
    entry.approvedBy = approvedBy;
    entry.approvedAt = this.runtime.now();

    this.journalEntries.set(entryId, entry);

    this.runtime.logger.info('Journal entry approved', { entryId, approvedBy });

    return entry;
  }

  /**
   * Post a journal entry (sync to NetSuite)
   */
  async postJournalEntry(entryId: string, postedBy: string): Promise<GLPostingResult> {
    const entry = this.journalEntries.get(entryId);
    if (!entry) {
      return { success: false, error: 'Journal entry not found' };
    }

    if (entry.status !== 'approved') {
      return { success: false, error: `Cannot post entry in ${entry.status} status` };
    }

    // Simulate NetSuite API call (90% success rate in demo)
    const success = this.runtime.random() > 0.1;

    if (!success) {
      entry.status = 'failed';
      entry.syncStatus = 'failed';
      entry.syncError = 'NetSuite API error: GL_PERIOD_CLOSED';
      this.journalEntries.set(entryId, entry);

      return {
        success: false,
        journalEntryId: entryId,
        error: entry.syncError,
      };
    }

    const netSuiteId = `NS_JE_${this.runtime.now()}_${this.runtime.random().toString(36).slice(2, 2 + 8)}`;

    entry.status = 'posted';
    entry.postedBy = postedBy;
    entry.postedAt = this.runtime.now();
    entry.netSuiteId = netSuiteId;
    entry.syncStatus = 'synced';

    this.journalEntries.set(entryId, entry);

    this.runtime.logger.info('Journal entry posted to NetSuite', {
      entryId,
      netSuiteId,
      postedBy,
    });

    return {
      success: true,
      journalEntryId: entryId,
      netSuiteId,
    };
  }

  /**
   * Void a journal entry
   */
  async voidJournalEntry(entryId: string, reason: string): Promise<JournalEntry | null> {
    const entry = this.journalEntries.get(entryId);
    if (!entry) {
      return null;
    }

    if (entry.status === 'voided') {
      throw new Error('Entry is already voided');
    }

    entry.status = 'voided';
    entry.memo = `${entry.memo} [VOIDED: ${reason}]`;

    this.journalEntries.set(entryId, entry);

    this.runtime.logger.info('Journal entry voided', { entryId, reason });

    return entry;
  }

  /**
   * Create a posting batch
   */
  async createPostingBatch(
    name: string,
    entryIds: string[],
    createdBy: string
  ): Promise<GLPostingBatch> {
    const batchId = this.runtime.createId('batch', 6);

    // Validate entries exist and are approved
    let totalDebit = 0;
    let totalCredit = 0;

    for (const entryId of entryIds) {
      const entry = this.journalEntries.get(entryId);
      if (!entry) {
        throw new Error(`Entry ${entryId} not found`);
      }
      if (entry.status !== 'approved') {
        throw new Error(`Entry ${entryId} is not in approved status`);
      }
      totalDebit += entry.totalDebit;
      totalCredit += entry.totalCredit;
    }

    const batch: GLPostingBatch = {
      id: batchId,
      name,
      status: 'open',
      entries: entryIds,
      totalEntries: entryIds.length,
      processedEntries: 0,
      successfulEntries: 0,
      failedEntries: 0,
      totalDebit,
      totalCredit,
      createdBy,
      createdAt: this.runtime.now(),
      errors: [],
    };

    this.postingBatches.set(batchId, batch);

    this.runtime.logger.info('Posting batch created', {
      batchId,
      name,
      entryCount: entryIds.length,
    });

    return batch;
  }

  /**
   * Process a posting batch
   */
  async processPostingBatch(batchId: string, processedBy: string): Promise<GLPostingBatch> {
    const batch = this.postingBatches.get(batchId);
    if (!batch) {
      throw new Error('Batch not found');
    }

    if (batch.status !== 'open') {
      throw new Error(`Cannot process batch in ${batch.status} status`);
    }

    batch.status = 'processing';
    this.postingBatches.set(batchId, batch);

    // Process each entry
    for (const entryId of batch.entries) {
      batch.processedEntries++;

      const result = await this.postJournalEntry(entryId, processedBy);

      if (result.success) {
        batch.successfulEntries++;
      } else {
        batch.failedEntries++;
        batch.errors.push({
          entryId,
          error: result.error || 'Unknown error',
        });
      }

      this.postingBatches.set(batchId, batch);
    }

    batch.status = batch.failedEntries === 0 ? 'completed' :
                   batch.successfulEntries === 0 ? 'failed' : 'partially_completed';
    batch.processedAt = this.runtime.now();

    this.postingBatches.set(batchId, batch);

    this.runtime.logger.info('Posting batch processed', {
      batchId,
      successful: batch.successfulEntries,
      failed: batch.failedEntries,
    });

    return batch;
  }

  /**
   * Get posting batches
   */
  async getPostingBatches(filters: {
    status?: GLPostingBatch['status'][];
    limit?: number;
    offset?: number;
  } = {}): Promise<{ batches: GLPostingBatch[]; totalCount: number }> {
    let batches = Array.from(this.postingBatches.values());

    if (filters.status && filters.status.length > 0) {
      batches = batches.filter(b => filters.status!.includes(b.status));
    }

    const totalCount = batches.length;

    batches.sort((a, b) => b.createdAt - a.createdAt);

    if (filters.offset !== undefined) {
      batches = batches.slice(filters.offset);
    }

    if (filters.limit !== undefined) {
      batches = batches.slice(0, filters.limit);
    }

    return { batches, totalCount };
  }

  /**
   * Get a posting batch by ID
   */
  async getPostingBatch(batchId: string): Promise<GLPostingBatch | null> {
    return this.postingBatches.get(batchId) || null;
  }

  /**
   * Get GL posting statistics
   */
  async getGLPostingStatistics(): Promise<GLPostingStatistics> {
    const entries = Array.from(this.journalEntries.values());
    const batches = Array.from(this.postingBatches.values());

    const postedEntries = entries.filter(e => e.status === 'posted');
    const pendingEntries = entries.filter(e => e.status === 'draft' || e.status === 'pending_approval' || e.status === 'approved');
    const failedEntries = entries.filter(e => e.status === 'failed');
    const pendingBatches = batches.filter(b => b.status === 'open');

    // Calculate totals
    const totalDebitPosted = postedEntries.reduce((sum, e) => sum + e.totalDebit, 0);
    const totalCreditPosted = postedEntries.reduce((sum, e) => sum + e.totalCredit, 0);

    // Find last posting date
    const lastPostedEntry = postedEntries
      .filter(e => e.postedAt)
      .sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))[0];

    // Count accounts used
    const accountUsage = new Map<string, number>();
    for (const entry of postedEntries) {
      for (const line of entry.lines) {
        const count = accountUsage.get(line.accountId) || 0;
        accountUsage.set(line.accountId, count + 1);
      }
    }

    const accountsUsed = Array.from(accountUsage.entries())
      .map(([accountId, count]) => {
        const account = this.glAccounts.get(accountId);
        return {
          accountId,
          accountNumber: account?.accountNumber || 'Unknown',
          name: account?.name || 'Unknown Account',
          transactionCount: count,
        };
      })
      .sort((a, b) => b.transactionCount - a.transactionCount)
      .slice(0, 10);

    return {
      totalEntriesPosted: postedEntries.length,
      totalEntriesPending: pendingEntries.length,
      totalEntriesFailed: failedEntries.length,
      totalDebitPosted,
      totalCreditPosted,
      pendingBatches: pendingBatches.length,
      lastPostingDate: lastPostedEntry?.postedAt,
      accountsUsed,
    };
  }

  /** Synchronous count accessors used by the facade for init logging. */
  glAccountCount(): number { return this.glAccounts.size; }
  journalEntryCount(): number { return this.journalEntries.size; }

  /**
   * Get GL posting dashboard summary
   */
  async getGLPostingDashboard(): Promise<Record<string, unknown>> {
    const [accounts, entriesResult, batchesResult, statistics] = await Promise.all([
      this.getGLAccounts({ isActive: true }),
      this.getJournalEntries({ limit: 10 }),
      this.getPostingBatches({ limit: 5 }),
      this.getGLPostingStatistics(),
    ]);

    return {
      statistics,
      accounts: {
        total: accounts.length,
        byType: {
          asset: accounts.filter(a => a.type === 'asset').length,
          liability: accounts.filter(a => a.type === 'liability').length,
          equity: accounts.filter(a => a.type === 'equity').length,
          revenue: accounts.filter(a => a.type === 'revenue').length,
          expense: accounts.filter(a => a.type === 'expense').length,
        },
      },
      recentEntries: entriesResult.entries,
      recentBatches: batchesResult.batches,
      lastUpdated: this.runtime.now(),
    };
  }
}
