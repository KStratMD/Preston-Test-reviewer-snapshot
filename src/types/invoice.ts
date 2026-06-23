/**
 * Invoice types for PaymentCentral Invoice Matching feature
 * Phase 6 Implementation
 */

/**
 * Invoice line item
 */
export interface InvoiceLineItem {
  lineNumber: number;
  itemCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  taxAmount?: number;
  poLineNumber?: number; // Reference to PO line for matching
}

/**
 * Match discrepancy between invoice and PO/receipt
 */
export interface MatchDiscrepancy {
  field: 'quantity' | 'price' | 'total' | 'item' | 'tax';
  lineNumber?: number;
  invoiceValue: number | string;
  poValue: number | string;
  receiptValue?: number | string;
  tolerance: number;
  tolerancePercent: number;
  withinTolerance: boolean;
  severity: 'info' | 'warning' | 'error';
}

/**
 * Invoice match result
 */
export interface InvoiceMatchResult {
  poId?: string;
  poNumber?: string;
  receiptId?: string;
  receiptNumber?: string;
  matchType: '2-way' | '3-way' | 'none';
  matchConfidence: number;
  matchedAt?: number;
  matchedBy?: string;
  discrepancies: MatchDiscrepancy[];
  autoMatched: boolean;
}

/**
 * Invoice status types
 */
export type InvoiceMatchStatus = 'pending' | 'matched' | 'partial' | 'disputed' | 'approved' | 'rejected';
export type InvoicePaymentStatus = 'unpaid' | 'scheduled' | 'processing' | 'paid' | 'held' | 'cancelled';

/**
 * Main Invoice entity
 */
export interface Invoice {
  id: string;
  vendorId: string;
  vendorName?: string;
  invoiceNumber: string;
  invoiceDate: number;
  receivedDate: number;
  dueDate: number;
  amount: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  lineItems: InvoiceLineItem[];
  matchStatus: InvoiceMatchStatus;
  matchResult?: InvoiceMatchResult;
  paymentStatus: InvoicePaymentStatus;
  paymentDate?: number;
  paymentReference?: string;
  disputeId?: string;
  creditMemoIds?: string[];
  notes?: string;
  attachmentUrls?: string[];
  metadata: {
    createdAt: number;
    createdBy: string;
    updatedAt?: number;
    updatedBy?: string;
    source?: 'manual' | 'upload' | 'edi' | 'api' | 'email';
  };
}

/**
 * Invoice dispute
 */
export interface InvoiceDispute {
  id: string;
  invoiceId: string;
  vendorId: string;
  reason: 'price_mismatch' | 'quantity_mismatch' | 'item_not_received' | 'damaged_goods' | 'duplicate_invoice' | 'other';
  description: string;
  status: 'open' | 'investigating' | 'pending_vendor' | 'resolved' | 'closed';
  resolution?: {
    type: 'credit_memo' | 'price_adjustment' | 'quantity_adjustment' | 'invoice_cancelled' | 'invoice_approved' | 'other';
    description: string;
    creditMemoId?: string;
    adjustedAmount?: number;
    resolvedAt: number;
    resolvedBy: string;
  };
  metadata: {
    createdAt: number;
    createdBy: string;
    updatedAt?: number;
    updatedBy?: string;
  };
  history: DisputeHistoryEntry[];
}

/**
 * Dispute history entry
 */
export interface DisputeHistoryEntry {
  timestamp: number;
  action: 'created' | 'updated' | 'comment_added' | 'status_changed' | 'resolved';
  user: string;
  details: string;
  previousStatus?: string;
  newStatus?: string;
}

/**
 * Credit memo
 */
export interface CreditMemo {
  id: string;
  invoiceId: string;
  disputeId?: string;
  vendorId: string;
  creditMemoNumber: string;
  amount: number;
  currency: string;
  reason: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'applied' | 'cancelled';
  appliedTo?: {
    invoiceId: string;
    amount: number;
    appliedAt: number;
  }[];
  metadata: {
    createdAt: number;
    createdBy: string;
    approvedAt?: number;
    approvedBy?: string;
  };
}

/**
 * Invoice matching configuration
 */
export interface InvoiceMatchingConfig {
  tolerances: {
    price: { absolute: number; percent: number };
    quantity: { absolute: number; percent: number };
    total: { absolute: number; percent: number };
    tax: { absolute: number; percent: number };
  };
  autoApproveThreshold: number; // Confidence threshold for auto-approval
  requireReceiptFor3Way: boolean;
  allowPartialMatches: boolean;
  autoMatchEnabled: boolean;
}

/**
 * Invoice statistics
 */
export interface InvoiceStatistics {
  totalInvoices: number;
  pendingMatch: number;
  matched: number;
  disputed: number;
  approved: number;
  totalAmount: number;
  overdueAmount: number;
  averageMatchTime: number; // in hours
  autoMatchRate: number; // percentage
  disputeRate: number; // percentage
}

/**
 * Invoice filter options
 */
export interface InvoiceFilters {
  vendorId?: string;
  matchStatus?: InvoiceMatchStatus[];
  paymentStatus?: InvoicePaymentStatus[];
  dateFrom?: number;
  dateTo?: number;
  amountMin?: number;
  amountMax?: number;
  hasDispute?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}
