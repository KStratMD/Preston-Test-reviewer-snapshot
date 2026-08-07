/**
 * SupplierCentral Service
 * 
 * Vendor portal management with onboarding, PO acknowledgment, ASN creation,
 * and AI-powered vendor risk scoring.
 * 
 * Created: January 9, 2026 (SuiteCentral Parity - Phase 2)
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';

// Vendor profile types
export interface VendorProfile {
    id: string;
    companyName: string;
    contactName: string;
    email: string;
    phone: string;
    address: {
        street: string;
        city: string;
        state: string;
        postalCode: string;
        country: string;
    };
    taxId?: string;
    documents: VendorDocument[];
    onboardingStatus: 'pending' | 'documents_submitted' | 'under_review' | 'approved' | 'rejected';
    riskScore: number; // AI-computed 0-100
    riskFactors: RiskFactor[];
    paymentTerms: string;
    preferredPaymentMethod: 'ach' | 'check' | 'wire' | 'credit_card';
    createdAt: Date;
    updatedAt: Date;
    approvedAt?: Date;
    approvedBy?: string;
}

export interface VendorDocument {
    id: string;
    type: 'w9' | 'insurance' | 'contract' | 'license' | 'other';
    fileName: string;
    uploadedAt: Date;
    status: 'pending' | 'verified' | 'rejected';
    expiresAt?: Date;
}

export interface RiskFactor {
    category: 'financial' | 'compliance' | 'delivery' | 'quality';
    severity: 'low' | 'medium' | 'high';
    description: string;
    score: number; // Impact on overall risk 0-25
}

// Purchase Order types
export interface PurchaseOrder {
    id: string;
    poNumber: string;
    vendorId: string;
    status: 'draft' | 'sent' | 'acknowledged' | 'partially_shipped' | 'shipped' | 'received' | 'closed' | 'cancelled';
    lineItems: POLineItem[];
    subtotal: number;
    tax: number;
    total: number;
    currency: string;
    requestedDeliveryDate: Date;
    promisedDeliveryDate?: Date;
    acknowledgmentDate?: Date;
    shippingAddress: {
        street: string;
        city: string;
        state: string;
        postalCode: string;
        country: string;
    };
    notes?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface POLineItem {
    lineNumber: number;
    itemId: string;
    itemName: string;
    quantity: number;
    unitPrice: number;
    unit: string;
    amount: number;
    requestedDate: Date;
    promisedDate?: Date;
    quantityShipped: number;
    quantityReceived: number;
}

// ASN types
export interface AdvancedShippingNotice {
    id: string;
    asnNumber: string;
    poId: string;
    poNumber: string;
    vendorId: string;
    status: 'pending' | 'in_transit' | 'delivered' | 'received';
    carrier: string;
    trackingNumber: string;
    shipDate: Date;
    estimatedDeliveryDate: Date;
    actualDeliveryDate?: Date;
    lineItems: ASNLineItem[];
    createdAt: Date;
    updatedAt: Date;
}

export interface ASNLineItem {
    poLineNumber: number;
    itemId: string;
    quantityShipped: number;
    lotNumber?: string;
    serialNumbers?: string[];
}

// AI suggestion types
export interface VendorSuggestion {
    vendorId: string;
    vendorName: string;
    score: number;
    reasoning: string;
    priceEstimate?: number;
    deliveryEstimate?: number; // days
    riskLevel: 'low' | 'medium' | 'high';
}

/**
 * SupplierCentralParityService - Vendor management with AI enhancements
 */
@injectable()
export class SupplierCentralParityService {
    private vendors = new Map<string, VendorProfile>();
    private purchaseOrders = new Map<string, PurchaseOrder>();
    private asns = new Map<string, AdvancedShippingNotice>();

    constructor(
        @inject(TYPES.Logger) private readonly logger: Logger,
    ) {
        this.initializeDemoData();
        this.logger.info('SupplierCentralParityService initialized');
    }

    // =========================================
    // VENDOR PROFILE MANAGEMENT
    // =========================================

