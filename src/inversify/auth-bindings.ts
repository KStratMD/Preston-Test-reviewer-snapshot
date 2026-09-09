import { Container } from 'inversify';
import { TYPES } from './types';
import { AuthenticationMiddleware } from '../middleware/authentication';
import { OAuth2Service } from '../security/OAuth2Service';
import { ApiKeyService } from '../security/ApiKeyService';
import { AuditLogRepository } from '../database/repositories/AuditLogRepository';

/**
 * Configure authentication-related inversify bindings
 *
 * This module registers:
 * - OAuth2Service: OAuth 2.0 / OIDC authentication
 * - ApiKeyService: API key validation and management
 * - AuditLogRepository: Audit logging for auth events
 * - AuthenticationMiddleware: Express middleware for route protection
 */
export function configureAuthBindings(container: Container): void {
  // OAuth2 Service
  container
    .bind<OAuth2Service>(TYPES.OAuth2Service)
    .to(OAuth2Service)
    .inSingletonScope();

  // API Key Service
  container
    .bind<ApiKeyService>(TYPES.ApiKeyService)
    .to(ApiKeyService)
    .inSingletonScope();

  // Audit Log Repository
  container
    .bind<AuditLogRepository>(TYPES.AuditLogRepository)
    .to(AuditLogRepository)
    .inSingletonScope();

  // Authentication Middleware
  container
    .bind<AuthenticationMiddleware>(TYPES.AuthenticationMiddleware)
    .to(AuthenticationMiddleware)
    .inSingletonScope();
}
