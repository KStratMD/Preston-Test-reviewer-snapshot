import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SecureCredentialManager } from '../services/SecureCredentialManager';
import type { TenantSystemCredentialRegistry } from '../services/integration/TenantSystemCredentialRegistry';
import type { ApiKeyCredentials, BasicCredentials, OAuth1Credentials, OAuth2Credentials } from '../types';
import { authMiddleware } from '../middleware/auth';
import { rbacMiddleware } from '../middleware/rbac';
import { validationMiddleware } from '../middleware/validation';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireTenantId } from './tenantGuard';

// This is the mounted credential custody surface. The older credentials.ts
// module remains unmounted because it resolves asynchronous dependencies at
// module initialization and has no tenant ownership boundary.
const credentialPayloadSchema = z.object({
  systemType: z.string().min(1),
  systemId: z.string().min(1).refine(value => value === value.trim(), 'systemId must not have leading or trailing whitespace'),
  credentials: z.record(z.string(), z.unknown()),
});

type CredentialPayload = OAuth1Credentials | OAuth2Credentials | BasicCredentials | ApiKeyCredentials;

async function secureCredentialManager(): Promise<SecureCredentialManager> {
  return container.getAsync<SecureCredentialManager>(TYPES.SecureCredentialManager);
}

async function assertCredentialReferenceOwned(
  req: Request,
  res: Response,
  systemType: string,
  systemId: string,
): Promise<boolean> {
  const tenantId = requireTenantId(req, res);
  if (!tenantId) return false;
  const registry = await container.getAsync<TenantSystemCredentialRegistry>(TYPES.TenantSystemCredentialRegistry);
  await registry.assertSystemOwnedByTenant(tenantId, systemType, systemId);
  return true;
}

const router = Router();
const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (req.user) {
    next();
    return;
  }
  authMiddleware(req, res, next);
};
const requireCredentialRole = rbacMiddleware(['admin', 'security_manager', 'integration_manager']);

router.post(
  '/',
  requireAuth,
  requireCredentialRole,
  validationMiddleware(credentialPayloadSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { systemType, systemId, credentials } = req.body as z.infer<typeof credentialPayloadSchema>;
    if (!await assertCredentialReferenceOwned(req, res, systemType, systemId)) return;
    const manager = await secureCredentialManager();
    await manager.storeCredentials(systemType, systemId, credentials as unknown as CredentialPayload);
    res.status(201).json({
      success: true,
      data: { systemType, systemId, credentialSource: 'secret_manager' },
    });
  }),
);

router.get(
  '/:systemType/:systemId',
  requireAuth,
  requireCredentialRole,
  asyncHandler(async (req: Request, res: Response) => {
    if (!await assertCredentialReferenceOwned(req, res, req.params.systemType, req.params.systemId)) return;
    const manager = await secureCredentialManager();
    const metadata = await manager.getCredentialMetadata(req.params.systemType, req.params.systemId);
    if (!metadata) {
      res.status(404).json({ success: false, error: 'Credentials not found' });
      return;
    }
    res.json({ success: true, data: metadata });
  }),
);

router.delete(
  '/:systemType/:systemId',
  requireAuth,
  requireCredentialRole,
  asyncHandler(async (req: Request, res: Response) => {
    if (!await assertCredentialReferenceOwned(req, res, req.params.systemType, req.params.systemId)) return;
    const manager = await secureCredentialManager();
    await manager.deleteCredentials(req.params.systemType, req.params.systemId);
    res.json({ success: true, message: 'Credentials deleted successfully' });
  }),
);

export const secureCredentialsRouter = router;
