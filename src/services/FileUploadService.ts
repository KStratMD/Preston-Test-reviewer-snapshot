import multer from 'multer';
import { Request } from 'express';
import csvParser from 'csv-parser';
import * as Papa from 'papaparse';
import { Readable } from 'stream';
import { logger } from '../utils/Logger';
import * as path from 'path';
import * as fs from 'fs';
import { FieldMapping, TransformationRule } from '../types';

export interface FileUploadOptions {
  maxFileSize?: number;
  allowedMimeTypes?: string[];
  allowedExtensions?: string[];
  uploadPath?: string;
}

export interface ParsedFileData {
  headers: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  fileName: string;
  fileType: string;
}

export interface FieldMappingImportResult {
  success: boolean;
  mappings: FieldMapping[];
  transformationRules?: TransformationRule[];
  errors: string[];
  warnings: string[];
  totalMappings: number;
  validMappings: number;
}

export class FileUploadService {
  private readonly options: Required<FileUploadOptions>;
  private upload!: multer.Multer;

  constructor(options: FileUploadOptions = {}) {
    this.options = {
      maxFileSize: options.maxFileSize || 5 * 1024 * 1024, // 5MB
      allowedMimeTypes: options.allowedMimeTypes || [
        'text/csv',
        'text/plain',
        'application/csv',
        'application/octet-stream', // Sometimes CSV files are detected as this
      ],
      allowedExtensions: options.allowedExtensions || ['.csv', '.txt'],
      uploadPath: options.uploadPath || path.join(process.cwd(), 'uploads', 'temp'),
    };

    this.setupMulter();
    this.ensureUploadDirectory();
  }

  private setupMulter(): void {
    const storage = multer.memoryStorage(); // Store in memory for immediate processing

    this.upload = multer({
      storage,
      limits: {
        fileSize: this.options.maxFileSize,
        files: 1,
      },
      fileFilter: (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
        // Check file extension first (more reliable than MIME type)
        const ext = path.extname(file.originalname).toLowerCase();
        if (!this.options.allowedExtensions.includes(ext)) {
          return cb(new Error(`File extension ${ext} not allowed`));
        }

        // For security, also check MIME type but be more lenient with CSV files
        const isCsvFile = ext === '.csv' || ext === '.txt';

        if (isCsvFile) {
          // CSV files can have various MIME types, so we're more permissive
          const csvMimeTypes = ['text/csv', 'text/plain', 'application/csv', 'application/octet-stream'];
          if (!csvMimeTypes.includes(file.mimetype)) {
            return cb(new Error(`Invalid MIME type ${file.mimetype} for CSV file`));
          }
        } else if (!this.options.allowedMimeTypes.includes(file.mimetype)) {
          return cb(new Error(`File type ${file.mimetype} not allowed`));
        }

        cb(null, true);
      },
    });
  }

  private ensureUploadDirectory(): void {
    if (!fs.existsSync(this.options.uploadPath)) {
      fs.mkdirSync(this.options.uploadPath, { recursive: true });
    }
  }

  public getMulterMiddleware(): multer.Multer {
    return this.upload;
  }

