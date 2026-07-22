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
