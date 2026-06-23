/**
 * Unit tests for NLActionGateService
 * PR C: Wire NL Action Gate to Real Backend Execution
 */

import { NLActionGateService, ParsedIntent } from '../../../../src/services/ai/NLActionGateService';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

// Mock logger
const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
} as any;

// Mock services
function createMockPaymentService() {
    return {
        createCreditMemo: jest.fn().mockResolvedValue({
            id: 'CM-001',
            invoiceId: 'INV-123',
            amount: 50,
            reason: 'NL Action Gate refund',
            createdBy: 'nl-action-gate',
            status: 'pending'
        }),
    } as any;
}

function createMockFinanceService() {
    return {
        approveItem: jest.fn().mockResolvedValue({
            success: true,
            message: 'Item approved successfully'
        }),
    } as any;
}

function createMockFinanceOperatorService() {
    return {
        approveItem: jest.fn().mockResolvedValue({
            ok: true,
            code: 'ok',
            appliedRecordId: 'NS-APR-001',
        }),
    } as any;
}

function createMockInventoryService() {
    return {
        getProducts: jest.fn().mockResolvedValue([
            { id: 'PROD-001', name: 'Widget A', sku: 'WA-100', status: 'active' }
        ]),
        getWarehouses: jest.fn().mockResolvedValue([
            { id: 'WH-001', name: 'Main Warehouse', status: 'active', type: 'primary' }
        ]),
        getStockLevel: jest.fn().mockResolvedValue({ quantityOnHand: 40, quantityAvailable: 40 }),
        recordMovement: jest.fn().mockResolvedValue({
            success: true,
            message: 'Movement recorded',
            movement: { id: 'MOV-001', type: 'adjustment', productId: 'PROD-001', quantity: 60 }
        }),
    } as any;
}

function createMockPortalService() {
    return {
        createNotification: jest.fn().mockResolvedValue({
            id: 'NOTIF-001',
            userId: 'user-123',
            type: 'info',
            title: 'Notification from NL Action Gate',
            message: 'Notification sent to user-123',
            read: false,
            createdAt: new Date().toISOString()
        }),
    } as any;
}

function createMockSupplierService() {
    return {
        createPurchaseOrder: jest.fn().mockResolvedValue({
            id: 'po_123',
            poNumber: 'PO-00123456',
            vendorId: 'vendor_1',
            status: 'pending_acknowledgement',
            total: 108,
        }),
    } as any;
}

function createMockSyncService() {
    return {
        cancelSubscription: jest.fn().mockResolvedValue({
            id: 'SUB-999',
            status: 'cancelled',
            customerId: 'cust_1',
            tierId: 'tier_pro',
        }),
    } as any;
}

function createMockSecureAIService() {
    return {
        callProvider: jest.fn().mockResolvedValue({
            content: JSON.stringify({
                action: 'refund',
                confidence: 0.88,
                parameters: { amount: 50, invoiceId: 'INV-LLM-001' }
            }),
            provider: 'claude',
            model: 'claude-3-5-haiku-20241022'
        })
    } as any;
}