    async createVendor(vendorData: Omit<VendorProfile, 'id' | 'riskScore' | 'riskFactors' | 'createdAt' | 'updatedAt'>): Promise<VendorProfile> {
        const id = `vendor_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;

        // Calculate initial AI risk score
        const { riskScore, riskFactors } = await this.calculateVendorRisk(vendorData);

        const vendor: VendorProfile = {
            ...vendorData,
            id,
            riskScore,
            riskFactors,
            onboardingStatus: 'pending',
            documents: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        this.vendors.set(id, vendor);
        this.logger.info(`Created vendor: ${vendor.companyName}`, { vendorId: id });

        return vendor;
    }

    async getVendors(filters?: { status?: string; riskLevel?: string }): Promise<VendorProfile[]> {
        let vendors = Array.from(this.vendors.values());

        if (filters?.status) {
            vendors = vendors.filter(v => v.onboardingStatus === filters.status);
        }
        if (filters?.riskLevel) {
            const riskThresholds = { low: 30, medium: 60, high: 100 };
            vendors = vendors.filter(v => {
                if (filters.riskLevel === 'low') return v.riskScore <= riskThresholds.low;
                if (filters.riskLevel === 'medium') return v.riskScore > riskThresholds.low && v.riskScore <= riskThresholds.medium;
                return v.riskScore > riskThresholds.medium;
            });
        }

        return vendors;
    }

    async getVendor(vendorId: string): Promise<VendorProfile | null> {
        return this.vendors.get(vendorId) || null;
    }

    async updateVendor(vendorId: string, updates: Partial<VendorProfile>): Promise<VendorProfile> {
        const vendor = this.vendors.get(vendorId);
        if (!vendor) {
            throw new Error(`Vendor not found: ${vendorId}`);
        }

        const updated = { ...vendor, ...updates, updatedAt: new Date() };
        this.vendors.set(vendorId, updated);

        return updated;
    }

    async approveVendor(vendorId: string, approvedBy: string): Promise<VendorProfile> {
        const vendor = this.vendors.get(vendorId);
        if (!vendor) {
            throw new Error(`Vendor not found: ${vendorId}`);
        }

        vendor.onboardingStatus = 'approved';
        vendor.approvedAt = new Date();
        vendor.approvedBy = approvedBy;
        vendor.updatedAt = new Date();

        this.logger.info(`Vendor approved: ${vendor.companyName}`, { vendorId, approvedBy });
        return vendor;
    }

    // =========================================
    // AI VENDOR RISK SCORING
    // =========================================

    async calculateVendorRisk(vendorData: Partial<VendorProfile>): Promise<{ riskScore: number; riskFactors: RiskFactor[] }> {
        const riskFactors: RiskFactor[] = [];
        let totalScore = 0;

        // Financial risk - check for missing tax ID
        if (!vendorData.taxId) {
            riskFactors.push({
                category: 'financial',
                severity: 'medium',
                description: 'Missing tax identification number',
                score: 15,
            });
            totalScore += 15;
        }

        // Compliance risk - check required documents
        const requiredDocs = ['w9', 'insurance'];
        const providedDocs = vendorData.documents?.map(d => d.type) || [];
        requiredDocs.forEach(docType => {
            if (!providedDocs.includes(docType as any)) {
                riskFactors.push({
                    category: 'compliance',
                    severity: 'high',
                    description: `Missing required document: ${docType.toUpperCase()}`,
                    score: 20,
                });
                totalScore += 20;
            }
        });

        // Delivery risk - new vendors have higher risk
        if (!vendorData.createdAt || Date.now() - new Date(vendorData.createdAt).getTime() < 90 * 24 * 60 * 60 * 1000) {
            riskFactors.push({
                category: 'delivery',
                severity: 'low',
                description: 'New vendor with limited delivery history',
                score: 10,
            });
            totalScore += 10;
        }

        // Cap at 100
        const riskScore = Math.min(100, totalScore);

        return { riskScore, riskFactors };
    }

    async getVendorSuggestions(itemId: string, quantity: number): Promise<VendorSuggestion[]> {
        // AI-powered vendor suggestions based on item and quantity
        const vendors = Array.from(this.vendors.values())
            .filter(v => v.onboardingStatus === 'approved');

        return vendors.map(vendor => ({
            vendorId: vendor.id,
            vendorName: vendor.companyName,
            score: 100 - vendor.riskScore, // Higher score = better
            reasoning: vendor.riskScore < 30
                ? 'Low risk vendor with strong delivery history'
                : vendor.riskScore < 60
                    ? 'Moderate risk vendor, consider for non-critical items'
                    : 'Higher risk vendor, recommend additional verification',
            priceEstimate: Math.random() * 1000 + 100, // Demo
            deliveryEstimate: Math.floor(Math.random() * 14) + 3, // 3-17 days
            riskLevel: (vendor.riskScore < 30 ? 'low' : vendor.riskScore < 60 ? 'medium' : 'high') as 'low' | 'medium' | 'high',
        })).sort((a, b) => b.score - a.score);
    }

    // =========================================
    // PURCHASE ORDER MANAGEMENT
    // =========================================

    async createPurchaseOrder(poData: Omit<PurchaseOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<PurchaseOrder> {
        const id = `po_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;

        const po: PurchaseOrder = {
            ...poData,
            id,
            status: 'draft',
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        this.purchaseOrders.set(id, po);
        this.logger.info(`Created PO: ${po.poNumber}`, { poId: id, vendorId: po.vendorId });

        return po;
    }

    async sendPurchaseOrder(poId: string): Promise<PurchaseOrder> {
        const po = this.purchaseOrders.get(poId);
        if (!po) throw new Error(`PO not found: ${poId}`);

        po.status = 'sent';
        po.updatedAt = new Date();

        this.logger.info(`PO sent: ${po.poNumber}`, { poId });
        return po;
    }

    async acknowledgePurchaseOrder(poId: string, promisedDeliveryDate: Date): Promise<PurchaseOrder> {
        const po = this.purchaseOrders.get(poId);
        if (!po) throw new Error(`PO not found: ${poId}`);

        po.status = 'acknowledged';
        po.promisedDeliveryDate = promisedDeliveryDate;
        po.acknowledgmentDate = new Date();
        po.updatedAt = new Date();

        // Update line items with promised dates
        po.lineItems.forEach(item => {
            item.promisedDate = promisedDeliveryDate;
        });

        this.logger.info(`PO acknowledged: ${po.poNumber}`, { poId, promisedDeliveryDate });
        return po;
    }

    async getPurchaseOrders(filters?: { vendorId?: string; status?: string }): Promise<PurchaseOrder[]> {
        let pos = Array.from(this.purchaseOrders.values());

        if (filters?.vendorId) {
            pos = pos.filter(po => po.vendorId === filters.vendorId);
        }
        if (filters?.status) {
            pos = pos.filter(po => po.status === filters.status);
        }

        return pos.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    // =========================================
    // ADVANCED SHIPPING NOTICE (ASN)
    // =========================================

    async createASN(asnData: Omit<AdvancedShippingNotice, 'id' | 'asnNumber' | 'createdAt' | 'updatedAt'>): Promise<AdvancedShippingNotice> {
        const id = `asn_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
        const asnNumber = `ASN-${Date.now()}`;

        const asn: AdvancedShippingNotice = {
            ...asnData,
            id,
            asnNumber,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        this.asns.set(id, asn);

        // Update PO status
        const po = this.purchaseOrders.get(asnData.poId);
        if (po) {
            const totalShipped = asnData.lineItems.reduce((sum, item) => sum + item.quantityShipped, 0);
            const totalOrdered = po.lineItems.reduce((sum, item) => sum + item.quantity, 0);
            po.status = totalShipped >= totalOrdered ? 'shipped' : 'partially_shipped';

            // Update line items
            asnData.lineItems.forEach(asnLine => {
                const poLine = po.lineItems.find(l => l.lineNumber === asnLine.poLineNumber);
                if (poLine) {
                    poLine.quantityShipped += asnLine.quantityShipped;
                }
            });
        }

        this.logger.info(`Created ASN: ${asnNumber}`, { asnId: id, poNumber: asnData.poNumber });
        return asn;
    }

    async getASNs(filters?: { vendorId?: string; poId?: string }): Promise<AdvancedShippingNotice[]> {
        let asns = Array.from(this.asns.values());

        if (filters?.vendorId) {
            asns = asns.filter(a => a.vendorId === filters.vendorId);
        }
        if (filters?.poId) {
            asns = asns.filter(a => a.poId === filters.poId);
        }

        return asns.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    async updateASNStatus(asnId: string, status: AdvancedShippingNotice['status']): Promise<AdvancedShippingNotice> {
        const asn = this.asns.get(asnId);
        if (!asn) throw new Error(`ASN not found: ${asnId}`);

        asn.status = status;
        asn.updatedAt = new Date();

        if (status === 'delivered') {
            asn.actualDeliveryDate = new Date();
        }

        this.logger.info(`ASN status updated: ${asn.asnNumber}`, { asnId, status });
        return asn;
    }

    // =========================================
    // STATISTICS
    // =========================================

    async getStatistics(): Promise<{
        totalVendors: number;
        vendorsByStatus: Record<string, number>;
        averageRiskScore: number;
        pendingPOs: number;
        openASNs: number;
        recentOnboarding: VendorProfile[];
    }> {
        const vendors = Array.from(this.vendors.values());
        const pos = Array.from(this.purchaseOrders.values());
        const asns = Array.from(this.asns.values());

        const vendorsByStatus: Record<string, number> = {};
        vendors.forEach(v => {
            vendorsByStatus[v.onboardingStatus] = (vendorsByStatus[v.onboardingStatus] || 0) + 1;
        });

        return {
            totalVendors: vendors.length,
            vendorsByStatus,
            averageRiskScore: vendors.length > 0
                ? vendors.reduce((sum, v) => sum + v.riskScore, 0) / vendors.length
                : 0,
            pendingPOs: pos.filter(p => ['draft', 'sent', 'acknowledged'].includes(p.status)).length,
            openASNs: asns.filter(a => ['pending', 'in_transit'].includes(a.status)).length,
            recentOnboarding: vendors
                .filter(v => v.onboardingStatus === 'pending')
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
                .slice(0, 5),
        };
    }

    // =========================================
    // DEMO DATA
    // =========================================

    private initializeDemoData(): void {
        // Demo vendors
        const demoVendors: Omit<VendorProfile, 'riskScore' | 'riskFactors'>[] = [
            {
                id: 'vendor_demo_1',
                companyName: 'TechStart Solutions LLC',
                contactName: 'John Smith',
                email: 'john@acmesupplies.com',
                phone: '+1-555-0101',
                address: { street: '123 Industrial Blvd', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'USA' },
                taxId: '12-3456789',
                documents: [
                    { id: 'doc1', type: 'w9', fileName: 'w9-acme.pdf', uploadedAt: new Date(), status: 'verified' },
                    { id: 'doc2', type: 'insurance', fileName: 'insurance-cert.pdf', uploadedAt: new Date(), status: 'verified' },
                ],
                onboardingStatus: 'approved',
                paymentTerms: 'Net 30',
                preferredPaymentMethod: 'ach',
                createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
                updatedAt: new Date(),
                approvedAt: new Date(Date.now() - 360 * 24 * 60 * 60 * 1000),
                approvedBy: 'admin',
            },
            {
                id: 'vendor_demo_2',
                companyName: 'Global Parts Ltd.',
                contactName: 'Jane Doe',
                email: 'jane@globalparts.com',
                phone: '+1-555-0102',
                address: { street: '456 Commerce Way', city: 'Detroit', state: 'MI', postalCode: '48201', country: 'USA' },
                documents: [],
                onboardingStatus: 'pending',
                paymentTerms: 'Net 45',
                preferredPaymentMethod: 'check',
                createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                updatedAt: new Date(),
            },
        ];

        demoVendors.forEach(v => {
            const { riskScore, riskFactors } = this.calculateVendorRiskSync(v);
            this.vendors.set(v.id, { ...v, riskScore, riskFactors } as VendorProfile);
        });

        // Demo POs
        const demoPOs: PurchaseOrder[] = [
            {
                id: 'po_demo_1',
                poNumber: 'PO-2026-001',
                vendorId: 'vendor_demo_1',
                status: 'acknowledged',
                lineItems: [
                    { lineNumber: 1, itemId: 'ITEM-001', itemName: 'Widget A', quantity: 100, unitPrice: 25.00, unit: 'EA', amount: 2500, requestedDate: new Date(), quantityShipped: 0, quantityReceived: 0 },
                    { lineNumber: 2, itemId: 'ITEM-002', itemName: 'Widget B', quantity: 50, unitPrice: 40.00, unit: 'EA', amount: 2000, requestedDate: new Date(), quantityShipped: 0, quantityReceived: 0 },
                ],
                subtotal: 4500,
                tax: 360,
                total: 4860,
                currency: 'USD',
                requestedDeliveryDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
                promisedDeliveryDate: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000),
                acknowledgmentDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
                shippingAddress: { street: '789 Warehouse Dr', city: 'Dallas', state: 'TX', postalCode: '75201', country: 'USA' },
                createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
                updatedAt: new Date(),
            },
        ];

        demoPOs.forEach(po => this.purchaseOrders.set(po.id, po));

        this.logger.debug(`Initialized ${this.vendors.size} demo vendors, ${this.purchaseOrders.size} demo POs`);
    }

    private calculateVendorRiskSync(vendorData: Partial<VendorProfile>): { riskScore: number; riskFactors: RiskFactor[] } {
        const riskFactors: RiskFactor[] = [];
        let totalScore = 0;

        if (!vendorData.taxId) {
            riskFactors.push({ category: 'financial', severity: 'medium', description: 'Missing tax ID', score: 15 });
            totalScore += 15;
        }

        const docs = vendorData.documents || [];
        if (!docs.some(d => d.type === 'w9')) {
            riskFactors.push({ category: 'compliance', severity: 'high', description: 'Missing W-9', score: 20 });
            totalScore += 20;
        }
        if (!docs.some(d => d.type === 'insurance')) {
            riskFactors.push({ category: 'compliance', severity: 'high', description: 'Missing insurance', score: 20 });
            totalScore += 20;
        }

        return { riskScore: Math.min(100, totalScore), riskFactors };
    }
}

export default SupplierCentralParityService;
