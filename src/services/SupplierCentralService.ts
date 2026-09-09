import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { TelemetryService } from './TelemetryService';
import { DocumentParsingAgent, DocumentParsingOutput } from './ai/orchestrator/agents/DocumentParsingAgent';
import { VendorOnboardingAgent } from './ai/orchestrator/agents/VendorOnboardingAgent';

import type {
  VendorProfile,
  PurchaseOrder,
  AdvancedShippingNotice,
  VendorOnboardingStats,
  CreateVendorProfileInput,
  VendorProfileFilters,
  PortalActivityPage,
  VendorAssessmentResult,
  BusinessCentralSyncResult,
  PurchaseOrderFilters,
  PurchaseOrderPage,
  CreatePurchaseOrderInput,
  PurchaseOrderAcknowledgementInput,
  CreateAdvancedShippingNoticeInput,
  NetSuiteSyncResult,
  BatchNetSuiteSyncResult,
  NetSuiteSyncStatus,
  GovernanceConfig,
  GovernanceMetrics,
} from '../types/supplierCentral';

import { TenantSandbox } from './common/TenantSandbox';
import { buildSupplierCentralBundle, type SupplierCentralBundle } from './supplier-central/supplierCentralBundle';

export type {
  VendorProfile,
  OnboardingTemplate,
  VendorOnboardingStats,
  PortalActivity,
  POLineItem,
  PurchaseOrder,
  AdvancedShippingNotice,
} from '../types/supplierCentral';

/**
 * SupplierCentral Service - Enhanced vendor onboarding and self-service portal
 * Extends existing functionality with comprehensive vendor management
 *
 * NOTE: This integrates with existing Squire sync functionality and adds
 * portal-based vendor onboarding with compliance management.
 */
