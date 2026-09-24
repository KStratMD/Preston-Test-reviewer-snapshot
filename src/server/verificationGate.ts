import type { NextFunction, Request, Response } from 'express';

export const VERIFICATION_HEALTH_PATHS = new Set(['/health', '/health/ready', '/ready', '/health/live']);

export function verificationOnlyGate(req: Request, res: Response, next: NextFunction): void {
  if (VERIFICATION_HEALTH_PATHS.has(req.path) && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) {
    next();
    return;
  }
  res.setHeader('Retry-After', '5');
  res.status(503).json({ status: 'verification_only' });
}
