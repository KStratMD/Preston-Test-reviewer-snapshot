import type {
  VendorProfile,
  NetSuiteSyncResult,
  BatchNetSuiteSyncResult,
  NetSuiteSyncStatus,
  GovernanceMetrics,
  GovernanceConfig,
} from '../../types/supplierCentral';
import type { SupplierCentralRuntime } from './SupplierCentralRuntime';
import type { VendorDirectory } from './VendorDirectory';
import type { PurchaseOrderService } from './PurchaseOrderService';
import type { GovernanceThrottle } from './GovernanceThrottle';

/**
 * NetSuite sync + governance orchestration for SupplierCentral.
 * Delegates pacing state to GovernanceThrottle and vendor/PO reads/writes to
 * VendorDirectory / PurchaseOrderService.
 */
export class NetSuiteSyncService {
  constructor(
    private runtime: SupplierCentralRuntime,
    private vendorDirectory: VendorDirectory,
    private purchaseOrderService: PurchaseOrderService,
    private governance: GovernanceThrottle,
  ) {}

  /**
   * Sync vendor to NetSuite
   */
  async syncVendorToNetSuite(vendorId: string): Promise<NetSuiteSyncResult> {
    const vendor = this.vendorDirectory.getVendorById(vendorId);
    if (!vendor) {
      return { success: false, error: 'Vendor not found' };
    }

    if (vendor.onboardingStatus.stage !== 'approved' && vendor.onboardingStatus.stage !== 'active') {
      return { success: false, error: 'Vendor must be approved before syncing to NetSuite' };
    }

    await this.governance.acquire();

    try {
      const syncAttemptTime = this.runtime.now();
      this.vendorDirectory.updateVendor(vendorId, draft => {
        draft.netSuite.syncAttempts++;
        draft.netSuite.lastSyncAttempt = syncAttemptTime;
        draft.netSuite.syncStatus = 'pending';
        draft.metadata.updatedAt = syncAttemptTime;
      });

      // Simulate NetSuite API call (90% success rate in demo)
      const success = this.runtime.random() > 0.1;

      if (!success) {
        const errorMessages = [
          'INVALID_TAX_ID: Tax ID format not recognized',
          'DUPLICATE_VENDOR: Vendor with this name already exists',
          'SUBSIDIARY_REQUIRED: Subsidiary must be specified',
          'API_RATE_LIMIT: Too many requests, please retry',
        ];
        const error = errorMessages[Math.floor(this.runtime.random() * errorMessages.length)];
        const failureTime = this.runtime.now();
        this.vendorDirectory.updateVendor(vendorId, draft => {
          draft.netSuite.syncStatus = 'failed';
          draft.netSuite.syncErrors = draft.netSuite.syncErrors || [];
          draft.netSuite.syncErrors.push(`${new Date(failureTime).toISOString()}: ${error}`);
          draft.metadata.updatedAt = failureTime;
        });

        this.runtime.logger.warn('NetSuite vendor sync failed', { vendorId, error });
        return { success: false, error };
      }

      // Generate NetSuite IDs
      const netSuiteInternalId = `NS_${Math.floor(this.runtime.random() * 900000 + 100000)}`;
      const successTime = this.runtime.now();
      const netSuiteExternalId = `VND_${vendor.basicInfo.companyName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20)}_${successTime}`;

      const updatedVendor = this.vendorDirectory.updateVendor(vendorId, draft => {
        draft.netSuite.vendorId = netSuiteInternalId;
        draft.netSuite.internalId = netSuiteInternalId;
        draft.netSuite.externalId = netSuiteExternalId;
        draft.netSuite.syncStatus = 'synced';
        draft.netSuite.lastSyncSuccess = successTime;
        draft.netSuite.syncErrors = [];
        draft.netSuite.subsidiary = 'Parent Company';
        draft.netSuite.terms = 'Net 30';
        draft.netSuite.currency = draft.banking.currency || 'USD';
        draft.onboardingStatus.notes.push({
          id: `note_${successTime}`,
          timestamp: successTime,
          author: 'system',
          content: `Successfully synced to NetSuite (ID: ${netSuiteInternalId})`,
          type: 'success',
        });
        draft.metadata.updatedAt = successTime;
      });
      if (!updatedVendor) {
        return { success: false, error: 'Vendor not found' };
      }

      this.runtime.logger.info('Vendor synced to NetSuite', {
        vendorId,
        netSuiteInternalId,
        netSuiteExternalId,
      });

      return { success: true, netSuiteId: netSuiteInternalId };

    } finally {
      this.governance.release();
    }
  }

