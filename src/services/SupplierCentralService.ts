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
import { VendorDirectory } from './supplier-central/VendorDirectory';
import { VendorDocumentService } from './supplier-central/VendorDocumentService';
import { VendorOnboardingService } from './supplier-central/VendorOnboardingService';
import { VendorOnboardingAgentAdapter } from './supplier-central/VendorOnboardingAgentAdapter';
import { PurchaseOrderService } from './supplier-central/PurchaseOrderService';
import { GovernanceThrottle } from './supplier-central/GovernanceThrottle';
import { NetSuiteSyncService } from './supplier-central/NetSuiteSyncService';
import { createSupplierCentralRuntime, type SupplierCentralRuntime } from './supplier-central/SupplierCentralRuntime';

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
  private runtime: SupplierCentralRuntime;
  private vendorDirectory: VendorDirectory;
  private vendorDocumentService: VendorDocumentService;
  private vendorOnboardingService: VendorOnboardingService;
  private purchaseOrderService: PurchaseOrderService;
  private governance: GovernanceThrottle;
  private netSuiteSyncService: NetSuiteSyncService;

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
    this.runtime = createSupplierCentralRuntime({
      logger: this.logger,
      telemetryService: this.telemetryService,
      documentParsingAgent: this.documentParsingAgent,
      vendorOnboardingAgent: this.vendorOnboardingAgent,
    });
    this.vendorDirectory = new VendorDirectory(this.runtime);
    this.vendorDocumentService = new VendorDocumentService(this.runtime, this.vendorDirectory);
    this.vendorOnboardingService = new VendorOnboardingService(
      this.runtime,
      this.vendorDirectory,
      new VendorOnboardingAgentAdapter(this.runtime),
    );
    this.purchaseOrderService = new PurchaseOrderService(this.runtime, this.vendorDirectory);
    this.governance = new GovernanceThrottle(this.runtime);
    this.netSuiteSyncService = new NetSuiteSyncService(
      this.runtime,
      this.vendorDirectory,
      this.purchaseOrderService,
      this.governance,
    );
    this.vendorDirectory.seedDemoData();
    this.purchaseOrderService.seedDemoPurchaseOrders(this.vendorDirectory.getAllVendors());
  }

  /**
   * Create vendor profile from portal registration
   */
  createVendorProfile(profileData: CreateVendorProfileInput): Promise<string> {
    return this.vendorDirectory.createVendorProfile(profileData);
  }

  /**
   * Update vendor profile
   */
  updateVendorProfile(vendorId: string, updates: Partial<VendorProfile>): Promise<void> {
    return this.vendorDirectory.updateVendorProfile(vendorId, updates);
  }

  /**
   * Upload compliance document
   */
  uploadDocument(
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
    return this.vendorDocumentService.uploadDocument(vendorId, documentType, documentData);
  }

  /**
   * Parse a document using AI without uploading/storing
   * Useful for re-parsing or previewing document content
   */
  parseDocument(
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
    return this.vendorDocumentService.parseDocument(documentId, documentData, vendorContext);
  }

  /**
   * Get vendor profile
   */
  getVendorProfile(vendorId: string): Promise<VendorProfile | null> {
    return this.vendorDirectory.getVendorProfile(vendorId);
  }

  /**
   * Get vendor profiles with filtering
   */
  getVendorProfiles(filters: VendorProfileFilters = {}): Promise<{ vendors: VendorProfile[]; totalCount: number }> {
    return this.vendorDirectory.getVendorProfiles(filters);
  }

  /**
   * Approve vendor
   */
  approveVendor(vendorId: string, approvedBy: string, notes?: string): Promise<void> {
    return this.vendorOnboardingService.approveVendor(vendorId, approvedBy, notes);
  }

  /**
   * Assess vendor for approval using AI-powered risk assessment
   * Calls VendorOnboardingAgent to evaluate risk, compliance, and generate recommendation
   */
  assessVendorForApproval(vendorId: string): Promise<VendorAssessmentResult> {
    return this.vendorOnboardingService.assessVendorForApproval(vendorId);
  }

  /**
   * Reject vendor with reason
   */
  rejectVendor(vendorId: string, rejectedBy: string, reason: string): Promise<void> {
    return this.vendorOnboardingService.rejectVendor(vendorId, rejectedBy, reason);
  }

  /**
   * Sync vendor to Business Central
   */
  syncVendorToBusinessCentral(vendorId: string): Promise<BusinessCentralSyncResult> {
    return this.vendorOnboardingService.syncVendorToBusinessCentral(vendorId);
  }

  /**
   * Get onboarding statistics
   */
  getOnboardingStats(): Promise<VendorOnboardingStats> {
    return this.vendorOnboardingService.getOnboardingStats();
  }

  /**
   * Get vendor portal activity
   */
  getPortalActivity(vendorId?: string, limit = 50, offset = 0): Promise<PortalActivityPage> {
    return this.vendorDirectory.getPortalActivity(vendorId, limit, offset);
  }

  // ==========================================
  // Purchase Order Management Methods
  // ==========================================

  /**
   * Get purchase orders for a vendor
   */
  getPurchaseOrdersForVendor(vendorId: string, filters?: PurchaseOrderFilters): Promise<PurchaseOrderPage> {
    return this.purchaseOrderService.getPurchaseOrdersForVendor(vendorId, filters);
  }

  /**
   * Get a single purchase order
   */
  getPurchaseOrder(poId: string): Promise<PurchaseOrder | null> {
    return this.purchaseOrderService.getPurchaseOrder(poId);
  }

  /**
   * Create a purchase order from API/NLActionGate input.
   * Uses demo-safe defaults when line details are omitted.
   */
  createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    return this.purchaseOrderService.createPurchaseOrder(input);
  }

  /**
   * Acknowledge a purchase order
   */
  acknowledgePurchaseOrder(
    poId: string,
    acknowledgement: PurchaseOrderAcknowledgementInput
  ): Promise<PurchaseOrder> {
    return this.purchaseOrderService.acknowledgePurchaseOrder(poId, acknowledgement);
  }

  /**
   * Create an Advanced Shipping Notice
   */
  createAdvancedShippingNotice(
    asnData: CreateAdvancedShippingNoticeInput
  ): Promise<AdvancedShippingNotice> {
    return this.purchaseOrderService.createAdvancedShippingNotice(asnData);
  }

  /**
   * Get ASNs for a vendor
   */
  getAdvancedShippingNoticesForVendor(vendorId: string): Promise<AdvancedShippingNotice[]> {
    return this.purchaseOrderService.getAdvancedShippingNoticesForVendor(vendorId);
  }

  /**
   * Get ASNs for a purchase order
   */
  getAdvancedShippingNoticesForPO(poId: string): Promise<AdvancedShippingNotice[]> {
    return this.purchaseOrderService.getAdvancedShippingNoticesForPO(poId);
  }

  /**
   * Update ASN status (e.g., mark as delivered)
   */
  updateASNStatus(
    asnId: string,
    status: AdvancedShippingNotice['status'],
    actualDeliveryDate?: number
  ): Promise<AdvancedShippingNotice> {
    return this.purchaseOrderService.updateASNStatus(asnId, status, actualDeliveryDate);
  }

  // ==================== NETSUITE SYNC METHODS ====================

  /**
   * Sync vendor to NetSuite
   */
  syncVendorToNetSuite(vendorId: string): Promise<NetSuiteSyncResult> {
    return this.netSuiteSyncService.syncVendorToNetSuite(vendorId);
  }

  /**
   * Batch sync vendors to NetSuite with governance pacing
   */
  batchSyncVendorsToNetSuite(vendorIds?: string[]): Promise<BatchNetSuiteSyncResult> {
    return this.netSuiteSyncService.batchSyncVendorsToNetSuite(vendorIds);
  }

  /**
   * Get NetSuite sync status for all vendors
   */
  getNetSuiteSyncStatus(): Promise<NetSuiteSyncStatus> {
    return this.netSuiteSyncService.getNetSuiteSyncStatus();
  }

  /**
   * Sync purchase order to NetSuite
   */
  syncPurchaseOrderToNetSuite(purchaseOrderId: string): Promise<NetSuiteSyncResult> {
    return this.netSuiteSyncService.syncPurchaseOrderToNetSuite(purchaseOrderId);
  }

  /**
   * Update governance configuration
   */
  updateGovernanceConfig(updates: Partial<GovernanceConfig>): void {
    this.netSuiteSyncService.updateGovernanceConfig(updates);
  }

  /**
   * Get governance metrics
   */
  getGovernanceMetrics(): GovernanceMetrics {
    return this.netSuiteSyncService.getGovernanceMetrics();
  }
}
