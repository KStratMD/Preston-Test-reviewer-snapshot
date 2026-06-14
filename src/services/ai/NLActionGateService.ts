import { injectable, inject } from 'inversify';
import { randomUUID } from 'crypto';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import type { PaymentCentralService } from '../PaymentCentralService';
import type { FinanceCentralService } from '../FinanceCentralService';
import type { FinanceCentralOperatorService } from '../financeCentral/FinanceCentralOperatorService';
import { SYSTEM_IDENTITY, type IdentityContext } from '../governance/identityContext';
import type { InventoryCentralService } from '../InventoryCentralService';
import type { PortalCentralService } from '../PortalCentralService';
import type { SupplierCentralService } from '../SupplierCentralService';
import type { SyncCentralService } from '../SyncCentralService';
import type { SecureAIService } from './SecureAIService';
import { parseJsonFromText } from '../../utils/json';

/**
 * Natural Language Action Gate Service
 * 
 * Implements the "NL Action Gate" from Grand Unified Strategy 2026.
 * 
 * Concept: "Refund this customer" → translated to API calls
 * Safety: Human-in-the-Loop Gateway
 *   - AI proposes: `POST /refund { amount: 50.00 }`
 *   - UI shows: "Refund $50.00? [Approve] [Reject]"
 *   - Value: Trust. Users won't let AI write to ERPs without a confirm button.
 */

export interface ParsedIntent {
    action: string;
    targetSystem: string;
    operation: string;
    parameters: Record<string, unknown>;
    confidence: number;
    rawInput: string;
}

export interface ProposedAction {
    id: string;
    intent: ParsedIntent;
    apiCall: {
        method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
        endpoint: string;
        body?: Record<string, unknown>;
    };
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    requiresApproval: boolean;
    humanReadableDescription: string;
    estimatedImpact?: string;
    createdAt: Date;
    expiresAt: Date;
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
}

/**
 * Result of an action execution or rejection
 * @property proposedAction - The action that was processed. Absent when action not found (invalid ID).
 */
export interface ActionResult {
    success: boolean;
    /** Present when action exists, absent when action ID not found */
    proposedAction?: ProposedAction;
    executionResult?: unknown;
    error?: string;
    /** Structured error code for programmatic handling */
    errorCode?: 'not_found' | 'not_approved' | 'validation_error' | 'not_implemented' | 'dispatch_error';
    executedAt?: Date;
}

