import { AppError } from './AppError';

export class NotFoundError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 404, 'NOT_FOUND', true, cause);
  }
}
