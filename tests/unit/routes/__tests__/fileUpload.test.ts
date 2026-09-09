import { createFileUploadRouter } from '../fileUpload';
import { createMockRequest, createMockResponse, createMockLogger, expectSuccess, expectError } from './testHelpers';
import type { FileUploadService } from '../../services/FileUploadService';
import type { Logger } from '../../utils/Logger';
import type { Express } from 'express';

// Mock multer
jest.mock('multer', () => {
  const multerMock = jest.fn(() => ({
    single: jest.fn(() => (req: any, res: any, next: any) => {
      // Simulate file upload
      if (req.simulateFile) {
        req.file = req.simulateFile;
      }
      next();
    }),
    array: jest.fn(() => (req: any, res: any, next: any) => {
      // Simulate multiple file upload
      if (req.simulateFiles) {
        req.files = req.simulateFiles;
      }
      next();
    }),
  }));

  // Add the memoryStorage method to the mock
  multerMock.memoryStorage = jest.fn(() => ({}));

  return multerMock;
});

describe('FileUpload Routes', () => {
  let mockFileUploadService: jest.Mocked<FileUploadService>;
  let mockLogger: Logger;
  let router: any;

  beforeEach(() => {
    mockFileUploadService = {
      uploadFile: jest.fn(),
      processFieldMappings: jest.fn(),
      validateFile: jest.fn(),
      exportFieldMappings: jest.fn(),
      generateTemplate: jest.fn(),
      getUploadHistory: jest.fn(),
      deleteUploadedFile: jest.fn(),
      processDataImport: jest.fn(),
      validateCSVStructure: jest.fn(),
      validateExcelStructure: jest.fn(),
      convertFileToJSON: jest.fn(),
    } as any;

    mockLogger = createMockLogger();

    router = createFileUploadRouter({
      fileUploadService: mockFileUploadService,
      logger: mockLogger,
    });
  });

  describe('POST /api/file-upload/field-mappings/import', () => {
    it('should import field mappings from CSV file', async () => {
      const mockFile = {
        originalname: 'mappings.csv',
        mimetype: 'text/csv',
        buffer: Buffer.from('sourceField,targetField\nfirstName,first_name'),
        size: 100,
      };

      const req = createMockRequest({
        body: { integrationId: 'test-integration' },
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      mockFileUploadService.processFieldMappings.mockResolvedValue({
        success: true,
        mappingsCount: 5,
        mappings: [
          { sourceField: 'firstName', targetField: 'first_name' },
        ],
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/import' && 
        layer.route?.methods?.post
      );

      // Simulate multer middleware
      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expect(mockFileUploadService.processFieldMappings).toHaveBeenCalledWith(
        mockFile,
        'test-integration'
      );
      expectSuccess(res, {
        success: true,
        mappingsCount: 5,
        mappings: expect.any(Array),
      });
    });

    it('should import Excel field mapping files', async () => {
      const mockFile = {
        originalname: 'mappings.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from('excel-data'),
        size: 500,
      };

      const req = createMockRequest({
        body: { integrationId: 'test-integration' },
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      mockFileUploadService.processFieldMappings.mockResolvedValue({
        success: true,
        mappingsCount: 8,
        mappings: [
          { sourceField: 'customerEmail', targetField: 'email_address' },
        ],
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/import' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expect(mockFileUploadService.processFieldMappings).toHaveBeenCalledWith(
        mockFile,
        'test-integration'
      );
      expectSuccess(res, {
        success: true,
        mappingsCount: 8,
        mappings: expect.any(Array),
      });
    });

    it('should validate file before import', async () => {
      const mockFile = {
        originalname: 'mappings.csv',
        mimetype: 'text/csv',
        buffer: Buffer.from('invalid-csv-data'),
        size: 50,
      };

      const req = createMockRequest({
        body: { 
          integrationId: 'test-integration',
          validateOnly: true,
        },
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      mockFileUploadService.validateFile.mockResolvedValue({
        valid: false,
        errors: ['Missing required column: targetField'],
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/import' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expect(mockFileUploadService.validateFile).toHaveBeenCalledWith(mockFile);
      expectError(res, 400, 'Missing required column');
    });

    it('should handle missing file', async () => {
      const req = createMockRequest({
        body: { integrationId: 'test-integration' },
      });
      const res = createMockResponse();

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/import' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expectError(res, 400, 'No file uploaded');
    });

    it('should reject unsupported file types', async () => {
      const mockFile = {
        originalname: 'mappings.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('pdf-data'),
        size: 1000,
      };

      const req = createMockRequest({
        body: { integrationId: 'test-integration' },
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/import' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expectError(res, 400, 'Unsupported file type');
    });

    it('should enforce file size limits', async () => {
      const mockFile = {
        originalname: 'large-mappings.csv',
        mimetype: 'text/csv',
        buffer: Buffer.alloc(10 * 1024 * 1024), // 10MB
        size: 10 * 1024 * 1024,
      };

      const req = createMockRequest({
        body: { integrationId: 'test-integration' },
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/import' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expectError(res, 400, 'File too large');
    });
  });

  describe('POST /api/file-upload/field-mappings/export', () => {
    it('should export field mappings as CSV', async () => {
      const req = createMockRequest({
        body: {
          integrationId: 'test-integration',
          format: 'csv',
        },
      });
      const res = createMockResponse();

      const csvData = 'sourceField,targetField\nfirstName,first_name\nlastName,last_name';
      mockFileUploadService.exportFieldMappings.mockResolvedValue({
        data: csvData,
        filename: 'field-mappings.csv',
        mimeType: 'text/csv',
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/export' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockFileUploadService.exportFieldMappings).toHaveBeenCalledWith(
        'test-integration',
        'csv'
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="field-mappings.csv"'
      );
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      expect(res.send).toHaveBeenCalledWith(csvData);
    });

    it('should export field mappings as Excel', async () => {
      const req = createMockRequest({
        body: {
          integrationId: 'test-integration',
          format: 'xlsx',
          includeTransformationRules: true,
        },
      });
      const res = createMockResponse();
      mockFileUploadService.exportFieldMappings.mockResolvedValue({
        data: Buffer.from('excel-bytes'),
        filename: 'field-mappings.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/export' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockFileUploadService.exportFieldMappings).toHaveBeenCalledWith(
        'test-integration',
        'xlsx',
        { includeTransformationRules: true }
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="field-mappings.xlsx"'
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it('should validate export format', async () => {
      const req = createMockRequest({
        body: {
          integrationId: 'test-integration',
          format: 'invalid',
        },
      });
      const res = createMockResponse();

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/export' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expectError(res, 400, 'Invalid export format');
    });
  });

  describe('GET /api/file-upload/field-mappings/template', () => {
    it('should generate CSV template', async () => {
      const req = createMockRequest({
        query: { format: 'csv' },
      });
      const res = createMockResponse();

      const templateData = 'sourceField,targetField,transformationType,isRequired\n';
      mockFileUploadService.generateTemplate.mockResolvedValue({
        data: templateData,
        filename: 'field-mappings-template.csv',
        mimeType: 'text/csv',
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/template' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockFileUploadService.generateTemplate).toHaveBeenCalledWith('csv');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="field-mappings-template.csv"'
      );
      expect(res.send).toHaveBeenCalledWith(templateData);
    });

    it('should return Excel template when requested', async () => {
      const req = createMockRequest({
        query: { 
          format: 'xlsx',
          includeSamples: 'true',
        },
      });
      const res = createMockResponse();
      mockFileUploadService.generateTemplate.mockResolvedValue({
        data: Buffer.from('excel-template'),
        filename: 'field-mappings-template.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/field-mappings/template' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockFileUploadService.generateTemplate).toHaveBeenCalledWith(
        'xlsx',
        { includeSamples: true }
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="field-mappings-template.xlsx"'
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    });
  });

  describe('POST /api/file-upload/data/import', () => {
    it('should import data from CSV file', async () => {
      const mockFile = {
        originalname: 'customers.csv',
        mimetype: 'text/csv',
        buffer: Buffer.from('name,email\nJohn Doe,john@example.com'),
        size: 200,
      };

      const req = createMockRequest({
        body: {
          integrationId: 'test-integration',
          entityType: 'customers',
        },
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      mockFileUploadService.processDataImport.mockResolvedValue({
        success: true,
        recordsProcessed: 100,
        recordsImported: 98,
        errors: [
          { row: 15, error: 'Invalid email format' },
          { row: 42, error: 'Duplicate record' },
        ],
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/data/import' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expect(mockFileUploadService.processDataImport).toHaveBeenCalledWith(
        mockFile,
        'test-integration',
        'customers'
      );
      expectSuccess(res, {
        success: true,
        recordsProcessed: 100,
        recordsImported: 98,
        errors: expect.any(Array),
      });
    });

    it('should validate data structure before import', async () => {
      const mockFile = {
        originalname: 'invalid-data.csv',
        mimetype: 'text/csv',
        buffer: Buffer.from('invalid,csv,structure'),
        size: 50,
      };

      const req = createMockRequest({
        body: {
          integrationId: 'test-integration',
          entityType: 'customers',
          validateOnly: true,
        },
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      mockFileUploadService.validateCSVStructure.mockResolvedValue({
        valid: false,
        errors: [
          'Missing required column: email',
          'Invalid column: invalid',
        ],
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/data/import' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expect(mockFileUploadService.validateCSVStructure).toHaveBeenCalledWith(
        mockFile,
        'customers'
      );
      expectError(res, 400, 'Missing required column');
    });
  });

  describe('POST /api/file-upload/validate', () => {
    it('should validate uploaded file', async () => {
      const mockFile = {
        originalname: 'test.csv',
        mimetype: 'text/csv',
        buffer: Buffer.from('valid,csv,data'),
        size: 100,
      };

      const req = createMockRequest({
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      mockFileUploadService.validateFile.mockResolvedValue({
        valid: true,
        fileInfo: {
          rows: 10,
          columns: 3,
          format: 'csv',
        },
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/validate' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expect(mockFileUploadService.validateFile).toHaveBeenCalledWith(mockFile);
      expectSuccess(res, {
        valid: true,
        fileInfo: expect.any(Object),
      });
    });

    it('should return validation errors', async () => {
      const mockFile = {
        originalname: 'invalid.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from('corrupted-excel'),
        size: 50,
      };

      const req = createMockRequest({
        simulateFile: mockFile,
      });
      const res = createMockResponse();

      mockFileUploadService.validateFile.mockResolvedValue({
        valid: false,
        errors: [
          'Corrupted Excel file',
          'Unable to read worksheet',
        ],
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/validate' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expectSuccess(res, {
        valid: false,
        errors: expect.arrayContaining([
          'Corrupted Excel file',
          'Unable to read worksheet',
        ]),
      });
    });
  });

  describe('GET /api/file-upload/history', () => {
    it('should return upload history', async () => {
      const req = createMockRequest({
        query: { integrationId: 'test-integration' },
      });
      const res = createMockResponse();

      const history = [
        {
          id: 'upload-1',
          filename: 'mappings.csv',
          uploadedAt: '2024-01-01T10:00:00Z',
          status: 'success',
          recordsProcessed: 100,
        },
        {
          id: 'upload-2',
          filename: 'customers.xlsx',
          uploadedAt: '2024-01-02T10:00:00Z',
          status: 'partial',
          recordsProcessed: 500,
          errors: 5,
        },
      ];

      mockFileUploadService.getUploadHistory.mockResolvedValue(history);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/history' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockFileUploadService.getUploadHistory).toHaveBeenCalledWith({
        integrationId: 'test-integration',
      });
      expectSuccess(res, history);
    });

    it('should support pagination', async () => {
      const req = createMockRequest({
        query: {
          page: '2',
          limit: '10',
        },
      });
      const res = createMockResponse();

      mockFileUploadService.getUploadHistory.mockResolvedValue([]);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/history' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockFileUploadService.getUploadHistory).toHaveBeenCalledWith({
        page: 2,
        limit: 10,
      });
    });
  });

  describe('DELETE /api/file-upload/:id', () => {
    it('should delete uploaded file', async () => {
      const req = createMockRequest({
        params: { id: 'upload-1' },
      });
      const res = createMockResponse();

      mockFileUploadService.deleteUploadedFile.mockResolvedValue({
        success: true,
        message: 'File deleted successfully',
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/:id' && 
        layer.route?.methods?.delete
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockFileUploadService.deleteUploadedFile).toHaveBeenCalledWith('upload-1');
      expectSuccess(res, {
        success: true,
        message: 'File deleted successfully',
      });
    });

    it('should handle file not found', async () => {
      const req = createMockRequest({
        params: { id: 'non-existent' },
      });
      const res = createMockResponse();

      mockFileUploadService.deleteUploadedFile.mockRejectedValue(
        new Error('Upload record not found')
      );

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/:id' && 
        layer.route?.methods?.delete
      );

      await handler.route.stack[0].handle(req, res);

      expectError(res, 404, 'Upload record not found');
    });
  });

  describe('POST /api/file-upload/convert', () => {
    it('should convert CSV to JSON', async () => {
      const mockFile = {
        originalname: 'data.csv',
        mimetype: 'text/csv',
        buffer: Buffer.from('name,age\nJohn,30\nJane,25'),
        size: 50,
      };

      const req = createMockRequest({
        simulateFile: mockFile,
        body: { outputFormat: 'json' },
      });
      const res = createMockResponse();

      mockFileUploadService.convertFileToJSON.mockResolvedValue({
        data: [
          { name: 'John', age: 30 },
          { name: 'Jane', age: 25 },
        ],
        format: 'json',
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/file-upload/convert' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res, () => {});
      await handler.route.stack[1].handle(req, res);

      expect(mockFileUploadService.convertFileToJSON).toHaveBeenCalledWith(
        mockFile,
        'json'
      );
      expectSuccess(res, {
        data: expect.any(Array),
        format: 'json',
      });
    });
  });
});

