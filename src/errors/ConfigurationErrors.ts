import { AppError, ConflictAppError, ValidationAppError } from './AppError';



export class ValidationError extends ValidationAppError {
  constructor(
    message: string,
    errors: string[],
    cause?: Error,
  ) {
    super(message, errors, cause);
  }
}

export class ConfigurationLoadError extends AppError {
  constructor(
    message: string,
    public readonly fileName?: string,
    cause?: Error,
  ) {
    super(message, 500, 'CONFIGURATION_LOAD_ERROR', true, cause);
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.fileName && { fileName: this.fileName }),
    };
  }
}

export class ConfigurationSaveError extends AppError {
  constructor(
    message: string,
    public readonly configId?: string,
    cause?: Error,
  ) {
    super(message, 500, 'CONFIGURATION_SAVE_ERROR', true, cause);
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.configId && { configId: this.configId }),
    };
  }
}

/**
 * Thrown when a tenant-agnostic lookup (the deprecated `ConfigurationService.getConfiguration(id)`)
 * finds two or more matching configs across tenants. Once cross-tenant duplicate ids are valid
 * (PR 13c-4), there is no safe answer the caller can do anything with — fail loud rather than
 * return arbitrary first.
 *
 * Extends ConflictAppError so the global error handler emits a structured 409 instead of
 * falling through to a generic 500.
 */
export class ConfigurationLookupAmbiguousError extends ConflictAppError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'ConfigurationLookupAmbiguousError';
  }
}
