import { Request, Response } from 'express';
import { z } from 'zod';

// Schema for a single batch operation
const BatchOperationSchema = z.object({
  id: z.string().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string(),
  body: z.any().optional(),
  headers: z.record(z.string(), z.string()).optional()
});

// Schema for batch request
const BatchRequestSchema = z.object({
  operations: z.array(BatchOperationSchema).min(1).max(50),
  sequential: z.boolean().optional().default(false),
  stopOnError: z.boolean().optional().default(false)
});

export type BatchOperation = z.infer<typeof BatchOperationSchema>;
export type BatchRequest = z.infer<typeof BatchRequestSchema>;

interface BatchResponse {
  id?: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  error?: string;
}

export interface BatchResult {
  results: BatchResponse[];
  hasErrors: boolean;
  successCount: number;
  errorCount: number;
}

export class BatchProcessor {
  constructor(
    private readonly app: unknown, // Express app instance
    private readonly baseUrl = '/api'
  ) {}
  
  async processBatch(
    req: Request,
    batchRequest: BatchRequest
  ): Promise<BatchResult> {
    const results: BatchResponse[] = [];
    let hasErrors = false;
    let successCount = 0;
    let errorCount = 0;
    
    const operations = batchRequest.operations;
    
    if (batchRequest.sequential) {
      // Process operations sequentially
      for (const operation of operations) {
        const result = await this.processSingleOperation(req, operation);
        results.push(result);
        
        if (result.status >= 400) {
          hasErrors = true;
          errorCount++;
          if (batchRequest.stopOnError) {
            break;
          }
        } else {
          successCount++;
        }
      }
    } else {
      // Process operations in parallel
      const promises = operations.map(operation => 
        this.processSingleOperation(req, operation)
      );
      
      const parallelResults = await Promise.all(promises);
      
      for (const result of parallelResults) {
        results.push(result);
        if (result.status >= 400) {
          hasErrors = true;
          errorCount++;
        } else {
          successCount++;
        }
      }
    }
    
    return {
      results,
      hasErrors,
      successCount,
      errorCount
    };
  }
  
  private async processSingleOperation(
    originalReq: Request,
    operation: BatchOperation
  ): Promise<BatchResponse> {
    try {
      // Create a mock request object
      const mockReq = {
        method: operation.method,
        url: `${this.baseUrl}${operation.path}`,
        path: operation.path,
        headers: {
          ...originalReq.headers,
          ...operation.headers,
          'x-batch-request': 'true'
        },
        body: operation.body,
        query: this.parseQueryString(operation.path),
        user: originalReq.user // Preserve authentication
      };
      
      // Create a mock response object
      let responseData: unknown;
      let responseStatus = 200;
      const responseHeaders: Record<string, string> = {};

      const mockRes = {
        status: (code: number) => {
          responseStatus = code;
          return mockRes;
        },
        json: (data: unknown) => {
          responseData = data;
          return mockRes;
        },
        send: (data: unknown) => {
          responseData = data;
          return mockRes;
        },
        set: (name: string, value: string) => {
          responseHeaders[name] = value;
          return mockRes;
        },
        header: (name: string, value: string) => {
          responseHeaders[name] = value;
          return mockRes;
        }
      };
      
      // Process the request through Express router
      await new Promise<void>((resolve, reject) => {
        (this.app as any).handle(mockReq, mockRes, (err: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      
      return {
        id: operation.id,
        status: responseStatus,
        headers: responseHeaders,
        body: responseData
      };
    } catch (error) {
      return {
        id: operation.id,
        status: 500,
        error: error instanceof Error ? error.message : 'Internal server error'
      };
    }
  }
  
  private parseQueryString(path: string): Record<string, string> {
    const queryIndex = path.indexOf('?');
    if (queryIndex === -1) {
      return {};
    }
    
    const queryString = path.substring(queryIndex + 1);
    const params: Record<string, string> = {};
    
    queryString.split('&').forEach(param => {
      const [key, value] = param.split('=');
      if (key) {
        params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
      }
    });
    
    return params;
  }
}

// Express middleware for batch endpoints
export function createBatchEndpoint(app: unknown) {
  const processor = new BatchProcessor(app);
  
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const validatedRequest = BatchRequestSchema.parse(req.body);
      const result = await processor.processBatch(req, validatedRequest);
      
      // Set appropriate status based on results
      const overallStatus = result.hasErrors ? 207 : 200; // 207 Multi-Status
      
      res.status(overallStatus).json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Invalid batch request',
          details: error.issues
        });
      } else {
        res.status(500).json({
          error: 'Internal server error'
        });
      }
    }
  };
}