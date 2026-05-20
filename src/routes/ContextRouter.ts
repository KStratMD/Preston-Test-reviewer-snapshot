/**
 * Context Router
 *
 * API endpoint for fetching contextual data based on ERP record context.
 * This powers the "Killer App" Context Sidecar feature by aggregating
 * relevant data from SuiteCentral module services when available, with
 * deterministic fallback data for demo/offline scenarios.
 *
 * Endpoints:
 *   GET /api/context/:system/:recordType/:recordId
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/Logger';
import { getAIContextAnalyzer } from '../services/ai/AIContextAnalyzer';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SupplierCentralService, PurchaseOrder } from '../services/SupplierCentralService';
import type { CustomerCentralService } from '../services/CustomerCentralService';
import type { PaymentCentralService } from '../services/PaymentCentralService';

export const contextRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_SYSTEMS = new Set(['netsuite', 'business_central', 'squire']);
const RECORD_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Record type to module mapping
 */
const RECORD_TYPE_MODULES: Record<string, string[]> = {
    vendor: ['SupplierCentral', 'PaymentCentral', 'ContractCentral'],
    customer: ['CustomerCentral', 'PaymentCentral', 'SyncCentral'],
    invoice: ['PaymentCentral', 'CustomerCentral'],
    purchaseorder: ['SupplierCentral', 'InventoryCentral'],
    salesorder: ['CustomerCentral', 'InventoryCentral', 'SyncCentral'],
    item: ['InventoryCentral', 'SupplierCentral'],
};

interface ContextServices {
    supplierService?: SupplierCentralService;
    customerService?: CustomerCentralService;
    paymentService?: PaymentCentralService;
}

/**
 * GET /api/context/:system/:recordType/:recordId
 *
 * Fetches aggregated contextual data for a given record.
 * Returns risk score, alerts, quick actions, and AI-generated insights.
 */
contextRouter.get('/:system/:recordType/:recordId', async (req: Request, res: Response) => {
    const { system, recordType, recordId } = req.params;

    logger.info('Context API request', { system, recordType, recordId });

    try {
        // Validate inputs
        if (!system || !recordType || !recordId) {
            return res.status(400).json({
                error: 'Missing required parameters: system, recordType, recordId'
            });
        }

        const normalizedSystem = system.toLowerCase();
        const normalizedRecordType = recordType.toLowerCase();
        if (!ALLOWED_SYSTEMS.has(normalizedSystem)) {
            return res.status(400).json({
                error: `Unsupported system '${system}'. Allowed values: netsuite, business_central, squire`
            });
        }

        if (!Object.prototype.hasOwnProperty.call(RECORD_TYPE_MODULES, normalizedRecordType)) {
            return res.status(400).json({
                error: `Unsupported recordType '${recordType}'`
            });
        }

        if (!RECORD_ID_PATTERN.test(recordId)) {
            return res.status(400).json({
                error: 'Invalid recordId format. Allowed characters: letters, numbers, underscore, hyphen'
            });
        }

        const modules = RECORD_TYPE_MODULES[normalizedRecordType] || [];

        // Build contextual response based on record type
        const contextData = await buildContextData(normalizedSystem, normalizedRecordType, recordId, modules);

        // Generate AI insights (Pre-Cognition Layer)
        const analyzer = getAIContextAnalyzer();
        const aiInsights = await analyzer.analyzeContext({
            system: normalizedSystem,
            recordType: normalizedRecordType,
            recordId,
            riskScore: contextData.riskScore ?? undefined,
            alerts: contextData.alerts
        });

        return res.json({
            success: true,
            system: normalizedSystem,
            recordType: normalizedRecordType,
            recordId,
            modules,
            ...contextData,
            aiInsights
        });

    } catch (error) {
        logger.error('Context API error', { error, system, recordType, recordId });
        return res.status(500).json({
            error: 'Failed to fetch context data'
        });
    }
});

/**
 * Build contextual data by aggregating from relevant modules.
 * Priority:
 * 1. Service-backed context from in-memory/live module services
 * 2. Deterministic fallback context for demo/offline behavior
 */
