/**
 * FileUploadService Unit Tests
 * Tests for file upload and parsing service
 */

import {
  FileUploadService,
  ParsedFileData,
  FieldMappingImportResult,
} from '../../../src/services/FileUploadService';
import { FieldMapping, TransformationRule } from '../../../src/types';
import * as fs from 'fs';
import * as path from 'path';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  statSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

describe('FileUploadService', () => {
  let service: FileUploadService;
  let mockLogger: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    service = new FileUploadService();
    mockLogger = require('../../../src/utils/Logger').logger;
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const svc = new FileUploadService();
      expect(svc).toBeDefined();
    });

    it('should initialize with custom options', () => {
      const svc = new FileUploadService({
        maxFileSize: 10 * 1024 * 1024,
        allowedMimeTypes: ['text/csv'],
        allowedExtensions: ['.csv'],
        uploadPath: '/custom/path',
      });
      expect(svc).toBeDefined();
    });

    it('should ensure upload directory exists', () => {
      (fs.existsSync as jest.Mock).mockReturnValueOnce(false);
      new FileUploadService();
      expect(fs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('getMulterMiddleware()', () => {
    it('should return multer middleware', () => {
      const middleware = service.getMulterMiddleware();
      expect(middleware).toBeDefined();
    });
  });

  describe('parseFile()', () => {
    it('should throw for unsupported file types', async () => {
      const file = {
        originalname: 'test.json',
        buffer: Buffer.from('{}'),
      } as Express.Multer.File;

      await expect(service.parseFile(file)).rejects.toThrow('Unsupported file type: .json');
    });

    it('should throw for Excel files', async () => {
      const file = {
        originalname: 'test.xlsx',
        buffer: Buffer.from(''),
      } as Express.Multer.File;

      await expect(service.parseFile(file)).rejects.toThrow('Excel uploads are temporarily disabled');
    });

    it('should throw for xls files', async () => {
      const file = {
        originalname: 'test.xls',
        buffer: Buffer.from(''),
      } as Express.Multer.File;

      await expect(service.parseFile(file)).rejects.toThrow('Excel uploads are temporarily disabled');
    });

    it('should parse CSV file', async () => {
      const csvContent = 'name,age\nJohn,30\nJane,25';
      const file = {
        originalname: 'test.csv',
        buffer: Buffer.from(csvContent),
      } as Express.Multer.File;

      const result = await service.parseFile(file);

      expect(result.fileName).toBe('test.csv');
      expect(result.fileType).toBe('csv');
      expect(result.headers).toContain('name');
      expect(result.headers).toContain('age');
      expect(result.rows.length).toBe(2);
      expect(result.totalRows).toBe(2);
    });

    it('should parse TXT file as CSV', async () => {
      const csvContent = 'field1,field2\nvalue1,value2';
      const file = {
        originalname: 'test.txt',
        buffer: Buffer.from(csvContent),
      } as Express.Multer.File;

      const result = await service.parseFile(file);

      expect(result.fileType).toBe('csv');
      expect(result.headers).toContain('field1');
    });
  });

  describe('importFieldMappings()', () => {
    it('should fail with missing required columns', async () => {
      const parsedData: ParsedFileData = {
        headers: ['name', 'value'],
        rows: [{ name: 'test', value: '123' }],
        totalRows: 1,
        fileName: 'test.csv',
        fileType: 'csv',
      };

      const result = await service.importFieldMappings(parsedData);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Missing required columns');
    });

    it('should import valid field mappings', async () => {
      const parsedData: ParsedFileData = {
        headers: ['sourceField', 'targetField', 'transformationType', 'isRequired'],
        rows: [
          { sourceField: 'source1', targetField: 'target1', transformationType: 'direct', isRequired: 'true' },
          { sourceField: 'source2', targetField: 'target2', transformationType: 'lookup', isRequired: 'false' },
        ],
        totalRows: 2,
        fileName: 'mappings.csv',
        fileType: 'csv',
      };

      const result = await service.importFieldMappings(parsedData);

      expect(result.success).toBe(true);
      expect(result.validMappings).toBe(2);
      expect(result.mappings.length).toBe(2);
    });

    it('should skip rows with missing required fields', async () => {
      const parsedData: ParsedFileData = {
        headers: ['sourceField', 'targetField'],
        rows: [
          { sourceField: 'source1', targetField: 'target1' },
          { sourceField: '', targetField: 'target2' }, // Invalid - empty sourceField
          { sourceField: 'source3', targetField: '' }, // Invalid - empty targetField
        ],
        totalRows: 3,
        fileName: 'mappings.csv',
        fileType: 'csv',
      };

      const result = await service.importFieldMappings(parsedData);

      expect(result.success).toBe(true);
      expect(result.validMappings).toBe(1);
      expect(result.errors.length).toBe(2);
    });

    it('should handle invalid transformation type with warning', async () => {
      const parsedData: ParsedFileData = {
        headers: ['sourceField', 'targetField', 'transformationType'],
        rows: [
          { sourceField: 'source1', targetField: 'target1', transformationType: 'invalid' },
        ],
        totalRows: 1,
        fileName: 'mappings.csv',
        fileType: 'csv',
      };

      const result = await service.importFieldMappings(parsedData);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBe(1);
      expect(result.mappings[0].transformationType).toBe('direct');
    });

    it('should create transformation rules for non-direct types', async () => {
      const parsedData: ParsedFileData = {
        headers: ['sourceField', 'targetField', 'transformationType', 'condition'],
        rows: [
          { sourceField: 'source1', targetField: 'target1', transformationType: 'calculation', condition: 'value > 0' },
        ],
        totalRows: 1,
        fileName: 'mappings.csv',
        fileType: 'csv',
      };

      const result = await service.importFieldMappings(parsedData);

      expect(result.transformationRules?.length).toBe(1);
      expect(result.transformationRules?.[0].type).toBe('field_mapping');
    });

    it('should handle empty rows', async () => {
      const parsedData: ParsedFileData = {
        headers: ['sourceField', 'targetField'],
        rows: [
          { sourceField: 'source1', targetField: 'target1' },
          undefined as any, // Invalid row
        ],
        totalRows: 2,
        fileName: 'mappings.csv',
        fileType: 'csv',
      };

      const result = await service.importFieldMappings(parsedData);

      expect(result.validMappings).toBe(1);
      expect(result.errors.some(e => e.includes('Invalid row data'))).toBe(true);
    });

    it('should parse isRequired field correctly', async () => {
      const parsedData: ParsedFileData = {
        headers: ['sourceField', 'targetField', 'isRequired'],
        rows: [
          { sourceField: 'source1', targetField: 'target1', isRequired: 'true' },
          { sourceField: 'source2', targetField: 'target2', isRequired: 'false' },
          { sourceField: 'source3', targetField: 'target3', isRequired: 'TRUE' },
        ],
        totalRows: 3,
        fileName: 'mappings.csv',
        fileType: 'csv',
      };

      const result = await service.importFieldMappings(parsedData);

      expect(result.mappings[0].isRequired).toBe(true);
      expect(result.mappings[1].isRequired).toBe(false);
      expect(result.mappings[2].isRequired).toBe(true);
    });
  });

  describe('exportFieldMappingsToCSV()', () => {
    it('should export mappings to CSV format', () => {
      const mappings: FieldMapping[] = [
        { sourceField: 'source1', targetField: 'target1', transformationType: 'direct', isRequired: true },
        { sourceField: 'source2', targetField: 'target2', transformationType: 'lookup', isRequired: false },
      ];

      const csv = service.exportFieldMappingsToCSV(mappings);

      expect(csv).toContain('sourceField');
      expect(csv).toContain('targetField');
      expect(csv).toContain('source1');
      expect(csv).toContain('target1');
    });

    it('should include transformation rules in export', () => {
      const mappings: FieldMapping[] = [
        {
          sourceField: 'source1',
          targetField: 'target1',
          transformationType: 'calculation',
          isRequired: true,
          transformationConfig: { type: 'calculation', expression: 'value * 2' }
        },
      ];

      const rules: TransformationRule[] = [
        {
          id: 'rule1',
          name: 'Rule 1',
          type: 'field_mapping',
          action: 'transform',
          condition: 'status == "active"',
          parameters: { sourceField: 'source1', targetField: 'target1' }
        },
      ];

      const csv = service.exportFieldMappingsToCSV(mappings, rules);

      expect(csv).toContain('calculation');
      expect(csv).toContain('value * 2');
    });

    it('should handle empty mappings', () => {
      const csv = service.exportFieldMappingsToCSV([]);

      expect(csv).toContain('sourceField');
      expect(csv).toContain('targetField');
    });
  });

  describe('exportFieldMappingsToExcel()', () => {
    it('should throw error (temporarily disabled)', () => {
      const mappings: FieldMapping[] = [];

      expect(() => service.exportFieldMappingsToExcel(mappings)).toThrow('Excel export is temporarily disabled');
    });
  });

  describe('cleanupTempFiles()', () => {
    it('should clean up old files', async () => {
      const oldTime = Date.now() - 7200000; // 2 hours ago

      (fs.readdirSync as jest.Mock).mockReturnValue(['old-file.csv', 'new-file.csv']);
      (fs.statSync as jest.Mock).mockImplementation((filePath: string) => ({
        mtime: new Date(filePath.includes('old') ? oldTime : Date.now()),
      }));

      const deleted = await service.cleanupTempFiles(3600000); // 1 hour max age

      expect(deleted).toBe(1);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when no old files', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['new-file.csv']);
      (fs.statSync as jest.Mock).mockReturnValue({
        mtime: new Date(),
      });

      const deleted = await service.cleanupTempFiles();

      expect(deleted).toBe(0);
    });

    it('should handle empty directory', async () => {
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      const deleted = await service.cleanupTempFiles();

      expect(deleted).toBe(0);
    });

    it('should handle errors gracefully', async () => {
      (fs.readdirSync as jest.Mock).mockImplementation(() => {
        throw new Error('Directory not found');
      });

      const deleted = await service.cleanupTempFiles();

      expect(deleted).toBe(0);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
