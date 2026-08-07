/**
 * Modular Security Middleware
 * 
 * This module provides a comprehensive, modular security middleware system
 * that can be composed based on specific requirements.
 */

// Export individual modules
export { createInputSanitizer, htmlEncode, urlEncode, sanitizeCSSValue } from './sanitization';
export { 
  createRequestSizeValidator,
  createContentTypeValidator,
  createFileUploadValidator,
  createUrlParameterValidator 
} from './validation';
export { 
  createSQLInjectionProtection,
  createXSSProtection,
  createPathTraversalProtection,
  createRateLimitProtection,
  createCSRFProtection 
} from './protection';
export { 
  createApiKeyValidator,
  createJWTValidator,
  createBasicAuthValidator,
  createSessionValidator,
  createRoleValidator,
  createPermissionValidator 
} from './authentication';

// Export factory and types
export { SecurityMiddlewareFactory } from './SecurityMiddlewareFactory';
export type { SecurityOptions } from './SecurityMiddlewareFactory';

// Convenience function to create a pre-configured factory
import { SecurityMiddlewareFactory } from './SecurityMiddlewareFactory';
import type { Logger } from '../../utils/Logger';

export function createSecurityFactory(logger: Logger): SecurityMiddlewareFactory {
  return new SecurityMiddlewareFactory(logger);
}