  public async parseFile(file: Express.Multer.File): Promise<ParsedFileData> {
    try {
      const ext = path.extname(file.originalname).toLowerCase();
      
      switch (ext) {
        case '.csv':
        case '.txt':
          return await this.parseCsv(file);
        case '.xlsx':
        case '.xls':
          throw new Error('Excel uploads are temporarily disabled. Please upload a CSV file instead.');
        default:
          throw new Error(`Unsupported file type: ${ext}`);
      }
    } catch (error) {
      logger.error('File parsing error', { 
        fileName: file.originalname, 
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  private async parseCsv(file: Express.Multer.File): Promise<ParsedFileData> {
    return new Promise((resolve, reject) => {
      const results: Record<string, unknown>[] = [];
      let headers: string[] = [];
      
      const stream = Readable.from(file.buffer);
      
      stream
        .pipe(csvParser())
        .on('headers', (headerList: string[]) => {
          headers = headerList;
        })
        .on('data', (data: Record<string, unknown>) => {
          results.push(data);
        })
        .on('end', () => {
          resolve({
            headers,
            rows: results,
            totalRows: results.length,
            fileName: file.originalname,
            fileType: 'csv',
          });
        })
        .on('error', (error: Error) => {
          reject(new Error(`CSV parsing error: ${error.message}`));
        });
    });
  }

  public async importFieldMappings(parsedData: ParsedFileData): Promise<FieldMappingImportResult> {
    const result: FieldMappingImportResult = {
      success: false,
      mappings: [],
      transformationRules: [],
      errors: [],
      warnings: [],
      totalMappings: 0,
      validMappings: 0,
    };

    try {
      // Validate required columns for field mappings
      const requiredColumns = ['sourceField', 'targetField'];
      const optionalColumns = ['transformationType', 'transformationValue', 'isRequired', 'validation'];
      
      const missingColumns = requiredColumns.filter(col => !parsedData.headers.includes(col));
      if (missingColumns.length > 0) {
        result.errors.push(`Missing required columns: ${missingColumns.join(', ')}`);
        return result;
      }

      result.totalMappings = parsedData.rows.length;

      for (let i = 0; i < parsedData.rows.length; i++) {
        const row = parsedData.rows[i];
        const rowNumber = i + 2; // Excel/CSV row number (accounting for header)

        if (!row) {
          result.errors.push(`Row ${rowNumber}: Invalid row data`);
          continue;
        }

        try {
          // Validate required fields
          if (!row.sourceField || !row.targetField) {
            result.errors.push(`Row ${rowNumber}: Missing sourceField or targetField`);
            continue;
          }

          // Create field mapping. Normalize the transformation type once so
          // mapping.transformationType and transformationConfig.type can't
          // diverge (e.g. one trimmed and the other not — Copilot review on
          // PR #658 caught this).
          const normalizedTransformationType = row.transformationType
            ? String(row.transformationType).trim()
            : 'direct';
          const mapping: FieldMapping = {
            sourceField: String(row.sourceField).trim(),
            targetField: String(row.targetField).trim(),
            transformationType: normalizedTransformationType as any,
            isRequired: row.isRequired ? String(row.isRequired).toLowerCase() === 'true' : false,
            defaultValue: row.defaultValue ? String(row.defaultValue).trim() : undefined,
            transformationConfig: row.transformationValue ? {
              type: normalizedTransformationType,
              expression: String(row.transformationValue).trim(),
            } : undefined,
          };

          // Validate transformation type
          const validTransformationTypes = ['direct', 'lookup', 'calculation', 'concatenation', 'conditional'];
          if (!validTransformationTypes.includes(mapping.transformationType)) {
            result.warnings.push(`Row ${rowNumber}: Invalid transformation type '${mapping.transformationType}', using 'direct'`);
            mapping.transformationType = 'direct';
          }

          // Create transformation rule if specified
          if (row.transformationType && row.transformationType !== 'direct') {
            const transformationRule: TransformationRule = {
              id: `rule_${mapping.sourceField}_${mapping.targetField}`,
              name: `Transform ${mapping.sourceField} to ${mapping.targetField}`,
              type: 'field_mapping',
              action: 'transform',
              condition: row.condition ? String(row.condition).trim() : undefined,
              parameters: {
                sourceField: mapping.sourceField,
                targetField: mapping.targetField,
                type: mapping.transformationType,
              },
            };

            result.transformationRules?.push(transformationRule);
          }

          result.mappings.push(mapping);
          result.validMappings++;

        } catch (error) {
          result.errors.push(`Row ${rowNumber}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      result.success = result.validMappings > 0;
      
      if (result.success) {
        logger.info('Field mappings imported successfully', {
          fileName: parsedData.fileName,
          totalMappings: result.totalMappings,
          validMappings: result.validMappings,
          errors: result.errors.length,
          warnings: result.warnings.length,
        });
      }

      return result;
    } catch (error) {
      result.errors.push(`Import error: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  public exportFieldMappingsToCSV(mappings: FieldMapping[], transformationRules?: TransformationRule[]): string {
    const headers = [
      'sourceField',
      'targetField', 
      'transformationType',
      'transformationValue',
      'isRequired',
      'validation',
      'condition',
    ];

    const rows = mappings.map(mapping => {
      // Find corresponding transformation rule
      const rule = transformationRules?.find(r => 
        r.parameters?.sourceField === mapping.sourceField && r.parameters?.targetField === mapping.targetField
      );

      return {
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        transformationType: mapping.transformationType || 'direct',
        transformationValue: mapping.transformationConfig?.expression || '',
        isRequired: mapping.isRequired ? 'true' : 'false',
        validation: mapping.transformationConfig?.expression || '',
        condition: rule?.condition || '',
      };
    });

    return Papa.unparse({
      fields: headers,
      data: rows,
    });
  }

  public exportFieldMappingsToExcel(_mappings: FieldMapping[], _transformationRules?: TransformationRule[]): Buffer {
    throw new Error('Excel export is temporarily disabled. Please request CSV export instead.');
  }

  public async cleanupTempFiles(maxAge = 3600000): Promise<number> {
    try {
      const files = fs.readdirSync(this.options.uploadPath);
      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.options.uploadPath, file);
        const stats = fs.statSync(filePath);
        
        if (Date.now() - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }

      logger.debug('Cleaned up temp files', { deletedCount, uploadPath: this.options.uploadPath });
      return deletedCount;
    } catch (error) {
      logger.error('Error cleaning up temp files', { error });
      return 0;
    }
  }
}

export const fileUploadService = new FileUploadService();
