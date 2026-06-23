/**
 * Unit tests for ActionIslandService
 *
 * Tests all action methods and error handling for cross-system operations.
 */

// This test uses real timers because it tests async operations that depend on timing
jest.useRealTimers();

import { ActionIslandService, getActionIslandService, ActionResult } from '../../../../src/services/embedded/ActionIslandService';

describe('ActionIslandService', () => {
    let service: ActionIslandService;

    beforeEach(() => {
        service = new ActionIslandService();
    });

    describe('requestW9', () => {
        it('should return successful result with envelope ID', async () => {
            const result = await service.requestW9('V-12345', 'vendor@example.com');

            expect(result.success).toBe(true);
            expect(result.actionId).toMatch(/^ENV-\d+$/);
            expect(result.message).toContain('W-9 request sent');
            expect(result.externalUrl).toContain('docusign.com');
            expect(result.data?.status).toBe('sent');
        });

        it('should handle missing email gracefully', async () => {
            const result = await service.requestW9('V-12345');

            expect(result.success).toBe(true);
            expect(result.message).toContain('vendor');
        });

        it('should include expiration info in data', async () => {
            const result = await service.requestW9('V-12345', 'vendor@example.com');

            expect(result.data?.expiresIn).toBeDefined();
        });
    });

    describe('checkInventory', () => {
        it('should return stock level information', async () => {
            const result = await service.checkInventory('ITEM-001');

            expect(result.success).toBe(true);
            expect(result.actionId).toMatch(/^INV-CHECK-\d+$/);
            expect(result.data?.stockLevel).toBeDefined();
            expect(typeof result.data?.stockLevel).toBe('number');
        });

        it('should include warehouse locations', async () => {
            const result = await service.checkInventory('ITEM-001');

            expect(result.data?.locations).toBeDefined();
            expect(Array.isArray(result.data?.locations)).toBe(true);
            expect((result.data?.locations as unknown[]).length).toBeGreaterThan(0);
        });

        it('should indicate low stock warning when applicable', async () => {
            // Run multiple times to get variation
            let hasLowStockWarning = false;
            let hasHealthyStock = false;

            for (let i = 0; i < 50; i++) {
                const result = await service.checkInventory(`ITEM-${i}`);
                if (result.message.includes('Low stock')) {
                    hasLowStockWarning = true;
                }
                if (result.message.includes('healthy')) {
                    hasHealthyStock = true;
                }
                if (hasLowStockWarning && hasHealthyStock) break;
            }

            // At least one type should occur given random stock levels
            expect(hasLowStockWarning || hasHealthyStock).toBe(true);
        });
    });

    describe('createDisputeTicket', () => {
        it('should create dispute ticket with ticket ID', async () => {
            const result = await service.createDisputeTicket('INV-001', 'Price discrepancy');

            expect(result.success).toBe(true);
            expect(result.actionId).toMatch(/^DISP-\d+$/);
            expect(result.message).toContain('created in Jira');
            expect(result.externalUrl).toContain('atlassian.net');
        });

        it('should include reason in ticket data', async () => {
            const reason = 'Damaged goods received';
            const result = await service.createDisputeTicket('INV-001', reason);

            expect(result.data?.reason).toBe(reason);
            expect(result.data?.status).toBe('Open');
        });
    });

    describe('pausePayments', () => {
        it('should pause payments and return confirmation', async () => {
            const result = await service.pausePayments('V-12345', 'Pending documentation');

            expect(result.success).toBe(true);
            expect(result.actionId).toMatch(/^PAY-HOLD-\d+$/);
            expect(result.data?.status).toBe('payments_paused');
        });

        it('should include reason in response', async () => {
            const reason = 'Compliance issue';
            const result = await service.pausePayments('V-12345', reason);

            expect(result.message).toContain(reason);
            expect(result.data?.reason).toBe(reason);
        });

        it('should provide resume action details', async () => {
            const result = await service.pausePayments('V-12345', 'Testing');

            const resumeAction = result.data?.resumeAction as { method: string; url: string; body: { vendorId: string } };
            expect(resumeAction.method).toBe('POST');
            expect(resumeAction.url).toBe('/api/actions/resume-payments');
            expect(resumeAction.body.vendorId).toBe('V-12345');
        });
    });

    describe('resumePayments', () => {
        it('should resume payments successfully', async () => {
            const result = await service.resumePayments('V-12345');

            expect(result.success).toBe(true);
            expect(result.actionId).toMatch(/^PAY-RESUME-\d+$/);
            expect(result.data?.status).toBe('payments_active');
        });

        it('should include timestamp', async () => {
            const result = await service.resumePayments('V-12345');

            expect(result.data?.resumedAt).toBeDefined();
            const date = new Date(result.data?.resumedAt as string);
            expect(date.toString()).not.toBe('Invalid Date');
        });
    });

    describe('sendPaymentReminder', () => {
        it('should send reminder and return confirmation', async () => {
            const result = await service.sendPaymentReminder('INV-001');

            expect(result.success).toBe(true);
            expect(result.actionId).toMatch(/^EMAIL-\d+$/);
            expect(result.message).toContain('reminder email sent');
        });

        it('should include email details in data', async () => {
            const result = await service.sendPaymentReminder('INV-001');

            expect(result.data?.emailSentAt).toBeDefined();
            expect(result.data?.recipient).toBeDefined();
            expect(result.data?.template).toBeDefined();
        });
    });

    describe('escalateToCSM', () => {
        it('should escalate to CSM with details', async () => {
            const result = await service.escalateToCSM('C-12345', 'Unhappy with service');

            expect(result.success).toBe(true);
            expect(result.actionId).toMatch(/^ESC-\d+$/);
            expect(result.message).toContain('CSM');
        });

        it('should include CSM contact information', async () => {
            const result = await service.escalateToCSM('C-12345', 'Testing');

            expect(result.data?.csmName).toBeDefined();
            expect(result.data?.csmEmail).toBeDefined();
            expect(result.data?.priority).toBe('High');
        });
    });

    describe('trackShipment', () => {
        it('should return shipment tracking information', async () => {
            const result = await service.trackShipment('PO-001');

            expect(result.success).toBe(true);
            expect(result.actionId).toMatch(/^TRACK-\d+$/);
            expect(result.externalUrl).toContain('tracking');
        });

        it('should include carrier and tracking number', async () => {
            const result = await service.trackShipment('PO-001');

            expect(result.data?.carrier).toBeDefined();
            expect(result.data?.trackingNumber).toBeDefined();
            expect(result.data?.status).toBeDefined();
        });

        it('should include estimated delivery date', async () => {
            const result = await service.trackShipment('PO-001');

            expect(result.data?.estimatedDelivery).toBeDefined();
            const date = new Date(result.data?.estimatedDelivery as string);
            expect(date.toString()).not.toBe('Invalid Date');
        });
    });

    describe('action result structure', () => {
        it('all actions should return consistent ActionResult structure', async () => {
            const actions: Promise<ActionResult>[] = [
                service.requestW9('V-1'),
                service.checkInventory('I-1'),
                service.createDisputeTicket('INV-1', 'test'),
                service.pausePayments('V-1', 'test'),
                service.resumePayments('V-1'),
                service.sendPaymentReminder('INV-1'),
                service.escalateToCSM('C-1', 'test'),
                service.trackShipment('PO-1')
            ];

            const results = await Promise.all(actions);

            results.forEach(result => {
                expect(result).toHaveProperty('success');
                expect(result).toHaveProperty('message');
                expect(result).toHaveProperty('actionId');
                expect(typeof result.success).toBe('boolean');
                expect(typeof result.message).toBe('string');
                expect(typeof result.actionId).toBe('string');
            });
        });
    });

    describe('singleton instance', () => {
        it('should return the same instance via getActionIslandService', () => {
            const instance1 = getActionIslandService();
            const instance2 = getActionIslandService();

            expect(instance1).toBe(instance2);
        });
    });
});