// Intent patterns for common actions
const INTENT_PATTERNS = [
    {
        pattern: /refund\s+(?:this\s+)?(?:customer|order|transaction)?\s*(?:for\s+)?\$?(\d+(?:\.\d{2})?)?\s*(?:(?:on|for)\s+)?(?:invoice\s+)?((?:INV[-_]|inv[-_])[\w-]+)?/i,
        action: 'refund',
        targetSystem: 'payment',
        operation: 'POST',
        extractParams: (match: RegExpMatchArray) => ({
            amount: match[1] ? parseFloat(match[1]) : undefined,
            invoiceId: match[2]?.trim() || undefined
        })
    },
    {
        pattern: /create\s+(?:a\s+)?(?:new\s+)?(?:purchase\s+)?order\s+(?:for\s+)?(.+)/i,
        action: 'create-purchase-order',
        targetSystem: 'supplier',
        operation: 'POST',
        extractParams: (match: RegExpMatchArray) => ({
            vendorName: match[1]?.trim()
        })
    },
    {
        pattern: /send\s+(?:a\s+)?(?:reminder|email|notification)\s+to\s+(.+)/i,
        action: 'send-notification',
        targetSystem: 'communication',
        operation: 'POST',
        extractParams: (match: RegExpMatchArray) => ({
            recipient: match[1]?.trim()
        })
    },
    {
        pattern: /update\s+(?:the\s+)?(?:inventory|stock)\s+(?:for\s+)?(.+?)\s+to\s+(\d+)/i,
        action: 'update-inventory',
        targetSystem: 'inventory',
        operation: 'PUT',
        extractParams: (match: RegExpMatchArray) => ({
            itemName: match[1]?.trim(),
            quantity: parseInt(match[2])
        })
    },
    {
        pattern: /approve\s+(?:the\s+)?(?:invoice|payment|expense|document|approval)\s+(?:#?\s*)?([\w-]+)/i,
        action: 'approve-document',
        targetSystem: 'finance',
        operation: 'POST',
        extractParams: (match: RegExpMatchArray) => ({
            approvalId: match[1]?.trim(),
            // Keep documentId as alias for backward compat in descriptions
            documentId: match[1]?.trim()
        })
    },
    {
        pattern: /cancel\s+(?:the\s+)?subscription\s+(?:#?\s*)?([\w-]+)(?:\s+for\s+(.+))?/i,
        action: 'cancel',
        targetSystem: 'sync',
        operation: 'POST',
        extractParams: (match: RegExpMatchArray) => ({
            entityId: match[1]?.trim(),
            reason: match[2]?.trim(),
            entityType: 'subscription'
        })
    }
];

const ACTION_PARAM_WHITELIST: Record<string, readonly string[]> = {
    refund: ['amount', 'invoiceId', 'reason'],
    'create-purchase-order': ['vendorName', 'vendorId', 'buyerCompany', 'buyerContact', 'requestedDeliveryDate', 'currency', 'notes', 'shippingAddress', 'lines'],
    'send-notification': ['recipient', 'title', 'message'],
    'update-inventory': ['itemName', 'quantity', 'warehouseId'],
    'approve-document': ['approvalId', 'documentId', 'comments'],
    cancel: ['entityId', 'reason', 'entityType'],
};

const MAX_PO_LINES_FROM_LLM = 20;

// Memory management constants
const MAX_PENDING_ACTIONS = 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Run cleanup every 5 minutes
const ACTION_EXPIRATION_MS = 5 * 60 * 1000; // Actions expire after 5 minutes

@injectable()
export class NLActionGateService {
    private pendingActions = new Map<string, ProposedAction>();
    private logger: Logger;
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    private paymentService?: PaymentCentralService;
    private financeService?: FinanceCentralService;
    private financeOperatorService?: FinanceCentralOperatorService;
    private inventoryService?: InventoryCentralService;
    private portalService?: PortalCentralService;
    private supplierService?: SupplierCentralService;
    private syncService?: SyncCentralService;
    private secureAIService?: SecureAIService;

    constructor(
        @inject(TYPES.Logger) logger: Logger,
        paymentService?: PaymentCentralService,
        financeService?: FinanceCentralService,
        inventoryService?: InventoryCentralService,
        portalService?: PortalCentralService,
        supplierService?: SupplierCentralService,
        syncService?: SyncCentralService,
        secureAIService?: SecureAIService,
        financeOperatorService?: FinanceCentralOperatorService
    ) {
        this.logger = logger;
        this.paymentService = paymentService;
        this.financeService = financeService;
        this.financeOperatorService = financeOperatorService;
        this.inventoryService = inventoryService;
        this.portalService = portalService;
        this.supplierService = supplierService;
        this.syncService = syncService;
        this.secureAIService = secureAIService;
        this.logger.info('[NLActionGate] Service initialized', {
            services: {
                payment: !!paymentService,
                finance: !!financeService,
                financeOperator: !!financeOperatorService,
                inventory: !!inventoryService,
                portal: !!portalService,
                supplier: !!supplierService,
                sync: !!syncService,
            },
            llmIntentParsing: !!secureAIService,
        });
        this.startPeriodicCleanup();
    }

    /**
     * Start periodic cleanup of expired/old actions
     */
    private startPeriodicCleanup(): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredActions();
        }, CLEANUP_INTERVAL_MS);
        // Allow process to exit even if interval is running
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }

    /**
     * Clean up expired and processed actions to prevent memory leaks
     */
    private cleanupExpiredActions(): void {
        const now = new Date();
        let removed = 0;

        for (const [actionId, action] of this.pendingActions) {
            // Remove expired actions
            if (now > action.expiresAt) {
                this.pendingActions.delete(actionId);
                removed++;
                continue;
            }
            // Remove already-processed actions (executed, rejected)
            if (action.status !== 'pending' && action.status !== 'approved') {
                this.pendingActions.delete(actionId);
                removed++;
            }
        }

        // If still over limit, remove oldest actions
        if (this.pendingActions.size > MAX_PENDING_ACTIONS) {
            const toRemove = this.pendingActions.size - MAX_PENDING_ACTIONS;
            const entries = Array.from(this.pendingActions.entries());
            for (let i = 0; i < toRemove && i < entries.length; i++) {
                this.pendingActions.delete(entries[i][0]);
                removed++;
            }
        }

        if (removed > 0) {
            this.logger.debug('[NLActionGate] Cleaned up actions', { removed, remaining: this.pendingActions.size });
        }
    }

    /**
     * Stop periodic cleanup (for graceful shutdown)
     */
    public stopPeriodicCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    /**
     * Parse natural language input into a structured intent
     */
    parseIntent(input: string): ParsedIntent | null {
        return this.parseIntentInternal(input, true);
    }

    /**
     * Parse intent without warning log on no-match.
     * Useful for speculative/fallback parsing paths.
     */
    parseIntentQuiet(input: string): ParsedIntent | null {
        return this.parseIntentInternal(input, false);
    }

    private parseIntentInternal(input: string, logOnMiss: boolean): ParsedIntent | null {
        // Match against original trimmed input (all patterns use /i flag)
        // to preserve original casing for IDs like INV-2026-001
        const trimmedInput = input.trim();

        for (const pattern of INTENT_PATTERNS) {
            const match = trimmedInput.match(pattern.pattern);
            if (match) {
                const params = pattern.extractParams(match);
                return {
                    action: pattern.action,
                    targetSystem: pattern.targetSystem,
                    operation: pattern.operation,
                    parameters: params,
                    confidence: this.calculateConfidence(match, params),
                    rawInput: input
                };
            }
        }

        if (logOnMiss) {
            this.logger.warn('[NLActionGate] Could not parse intent:', { input });
        }
        return null;
    }

    /**
     * Parse intent with regex fast-path and optional LLM fallback.
     */
    async parseIntentSmart(input: string): Promise<ParsedIntent | null> {
        const regexIntent = this.parseIntentInternal(input, false);
        if (regexIntent) {
            return regexIntent;
        }
        return this.parseIntentWithLLM(input);
    }

    /**
     * Use an LLM classification prompt when regex patterns cannot parse user input.
     */
    private async parseIntentWithLLM(input: string): Promise<ParsedIntent | null> {
        if (!this.secureAIService) {
            return null;
        }

        try {
            const response = await this.secureAIService.callProvider({
                provider: process.env.NL_ACTION_GATE_INTENT_PROVIDER || process.env.DEFAULT_AI_PROVIDER || 'claude',
                model: process.env.NL_ACTION_GATE_INTENT_MODEL || 'claude-haiku-4-5-20251001',
                temperature: 0.1,
                maxTokens: 400,
                messages: [
                    {
                        role: 'system',
                        content:
                            'Classify user intent for ERP write actions. ' +
                            'Allowed actions: refund, create-purchase-order, send-notification, update-inventory, approve-document, cancel. ' +
                            'Return strict JSON with keys: action, confidence, parameters. ' +
                            'If no match, return {"action":"none","confidence":0}.'
                    },
                    {
                        role: 'user',
                        content:
                            `Input: "${input}"\n` +
                            'Parameter expectations:\n' +
                            '- refund: amount, invoiceId (if present)\n' +
                            '- create-purchase-order: vendorName or vendorId\n' +
                            '- send-notification: recipient, title (optional), message (optional)\n' +
                            '- update-inventory: itemName, quantity, warehouseId(optional)\n' +
                            '- approve-document: approvalId\n' +
                            '- cancel: entityId, reason(optional)'
                    }
                ]
            });

            const parsed = parseJsonFromText(response.content) as {
                action?: string;
                confidence?: number;
                parameters?: Record<string, unknown>;
            };

            const action = String(parsed?.action || '').trim();
            const allowedActions = new Set([
                'refund',
                'create-purchase-order',
                'send-notification',
                'update-inventory',
                'approve-document',
                'cancel'
            ]);

            if (!action || action === 'none' || !allowedActions.has(action)) {
                return null;
            }

            const template = INTENT_PATTERNS.find(p => p.action === action);
            if (!template) {
                return null;
            }

            const parameters = parsed?.parameters && typeof parsed.parameters === 'object'
                ? parsed.parameters
                : {};

            const sanitizedParameters = this.sanitizeLLMParameters(template.action, parameters);

            const normalized: ParsedIntent = {
                action: template.action,
                targetSystem: template.targetSystem,
                operation: template.operation,
                parameters: sanitizedParameters,
                confidence: typeof parsed?.confidence === 'number'
                    ? Math.max(0, Math.min(1, parsed.confidence))
                    : 0.65,
                rawInput: input
            };

            this.logger.info('[NLActionGate] LLM intent parsed', {
                action: normalized.action,
                confidence: normalized.confidence
            });

            return normalized;
        } catch (error) {
            this.logger.warn('[NLActionGate] LLM intent parsing failed', {
                input,
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }

    private sanitizeLLMParameters(action: string, parameters: Record<string, unknown>): Record<string, unknown> {
        if (action === 'create-purchase-order') {
            return this.sanitizeCreatePurchaseOrderParams(parameters);
        }

        const allowed = new Set(ACTION_PARAM_WHITELIST[action] || []);
        const sanitized: Record<string, unknown> = {};

        for (const [key, rawValue] of Object.entries(parameters)) {
            if (!allowed.has(key)) {
                continue;
            }

            let value: unknown = rawValue;
            if ((key === 'amount' || key === 'quantity') && typeof rawValue === 'string') {
                const numericValue = Number(rawValue);
                if (Number.isFinite(numericValue)) {
                    value = numericValue;
                }
            }

            if (key === 'entityType' && typeof value === 'string') {
                value = value.toLowerCase();
            }

            sanitized[key] = value;
        }

        if (action === 'cancel' && !sanitized.entityType) {
            sanitized.entityType = 'subscription';
        }

        return sanitized;
    }

    private sanitizeCreatePurchaseOrderParams(parameters: Record<string, unknown>): Record<string, unknown> {
        const sanitizeString = (value: unknown, maxLength = 200): string | undefined => {
            if (typeof value !== 'string') return undefined;
            const trimmed = value.trim();
            if (trimmed.length === 0) return undefined;
            return trimmed.slice(0, maxLength);
        };

        const sanitizeNumber = (value: unknown): number | undefined => {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string' && value.trim().length > 0) {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) return parsed;
            }
            return undefined;
        };

        const sanitized: Record<string, unknown> = {};
        sanitized.vendorId = sanitizeString(parameters.vendorId);
        sanitized.vendorName = sanitizeString(parameters.vendorName);
        sanitized.buyerCompany = sanitizeString(parameters.buyerCompany);
        sanitized.buyerContact = sanitizeString(parameters.buyerContact);
        sanitized.currency = sanitizeString(parameters.currency, 10);
        sanitized.notes = sanitizeString(parameters.notes, 1000);

        const requestedDeliveryDate = sanitizeNumber(parameters.requestedDeliveryDate);
        if (requestedDeliveryDate !== undefined) {
            sanitized.requestedDeliveryDate = requestedDeliveryDate;
        }

        if (parameters.shippingAddress && typeof parameters.shippingAddress === 'object' && !Array.isArray(parameters.shippingAddress)) {
            const rawAddress = parameters.shippingAddress as Record<string, unknown>;
            const shippingAddress = {
                street1: sanitizeString(rawAddress.street1),
                street2: sanitizeString(rawAddress.street2),
                city: sanitizeString(rawAddress.city),
                state: sanitizeString(rawAddress.state),
                postalCode: sanitizeString(rawAddress.postalCode),
                country: sanitizeString(rawAddress.country),
            };

            if (Object.values(shippingAddress).some(value => value !== undefined)) {
                sanitized.shippingAddress = shippingAddress;
            }
        }

        if (Array.isArray(parameters.lines)) {
            const lines = parameters.lines
                .slice(0, MAX_PO_LINES_FROM_LLM)
                .map((line): Record<string, unknown> | null => {
                    if (!line || typeof line !== 'object') return null;
                    const rawLine = line as Record<string, unknown>;

                    const itemName = sanitizeString(rawLine.itemName);
                    const quantity = sanitizeNumber(rawLine.quantity);
                    const unitPrice = sanitizeNumber(rawLine.unitPrice);
                    if (!itemName || quantity === undefined || unitPrice === undefined || quantity <= 0 || unitPrice < 0) {
                        return null;
                    }

                    const expectedShipDate = sanitizeNumber(rawLine.expectedShipDate);
                    const sanitizedLine: Record<string, unknown> = {
                        itemName,
                        quantity,
                        unitPrice,
                    };

                    const itemId = sanitizeString(rawLine.itemId);
                    const description = sanitizeString(rawLine.description, 500);
                    if (itemId) sanitizedLine.itemId = itemId;
                    if (description) sanitizedLine.description = description;
                    if (expectedShipDate !== undefined) sanitizedLine.expectedShipDate = expectedShipDate;

                    return sanitizedLine;
                })
                .filter((line): line is Record<string, unknown> => line !== null);

            if (lines.length > 0) {
                sanitized.lines = lines;
            }
        }

        // Remove undefined values to avoid passing ambiguous payloads downstream
        return Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined));
    }

    /**
     * Propose an action based on parsed intent
     * Returns a ProposedAction that requires human approval
     */
    proposeAction(intent: ParsedIntent): ProposedAction {
        const id = this.generateActionId();
        const riskLevel = this.assessRiskLevel(intent);

        const proposedAction: ProposedAction = {
            id,
            intent,
            apiCall: this.buildApiCall(intent),
            riskLevel,
            requiresApproval: riskLevel !== 'low' || intent.operation !== 'GET',
            humanReadableDescription: this.generateDescription(intent),
            estimatedImpact: this.estimateImpact(intent),
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + ACTION_EXPIRATION_MS),
            status: 'pending'
        };

        this.pendingActions.set(id, proposedAction);
        this.logger.info('[NLActionGate] Action proposed:', {
            id,
            action: intent.action,
            riskLevel,
            requiresApproval: proposedAction.requiresApproval
        });

        return proposedAction;
    }

    /**
     * Approve a pending action
     */
    approveAction(actionId: string, approverUserId: string): ProposedAction | null {
        const action = this.pendingActions.get(actionId);
        if (!action) {
            this.logger.warn('[NLActionGate] Action not found:', { actionId });
            return null;
        }

        if (action.status !== 'pending') {
            this.logger.warn('[NLActionGate] Action not pending:', { actionId, status: action.status });
            return null;
        }

        if (new Date() > action.expiresAt) {
            action.status = 'expired';
            this.logger.warn('[NLActionGate] Action expired:', { actionId });
            return action;
        }

        action.status = 'approved';
        this.logger.info('[NLActionGate] Action approved:', { actionId, approverUserId });

        return action;
    }

    /**
     * Reject a pending action
     */
    rejectAction(actionId: string, reason?: string): ProposedAction | null {
        const action = this.pendingActions.get(actionId);
        if (!action) return null;

        action.status = 'rejected';
        this.logger.info('[NLActionGate] Action rejected:', { actionId, reason });

        // Clean up rejected action after short delay (allow response to be returned first)
        setTimeout(() => this.pendingActions.delete(actionId), 5000);

        return action;
    }

    /**
     * Validate required parameters before dispatch
     */
    private validateParams(action: string, params: Record<string, unknown>): string | null {
        switch (action) {
            case 'refund':
                if (!params.invoiceId) return 'Missing required parameter: invoiceId';
                if (!params.amount || typeof params.amount !== 'number' || !Number.isFinite(params.amount) || params.amount <= 0) {
                    return 'Missing or invalid parameter: amount (must be positive finite number)';
                }
                return null;
            case 'approve-document':
                if (!params.approvalId && !params.documentId) return 'Missing required parameter: approvalId';
                return null;
            case 'update-inventory':
                if (!params.itemName) return 'Missing required parameter: itemName';
                if (params.quantity === undefined || params.quantity === null) return 'Missing required parameter: quantity';
                if (typeof params.quantity !== 'number' || !Number.isFinite(params.quantity)) return 'Invalid parameter: quantity (must be a finite number)';
                return null;
            case 'send-notification':
                if (!params.recipient) return 'Missing required parameter: recipient';
                return null;
            case 'create-purchase-order':
                if (!params.vendorName && !params.vendorId) return 'Missing required parameter: vendorName or vendorId';
                if (params.requestedDeliveryDate !== undefined &&
                    (typeof params.requestedDeliveryDate !== 'number' || !Number.isFinite(params.requestedDeliveryDate))) {
                    return 'Invalid parameter: requestedDeliveryDate (must be a finite timestamp number)';
                }
                if (params.shippingAddress !== undefined &&
                    (typeof params.shippingAddress !== 'object' || params.shippingAddress === null || Array.isArray(params.shippingAddress))) {
                    return 'Invalid parameter: shippingAddress (must be an object)';
                }
                if (params.lines !== undefined) {
                    if (!Array.isArray(params.lines)) {
                        return 'Invalid parameter: lines (must be an array)';
                    }
                    if (params.lines.length > MAX_PO_LINES_FROM_LLM) {
                        return `Invalid parameter: lines (maximum ${MAX_PO_LINES_FROM_LLM} lines)`;
                    }
                    for (const line of params.lines) {
                        if (!line || typeof line !== 'object') {
                            return 'Invalid parameter: each line must be an object';
                        }
                        const rawLine = line as Record<string, unknown>;
                        if (typeof rawLine.itemName !== 'string' || rawLine.itemName.trim().length === 0) {
                            return 'Invalid parameter: each line.itemName is required';
                        }
                        if (typeof rawLine.quantity !== 'number' || !Number.isFinite(rawLine.quantity) || rawLine.quantity <= 0) {
                            return 'Invalid parameter: each line.quantity must be a positive finite number';
                        }
                        if (typeof rawLine.unitPrice !== 'number' || !Number.isFinite(rawLine.unitPrice) || rawLine.unitPrice < 0) {
                            return 'Invalid parameter: each line.unitPrice must be a finite number >= 0';
                        }
                        if (rawLine.expectedShipDate !== undefined &&
                            (typeof rawLine.expectedShipDate !== 'number' || !Number.isFinite(rawLine.expectedShipDate))) {
                            return 'Invalid parameter: each line.expectedShipDate must be a finite timestamp number';
                        }
                    }
                }
                return null;
            case 'cancel':
                if (!params.entityId) return 'Missing required parameter: entityId';
                if (params.entityType && String(params.entityType).toLowerCase() !== 'subscription') {
                    return 'Cancel currently supports subscriptions only';
                }
                return null;
            default:
                return null;
        }
    }

    /**
     * Look up a product by name/SKU for inventory operations
     */
    private async resolveProductId(itemName: string): Promise<string> {
        if (!this.inventoryService) {
            throw new Error('InventoryCentralService not available');
        }
        const products = await this.inventoryService.getProducts({ search: itemName });
        if (products.length === 0) {
            throw new Error(`No product found matching '${itemName}'`);
        }
        // Prefer exact name match
        const exactMatch = products.find(p => p.name.toLowerCase() === itemName.toLowerCase());
        if (exactMatch) return exactMatch.id;
        if (products.length === 1) return products[0].id;
        throw new Error(`Ambiguous product match for '${itemName}': found ${products.length} products`);
    }

    /**
     * Dispatch action to the appropriate backend service.
     *
     * `ctx` carries the request-scoped identity (tenantId + userId) from the
     * route layer via `extractIdentityContext(req)`. Two branches currently
     * thread the identity through: `refund` uses `ctx.userId` for the
     * createCreditMemo audit attribution, and `approve-document` uses both
     * `ctx.tenantId` (operator service requires it) and `ctx.userId` (the
     * approverId stamp). Other branches (`update-inventory`,
     * `send-notification`, `create-purchase-order`, `cancel`) still use
     * inline service-specific attribution and do not consume `ctx` — those
     * are out of scope for PR 6 (Codex R1 BLOCKS-MERGE BM-3 was scoped to
     * the FC approve path). Pre-PR-2C-Auth `extractIdentityContext` returns
     * `SYSTEM_IDENTITY` so behavior is identical until verified auth is
     * mounted; post-auth, real tenant/user values flow through.
     */
    private async dispatchAction(action: ProposedAction, ctx?: IdentityContext): Promise<{ status: string; result?: unknown }> {
        const { intent } = action;
        const params = intent.parameters;
        const identity: IdentityContext = ctx ?? SYSTEM_IDENTITY;

        switch (intent.action) {
            case 'refund': {
                if (!this.paymentService) throw new Error('PaymentCentralService not available');
                const creditMemo = await this.paymentService.createCreditMemo(
                    identity.tenantId,
                    params.invoiceId as string,
                    params.amount as number,
                    params.reason as string || 'NL Action Gate refund',
                    identity.userId
                );
                return { status: 'executed', result: creditMemo };
            }
            case 'approve-document': {
                if (!this.financeOperatorService) throw new Error('FinanceCentralOperatorService not available');
                const approvalId = (params.approvalId || params.documentId) as string;
                const approval = await this.financeOperatorService.approveItem({
                    tenantId: identity.tenantId,
                    approvalId,
                    approverId: identity.userId,
                    comments: params.comments as string | undefined,
                });
                if (approval.ok === false) {
                    throw new Error(approval.message || `Approval failed: ${approval.code}`);
                }
                return { status: 'executed', result: approval };
            }
            case 'update-inventory': {
                if (!this.inventoryService) throw new Error('InventoryCentralService not available');
                const productId = await this.resolveProductId(params.itemName as string);
                // Resolve target warehouse — use explicit param or default to first active warehouse
                let warehouseId = params.warehouseId as string | undefined;
                if (!warehouseId) {
                    const warehouses = await this.inventoryService.getWarehouses({ status: 'active' });
                    if (warehouses.length === 0) throw new Error('No active warehouses available');
                    warehouseId = warehouses[0].id;
                }
                // "Update inventory to X" means set absolute level, not add X.
                // Compute delta from current stock so recordMovement adjusts correctly.
                const targetQuantity = params.quantity as number;
                const currentStock = await this.inventoryService.getStockLevel(productId, warehouseId);
                const currentOnHand = currentStock?.quantityOnHand ?? 0;
                const delta = targetQuantity - currentOnHand;
                if (delta === 0) {
                    return { status: 'executed', result: { message: `Stock already at ${targetQuantity}`, noChange: true } };
                }
                const movement = await this.inventoryService.recordMovement(
                    'adjustment',
                    productId,
                    Math.abs(delta),
                    {
                        // Positive delta → stock in (toWarehouse), negative → stock out (fromWarehouse)
                        ...(delta > 0 ? { toWarehouseId: warehouseId } : { fromWarehouseId: warehouseId }),
                        performedBy: 'nl-action-gate',
                        reason: `NL Action Gate: set stock to ${targetQuantity} (delta ${delta > 0 ? '+' : ''}${delta})`
                    }
                );
                if (!movement.success) {
                    throw new Error(movement.message || 'Inventory movement failed');
                }
                return { status: 'executed', result: movement };
            }
            case 'send-notification': {
                if (!this.portalService) throw new Error('PortalCentralService not available');
                const notification = await this.portalService.createNotification({
                    userId: params.recipient as string,
                    type: 'info',
                    title: params.title as string || 'Notification from NL Action Gate',
                    message: params.message as string || `Notification sent to ${params.recipient}`
                });
                return { status: 'executed', result: notification };
            }
            case 'create-purchase-order': {
                if (!this.supplierService) throw new Error('SupplierCentralService not available');
                const po = await this.supplierService.createPurchaseOrder(identity.tenantId, {
                    vendorId: params.vendorId as string | undefined,
                    vendorName: params.vendorName as string | undefined,
                    notes: params.notes as string | undefined,
                    requestedDeliveryDate: typeof params.requestedDeliveryDate === 'number'
                        ? params.requestedDeliveryDate
                        : undefined,
                    createdBy: 'nl-action-gate',
                });
                return { status: 'executed', result: po };
            }
            case 'cancel': {
                if (!this.syncService) throw new Error('SyncCentralService not available');
                const entityType = String(params.entityType || 'subscription').toLowerCase();
                if (entityType !== 'subscription') {
                    throw new Error(`Cancel action does not support entity type '${entityType}'`);
                }
                const cancelled = await this.syncService.cancelSubscription(
                    identity.tenantId,
                    params.entityId as string,
                    params.reason as string | undefined,
                    'nl-action-gate'
                );
                return { status: 'executed', result: cancelled };
            }
            default:
                return { status: 'not_implemented' };
        }
    }

    /**
     * Execute an approved action.
     *
     * `ctx` is the request-scoped identity from `extractIdentityContext(req)`
     * — passed through to dispatch so backend operator services see the real
     * caller instead of a hardcoded `SYSTEM_IDENTITY` (Codex R1 BLOCKS-MERGE
     * BM-3). Optional for backward compat; absent → SYSTEM_IDENTITY fallback.
     */
    async executeAction(actionId: string, ctx?: IdentityContext): Promise<ActionResult> {
        const action = this.pendingActions.get(actionId);
        if (!action) {
            return { success: false, error: 'Action not found', errorCode: 'not_found' };
        }

        if (action.status !== 'approved') {
            return { success: false, proposedAction: action, error: `Action is ${action.status}, not approved`, errorCode: 'not_approved' };
        }

        // Validate required parameters before dispatch
        const validationError = this.validateParams(action.intent.action, action.intent.parameters);
        if (validationError) {
            return { success: false, proposedAction: action, error: validationError, errorCode: 'validation_error' };
        }

        try {
            this.logger.info('[NLActionGate] Executing action:', {
                id: actionId,
                action: action.intent.action,
                apiCall: action.apiCall
            });

            const dispatchResult = await this.dispatchAction(action, ctx);

            if (dispatchResult.status === 'not_implemented') {
                return {
                    success: false,
                    proposedAction: action,
                    error: `Action '${action.intent.action}' is not yet implemented`,
                    errorCode: 'not_implemented'
                };
            }

            action.status = 'executed';

            // Clean up executed action after short delay
            setTimeout(() => this.pendingActions.delete(actionId), 5000);

            return {
                success: true,
                proposedAction: action,
                executionResult: dispatchResult.result,
                executedAt: new Date()
            };
        } catch (error) {
            this.logger.error('[NLActionGate] Execution failed:', { actionId, error });
            return {
                success: false,
                proposedAction: action,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorCode: 'dispatch_error'
            };
        }
    }

    /**
     * Get pending actions for a user to review
     */
    getPendingActions(): ProposedAction[] {
        const now = new Date();
        const pending: ProposedAction[] = [];

        for (const [, action] of this.pendingActions) {
            if (action.status === 'pending') {
                if (now > action.expiresAt) {
                    action.status = 'expired';
                } else {
                    pending.push(action);
                }
            }
        }

        return pending;
    }

    /**
     * Calculate confidence score for parsed intent
     */
    private calculateConfidence(match: RegExpMatchArray, params: Record<string, unknown>): number {
        let confidence = 0.7; // Base confidence

        // Higher confidence if all parameters were extracted
        const paramValues = Object.values(params).filter(v => v !== undefined);
        if (paramValues.length > 0) {
            confidence += 0.1 * Math.min(paramValues.length, 3);
        }

        // Higher confidence for longer, more specific matches
        if (match[0].length > 20) {
            confidence += 0.1;
        }

        return Math.min(confidence, 1.0);
    }

    /**
     * Assess risk level of an action
     */
    private assessRiskLevel(intent: ParsedIntent): ProposedAction['riskLevel'] {
        if (intent.action === 'cancel') {
            return 'critical';
        }

        // DELETE operations are always high risk
        if (intent.operation === 'DELETE') {
            return 'critical';
        }

        // Financial operations are high risk
        if (intent.targetSystem === 'payment' || intent.targetSystem === 'finance') {
            return 'high';
        }

        // POST/PUT to critical systems
        if (intent.operation === 'POST' || intent.operation === 'PUT') {
            if (['supplier', 'inventory'].includes(intent.targetSystem)) {
                return 'medium';
            }
        }

        return 'low';
    }

    /**
     * Build API call from intent
     */
    private buildApiCall(intent: ParsedIntent): ProposedAction['apiCall'] {
        const actionEndpoints: Record<string, { method: ProposedAction['apiCall']['method']; endpoint: string }> = {
            'refund': { method: 'POST', endpoint: '/api/payment-central/credit-memos' },
            'approve-document': { method: 'POST', endpoint: `/api/finance-central/approvals/${intent.parameters.approvalId || intent.parameters.documentId || ':id'}/approve` },
            'update-inventory': { method: 'POST', endpoint: '/api/inventory-central/movements' },
            'send-notification': { method: 'POST', endpoint: '/api/portal-central/notifications' },
            'create-purchase-order': { method: 'POST', endpoint: '/api/supplier-central/purchase-orders' },
            'cancel': { method: 'POST', endpoint: `/api/sync-central/subscriptions/${intent.parameters.entityId || ':id'}/cancel` },
        };

        const mapping = actionEndpoints[intent.action];
        if (mapping) {
            return {
                method: mapping.method,
                endpoint: mapping.endpoint,
                body: intent.operation !== 'GET' ? intent.parameters : undefined
            };
        }

        return {
            method: intent.operation as ProposedAction['apiCall']['method'],
            endpoint: `/api/generic/${intent.action}`,
            body: intent.operation !== 'GET' ? intent.parameters : undefined
        };
    }

    /**
     * Generate human-readable description
     */
    private generateDescription(intent: ParsedIntent): string {
        const descriptions: Record<string, (p: Record<string, unknown>) => string> = {
            'refund': (p) => `Refund ${p.amount ? `$${p.amount}` : 'amount'} to customer`,
            'create-purchase-order': (p) => `Create purchase order for ${p.vendorName || 'vendor'}`,
            'send-notification': (p) => `Send notification to ${p.recipient || 'recipient'}`,
            'update-inventory': (p) => `Update stock for ${p.itemName || 'item'} to ${p.quantity || '?'} units`,
            'approve-document': (p) => `Approve document ${p.documentId || '#'}`,
            'cancel': (p) => `Cancel subscription ${p.entityId || '#'}`
        };

        const generator = descriptions[intent.action];
        return generator ? generator(intent.parameters) : `Execute ${intent.action}`;
    }

    /**
     * Estimate impact of action
     */
    private estimateImpact(intent: ParsedIntent): string {
        const impacts: Record<string, string> = {
            'refund': 'Financial: Will deduct from account balance',
            'create-purchase-order': 'Creates commitment with vendor',
            'update-inventory': 'Updates stock levels across all channels',
            'approve-document': 'Document will be marked as approved',
            'cancel': 'Cancels subscription and disables automatic renewal'
        };

        return impacts[intent.action] || 'Standard operation';
    }

    /**
     * Generate unique action ID using cryptographically secure random
     */
    private generateActionId(): string {
        return `nla-${randomUUID()}`;
    }
}
