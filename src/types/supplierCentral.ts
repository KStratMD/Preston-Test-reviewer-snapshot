import type { DocumentParsingOutput } from '../services/ai/orchestrator/agents/DocumentParsingAgent';
import type { VendorOnboardingOutput } from '../services/ai/orchestrator/agents/VendorOnboardingAgent';

export interface VendorProfile {
  id: string;
  externalId?: string; // From source system like Squire
  basicInfo: {
    companyName: string;
    legalName?: string;
    dbaName?: string;
    taxId: string;
    duns?: string;
    website?: string;
    industry: string;
    subIndustry?: string;
    companySize: 'startup' | 'small' | 'medium' | 'large' | 'enterprise';
    yearEstablished?: number;
  };
  contacts: {
    primary: {
      firstName: string;
      lastName: string;
      title: string;
      email: string;
      phone: string;
      mobile?: string;
    };
    accounting?: {
      firstName: string;
      lastName: string;
      title: string;
      email: string;
      phone: string;
    };
    procurement?: {
      firstName: string;
      lastName: string;
      title: string;
      email: string;
      phone: string;
    };
  };
  addresses: {
    headquarters: {
      street1: string;
      street2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
    billing?: {
      street1: string;
      street2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
    shipping?: {
      street1: string;
      street2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
  };
  banking: {
    accountName: string;
    accountNumber: string; // Encrypted
    routingNumber: string;
    bankName: string;
    accountType: 'checking' | 'savings' | 'business';
    currency: string;
    swiftCode?: string; // For international
  };
  compliance: {
    w9Form: {
      status: 'pending' | 'submitted' | 'verified' | 'rejected';
      submittedAt?: number;
      verifiedAt?: number;
      documentUrl?: string;
      rejectionReason?: string;
    };
    insurance: {
      generalLiability: {
        status: 'pending' | 'submitted' | 'verified' | 'rejected' | 'not_required';
        coverage?: number;
        expirationDate?: number;
        certificateUrl?: string;
      };
      workersComp: {
        status: 'pending' | 'submitted' | 'verified' | 'rejected' | 'not_required';
        coverage?: number;
        expirationDate?: number;
        certificateUrl?: string;
      };
      professionalLiability: {
        status: 'pending' | 'submitted' | 'verified' | 'rejected' | 'not_required';
        coverage?: number;
        expirationDate?: number;
        certificateUrl?: string;
      };
    };
    certifications: {
      name: string;
      issuingBody: string;
      certificateNumber: string;
      issuedDate: number;
      expirationDate: number;
      documentUrl?: string;
    }[];
  };
  capabilities: {
    services: string[];
    specializations: string[];
    geographicCoverage: string[];
    languages: string[];
    businessHours: {
      timezone: string;
      monday: { start: string; end: string; } | null;
      tuesday: { start: string; end: string; } | null;
      wednesday: { start: string; end: string; } | null;
      thursday: { start: string; end: string; } | null;
      friday: { start: string; end: string; } | null;
      saturday: { start: string; end: string; } | null;
      sunday: { start: string; end: string; } | null;
    };
    capacity: {
      maxConcurrentProjects?: number;
      availableStartDate?: number;
      preferredProjectSize?: 'small' | 'medium' | 'large' | 'enterprise';
    };
  };
  onboardingStatus: {
    stage: 'initiated' | 'profile_complete' | 'documents_pending' | 'compliance_review' | 'approved' | 'active' | 'suspended' | 'rejected';
    progress: number; // 0-100
    completedSteps: string[];
    nextSteps: string[];
    assignedTo?: string;
    notes: {
      id: string;
      timestamp: number;
      author: string;
      content: string;
      type: 'info' | 'warning' | 'error' | 'success';
    }[];
    approvedAt?: number;
    approvedBy?: string;
    rejectionReason?: string;
  };
  businessCentral: {
    vendorId?: string;
    syncStatus: 'pending' | 'synced' | 'failed' | 'ignored';
    syncAttempts: number;
    lastSyncAttempt?: number;
    syncErrors?: string[];
  };
  netSuite: {
    vendorId?: string;
    internalId?: string;
    externalId?: string;
    syncStatus: 'pending' | 'synced' | 'failed' | 'ignored';
    syncAttempts: number;
    lastSyncAttempt?: number;
    lastSyncSuccess?: number;
    syncErrors?: string[];
    subsidiary?: string;
    terms?: string;
    currency?: string;
  };
  metadata: {
    createdAt: number;
    updatedAt: number;
    source: 'portal' | 'api' | 'import' | 'squire';
    tags: string[];
    customFields: Record<string, unknown>;
  };
}

export interface OnboardingTemplate {
  id: string;
  name: string;
  description: string;
  industry?: string;
  requiredDocuments: {
    documentType: 'w9' | 'insurance_gl' | 'insurance_wc' | 'insurance_pl' | 'certification' | 'contract' | 'reference';
    required: boolean;
    description: string;
    acceptedFormats: string[];
    maxSize: number; // bytes
    expirationRequired: boolean;
  }[];
  complianceRequirements: {
    minimumInsuranceCoverage?: {
      generalLiability?: number;
      workersComp?: number;
      professionalLiability?: number;
    };
    requiredCertifications?: string[];
    backgroundCheckRequired?: boolean;
    creditCheckRequired?: boolean;
  };
  approvalWorkflow: {
    steps: {
      id: string;
      name: string;
      assignedRole: string;
      autoApprove?: boolean;
      conditions?: Record<string, unknown>;
    }[];
    slaHours: number;
    escalationRules: {
      afterHours: number;
      escalateTo: string;
    }[];
  };
  isActive: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface VendorOnboardingStats {
  summary: {
    totalVendors: number;
    activeVendors: number;
    pendingApproval: number;
    recentlyOnboarded: number;
    averageOnboardingTime: number; // days
    completionRate: number; // percentage
  };
  byStage: {
    stage: VendorProfile['onboardingStatus']['stage'];
    count: number;
    percentage: number;
    averageTimeInStage: number; // days
  }[];
  byIndustry: {
    industry: string;
    count: number;
    averageOnboardingTime: number;
  }[];
  complianceStats: {
    w9Completion: number;
    insuranceCompletion: number;
    certificationCompletion: number;
    overallComplianceRate: number;
  };
  recentActivity: {
    newRegistrations: number;
    completedOnboardings: number;
    documentsSubmitted: number;
    approvalsPending: number;
  };
}

export interface PortalActivity {
  id: string;
  vendorId: string;
  type: 'login' | 'profile_update' | 'document_upload' | 'message_sent' | 'status_change';
  description: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  ipAddress?: string;
  userAgent?: string;
}

export interface POLineItem {
  id: string;
  lineNumber: number;
  itemId: string;
  itemName: string;
  description: string;
  quantity: number;
  confirmedQuantity?: number;
  unitPrice: number;
  confirmedUnitPrice?: number;
  expectedShipDate: number;
  confirmedShipDate?: number;
  status: 'pending' | 'confirmed' | 'partial' | 'shipped' | 'received' | 'cancelled';
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorId: string;
  buyerCompany: string;
  buyerContact: string;
  orderDate: number;
  requestedDeliveryDate: number;
  confirmedDeliveryDate?: number;
  status: 'pending_acknowledgement' | 'acknowledged' | 'in_progress' | 'shipped' | 'received' | 'cancelled';
  lines: POLineItem[];
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
  currency: string;
  shippingAddress: {
    street1: string;
    street2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  notes?: string;
  acknowledgement?: {
    acknowledgedAt: number;
    acknowledgedBy: string;
    notes?: string;
  };
  createdAt: number;
  updatedAt: number;
}

export interface AdvancedShippingNotice {
  id: string;
  asnNumber: string;
  purchaseOrderId: string;
  vendorId: string;
  carrierName: string;
  trackingNumber: string;
  shipDate: number;
  estimatedDeliveryDate: number;
  actualDeliveryDate?: number;
  status: 'created' | 'in_transit' | 'delivered' | 'exception';
  lines: {
    poLineId: string;
    quantityShipped: number;
    lotNumber?: string;
    serialNumbers?: string[];
  }[];
  packingList?: string;
  createdAt: number;
  updatedAt: number;
}

// ==========================================
// Named aliases for anonymous method shapes
// ==========================================

/** Input to {@link SupplierCentralService.createVendorProfile}. */
export type CreateVendorProfileInput = Omit<
  VendorProfile,
  'id' | 'metadata' | 'onboardingStatus' | 'businessCentral' | 'netSuite'
>;

/** Filter options for {@link SupplierCentralService.getVendorProfiles}. */
export interface VendorProfileFilters {
  stage?: VendorProfile['onboardingStatus']['stage'][];
  industry?: string[];
  companySize?: string[];
  source?: string[];
  createdAfter?: number;
  createdBefore?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Input to {@link SupplierCentralService.uploadDocument}. */
export interface DocumentUploadInput {
  fileName: string;
  fileSize: number;
  mimeType: string;
  content?: string; // base64 or file path for demo
  expirationDate?: number;
  metadata?: Record<string, unknown>;
}

/** Return shape of {@link SupplierCentralService.uploadDocument}. */
export interface DocumentUploadResult {
  documentId: string;
  uploadUrl?: string;
  aiExtraction?: DocumentParsingOutput;
}

/** Document data input to {@link SupplierCentralService.parseDocument}. */
export interface DocumentParseInput {
  fileName: string;
  mimeType: string;
  content: string;
  expectedType?: 'w9' | 'coi' | 'unknown';
}

/** Optional vendor context passed to {@link SupplierCentralService.parseDocument}. */
export interface DocumentParseVendorContext {
  vendorId?: string;
  vendorName?: string;
  existingTin?: string;
}

/** Return shape of {@link SupplierCentralService.parseDocument}. */
export interface DocumentParseResult {
  success: boolean;
  parsing?: DocumentParsingOutput;
  error?: string;
}

/** Return shape of {@link SupplierCentralService.assessVendorForApproval}. */
export interface VendorAssessmentResult {
  vendorId: string;
  assessment: VendorOnboardingOutput | null;
  error?: string;
}

/** Return shape of {@link SupplierCentralService.syncVendorToBusinessCentral}. */
export interface BusinessCentralSyncResult {
  success: boolean;
  bcVendorId?: string;
  error?: string;
}

/** Return shape of {@link SupplierCentralService.getPortalActivity}. */
export interface PortalActivityPage {
  activities: PortalActivity[];
  totalCount: number;
}

/** Filter options for {@link SupplierCentralService.getPurchaseOrdersForVendor}. */
export interface PurchaseOrderFilters {
  status?: PurchaseOrder['status'];
  fromDate?: number;
  toDate?: number;
  limit?: number;
  offset?: number;
}

/** Return shape of {@link SupplierCentralService.getPurchaseOrdersForVendor}. */
export interface PurchaseOrderPage {
  orders: PurchaseOrder[];
  totalCount: number;
}

/** Input to {@link SupplierCentralService.createPurchaseOrder}. */
export interface CreatePurchaseOrderInput {
  vendorId?: string;
  vendorName?: string;
  buyerCompany?: string;
  buyerContact?: string;
  requestedDeliveryDate?: number;
  currency?: string;
  notes?: string;
  createdBy?: string;
  shippingAddress?: Partial<PurchaseOrder['shippingAddress']>;
  lines?: {
    itemId?: string;
    itemName: string;
    description?: string;
    quantity: number;
    unitPrice: number;
    expectedShipDate?: number;
  }[];
}

/** Acknowledgement payload for {@link SupplierCentralService.acknowledgePurchaseOrder}. */
export interface PurchaseOrderAcknowledgementInput {
  acknowledgedBy: string;
  notes?: string;
  lineConfirmations?: {
    lineId: string;
    confirmedQuantity: number;
    confirmedUnitPrice?: number;
    confirmedShipDate?: number;
  }[];
}

/** Input to {@link SupplierCentralService.createAdvancedShippingNotice}. */
export type CreateAdvancedShippingNoticeInput = Omit<
  AdvancedShippingNotice,
  'id' | 'asnNumber' | 'status' | 'createdAt' | 'updatedAt'
>;

/** Governance pacing configuration for NetSuite API calls. */
export interface GovernanceConfig {
  maxRequestsPerMinute: number;
  maxConcurrent: number;
  batchSize: number;
  retryDelayMs: number;
  maxRetries: number;
  cooldownMs: number;
}

/**
 * Return shape of {@link SupplierCentralService.syncVendorToNetSuite}
 * and {@link SupplierCentralService.syncPurchaseOrderToNetSuite}.
 */
export interface NetSuiteSyncResult {
  success: boolean;
  netSuiteId?: string;
  error?: string;
}

/** Return shape of {@link SupplierCentralService.batchSyncVendorsToNetSuite}. */
export interface BatchNetSuiteSyncResult {
  total: number;
  successful: number;
  failed: number;
  results: { vendorId: string; success: boolean; netSuiteId?: string; error?: string }[];
}

/** Return shape of {@link SupplierCentralService.getNetSuiteSyncStatus}. */
export interface NetSuiteSyncStatus {
  summary: {
    total: number;
    synced: number;
    pending: number;
    failed: number;
    ignored: number;
  };
  recentSyncs: {
    vendorId: string;
    companyName: string;
    status: string;
    lastSyncAttempt?: number;
    netSuiteId?: string;
  }[];
  failedSyncs: {
    vendorId: string;
    companyName: string;
    attempts: number;
    lastError?: string;
  }[];
  governance: {
    requestsInLastMinute: number;
    activeRequests: number;
    config: GovernanceConfig;
  };
}

/** Return shape of {@link SupplierCentralService.getGovernanceMetrics}. */
export interface GovernanceMetrics {
  requestsInLastMinute: number;
  activeRequests: number;
  config: GovernanceConfig;
  healthStatus: 'healthy' | 'throttled' | 'at_limit';
}
