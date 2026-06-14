/**
 * RBACService Tests
 * Tests for Role-Based Access Control
 */

import 'reflect-metadata';
import { RBACService, Role, User, AccessContext } from '../../../src/services/RBACService';

describe('RBACService', () => {
  let service: RBACService;
  let mockLogger: any;
  let mockSecretManager: any;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockSecretManager = {
      getSecret: jest.fn(),
      setSecret: jest.fn(),
    };

    service = new RBACService(mockLogger, mockSecretManager);
  });

  describe('initialization', () => {
    it('should initialize default roles', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('Default RBAC roles initialized', expect.any(Object));
    });

    it('should initialize default permissions', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('Default RBAC permissions initialized', expect.any(Object));
    });

    it('should create admin role', () => {
      const adminRole = service.getRole('admin');
      expect(adminRole).toBeDefined();
      expect(adminRole?.permissions).toContain('*');
      expect(adminRole?.isSystem).toBe(true);
    });

    it('should create integration_manager role', () => {
      const role = service.getRole('integration_manager');
      expect(role).toBeDefined();
      expect(role?.permissions).toContain('integration:read');
      expect(role?.permissions).toContain('integration:write');
    });

    it('should create operator role', () => {
      const role = service.getRole('operator');
      expect(role).toBeDefined();
      expect(role?.permissions).toContain('integration:execute');
      expect(role?.permissions).toContain('monitoring:read');
    });

    it('should create viewer role', () => {
      const role = service.getRole('viewer');
      expect(role).toBeDefined();
      expect(role?.permissions).toContain('integration:read');
      expect(role?.permissions).not.toContain('integration:write');
    });
  });

  describe('hasPermission', () => {
    beforeEach(async () => {
      await service.createUser({
        id: 'user-admin',
        email: 'admin@test.com',
        roles: ['admin'],
        isActive: true,
      });

      await service.createUser({
        id: 'user-viewer',
        email: 'viewer@test.com',
        roles: ['viewer'],
        isActive: true,
      });

      await service.createUser({
        id: 'user-inactive',
        email: 'inactive@test.com',
        roles: ['admin'],
        isActive: false,
      });
    });

    it('should grant access for admin wildcard', async () => {
      const context: AccessContext = {
        userId: 'user-admin',
        resource: 'integration',
        action: 'delete',
      };

      const result = await service.hasPermission(context);

      expect(result).toBe(true);
    });

    it('should grant access for specific permission', async () => {
      const context: AccessContext = {
        userId: 'user-viewer',
        resource: 'integration',
        action: 'read',
      };

      const result = await service.hasPermission(context);

      expect(result).toBe(true);
    });

    it('should deny access when permission not granted', async () => {
      const context: AccessContext = {
        userId: 'user-viewer',
        resource: 'integration',
        action: 'write',
      };

      const result = await service.hasPermission(context);

      expect(result).toBe(false);
    });

    it('should deny access for inactive user', async () => {
      const context: AccessContext = {
        userId: 'user-inactive',
        resource: 'integration',
        action: 'read',
      };

      const result = await service.hasPermission(context);

      expect(result).toBe(false);
    });

    it('should deny access for non-existent user', async () => {
      const context: AccessContext = {
        userId: 'non-existent',
        resource: 'integration',
        action: 'read',
      };

      const result = await service.hasPermission(context);

      expect(result).toBe(false);
    });

    it('should log access decisions', async () => {
      const context: AccessContext = {
        userId: 'user-viewer',
        resource: 'integration',
        action: 'write',
      };

      await service.hasPermission(context);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('insufficient permissions'),
        expect.any(Object)
      );
    });
  });

  describe('createRole', () => {
    it('should create new role', async () => {
      const role = await service.createRole({
        name: 'Custom Role',
        description: 'A custom role',
        permissions: ['integration:read'],
      });

      expect(role.id).toBe('custom_role');
      expect(role.name).toBe('Custom Role');
      expect(role.permissions).toContain('integration:read');
    });

    it('should throw when role already exists', async () => {
      await expect(
        service.createRole({
          name: 'Admin',
          description: 'Duplicate admin',
          permissions: [],
        })
      ).rejects.toThrow('already exists');
    });

    it('should throw for invalid permissions', async () => {
      await expect(
        service.createRole({
          name: 'Invalid Role',
          description: 'Has invalid permission',
          permissions: ['invalid:permission'],
        })
      ).rejects.toThrow('Invalid permissions');
    });

    it('should allow wildcard permissions', async () => {
      const role = await service.createRole({
        name: 'Super User',
        description: 'All access',
        permissions: ['*'],
      });

      expect(role.permissions).toContain('*');
    });

    it('should allow resource wildcard permissions', async () => {
      const role = await service.createRole({
        name: 'Integration Admin',
        description: 'Full integration access',
        permissions: ['integration:*'],
      });

      expect(role.permissions).toContain('integration:*');
    });

    it('should log role creation', async () => {
      await service.createRole({
        name: 'New Role',
        description: 'Test',
        permissions: ['integration:read'],
      });

      expect(mockLogger.info).toHaveBeenCalledWith('Role created', expect.objectContaining({
        roleId: 'new_role',
      }));
    });
  });

  describe('updateRole', () => {
    it('should update role description', async () => {
      await service.createRole({
        name: 'Test Role',
        description: 'Original',
        permissions: ['integration:read'],
      });

      const updated = await service.updateRole('test_role', {
        description: 'Updated description',
      });

      expect(updated.description).toBe('Updated description');
    });

    it('should throw for non-existent role', async () => {
      await expect(
        service.updateRole('non-existent', { description: 'Update' })
      ).rejects.toThrow('not found');
    });

    it('should throw when updating system role permissions', async () => {
      await expect(
        service.updateRole('admin', { permissions: ['integration:read'] })
      ).rejects.toThrow('Cannot modify permissions of system roles');
    });

    it('should validate updated permissions', async () => {
      await service.createRole({
        name: 'Test Role',
        description: 'Test',
        permissions: ['integration:read'],
      });

      await expect(
        service.updateRole('test_role', { permissions: ['invalid:permission'] })
      ).rejects.toThrow('Invalid permissions');
    });
  });

  describe('createUser', () => {
    it('should create new user', async () => {
      const user = await service.createUser({
        id: 'new-user',
        email: 'new@test.com',
        roles: ['viewer'],
        isActive: true,
      });

      expect(user.id).toBe('new-user');
      expect(user.email).toBe('new@test.com');
      expect(user.roles).toContain('viewer');
    });

    it('should throw when user already exists', async () => {
      await service.createUser({
        id: 'existing-user',
        email: 'existing@test.com',
        roles: ['viewer'],
        isActive: true,
      });

      await expect(
        service.createUser({
          id: 'existing-user',
          email: 'duplicate@test.com',
          roles: ['viewer'],
          isActive: true,
        })
      ).rejects.toThrow('already exists');
    });

    it('should throw for invalid roles', async () => {
      await expect(
        service.createUser({
          id: 'user-invalid-role',
          email: 'invalid@test.com',
          roles: ['non-existent-role'],
          isActive: true,
        })
      ).rejects.toThrow('Invalid roles');
    });

    it('should log user creation', async () => {
      await service.createUser({
        id: 'logged-user',
        email: 'logged@test.com',
        roles: ['viewer'],
        isActive: true,
      });

      expect(mockLogger.info).toHaveBeenCalledWith('User created', expect.objectContaining({
        userId: 'logged-user',
      }));
    });
  });

  describe('assignRoles', () => {
    beforeEach(async () => {
      await service.createUser({
        id: 'role-user',
        email: 'role@test.com',
        roles: ['viewer'],
        isActive: true,
      });
    });

    it('should assign additional roles to user', async () => {
      const user = await service.assignRoles('role-user', ['operator']);

      expect(user.roles).toContain('viewer');
      expect(user.roles).toContain('operator');
    });

    it('should not duplicate roles', async () => {
      const user = await service.assignRoles('role-user', ['viewer', 'operator']);

      const viewerCount = user.roles.filter(r => r === 'viewer').length;
      expect(viewerCount).toBe(1);
    });

    it('should throw for non-existent user', async () => {
      await expect(
        service.assignRoles('non-existent', ['viewer'])
      ).rejects.toThrow('not found');
    });

    it('should throw for invalid roles', async () => {
      await expect(
        service.assignRoles('role-user', ['invalid-role'])
      ).rejects.toThrow('Invalid roles');
    });
  });

  describe('removeRoles', () => {
    beforeEach(async () => {
      await service.createUser({
        id: 'multi-role-user',
        email: 'multi@test.com',
        roles: ['viewer', 'operator'],
        isActive: true,
      });
    });

    it('should remove roles from user', async () => {
      const user = await service.removeRoles('multi-role-user', ['operator']);

      expect(user.roles).toContain('viewer');
      expect(user.roles).not.toContain('operator');
    });

    it('should throw for non-existent user', async () => {
      await expect(
        service.removeRoles('non-existent', ['viewer'])
      ).rejects.toThrow('not found');
    });
  });

  describe('getUser and getRole', () => {
    it('should get user by ID', async () => {
      await service.createUser({
        id: 'get-user',
        email: 'get@test.com',
        roles: ['viewer'],
        isActive: true,
      });

      const user = service.getUser('get-user');

      expect(user).toBeDefined();
      expect(user?.email).toBe('get@test.com');
    });

    it('should return undefined for non-existent user', () => {
      const user = service.getUser('non-existent');
      expect(user).toBeUndefined();
    });

    it('should get role by ID', () => {
      const role = service.getRole('admin');

      expect(role).toBeDefined();
      expect(role?.name).toBe('Administrator');
    });

    it('should return undefined for non-existent role', () => {
      const role = service.getRole('non-existent');
      expect(role).toBeUndefined();
    });
  });

  describe('listRoles and listPermissions', () => {
    it('should list all roles', () => {
      const roles = service.listRoles();

      expect(roles.length).toBeGreaterThan(0);
      expect(roles.find(r => r.id === 'admin')).toBeDefined();
      expect(roles.find(r => r.id === 'viewer')).toBeDefined();
    });

    it('should list all permissions', () => {
      const permissions = service.listPermissions();

      expect(permissions.length).toBeGreaterThan(0);
      expect(permissions.find(p => p.id === 'integration:read')).toBeDefined();
    });
  });

  describe('getUserPermissions', () => {
    it('should get effective permissions for user', async () => {
      await service.createUser({
        id: 'perm-user',
        email: 'perm@test.com',
        roles: ['viewer'],
        isActive: true,
      });

      const permissions = service.getUserPermissions('perm-user');

      expect(permissions).toContain('integration:read');
      expect(permissions).toContain('monitoring:read');
    });

    it('should aggregate permissions from multiple roles', async () => {
      await service.createUser({
        id: 'multi-perm-user',
        email: 'multi-perm@test.com',
        roles: ['viewer', 'operator'],
        isActive: true,
      });

      const permissions = service.getUserPermissions('multi-perm-user');

      expect(permissions).toContain('integration:read');
      expect(permissions).toContain('integration:execute');
    });

    it('should return empty array for non-existent user', () => {
      const permissions = service.getUserPermissions('non-existent');
      expect(permissions).toEqual([]);
    });

    it('should deduplicate permissions', async () => {
      await service.createUser({
        id: 'dup-perm-user',
        email: 'dup-perm@test.com',
        roles: ['viewer', 'operator'],
        isActive: true,
      });

      const permissions = service.getUserPermissions('dup-perm-user');

      // Both roles have integration:read, should only appear once
      const readCount = permissions.filter(p => p === 'integration:read').length;
      expect(readCount).toBe(1);
    });
  });

  describe('auditUserAccess', () => {
    beforeEach(async () => {
      await service.createUser({
        id: 'audit-user',
        email: 'audit@test.com',
        roles: ['viewer', 'operator'],
        isActive: true,
      });
    });

    it('should return audit data for user', async () => {
      const audit = await service.auditUserAccess('audit-user');

      expect(audit.user).toBeDefined();
      expect(audit.user.id).toBe('audit-user');
      expect(audit.roles.length).toBe(2);
      expect(audit.permissions.length).toBeGreaterThan(0);
    });

    it('should throw for non-existent user', async () => {
      await expect(
        service.auditUserAccess('non-existent')
      ).rejects.toThrow('not found');
    });

    it('should log audit', async () => {
      await service.auditUserAccess('audit-user');

      expect(mockLogger.info).toHaveBeenCalledWith('User access audit performed', expect.any(Object));
    });
  });

  describe('generateAccessReport', () => {
    beforeEach(async () => {
      await service.createUser({
        id: 'report-user-1',
        email: 'report1@test.com',
        roles: ['viewer'],
        isActive: true,
      });
      await service.createUser({
        id: 'report-user-2',
        email: 'report2@test.com',
        roles: ['viewer', 'operator'],
        isActive: true,
      });
    });

    it('should generate access report', () => {
      const report = service.generateAccessReport();

      expect(report.totalUsers).toBe(2);
      expect(report.totalRoles).toBeGreaterThan(0);
      expect(report.totalPermissions).toBeGreaterThan(0);
    });

    it('should count users by role', () => {
      const report = service.generateAccessReport();

      expect(report.usersByRole.viewer).toBe(2);
      expect(report.usersByRole.operator).toBe(1);
    });

    it('should identify unused roles', () => {
      const report = service.generateAccessReport();

      // Admin role is not assigned to any user
      expect(report.unusedRoles).toContain('admin');
    });

    it('should list system roles', () => {
      const report = service.generateAccessReport();

      expect(report.systemRoles).toContain('admin');
      expect(report.systemRoles).toContain('viewer');
    });

    it('should log report generation', () => {
      service.generateAccessReport();

      expect(mockLogger.info).toHaveBeenCalledWith('Access report generated', expect.any(Object));
    });
  });

  describe('resource wildcard permissions', () => {
    beforeEach(async () => {
      await service.createRole({
        name: 'Integration Full',
        description: 'Full integration access',
        permissions: ['integration:*'],
      });

      await service.createUser({
        id: 'wildcard-user',
        email: 'wildcard@test.com',
        roles: ['integration_full'],
        isActive: true,
      });
    });

    it('should grant access via resource wildcard', async () => {
      const readResult = await service.hasPermission({
        userId: 'wildcard-user',
        resource: 'integration',
        action: 'read',
      });

      const writeResult = await service.hasPermission({
        userId: 'wildcard-user',
        resource: 'integration',
        action: 'write',
      });

      const deleteResult = await service.hasPermission({
        userId: 'wildcard-user',
        resource: 'integration',
        action: 'delete',
      });

      expect(readResult).toBe(true);
      expect(writeResult).toBe(true);
      expect(deleteResult).toBe(true);
    });

    it('should not grant access to other resources', async () => {
      const result = await service.hasPermission({
        userId: 'wildcard-user',
        resource: 'config',
        action: 'read',
      });

      expect(result).toBe(false);
    });
  });
});
