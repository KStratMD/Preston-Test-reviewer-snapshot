import { Router, type Request } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { MCPPolicyService, MCPPolicyAction } from '../services/mcp/MCPPolicyService';

interface MCPPolicyRouterDeps {
  policyService?: MCPPolicyService;
  logger?: Logger;
}

function isAdminRequest(req: Request): boolean {
  const userRoles = req.user?.roles;
  const userPermissions = req.user?.permissions;
  const roles: string[] = Array.isArray(userRoles) ? userRoles : [];
  const permissions: string[] = Array.isArray(userPermissions) ? userPermissions : [];
  return roles.includes('admin') || permissions.includes('*');
}

function resolveAdminHeaderTenant(req: Request): string | undefined {
  if (!isAdminRequest(req)) {
    return undefined;
  }

  const headerTenant = req.headers['x-tenant-id'];
  if (typeof headerTenant === 'string' && headerTenant.trim().length > 0) {
    return headerTenant.trim();
  }

  const headerOrg = req.headers['x-organization-id'];
  if (typeof headerOrg === 'string' && headerOrg.trim().length > 0) {
    return headerOrg.trim();
  }

  return undefined;
}

function resolveTenantId(req: Request): string {
  const authTenantId = req.auth?.tenantId;
  if (typeof authTenantId === 'string' && authTenantId.trim().length > 0) {
    return authTenantId.trim();
  }

  const contextTenantId = req.tenantContext?.tenantId;
  if (typeof contextTenantId === 'string' && contextTenantId.trim().length > 0) {
    return contextTenantId.trim();
  }

  const userTenantId = req.user?.tenantId;
  if (typeof userTenantId === 'string' && userTenantId.trim().length > 0) {
    return userTenantId.trim();
  }

  const userId = req.user?.id;
  if (typeof userId === 'string' && userId.trim().length > 0) {
    return userId.trim();
  }

  if (typeof userId === 'number') {
    return String(userId);
  }

  const adminHeaderTenant = resolveAdminHeaderTenant(req);
  if (adminHeaderTenant) {
    return adminHeaderTenant;
  }

  return 'default';
}

function resolveRequestedTenantId(req: Request): string {
  const queryTenantId = req.query?.tenantId;
  const bodyTenantId = req.body?.tenantId;
  const requested = typeof queryTenantId === 'string'
    ? queryTenantId.trim()
    : (typeof bodyTenantId === 'string' ? bodyTenantId.trim() : '');

  if (requested.length === 0) {
    return resolveTenantId(req);
  }

  if (!isAdminRequest(req)) {
    throw new Error('forbidden_tenant_override');
  }

  return requested;
}

export async function createMCPPolicyRouter(deps?: MCPPolicyRouterDeps): Promise<Router> {
  const router = Router();
  const logger = deps?.logger || container.get<Logger>(TYPES.Logger);

  if (!deps?.policyService && !container.isBound(TYPES.MCPPolicyService)) {
    router.use((_req, res) => {
      res.status(503).json({
        success: false,
        error: 'service_unavailable',
        message: 'MCP policy service is unavailable in this runtime configuration.',
      });
    });
    return router;
  }

  const policyService = deps?.policyService || container.get<MCPPolicyService>(TYPES.MCPPolicyService);

  // GET /api/mcp/policies
  router.get('/policies', async (req, res, next) => {
    try {
      const tenantId = resolveRequestedTenantId(req);
      const policy = await policyService.getPolicy(tenantId);

      res.json({
        success: true,
        tenantId,
        policy,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden_tenant_override') {
        return res.status(403).json({
          success: false,
          error: 'forbidden',
          message: 'Only admin users can request policies for another tenant.',
        });
      }
      logger.error('Failed to fetch MCP policies', {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  // PUT /api/mcp/policies
  router.put('/policies', async (req, res, next) => {
    try {
      const tenantId = resolveRequestedTenantId(req);
      const { systemName, toolPattern, action } = req.body || {};

      if (typeof systemName !== 'string' || systemName.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'systemName is required and must be a non-empty string.',
        });
      }

      if (typeof toolPattern !== 'string' || toolPattern.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'toolPattern is required and must be a non-empty string.',
        });
      }

      if (action !== 'allow' && action !== 'deny') {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'action must be either "allow" or "deny".',
        });
      }

      const policy = await policyService.upsertToolPolicy({
        tenantId,
        systemName,
        toolPattern,
        action: action as MCPPolicyAction,
      });

      res.json({
        success: true,
        tenantId,
        policy,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden_tenant_override') {
        return res.status(403).json({
          success: false,
          error: 'forbidden',
          message: 'Only admin users can mutate policies for another tenant.',
        });
      }
      logger.error('Failed to upsert MCP policy', {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  // DELETE /api/mcp/policies/:id
  router.delete('/policies/:id', async (req, res, next) => {
    try {
      const tenantId = resolveRequestedTenantId(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'id must be a positive integer.',
        });
      }

      const deleted = await policyService.deleteToolPolicy(id, tenantId);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: 'not_found',
          message: 'Policy rule not found for the specified tenant.',
        });
      }

      res.json({
        success: true,
        tenantId,
        deletedId: id,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden_tenant_override') {
        return res.status(403).json({
          success: false,
          error: 'forbidden',
          message: 'Only admin users can delete policies for another tenant.',
        });
      }
      logger.error('Failed to delete MCP policy', {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  return router;
}
