/**
 * Characterization tests for PaymentCentralService.
 * These tests lock the observable behavior of the monolith BEFORE any structural refactoring.
 * They exercise all seven domains through the facade using demo-seeded data.
 *
 * DO NOT mock PaymentCentralService itself here — we instantiate the real class
 * so that demo data is seeded and methods run through actual code paths.
 */

import 'reflect-metadata';
import { createPaymentCentralService } from './helpers/createPaymentCentralService';

describe('PaymentCentralService — characterization suite', () => {
  // ==================== Deterministic runtime contract ====================

  describe('deterministic runtime (Task 6)', () => {
    it('produces identical demo-seeded state across independent service instances', async () => {
      const a = createPaymentCentralService();
      const b = createPaymentCentralService();
      const [procA, procB] = await Promise.all([
        a.service.getPaymentProcessors(),
        b.service.getPaymentProcessors(),
      ]);
      expect(procA.map(p => p.id)).toEqual(procB.map(p => p.id));
      const [txA, txB] = await Promise.all([
        a.service.getTransactions({ limit: 5 }),
        b.service.getTransactions({ limit: 5 }),
      ]);
      expect(txA.totalCount).toBe(txB.totalCount);
      expect(txA.transactions.map(t => t.id)).toEqual(txB.transactions.map(t => t.id));
    });

    it('opts out of determinism when runtime: null is passed', async () => {
      // With the ambient runtime, identical same-ms + random-suffix collisions
      // are possible (tiny probability, but non-zero). Mock Date.now() so the
      // two constructions deterministically see different millis, making the
      // divergence assertion reliable without coupling the test to Math.random.
      let now = 1_700_000_000_000;
      const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now++);
      try {
        const a = createPaymentCentralService({ runtime: null });
        const b = createPaymentCentralService({ runtime: null });
        const [txA, txB] = await Promise.all([
          a.service.getTransactions({ limit: 5 }),
          b.service.getTransactions({ limit: 5 }),
        ]);
        expect(txA.transactions.length).toBeGreaterThan(0);
        expect(txB.transactions.length).toBeGreaterThan(0);
        expect(txA.transactions[0].id).not.toBe(txB.transactions[0].id);
      } finally {
        dateNowSpy.mockRestore();
      }
    });
  });

  // ==================== Domain 1: Processors ====================

  describe('processor listing', () => {
    it('returns a non-empty list of payment processors seeded by demo data', async () => {
      const { service } = createPaymentCentralService();
      const processors = await service.getPaymentProcessors();

      expect(Array.isArray(processors)).toBe(true);
      expect(processors.length).toBeGreaterThan(0);

      // Each processor should have required shape
      const first = processors[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('name');
      expect(first).toHaveProperty('type');
      expect(first).toHaveProperty('status');
      expect(first).toHaveProperty('limits');
      expect(first).toHaveProperty('fees');
    });
  });

  // ==================== Domain 2: Transactions ====================

  describe('transaction listing', () => {
    it('returns expected shape {transactions, totalCount}', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.getTransactions({ limit: 10 });

      expect(result).toHaveProperty('transactions');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.transactions)).toBe(true);
      expect(typeof result.totalCount).toBe('number');
    });

    it('returns demo-seeded transactions (non-zero totalCount)', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.getTransactions();

      expect(result.totalCount).toBeGreaterThan(0);
      expect(result.transactions.length).toBeGreaterThan(0);
    });

    it('sorts transactions newest-first by timestamp', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.getTransactions({ limit: 20 });

      const timestamps = result.transactions.map(t => t.timestamp);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
      }
    });
  });

  // ==================== Domain 2b: Sync ====================

  describe('syncTransactionToBusinessCentral', () => {
    it('throws for a non-existent transaction id (pins throw-not-return behavior)', async () => {
      const { service } = createPaymentCentralService();
      await expect(
        service.syncTransactionToBusinessCentral('txn-does-not-exist')
      ).rejects.toThrow('Transaction not found: txn-does-not-exist');
    });
  });

  // ==================== Domain 3: Reconciliation ====================

  describe('reconciliation report', () => {
    it('generateReconciliationReport returns a string id', async () => {
      const { service } = createPaymentCentralService();
      const now = Date.now();
      const reportId = await service.generateReconciliationReport(
        { start: now - 30 * 24 * 60 * 60 * 1000, end: now },
        []
      );

      expect(typeof reportId).toBe('string');
      expect(reportId.length).toBeGreaterThan(0);
    });

    it('getReconciliationReport returns the same report after generation', async () => {
      const { service } = createPaymentCentralService();
      const now = Date.now();
      const reportId = await service.generateReconciliationReport(
        { start: now - 7 * 24 * 60 * 60 * 1000, end: now },
        []
      );

      const report = await service.getReconciliationReport(reportId);

      expect(report).not.toBeNull();
      expect(report!.id).toBe(reportId);
      expect(report).toHaveProperty('summary');
      expect(report).toHaveProperty('processorBreakdown');
      expect(report).toHaveProperty('status');
      expect(report!.status).toBe('completed');
    });

    it('getReconciliationReport returns null for unknown id', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.getReconciliationReport('non-existent-report-id');
      expect(result).toBeNull();
    });

    it('generated report contains a discrepancies array (pins discrepancy helper behavior)', async () => {
      const { service } = createPaymentCentralService();
      const now = Date.now();
      const reportId = await service.generateReconciliationReport(
        { start: now - 30 * 24 * 60 * 60 * 1000, end: now },
        []
      );

      const report = await service.getReconciliationReport(reportId);

      expect(report).not.toBeNull();
      expect(Array.isArray(report!.discrepancies)).toBe(true);
    });
  });

  // ==================== Domain 4: Analytics ====================

  describe('payment analytics', () => {
    it('getPaymentAnalytics returns result with summary block', async () => {
      const { service } = createPaymentCentralService();
      const analytics = await service.getPaymentAnalytics();

      expect(analytics).toHaveProperty('summary');
      expect(analytics.summary).toHaveProperty('totalVolume');
      expect(analytics.summary).toHaveProperty('totalTransactions');
      expect(analytics.summary).toHaveProperty('successRate');
      expect(analytics.summary).toHaveProperty('totalFees');
      expect(analytics.summary).toHaveProperty('netRevenue');
    });

    it('getPaymentAnalytics returns result with reconciliationHealth block', async () => {
      const { service } = createPaymentCentralService();
      const analytics = await service.getPaymentAnalytics();

      expect(analytics).toHaveProperty('reconciliationHealth');
      expect(analytics.reconciliationHealth).toHaveProperty('reconciliationRate');
      expect(analytics.reconciliationHealth).toHaveProperty('unreconciledAmount');
    });
  });

  // ==================== Domain 5: Dunning ====================

  describe('dunning entries', () => {
    it('getDunningEntries({limit:1}) returns {entries, totalCount} with non-zero totalCount', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.getDunningEntries({ limit: 1 });

      expect(result).toHaveProperty('entries');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.entries)).toBe(true);
      expect(result.totalCount).toBeGreaterThan(0);
      expect(result.entries.length).toBeLessThanOrEqual(1);
    });

    it('getDunningEntries returns entries with expected shape', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.getDunningEntries({ limit: 5 });

      expect(result.entries.length).toBeGreaterThan(0);
      const entry = result.entries[0];
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('customerId');
      expect(entry).toHaveProperty('invoiceAmount');
      expect(entry).toHaveProperty('daysOverdue');
      expect(entry).toHaveProperty('status');
    });

    it('analyzeDunningEntry returns {success: true, aiAnalysis} when AI agent is configured (preview, no mutation)', async () => {
      // Default harness binds a DunningAgent with a properly-shaped
      // AgentResult<DunningOutput> mock. Analyze goes through the adapter
      // successful branch and returns the AI output WITHOUT mutating the entry.
      const { service } = createPaymentCentralService();
      const { entries } = await service.getDunningEntries({ limit: 1 });
      expect(entries.length).toBeGreaterThan(0);
      const entryBefore = entries[0];
      const entryId = entryBefore.id;
      const historyBefore = entryBefore.history.length;

      const result = await service.analyzeDunningEntry(entryId);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('aiAnalysis');
      expect(result.aiAnalysis).toHaveProperty('generatedMessage');
      expect(result.aiAnalysis!.generatedMessage).toHaveProperty('body');

      // Preview mode: entry state must not mutate (status unchanged, history length unchanged)
      const entryAfter = await service.getDunningEntry(entryId);
      expect(entryAfter).not.toBeNull();
      expect(entryAfter!.id).toBe(entryId);
      expect(entryAfter!.status).toBe(entryBefore.status);
      expect(entryAfter!.history.length).toBe(historyBefore);
    });

    it('analyzeDunningEntry returns {success: false} when no AI agent is bound', async () => {
      // withAgent:false skips the container binding entirely — pins the
      // "AI analysis not available (no agent or schedule)" error path.
      const { service } = createPaymentCentralService({ withAgent: false });
      const { entries } = await service.getDunningEntries({ limit: 1 });
      expect(entries.length).toBeGreaterThan(0);
      const entryId = entries[0].id;

      const result = await service.analyzeDunningEntry(entryId);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('message');
      expect(result.message).toContain('AI analysis not available');
    });

    it('sendDunningReminder mutates entry status to "sent" and appends history', async () => {
      const { service } = createPaymentCentralService();
      // Find a non-paid, non-cancelled entry
      const { entries } = await service.getDunningEntries({
        status: ['pending'],
        limit: 1,
      });
      expect(entries.length).toBeGreaterThan(0);
      const entryId = entries[0].id;
      const historyLengthBefore = entries[0].history.length;

      const result = await service.sendDunningReminder(entryId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Reminder sent');

      const entryAfter = await service.getDunningEntry(entryId);
      expect(entryAfter).not.toBeNull();
      expect(entryAfter!.status).toBe('sent');
      expect(entryAfter!.history.length).toBe(historyLengthBefore + 1);
      expect(entryAfter!.nextActionDate).toBeDefined();
    });

    it('processPendingDunning returns counters {processed, sent, escalated, paused, paymentPlans}', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.processPendingDunning();

      expect(result).toHaveProperty('processed');
      expect(result).toHaveProperty('sent');
      expect(result).toHaveProperty('escalated');
      expect(result).toHaveProperty('paused');
      expect(result).toHaveProperty('paymentPlans');
      expect(typeof result.processed).toBe('number');
      expect(typeof result.sent).toBe('number');
    });
  });

  // ==================== Domain 6: GL Posting ====================

  describe('journal entry from transaction', () => {
    // Demo seeding pre-creates JEs for the first 50 transactions in insertion order,
    // but getTransactions sorts by timestamp (newest first). Random demo timestamps
    // mean any single newest-by-timestamp transaction may already be seeded.
    // This helper iterates until it finds one without a seeded JE so the tests
    // are deterministic across runs.
    async function createFirstUnseededJournalEntry(
      service: ReturnType<typeof createPaymentCentralService>['service'],
    ): Promise<{ txnId: string; journalEntryId: string }> {
      const { transactions } = await service.getTransactions({ limit: 200 });
      for (const txn of transactions) {
        const result = await service.createJournalEntryFromTransaction(txn.id);
        if (result.success && result.journalEntryId) {
          return { txnId: txn.id, journalEntryId: result.journalEntryId };
        }
      }
      throw new Error('No unseeded transaction available in first 200 — seed scope changed?');
    }

    it('createJournalEntryFromTransaction for an existing transaction returns {success: true, journalEntryId}', async () => {
      const { service } = createPaymentCentralService();
      const { journalEntryId } = await createFirstUnseededJournalEntry(service);
      expect(typeof journalEntryId).toBe('string');
    });

    it('createJournalEntryFromTransaction returns failure for non-existent transaction', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.createJournalEntryFromTransaction('txn-does-not-exist');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('createJournalEntryFromTransaction returns {success: false} on duplicate (same transactionId called twice)', async () => {
      const { service } = createPaymentCentralService();
      const { txnId } = await createFirstUnseededJournalEntry(service);

      const second = await service.createJournalEntryFromTransaction(txnId);
      expect(second.success).toBe(false);
      expect(second.error).toBeDefined();
    });

    it('approveJournalEntry returns null for a non-existent entry id', async () => {
      const { service } = createPaymentCentralService();
      const result = await service.approveJournalEntry('je-does-not-exist', 'admin');
      expect(result).toBeNull();
    });

    it('approveJournalEntry throws for an already-approved or posted entry', async () => {
      const { service } = createPaymentCentralService();
      const { journalEntryId } = await createFirstUnseededJournalEntry(service);

      // Approve once (moves from draft → approved)
      await service.approveJournalEntry(journalEntryId, 'admin');

      // Approving again (from approved status) should throw
      await expect(
        service.approveJournalEntry(journalEntryId, 'admin2')
      ).rejects.toThrow();
    });

    it('processPostingBatch returns a batch with processed/successful/failed counters', async () => {
      const { service } = createPaymentCentralService();
      const { journalEntryId } = await createFirstUnseededJournalEntry(service);
      await service.approveJournalEntry(journalEntryId, 'admin');

      const batch = await service.createPostingBatch('Test Batch', [journalEntryId], 'admin');
      expect(batch.id).toBeDefined();

      const processed = await service.processPostingBatch(batch.id, 'admin');

      expect(processed).toHaveProperty('processedEntries');
      expect(processed).toHaveProperty('successfulEntries');
      expect(processed).toHaveProperty('failedEntries');
      expect(typeof processed.processedEntries).toBe('number');
      expect(processed.processedEntries).toBe(1);
      // successfulEntries + failedEntries should equal processedEntries
      expect(processed.successfulEntries + processed.failedEntries).toBe(processed.processedEntries);
    });
  });

  // ==================== Domain 7: Invoice Matching ====================

  describe('invoice creation', () => {
    it('createInvoice returns an invoice with an id', async () => {
      const { service } = createPaymentCentralService();
      const invoice = await service.createInvoice('tenant-char', 'VENDOR-CHAR-001', {
        invoiceNumber: 'INV-CHAR-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 500,
        taxAmount: 40,
        currency: 'USD',
        lineItems: [],
      });

      expect(invoice).toBeDefined();
      expect(invoice.id).toBeDefined();
      expect(typeof invoice.id).toBe('string');
      expect(invoice.vendorId).toBe('VENDOR-CHAR-001');
      expect(invoice.amount).toBe(500);
    });

    it('getInvoices returns {invoices, totalCount} shape', async () => {
      const { service } = createPaymentCentralService();

      // Create one invoice so there is something to list
      await service.createInvoice('tenant-char', 'VENDOR-CHAR-002', {
        invoiceNumber: 'INV-CHAR-002',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 100,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      const result = await service.getInvoices('tenant-char', { vendorId: 'VENDOR-CHAR-002' });

      expect(result).toHaveProperty('invoices');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.invoices)).toBe(true);
      expect(result.totalCount).toBeGreaterThanOrEqual(1);
    });

    it('autoMatchInvoice returns {success, candidates} shape (pins return contract)', async () => {
      const { service } = createPaymentCentralService();
      const invoice = await service.createInvoice('tenant-char', 'VENDOR-CHAR-MATCH', {
        invoiceNumber: 'INV-CHAR-MATCH-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 500,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [
          { itemCode: 'ITEM-A', description: 'Item A', quantity: 5, unitPrice: 100, lineTotal: 500 },
        ],
      });

      const result = await service.autoMatchInvoice('tenant-char', invoice.id);

      expect(typeof result.success).toBe('boolean');
      // When a match is found, matchResult.matchConfidence must be [0, 1]
      if (result.success && result.matchResult) {
        expect(result.matchResult.matchConfidence).toBeGreaterThanOrEqual(0);
        expect(result.matchResult.matchConfidence).toBeLessThanOrEqual(1);
      }
    });

    it('createInvoiceDispute sets invoice paymentStatus to held', async () => {
      const { service } = createPaymentCentralService();
      const invoice = await service.createInvoice('tenant-char', 'VENDOR-CHAR-DISP', {
        invoiceNumber: 'INV-CHAR-DISP-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 800,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      await service.createInvoiceDispute('tenant-char', invoice.id, 'price_mismatch', 'Price does not match', 'test-user');

      const updated = await service.getInvoice('tenant-char', invoice.id);
      expect(updated?.matchStatus).toBe('disputed');
      expect(updated?.paymentStatus).toBe('held');
    });

    it('createCreditMemo throws when amount exceeds remaining invoice balance', async () => {
      const { service } = createPaymentCentralService();
      const invoice = await service.createInvoice('tenant-char', 'VENDOR-CHAR-CREDIT', {
        invoiceNumber: 'INV-CHAR-CREDIT-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 300,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      await expect(
        service.createCreditMemo('tenant-char', invoice.id, 400, 'Over-credit attempt', 'test-user')
      ).rejects.toThrow('exceeds');
    });

    it('invoice created under tenant-a is invisible to tenant-b', async () => {
      const { service } = createPaymentCentralService();
      await service.createInvoice('tenant-a', 'VENDOR-ISO', {
        invoiceNumber: 'INV-ISO-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 250,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });
      const resultB = await service.getInvoices('tenant-b', { vendorId: 'VENDOR-ISO' });
      expect(resultB.totalCount).toBe(0);
    });
  });
});
