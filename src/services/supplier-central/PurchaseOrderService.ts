import type {
  VendorProfile,
  POLineItem,
  PurchaseOrder,
  AdvancedShippingNotice,
  PurchaseOrderFilters,
  PurchaseOrderPage,
  CreatePurchaseOrderInput,
  PurchaseOrderAcknowledgementInput,
  CreateAdvancedShippingNoticeInput,
} from '../../types/supplierCentral';
import type { SupplierCentralRuntime } from './SupplierCentralRuntime';
import type { VendorDirectory } from './VendorDirectory';

export class PurchaseOrderService {
  private purchaseOrders = new Map<string, PurchaseOrder>();
  private advancedShippingNotices = new Map<string, AdvancedShippingNotice>();

  constructor(
    private runtime: SupplierCentralRuntime,
    private vendorDirectory: VendorDirectory,
  ) {}

  /**
   * Get purchase orders for a vendor
   */
  async getPurchaseOrdersForVendor(vendorId: string, filters?: PurchaseOrderFilters): Promise<PurchaseOrderPage> {
    let orders = Array.from(this.purchaseOrders.values())
      .filter(po => po.vendorId === vendorId);

    if (filters?.status) {
      orders = orders.filter(po => po.status === filters.status);
    }

    if (filters?.fromDate) {
      orders = orders.filter(po => po.orderDate >= filters.fromDate!);
    }

    if (filters?.toDate) {
      orders = orders.filter(po => po.orderDate <= filters.toDate!);
    }

    const totalCount = orders.length;

    // Sort by order date (newest first)
    orders.sort((a, b) => b.orderDate - a.orderDate);

    // Apply pagination
    const offset = filters?.offset || 0;
    const limit = filters?.limit || 50;
    orders = orders.slice(offset, offset + limit);

    this.runtime.logger.debug('Retrieved POs for vendor', { vendorId, count: orders.length });
    return { orders, totalCount };
  }

  /**
   * Get a single purchase order
   */
  async getPurchaseOrder(poId: string): Promise<PurchaseOrder | null> {
    return this.purchaseOrders.get(poId) || null;
  }

