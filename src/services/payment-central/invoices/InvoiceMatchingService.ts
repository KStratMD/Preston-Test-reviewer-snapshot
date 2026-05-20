import type {
  Invoice,
  InvoiceLineItem,
  InvoiceDispute,
  CreditMemo,
  InvoiceMatchResult,
  MatchDiscrepancy,
  InvoiceFilters,
  InvoiceStatistics,
  InvoiceMatchingConfig,
} from '../../../types/invoice';
import type { PaymentCentralRuntime } from '../PaymentCentralRuntime';

export class InvoiceMatchingService {
  // Invoice matching storage
  private invoices = new Map<string, Invoice>();
  private invoiceDisputes = new Map<string, InvoiceDispute>();
  private creditMemos = new Map<string, CreditMemo>();
  private invoiceMatchingConfig: InvoiceMatchingConfig = {
    tolerances: {
      price: { absolute: 0.01, percent: 1 },
      quantity: { absolute: 0, percent: 0 },
      total: { absolute: 1.00, percent: 2 },
      tax: { absolute: 0.10, percent: 5 },
    },
    autoApproveThreshold: 0.95,
    requireReceiptFor3Way: true,
    allowPartialMatches: true,
    autoMatchEnabled: true,
  };

  constructor(private readonly runtime: PaymentCentralRuntime) {}

  /**
   * Create a new invoice
   */
  async createInvoice(
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
  ): Promise<Invoice> {
    const id = this.runtime.createId('inv');
    const now = this.runtime.now();

    const lineItems: InvoiceLineItem[] = invoiceData.lineItems.map((item, index) => ({
      ...item,
      lineNumber: index + 1,
    }));

    const totalAmount = invoiceData.amount + (invoiceData.taxAmount || 0);

    const invoice: Invoice = {
      id,
      vendorId,
      invoiceNumber: invoiceData.invoiceNumber,
      invoiceDate: invoiceData.invoiceDate,
      receivedDate: now,
      dueDate: invoiceData.dueDate,
      amount: invoiceData.amount,
      taxAmount: invoiceData.taxAmount || 0,
      totalAmount,
      currency: invoiceData.currency || 'USD',
      lineItems,
      matchStatus: 'pending',
      paymentStatus: 'unpaid',
      notes: invoiceData.notes,
      attachmentUrls: invoiceData.attachmentUrls,
      metadata: {
        createdAt: now,
        createdBy,
        source: invoiceData.source || 'manual',
      },
    };

    this.invoices.set(id, invoice);

    this.runtime.logger.info('Invoice created', {
      invoiceId: id,
      vendorId,
      invoiceNumber: invoiceData.invoiceNumber,
      amount: totalAmount,
    });

    return invoice;
  }

  /**
   * Get invoice by ID
   */
  async getInvoice(invoiceId: string): Promise<Invoice | null> {
    return this.invoices.get(invoiceId) || null;
  }

  /**
   * Get invoices with filtering
   */
  async getInvoices(filters: InvoiceFilters = {}): Promise<{
    invoices: Invoice[];
    totalCount: number;
  }> {
    let filtered = Array.from(this.invoices.values());

    if (filters.vendorId) {
      filtered = filtered.filter(inv => inv.vendorId === filters.vendorId);
    }

    if (filters.matchStatus && filters.matchStatus.length > 0) {
      filtered = filtered.filter(inv => filters.matchStatus!.includes(inv.matchStatus));
    }

    if (filters.paymentStatus && filters.paymentStatus.length > 0) {
      filtered = filtered.filter(inv => filters.paymentStatus!.includes(inv.paymentStatus));
    }

    if (filters.dateFrom) {
      filtered = filtered.filter(inv => inv.invoiceDate >= filters.dateFrom!);
    }

    if (filters.dateTo) {
      filtered = filtered.filter(inv => inv.invoiceDate <= filters.dateTo!);
    }

    if (filters.amountMin !== undefined) {
      filtered = filtered.filter(inv => inv.totalAmount >= filters.amountMin!);
    }

    if (filters.amountMax !== undefined) {
      filtered = filtered.filter(inv => inv.totalAmount <= filters.amountMax!);
    }

    if (filters.hasDispute !== undefined) {
      filtered = filtered.filter(inv =>
        filters.hasDispute ? !!inv.disputeId : !inv.disputeId
      );
    }

    if (filters.search) {
      const search = filters.search.toLowerCase();
      filtered = filtered.filter(inv =>
        inv.invoiceNumber.toLowerCase().includes(search) ||
        inv.vendorName?.toLowerCase().includes(search) ||
        inv.vendorId.toLowerCase().includes(search)
      );
    }

    // Sort by invoice date descending
    filtered.sort((a, b) => b.invoiceDate - a.invoiceDate);

    const totalCount = filtered.length;

    // Apply pagination
    if (filters.offset !== undefined) {
      filtered = filtered.slice(filters.offset);
    }
    if (filters.limit !== undefined) {
      filtered = filtered.slice(0, filters.limit);
    }

    return { invoices: filtered, totalCount };
  }

