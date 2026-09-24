export interface PaymentProcessor {
  id: string;
  name: string;
  type: 'stripe' | 'adyen' | 'paypal' | 'worldpay' | 'braintree' | 'square' | 'custom';
  status: 'active' | 'inactive' | 'maintenance' | 'error';
  apiEndpoint: string;
  credentials: {
    encrypted: boolean;
    lastUpdated: number;
    credentialId: string;
  };
  features: {
    recurring: boolean;
    multiCurrency: boolean;
    refunds: boolean;
    disputes: boolean;
    webhooks: boolean;
    reporting: boolean;
  };
  limits: {
    dailyVolume: number;
    monthlyVolume: number;
    maxTransactionAmount: number;
    minTransactionAmount: number;
  };
  fees: {
    percentage: number;
    fixed: number;
    currency: string;
  };
  metadata: {
    environment: 'sandbox' | 'production';
    region: string;
    compliance: string[];
  };
}

export interface PaymentTransaction {
  id: string;
  processorId: string;
  processorTransactionId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'refunded' | 'disputed';
  type: 'payment' | 'refund' | 'chargeback' | 'fee' | 'adjustment';
  timestamp: number;
  customer: {
    id: string;
    email?: string;
    name?: string;
  };
  merchant: {
    id: string;
    name: string;
    mcc: string; // Merchant Category Code
  };
  paymentMethod: {
    type: 'card' | 'ach' | 'wire' | 'wallet' | 'cryptocurrency';
    last4?: string;
    brand?: string;
    country?: string;
  };
  fees: {
    processingFee: number;
    platformFee: number;
    networkFee: number;
    total: number;
  };
  risk: {
    score: number;
    level: 'low' | 'medium' | 'high' | 'blocked';
    reasons: string[];
  };
  businessCentral: {
    customerId?: string;
    invoiceId?: string;
    glAccount?: string;
    syncStatus: 'pending' | 'synced' | 'failed' | 'ignored';
    syncAttempts: number;
    lastSyncAttempt?: number;
    syncErrors?: string[];
  };
  metadata: Record<string, unknown>;
}

export interface ReconciliationReport {
  id: string;
  dateRange: { start: number; end: number };
  processors: string[];
  summary: {
    totalTransactions: number;
    totalAmount: number;
    totalFees: number;
    netAmount: number;
    reconciledTransactions: number;
    unreconciledTransactions: number;
    reconciledAmount: number;
    unreconciledAmount: number;
    discrepancies: number;
    discrepancyAmount: number;
  };
  processorBreakdown: {
    processorId: string;
    processorName: string;
    transactions: number;
    amount: number;
    fees: number;
    net: number;
    reconciled: number;
    discrepancies: number;
  }[];
  discrepancies: {
    id: string;
    type: 'missing_bc' | 'missing_processor' | 'amount_mismatch' | 'status_mismatch' | 'duplicate';
    severity: 'low' | 'medium' | 'high' | 'critical';
    processorId: string;
    transactionId: string;
    processorAmount?: number;
    businessCentralAmount?: number;
    description: string;
    suggestedAction: string;
    autoResolvable: boolean;
  }[];
  generatedAt: number;
  generatedBy: string;
  status: 'generating' | 'completed' | 'failed';
}

export interface PaymentAnalytics {
  summary: {
    totalVolume: number;
    totalTransactions: number;
    averageTransactionSize: number;
    successRate: number;
    totalFees: number;
    netRevenue: number;
  };
  processorPerformance: {
    processorId: string;
    name: string;
    volume: number;
    transactions: number;
    successRate: number;
    averageProcessingTime: number;
    totalFees: number;
    reliability: number;
    costEfficiency: number;
  }[];
  timeAnalysis: {
    hourlyVolume: { hour: number; volume: number; transactions: number }[];
    dailyTrends: { date: string; volume: number; transactions: number }[];
    peakHours: number[];
    seasonalityScore: number;
  };
  riskAnalysis: {
    riskDistribution: { level: string; count: number; percentage: number }[];
    fraudPrevented: number;
    chargebackRate: number;
    disputeResolutionRate: number;
    averageRiskScore: number;
  };
  reconciliationHealth: {
    reconciliationRate: number;
    averageReconciliationTime: number;
    unreconciledAmount: number;
    oldestUnreconciledTransaction: number;
    discrepancyTrend: 'improving' | 'stable' | 'declining';
  };
}

// ==================== DUNNING AUTOMATION INTERFACES ====================

export interface DunningSchedule {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'paused';
  levels: DunningLevel[];
  filters: {
    minAmount?: number;
    maxAmount?: number;
    customerTypes?: string[];
    excludeCustomerIds?: string[];
    regions?: string[];
  };
  settings: {
    sendEmail: boolean;
    sendSms: boolean;
    escalateToCollections: boolean;
    collectionsDaysThreshold: number;
    pauseDuringHolidays: boolean;
    businessHoursOnly: boolean;
  };
  createdAt: number;
  updatedAt: number;
}