async function buildContextData(
    _system: string,
    recordType: string,
    recordId: string,
    modules: string[]
): Promise<ContextResponse> {
    const services = getContextServices();

    const liveData = await buildLiveContextData(recordType, recordId, services, modules);
    if (liveData) {
        return {
            ...liveData,
            dataSource: 'service',
            lastUpdated: new Date().toISOString(),
        };
    }

    const fallback = buildFallbackContext(recordType, recordId, modules);
    return {
        ...fallback,
        dataSource: process.env.DEMO_MODE === '1' ? 'demo' : 'fallback',
        lastUpdated: new Date().toISOString(),
    };
}

function getContextServices(): ContextServices {
    const safeGet = <T>(token: symbol): T | undefined => {
        try {
            return container.get<T>(token);
        } catch {
            return undefined;
        }
    };

    return {
        supplierService: safeGet<SupplierCentralService>(TYPES.SupplierCentralService),
        customerService: safeGet<CustomerCentralService>(TYPES.CustomerCentralService),
        paymentService: safeGet<PaymentCentralService>(TYPES.PaymentCentralService),
    };
}

async function buildLiveContextData(
    recordType: string,
    recordId: string,
    services: ContextServices,
    modules: string[]
): Promise<ContextResponse | null> {
    try {
        switch (recordType) {
            case 'vendor':
                return buildVendorContextFromServices(recordId, services, modules);
            case 'customer':
                return buildCustomerContextFromServices(recordId, services, modules);
            case 'invoice':
                return buildInvoiceContextFromServices(recordId, services, modules);
            case 'purchaseorder':
                return buildPurchaseOrderContextFromServices(recordId, services, modules);
            default:
                return null;
        }
    } catch (error) {
        logger.warn('Live context data assembly failed, using fallback', {
            recordType,
            recordId,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

async function buildVendorContextFromServices(
    vendorId: string,
    services: ContextServices,
    modules: string[]
): Promise<ContextResponse | null> {
    const supplier = services.supplierService;
    if (!supplier) {
        return null;
    }

    const vendor = await supplier.getVendorProfile(vendorId);
    if (!vendor) {
        return null;
    }

    const poResult = await supplier.getPurchaseOrdersForVendor(vendor.id, { limit: 100, offset: 0 });
    const orders = poResult.orders;
    const openPOs = orders.filter(po => ['pending_acknowledgement', 'acknowledged', 'in_progress', 'shipped'].includes(po.status)).length;
    const latePOs = orders.filter(
        po => po.requestedDeliveryDate < Date.now() && !['received', 'cancelled'].includes(po.status)
    ).length;

    const insurancePolicies = [
        vendor.compliance.insurance.generalLiability,
        vendor.compliance.insurance.workersComp,
        vendor.compliance.insurance.professionalLiability,
    ];
    const expiredPolicyCount = insurancePolicies.filter(
        policy => !!policy.expirationDate && policy.expirationDate < Date.now()
    ).length;
    const expiringSoonPolicyCount = insurancePolicies.filter(
        policy =>
            !!policy.expirationDate &&
            policy.expirationDate >= Date.now() &&
            policy.expirationDate < (Date.now() + (30 * DAY_MS))
    ).length;

    let riskScore = 20;
    if (vendor.onboardingStatus.stage === 'compliance_review') riskScore += 20;
    if (vendor.onboardingStatus.stage === 'suspended') riskScore += 35;
    if (vendor.netSuite.syncStatus === 'failed') riskScore += 20;
    if (latePOs > 0) riskScore += Math.min(20, latePOs * 8);
    if (expiredPolicyCount > 0) riskScore += 20;
    if (expiringSoonPolicyCount > 0) riskScore += 10;
    riskScore = clampRisk(riskScore);

    return {
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        alerts: [
            ...(vendor.netSuite.syncStatus === 'failed'
                ? [{ severity: 'warning', message: 'NetSuite sync failures detected for vendor profile', source: 'SupplierCentral' }]
                : []),
            ...(latePOs > 0
                ? [{ severity: 'warning', message: `${latePOs} purchase order(s) are past requested delivery date`, source: 'SupplierCentral' }]
                : []),
            ...(expiredPolicyCount > 0
                ? [{ severity: 'critical', message: `${expiredPolicyCount} insurance policy(ies) expired`, source: 'ContractCentral' }]
                : []),
            ...(expiringSoonPolicyCount > 0
                ? [{ severity: 'warning', message: `${expiringSoonPolicyCount} insurance policy(ies) expiring within 30 days`, source: 'ContractCentral' }]
                : []),
            ...(vendor.compliance.w9Form.status !== 'verified'
                ? [{ severity: 'info', message: `W-9 status is ${vendor.compliance.w9Form.status}`, source: 'SupplierCentral' }]
                : []),
        ],
        quickActions: [
            { label: 'View Risk Profile', action: 'openSupplierCentral', icon: '[R]' },
            { label: 'Request W-9', action: 'requestDocument', icon: '[D]', params: { docType: 'W-9' } },
            { label: 'View Payment History', action: 'openPaymentCentral', icon: '[P]' },
            ...(riskScore > 70 ? [{ label: 'Pause Payments', action: 'pausePayments', icon: '[!]' }] : []),
        ],
        insights: [
            { label: 'Onboarding Stage', value: vendor.onboardingStatus.stage.replace(/_/g, ' '), trend: 'stable' },
            { label: 'Open POs', value: String(openPOs), trend: openPOs > 5 ? 'down' : 'stable' },
            { label: 'NetSuite Sync', value: vendor.netSuite.syncStatus, trend: vendor.netSuite.syncStatus === 'synced' ? 'up' : 'down' },
        ],
        modules,
        lastUpdated: new Date().toISOString(),
    };
}

async function buildCustomerContextFromServices(
    customerId: string,
    services: ContextServices,
    modules: string[]
): Promise<ContextResponse | null> {
    const customers = services.customerService;
    if (!customers) {
        return null;
    }

    const customer = await customers.getCustomer(customerId);
    if (!customer) {
        return null;
    }

    const tickets = await customers.getCustomerTickets(customer.id, 20);
    const openTickets = tickets.filter(t => ['open', 'in_progress', 'waiting'].includes(t.status)).length;

    const churnBase = customer.metrics.churnRisk === 'high'
        ? 70
        : customer.metrics.churnRisk === 'medium'
            ? 50
            : 25;

    let riskScore = churnBase;
    if (openTickets >= 3) riskScore += 10;
    if (customer.metrics.daysSinceLastOrder > 30) riskScore += 10;
    if ((customer.metrics.npsScore ?? 50) < 30) riskScore += 10;
    riskScore = clampRisk(riskScore);

    return {
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        alerts: [
            ...(customer.metrics.churnRisk === 'high'
                ? [{ severity: 'critical', message: 'High churn risk detected from customer health indicators', source: 'CustomerCentral' }]
                : []),
            ...(openTickets > 0
                ? [{ severity: openTickets > 2 ? 'warning' : 'info', message: `${openTickets} open support ticket(s)`, source: 'CustomerCentral' }]
                : []),
            ...(customer.metrics.daysSinceLastOrder > 30
                ? [{ severity: 'info', message: `${customer.metrics.daysSinceLastOrder} days since last order`, source: 'CustomerCentral' }]
                : []),
        ],
        quickActions: [
            { label: 'View Customer 360', action: 'openCustomerCentral', icon: '[C]' },
            { label: 'Check Support Tickets', action: 'openZendesk', icon: '[T]' },
            { label: 'View Payment Status', action: 'openPaymentCentral', icon: '[P]' },
            ...(riskScore > 60 ? [{ label: 'Escalate to CSM', action: 'escalateToCSM', icon: '[!]' }] : []),
        ],
        insights: [
            { label: 'Lifetime Value', value: `$${Math.round(customer.metrics.lifetimeValue).toLocaleString()}`, trend: 'stable' },
            { label: 'NPS Score', value: String(customer.metrics.npsScore ?? 'N/A'), trend: (customer.metrics.npsScore ?? 0) < 40 ? 'down' : 'up' },
            { label: 'Days Since Order', value: String(customer.metrics.daysSinceLastOrder), trend: customer.metrics.daysSinceLastOrder > 30 ? 'down' : 'stable' },
        ],
        modules,
        lastUpdated: new Date().toISOString(),
    };
}

async function buildInvoiceContextFromServices(
    invoiceId: string,
    services: ContextServices,
    modules: string[]
): Promise<ContextResponse | null> {
    const payments = services.paymentService;
    if (!payments) {
        return null;
    }

    const invoice = await payments.getInvoice(invoiceId);
    if (!invoice) {
        return null;
    }

    const daysPastDue = Math.max(0, Math.floor((Date.now() - invoice.dueDate) / DAY_MS));
    let riskScore = Math.min(90, daysPastDue * 2);
    if (invoice.matchStatus === 'disputed') riskScore += 15;
    if (invoice.paymentStatus === 'held') riskScore += 10;
    riskScore = clampRisk(riskScore);

    return {
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        alerts: [
            ...(daysPastDue > 30
                ? [{ severity: 'critical', message: `Invoice is ${daysPastDue} days past due`, source: 'PaymentCentral' }]
                : []),
            ...(daysPastDue > 0 && daysPastDue <= 30
                ? [{ severity: 'warning', message: `Invoice is ${daysPastDue} days past due`, source: 'PaymentCentral' }]
                : []),
            ...(invoice.matchStatus === 'disputed'
                ? [{ severity: 'warning', message: 'Invoice is currently disputed', source: 'PaymentCentral' }]
                : []),
        ],
        quickActions: [
            { label: 'Send Reminder', action: 'sendPaymentReminder', icon: '[M]' },
            { label: 'View in PaymentCentral', action: 'openPaymentCentral', icon: '[P]' },
            ...(daysPastDue > 30 ? [{ label: 'Start Collections', action: 'startCollections', icon: '[!]' }] : []),
        ],
        insights: [
            { label: 'Amount', value: `$${Math.round(invoice.totalAmount).toLocaleString()}`, trend: 'stable' },
            { label: 'Match Status', value: invoice.matchStatus, trend: invoice.matchStatus === 'approved' ? 'up' : 'down' },
            { label: 'Payment Status', value: invoice.paymentStatus, trend: invoice.paymentStatus === 'paid' ? 'up' : 'stable' },
        ],
        modules,
        lastUpdated: new Date().toISOString(),
    };
}

async function buildPurchaseOrderContextFromServices(
    poId: string,
    services: ContextServices,
    modules: string[]
): Promise<ContextResponse | null> {
    const supplier = services.supplierService;
    if (!supplier) {
        return null;
    }

    const po = await supplier.getPurchaseOrder(poId);
    if (!po) {
        return null;
    }

    const vendor = await supplier.getVendorProfile(po.vendorId);
    if (!vendor) {
        logger.warn('Vendor not found while assembling purchase order context', { poId, vendorId: po.vendorId });
    }

    const statusRisk: Record<PurchaseOrder['status'], number> = {
        pending_acknowledgement: 45,
        acknowledged: 30,
        in_progress: 25,
        shipped: 20,
        received: 10,
        cancelled: 15,
    };

    let riskScore = statusRisk[po.status] ?? 25;
    const daysToDelivery = Math.ceil((po.requestedDeliveryDate - Date.now()) / DAY_MS);
    if (daysToDelivery < 0 && !['received', 'cancelled'].includes(po.status)) {
        riskScore += 20;
    }

    const delayedLines = po.lines.filter(
        l => l.expectedShipDate < Date.now() && !['shipped', 'received', 'cancelled'].includes(l.status)
    ).length;
    if (delayedLines > 0) {
        riskScore += Math.min(15, delayedLines * 5);
    }

    riskScore = clampRisk(riskScore);

    return {
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        alerts: [
            ...(daysToDelivery < 0 && !['received', 'cancelled'].includes(po.status)
                ? [{ severity: 'warning', message: `Purchase order is ${Math.abs(daysToDelivery)} day(s) past requested delivery`, source: 'SupplierCentral' }]
                : []),
            ...(delayedLines > 0
                ? [{ severity: 'warning', message: `${delayedLines} line item(s) delayed`, source: 'SupplierCentral' }]
                : []),
            ...(vendor && vendor.netSuite.syncStatus === 'failed'
                ? [{ severity: 'info', message: 'Vendor has recent NetSuite sync failures', source: 'SupplierCentral' }]
                : []),
            ...(!vendor
                ? [{ severity: 'info', message: 'Vendor profile unavailable for this purchase order', source: 'SupplierCentral' }]
                : []),
        ],
        quickActions: [
            { label: 'Track Shipment', action: 'trackShipment', icon: '[S]' },
            { label: 'View Supplier', action: 'openSupplierCentral', icon: '[V]' },
            { label: 'Check Inventory', action: 'openInventoryCentral', icon: '[I]' },
        ],
        insights: [
            { label: 'PO Total', value: `$${Math.round(po.total).toLocaleString()}`, trend: 'stable' },
            { label: 'Line Items', value: String(po.lines.length), trend: 'stable' },
            { label: 'Supplier', value: vendor?.basicInfo.companyName || po.vendorId, trend: 'stable' },
        ],
        modules,
        lastUpdated: new Date().toISOString(),
    };
}

function buildFallbackContext(recordType: string, recordId: string, modules: string[]): ContextResponse {
    const baseContext: ContextResponse = {
        riskScore: null,
        riskLevel: 'unknown',
        alerts: [],
        quickActions: [],
        insights: [],
        modules,
        lastUpdated: new Date().toISOString(),
    };

    switch (recordType) {
        case 'vendor':
            return buildVendorContextFallback(recordId, modules);
        case 'customer':
            return buildCustomerContextFallback(recordId, modules);
        case 'invoice':
            return buildInvoiceContextFallback(recordId, modules);
        case 'purchaseorder':
            return buildPurchaseOrderContextFallback(recordId, modules);
        default:
            return baseContext;
    }
}

/**
 * Vendor context fallback
 */
function buildVendorContextFallback(recordId: string, modules: string[]): ContextResponse {
    const hash = simpleHash(recordId);
    const riskScore = 30 + (hash % 50); // 30-79 range

    return {
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        alerts: [
            ...(riskScore > 60 ? [{ severity: 'warning', message: 'High late delivery rate (fallback)', source: 'SupplierCentral' }] : []),
            ...(hash % 3 === 0 ? [{ severity: 'critical', message: 'Insurance certificate appears expired (fallback)', source: 'ContractCentral' }] : []),
        ],
        quickActions: [
            { label: 'View Risk Profile', action: 'openSupplierCentral', icon: '[R]' },
            { label: 'Request W-9', action: 'requestDocument', icon: '[D]', params: { docType: 'W-9' } },
            { label: 'View Payment History', action: 'openPaymentCentral', icon: '[P]' },
            ...(riskScore > 70 ? [{ label: 'Pause Payments', action: 'pausePayments', icon: '[!]' }] : []),
        ],
        insights: [
            { label: 'On-Time Delivery', value: `${100 - Math.floor(riskScore / 3)}%`, trend: riskScore > 50 ? 'down' : 'up' },
            { label: 'Open POs', value: `${3 + (hash % 5)}`, trend: 'stable' },
            { label: 'Avg Lead Time', value: `${5 + (hash % 10)} days`, trend: 'stable' },
        ],
        modules,
        lastUpdated: new Date().toISOString()
    };
}

/**
 * Customer context fallback
 */
function buildCustomerContextFallback(recordId: string, modules: string[]): ContextResponse {
    const hash = simpleHash(recordId);
    const riskScore = 20 + (hash % 60);

    return {
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        alerts: [
            ...(riskScore > 65 ? [{ severity: 'critical', message: 'High churn risk detected (fallback)', source: 'CustomerCentral' }] : []),
            ...(hash % 4 === 0 ? [{ severity: 'warning', message: 'Open support tickets detected (fallback)', source: 'CustomerCentral' }] : []),
        ],
        quickActions: [
            { label: 'View Customer 360', action: 'openCustomerCentral', icon: '[C]' },
            { label: 'Check Support Tickets', action: 'openZendesk', icon: '[T]' },
            { label: 'View Payment Status', action: 'openPaymentCentral', icon: '[P]' },
        ],
        insights: [
            { label: 'Lifetime Value', value: `$${(50000 + hash * 1000).toLocaleString()}`, trend: 'up' },
            { label: 'NPS Score', value: `${90 - Math.floor(riskScore / 2)}`, trend: riskScore > 50 ? 'down' : 'stable' },
            { label: 'Last Order', value: `${2 + (hash % 14)} days ago`, trend: 'stable' },
        ],
        modules,
        lastUpdated: new Date().toISOString()
    };
}

/**
 * Invoice context fallback
 */
function buildInvoiceContextFallback(recordId: string, modules: string[]): ContextResponse {
    const hash = simpleHash(recordId);
    const daysPastDue = hash % 45;
    const riskScore = Math.min(90, daysPastDue * 2);

    return {
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        alerts: [
            ...(daysPastDue > 30 ? [{ severity: 'critical', message: `Invoice ${daysPastDue} days past due (fallback)`, source: 'PaymentCentral' }] : []),
            ...(daysPastDue > 0 && daysPastDue <= 30 ? [{ severity: 'warning', message: `Invoice ${daysPastDue} days past due (fallback)`, source: 'PaymentCentral' }] : []),
        ],
        quickActions: [
            { label: 'Send Reminder', action: 'sendPaymentReminder', icon: '[M]' },
            { label: 'View in PaymentCentral', action: 'openPaymentCentral', icon: '[P]' },
            ...(daysPastDue > 30 ? [{ label: 'Start Collections', action: 'startCollections', icon: '[!]' }] : []),
        ],
        insights: [
            { label: 'Amount', value: `$${(1000 + hash * 100).toLocaleString()}`, trend: 'stable' },
            { label: 'Days Outstanding', value: `${daysPastDue}`, trend: daysPastDue > 0 ? 'down' : 'stable' },
            { label: 'Payment Probability', value: `${Math.max(20, 95 - daysPastDue * 2)}%`, trend: daysPastDue > 15 ? 'down' : 'stable' },
        ],
        modules,
        lastUpdated: new Date().toISOString()
    };
}

/**
 * Purchase order context fallback
 */
function buildPurchaseOrderContextFallback(recordId: string, modules: string[]): ContextResponse {
    const hash = simpleHash(recordId);
    const riskScore = 15 + (hash % 45);

    return {
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        alerts: [
            ...(riskScore > 40 ? [{ severity: 'warning', message: 'Supplier has elevated delivery risk (fallback)', source: 'SupplierCentral' }] : []),
            ...(hash % 5 === 0 ? [{ severity: 'info', message: 'Partial shipment expected (fallback)', source: 'ShipStation' }] : []),
        ],
        quickActions: [
            { label: 'Track Shipment', action: 'trackShipment', icon: '[S]' },
            { label: 'View Supplier', action: 'openSupplierCentral', icon: '[V]' },
            { label: 'Check Inventory', action: 'openInventoryCentral', icon: '[I]' },
        ],
        insights: [
            { label: 'Expected Delivery', value: `${3 + (hash % 7)} days`, trend: 'stable' },
            { label: 'Line Items', value: `${2 + (hash % 8)}`, trend: 'stable' },
            { label: 'Supplier Rating', value: `${Math.max(3, 5 - Math.floor(riskScore / 25))}/5`, trend: riskScore > 30 ? 'down' : 'stable' },
        ],
        modules,
        lastUpdated: new Date().toISOString()
    };
}

/**
 * Simple hash function for deterministic fallback data
 */
function simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

function clampRisk(score: number): number {
    return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Get risk level from score
 */
function getRiskLevel(score: number): string {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
}

/**
 * Context response shape
 */
interface ContextResponse {
    riskScore: number | null;
    riskLevel: string;
    alerts: { severity: string; message: string; source?: string }[];
    quickActions: { label: string; action: string; icon?: string; params?: Record<string, unknown> }[];
    insights?: { label: string; value: string; trend: string }[];
    modules?: string[];
    dataSource?: 'service' | 'demo' | 'fallback';
    lastUpdated: string;
}