  /**
   * Create a purchase order from API/NLActionGate input.
   * Uses demo-safe defaults when line details are omitted.
   */
  async createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    const now = this.runtime.now();
    const asFiniteNumber = (value: unknown): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('Purchase order numeric fields must be finite numbers');
      }
      return value;
    };

    let vendorId = input.vendorId;
    if (!vendorId && input.vendorName) {
      const search = this.normalizeName(input.vendorName);
      const vendors = this.vendorDirectory.getAllVendors();
      const exact = vendors.find(v => {
        const companyName = this.normalizeName(v.basicInfo.companyName);
        const legalName = this.normalizeName(v.basicInfo.legalName || '');
        return companyName === search || (legalName.length > 0 && legalName === search);
      });
      const fuzzyMatches = vendors.filter(v => {
          const companyName = this.normalizeName(v.basicInfo.companyName);
          const legalName = this.normalizeName(v.basicInfo.legalName || '');

          return (
            (companyName.length >= 5 && this.containsWholePhrase(search, companyName)) ||
            (legalName.length > 0 && legalName.length >= 5 && this.containsWholePhrase(search, legalName))
          );
      });

      if (!exact && fuzzyMatches.length > 1) {
        throw new Error(`Ambiguous vendor name: ${input.vendorName}. Please provide vendorId.`);
      }

      vendorId = exact?.id || fuzzyMatches[0]?.id;
    }

    if (!vendorId) {
      throw new Error('Vendor ID or resolvable vendor name is required');
    }

    const vendor = this.vendorDirectory.getVendorById(vendorId);
    if (!vendor) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    if (input.requestedDeliveryDate !== undefined &&
      (typeof input.requestedDeliveryDate !== 'number' || !Number.isFinite(input.requestedDeliveryDate))) {
      throw new Error('requestedDeliveryDate must be a finite timestamp number');
    }
    if (input.lines !== undefined && !Array.isArray(input.lines)) {
      throw new Error('lines must be an array when provided');
    }

    const requestedDeliveryDate = input.requestedDeliveryDate ?? (now + 7 * 24 * 60 * 60 * 1000);
    const rawLines = input.lines && input.lines.length > 0
      ? input.lines
      : [{
          itemId: 'ITEM-001',
          itemName: 'General Goods',
          description: 'Auto-generated PO line',
          quantity: 1,
          unitPrice: 100,
          expectedShipDate: now + 3 * 24 * 60 * 60 * 1000,
        }];

    const lines: POLineItem[] = rawLines.map((line, idx) => {
      const itemName = typeof line.itemName === 'string' ? line.itemName.trim() : '';
      const quantity = asFiniteNumber(line.quantity);
      const unitPrice = asFiniteNumber(line.unitPrice);

      if (!itemName) {
        throw new Error(`Invalid line ${idx + 1}: itemName is required`);
      }
      if (quantity <= 0) {
        throw new Error(`Invalid line ${idx + 1}: quantity must be greater than 0`);
      }
      if (unitPrice < 0) {
        throw new Error(`Invalid line ${idx + 1}: unitPrice must be >= 0`);
      }

      const expectedShipDate = line.expectedShipDate === undefined
        ? requestedDeliveryDate
        : asFiniteNumber(line.expectedShipDate);

      return {
        id: `line_${now}_${idx + 1}`,
        lineNumber: idx + 1,
        itemId: (typeof line.itemId === 'string' && line.itemId.trim().length > 0)
          ? line.itemId
          : `ITEM-${String(idx + 1).padStart(3, '0')}`,
        itemName,
        description: (typeof line.description === 'string' && line.description.trim().length > 0)
          ? line.description
          : itemName,
        quantity,
        unitPrice,
        expectedShipDate,
        status: 'pending',
      };
    });

    const subtotal = lines.reduce((sum, line) => sum + (line.quantity * line.unitPrice), 0);
    const tax = Number((subtotal * 0.08).toFixed(2));
    const shipping = Number((subtotal > 0 ? 25 : 0).toFixed(2));
    const total = Number((subtotal + tax + shipping).toFixed(2));

    const id = this.runtime.createId('po');
    const po: PurchaseOrder = {
      id,
      poNumber: `PO-${String(now).slice(-8)}`,
      vendorId: vendor.id,
      buyerCompany: input.buyerCompany || 'SuiteCentral Buyer',
      buyerContact: input.buyerContact || 'procurement@suitecentral.local',
      orderDate: now,
      requestedDeliveryDate,
      status: 'pending_acknowledgement',
      lines,
      subtotal,
      tax,
      shipping,
      total,
      currency: input.currency || vendor.banking.currency || 'USD',
      shippingAddress: {
        street1: input.shippingAddress?.street1 || vendor.addresses.shipping?.street1 || vendor.addresses.headquarters.street1,
        street2: input.shippingAddress?.street2 || vendor.addresses.shipping?.street2 || vendor.addresses.headquarters.street2,
        city: input.shippingAddress?.city || vendor.addresses.shipping?.city || vendor.addresses.headquarters.city,
        state: input.shippingAddress?.state || vendor.addresses.shipping?.state || vendor.addresses.headquarters.state,
        postalCode: input.shippingAddress?.postalCode || vendor.addresses.shipping?.postalCode || vendor.addresses.headquarters.postalCode,
        country: input.shippingAddress?.country || vendor.addresses.shipping?.country || vendor.addresses.headquarters.country,
      },
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    };

    this.purchaseOrders.set(id, po);

    await this.vendorDirectory.recordActivity({
      vendorId: vendor.id,
      type: 'status_change',
      description: `Purchase order ${po.poNumber} created`,
      metadata: {
        poId: po.id,
        poNumber: po.poNumber,
        total: po.total,
        createdBy: input.createdBy || 'system',
      },
    });

    this.runtime.logger.info('Purchase order created', {
      poId: po.id,
      poNumber: po.poNumber,
      vendorId: vendor.id,
      total: po.total,
      lineCount: po.lines.length,
      createdBy: input.createdBy || 'system',
    });

    return po;
  }

  /**
   * Acknowledge a purchase order
   */
  async acknowledgePurchaseOrder(
    poId: string,
    acknowledgement: PurchaseOrderAcknowledgementInput
  ): Promise<PurchaseOrder> {
    const po = this.purchaseOrders.get(poId);
    if (!po) {
      throw new Error(`Purchase order not found: ${poId}`);
    }

    if (po.status !== 'pending_acknowledgement') {
      throw new Error(`Purchase order ${poId} has already been acknowledged`);
    }

    const now = this.runtime.now();

    // Update line confirmations
    if (acknowledgement.lineConfirmations) {
      for (const confirmation of acknowledgement.lineConfirmations) {
        const line = po.lines.find(l => l.id === confirmation.lineId);
        if (line) {
          line.confirmedQuantity = confirmation.confirmedQuantity;
          if (confirmation.confirmedUnitPrice !== undefined) {
            line.confirmedUnitPrice = confirmation.confirmedUnitPrice;
          }
          if (confirmation.confirmedShipDate) {
            line.confirmedShipDate = confirmation.confirmedShipDate;
          }
          line.status = 'confirmed';
        }
      }
    } else {
      // If no line confirmations provided, confirm all lines as-is
      for (const line of po.lines) {
        line.confirmedQuantity = line.quantity;
        line.confirmedUnitPrice = line.unitPrice;
        line.confirmedShipDate = line.expectedShipDate;
        line.status = 'confirmed';
      }
    }

    // Update PO status and acknowledgement
    po.status = 'acknowledged';
    po.acknowledgement = {
      acknowledgedAt: now,
      acknowledgedBy: acknowledgement.acknowledgedBy,
      notes: acknowledgement.notes,
    };
    po.updatedAt = now;

    this.purchaseOrders.set(poId, po);

    // Record activity
    await this.vendorDirectory.recordActivity({
      vendorId: po.vendorId,
      type: 'status_change',
      description: `Purchase order ${po.poNumber} acknowledged`,
      metadata: { poId, poNumber: po.poNumber },
    });

    this.runtime.logger.info('Purchase order acknowledged', {
      poId,
      poNumber: po.poNumber,
      acknowledgedBy: acknowledgement.acknowledgedBy,
    });

    return po;
  }

  /**
   * Create an Advanced Shipping Notice
   */
  async createAdvancedShippingNotice(
    asnData: CreateAdvancedShippingNoticeInput
  ): Promise<AdvancedShippingNotice> {
    const po = this.purchaseOrders.get(asnData.purchaseOrderId);
    if (!po) {
      throw new Error(`Purchase order not found: ${asnData.purchaseOrderId}`);
    }

    if (po.status !== 'acknowledged' && po.status !== 'in_progress') {
      throw new Error(`Cannot create ASN for PO with status: ${po.status}`);
    }

    const now = this.runtime.now();
    const id = this.runtime.createId('asn');
    const asnNumber = `ASN-${String(now).slice(-8)}`;

    const asn: AdvancedShippingNotice = {
      ...asnData,
      id,
      asnNumber,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };

    this.advancedShippingNotices.set(id, asn);

    // Update PO status and line statuses
    po.status = 'in_progress';
    for (const asnLine of asnData.lines) {
      const poLine = po.lines.find(l => l.id === asnLine.poLineId);
      if (poLine) {
        poLine.status = 'shipped';
      }
    }
    po.updatedAt = now;
    this.purchaseOrders.set(po.id, po);

    // Record activity
    await this.vendorDirectory.recordActivity({
      vendorId: asnData.vendorId,
      type: 'status_change',
      description: `Advanced Shipping Notice ${asnNumber} created for PO ${po.poNumber}`,
      metadata: { asnId: id, asnNumber, poId: po.id, poNumber: po.poNumber },
    });

    this.runtime.logger.info('ASN created', {
      asnId: id,
      asnNumber,
      poId: po.id,
      trackingNumber: asnData.trackingNumber,
    });

    return asn;
  }

  /**
   * Get ASNs for a vendor
   */
  async getAdvancedShippingNoticesForVendor(vendorId: string): Promise<AdvancedShippingNotice[]> {
    return Array.from(this.advancedShippingNotices.values())
      .filter(asn => asn.vendorId === vendorId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get ASNs for a purchase order
   */
  async getAdvancedShippingNoticesForPO(poId: string): Promise<AdvancedShippingNotice[]> {
    return Array.from(this.advancedShippingNotices.values())
      .filter(asn => asn.purchaseOrderId === poId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Update ASN status (e.g., mark as delivered)
   */
  async updateASNStatus(
    asnId: string,
    status: AdvancedShippingNotice['status'],
    actualDeliveryDate?: number
  ): Promise<AdvancedShippingNotice> {
    const asn = this.advancedShippingNotices.get(asnId);
    if (!asn) {
      throw new Error(`ASN not found: ${asnId}`);
    }

    asn.status = status;
    asn.updatedAt = this.runtime.now();

    if (status === 'delivered' && actualDeliveryDate) {
      asn.actualDeliveryDate = actualDeliveryDate;

      // Update PO if all lines are delivered
      const po = this.purchaseOrders.get(asn.purchaseOrderId);
      if (po) {
        const allLinesDelivered = po.lines.every(l => l.status === 'shipped' || l.status === 'received');
        if (allLinesDelivered) {
          po.status = 'received';
          for (const line of po.lines) {
            if (line.status === 'shipped') {
              line.status = 'received';
            }
          }
          po.updatedAt = this.runtime.now();
          this.purchaseOrders.set(po.id, po);
        }
      }
    }

    this.advancedShippingNotices.set(asnId, asn);

    this.runtime.logger.info('ASN status updated', { asnId, status });
    return asn;
  }

  /**
   * Initialize demo PO data
   */
  seedDemoPurchaseOrders(vendors: VendorProfile[]): void {
    if (vendors.length === 0) return;
    const vendorIds = vendors.map(v => v.id);
    const vendorById = new Map(vendors.map(v => [v.id, v] as const));

    const now = this.runtime.now();
    const samplePOs = [
      { vendorIdx: 0, status: 'pending_acknowledgement' as const, daysAgo: 2 },
      { vendorIdx: 0, status: 'acknowledged' as const, daysAgo: 5 },
      { vendorIdx: 1, status: 'pending_acknowledgement' as const, daysAgo: 1 },
      { vendorIdx: 2, status: 'in_progress' as const, daysAgo: 10 },
      { vendorIdx: 0, status: 'received' as const, daysAgo: 30 },
    ];

    samplePOs.forEach((sample, index) => {
      const vendorId = vendorIds[sample.vendorIdx % vendorIds.length];
      const vendor = vendorById.get(vendorId)!;
      const orderDate = now - (sample.daysAgo * 24 * 60 * 60 * 1000);
      const id = `po_${now}_${index}`;

      const lines: POLineItem[] = [
        {
          id: `line_${id}_1`,
          lineNumber: 1,
          itemId: 'ITEM-001',
          itemName: 'Widget A',
          description: 'Standard widget with premium finish',
          quantity: 100,
          unitPrice: 25.00,
          expectedShipDate: orderDate + (7 * 24 * 60 * 60 * 1000),
          status: sample.status === 'pending_acknowledgement' ? 'pending' : 'confirmed',
        },
        {
          id: `line_${id}_2`,
          lineNumber: 2,
          itemId: 'ITEM-002',
          itemName: 'Widget B',
          description: 'Deluxe widget with custom branding',
          quantity: 50,
          unitPrice: 45.00,
          expectedShipDate: orderDate + (10 * 24 * 60 * 60 * 1000),
          status: sample.status === 'pending_acknowledgement' ? 'pending' : 'confirmed',
        },
      ];

      const subtotal = lines.reduce((sum, l) => sum + (l.quantity * l.unitPrice), 0);

      const po: PurchaseOrder = {
        id,
        poNumber: `PO-${String(10000 + index).padStart(6, '0')}`,
        vendorId,
        buyerCompany: 'Preston Industries Inc.',
        buyerContact: 'Jane Smith (jane.smith@prestonindustries.com)',
        orderDate,
        requestedDeliveryDate: orderDate + (14 * 24 * 60 * 60 * 1000),
        status: sample.status,
        lines,
        subtotal,
        tax: subtotal * 0.08,
        shipping: 25.00,
        total: subtotal * 1.08 + 25,
        currency: 'USD',
        shippingAddress: {
          street1: '456 Buyer Way',
          city: 'Chicago',
          state: 'IL',
          postalCode: '60601',
          country: 'US',
        },
        notes: 'Please confirm delivery date upon acknowledgement',
        createdAt: orderDate,
        updatedAt: orderDate,
      };

      if (sample.status !== 'pending_acknowledgement') {
        po.acknowledgement = {
          acknowledgedAt: orderDate + (24 * 60 * 60 * 1000),
          acknowledgedBy: vendor.contacts.primary.email,
          notes: 'Order confirmed, will ship on schedule.',
        };
        po.confirmedDeliveryDate = po.requestedDeliveryDate;
        for (const line of po.lines) {
          line.confirmedQuantity = line.quantity;
          line.confirmedUnitPrice = line.unitPrice;
          line.confirmedShipDate = line.expectedShipDate;
        }
      }

      this.purchaseOrders.set(id, po);
    });

    this.runtime.logger.info('Demo PO data initialized', { count: this.purchaseOrders.size });
  }

  // Collaborator-facing helpers used by Task 7 (NetSuite sync)
  getPurchaseOrderById(poId: string): PurchaseOrder | undefined {
    return this.purchaseOrders.get(poId);
  }

  getAllPurchaseOrders(): PurchaseOrder[] {
    return Array.from(this.purchaseOrders.values());
  }

  // Private fuzzy-name matching helpers (used by createPurchaseOrder)
  private normalizeName(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private containsWholePhrase(haystack: string, phrase: string): boolean {
    if (!phrase) {
      return false;
    }

    const pattern = new RegExp(`(?:^|[^a-z0-9])${this.escapeRegex(phrase)}(?:$|[^a-z0-9])`, 'i');
    return pattern.test(haystack);
  }
}
