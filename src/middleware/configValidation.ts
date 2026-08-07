import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../utils/Logger';
import {
  validateIntegrationConfig,
  validateSystemAuthentication,
  type ConfigurationValidationResult,
} from '../schemas/configurationSchemas';
import { ValidationError } from '../errors/ConfigurationErrors';

export interface ValidatedRequest extends Request {
  validatedConfig?: unknown;
  validationResult?: ConfigurationValidationResult;
}

/**
 * Middleware to validate integration configuration requests
 */
export function validateConfigurationMiddleware(logger: Logger) {
  return (req: ValidatedRequest, res: Response, next: NextFunction): void => {
    try {
      const config = req.body;

      if (!config) {
        res.status(400).json({
          success: false,
          error: 'Configuration data is required',
          code: 'MISSING_CONFIG',
        });
        return;
      }

      // Validate the configuration using Zod schema
      const validationResult = validateIntegrationConfig(config);

      if (!validationResult.isValid) {
        logger.warn('Configuration validation failed', {
          errors: validationResult.errors,
          warnings: validationResult.warnings,
          configId: config.id || 'unknown',
        });

        res.status(400).json({
          success: false,
          error: 'Configuration validation failed',
          code: 'VALIDATION_ERROR',
          details: {
            errors: validationResult.errors,
            warnings: validationResult.warnings,
            fieldErrors: validationResult.fieldErrors,
          },
        });
        return;
      }

      // Additional system-specific validation
      const authValidationErrors: string[] = [];

      if (config.sourceAuthentication) {
        const sourceAuthResult = validateSystemAuthentication(
          config.sourceSystem,
          config.sourceAuthentication,
        );
        if (!sourceAuthResult.isValid) {
          authValidationErrors.push(...sourceAuthResult.errors.map(e => `Source: ${e}`));
        }
      }

      if (config.targetAuthentication) {
        const targetAuthResult = validateSystemAuthentication(
          config.targetSystem,
          config.targetAuthentication,
        );
        if (!targetAuthResult.isValid) {
          authValidationErrors.push(...targetAuthResult.errors.map(e => `Target: ${e}`));
        }
      }

      if (authValidationErrors.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Authentication configuration validation failed',
          code: 'AUTH_VALIDATION_ERROR',
          details: {
            errors: authValidationErrors,
          },
        });
        return;
      }

      // Log successful validation with warnings if any
      if (validationResult.warnings && validationResult.warnings.length > 0) {
        logger.warn('Configuration validation completed with warnings', {
          warnings: validationResult.warnings,
          configId: config.id,
        });
      } else {
        logger.info('Configuration validation successful', {
          configId: config.id,
          sourceSystem: config.sourceSystem,
          targetSystem: config.targetSystem,
        });
      }

      // Attach validated config and result to request for downstream use
      req.validatedConfig = config;
      req.validationResult = validationResult;

      next();
    } catch (error) {
      logger.error('Configuration validation middleware error', error);

      res.status(500).json({
        success: false,
        error: 'Internal validation error',
        code: 'VALIDATION_INTERNAL_ERROR',
      });
    }
  };
}

/**
 * Middleware to validate configuration updates (PATCH requests)
 */
export function validateConfigurationUpdateMiddleware(logger: Logger) {
  return (req: ValidatedRequest, res: Response, next: NextFunction): void => {
    try {
      const updates = req.body;

      if (!updates || Object.keys(updates).length === 0) {
        res.status(400).json({
          success: false,
          error: 'Update data is required',
          code: 'MISSING_UPDATES',
        });
        return;
      }

      // For updates, we allow partial configurations
      // Validate only the fields that are being updated
      const validationErrors: string[] = [];
      const validationWarnings: string[] = [];

      // Validate individual fields if they exist
      if (updates.id !== undefined) {
        if (typeof updates.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(updates.id)) {
          validationErrors.push('Invalid configuration ID format');
        }
      }

      if (updates.name !== undefined) {
        if (typeof updates.name !== 'string' || updates.name.length === 0) {
          validationErrors.push('Configuration name cannot be empty');
        } else if (updates.name.length > 200) {
          validationErrors.push('Configuration name cannot exceed 200 characters');
        }
      }

      if (updates.syncDirection !== undefined) {
        const validDirections = ['unidirectional', 'bidirectional', 'source_to_target', 'target_to_source'];
        if (!validDirections.includes(updates.syncDirection)) {
          validationErrors.push('Invalid sync direction');
        }
      }

      if (updates.syncMode !== undefined) {
        const validModes = ['realtime', 'batch', 'manual'];
        if (!validModes.includes(updates.syncMode)) {
          validationErrors.push('Invalid sync mode');
        }
      }

      if (updates.batchSize !== undefined) {
        if (typeof updates.batchSize !== 'number' || updates.batchSize < 1 || updates.batchSize > 10000) {
          validationErrors.push('Batch size must be between 1 and 10,000');
        }
      }

      // Validate authentication updates
      if (updates.sourceAuthentication) {
        const sourceSystem = updates.sourceSystem || req.params.sourceSystem;
        if (sourceSystem) {
          const authResult = validateSystemAuthentication(sourceSystem, updates.sourceAuthentication);
          if (!authResult.isValid) {
            validationErrors.push(...authResult.errors.map(e => `Source authentication: ${e}`));
          }
        }
      }

      if (updates.targetAuthentication) {
        const targetSystem = updates.targetSystem || req.params.targetSystem;
        if (targetSystem) {
          const authResult = validateSystemAuthentication(targetSystem, updates.targetAuthentication);
          if (!authResult.isValid) {
            validationErrors.push(...authResult.errors.map(e => `Target authentication: ${e}`));
          }
        }
      }

      if (validationErrors.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Configuration update validation failed',
          code: 'UPDATE_VALIDATION_ERROR',
          details: {
            errors: validationErrors,
            warnings: validationWarnings,
          },
        });
        return;
      }

      logger.info('Configuration update validation successful', {
        updatedFields: Object.keys(updates),
        configId: req.params.id,
      });

      req.validatedConfig = updates;
      next();
    } catch (error) {
      logger.error('Configuration update validation middleware error', error);

      res.status(500).json({
        success: false,
        error: 'Internal validation error',
        code: 'VALIDATION_INTERNAL_ERROR',
      });
    }
  };
}

/**
 * Middleware to validate configuration IDs in URL parameters
 */
export function validateConfigurationIdMiddleware(_logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const configId = req.params.id;

    if (!configId) {
      res.status(400).json({
        success: false,
        error: 'Configuration ID is required',
        code: 'MISSING_CONFIG_ID',
      });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(configId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid configuration ID format',
        code: 'INVALID_CONFIG_ID',
      });
      return;
    }

    next();
  };
}

/**
 * Express error handler for validation errors
 */
export function configurationValidationErrorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof ValidationError) {
    interface HasDetails { details?: unknown }
    const details = (error as HasDetails).details ?? error.message;
    res.status(400).json({
      success: false,
      error: error.message,
      code: 'CONFIGURATION_VALIDATION_ERROR',
      details,
    });
    return;
  }

  // If it's not a validation error, pass it to the next error handler
  next(error);
}
