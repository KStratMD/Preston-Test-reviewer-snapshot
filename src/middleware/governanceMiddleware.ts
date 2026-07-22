/**
 * Centralized Governance Middleware
 * PR 1B: Consolidates per-route governance pre-checks into a single, reusable
 * Express middleware that runs at the router-mount boundary.
 *
 * When mounted on the proxy router, every AI request is validated through
 * GovernanceService.validateInput() before reaching any endpoint handler.
 *
 * NOTE: The existing proxy sub-routers (AgentRouter, MappingRouter, etc.)
 * already contain inline governance pre-checks. This middleware provides
 * a belt-and-suspenders layer for the newly-migrated routers that previously
 * had no governance at all. The inline checks in the original routers are
 * retained for defence-in-depth (they are idempotent).
 */

import { Request, Response, NextFunction } from 'express';
import type { GovernanceService } from '../services/ai/orchestrator/GovernanceService';
import type { Logger } from '../utils/Logger';
import { extractIdentityContext } from '../services/governance/identityContext';

export interface GovernanceMiddlewareOptions {
  /** GovernanceService instance (resolved from DI container). */
  governanceService: GovernanceService;
  /** Logger instance. */
  logger: Logger;
  /**
   * If true, the middleware will NOT block requests on governance failure
   * but will log a warning. Useful during migration to avoid breaking
   * read-only / metrics endpoints that don't forward input to LLMs.
   * Default: false.
   */
  auditOnly?: boolean;
}

/**
 * Creates an Express middleware that gates requests through GovernanceService.
 *
 * For POST/PUT/PATCH requests, `req.body` is validated.
 * For GET/DELETE requests, `req.query` is validated (these are typically
 * harmless, but the governance check provides a uniform audit trail).
 *
 * On governance block the middleware returns HTTP 400 with a structured
 * JSON response (matching the existing convention in proxy sub-routers).
 * On governance service failure — including when GovernanceService internally
 * catches and returns `{ approved: false, flags: ['validation_error'] }` —
 * the middleware falls through (fail-open) and logs a warning.
 */
export function createGovernanceMiddleware(options: GovernanceMiddlewareOptions) {
  const { governanceService, logger, auditOnly = false } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = ['POST', 'PUT', 'PATCH'].includes(req.method)
        ? {
            body: req.body ?? {},
            path: req.path,
            originalUrl: req.originalUrl,
          }
        : {
            query: req.query ?? {},
            path: req.path,
            originalUrl: req.originalUrl,
          };

      // C5: identity from verified sources only (req.auth / req.user /
      // req.tenantContext). Anonymous callers fall back to SYSTEM_IDENTITY.userId.
      const { userId } = extractIdentityContext(req);
      const sessionId = `gov_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

      const preCheck = await governanceService.validateInput(input ?? {}, {
        sessionId,
        userId,
        timestamp: new Date(),
        correlationId: (req.headers['x-correlation-id'] as string) || sessionId,
        sourceSystem: 'ai-proxy',
        targetSystem: 'ai-proxy',
        confidenceThreshold: 0.5,
        maxExecutionTime: 30000,
        metadata: {
          source: 'governance-middleware',
          path: req.originalUrl,
          method: req.method,
          userAgent: req.headers['user-agent'],
        },
      });

      if (!preCheck.approved) {
        // Detect GovernanceService internal errors surfaced as validation_error flags.
        // These are service failures, not policy denials — honour the fail-open contract.
        const isServiceError = preCheck.flags?.some(
          (f: string) => f === 'validation_error' || f === 'service_error'
        );

        if (isServiceError) {
          logger.warn('Governance service error treated as fail-open', {
            path: req.originalUrl,
            method: req.method,
            flags: preCheck.flags,
          });
          return next();
        }

        logger.warn('Governance middleware blocked request', {
          path: req.originalUrl,
          method: req.method,
          reason: preCheck.reason,
          flags: preCheck.flags,
          riskLevel: preCheck.riskLevel,
          auditOnly,
        });

        if (auditOnly) {
          // Log-only mode — don't block the request
          return next();
        }

        res.status(400).json({
          success: false,
          error: {
            type: 'governance_violation',
            message: preCheck.reason || 'Blocked by governance policy',
          },
          governance: {
            blocked: true,
            reason: preCheck.reason,
            flags: preCheck.flags,
            riskLevel: preCheck.riskLevel,
            complianceChecks: preCheck.complianceChecks,
          },
          metadata: {
            sessionId,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      next();
    } catch (error) {
      // Fail-open: governance service error should not block requests
      logger.error('Governance middleware error (fail-open)', {
        path: req.originalUrl,
        error: String(error),
      });
      next();
    }
  };
}