describe('NLActionGateService', () => {
    let service: NLActionGateService;
    let mockPayment: ReturnType<typeof createMockPaymentService>;
    let mockFinance: ReturnType<typeof createMockFinanceService>;
    let mockFinanceOperator: ReturnType<typeof createMockFinanceOperatorService>;
    let mockInventory: ReturnType<typeof createMockInventoryService>;
    let mockPortal: ReturnType<typeof createMockPortalService>;
    let mockSupplier: ReturnType<typeof createMockSupplierService>;
    let mockSync: ReturnType<typeof createMockSyncService>;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        mockPayment = createMockPaymentService();
        mockFinance = createMockFinanceService();
        mockFinanceOperator = createMockFinanceOperatorService();
        mockInventory = createMockInventoryService();
        mockPortal = createMockPortalService();
        mockSupplier = createMockSupplierService();
        mockSync = createMockSyncService();
        service = new NLActionGateService(
            mockLogger,
            mockPayment,
            mockFinance,
            mockInventory,
            mockPortal,
            mockSupplier,
            mockSync,
            undefined,
            mockFinanceOperator,
        );
    });

    afterEach(() => {
        service.stopPeriodicCleanup();
        jest.useRealTimers();
    });

    // ==================== parseIntent ====================

    describe('parseIntent', () => {
        it('should parse a refund intent with amount', () => {
            const result = service.parseIntent('Refund this customer for $50.00');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('refund');
            expect(result!.targetSystem).toBe('payment');
            expect(result!.parameters.amount).toBe(50);
        });

        it('should parse a refund intent with invoice ID preserving case', () => {
            const result = service.parseIntent('Refund customer $75 on invoice INV-2024-001');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('refund');
            expect(result!.parameters.amount).toBe(75);
            expect(result!.parameters.invoiceId).toBe('INV-2024-001');
        });

        it('should parse a refund intent with underscore-format invoice ID', () => {
            const result = service.parseIntent('Refund customer $100 for invoice inv_1738900000_abc123');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('refund');
            expect(result!.parameters.amount).toBe(100);
            expect(result!.parameters.invoiceId).toBe('inv_1738900000_abc123');
        });

        it('should parse a refund intent without invoice (backward compat)', () => {
            const result = service.parseIntent('Refund customer for $50');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('refund');
            expect(result!.parameters.amount).toBe(50);
            expect(result!.parameters.invoiceId).toBeUndefined();
        });

        it('should parse create-purchase-order intent', () => {
            const result = service.parseIntent('Create purchase order for Acme Corp');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('create-purchase-order');
            expect(result!.parameters.vendorName).toBe('Acme Corp');
        });

        it('should parse send-notification intent', () => {
            const result = service.parseIntent('Send a reminder to John Smith');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('send-notification');
            expect(result!.parameters.recipient).toBe('John Smith');
        });

        it('should parse update-inventory intent', () => {
            const result = service.parseIntent('Update inventory for Widget A to 100');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('update-inventory');
            expect(result!.parameters.itemName).toBe('Widget A');
            expect(result!.parameters.quantity).toBe(100);
        });

        it('should parse approve-document intent with hyphenated ID', () => {
            const result = service.parseIntent('Approve the invoice appr-001');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('approve-document');
            expect(result!.parameters.approvalId).toBe('appr-001');
            expect(result!.parameters.documentId).toBe('appr-001');
        });

        it('should parse cancel intent with hyphenated ID', () => {
            const result = service.parseIntent('Cancel the subscription SUB-123');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('cancel');
            expect(result!.parameters.entityId).toBe('SUB-123');
        });

        it('should not parse non-subscription cancel intents', () => {
            const result = service.parseIntent('Cancel the order ORD-123');
            expect(result).toBeNull();
        });

        it('should return null for unrecognized input', () => {
            const result = service.parseIntent('xyzzy completely random gibberish');
            expect(result).toBeNull();
        });

        it('should use LLM fallback for conversational input that regex cannot parse', async () => {
            const mockSecureAI = createMockSecureAIService();
            const llmService = new NLActionGateService(
                mockLogger,
                mockPayment,
                mockFinance,
                mockInventory,
                mockPortal,
                mockSupplier,
                mockSync,
                mockSecureAI
            );

            const result = await llmService.parseIntentSmart('Please reimburse invoice INV-LLM-001 for this overcharge.');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('refund');
            expect(result!.parameters.invoiceId).toBe('INV-LLM-001');
            expect(mockSecureAI.callProvider).toHaveBeenCalled();

            llmService.stopPeriodicCleanup();
        });

        it('should sanitize nested create-purchase-order parameters from LLM output', async () => {
            const mockSecureAI = {
                callProvider: jest.fn().mockResolvedValue({
                    content: JSON.stringify({
                        action: 'create-purchase-order',
                        confidence: 0.9,
                        parameters: {
                            vendorName: ' Acme Corp ',
                            requestedDeliveryDate: '1738900000',
                            shippingAddress: {
                                street1: '123 Main',
                                city: 'Austin',
                                country: 'USA',
                                ignored: 'drop-this'
                            },
                            lines: [
                                { itemName: 'Widget A', quantity: '2', unitPrice: '10.5', extra: 'drop-this' },
                                { itemName: '', quantity: 1, unitPrice: 1 }, // invalid, should be dropped
                                { itemName: 'Widget B', quantity: 0, unitPrice: 5 } // invalid, should be dropped
                            ],
                            arbitraryKey: 'drop-this'
                        }
                    }),
                    provider: 'claude',
                    model: 'claude-3-5-haiku-20241022'
                })
            } as any;

            const llmService = new NLActionGateService(
                mockLogger,
                mockPayment,
                mockFinance,
                mockInventory,
                mockPortal,
                mockSupplier,
                mockSync,
                mockSecureAI
            );

            const result = await llmService.parseIntentSmart('Could you place a PO with Acme for tomorrow?');
            expect(result).not.toBeNull();
            expect(result!.action).toBe('create-purchase-order');
            expect(result!.parameters.vendorName).toBe('Acme Corp');
            expect(result!.parameters.requestedDeliveryDate).toBe(1738900000);
            expect((result!.parameters.shippingAddress as Record<string, unknown>).ignored).toBeUndefined();
            expect(result!.parameters.arbitraryKey).toBeUndefined();
            expect(Array.isArray(result!.parameters.lines)).toBe(true);
            expect((result!.parameters.lines as unknown[])).toHaveLength(1);

            llmService.stopPeriodicCleanup();
        });
    });

    // ==================== proposeAction ====================

    describe('proposeAction', () => {
        it('should create a proposed action with correct risk level for refund', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);

            expect(proposed.id).toMatch(/^nla-/);
            expect(proposed.riskLevel).toBe('high');
            expect(proposed.requiresApproval).toBe(true);
            expect(proposed.status).toBe('pending');
        });

        it('should assign medium risk for inventory updates', () => {
            const intent = service.parseIntent('Update inventory for Widget A to 100')!;
            const proposed = service.proposeAction(intent);
            expect(proposed.riskLevel).toBe('medium');
        });

        it('should assign critical risk for cancel/delete operations', () => {
            const intent = service.parseIntent('Cancel the subscription SUB-123')!;
            const proposed = service.proposeAction(intent);
            expect(proposed.riskLevel).toBe('critical');
        });

        it('should generate human-readable description', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);
            expect(proposed.humanReadableDescription).toContain('Refund');
            expect(proposed.humanReadableDescription).toContain('$50');
        });

        it('should set an expiration time', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);
            expect(proposed.expiresAt.getTime()).toBeGreaterThan(proposed.createdAt.getTime());
        });
    });

    // ==================== buildApiCall ====================

    describe('buildApiCall (via proposeAction)', () => {
        it('should map refund to /api/payment-central/credit-memos', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);
            expect(proposed.apiCall.method).toBe('POST');
            expect(proposed.apiCall.endpoint).toBe('/api/payment-central/credit-memos');
        });

        it('should map approve-document to /api/finance-central/approvals/:id/approve', () => {
            const intent = service.parseIntent('Approve the invoice appr-001')!;
            const proposed = service.proposeAction(intent);
            expect(proposed.apiCall.method).toBe('POST');
            expect(proposed.apiCall.endpoint).toBe('/api/finance-central/approvals/appr-001/approve');
        });

        it('should map update-inventory to /api/inventory-central/movements', () => {
            const intent = service.parseIntent('Update inventory for Widget A to 50')!;
            const proposed = service.proposeAction(intent);
            expect(proposed.apiCall.method).toBe('POST');
            expect(proposed.apiCall.endpoint).toBe('/api/inventory-central/movements');
        });

        it('should map send-notification to /api/portal-central/notifications', () => {
            const intent = service.parseIntent('Send notification to user-1')!;
            const proposed = service.proposeAction(intent);
            expect(proposed.apiCall.method).toBe('POST');
            expect(proposed.apiCall.endpoint).toBe('/api/portal-central/notifications');
        });
    });

    // ==================== approveAction / rejectAction ====================

    describe('approveAction', () => {
        it('should approve a pending action', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);

            const approved = service.approveAction(proposed.id, 'user-1');
            expect(approved).not.toBeNull();
            expect(approved!.status).toBe('approved');
        });

        it('should return null for unknown action ID', () => {
            const result = service.approveAction('nla-nonexistent', 'user-1');
            expect(result).toBeNull();
        });

        it('should return null for already-approved action', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);
            service.approveAction(proposed.id, 'user-1');

            const second = service.approveAction(proposed.id, 'user-1');
            expect(second).toBeNull();
        });

        it('should mark expired action as expired', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);

            // Fast-forward past expiration
            jest.advanceTimersByTime(6 * 60 * 1000);

            const result = service.approveAction(proposed.id, 'user-1');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('expired');
        });
    });

    describe('rejectAction', () => {
        it('should reject a pending action', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);

            const rejected = service.rejectAction(proposed.id, 'Changed my mind');
            expect(rejected).not.toBeNull();
            expect(rejected!.status).toBe('rejected');
        });
    });

    // ==================== executeAction ====================

    describe('executeAction', () => {
        function proposeAndApprove(input: string, paramOverrides?: Record<string, unknown>) {
            const intent = service.parseIntent(input)!;
            if (paramOverrides) {
                Object.assign(intent.parameters, paramOverrides);
            }
            const proposed = service.proposeAction(intent);
            service.approveAction(proposed.id, 'test-user');
            return proposed;
        }

        it('should return error for non-existent action', async () => {
            const result = await service.executeAction('nla-does-not-exist');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Action not found');
        });

        it('should return error for non-approved action', async () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            const proposed = service.proposeAction(intent);

            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not approved');
        });

        // --- Validation tests ---

        it('should fail validation when refund missing invoiceId', async () => {
            const proposed = proposeAndApprove('Refund customer for $50');
            // amount is set but invoiceId is not
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('invoiceId');
        });

        it('should fail validation when refund missing amount', async () => {
            const proposed = proposeAndApprove('Refund customer', { invoiceId: 'INV-123' });
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('amount');
        });

        it('should fail validation when refund amount is not finite', async () => {
            const proposed = proposeAndApprove('Refund customer', { invoiceId: 'INV-123', amount: Number.POSITIVE_INFINITY });
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('finite');
        });

        it('should fail validation for approve-document without approvalId', async () => {
            const intent: ParsedIntent = {
                action: 'approve-document',
                targetSystem: 'finance',
                operation: 'POST',
                parameters: {},
                confidence: 0.8,
                rawInput: 'approve the document'
            };
            const proposed = service.proposeAction(intent);
            service.approveAction(proposed.id, 'user-1');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('approvalId');
            expect(result.errorCode).toBe('validation_error');
        });

        it('should fail validation for update-inventory without itemName', async () => {
            const intent: ParsedIntent = {
                action: 'update-inventory',
                targetSystem: 'inventory',
                operation: 'PUT',
                parameters: { quantity: 10 },
                confidence: 0.8,
                rawInput: 'update inventory'
            };
            const proposed = service.proposeAction(intent);
            service.approveAction(proposed.id, 'user-1');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('itemName');
        });

        it('should fail validation for update-inventory with NaN quantity', async () => {
            const intent: ParsedIntent = {
                action: 'update-inventory',
                targetSystem: 'inventory',
                operation: 'PUT',
                parameters: { itemName: 'Widget', quantity: NaN },
                confidence: 0.8,
                rawInput: 'update inventory'
            };
            const proposed = service.proposeAction(intent);
            service.approveAction(proposed.id, 'user-1');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('finite number');
        });

        it('should fail validation for send-notification without recipient', async () => {
            const intent: ParsedIntent = {
                action: 'send-notification',
                targetSystem: 'communication',
                operation: 'POST',
                parameters: {},
                confidence: 0.8,
                rawInput: 'send notification'
            };
            const proposed = service.proposeAction(intent);
            service.approveAction(proposed.id, 'user-1');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('recipient');
        });

        it('should fail validation for create-purchase-order with invalid requestedDeliveryDate', async () => {
            const proposed = proposeAndApprove('Create purchase order for Acme Corp', {
                requestedDeliveryDate: Number.NaN
            });
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('requestedDeliveryDate');
        });

        it('should fail validation for create-purchase-order with invalid lines', async () => {
            const proposed = proposeAndApprove('Create purchase order for Acme Corp', {
                lines: [{ itemName: 'Widget', quantity: Number.NaN, unitPrice: 10 }]
            });
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('line.quantity');
        });

        // --- Dispatch tests ---

        it('should dispatch refund to PaymentCentralService.createCreditMemo using ctx.userId', async () => {
            const proposed = proposeAndApprove('Refund customer $75 on invoice INV-2024-001', { invoiceId: 'INV-2024-001' });
            // PR 6 R2 (Codex BM-3): identity flows from route via ctx, replacing
            // the prior hardcoded 'nl-action-gate'. Pre-PR-2C-Auth routes pass
            // SYSTEM_IDENTITY so the default-no-ctx path falls back identically.
            const result = await service.executeAction(proposed.id, { tenantId: 'tnt_T', userId: 'user_t' });
            expect(result.success).toBe(true);
            expect(result.executedAt).toBeDefined();
            expect(mockPayment.createCreditMemo).toHaveBeenCalledWith(
                'tnt_T',
                'INV-2024-001',
                75,
                'NL Action Gate refund',
                'user_t'
            );
        });

        it('should dispatch approve-document to FinanceCentralOperatorService.approveItem with ctx.tenantId + ctx.userId', async () => {
            const proposed = proposeAndApprove('Approve the invoice appr-001');
            const result = await service.executeAction(proposed.id, { tenantId: 'tnt_T', userId: 'user_t' });
            expect(result.success).toBe(true);
            expect(mockFinanceOperator.approveItem).toHaveBeenCalledWith(
                expect.objectContaining({
                    approvalId: 'appr-001',
                    approverId: 'user_t',
                    comments: undefined,
                    tenantId: 'tnt_T',
                })
            );
        });

        it('executeAction falls back to SYSTEM_IDENTITY when no ctx is passed (backward compat)', async () => {
            const proposed = proposeAndApprove('Approve the invoice appr-002');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(mockFinanceOperator.approveItem).toHaveBeenCalledWith(
                expect.objectContaining({
                    approvalId: 'appr-002',
                    approverId: SYSTEM_IDENTITY.userId,
                    tenantId: SYSTEM_IDENTITY.tenantId,
                })
            );
        });

        it('should dispatch update-inventory computing delta from current stock', async () => {
            // Mock: current stock is 40, target is 100 → delta = +60
            const proposed = proposeAndApprove('Update inventory for Widget A to 100');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(mockInventory.getStockLevel).toHaveBeenCalledWith('PROD-001', 'WH-001');
            expect(mockInventory.recordMovement).toHaveBeenCalledWith(
                'adjustment',
                'PROD-001',
                60, // delta: 100 - 40
                expect.objectContaining({ performedBy: 'nl-action-gate', toWarehouseId: 'WH-001' })
            );
        });

        it('should use fromWarehouseId when reducing stock', async () => {
            // Mock: current stock is 40, target is 10 → delta = -30
            mockInventory.getStockLevel.mockResolvedValueOnce({ quantityOnHand: 40 });
            const proposed = proposeAndApprove('Update inventory for Widget A to 10');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(mockInventory.recordMovement).toHaveBeenCalledWith(
                'adjustment',
                'PROD-001',
                30, // |delta|: |10 - 40|
                expect.objectContaining({ fromWarehouseId: 'WH-001' })
            );
        });

        it('should return no-change when stock already at target', async () => {
            mockInventory.getStockLevel.mockResolvedValueOnce({ quantityOnHand: 100 });
            const proposed = proposeAndApprove('Update inventory for Widget A to 100');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(mockInventory.recordMovement).not.toHaveBeenCalled();
        });

        it('should dispatch send-notification to PortalCentralService.createNotification', async () => {
            const proposed = proposeAndApprove('Send a notification to user-123');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(mockPortal.createNotification).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-123',
                    type: 'info',
                    title: expect.any(String),
                    message: expect.any(String)
                })
            );
        });

        it('should dispatch cancel action to SyncCentralService.cancelSubscription', async () => {
            const proposed = proposeAndApprove('Cancel the subscription SUB-999');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(mockSync.cancelSubscription).toHaveBeenCalledWith(
                '__system__', // identity.tenantId (SYSTEM_IDENTITY when no ctx)
                'SUB-999',
                undefined,
                'nl-action-gate'
            );
        });

        it('should reject cancel actions for unsupported entity types', async () => {
            const proposed = proposeAndApprove('Cancel the subscription SUB-999', { entityType: 'order' });
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.errorCode).toBe('validation_error');
            expect(result.error).toContain('subscriptions only');
            expect(mockSync.cancelSubscription).not.toHaveBeenCalled();
        });

        it('should dispatch create-purchase-order to SupplierCentralService.createPurchaseOrder', async () => {
            const proposed = proposeAndApprove('Create purchase order for Acme Corp');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(mockSupplier.createPurchaseOrder).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    vendorName: 'Acme Corp',
                    createdBy: 'nl-action-gate',
                })
            );
        });

        // --- Error handling ---

        it('should fail when finance approval returns ok:false', async () => {
            mockFinanceOperator.approveItem.mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'Approval not found' });
            const proposed = proposeAndApprove('Approve the invoice #DOC999');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toBe('Approval not found');
        });

        it('should fail when no active warehouses for inventory update', async () => {
            mockInventory.getWarehouses.mockResolvedValueOnce([]);
            const proposed = proposeAndApprove('Update inventory for Widget A to 50');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('No active warehouses');
        });

        it('should handle service error during dispatch', async () => {
            mockPayment.createCreditMemo.mockRejectedValueOnce(new Error('Payment gateway unavailable'));
            const proposed = proposeAndApprove('Refund customer $50 on invoice INV-001', { invoiceId: 'INV-001' });
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toBe('Payment gateway unavailable');
            expect(result.errorCode).toBe('dispatch_error');
        });

        it('should handle missing service gracefully', async () => {
            const noServices = new NLActionGateService(mockLogger);
            const intent = noServices.parseIntent('Refund customer $50 on invoice INV-001')!;
            intent.parameters.invoiceId = 'INV-001';
            const proposed = noServices.proposeAction(intent);
            noServices.approveAction(proposed.id, 'user-1');
            const result = await noServices.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('PaymentCentralService not available');
            expect(result.errorCode).toBe('dispatch_error');
            noServices.stopPeriodicCleanup();
        });

        it('should set status to executed on success', async () => {
            const proposed = proposeAndApprove('Approve the invoice #DOC789');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(result.proposedAction!.status).toBe('executed');
        });

        // --- Product lookup edge cases ---

        it('should fail when product not found for inventory update', async () => {
            mockInventory.getProducts.mockResolvedValueOnce([]);
            const proposed = proposeAndApprove('Update inventory for NonExistentWidget to 50');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('No product found');
        });

        it('should fail on ambiguous product match', async () => {
            mockInventory.getProducts.mockResolvedValueOnce([
                { id: 'PROD-001', name: 'Widget Alpha', sku: 'WA-1' },
                { id: 'PROD-002', name: 'Widget Bravo', sku: 'WB-1' }
            ]);
            const proposed = proposeAndApprove('Update inventory for Widget to 50', { itemName: 'Widget' });
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Ambiguous product match');
        });

        it('should resolve exact name match when multiple products returned', async () => {
            mockInventory.getProducts.mockResolvedValueOnce([
                { id: 'PROD-001', name: 'Widget A', sku: 'WA-1' },
                { id: 'PROD-002', name: 'Widget AB', sku: 'WAB-1' }
            ]);
            // current stock = 40 (default mock), target = 75 → delta = +35
            const proposed = proposeAndApprove('Update inventory for Widget A to 75');
            const result = await service.executeAction(proposed.id);
            expect(result.success).toBe(true);
            expect(mockInventory.recordMovement).toHaveBeenCalledWith(
                'adjustment',
                'PROD-001',
                35, // delta: 75 - 40
                expect.objectContaining({ toWarehouseId: 'WH-001' })
            );
        });
    });

    // ==================== getPendingActions + memory ====================

    describe('getPendingActions', () => {
        it('should return only pending actions', () => {
            const intent1 = service.parseIntent('Refund customer for $50')!;
            service.proposeAction(intent1);
            const intent2 = service.parseIntent('Approve the invoice #DOC1')!;
            const proposed2 = service.proposeAction(intent2);
            service.approveAction(proposed2.id, 'user-1');

            const pending = service.getPendingActions();
            expect(pending.length).toBe(1);
            expect(pending[0].intent.action).toBe('refund');
        });

        it('should mark expired actions', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            service.proposeAction(intent);

            jest.advanceTimersByTime(6 * 60 * 1000);

            const pending = service.getPendingActions();
            expect(pending.length).toBe(0);
        });

        it('should clean up expired actions during periodic cleanup', () => {
            const intent = service.parseIntent('Refund customer for $50')!;
            service.proposeAction(intent);

            jest.advanceTimersByTime(6 * 60 * 1000);
            // Trigger cleanup interval
            jest.advanceTimersByTime(5 * 60 * 1000);

            const pending = service.getPendingActions();
            expect(pending.length).toBe(0);
        });
    });

    describe('initialization', () => {
        it('should log service availability on init', () => {
            expect(mockLogger.info).toHaveBeenCalledWith(
                '[NLActionGate] Service initialized',
                expect.objectContaining({
                    services: {
                        payment: true,
                        finance: true,
                        financeOperator: true,
                        inventory: true,
                        portal: true,
                        supplier: true,
                        sync: true
                    }
                })
            );
        });

        it('should work without any backend services', () => {
            const minimal = new NLActionGateService(mockLogger);
            expect(minimal).toBeDefined();
            const intent = minimal.parseIntent('Refund customer for $50');
            expect(intent).not.toBeNull();
            minimal.stopPeriodicCleanup();
        });
    });
});
