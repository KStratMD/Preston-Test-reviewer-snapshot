export abstract class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly errorCode: string;
  public readonly timestamp: Date;

  constructor(
    message: string,
    statusCode: number,
    errorCode: string,
    isOperational = true,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.errorCode = errorCode;
    this.timestamp = new Date();

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      errorCode: this.errorCode,
      timestamp: this.timestamp.toISOString(),
      isOperational: this.isOperational,
      ...(this.cause && { cause: this.cause.message }),
    };
  }

  public static isAppError(error: unknown): error is AppError {
    return error instanceof AppError;
  }
}

export class ValidationAppError extends AppError {
  constructor(message: string, public readonly validationErrors: string[], cause?: Error) {
    super(message, 400, 'VALIDATION_ERROR', true, cause);
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      validationErrors: this.validationErrors,
    };
  }
}

export class NotFoundAppError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 404, 'NOT_FOUND', true, cause);
  }
}

export class UnauthorizedAppError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 401, 'UNAUTHORIZED', true, cause);
  }
}

export class ForbiddenAppError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 403, 'FORBIDDEN', true, cause);
  }
}

export class ConflictAppError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 409, 'CONFLICT', true, cause);
  }
}

export class InternalServerAppError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 500, 'INTERNAL_SERVER_ERROR', true, cause);
  }
}

export class BadRequestAppError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 400, 'BAD_REQUEST', true, cause);
  }
}

export class ServiceUnavailableAppError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 503, 'SERVICE_UNAVAILABLE', true, cause);
  }
}
