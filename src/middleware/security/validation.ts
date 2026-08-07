import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../../utils/Logger';
import { BadRequestAppError } from '../../errors/AppError';

/**
 * Request size validation middleware
 */
export function createRequestSizeValidator(
  logger: Logger, 
  maxSizeBytes: number = 10 * 1024 * 1024 // 10MB default
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const contentLength = req.headers['content-length'];

    if (contentLength && parseInt(contentLength) > maxSizeBytes) {
      logger.warn('Request size limit exceeded', {
        contentLength: parseInt(contentLength),
        maxAllowed: maxSizeBytes,
        ip: req.ip,
        path: req.path,
      });

      return next(new BadRequestAppError(
        `Request too large. Maximum size: ${maxSizeBytes / (1024 * 1024)}MB`
      ));
    }

    next();
  };
}

/**
 * Content-Type validation middleware
 */
export function createContentTypeValidator(
  logger: Logger, 
  allowedTypes: string[] = ['application/json']
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Skip validation for GET, DELETE, and OPTIONS requests
    if (['GET', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method)) {
      return next();
    }

    const contentType = req.headers['content-type'];
    
    if (!contentType) {
      logger.warn('Missing Content-Type header', {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      
      return next(new BadRequestAppError('Content-Type header is required'));
    }

    // Extract the main content type (ignore charset and other parameters)
    const contentTypeString = Array.isArray(contentType) ? contentType[0] : contentType;
    const mainContentType = contentTypeString.split(';')[0].trim().toLowerCase();
    
    if (!allowedTypes.some(type => mainContentType === type.toLowerCase())) {
      logger.warn('Invalid Content-Type', {
        contentType: mainContentType,
        allowed: allowedTypes,
        path: req.path,
        ip: req.ip,
      });
      
      return next(new BadRequestAppError(
        `Invalid Content-Type. Allowed types: ${allowedTypes.join(', ')}`
      ));
    }

    next();
  };
}

/**
 * File upload validation middleware
 */
export function createFileUploadValidator(
  logger: Logger,
  options: {
    maxFileSize?: number;
    allowedTypes?: string[];
    maxFiles?: number;
  } = {}
) {
  const {
    maxFileSize = 5 * 1024 * 1024, // 5MB
    allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'text/csv', 'application/json'],
    maxFiles = 1,
  } = options;

  return (req: Request, _res: Response, next: NextFunction) => {
    const files = req.files;
    const file = req.file;

    // Check if files were uploaded
    if (!files && !file) {
      return next();
    }

    const filesToCheck = file ? [file] : (Array.isArray(files) ? files : Object.values(files || {}).flat());

    // Validate number of files
    if (filesToCheck.length > maxFiles) {
      logger.warn('Too many files uploaded', {
        count: filesToCheck.length,
        maxAllowed: maxFiles,
        path: req.path,
        ip: req.ip,
      });
      
      return next(new BadRequestAppError(
        `Too many files. Maximum allowed: ${maxFiles}`
      ));
    }

    // Validate each file
    for (const uploadedFile of filesToCheck) {
      // Check file size
      if (uploadedFile.size > maxFileSize) {
        logger.warn('File too large', {
          filename: uploadedFile.originalname,
          size: uploadedFile.size,
          maxAllowed: maxFileSize,
          path: req.path,
          ip: req.ip,
        });
        
        return next(new BadRequestAppError(
          `File too large: ${uploadedFile.originalname}. Maximum size: ${maxFileSize / (1024 * 1024)}MB`
        ));
      }

      // Check file type
      if (!allowedTypes.includes(uploadedFile.mimetype)) {
        logger.warn('Invalid file type', {
          filename: uploadedFile.originalname,
          mimetype: uploadedFile.mimetype,
          allowed: allowedTypes,
          path: req.path,
          ip: req.ip,
        });
        
        return next(new BadRequestAppError(
          `Invalid file type: ${uploadedFile.mimetype}. Allowed types: ${allowedTypes.join(', ')}`
        ));
      }

      // Check filename for suspicious patterns
      if (uploadedFile.originalname.includes('..') || 
          uploadedFile.originalname.includes('/') || 
          uploadedFile.originalname.includes('\\')) {
        logger.warn('Suspicious filename', {
          filename: uploadedFile.originalname,
          path: req.path,
          ip: req.ip,
        });
        
        return next(new BadRequestAppError(
          'Invalid filename detected'
        ));
      }
    }

    next();
  };
}

/**
 * URL parameter validation middleware
 */
export function createUrlParameterValidator(
  logger: Logger,
  paramValidations: Record<string, {
    required?: boolean;
    pattern?: RegExp;
    maxLength?: number;
    allowedValues?: string[];
  }>
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const [paramName, validation] of Object.entries(paramValidations)) {
      const paramValue = req.params[paramName];
      
      // Check if required parameter is missing
      if (validation.required && !paramValue) {
        return next(new BadRequestAppError(
          `Required parameter missing: ${paramName}`
        ));
      }
      
      if (paramValue) {
        // Check length
        if (validation.maxLength && paramValue.length > validation.maxLength) {
          logger.warn('Parameter too long', {
            param: paramName,
            length: paramValue.length,
            maxLength: validation.maxLength,
            path: req.path,
            ip: req.ip,
          });
          
          return next(new BadRequestAppError(
            `Parameter too long: ${paramName}. Maximum length: ${validation.maxLength}`
          ));
        }
        
        // Check pattern
        if (validation.pattern && !validation.pattern.test(paramValue)) {
          logger.warn('Parameter format invalid', {
            param: paramName,
            value: paramValue.substring(0, 50), // Log only first 50 chars
            pattern: validation.pattern.toString(),
            path: req.path,
            ip: req.ip,
          });
          
          return next(new BadRequestAppError(
            `Invalid format for parameter: ${paramName}`
          ));
        }
        
        // Check allowed values
        if (validation.allowedValues && !validation.allowedValues.includes(paramValue)) {
          logger.warn('Parameter value not allowed', {
            param: paramName,
            value: paramValue,
            allowedValues: validation.allowedValues,
            path: req.path,
            ip: req.ip,
          });
          
          return next(new BadRequestAppError(
            `Invalid value for parameter: ${paramName}. Allowed values: ${validation.allowedValues.join(', ')}`
          ));
        }
      }
    }
    
    next();
  };
}