/**
 * Invoice Matching Tests
 * Phase 6: 3-Way Invoice Matching Feature
 */

import 'reflect-metadata';
import type { Invoice, InvoiceDispute, CreditMemo, InvoiceMatchStatus, InvoicePaymentStatus } from '../../../../src/types/invoice';
import { createPaymentCentralService } from './helpers/createPaymentCentralService';

describe('PaymentCentralService - Invoice Matching', () => {
  let service: ReturnType<typeof createPaymentCentralService>['service'];

  beforeEach(() => {
    jest.clearAllMocks();
    ({ service } = createPaymentCentralService());
  });

  describe('createInvoice', () => {
    it('should create an invoice with valid data', async () => {
      const invoiceData = {
        vendorId: 'VENDOR-001',
        invoiceNumber: 'INV-2026-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
        amount: 1000.00,
        taxAmount: 80.00,
        currency: 'USD',
        lineItems: [
          {
            lineNumber: 1,
            itemCode: 'ITEM-001',
            description: 'Test Item',
            quantity: 10,
            unitPrice: 100,
            lineTotal: 1000,
          },
        ],
      };

      const invoice = await service.createInvoice('VENDOR-001', invoiceData);

      expect(invoice).toBeDefined();
      expect(invoice.id).toBeDefined();
      expect(invoice.vendorId).toBe('VENDOR-001');
      expect(invoice.invoiceNumber).toBe('INV-2026-001');
      expect(invoice.amount).toBe(1000.00);
      expect(invoice.taxAmount).toBe(80.00);
      expect(invoice.totalAmount).toBe(1080.00);
      expect(invoice.matchStatus).toBe('pending');
      expect(invoice.paymentStatus).toBe('unpaid');
    });

    it('should allow multiple invoices for same vendor', async () => {
      const invoice1 = await service.createInvoice('VENDOR-001', {
        vendorId: 'VENDOR-001',
        invoiceNumber: 'INV-DUP-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 500,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      const invoice2 = await service.createInvoice('VENDOR-001', {
        vendorId: 'VENDOR-001',
        invoiceNumber: 'INV-DUP-002',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 750,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      expect(invoice1.id).not.toBe(invoice2.id);
      expect(invoice1.vendorId).toBe(invoice2.vendorId);
    });
  });

  describe('getInvoice', () => {
    it('should retrieve an existing invoice', async () => {
      const invoiceData = {
        vendorId: 'VENDOR-GET',
        invoiceNumber: 'INV-GET-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 750,
        taxAmount: 50,
        currency: 'USD',
        lineItems: [],
      };

      const created = await service.createInvoice('VENDOR-GET', invoiceData);
      const retrieved = await service.getInvoice(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.invoiceNumber).toBe('INV-GET-001');
    });

    it('should return null for non-existent invoice', async () => {
      const invoice = await service.getInvoice('non-existent-id');
      expect(invoice).toBeNull();
    });
  });

  describe('getInvoices', () => {
    beforeEach(async () => {
      // Create test invoices
      const baseDate = Date.now();

      await service.createInvoice('VENDOR-LIST', {
        vendorId: 'VENDOR-LIST',
        invoiceNumber: 'INV-LIST-001',
        invoiceDate: baseDate,
        dueDate: baseDate + 30 * 24 * 60 * 60 * 1000,
        amount: 100,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      await service.createInvoice('VENDOR-LIST', {
        vendorId: 'VENDOR-LIST',
        invoiceNumber: 'INV-LIST-002',
        invoiceDate: baseDate,
        dueDate: baseDate + 30 * 24 * 60 * 60 * 1000,
        amount: 200,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });
    });

    it('should list invoices with filters', async () => {
      const result = await service.getInvoices({ vendorId: 'VENDOR-LIST' });

      expect(result.invoices.length).toBeGreaterThanOrEqual(2);
      expect(result.invoices.every((inv: Invoice) => inv.vendorId === 'VENDOR-LIST')).toBe(true);
    });

    it('should filter by match status', async () => {
      const result = await service.getInvoices({ matchStatus: ['pending'] });

      expect(result.invoices.every((inv: Invoice) => inv.matchStatus === 'pending')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const result = await service.getInvoices({ limit: 1 });

      expect(result.invoices.length).toBeLessThanOrEqual(1);
    });
  });

  describe('autoMatchInvoice', () => {
    it('should attempt auto-matching for pending invoice', async () => {
      const invoiceData = {
        vendorId: 'VENDOR-MATCH',
        invoiceNumber: 'INV-MATCH-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 500,
        taxAmount: 25,
        currency: 'USD',
        lineItems: [
          { lineNumber: 1, itemCode: 'ITEM-001', description: 'Test', quantity: 5, unitPrice: 100, lineTotal: 500 },
        ],
      };

      const invoice = await service.createInvoice('VENDOR-MATCH', invoiceData);
      const result = await service.autoMatchInvoice(invoice.id);

      expect(result).toBeDefined();
      // Auto-match returns success/error/candidates pattern
      // In demo mode without actual POs, it may not find matches
      expect(typeof result.success).toBe('boolean');
      if (result.success) {
        expect(result.matchResult).toBeDefined();
      } else {
        // No PO candidates found is expected in demo mode
        expect(result.error).toBeDefined();
      }
    });

    it('should return error for non-existent invoice', async () => {
      const result = await service.autoMatchInvoice('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invoice not found');
    });
  });

  describe('matchInvoiceToPO', () => {
    it('should match invoice to purchase order', async () => {
      const invoiceData = {
        vendorId: 'VENDOR-PO',
        invoiceNumber: 'INV-PO-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 1000,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [
          { lineNumber: 1, itemCode: 'ITEM-001', description: 'Test', quantity: 10, unitPrice: 100, lineTotal: 1000 },
        ],
      };

      const invoice = await service.createInvoice('VENDOR-PO', invoiceData);
      const result = await service.matchInvoiceToPO(invoice.id, 'PO-001');

      expect(result.success).toBe(true);
      expect(result.matchResult).toBeDefined();
      expect(result.matchResult?.poId).toBe('PO-001');

      // Check the invoice was updated
      const updatedInvoice = await service.getInvoice(invoice.id);
      expect(['matched', 'partial']).toContain(updatedInvoice?.matchStatus);
    });
  });

  describe('approveInvoice', () => {
    it('should approve a matched invoice', async () => {
      const invoiceData = {
        vendorId: 'VENDOR-APPROVE',
        invoiceNumber: 'INV-APPROVE-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 250,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      };

      const invoice = await service.createInvoice('VENDOR-APPROVE', invoiceData);

      // First match to PO
      await service.matchInvoiceToPO(invoice.id, 'PO-APPROVE-001');

      // Then approve
      const result = await service.approveInvoice(invoice.id, 'test-approver');

      expect(result.success).toBe(true);

      // Check the invoice was updated
      const approved = await service.getInvoice(invoice.id);
      expect(approved?.matchStatus).toBe('approved');
    });

    it('should return error for pending invoice without match', async () => {
      const invoiceData = {
        vendorId: 'VENDOR-REJECT',
        invoiceNumber: 'INV-REJECT-001',
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 100,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      };

      const invoice = await service.createInvoice('VENDOR-REJECT', invoiceData);

      const result = await service.approveInvoice(invoice.id, 'test-user');
      expect(result.success).toBe(false);
      expect(result.error).toContain('matched');
    });
  });

  describe('createInvoiceDispute', () => {
    let testInvoice: Invoice;

    beforeEach(async () => {
      testInvoice = await service.createInvoice('VENDOR-DISPUTE', {
        vendorId: 'VENDOR-DISPUTE',
        invoiceNumber: `INV-DISPUTE-${Date.now()}`,
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 500,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });
    });

    it('should create a dispute for an invoice', async () => {
      const result = await service.createInvoiceDispute(
        testInvoice.id,
        'price_mismatch',
        'Invoice price does not match PO',
        'test-user'
      );

      expect(result.success).toBe(true);
      expect(result.dispute).toBeDefined();
      expect(result.dispute!.id).toBeDefined();
      expect(result.dispute!.invoiceId).toBe(testInvoice.id);
      expect(result.dispute!.reason).toBe('price_mismatch');
      expect(result.dispute!.status).toBe('open');
    });

    it('should update invoice status to disputed', async () => {
      await service.createInvoiceDispute(
        testInvoice.id,
        'quantity_mismatch',
        'Quantity does not match receipt',
        'test-user'
      );

      const updatedInvoice = await service.getInvoice(testInvoice.id);
      expect(updatedInvoice?.matchStatus).toBe('disputed');
    });

    it('should return error for non-existent invoice', async () => {
      const result = await service.createInvoiceDispute('non-existent', 'other', 'Test', 'user');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invoice not found');
    });
  });

  describe('resolveDispute', () => {
    let testDispute: InvoiceDispute;
    let testInvoice: Invoice;

    beforeEach(async () => {
      testInvoice = await service.createInvoice('VENDOR-RESOLVE', {
        vendorId: 'VENDOR-RESOLVE',
        invoiceNumber: `INV-RESOLVE-${Date.now()}`,
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 1000,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      const disputeResult = await service.createInvoiceDispute(
        testInvoice.id,
        'price_mismatch',
        'Price is incorrect',
        'test-user'
      );
      testDispute = disputeResult.dispute!;
    });

    it('should resolve a dispute with credit memo', async () => {
      const result = await service.resolveDispute(testDispute.id, {
        type: 'credit_memo',
        description: 'Issuing credit for price difference',
        adjustedAmount: 100,
      }, 'resolver-user');

      expect(result.success).toBe(true);
      expect(result.creditMemo).toBeDefined();
      expect(result.creditMemo?.amount).toBe(100);

      // Check the dispute was updated
      const disputes = await service.getDisputes({ status: ['resolved'] });
      const resolved = disputes.disputes.find(d => d.id === testDispute.id);
      expect(resolved?.status).toBe('resolved');
      expect(resolved?.resolution?.type).toBe('credit_memo');
    });

    it('should resolve dispute with invoice approval', async () => {
      const result = await service.resolveDispute(testDispute.id, {
        type: 'invoice_approved',
        description: 'Invoice approved after review',
      }, 'approver');

      expect(result.success).toBe(true);

      // Invoice should be marked as approved
      const invoice = await service.getInvoice(testInvoice.id);
      expect(invoice?.matchStatus).toBe('approved');
    });

    it('should return error for non-existent dispute', async () => {
      const result = await service.resolveDispute('non-existent', {
        type: 'other',
        description: 'Test',
      }, 'user');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Dispute not found');
    });
  });

  describe('createCreditMemo', () => {
    let testInvoice: Invoice;

    beforeEach(async () => {
      testInvoice = await service.createInvoice('VENDOR-CREDIT', {
        vendorId: 'VENDOR-CREDIT',
        invoiceNumber: `INV-CREDIT-${Date.now()}`,
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 1000,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });
    });

    it('should create a credit memo for an invoice', async () => {
      const creditMemo = await service.createCreditMemo(
        testInvoice.id,
        200,
        'Overcharge adjustment',
        'test-user'
      );

      expect(creditMemo).toBeDefined();
      expect(creditMemo.id).toBeDefined();
      expect(creditMemo.invoiceId).toBe(testInvoice.id);
      expect(creditMemo.amount).toBe(200);
      expect(creditMemo.status).toBe('pending_approval');
    });

    it('should reject credit memo exceeding invoice amount', async () => {
      await expect(
        service.createCreditMemo(testInvoice.id, 2000, 'Too much', 'user')
      ).rejects.toThrow('exceeds');
    });

    it('should reject credit memo for non-existent invoice', async () => {
      await expect(
        service.createCreditMemo('non-existent', 100, 'Test', 'user')
      ).rejects.toThrow('Invoice not found');
    });
  });

  describe('getInvoiceStatistics', () => {
    beforeEach(async () => {
      // Create various invoices for statistics
      const baseDate = Date.now();

      await service.createInvoice('VENDOR-STATS', {
        vendorId: 'VENDOR-STATS',
        invoiceNumber: `INV-STATS-1-${baseDate}`,
        invoiceDate: baseDate,
        dueDate: baseDate + 30 * 24 * 60 * 60 * 1000,
        amount: 1000,
        taxAmount: 100,
        currency: 'USD',
        lineItems: [],
      });

      await service.createInvoice('VENDOR-STATS', {
        vendorId: 'VENDOR-STATS',
        invoiceNumber: `INV-STATS-2-${baseDate}`,
        invoiceDate: baseDate,
        dueDate: baseDate - 10 * 24 * 60 * 60 * 1000, // Overdue
        amount: 500,
        taxAmount: 50,
        currency: 'USD',
        lineItems: [],
      });
    });

    it('should return invoice statistics', async () => {
      const stats = await service.getInvoiceStatistics();

      expect(stats).toBeDefined();
      expect(stats.totalInvoices).toBeGreaterThanOrEqual(2);
      expect(stats.totalAmount).toBeGreaterThan(0);
      expect(typeof stats.pendingMatch).toBe('number');
      expect(typeof stats.matched).toBe('number');
      expect(typeof stats.disputed).toBe('number');
      expect(typeof stats.approved).toBe('number');
      expect(typeof stats.overdueAmount).toBe('number');
    });
  });

  describe('getDisputes', () => {
    beforeEach(async () => {
      const invoice = await service.createInvoice('VENDOR-LIST-DISPUTES', {
        vendorId: 'VENDOR-LIST-DISPUTES',
        invoiceNumber: `INV-LIST-DISPUTES-${Date.now()}`,
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 500,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      await service.createInvoiceDispute(invoice.id, 'other', 'Test dispute', 'user');
    });

    it('should list disputes', async () => {
      const result = await service.getDisputes();

      expect(result.disputes).toBeDefined();
      expect(Array.isArray(result.disputes)).toBe(true);
      expect(result.disputes.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter disputes by status', async () => {
      const result = await service.getDisputes({ status: 'open' });

      expect(result.disputes.every((d: InvoiceDispute) => d.status === 'open')).toBe(true);
    });
  });

  describe('getCreditMemos', () => {
    beforeEach(async () => {
      const invoice = await service.createInvoice('VENDOR-LIST-CREDITS', {
        vendorId: 'VENDOR-LIST-CREDITS',
        invoiceNumber: `INV-LIST-CREDITS-${Date.now()}`,
        invoiceDate: Date.now(),
        dueDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        amount: 1000,
        taxAmount: 0,
        currency: 'USD',
        lineItems: [],
      });

      await service.createCreditMemo(invoice.id, 100, 'Test credit', 'user');
    });

    it('should list credit memos', async () => {
      const result = await service.getCreditMemos();

      expect(result.creditMemos).toBeDefined();
      expect(Array.isArray(result.creditMemos)).toBe(true);
      expect(result.creditMemos.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter by vendor', async () => {
      const result = await service.getCreditMemos({ vendorId: 'VENDOR-LIST-CREDITS' });

      expect(result.creditMemos.every((cm: CreditMemo) => cm.vendorId === 'VENDOR-LIST-CREDITS')).toBe(true);
    });
  });
});
