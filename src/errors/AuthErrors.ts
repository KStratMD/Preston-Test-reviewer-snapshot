import { AppError, UnauthorizedAppError } from './AppError';



export class TokenError extends UnauthorizedAppError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
  }
}

export class OAuth2Error extends AppError {
  constructor(
    message: string,
    statusCode = 401,
    public readonly errorResponse?: string,
    cause?: Error,
  ) {
    super(message, statusCode, 'OAUTH2_ERROR', true, cause);
  }

  public override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.errorResponse && { errorResponse: this.errorResponse }),
    };
  }
}

export class JWTError extends UnauthorizedAppError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
  }
}