  /**
   * Match invoice to PO (2-way matching)
   */
  async matchInvoiceToPO(
    invoiceId: string,
    poId: string,
    matchedBy = 'system'
  ): Promise<{
    success: boolean;
    matchResult?: InvoiceMatchResult;
    error?: string;
  }> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    // In demo mode, simulate PO lookup
    const poData = this.simulatePOLookup(poId, invoice);
    if (!poData) {
      return { success: false, error: 'Purchase order not found' };
    }

    const discrepancies = this.identifyDiscrepancies(invoice, poData);
    const confidence = this.calculateMatchConfidence(discrepancies);
    const withinTolerance = discrepancies.every(d => d.withinTolerance);

    const matchResult: InvoiceMatchResult = {
      poId,
      poNumber: poData.poNumber,
      matchType: '2-way',
      matchConfidence: confidence,
      matchedAt: this.runtime.now(),
      matchedBy,
      discrepancies,
      autoMatched: matchedBy === 'system',
    };

    invoice.matchResult = matchResult;
    invoice.matchStatus = withinTolerance ? 'matched' : 'partial';
    invoice.metadata.updatedAt = this.runtime.now();
    invoice.metadata.updatedBy = matchedBy;

    this.invoices.set(invoiceId, invoice);

    this.runtime.logger.info('Invoice matched to PO', {
      invoiceId,
      poId,
      matchType: '2-way',
      confidence,
      discrepancyCount: discrepancies.length,
    });