@injectable()
export class SupplierCentralService {
  private readonly bundles: TenantSandbox<SupplierCentralBundle>;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.TelemetryService) private telemetryService: TelemetryService,
    @optional() @inject(TYPES.DocumentParsingAgent) private documentParsingAgent?: DocumentParsingAgent,
    @optional() @inject(TYPES.VendorOnboardingAgent) private vendorOnboardingAgent?: VendorOnboardingAgent,
  ) {
    this.logger.info('SupplierCentralService initialized', {
      hasDocumentParsingAgent: !!documentParsingAgent,
      hasVendorOnboardingAgent: !!vendorOnboardingAgent,
    });
    // Pin the sandbox's per-tenant seed time so timestamps within each tenant's clone are
    // internally consistent. Vendor/PO IDs use fixed constants (no time component) so every
    // tenant gets an IDENTICAL cloned demo — matching the Finance/Sync seeds and the spec's
    // "clone the canonical seed" intent.
    this.bundles = new TenantSandbox<SupplierCentralBundle>(({ nowMs }) => buildSupplierCentralBundle({
      logger: this.logger,
      telemetryService: this.telemetryService,
      documentParsingAgent: this.documentParsingAgent,
      vendorOnboardingAgent: this.vendorOnboardingAgent,
    }, nowMs));
  }

  private bundleFor(tenantId: string): SupplierCentralBundle {
    return this.bundles.forTenant(tenantId);
  }

  /**
   * Create vendor profile from portal registration
   */
  createVendorProfile(tenantId: string, profileData: CreateVendorProfileInput): Promise<string> {
    return this.bundleFor(tenantId).vendorDirectory.createVendorProfile(profileData);
  }

  /**
   * Update vendor profile
   */
  updateVendorProfile(tenantId: string, vendorId: string, updates: Partial<VendorProfile>): Promise<void> {
    return this.bundleFor(tenantId).vendorDirectory.updateVendorProfile(vendorId, updates);
  }

  /**
   * Upload compliance document
   */
  uploadDocument(
    tenantId: string,
    vendorId: string,
    documentType: 'w9' | 'insurance_gl' | 'insurance_wc' | 'insurance_pl' | 'certification',
    documentData: {
      fileName: string;
      fileSize: number;
      mimeType: string;
      content?: string; // base64 or file path for demo
      expirationDate?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{
    documentId: string;
    uploadUrl?: string;
    aiExtraction?: DocumentParsingOutput;
  }> {
    return this.bundleFor(tenantId).vendorDocumentService.uploadDocument(vendorId, documentType, documentData);
  }

  /**
   * Parse a document using AI without uploading/storing
   * Useful for re-parsing or previewing document content
   */
  parseDocument(
    tenantId: string,
    documentId: string,
    documentData: {
      fileName: string;
      mimeType: string;
      content: string;
      expectedType?: 'w9' | 'coi' | 'unknown';
    },
    vendorContext?: {
      vendorId?: string;
      vendorName?: string;
      existingTin?: string;
    }
  ): Promise<{
    success: boolean;
    parsing?: DocumentParsingOutput;
    error?: string;
  }> {
    return this.bundleFor(tenantId).vendorDocumentService.parseDocument(documentId, documentData, vendorContext);
  }

  /**
   * Get vendor profile
   */
  getVendorProfile(tenantId: string, vendorId: string): Promise<VendorProfile | null> {
    return this.bundleFor(tenantId).vendorDirectory.getVendorProfile(vendorId);
  }

  /**
   * Get vendor profiles with filtering
   */
  getVendorProfiles(tenantId: string, filters: VendorProfileFilters = {}): Promise<{ vendors: VendorProfile[]; totalCount: number }> {
    return this.bundleFor(tenantId).vendorDirectory.getVendorProfiles(filters);
  }

  /**
   * Approve vendor
   */
  approveVendor(tenantId: string, vendorId: string, approvedBy: string, notes?: string): Promise<void> {
    return this.bundleFor(tenantId).vendorOnboardingService.approveVendor(vendorId, approvedBy, notes);
  }

  /**
   * Assess vendor for approval using AI-powered risk assessment
   * Calls VendorOnboardingAgent to evaluate risk, compliance, and generate recommendation
   */
  assessVendorForApproval(tenantId: string, vendorId: string): Promise<VendorAssessmentResult> {
    return this.bundleFor(tenantId).vendorOnboardingService.assessVendorForApproval(vendorId);
  }

  /**
   * Reject vendor with reason
   */
  rejectVendor(tenantId: string, vendorId: string, rejectedBy: string, reason: string): Promise<void> {
    return this.bundleFor(tenantId).vendorOnboardingService.rejectVendor(vendorId, rejectedBy, reason);
  }

  /**
   * Sync vendor to Business Central
   */
  syncVendorToBusinessCentral(tenantId: string, vendorId: string): Promise<BusinessCentralSyncResult> {
    return this.bundleFor(tenantId).vendorOnboardingService.syncVendorToBusinessCentral(vendorId);
  }

  /**
   * Get onboarding statistics
   */
  getOnboardingStats(tenantId: string): Promise<VendorOnboardingStats> {
    return this.bundleFor(tenantId).vendorOnboardingService.getOnboardingStats();
  }

  /**
   * Get vendor portal activity
   */
  getPortalActivity(tenantId: string, vendorId?: string, limit = 50, offset = 0): Promise<PortalActivityPage> {
    return this.bundleFor(tenantId).vendorDirectory.getPortalActivity(vendorId, limit, offset);
  }

  // ==========================================
  // Purchase Order Management Methods
  // ==========================================

  /**
   * Get purchase orders for a vendor
   */
  getPurchaseOrdersForVendor(tenantId: string, vendorId: string, filters?: PurchaseOrderFilters): Promise<PurchaseOrderPage> {
    return this.bundleFor(tenantId).purchaseOrderService.getPurchaseOrdersForVendor(vendorId, filters);
  }

  /**
   * Get a single purchase order
   */
  getPurchaseOrder(tenantId: string, poId: string): Promise<PurchaseOrder | null> {
    return this.bundleFor(tenantId).purchaseOrderService.getPurchaseOrder(poId);
  }

  /**
   * Create a purchase order from API/NLActionGate input.
   * Uses demo-safe defaults when line details are omitted.
   */
  createPurchaseOrder(tenantId: string, input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    return this.bundleFor(tenantId).purchaseOrderService.createPurchaseOrder(input);
  }

  /**
   * Acknowledge a purchase order
   */
  acknowledgePurchaseOrder(
    tenantId: string,
    poId: string,
    acknowledgement: PurchaseOrderAcknowledgementInput
  ): Promise<PurchaseOrder> {
    return this.bundleFor(tenantId).purchaseOrderService.acknowledgePurchaseOrder(poId, acknowledgement);
  }

  /**
   * Create an Advanced Shipping Notice
   */
  createAdvancedShippingNotice(
    tenantId: string,
    asnData: CreateAdvancedShippingNoticeInput
  ): Promise<AdvancedShippingNotice> {
    return this.bundleFor(tenantId).purchaseOrderService.createAdvancedShippingNotice(asnData);
  }

  /**
   * Get ASNs for a vendor
   */
  getAdvancedShippingNoticesForVendor(tenantId: string, vendorId: string): Promise<AdvancedShippingNotice[]> {
    return this.bundleFor(tenantId).purchaseOrderService.getAdvancedShippingNoticesForVendor(vendorId);
  }

  /**
   * Get ASNs for a purchase order
   */
  getAdvancedShippingNoticesForPO(tenantId: string, poId: string): Promise<AdvancedShippingNotice[]> {
    return this.bundleFor(tenantId).purchaseOrderService.getAdvancedShippingNoticesForPO(poId);
  }

  /**
   * Update ASN status (e.g., mark as delivered)
   */
  updateASNStatus(
    tenantId: string,
    asnId: string,
    status: AdvancedShippingNotice['status'],
    actualDeliveryDate?: number
  ): Promise<AdvancedShippingNotice> {
    return this.bundleFor(tenantId).purchaseOrderService.updateASNStatus(asnId, status, actualDeliveryDate);
  }

  // ==================== NETSUITE SYNC METHODS ====================

  /**
   * Sync vendor to NetSuite
   */
  syncVendorToNetSuite(tenantId: string, vendorId: string): Promise<NetSuiteSyncResult> {
    return this.bundleFor(tenantId).netSuiteSyncService.syncVendorToNetSuite(vendorId);
  }

  /**
   * Batch sync vendors to NetSuite with governance pacing
   */
  batchSyncVendorsToNetSuite(tenantId: string, vendorIds?: string[]): Promise<BatchNetSuiteSyncResult> {
    return this.bundleFor(tenantId).netSuiteSyncService.batchSyncVendorsToNetSuite(vendorIds);
  }

  /**
   * Get NetSuite sync status for all vendors
   */
  getNetSuiteSyncStatus(tenantId: string): Promise<NetSuiteSyncStatus> {
    return this.bundleFor(tenantId).netSuiteSyncService.getNetSuiteSyncStatus();
  }

  /**
   * Sync purchase order to NetSuite
   */
  syncPurchaseOrderToNetSuite(tenantId: string, purchaseOrderId: string): Promise<NetSuiteSyncResult> {
    return this.bundleFor(tenantId).netSuiteSyncService.syncPurchaseOrderToNetSuite(purchaseOrderId);
  }

  /**
   * Update governance configuration
   */
  updateGovernanceConfig(tenantId: string, updates: Partial<GovernanceConfig>): void {
    this.bundleFor(tenantId).netSuiteSyncService.updateGovernanceConfig(updates);
  }

  /**
   * Get governance metrics
   */
  getGovernanceMetrics(tenantId: string): GovernanceMetrics {
    return this.bundleFor(tenantId).netSuiteSyncService.getGovernanceMetrics();
  }
}