export interface DunningLevel {
  level: number;
  daysOverdue: number;
  action: 'reminder' | 'warning' | 'final_notice' | 'collections';
  emailTemplateId: string;
  smsTemplateId?: string;
  tone: 'friendly' | 'neutral' | 'firm' | 'final';
  fee?: number;
  interestRate?: number;
}

export interface DunningEntry {
  id: string;
  scheduleId: string;
  invoiceId: string;
  customerId: string;
  customerEmail: string;
  customerName: string;
  invoiceAmount: number;
  amountDue: number;
  currency: string;
  invoiceDate: number;
  dueDate: number;
  daysOverdue: number;
  currentLevel: number;
  status: 'pending' | 'sent' | 'responded' | 'paid' | 'escalated' | 'paused' | 'cancelled';
  history: DunningAction[];
  nextActionDate?: number;
  paymentLink?: string;
  metadata: Record<string, unknown>;
}

export interface DunningAction {
  timestamp: number;
  level: number;
  action: 'email_sent' | 'sms_sent' | 'reminder_sent' | 'payment_received' | 'escalated' | 'paused' | 'cancelled' | 'customer_response';
  details: string;
  sentTo?: string;
  responseReceived?: string;
  amount?: number;
  // AI-powered dunning metadata
  aiGenerated?: boolean;
  aiTone?: string;
  aiPaymentLikelihood?: number;
  aiChurnRisk?: number;
  customerResponse?: string;
}

export interface DunningStatistics {
  totalOverdueInvoices: number;
  totalOverdueAmount: number;
  byLevel: { level: number; count: number; amount: number }[];
  byStatus: { status: string; count: number; amount: number }[];
  recoveryRate: number;
  averageDaysToPayment: number;
  escalatedToCollections: number;
  emailsSentToday: number;
  paymentsReceivedToday: number;
  paymentsReceivedAmount: number;
}

// ==================== GL POSTING INTERFACES ====================

export interface GLAccount {
  id: string;
  accountNumber: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subType?: string;
  currency: string;
  isActive: boolean;
  parentAccountId?: string;
  description?: string;
}

export interface JournalEntryLine {
  lineNumber: number;
  accountId: string;
  accountNumber: string;
  accountName: string;
  debit: number;
  credit: number;
  memo?: string;
  department?: string;
  class?: string;
  location?: string;
  entity?: {
    type: 'customer' | 'vendor' | 'employee';
    id: string;
    name: string;
  };
}

export interface JournalEntry {
  id: string;
  entryNumber: string;
  transactionDate: number;
  postingDate: number;
  status: 'draft' | 'pending_approval' | 'approved' | 'posted' | 'voided' | 'failed';
  currency: string;
  exchangeRate: number;
  memo: string;
  lines: JournalEntryLine[];
  totalDebit: number;
  totalCredit: number;
  sourceType: 'payment' | 'refund' | 'fee' | 'adjustment' | 'reconciliation';
  sourceId: string;
  sourceReference?: string;
  createdBy: string;
  createdAt: number;
  approvedBy?: string;
  approvedAt?: number;
  postedBy?: string;
  postedAt?: number;
  netSuiteId?: string;
  syncStatus: 'pending' | 'synced' | 'failed';
  syncError?: string;
}

export interface GLPostingBatch {
  id: string;
  name: string;
  description?: string;
  status: 'open' | 'processing' | 'completed' | 'failed' | 'partially_completed';
  entries: string[]; // Journal entry IDs
  totalEntries: number;
  processedEntries: number;
  successfulEntries: number;
  failedEntries: number;
  totalDebit: number;
  totalCredit: number;
  createdBy: string;
  createdAt: number;
  processedAt?: number;
  errors: { entryId: string; error: string }[];
}

export interface GLPostingResult {
  success: boolean;
  journalEntryId?: string;
  netSuiteId?: string;
  error?: string;
  warnings?: string[];
}

export interface GLPostingStatistics {
  totalEntriesPosted: number;
  totalEntriesPending: number;
  totalEntriesFailed: number;
  totalDebitPosted: number;
  totalCreditPosted: number;
  pendingBatches: number;
  lastPostingDate?: number;
  accountsUsed: { accountId: string; accountNumber: string; name: string; transactionCount: number }[];
}

// ==================== FILTER / RESULT ALIASES ====================

export interface PaymentTransactionFilters {
  processorIds?: string[];
  status?: string[];
  dateRange?: { start: number; end: number };
  amountRange?: { min: number; max: number };
  customerIds?: string[];
  syncStatus?: string[];
  limit?: number;
  offset?: number;
}

export interface PaymentTransactionListResult {
  transactions: PaymentTransaction[];
  totalCount: number;
}

export interface DunningEntryFilters {
  scheduleId?: string;
  status?: DunningEntry['status'][];
  level?: number[];
  daysOverdueMin?: number;
  daysOverdueMax?: number;
  amountMin?: number;
  amountMax?: number;
  customerId?: string;
  limit?: number;
  offset?: number;
}

export interface DunningEntryListResult {
  entries: DunningEntry[];
  totalCount: number;
}