    return { success: true, matchResult };
  }

  /**
   * Auto-match invoice using heuristics
   */
  async autoMatchInvoice(invoiceId: string): Promise<{
    success: boolean;
    matchResult?: InvoiceMatchResult;
    candidates?: { poId: string; confidence: number }[];
    error?: string;
  }> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    const candidates = this.findPOCandidates(invoice);

    if (candidates.length === 0) {
      return { success: false, candidates: [], error: 'No matching PO candidates found' };
    }

    const bestMatch = candidates[0];
    if (bestMatch.confidence >= this.invoiceMatchingConfig.autoApproveThreshold) {
      const result = await this.matchInvoiceToPO(invoiceId, bestMatch.poId, 'system');
      return { ...result, candidates };
    }

    return { success: false, candidates, error: 'No match above auto-approve threshold' };
  }

  /**
   * Approve a matched invoice for payment
   */
  async approveInvoice(
    invoiceId: string,
    approvedBy: string
  ): Promise<{ success: boolean; error?: string }> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    if (invoice.matchStatus !== 'matched' && invoice.matchStatus !== 'partial') {
      return { success: false, error: 'Invoice must be matched before approval' };
    }

    invoice.matchStatus = 'approved';
    invoice.paymentStatus = 'scheduled';
    invoice.metadata.updatedAt = this.runtime.now();
    invoice.metadata.updatedBy = approvedBy;

    this.invoices.set(invoiceId, invoice);
    this.runtime.logger.info('Invoice approved', { invoiceId, approvedBy });

    return { success: true };
  }

  /**
   * Create a dispute for an invoice
   */
  async createInvoiceDispute(
    invoiceId: string,
    reason: InvoiceDispute['reason'],
    description: string,
    createdBy: string
  ): Promise<{ success: boolean; dispute?: InvoiceDispute; error?: string }> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    const id = this.runtime.createId('disp');
    const now = this.runtime.now();

    const dispute: InvoiceDispute = {
      id,
      invoiceId,
      vendorId: invoice.vendorId,
      reason,
      description,
      status: 'open',
      metadata: { createdAt: now, createdBy },
      history: [{
        timestamp: now,
        action: 'created',
        user: createdBy,
        details: `Dispute created: ${reason}`,
      }],
    };

    this.invoiceDisputes.set(id, dispute);

    invoice.disputeId = id;
    invoice.matchStatus = 'disputed';
    invoice.paymentStatus = 'held';
    invoice.metadata.updatedAt = now;
    invoice.metadata.updatedBy = createdBy;
    this.invoices.set(invoiceId, invoice);

    this.runtime.logger.info('Invoice dispute created', { disputeId: id, invoiceId, reason });
    return { success: true, dispute };
  }

  /**
   * Resolve an invoice dispute
   */
  async resolveDispute(
    disputeId: string,
    resolution: {
      type: 'credit_memo' | 'price_adjustment' | 'quantity_adjustment' | 'invoice_cancelled' | 'invoice_approved' | 'other';
      description: string;
      adjustedAmount?: number;
    },
    resolvedBy: string
  ): Promise<{ success: boolean; creditMemo?: CreditMemo; error?: string }> {
    const dispute = this.invoiceDisputes.get(disputeId);
    if (!dispute) {
      return { success: false, error: 'Dispute not found' };
    }

    const now = this.runtime.now();
    let creditMemo: CreditMemo | undefined;

    if (resolution.type === 'credit_memo' && resolution.adjustedAmount) {
      creditMemo = await this.createCreditMemo(
        dispute.invoiceId,
        resolution.adjustedAmount,
        resolution.description,
        resolvedBy,
        disputeId
      );
    }

    const previousStatus = dispute.status;
    dispute.resolution = {
      type: resolution.type,
      description: resolution.description,
      creditMemoId: creditMemo?.id,
      adjustedAmount: resolution.adjustedAmount,
      resolvedAt: now,
      resolvedBy,
    };
    dispute.status = 'resolved';
    dispute.metadata.updatedAt = now;
    dispute.metadata.updatedBy = resolvedBy;
    dispute.history.push({
      timestamp: now,
      action: 'resolved',
      user: resolvedBy,
      details: `Dispute resolved: ${resolution.type}`,
      previousStatus,
      newStatus: 'resolved',
    });

    this.invoiceDisputes.set(disputeId, dispute);

    const invoice = this.invoices.get(dispute.invoiceId);
    if (invoice) {
      invoice.matchStatus = resolution.type === 'invoice_cancelled' ? 'rejected' : 'approved';
      invoice.paymentStatus = resolution.type === 'invoice_cancelled' ? 'cancelled' : 'scheduled';
      invoice.metadata.updatedAt = now;
      invoice.metadata.updatedBy = resolvedBy;
      this.invoices.set(dispute.invoiceId, invoice);
    }

    this.runtime.logger.info('Dispute resolved', { disputeId, resolution: resolution.type });
    return { success: true, creditMemo };
  }

  /**
   * Create a credit memo
   */
  async createCreditMemo(
    invoiceId: string,
    amount: number,
    reason: string,
    createdBy: string,
    disputeId?: string
  ): Promise<CreditMemo> {
    const invoice = this.invoices.get(invoiceId);

    if (!invoice) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    // Calculate existing credits already applied to this invoice
    const existingCredits = Array.from(this.creditMemos.values())
      .filter(cm => cm.invoiceId === invoiceId && cm.status !== 'cancelled')
      .reduce((sum, cm) => sum + cm.amount, 0);

    // Check if new credit would exceed invoice total
    if (amount + existingCredits > invoice.totalAmount) {
      throw new Error(
        `Credit memo amount ($${amount}) exceeds remaining invoice balance ($${invoice.totalAmount - existingCredits})`
      );
    }

    const id = this.runtime.createId('cm');
    const now = this.runtime.now();

    const creditMemo: CreditMemo = {
      id,
      invoiceId,
      disputeId,
      vendorId: invoice.vendorId,
      creditMemoNumber: `CM-${new Date(now).getFullYear()}-${String(this.creditMemos.size + 1).padStart(5, '0')}`,
      amount,
      currency: invoice.currency,
      reason,
      status: 'pending_approval',
      metadata: { createdAt: now, createdBy },
    };

    this.creditMemos.set(id, creditMemo);

    invoice.creditMemoIds = [...(invoice.creditMemoIds || []), id];
    this.invoices.set(invoiceId, invoice);

    this.runtime.logger.info('Credit memo created', { creditMemoId: id, invoiceId, amount });
    return creditMemo;
  }

  /**
   * Get invoice disputes
   */
  async getDisputes(filters: {
    status?: InvoiceDispute['status'][];
    vendorId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ disputes: InvoiceDispute[]; totalCount: number }> {
    let filtered = Array.from(this.invoiceDisputes.values());

    if (filters.status && filters.status.length > 0) {
      filtered = filtered.filter(d => filters.status!.includes(d.status));
    }
    if (filters.vendorId) {
      filtered = filtered.filter(d => d.vendorId === filters.vendorId);
    }

    filtered.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);
    const totalCount = filtered.length;

    if (filters.offset !== undefined) filtered = filtered.slice(filters.offset);
    if (filters.limit !== undefined) filtered = filtered.slice(0, filters.limit);

    return { disputes: filtered, totalCount };
  }

  /**
   * Get credit memos
   */
  async getCreditMemos(filters: {
    vendorId?: string;
    status?: CreditMemo['status'][];
    limit?: number;
    offset?: number;
  } = {}): Promise<{ creditMemos: CreditMemo[]; totalCount: number }> {
    let filtered = Array.from(this.creditMemos.values());

    if (filters.vendorId) {
      filtered = filtered.filter(cm => cm.vendorId === filters.vendorId);
    }
    if (filters.status && filters.status.length > 0) {
      filtered = filtered.filter(cm => filters.status!.includes(cm.status));
    }

    filtered.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt);
    const totalCount = filtered.length;

    if (filters.offset !== undefined) filtered = filtered.slice(filters.offset);
    if (filters.limit !== undefined) filtered = filtered.slice(0, filters.limit);

    return { creditMemos: filtered, totalCount };
  }

  /**
   * Get invoice statistics
   */
  async getInvoiceStatistics(): Promise<InvoiceStatistics> {
    const invoices = Array.from(this.invoices.values());
    const now = this.runtime.now();

    const overdueInvoices = invoices.filter(inv =>
      inv.dueDate < now && inv.paymentStatus === 'unpaid'
    );
    const matchedInvoices = invoices.filter(inv => inv.matchResult?.matchedAt);
    const autoMatchedCount = matchedInvoices.filter(inv => inv.matchResult?.autoMatched).length;
    const disputedCount = invoices.filter(inv => inv.disputeId).length;

    let totalMatchTime = 0;
    matchedInvoices.forEach(inv => {
      if (inv.matchResult?.matchedAt) {
        totalMatchTime += inv.matchResult.matchedAt - inv.metadata.createdAt;
      }
    });
    const avgMatchTimeHours = matchedInvoices.length > 0
      ? (totalMatchTime / matchedInvoices.length) / (1000 * 60 * 60) : 0;

    return {
      totalInvoices: invoices.length,
      pendingMatch: invoices.filter(inv => inv.matchStatus === 'pending').length,
      matched: invoices.filter(inv => ['matched', 'approved'].includes(inv.matchStatus)).length,
      disputed: disputedCount,
      approved: invoices.filter(inv => inv.matchStatus === 'approved').length,
      totalAmount: invoices.reduce((sum, inv) => sum + inv.totalAmount, 0),
      overdueAmount: overdueInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0),
      averageMatchTime: avgMatchTimeHours,
      autoMatchRate: matchedInvoices.length > 0 ? (autoMatchedCount / matchedInvoices.length) * 100 : 0,
      disputeRate: invoices.length > 0 ? (disputedCount / invoices.length) * 100 : 0,
    };
  }

  // ==================== INVOICE MATCHING HELPERS ====================

  private simulatePOLookup(poId: string, invoice: Invoice): {
    poNumber: string;
    vendorId: string;
    amount: number;
    lineItems: { itemCode: string; quantity: number; unitPrice: number }[];
  } | null {
    return {
      poNumber: `PO-${poId}`,
      vendorId: invoice.vendorId,
      amount: invoice.amount * (0.98 + this.runtime.random() * 0.04),
      lineItems: invoice.lineItems.map(item => ({
        itemCode: item.itemCode,
        quantity: item.quantity,
        unitPrice: item.unitPrice * (0.99 + this.runtime.random() * 0.02),
      })),
    };
  }

  private identifyDiscrepancies(
    invoice: Invoice,
    poData: { amount: number; lineItems: { itemCode: string; quantity: number; unitPrice: number }[] }
  ): MatchDiscrepancy[] {
    const discrepancies: MatchDiscrepancy[] = [];
    const config = this.invoiceMatchingConfig.tolerances;

    const amountDiff = Math.abs(invoice.amount - poData.amount);
    const amountDiffPercent = (amountDiff / poData.amount) * 100;
    discrepancies.push({
      field: 'total',
      invoiceValue: invoice.amount,
      poValue: poData.amount,
      tolerance: config.total.absolute,
      tolerancePercent: config.total.percent,
      withinTolerance: amountDiff <= config.total.absolute || amountDiffPercent <= config.total.percent,
      severity: amountDiff <= config.total.absolute ? 'info' : amountDiffPercent <= config.total.percent * 2 ? 'warning' : 'error',
    });

    invoice.lineItems.forEach(invItem => {
      const poItem = poData.lineItems.find(p => p.itemCode === invItem.itemCode);
      if (poItem) {
        if (invItem.quantity !== poItem.quantity) {
          const qtyDiff = Math.abs(invItem.quantity - poItem.quantity);
          discrepancies.push({
            field: 'quantity',
            lineNumber: invItem.lineNumber,
            invoiceValue: invItem.quantity,
            poValue: poItem.quantity,
            tolerance: config.quantity.absolute,
            tolerancePercent: config.quantity.percent,
            withinTolerance: qtyDiff <= config.quantity.absolute,
            severity: qtyDiff === 0 ? 'info' : 'error',
          });
        }

        const priceDiff = Math.abs(invItem.unitPrice - poItem.unitPrice);
        const priceDiffPercent = (priceDiff / poItem.unitPrice) * 100;
        if (priceDiff > config.price.absolute && priceDiffPercent > config.price.percent) {
          discrepancies.push({
            field: 'price',
            lineNumber: invItem.lineNumber,
            invoiceValue: invItem.unitPrice,
            poValue: poItem.unitPrice,
            tolerance: config.price.absolute,
            tolerancePercent: config.price.percent,
            withinTolerance: false,
            severity: priceDiffPercent <= config.price.percent * 2 ? 'warning' : 'error',
          });
        }
      } else {
        discrepancies.push({
          field: 'item',
          lineNumber: invItem.lineNumber,
          invoiceValue: invItem.itemCode,
          poValue: 'NOT FOUND',
          tolerance: 0,
          tolerancePercent: 0,
          withinTolerance: false,
          severity: 'error',
        });
      }
    });

    return discrepancies;
  }

  private calculateMatchConfidence(discrepancies: MatchDiscrepancy[]): number {
    if (discrepancies.length === 0) return 1.0;

    const errorCount = discrepancies.filter(d => d.severity === 'error').length;
    const warningCount = discrepancies.filter(d => d.severity === 'warning').length;
    const withinToleranceCount = discrepancies.filter(d => d.withinTolerance).length;

    let confidence = 1.0;
    confidence -= errorCount * 0.2;
    confidence -= warningCount * 0.05;
    confidence += (withinToleranceCount / discrepancies.length) * 0.1;

    return Math.max(0, Math.min(1, confidence));
  }

  private findPOCandidates(invoice: Invoice): { poId: string; confidence: number }[] {
    const candidates = [];
    const numCandidates = 1 + Math.floor(this.runtime.random() * 3);
    for (let i = 0; i < numCandidates; i++) {
      candidates.push({
        poId: `PO-${invoice.vendorId}-${this.runtime.now()}-${i}`,
        confidence: 0.7 + this.runtime.random() * 0.28,
      });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates;
  }
}
