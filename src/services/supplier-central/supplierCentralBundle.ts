import type { Logger } from '../../utils/Logger';
import type { TelemetryService } from '../TelemetryService';
import type { DocumentParsingAgent } from '../ai/orchestrator/agents/DocumentParsingAgent';
import type { VendorOnboardingAgent } from '../ai/orchestrator/agents/VendorOnboardingAgent';

import { VendorDirectory } from './VendorDirectory';
import { VendorDocumentService } from './VendorDocumentService';
import { VendorOnboardingService } from './VendorOnboardingService';
import { VendorOnboardingAgentAdapter } from './VendorOnboardingAgentAdapter';
import { PurchaseOrderService } from './PurchaseOrderService';
import { GovernanceThrottle } from './GovernanceThrottle';
import { NetSuiteSyncService } from './NetSuiteSyncService';
import { createSupplierCentralRuntime, type SupplierCentralRuntime } from './SupplierCentralRuntime';

export interface SupplierCentralBundle {
  runtime: SupplierCentralRuntime;
  vendorDirectory: VendorDirectory;
  vendorDocumentService: VendorDocumentService;
  vendorOnboardingService: VendorOnboardingService;
  purchaseOrderService: PurchaseOrderService;
  governance: GovernanceThrottle;
  netSuiteSyncService: NetSuiteSyncService;
}

export interface SupplierCentralBundleDeps {
  logger: Logger;
  telemetryService: TelemetryService;
  documentParsingAgent?: DocumentParsingAgent;
  vendorOnboardingAgent?: VendorOnboardingAgent;
}

/** Builds one fully-wired, demo-seeded Supplier bundle for a single tenant.
 *
 * @param deps - Shared service dependencies (logger, telemetry, optional AI agents).
 * @param nowMs - Pinned seed time from TenantSandbox. Passed through to seedDemoData /
 *   seedDemoPurchaseOrders so timestamps are internally consistent per tenant. Vendor/PO
 *   IDs use fixed constants (no time component) so every tenant's clone is byte-identical.
 */
export function buildSupplierCentralBundle(deps: SupplierCentralBundleDeps, nowMs: number): SupplierCentralBundle {
  const runtime = createSupplierCentralRuntime({
    logger: deps.logger,
    telemetryService: deps.telemetryService,
    documentParsingAgent: deps.documentParsingAgent,
    vendorOnboardingAgent: deps.vendorOnboardingAgent,
  });
  const vendorDirectory = new VendorDirectory(runtime);
  const vendorDocumentService = new VendorDocumentService(runtime, vendorDirectory);
  const vendorOnboardingService = new VendorOnboardingService(
    runtime, vendorDirectory, new VendorOnboardingAgentAdapter(runtime),
  );
  const purchaseOrderService = new PurchaseOrderService(runtime, vendorDirectory);
  const governance = new GovernanceThrottle(runtime);
  const netSuiteSyncService = new NetSuiteSyncService(
    runtime, vendorDirectory, purchaseOrderService, governance,
  );
  vendorDirectory.seedDemoData(nowMs);
  purchaseOrderService.seedDemoPurchaseOrders(vendorDirectory.getAllVendors(), nowMs);
  return {
    runtime, vendorDirectory, vendorDocumentService, vendorOnboardingService,
    purchaseOrderService, governance, netSuiteSyncService,
  };
}
