import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { SecretManager } from './SecretManager';

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  email: string;
  roles: string[];
  isActive: boolean;
  lastLogin?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Permission {
  id: string;
  resource: string;
  action: string;
  description: string;
}

export interface AccessContext {
  userId: string;
  resource: string;
  action: string;
  metadata?: Record<string, unknown>;
}

/**
 * Role-Based Access Control (RBAC) service for fine-grained permissions
 */
@injectable()
export class RBACService {
  private readonly logger: Logger;
  private readonly secretManager: SecretManager;
  private readonly roles = new Map<string, Role>();
  private readonly users = new Map<string, User>();
  private readonly permissions = new Map<string, Permission>();

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.SecretManager) secretManager: SecretManager,
  ) {
    this.logger = logger;
    this.secretManager = secretManager;
    this.initializeDefaultRoles();
    this.initializeDefaultPermissions();
  }

  /**
   * Initialize default system roles
   */
  private initializeDefaultRoles(): void {
    const defaultRoles: Role[] = [
      {
        id: 'admin',
        name: 'Administrator',
        description: 'Full system access',
        permissions: ['*'],
        isSystem: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'integration_manager',
        name: 'Integration Manager',
        description: 'Manage integrations and configurations',
        permissions: [
          'integration:read',
          'integration:write',
          'integration:execute',
          'config:read',
          'config:write',
          'connector:read',
          'connector:write',
        ],
        isSystem: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'operator',
        name: 'System Operator',
        description: 'Monitor and operate integrations',
        permissions: [
          'integration:read',
          'integration:execute',
          'monitoring:read',
          'logs:read',
          'health:read',
        ],
        isSystem: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'viewer',
        name: 'Read-Only Viewer',
        description: 'View-only access to system information',
        permissions: [
          'integration:read',
          'config:read',
          'monitoring:read',
          'logs:read',
          'health:read',
        ],
        isSystem: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'service_account',
        name: 'Service Account',
        description: 'Automated service access',
        permissions: [
          'integration:execute',
          'health:read',
          'api:read',
          'api:write',
        ],
        isSystem: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    defaultRoles.forEach(role => {
      this.roles.set(role.id, role);
    });

    this.logger.info('Default RBAC roles initialized', {
      roleCount: defaultRoles.length,
      roles: defaultRoles.map(r => r.name),
    });
  }

  /**
   * Initialize default system permissions
   */
  private initializeDefaultPermissions(): void {
    const defaultPermissions: Permission[] = [
      // Integration permissions
      { id: 'integration:read', resource: 'integration', action: 'read', description: 'View integration configurations' },
      { id: 'integration:write', resource: 'integration', action: 'write', description: 'Modify integration configurations' },
      { id: 'integration:execute', resource: 'integration', action: 'execute', description: 'Execute integration workflows' },
      { id: 'integration:delete', resource: 'integration', action: 'delete', description: 'Delete integrations' },

      // Configuration permissions
      { id: 'config:read', resource: 'config', action: 'read', description: 'View system configurations' },
      { id: 'config:write', resource: 'config', action: 'write', description: 'Modify system configurations' },

      // Connector permissions
      { id: 'connector:read', resource: 'connector', action: 'read', description: 'View connector configurations' },
      { id: 'connector:write', resource: 'connector', action: 'write', description: 'Modify connector configurations' },
      { id: 'connector:test', resource: 'connector', action: 'test', description: 'Test connector connections' },

      // Monitoring permissions
      { id: 'monitoring:read', resource: 'monitoring', action: 'read', description: 'View monitoring data' },
      { id: 'logs:read', resource: 'logs', action: 'read', description: 'View system logs' },
      { id: 'health:read', resource: 'health', action: 'read', description: 'View system health status' },

      // API permissions
      { id: 'api:read', resource: 'api', action: 'read', description: 'Read access to API endpoints' },
      { id: 'api:write', resource: 'api', action: 'write', description: 'Write access to API endpoints' },

      // User management permissions
      { id: 'user:read', resource: 'user', action: 'read', description: 'View user information' },
      { id: 'user:write', resource: 'user', action: 'write', description: 'Modify user information' },
      { id: 'user:delete', resource: 'user', action: 'delete', description: 'Delete users' },

      // Role management permissions
      { id: 'role:read', resource: 'role', action: 'read', description: 'View role configurations' },
      { id: 'role:write', resource: 'role', action: 'write', description: 'Modify role configurations' },
      { id: 'role:assign', resource: 'role', action: 'assign', description: 'Assign roles to users' },

      // Secret management permissions
      { id: 'secret:read', resource: 'secret', action: 'read', description: 'View secret names (not values)' },
      { id: 'secret:write', resource: 'secret', action: 'write', description: 'Store and modify secrets' },
      { id: 'secret:rotate', resource: 'secret', action: 'rotate', description: 'Rotate secret values' },
    ];

    defaultPermissions.forEach(permission => {
      this.permissions.set(permission.id, permission);
    });

    this.logger.info('Default RBAC permissions initialized', {
      permissionCount: defaultPermissions.length,
    });
  }

  /**
   * Check if a user has permission to perform an action
   */
  async hasPermission(context: AccessContext): Promise<boolean> {
    try {
      const user = this.users.get(context.userId);
      if (!user?.isActive) {
        this.logger.warn('Access denied for inactive or non-existent user', {
          userId: context.userId,
          resource: context.resource,
          action: context.action,
        });
        return false;
      }

      // Check user roles for required permission
      const requiredPermission = `${context.resource}:${context.action}`;

      for (const roleId of user.roles) {
        const role = this.roles.get(roleId);
        if (!role) continue;

        // Admin wildcard permission
        if (role.permissions.includes('*')) {
          this.logger.debug('Access granted via admin wildcard', {
            userId: context.userId,
            roleId,
            permission: requiredPermission,
          });
          return true;
        }

        // Specific permission check
        if (role.permissions.includes(requiredPermission)) {
          this.logger.debug('Access granted via specific permission', {
            userId: context.userId,
            roleId,
            permission: requiredPermission,
          });
          return true;
        }

        // Resource wildcard permission (e.g., integration:*)
        const resourceWildcard = `${context.resource}:*`;
        if (role.permissions.includes(resourceWildcard)) {
          this.logger.debug('Access granted via resource wildcard', {
            userId: context.userId,
            roleId,
            permission: requiredPermission,
            wildcard: resourceWildcard,
          });
          return true;
        }
      }

      this.logger.warn('Access denied - insufficient permissions', {
        userId: context.userId,
        userRoles: user.roles,
        requiredPermission,
        resource: context.resource,
        action: context.action,
      });

      return false;
    } catch (error) {
      this.logger.error('Error checking permissions', {
        error: error instanceof Error ? error.message : String(error),
        userId: context.userId,
        resource: context.resource,
        action: context.action,
      });
      return false;
    }
  }

  /**
   * Create a new role
   */
  async createRole(roleData: Omit<Role, 'id' | 'createdAt' | 'updatedAt'>): Promise<Role> {
    const roleId = roleData.name.toLowerCase().replace(/\s+/g, '_');

    if (this.roles.has(roleId)) {
      throw new Error(`Role '${roleId}' already exists`);
    }

    // Validate permissions exist
    const invalidPermissions = roleData.permissions.filter(p =>
      p !== '*' && !p.endsWith(':*') && !this.permissions.has(p),
    );

    if (invalidPermissions.length > 0) {
      throw new Error(`Invalid permissions: ${invalidPermissions.join(', ')}`);
    }

    const role: Role = {
      ...roleData,
      id: roleId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.roles.set(roleId, role);

    this.logger.info('Role created', {
      roleId,
      roleName: role.name,
      permissions: role.permissions,
    });

    return role;
  }

  /**
   * Update an existing role
   */
  async updateRole(roleId: string, updates: Partial<Omit<Role, 'id' | 'createdAt'>>): Promise<Role> {
    const existingRole = this.roles.get(roleId);
    if (!existingRole) {
      throw new Error(`Role '${roleId}' not found`);
    }

    if (existingRole.isSystem && updates.permissions) {
      throw new Error('Cannot modify permissions of system roles');
    }

    // Validate permissions if being updated
    if (updates.permissions) {
      const invalidPermissions = updates.permissions.filter(p =>
        p !== '*' && !p.endsWith(':*') && !this.permissions.has(p),
      );

      if (invalidPermissions.length > 0) {
        throw new Error(`Invalid permissions: ${invalidPermissions.join(', ')}`);
      }
    }

    const updatedRole: Role = {
      ...existingRole,
      ...updates,
      updatedAt: new Date(),
    };

    this.roles.set(roleId, updatedRole);

    this.logger.info('Role updated', {
      roleId,
      updates: Object.keys(updates),
    });

    return updatedRole;
  }

  /**
   * Create a new user
   */
  async createUser(userData: Omit<User, 'createdAt' | 'updatedAt'>): Promise<User> {
    if (this.users.has(userData.id)) {
      throw new Error(`User '${userData.id}' already exists`);
    }

    // Validate roles exist
    const invalidRoles = userData.roles.filter(roleId => !this.roles.has(roleId));
    if (invalidRoles.length > 0) {
      throw new Error(`Invalid roles: ${invalidRoles.join(', ')}`);
    }

    const user: User = {
      ...userData,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.users.set(userData.id, user);

    this.logger.info('User created', {
      userId: user.id,
      email: user.email,
      roles: user.roles,
    });

    return user;
  }

  /**
   * Assign roles to a user
   */
  async assignRoles(userId: string, roleIds: string[]): Promise<User> {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User '${userId}' not found`);
    }

    // Validate roles exist
    const invalidRoles = roleIds.filter(roleId => !this.roles.has(roleId));
    if (invalidRoles.length > 0) {
      throw new Error(`Invalid roles: ${invalidRoles.join(', ')}`);
    }

    const updatedUser: User = {
      ...user,
      roles: [...new Set([...user.roles, ...roleIds])], // Merge and deduplicate
      updatedAt: new Date(),
    };

    this.users.set(userId, updatedUser);

    this.logger.info('Roles assigned to user', {
      userId,
      newRoles: roleIds,
      allRoles: updatedUser.roles,
    });

    return updatedUser;
  }

  /**
   * Remove roles from a user
   */
  async removeRoles(userId: string, roleIds: string[]): Promise<User> {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User '${userId}' not found`);
    }

    const updatedUser: User = {
      ...user,
      roles: user.roles.filter(roleId => !roleIds.includes(roleId)),
      updatedAt: new Date(),
    };

    this.users.set(userId, updatedUser);

    this.logger.info('Roles removed from user', {
      userId,
      removedRoles: roleIds,
      remainingRoles: updatedUser.roles,
    });

    return updatedUser;
  }

  /**
   * Get user by ID
   */
  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  /**
   * Get role by ID
   */
  getRole(roleId: string): Role | undefined {
    return this.roles.get(roleId);
  }

  /**
   * List all roles
   */
  listRoles(): Role[] {
    return Array.from(this.roles.values());
  }

  /**
   * List all permissions
   */
  listPermissions(): Permission[] {
    return Array.from(this.permissions.values());
  }

  /**
   * Get effective permissions for a user
   */
  getUserPermissions(userId: string): string[] {
    const user = this.users.get(userId);
    if (!user) {
      return [];
    }

    const permissions = new Set<string>();

    for (const roleId of user.roles) {
      const role = this.roles.get(roleId);
      if (role) {
        role.permissions.forEach(permission => permissions.add(permission));
      }
    }

    return Array.from(permissions);
  }

  /**
   * Audit user access
   */
  async auditUserAccess(userId: string, timeRange?: { start: Date; end: Date }): Promise<{
    user: User;
    roles: Role[];
    permissions: string[];
    recentActivity: unknown[]; // Would be populated from audit logs
  }> {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User '${userId}' not found`);
    }

    const roles = user.roles.map(roleId => this.roles.get(roleId)).filter(Boolean) as Role[];
    const permissions = this.getUserPermissions(userId);

    // In a full implementation, this would query audit logs
    const recentActivity: unknown[] = [];

    this.logger.info('User access audit performed', {
      userId,
      roleCount: roles.length,
      permissionCount: permissions.length,
      timeRange,
    });

    return {
      user,
      roles,
      permissions,
      recentActivity,
    };
  }

  /**
   * Generate access report for all users
   */
  generateAccessReport(): {
    totalUsers: number;
    totalRoles: number;
    totalPermissions: number;
    usersByRole: Record<string, number>;
    unusedRoles: string[];
    systemRoles: string[];
    } {
    const totalUsers = this.users.size;
    const totalRoles = this.roles.size;
    const totalPermissions = this.permissions.size;

    // Count users by role
    const usersByRole: Record<string, number> = {};
    const usedRoles = new Set<string>();

    this.users.forEach(user => {
      user.roles.forEach(roleId => {
        usedRoles.add(roleId);
        usersByRole[roleId] = (usersByRole[roleId] || 0) + 1;
      });
    });

    // Find unused roles
    const unusedRoles = Array.from(this.roles.keys()).filter(roleId => !usedRoles.has(roleId));

    // List system roles
    const systemRoles = Array.from(this.roles.values())
      .filter(role => role.isSystem)
      .map(role => role.id);

    this.logger.info('Access report generated', {
      totalUsers,
      totalRoles,
      totalPermissions,
      unusedRoleCount: unusedRoles.length,
    });

    return {
      totalUsers,
      totalRoles,
      totalPermissions,
      usersByRole,
      unusedRoles,
      systemRoles,
    };
  }
}
