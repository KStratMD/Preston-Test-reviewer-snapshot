/**
 * Document Aggregator Service
 * 
 * Aggregates documents from multiple sources (SharePoint, NetSuite, Box, etc.)
 * based on the current ERP record context.
 */

import { injectable } from 'inversify';
import { logger } from '../../utils/Logger';

export interface Document {
    id: string;
    name: string;
    type: 'pdf' | 'docx' | 'xlsx' | 'image' | 'other';
    source: string;
    size: number;
    lastModified: string;
    url: string;
    metadata?: Record<string, unknown>;
}

export interface DocumentContext {
    system: string;
    recordType: string;
    recordId: string;
}

@injectable()
export class DocumentAggregatorService {
    /**
     * Get documents for a given record context
     */
    async getDocuments(context: DocumentContext): Promise<Document[]> {
        logger.info('[DocumentAggregator] Fetching documents', { ...context });

        // Generate consistent mock data based on record
        const hash = this.simpleHash(`${context.recordType}-${context.recordId}`);
        const documents: Document[] = [];

        // Add documents based on record type
        switch (context.recordType.toLowerCase()) {
            case 'vendor':
                documents.push(...this.getVendorDocuments(context.recordId, hash));
                break;
            case 'customer':
                documents.push(...this.getCustomerDocuments(context.recordId, hash));
                break;
            case 'invoice':
                documents.push(...this.getInvoiceDocuments(context.recordId, hash));
                break;
            case 'purchaseorder':
                documents.push(...this.getPurchaseOrderDocuments(context.recordId, hash));
                break;
            default:
                documents.push(...this.getGenericDocuments(context.recordId, hash));
        }

        return documents;
    }

    private getVendorDocuments(recordId: string, hash: number): Document[] {
        const docs: Document[] = [
            {
                id: `w9-${recordId}`,
                name: 'W-9_Tax_Form.pdf',
                type: 'pdf',
                source: 'DocuSign',
                size: 245000,
                lastModified: this.recentDate(hash, 30),
                url: `/api/documents/download/w9-${recordId}`
            },
            {
                id: `coi-${recordId}`,
                name: 'Certificate_of_Insurance.pdf',
                type: 'pdf',
                source: 'SharePoint',
                size: 512000,
                lastModified: this.recentDate(hash, 90),
                url: `/api/documents/download/coi-${recordId}`
            },
            {
                id: `msa-${recordId}`,
                name: 'Master_Service_Agreement.pdf',
                type: 'pdf',
                source: 'ContractCentral',
                size: 1024000,
                lastModified: this.recentDate(hash, 365),
                url: `/api/documents/download/msa-${recordId}`
            }
        ];

        // Add optional documents based on hash
        if (hash % 3 === 0) {
            docs.push({
                id: `nda-${recordId}`,
                name: 'Non_Disclosure_Agreement.pdf',
                type: 'pdf',
                source: 'DocuSign',
                size: 156000,
                lastModified: this.recentDate(hash, 180),
                url: `/api/documents/download/nda-${recordId}`
            });
        }

        return docs;
    }

    private getCustomerDocuments(recordId: string, hash: number): Document[] {
        return [
            {
                id: `contract-${recordId}`,
                name: 'Service_Contract.pdf',
                type: 'pdf',
                source: 'ContractCentral',
                size: 890000,
                lastModified: this.recentDate(hash, 60),
                url: `/api/documents/download/contract-${recordId}`
            },
            {
                id: `proposal-${recordId}`,
                name: 'Sales_Proposal.pdf',
                type: 'pdf',
                source: 'Salesforce',
                size: 2048000,
                lastModified: this.recentDate(hash, 120),
                url: `/api/documents/download/proposal-${recordId}`
            },
            {
                id: `sow-${recordId}`,
                name: 'Statement_of_Work.docx',
                type: 'docx',
                source: 'SharePoint',
                size: 456000,
                lastModified: this.recentDate(hash, 45),
                url: `/api/documents/download/sow-${recordId}`
            }
        ];
    }

    private getInvoiceDocuments(recordId: string, hash: number): Document[] {
        return [
            {
                id: `inv-${recordId}`,
                name: `Invoice_${recordId}.pdf`,
                type: 'pdf',
                source: 'NetSuite',
                size: 125000,
                lastModified: this.recentDate(hash, 7),
                url: `/api/documents/download/inv-${recordId}`
            },
            {
                id: `pod-${recordId}`,
                name: 'Proof_of_Delivery.pdf',
                type: 'pdf',
                source: 'ShipStation',
                size: 89000,
                lastModified: this.recentDate(hash, 14),
                url: `/api/documents/download/pod-${recordId}`
            }
        ];
    }

    private getPurchaseOrderDocuments(recordId: string, hash: number): Document[] {
        return [
            {
                id: `po-${recordId}`,
                name: `PO_${recordId}.pdf`,
                type: 'pdf',
                source: 'NetSuite',
                size: 178000,
                lastModified: this.recentDate(hash, 5),
                url: `/api/documents/download/po-${recordId}`
            },
            {
                id: `quote-${recordId}`,
                name: 'Vendor_Quote.pdf',
                type: 'pdf',
                source: 'Email',
                size: 234000,
                lastModified: this.recentDate(hash, 10),
                url: `/api/documents/download/quote-${recordId}`
            },
            {
                id: `spec-${recordId}`,
                name: 'Product_Specifications.xlsx',
                type: 'xlsx',
                source: 'SharePoint',
                size: 567000,
                lastModified: this.recentDate(hash, 30),
                url: `/api/documents/download/spec-${recordId}`
            }
        ];
    }

    private getGenericDocuments(recordId: string, hash: number): Document[] {
        return [
            {
                id: `doc-${recordId}`,
                name: 'Related_Document.pdf',
                type: 'pdf',
                source: 'SharePoint',
                size: 200000,
                lastModified: this.recentDate(hash, 15),
                url: `/api/documents/download/doc-${recordId}`
            }
        ];
    }

    private recentDate(hash: number, maxDaysAgo: number): string {
        const daysAgo = hash % maxDaysAgo;
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        return date.toISOString();
    }

    private simpleHash(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }
}

// Singleton instance
let instance: DocumentAggregatorService | null = null;

export function getDocumentAggregatorService(): DocumentAggregatorService {
    if (!instance) {
        instance = new DocumentAggregatorService();
    }
    return instance;
}
