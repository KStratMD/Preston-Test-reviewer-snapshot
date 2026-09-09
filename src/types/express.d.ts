// Consolidated type augmentation for Express Request.
// This is the SINGLE source of truth for req.user and req.rbac types.
// Do NOT duplicate this augmentation in other files.

declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      id: string;
      username: string;
      email?: string;
      tenantId?: string;
      // Normalized `org_id`/`organizationId` JWT claim. Distinct from tenantId:
      // it carries no authorization weight and is used for attribution only
      // (cost-tracking rows, MCP tenant fallback) via TenantContext.
      organizationId?: string;
      roles: string[];
      permissions: string[];
      [key: string]: unknown;
    };
    rbac?: {
      hasPermission: (resource: string, action: string) => Promise<boolean>;
      getUserPermissions: () => string[];
    };
  }
}

export {};
