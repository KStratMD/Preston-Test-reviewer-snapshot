import { Router, type Request, type Response } from 'express';
import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import type { BatchProcessingService } from '../services/BatchProcessingService';
import { TYPES } from '../inversify/types';
import { validateRequest } from '../middleware/validation';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

const submitBatchSchema = z.object({
  integrationId: z.string().min(1),
  records: z.array(z.object({
    id: z.string(),
    fields: z.record(z.string(), z.unknown()),
  })).min(1),
  options: z.object({
    batchSize: z.number().int().min(1).max(1000).optional(),
    priority: z.number().int().min(0).max(10).optional(),
    delay: z.number().int().min(0).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
  }).optional(),
});

/**
 * Router for batch processing operations
 */
@injectable()
export class BatchProcessingRouter {
  private readonly router: Router;
  private readonly logger: Logger;
  private readonly batchProcessingService: BatchProcessingService;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.BatchProcessingService) batchProcessingService: BatchProcessingService,
  ) {
    this.router = Router();
    this.logger = logger;
    this.batchProcessingService = batchProcessingService;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    /**
     * @swagger
     * /api/batch/submit:
     *   post:
     *     summary: Submit a batch for processing
     *     tags: [Batch Processing]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               integrationId:
     *                 type: string
     *                 description: Integration ID to process
     *               records:
     *                 type: array
     *                 description: Array of records to process
     *                 items:
     *                   type: object
     *                   properties:
     *                     id:
     *                       type: string
     *                     fields:
     *                       type: object
     *               options:
     *                 type: object
     *                 properties:
     *                   batchSize:
     *                     type: number
     *                     minimum: 1
     *                     maximum: 1000
     *                   priority:
     *                     type: number
     *                     minimum: 0
     *                     maximum: 10
     *                   delay:
     *                     type: number
     *                     minimum: 0
     *                   maxAttempts:
     *                     type: number
     *                     minimum: 1
     *                     maximum: 10
     *     responses:
     *       200:
     *         description: Batch submitted successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 jobId:
     *                   type: string
     *                 message:
     *                   type: string
     *       400:
     *         description: Invalid request
     *       500:
     *         description: Internal server error
     */
    this.router.post('/submit', validateRequest(submitBatchSchema), asyncHandler(async (req: Request, res: Response) => {
      const { integrationId, records, options } = req.body;

      const jobId = await this.batchProcessingService.submitBatch(
        integrationId,
        records,
        options,
      );

      this.logger.info('Batch submitted via API', {
        integrationId,
        recordCount: records.length,
        jobId,
      });

      res.json({
        jobId,
        message: 'Batch submitted successfully',
      });
    }));

    /**
     * @swagger
     * /api/batch/status/{jobId}:
     *   get:
     *     summary: Get batch processing status
     *     tags: [Batch Processing]
     *     parameters:
     *       - in: path
     *         name: jobId
     *         required: true
     *         schema:
     *           type: string
     *         description: Job ID
     *     responses:
     *       200:
     *         description: Batch status retrieved successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 jobId:
     *                   type: string
     *                 status:
     *                   type: string
     *                   enum: [queued, processing, completed, failed]
     *                 totalRecords:
     *                   type: number
     *                 processedRecords:
     *                   type: number
     *                 failedRecords:
     *                   type: number
     *       404:
     *         description: Job not found
     *       500:
     *         description: Internal server error
     */
    this.router.get('/status/:jobId', asyncHandler(async (req: Request, res: Response) => {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          error: 'Missing job ID',
          message: 'Job ID is required',
        });
        return;
      }

      const status = await this.batchProcessingService.getBatchStatus(jobId);

      if (!status) {
        res.status(404).json({
          error: 'Job not found',
          message: `No batch job found with ID: ${jobId}`,
        });
        return;
      }

      res.json(status);
    }));

    /**
     * @swagger
     * /api/batch/metrics:
     *   get:
     *     summary: Get batch processing metrics
     *     tags: [Batch Processing]
     *     responses:
     *       200:
     *         description: Metrics retrieved successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 waiting:
     *                   type: number
     *                 active:
     *                   type: number
     *                 completed:
     *                   type: number
     *                 failed:
     *                   type: number
     *                 delayed:
     *                   type: number
     *                 paused:
     *                   type: boolean
     *       500:
     *         description: Internal server error
     */
    this.router.get('/metrics', asyncHandler(async (req: Request, res: Response) => {
      const metrics = await this.batchProcessingService.getBatchMetrics();
      res.json(metrics);
    }));

    /**
     * @swagger
     * /api/batch/pause:
     *   post:
     *     summary: Pause batch processing
     *     tags: [Batch Processing]
     *     responses:
     *       200:
     *         description: Batch processing paused successfully
     *       500:
     *         description: Internal server error
     */
    this.router.post('/pause', asyncHandler(async (req: Request, res: Response) => {
      await this.batchProcessingService.pauseBatchProcessing();

      this.logger.info('Batch processing paused via API');

      res.json({
        message: 'Batch processing paused successfully',
      });
    }));

    /**
     * @swagger
     * /api/batch/resume:
     *   post:
     *     summary: Resume batch processing
     *     tags: [Batch Processing]
     *     responses:
     *       200:
     *         description: Batch processing resumed successfully
     *       500:
     *         description: Internal server error
     */
    this.router.post('/resume', asyncHandler(async (req: Request, res: Response) => {
      await this.batchProcessingService.resumeBatchProcessing();

      this.logger.info('Batch processing resumed via API');

      res.json({
        message: 'Batch processing resumed successfully',
      });
    }));

    /**
     * @swagger
     * /api/batch/retry-failed:
     *   post:
     *     summary: Retry all failed batch jobs
     *     tags: [Batch Processing]
     *     responses:
     *       200:
     *         description: Failed jobs retried successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 retriedCount:
     *                   type: number
     *                 message:
     *                   type: string
     *       500:
     *         description: Internal server error
     */
    this.router.post('/retry-failed', asyncHandler(async (req: Request, res: Response) => {
      const retriedCount = await this.batchProcessingService.retryFailedBatches();

      this.logger.info('Failed batches retried via API', { retriedCount });

      res.json({
        retriedCount,
        message: `${retriedCount} failed jobs retried successfully`,
      });
    }));
  }

  getRouter(): Router {
    return this.router;
  }
}