  /**
   * Batch sync vendors to NetSuite with governance pacing
   */
  async batchSyncVendorsToNetSuite(vendorIds?: string[]): Promise<BatchNetSuiteSyncResult> {
    // Get vendors to sync
    const toSync = vendorIds
      ? vendorIds.map(id => this.vendorDirectory.getVendorById(id)).filter((v): v is VendorProfile => v !== undefined)
      : this.vendorDirectory.getAllVendors().filter(
          v => v.netSuite.syncStatus === 'pending' || v.netSuite.syncStatus === 'failed'
        );

    const results: { vendorId: string; success: boolean; netSuiteId?: string; error?: string }[] = [];
    let successful = 0;
    let failed = 0;
    let processedCount = 0;

    // Process in batches with governance pacing
    for (let i = 0; i < toSync.length; i += this.governance.getConfig().batchSize) {
      const batch = toSync.slice(i, i + this.governance.getConfig().batchSize);

      for (const vendor of batch) {
        const result = await this.syncVendorToNetSuite(vendor.id);
        results.push({
          vendorId: vendor.id,
          ...result,
        });

        if (result.success) {
          successful++;
        } else {
          failed++;
        }

        processedCount++;
        // Cooldown between vendors (not after the last one overall)
        if (processedCount < toSync.length) {
          await this.runtime.wait(this.governance.getConfig().cooldownMs);
        }
      }
    }

    this.runtime.logger.info('Batch NetSuite sync completed', {
      total: toSync.length,
      successful,
      failed,
    });

    return {
      total: toSync.length,
      successful,
      failed,
      results,
    };
  }

  /**
   * Get NetSuite sync status for all vendors
   */
  async getNetSuiteSyncStatus(): Promise<NetSuiteSyncStatus> {
    const vendors = this.vendorDirectory.getAllVendors();
    const now = this.runtime.now();

    const summary = {
      total: vendors.length,
      synced: vendors.filter(v => v.netSuite.syncStatus === 'synced').length,
      pending: vendors.filter(v => v.netSuite.syncStatus === 'pending').length,
      failed: vendors.filter(v => v.netSuite.syncStatus === 'failed').length,
      ignored: vendors.filter(v => v.netSuite.syncStatus === 'ignored').length,
    };

    const recentSyncs = vendors
      .filter(v => v.netSuite.lastSyncAttempt && v.netSuite.lastSyncAttempt > now - (24 * 60 * 60 * 1000))
      .sort((a, b) => (b.netSuite.lastSyncAttempt || 0) - (a.netSuite.lastSyncAttempt || 0))
      .slice(0, 10)
      .map(v => ({
        vendorId: v.id,
        companyName: v.basicInfo.companyName,
        status: v.netSuite.syncStatus,
        lastSyncAttempt: v.netSuite.lastSyncAttempt,
        netSuiteId: v.netSuite.vendorId,
      }));

    const failedSyncs = vendors
      .filter(v => v.netSuite.syncStatus === 'failed')
      .map(v => ({
        vendorId: v.id,
        companyName: v.basicInfo.companyName,
        attempts: v.netSuite.syncAttempts,
        lastError: v.netSuite.syncErrors?.[v.netSuite.syncErrors.length - 1],
      }));

    return {
      summary,
      recentSyncs,
      failedSyncs,
      governance: {
        requestsInLastMinute: this.governance.getRequestsInLastMinute(),
        activeRequests: this.governance.getActiveRequests(),
        config: this.governance.getConfig(),
      },
    };
  }

  /**
   * Sync purchase order to NetSuite
   */
  async syncPurchaseOrderToNetSuite(purchaseOrderId: string): Promise<NetSuiteSyncResult> {
    const po = this.purchaseOrderService.getPurchaseOrderById(purchaseOrderId);
    if (!po) {
      return { success: false, error: 'Purchase order not found' };
    }

    await this.governance.acquire();

    try {
      // Simulate NetSuite API call (95% success rate for POs)
      const success = this.runtime.random() > 0.05;

      if (!success) {
        const error = 'INVALID_VENDOR_REF: Vendor not found in NetSuite';
        this.runtime.logger.warn('NetSuite PO sync failed', { purchaseOrderId, error });
        return { success: false, error };
      }

      const netSuiteId = `NS_PO_${this.runtime.now()}_${this.runtime.random().toString(36).slice(2, 2 + 8)}`;

      this.runtime.logger.info('Purchase order synced to NetSuite', {
        purchaseOrderId,
        poNumber: po.poNumber,
        netSuiteId,
      });

      return { success: true, netSuiteId };

    } finally {
      this.governance.release();
    }
  }

  /**
   * Update governance configuration
   */
  updateGovernanceConfig(updates: Partial<GovernanceConfig>): void {
    this.governance.updateConfig(updates);
  }

  /**
   * Get governance metrics
   */
  getGovernanceMetrics(): GovernanceMetrics {
    return this.governance.getMetrics();
  }
}
