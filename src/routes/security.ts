import { Router, type Request, type Response } from 'express';
import type { SecurityMonitor } from '../services/SecurityMonitor';
import type { RBACService } from '../services/RBACService';
import type { SecretManager } from '../services/SecretManager';
import { Logger } from '../utils/Logger';
import { sendError } from '../utils/errorResponse';
import { requirePermission, requireAdmin } from '../middleware/rbac';
// import { validateApiKey } from '../middleware/security';

const logger = new Logger('SecurityRoutes');

// Helper to get service instances
let securityMonitorInstance: SecurityMonitor | null = null;
let rbacServiceInstance: RBACService | null = null;
let secretManagerInstance: SecretManager | null = null;

export function setSecurityServiceInstances(
  securityMonitor: SecurityMonitor,
  rbacService: RBACService,
  secretManager: SecretManager,
): void {
  securityMonitorInstance = securityMonitor;
  rbacServiceInstance = rbacService;
  secretManagerInstance = secretManager;
}

function getSecurityServices() {
  if (!securityMonitorInstance || !rbacServiceInstance || !secretManagerInstance) {
    throw new Error('Security services not initialized');
  }
  return {
    securityMonitor: securityMonitorInstance,
    rbacService: rbacServiceInstance,
    secretManager: secretManagerInstance,
  };
}

const router = Router();

import { asyncHandler } from '../middleware/asyncHandler';

// Security dashboard - overview of security status
router.get('/dashboard', requirePermission('monitoring', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { securityMonitor } = getSecurityServices();

  const timeRange = {
    start: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
    end: new Date(),
  };

  const metrics = securityMonitor.getSecurityMetrics(timeRange);
  const recentEvents = securityMonitor.getRecentEvents(50);
  const activeAlerts = securityMonitor.getActiveAlerts();
  const quarantinedIPs = securityMonitor.getQuarantinedIPs();

  res.json({
    metrics,
    // Strip sensitive `details` via destructuring so the dashboard payload
    // never carries it. Using a rest spread avoids a type-assertion escape
    // hatch that could silently re-admit the field later.
    recentEvents: recentEvents.map(({ details: _details, ...event }) => event),
    activeAlerts,
    quarantinedIPs: quarantinedIPs.length,
    status: 'healthy',
    lastUpdated: new Date().toISOString(),
  });
}));

// Get security events with filtering
router.get('/events', requirePermission('monitoring', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { securityMonitor } = getSecurityServices();

  const limit = parseInt(req.query.limit as string) || 100;
  const severity = req.query.severity as 'low' | 'medium' | 'high' | 'critical' | undefined;
  const type = req.query.type as string | undefined;

  let events = securityMonitor.getRecentEvents(limit, severity);

  if (type) {
    events = events.filter(event => event.type === type);
  }

  res.json({
    events,
    total: events.length,
    filters: { limit, severity, type },
  });
}));

// Get security metrics
router.get('/metrics', requirePermission('monitoring', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { securityMonitor } = getSecurityServices();

  const startDate = req.query.start ? new Date(req.query.start as string) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const endDate = req.query.end ? new Date(req.query.end as string) : new Date();

  const metrics = securityMonitor.getSecurityMetrics({ start: startDate, end: endDate });

  res.json({
    metrics,
    timeRange: { start: startDate, end: endDate },
  });
}));

// Get active security alerts
router.get('/alerts', requirePermission('monitoring', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { securityMonitor } = getSecurityServices();

  const activeAlerts = securityMonitor.getActiveAlerts();

  res.json({
    alerts: activeAlerts,
    count: activeAlerts.length,
  });
}));

