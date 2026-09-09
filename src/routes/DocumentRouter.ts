/**
 * Document Router
 *
 * API endpoints for document aggregation and management.
 * Supports the Universal Document Sidecar feature.
 *
 * Endpoints:
 *   GET /api/documents/:system/:recordType/:recordId
 *   POST /api/documents/upload (mock)
 *   GET /api/documents/download/:id (mock)
 *   GET /api/documents/health
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/Logger';
import { getDocumentAggregatorService } from '../services/documents/DocumentAggregatorService';

export const documentRouter = Router();

/**
 * GET /api/documents/:system/:recordType/:recordId
 * 
 * Fetches documents associated with a given record context.
 */
documentRouter.get('/:system/:recordType/:recordId', async (req: Request, res: Response) => {
    const { system, recordType, recordId } = req.params;

    logger.info('Document API request', { system, recordType, recordId });

    try {
        if (!system || !recordType || !recordId) {
            return res.status(400).json({
                error: 'Missing required parameters: system, recordType, recordId'
            });
        }

        const service = getDocumentAggregatorService();
        const documents = await service.getDocuments({
            system,
            recordType,
            recordId
        });

        return res.json({
            success: true,
            system,
            recordType,
            recordId,
            count: documents.length,
            documents
        });

    } catch (error) {
        logger.error('Document API error', { error, system, recordType, recordId });
        return res.status(500).json({
            error: 'Failed to fetch documents',
            message: (error as Error).message
        });
    }
});

/**
 * POST /api/documents/upload
 *
 * Mock upload endpoint for demo purposes.
 */
documentRouter.post('/upload', async (req: Request, res: Response) => {
    const { recordType, recordId, filename } = req.body;

    logger.info('Document upload request', { recordType, recordId, filename });

    // Capture timestamp once for consistency
    const timestamp = Date.now();
    const documentId = `upload-${timestamp}`;

    // Mock successful upload
    return res.json({
        success: true,
        message: 'Document uploaded successfully (demo mode)',
        document: {
            id: documentId,
            name: filename || 'Uploaded_Document.pdf',
            type: 'pdf',
            source: 'Upload',
            size: 0,
            lastModified: new Date().toISOString(),
            url: `/api/documents/download/${documentId}`
        }
    });
});

/**
 * GET /api/documents/download/:id
 *
 * Mock download endpoint for demo purposes.
 * Returns a placeholder response since actual documents are mocked.
 */
documentRouter.get('/download/:id', (req: Request, res: Response) => {
    const { id } = req.params;

    logger.info('Document download request', { documentId: id });

    // In demo mode, return a placeholder response
    res.json({
        success: true,
        message: 'Document download endpoint (demo mode)',
        documentId: id,
        note: 'In production, this would stream the actual document file'
    });
});

/**
 * GET /api/documents/health
 * 
 * Health check for document service.
 */
documentRouter.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'healthy',
        service: 'DocumentAggregatorService',
        timestamp: new Date().toISOString()
    });
});
