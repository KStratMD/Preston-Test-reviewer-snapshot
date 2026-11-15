import { Request, Response, NextFunction } from 'express';
import type { Logger } from '../utils/Logger';

export const errorHandler = (logger: Logger) => (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error('An unexpected error occurred', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred. Please try again later.',
  });
};