// Acknowledge a security alert
router.post('/alerts/:alertId/acknowledge', requirePermission('monitoring', 'write'), asyncHandler(async (req: Request, res: Response) => {
  const { securityMonitor } = getSecurityServices();
  const { alertId } = req.params;
  if (!alertId) {
    sendError(res, 400, { code: 'INVALID_ALERT_ID', message: 'Alert ID is required' }, req);
    return;
  }
  const acknowledgedBy = req.user?.id || 'unknown';

  const success = securityMonitor.acknowledgeAlert(alertId, acknowledgedBy);

  if (success) {
    logger.info('Security alert acknowledged', {
      alertId,
      acknowledgedBy,
      ip: req.ip,
    });
    res.json({ success: true, message: 'Alert acknowledged successfully' });
  } else {
    sendError(res, 404, { code: 'ALERT_NOT_FOUND', message: 'Alert not found' }, req);
  }
}));

// Get quarantined IPs
router.get('/quarantine', requirePermission('monitoring', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { securityMonitor } = getSecurityServices();

  const quarantinedIPs = securityMonitor.getQuarantinedIPs();

  res.json({
    quarantinedIPs,
    count: quarantinedIPs.length,
  });
}));

// Release IP from quarantine
router.post('/quarantine/:ip/release', requirePermission('monitoring', 'write'), asyncHandler(async (req: Request, res: Response) => {
  const { securityMonitor } = getSecurityServices();
  const { ip } = req.params;
  if (!ip) {
    sendError(res, 400, { code: 'INVALID_IP', message: 'IP address is required' }, req);
    return;
  }
  const releasedBy = req.user?.id || 'unknown';

  securityMonitor.releaseIP(ip, releasedBy);

  logger.info('IP released from quarantine', {
    ip,
    releasedBy,
    requestIp: req.ip,
  });

  res.json({ success: true, message: 'IP released from quarantine' });
}));

// RBAC Management Routes

// Get all roles
router.get('/rbac/roles', requirePermission('role', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { rbacService } = getSecurityServices();

  const roles = rbacService.listRoles();

  res.json({
    roles,
    count: roles.length,
  });
}));

// Create new role
router.post('/rbac/roles', requirePermission('role', 'write'), asyncHandler(async (req: Request, res: Response) => {
  const { rbacService } = getSecurityServices();
  const { name, description, permissions } = req.body;

  if (!name || !description || !Array.isArray(permissions)) {
    sendError(res, 400, { code: 'INVALID_ROLE_DATA', message: 'Invalid role data. Required: name, description, permissions' }, req);
    return;
  }

  const role = await rbacService.createRole({
    name,
    description,
    permissions,
    isSystem: false,
  });

  logger.info('Role created', {
    roleId: role.id,
    roleName: role.name,
    createdBy: req.user?.id,
  });

  res.status(201).json({ role });
}));

// Update role
router.put('/rbac/roles/:roleId', requirePermission('role', 'write'), asyncHandler(async (req: Request, res: Response) => {
  const { rbacService } = getSecurityServices();
  const { roleId } = req.params;
  if (!roleId) {
    sendError(res, 400, { code: 'INVALID_ROLE_ID', message: 'Role ID is required' }, req);
    return;
  }
  const updates = req.body;

  const role = await rbacService.updateRole(roleId, updates);

  logger.info('Role updated', {
    roleId,
    updates: Object.keys(updates),
    updatedBy: req.user?.id,
  });

  res.json({ role });
}));

// Get all permissions
router.get('/rbac/permissions', requirePermission('role', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { rbacService } = getSecurityServices();

  const permissions = rbacService.listPermissions();

  res.json({
    permissions,
    count: permissions.length,
  });
}));

// Assign roles to user
router.post('/rbac/users/:userId/roles', requirePermission('role', 'assign'), asyncHandler(async (req: Request, res: Response) => {
  const { rbacService } = getSecurityServices();
  const { userId } = req.params;
  if (!userId) {
    sendError(res, 400, { code: 'INVALID_USER_ID', message: 'User ID is required' }, req);
    return;
  }
  const { roleIds } = req.body;

  if (!Array.isArray(roleIds)) {
    sendError(res, 400, { code: 'INVALID_ROLE_IDS', message: 'roleIds must be an array' }, req);
    return;
  }

  const user = await rbacService.assignRoles(userId, roleIds);

  logger.info('Roles assigned to user', {
    targetUserId: userId,
    roleIds,
    assignedBy: req.user?.id,
  });

  res.json({ user });
}));

