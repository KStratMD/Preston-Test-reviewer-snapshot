import { AppError, ValidationAppError } from './AppError';



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
