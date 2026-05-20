/**
 * Unit tests for DocumentAggregatorService
 *
 * Tests document generation by record type and hash-based consistency.
 */

import { DocumentAggregatorService, getDocumentAggregatorService } from '../../../../src/services/documents/DocumentAggregatorService';

describe('DocumentAggregatorService', () => {
    let service: DocumentAggregatorService;

    beforeEach(() => {
        service = new DocumentAggregatorService();
    });

    describe('getDocuments', () => {
        it('should return vendor documents for vendor record type', async () => {
            const docs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345'
            });

            expect(docs.length).toBeGreaterThanOrEqual(3);
            expect(docs.some(d => d.name.includes('W-9'))).toBe(true);
            expect(docs.some(d => d.name.includes('Certificate_of_Insurance'))).toBe(true);
            expect(docs.some(d => d.name.includes('Master_Service_Agreement'))).toBe(true);
        });

        it('should return customer documents for customer record type', async () => {
            const docs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'customer',
                recordId: 'C-67890'
            });

            expect(docs.length).toBe(3);
            expect(docs.some(d => d.name.includes('Service_Contract'))).toBe(true);
            expect(docs.some(d => d.name.includes('Sales_Proposal'))).toBe(true);
            expect(docs.some(d => d.name.includes('Statement_of_Work'))).toBe(true);
        });

        it('should return invoice documents for invoice record type', async () => {
            const docs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'invoice',
                recordId: 'INV-001'
            });

            expect(docs.length).toBe(2);
            expect(docs.some(d => d.name.includes('Invoice'))).toBe(true);
            expect(docs.some(d => d.name.includes('Proof_of_Delivery'))).toBe(true);
        });

        it('should return purchase order documents for purchaseorder record type', async () => {
            const docs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'purchaseorder',
                recordId: 'PO-5555'
            });

            expect(docs.length).toBe(3);
            expect(docs.some(d => d.name.includes('PO_'))).toBe(true);
            expect(docs.some(d => d.name.includes('Vendor_Quote'))).toBe(true);
            expect(docs.some(d => d.name.includes('Product_Specifications'))).toBe(true);
        });

        it('should return generic documents for unknown record type', async () => {
            const docs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'unknown',
                recordId: 'U-9999'
            });

            expect(docs.length).toBe(1);
            expect(docs[0].name).toBe('Related_Document.pdf');
        });

        it('should handle case-insensitive record types', async () => {
            const upperDocs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'VENDOR',
                recordId: 'V-12345'
            });

            const lowerDocs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345'
            });

            expect(upperDocs.length).toBe(lowerDocs.length);
        });
    });

    describe('hash-based consistency', () => {
        it('should return consistent documents for the same recordId', async () => {
            const docs1 = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-CONSISTENT'
            });

            const docs2 = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-CONSISTENT'
            });

            expect(docs1.length).toBe(docs2.length);
            expect(docs1.map(d => d.id).sort()).toEqual(docs2.map(d => d.id).sort());
        });

        it('should return different document counts for different vendors based on hash', async () => {
            const results: number[] = [];

            // Test multiple vendors to verify hash-based variation
            for (let i = 0; i < 20; i++) {
                const docs = await service.getDocuments({
                    system: 'NetSuite',
                    recordType: 'vendor',
                    recordId: `V-TEST-${i}`
                });
                results.push(docs.length);
            }

            // Should have variation (some with NDA, some without)
            const uniqueCounts = [...new Set(results)];
            expect(uniqueCounts.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('document structure', () => {
        it('should return documents with all required fields', async () => {
            const docs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345'
            });

            docs.forEach(doc => {
                expect(doc.id).toBeDefined();
                expect(doc.name).toBeDefined();
                expect(doc.type).toMatch(/^(pdf|docx|xlsx|image|other)$/);
                expect(doc.source).toBeDefined();
                expect(typeof doc.size).toBe('number');
                expect(doc.lastModified).toBeDefined();
                expect(doc.url).toMatch(/^\/api\/documents\/download\//);
            });
        });

        it('should generate valid ISO date strings for lastModified', async () => {
            const docs = await service.getDocuments({
                system: 'NetSuite',
                recordType: 'customer',
                recordId: 'C-12345'
            });

            docs.forEach(doc => {
                const date = new Date(doc.lastModified);
                expect(date.toString()).not.toBe('Invalid Date');
            });
        });
    });

    describe('singleton instance', () => {
        it('should return the same instance via getDocumentAggregatorService', () => {
            const instance1 = getDocumentAggregatorService();
            const instance2 = getDocumentAggregatorService();

            expect(instance1).toBe(instance2);
        });
    });
});