// Get user permissions
router.get('/rbac/users/:userId/permissions', requirePermission('user', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { rbacService } = getSecurityServices();
  const { userId } = req.params;
  if (!userId) {
    sendError(res, 400, { code: 'INVALID_USER_ID', message: 'User ID is required' }, req);
    return;
  }

  const permissions = rbacService.getUserPermissions(userId);
  const user = rbacService.getUser(userId);

  if (!user) {
    sendError(res, 404, { code: 'USER_NOT_FOUND', message: 'User not found' }, req);
    return;
  }

  res.json({
    userId,
    permissions,
    roles: user.roles,
    permissionCount: permissions.length,
  });
}));

// Generate access report
router.get('/rbac/access-report', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { rbacService } = getSecurityServices();

  const report = rbacService.generateAccessReport();

  res.json({
    report,
    generatedAt: new Date().toISOString(),
    generatedBy: req.user?.id,
  });
}));

// Secret Management Routes

// List secret names (not values)
router.get('/secrets', requirePermission('secret', 'read'), asyncHandler(async (req: Request, res: Response) => {
  const { secretManager } = getSecurityServices();

  const secretNames = await secretManager.listSecrets();
  const cacheStats = secretManager.getCacheStats();

  res.json({
    secrets: secretNames,
    count: secretNames.length,
    cacheStats,
  });
}));

// Rotate a secret
router.post('/secrets/:secretName/rotate', requirePermission('secret', 'rotate'), asyncHandler(async (req: Request, res: Response) => {
  const { secretManager } = getSecurityServices();
  const { secretName } = req.params;
  if (!secretName) {
    sendError(res, 400, { code: 'INVALID_SECRET_NAME', message: 'Secret name is required' }, req);
    return;
  }

  const rotatedSecret = await secretManager.rotateSecret(secretName);

  logger.info('Secret rotated', {
    secretName,
    rotatedBy: req.user?.id,
    version: rotatedSecret.version,
  });

  res.json({
    success: true,
    message: 'Secret rotated successfully',
    version: rotatedSecret.version,
    lastUpdated: rotatedSecret.lastUpdated,
  });
}));

// Clear secret cache
router.post('/secrets/cache/clear', requirePermission('secret', 'write'), asyncHandler(async (req: Request, res: Response) => {
  const { secretManager } = getSecurityServices();
  const { secretName } = req.body;

  // Note: Stub implementation doesn't support per-secret cache clearing
  secretManager.clearCache();
  logger.info('Secret cache cleared', {
    secretName: secretName || 'all',
    clearedBy: req.user?.id,
  });

  res.json({
    success: true,
    message: secretName ? `Cache cleared for ${secretName}` : 'All secret cache cleared',
  });
}));

// Security audit endpoint
router.get('/audit/user/:userId', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { rbacService } = getSecurityServices();
  const { userId } = req.params;
  if (!userId) {
    sendError(res, 400, { code: 'INVALID_USER_ID', message: 'User ID is required' }, req);
    return;
  }
  const { start, end } = req.query;

  const timeRange = start && end ? {
    start: new Date(start as string),
    end: new Date(end as string),
  } : undefined;

  const auditReport = await rbacService.auditUserAccess(userId, timeRange);

  logger.info('User access audit performed', {
    targetUserId: userId,
    auditedBy: req.user?.id,
    timeRange,
  });

  res.json({
    audit: auditReport,
    auditedAt: new Date().toISOString(),
    auditedBy: req.user?.id,
  });
}));

export { router as securityRouter };
