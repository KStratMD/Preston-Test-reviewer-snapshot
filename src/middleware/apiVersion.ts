import { Request, Response, NextFunction } from 'express';

export interface VersionedRequest extends Request {
  apiVersion?: string;
}

export const API_VERSIONS = {
  V1: 'v1',
  V2: 'v2',
  DEFAULT: 'v1'
} as const;

export type ApiVersion = typeof API_VERSIONS[keyof typeof API_VERSIONS];

/**
 * Middleware to extract API version from URL or header
 */
export function apiVersionMiddleware(req: VersionedRequest, _res: Response, next: NextFunction): void {
  // Check URL path for version
  const pathMatch = req.path.match(/^\/api\/(v\d+)\//);
  if (pathMatch) {
    req.apiVersion = pathMatch[1];
  } else {
    // Check header for version
    const headerVersion = req.headers['api-version'] || req.headers['x-api-version'];
    if (headerVersion && typeof headerVersion === 'string') {
      req.apiVersion = headerVersion;
    } else {
      // Use default version
      req.apiVersion = API_VERSIONS.DEFAULT;
    }
  }
  
  next();
}

/**
 * Route handler wrapper that checks API version
 */
export function versionedRoute(
  handlers: Record<ApiVersion, (req: Request, res: Response, next: NextFunction) => void | Promise<void>>
) {
  return async (req: VersionedRequest, res: Response, next: NextFunction): Promise<void> => {
    const version = req.apiVersion || API_VERSIONS.DEFAULT;
    const handler = handlers[version as ApiVersion];
    
    if (!handler) {
      res.status(400).json({
        error: 'unsupported_api_version',
        message: `API version ${version} is not supported`,
        supported_versions: Object.values(API_VERSIONS)
      });
      return;
    }
    
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}